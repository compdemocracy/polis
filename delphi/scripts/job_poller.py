#!/usr/bin/env python3
"""
Delphi Job Poller Service

This script runs as a daemon to poll the Delphi_JobQueue for pending jobs
and execute them.
"""

import argparse


def _postgres_vote_to_delphi(pg_vote):
    """
    Convert PostgreSQL vote convention to Delphi convention.

    PostgreSQL/Server/Client: AGREE=-1, DISAGREE=+1, PASS=0
    Delphi internal:          AGREE=+1, DISAGREE=-1, PASS=0

    Note: The canonical definition is in polismath.utils.general.postgres_vote_to_delphi()
    This local copy exists to avoid import dependencies in the standalone poller.
    """
    return pg_vote * -1


from contextlib import contextmanager
import sqlalchemy as sa
from sqlalchemy.orm import DeclarativeBase, sessionmaker, scoped_session
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import text
from typing import Any, Dict, List, Optional
from enum import Enum
import boto3
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from botocore.exceptions import ClientError
import urllib


class PostgresConfig:
    """Configuration for PostgreSQL connection."""
    
    def __init__(self, 
                url: Optional[str] = None,
                host: Optional[str] = None,
                port: Optional[int] = None,
                database: Optional[str] = None,
                user: Optional[str] = None,
                password: Optional[str] = None,
                ssl_mode: Optional[str] = None):
        """
        Initialize PostgreSQL configuration.

        Args:
            url: Database URL (overrides other connection parameters if provided)
            host: Database host
            port: Database port
            database: Database name
            user: Database user
            password: Database password
            ssl_mode: SSL mode (disable, allow, prefer, require, verify-ca, verify-full)
        """
        # Parse URL if provided
        if url:
            self._parse_url(url)
        else:
            self.host = host or os.environ.get('DATABASE_HOST', 'localhost')
            self.port = port or int(os.environ.get('DATABASE_PORT', '5432'))
            self.database = database or os.environ.get('DATABASE_NAME', 'polisDB_prod_local_mar14')
            self.user = user or os.environ.get('DATABASE_USER', 'postgres')
            self.password = password or os.environ.get('DATABASE_PASSWORD', '')
        
        # Set SSL mode
        self.ssl_mode = ssl_mode or os.environ.get('DATABASE_SSL_MODE', 'require')
    
    def _parse_url(self, url: str) -> None:
        """
        Parse a database URL into components.

        Args:
            url: Database URL in format postgresql://user:password@host:port/database
        """
        # Use environment variable if url is not provided
        if not url:
            url = os.environ.get('DATABASE_URL', '')
        
        if not url:
            raise ValueError("No database URL provided")

        # Parse URL
        parsed = urllib.parse.urlparse(url)

        # Extract components
        self.user = parsed.username
        self.password = parsed.password
        self.host = parsed.hostname
        self.port = parsed.port or 5432

        # Extract database name (remove leading '/')
        path = parsed.path
        if path.startswith('/'):
            path = path[1:]
        self.database = path

    def get_uri(self) -> str:
        """
        Get SQLAlchemy URI for database connection.

        Returns:
            SQLAlchemy URI string
        """
        # Format password component if present
        password_str = f":{self.password}" if self.password else ""

        # Build URI
        uri = f"postgresql://{self.user}{password_str}@{self.host}:{self.port}/{self.database}"

        if self.ssl_mode: # Check if self.ssl_mode is not None or empty
            uri = f"{uri}?sslmode={self.ssl_mode}"

        return uri

    @classmethod
    def from_env(cls) -> 'PostgresConfig':
        """
        Create a configuration from environment variables.

        Returns:
            PostgresConfig instance
        """
        # Check for DATABASE_URL
        url = os.environ.get('DATABASE_URL')
        if url:
            return cls(url=url)

        # Use individual environment variables
        return cls(
            host=os.environ.get('DATABASE_HOST'),
            port=int(os.environ.get('DATABASE_PORT', '5432')),
            database=os.environ.get('DATABASE_NAME'),
            user=os.environ.get('DATABASE_USER'),
            password=os.environ.get('DATABASE_PASSWORD')
        )


class PostgresClient:
    """PostgreSQL client for accessing Polis data."""

    def __init__(self, config: Optional[PostgresConfig] = None):
        """
        Initialize PostgreSQL client.

        Args:
            config: PostgreSQL configuration
        """
        self.config = config or PostgresConfig.from_env()
        self.engine = None
        self.session_factory = None
        self.Session = None
        self._initialized = False

    def initialize(self) -> None:
        """
        Initialize the database connection.
        """
        if self._initialized:
            return

        # Create engine
        uri = self.config.get_uri()
        self.engine = sa.create_engine(
            uri,
            pool_size=5,
            max_overflow=10,
            pool_recycle=300,  # Recycle connections after 5 minutes
        )

        # Create session factory
        self.session_factory = sessionmaker(bind=self.engine)
        self.Session = scoped_session(self.session_factory)

        # Mark as initialized
        self._initialized = True
        
        logger.info(f"Initialized PostgreSQL connection to {self.config.host}:{self.config.port}/{self.config.database}")
    
    def shutdown(self) -> None:
        """
        Shut down the database connection.
        """
        if not self._initialized:
            return

        # Dispose of the engine
        if self.engine:
            self.engine.dispose()

        # Clear session factory
        if self.Session:
            self.Session.remove()
            self.Session = None

        # Mark as not initialized
        self._initialized = False

        logger.info("Shut down PostgreSQL connection")

    @contextmanager
    def session(self):
        """
        Get a database session context.

        Yields:
            SQLAlchemy session
        """
        if not self._initialized:
            self.initialize()

        session = self.Session()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()
    
    def query(self, sql: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """
        Execute a SQL query.

        Args:
            sql: SQL query
            params: Query parameters

        Returns:
            List of dictionaries with query results
        """
        if not self._initialized:
            self.initialize()

        with self.engine.connect() as conn:
            result = conn.execute(text(sql), params or {})

            # Convert to dictionaries
            columns = result.keys()
            return [dict(zip(columns, row)) for row in result]

    def get_conversation_by_id(self, zid: int) -> Optional[Dict[str, Any]]:
        """
        Get conversation information by ID.

        Args:
            zid: Conversation ID

        Returns:
            Conversation data, or None if not found
        """
        sql = """
        SELECT * FROM conversations WHERE zid = :zid
        """

        results = self.query(sql, {"zid": zid})
        return results[0] if results else None

    def get_comments_by_conversation(self, zid: int) -> List[Dict[str, Any]]:
        """
        Get all comments in a conversation.

        Args:
            zid: Conversation ID

        Returns:
            List of comments
        """
        sql = """
        SELECT 
            tid, 
            zid, 
            pid, 
            txt, 
            created, 
            mod,
            active
        FROM 
            comments 
        WHERE 
            zid = :zid
        ORDER BY 
            tid
        """

        return self.query(sql, {"zid": zid})

    def get_votes_by_conversation(self, zid: int) -> List[Dict[str, Any]]:
        """
        Get all votes in a conversation.

        Vote signs are flipped at this PostgreSQL boundary:
        - PostgreSQL stores: AGREE=-1, DISAGREE=+1
        - Delphi expects:    AGREE=+1, DISAGREE=-1

        Args:
            zid: Conversation ID

        Returns:
            List of votes with signs converted to Delphi convention
        """
        sql = """
        SELECT 
            v.zid, 
            v.pid, 
            v.tid, 
            v.vote
        FROM 
            votes_latest_unique v
        WHERE 
            v.zid = :zid
        """

        results = self.query(sql, {"zid": zid})
        # Flip vote signs at PostgreSQL boundary
        for r in results:
            if r.get("vote") is not None:
                r["vote"] = _postgres_vote_to_delphi(r["vote"])
        return results

    def get_participants_by_conversation(self, zid: int) -> List[Dict[str, Any]]:
        """
        Get all participants in a conversation.

        Args:
            zid: Conversation ID

        Returns:
            List of participants
        """
        sql = """
        SELECT 
            p.zid,
            p.pid,
            p.uid,
            p.vote_count,
            p.created
        FROM 
            participants p
        WHERE 
            p.zid = :zid
        """

        return self.query(sql, {"zid": zid})

    def get_conversation_id_by_slug(self, conversation_slug: str) -> Optional[int]:
        """
        Get conversation ID by its slug (zinvite).

        Args:
            conversation_slug: Conversation slug/zinvite

        Returns:
            Conversation ID, or None if not found
        """
        sql = """
        SELECT 
            z.zid
        FROM 
            zinvites z
        WHERE 
            z.zinvite = :zinvite
        """

        results = self.query(sql, {"zinvite": conversation_slug})
        return results[0]["zid"] if results else None


# Configure logging
logging.basicConfig(level=logging.INFO, 
                   format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('delphi_poller')

# Global flag for graceful shutdown
running = True

# Exit code from 803_check_batch_status.py script if batch is still processing
EXIT_CODE_PROCESSING_CONTINUES = 3

# How long to wait for a job's child process to exit after terminate/kill
# before giving up on confirming it. See JobProcessor.stop_child_process.
CHILD_TERMINATE_GRACE_SECONDS = 30

# Fallback only. When the poller cannot become a child-subreaper (macOS/BSD, or
# prctl fails) it cannot reap a job's orphaned grandchildren, so process-group
# emptiness is decided by a best-effort /proc scan. Enumeration is not a
# snapshot — the group's last live member can fork a successor and exit between
# the listing and the stat reads — so the scan requires this many consecutive
# passes that all find no live member, with a short pause between them. This
# still cannot beat an N-generation fork race; the subreaper path below is the
# real fence. See JobProcessor._process_group_alive_by_scan.
GROUP_EMPTY_STABLE_PASSES = 2
GROUP_EMPTY_RECHECK_PAUSE_SECONDS = 0.05

# PR_SET_CHILD_SUBREAPER from <linux/prctl.h>. Setting it makes this process the
# reaper for its orphaned descendants (needs no capability).
PR_SET_CHILD_SUBREAPER = 36

# Set once mark_child_subreaper() succeeds. While True, process-group emptiness
# is decided by the kernel (reap the group's dead members, then killpg(pgid, 0)
# raising ESRCH proves it empty) instead of by scanning /proc.
_child_subreaper_set = False


def mark_child_subreaper() -> bool:
    """Make the poller reap its orphaned descendants, so process-group emptiness
    can be decided by the kernel rather than by scanning /proc.

    Jobs are spawned by this process with ``start_new_session=True``; their
    grandchildren, when orphaned, would normally re-parent to the container's
    PID 1 — ``tail -f /dev/null`` under the CI compose file — which never reaps,
    so their zombies pile up and keep ``killpg(pgid, 0)`` answering forever (the
    round-10 hang). ``PR_SET_CHILD_SUBREAPER`` re-parents them here instead. The
    exit confirmation can then reap them and trust that ``killpg`` raising ESRCH
    means the group is truly empty: no lingering zombie fakes liveness, and a
    just-forked successor is simply a live member that keeps ``killpg``
    succeeding until it too exits and is reaped — so no enumeration race
    (round 11) can hide it. Adding scan passes cannot make a scan race-free;
    making the kernel the authority can.

    Returns True if the poller is now a subreaper. On a platform without the
    call (macOS/BSD) or if prctl fails, returns False and leaves the exit
    confirmation on its best-effort /proc-scan fallback.
    """
    global _child_subreaper_set
    if not sys.platform.startswith('linux'):
        logger.info(
            "child-subreaper unavailable on %s; process-exit confirmation is best-effort.",
            sys.platform,
        )
        return False
    try:
        import ctypes
        libc = ctypes.CDLL('libc.so.6', use_errno=True)
        if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
            logger.warning(
                "PR_SET_CHILD_SUBREAPER failed (errno %s); process-exit confirmation is best-effort.",
                ctypes.get_errno(),
            )
            return False
    except Exception as prctl_error:
        logger.warning(
            "Could not set child-subreaper (%s); process-exit confirmation is best-effort.",
            prctl_error,
        )
        return False
    _child_subreaper_set = True
    logger.info(
        "Poller marked as child-subreaper; orphaned job descendants re-parent here and are reaped."
    )
    return True


def ensure_process_exit_fence() -> None:
    """Establish the kernel exit fence at startup, or refuse to start on Linux.

    ``PR_SET_CHILD_SUBREAPER`` needs no capability, so if it cannot be set on
    Linux the container/runtime is broken — and without it the poller can only
    fail closed (never confirm a job's process exit, so guards are never
    released). Rather than run in that degraded state in production, refuse to
    start. On a platform without the call (macOS/BSD dev) the poller continues
    with the documented fail-closed confirmation.
    """
    if mark_child_subreaper():
        return
    if sys.platform.startswith('linux'):
        logger.critical(
            "PR_SET_CHILD_SUBREAPER could not be set; the poller requires the kernel "
            "process-reaper fence to confirm job exits safely on Linux and refuses to "
            "start. The call needs no capability, so its failure means the "
            "container/runtime is misconfigured."
        )
        raise SystemExit(1)
    logger.warning(
        "child-subreaper unavailable on %s; job exit confirmation will fail closed "
        "(the submission guard is never released from a /proc scan alone).",
        sys.platform,
    )


class ExitConfirmation(Enum):
    """Outcome of trying to prove a job's process tree has exited.

    Only ``CONFIRMED`` may release the server's submission guard. The other two
    both mean "not proven gone" and are handled like a timeout — the guard is
    not released and the job records why — but they are kept distinct so the
    reason is visible: ``LIVE`` when members remained and could not be stopped,
    ``UNCONFIRMED`` when there is no kernel reaper fence and a /proc scan cannot
    prove exit (fail closed).
    """

    CONFIRMED = "confirmed"
    LIVE = "live"
    UNCONFIRMED = "unconfirmed"

    @property
    def confirmed(self) -> bool:
        return self is ExitConfirmation.CONFIRMED

    @property
    def note(self) -> Optional[str]:
        if self is ExitConfirmation.CONFIRMED:
            return None
        if self is ExitConfirmation.UNCONFIRMED:
            return (
                "process exit unconfirmed: no kernel process-reaper fence "
                "(child-subreaper unavailable); a /proc scan cannot prove the tree "
                "exited, so the submission guard is not released"
            )
        return (
            "process exit unconfirmed: live members remained in the job's process "
            "group and could not be stopped"
        )


def signal_handler(sig, frame):
    """Handle exit signals gracefully."""
    global running
    logger.info("Shutdown signal received. Stopping workers...")
    running = False


class JobProcessor:
    """Process jobs from the Delphi_JobQueue."""
    
    def __init__(self, endpoint_url=None, region='us-east-1'):
        """Initialize the job processor."""
        self.worker_id = str(uuid.uuid4())
        raw_endpoint = endpoint_url or os.environ.get('DYNAMODB_ENDPOINT')
        self.endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None

        # Determine instance type from environment variable set by configure_instance.py
        self.instance_type = os.environ.get('INSTANCE_SIZE', 'default') # Default to 'default' if not set
        logger.info(f"Worker {self.worker_id} initialized for instance type: {self.instance_type}")
        
        # Initialize PostgresClient - it will be used per-query within poll_and_process
        # No need to store it as self.postgres_client if we instantiate it on demand.
        # If performance becomes an issue, connection pooling could be considered.
        
        logger.info(f"Connecting to DynamoDB at {self.endpoint_url or 'default AWS endpoint'}")
        self.dynamodb = boto3.resource('dynamodb', 
                                     endpoint_url=self.endpoint_url, 
                                     region_name=region)
        self.table = self.dynamodb.Table('Delphi_JobQueue')
        
        try:
            self.table.table_status
            logger.info("Successfully connected to Delphi_JobQueue table")
        except Exception as e:
            logger.error(f"Failed to connect to Delphi_JobQueue table: {e}")
            raise

    def find_pending_job(self):
        """
        Finds the highest-priority actionable job. This includes PENDING jobs, jobs
        awaiting a re-check, and jobs with expired locks ("zombie" jobs).
        """
        try:
            # Helper to query the index with pagination
            def execute_paginated_query(status):
                items = []
                last_key = None
                while True:
                    query_kwargs = {
                        'IndexName': 'StatusCreatedIndex',
                        'KeyConditionExpression': '#s = :status',
                        'ExpressionAttributeNames': {'#s': 'status'},
                        'ExpressionAttributeValues': {':status': status},
                        'ScanIndexForward': True
                    }
                    if last_key:
                        query_kwargs['ExclusiveStartKey'] = last_key
                    
                    response = self.table.query(**query_kwargs)
                    items.extend(response.get('Items', []))
                    last_key = response.get('LastEvaluatedKey')
                    if not last_key:
                        break
                return items

            # 1. Fetch all potentially actionable jobs from different states
            pending_jobs = execute_paginated_query('PENDING')
            awaiting_jobs = execute_paginated_query('AWAITING_RECHECK')
            
            actionable_jobs = pending_jobs + awaiting_jobs

            # 2. Add any jobs that are stuck in PROCESSING with an expired lock (zombies)
            processing_jobs = execute_paginated_query('PROCESSING')
            now_iso = datetime.now(timezone.utc).isoformat()
            for job in processing_jobs:
                if job.get('lock_expires_at', 'z') < now_iso:
                    logger.warning(f"Found zombie job {job['job_id']} with expired lock. Re-queueing.")
                    actionable_jobs.append(job)

            if not actionable_jobs:
                return None

            # 3. Sort all actionable jobs by priority and then by creation date
            actionable_jobs.sort(key=lambda x: (
                0 if x.get('status') == 'PENDING' else 1, # PENDING jobs are highest priority
                x.get('created_at', '')
            ))
            
            logger.info(f"Found {len(actionable_jobs)} actionable job(s). Highest priority is {actionable_jobs[0]['job_id']}")
            return actionable_jobs[0]

        except Exception as e:
            logger.error(f"Error finding pending job: {e}", exc_info=True)
            return None

    def claim_job(self, job: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Atomically claims a job by setting its status to PROCESSING
        and applying a lock timeout, using optimistic locking.
        """
        job_id = job['job_id']
        current_version = job.get('version', 1)
        current_status = job.get('status')
        now = datetime.now(timezone.utc)
        new_expiry_iso = (now + timedelta(minutes=15)).isoformat()

        # This condition handles all actionable states found by find_pending_job.
        # It allows claiming a PENDING job, an AWAITING_RECHECK job, or an expired job.
        condition_expr = "(#s = :pending OR #s = :awaiting_recheck OR (attribute_exists(lock_expires_at) AND lock_expires_at < :now)) AND #v = :current_version"

        try:
            response = self.table.update_item(
                Key={'job_id': job_id},
                UpdateExpression='SET #s = :processing, started_at = :now, lock_expires_at = :expiry, #v = :new_version, #w = :worker_id',
                ConditionExpression=condition_expr,
                ExpressionAttributeNames={
                    '#s': 'status',
                    '#v': 'version',
                    '#w': 'worker_id'
                },
                ExpressionAttributeValues={
                    ':pending': 'PENDING',
                    ':awaiting_recheck': 'AWAITING_RECHECK',
                    ':now': now.isoformat(),
                    ':processing': 'PROCESSING',
                    ':expiry': new_expiry_iso,
                    ':current_version': current_version,
                    ':new_version': current_version + 1,
                    ':worker_id': self.worker_id
                },
                ReturnValues='ALL_NEW'
            )
            logger.info(f"Successfully claimed job {job_id}. Lock expires at {new_expiry_iso}.")
            return response.get('Attributes')
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                logger.warning(f"Job {job_id} was claimed by another worker in a race condition. Skipping.")
            else:
                logger.error(f"DynamoDB error claiming job {job_id}: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error claiming job {job_id}: {e}", exc_info=True)
            return None

    def get_job_actual_size(self, conversation_id_str: str) -> str:
        """
        Queries PostgreSQL to determine the actual size of the job based on comment count.
        Returns "large" or "normal".
        """
        pg_client = None
        try:
            # Ensure conversation_id is an integer for the query
            conversation_id = int(conversation_id_str)

            pg_client = PostgresClient()
            pg_client.initialize()

            # Query for comment count. Assuming 'comments' table and 'zid' column.
            # Adjust table/column names if different.
            # The table is indeed 'comments' and the column is 'zid' per CLAUDE.md
            sql_query = "SELECT COUNT(*) FROM comments WHERE zid = :zid"
            count_result = pg_client.query(sql_query, {"zid": conversation_id})

            if count_result and count_result[0] is not None:
                comment_count = count_result[0]['count']
                logger.info(f"Conversation {conversation_id} has {comment_count} comments.")
                return "large" if comment_count > 5000 else "normal"
            logger.warning(f"Could not retrieve comment count for conversation {conversation_id}. Defaulting to 'normal' size.")
            return "normal"
        except Exception as e:
            logger.error(f"Error querying PostgreSQL for comment count (conv_id: {conversation_id_str}): {e}. Defaulting to 'normal' size.")
            return "normal"
        finally:
            if pg_client:
                pg_client.shutdown()

    def release_lock(self, job, is_still_processing=False):
        """Releases the lock on a job, optionally setting it to be re-checked."""
        job_id = job['job_id']
        logger.info(f"Releasing lock for job {job_id}.")
        try:
            if is_still_processing:
                # Set status to AWAITING_RECHECK so find_pending_job can pick it up again.
                self.table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression="SET #s = :recheck_status REMOVE lock_expires_at",
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={':recheck_status': 'AWAITING_RECHECK'}
                )
            else:
                # For jobs that are finished (completed/failed), just remove the lock.
                self.table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression="REMOVE lock_expires_at"
                )
        except Exception as e:
            logger.error(f"Failed to release lock for job {job_id}: {e}")

    def update_job_logs(self, job, log_entry, mirror_to_console=True):
        """
        Add a log entry to the job logs with optimistic locking.
        """
        try:
            # Get current logs and version
            current_logs = json.loads(job.get('logs', '{"entries":[]}'))
            if 'entries' not in current_logs:
                current_logs['entries'] = []
            
            # Add new entry
            current_logs['entries'].append({
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'level': log_entry.get('level', 'INFO'),
                'message': log_entry.get('message', '')
            })
            
            # Mirror to console if requested
            if mirror_to_console:
                colors = {'INFO': '\033[32m', 'WARNING': '\033[33m', 'ERROR': '\033[31m', 'CRITICAL': '\033[31;1m'}
                reset = '\033[0m'
                level = log_entry.get('level', 'INFO')
                color = colors.get(level, '')
                short_job_id = job['job_id'][:8]
                print(f"{color}[DELPHI JOB {short_job_id}] {level}{reset}: {log_entry.get('message', '')}")
            
            # Keep only the most recent log entries
            current_logs['entries'] = current_logs['entries'][-50:]
            
            # Update DynamoDB
            self.table.update_item(
                Key={'job_id': job['job_id']},
                UpdateExpression='SET logs = :logs, updated_at = :updated_at',
                ExpressionAttributeValues={
                    ':logs': json.dumps(current_logs),
                    ':updated_at': datetime.now(timezone.utc).isoformat()
                }
            )
        except Exception as e:
            # Log failure but do not crash the worker
            logger.error(f"Error updating job logs for {job['job_id']}: {e}")

    def complete_job(self, job, success, result=None, error=None, process_exited=False, process_exit_note=None):
        """Mark a job as completed or failed using optimistic locking.

        ``process_exited`` records whether this worker has *confirmed* that the
        job's child process is gone (terminated and joined). The server's
        submission guard reads ``process_exit_confirmed`` before it will release
        a FAILED root: a root marked FAILED while its subprocess was still alive
        can still create a checker row or submit provider work afterwards, so an
        unconfirmed failure is not proof that the paid work ended. Defaults to
        False so a caller that cannot make the claim does not make it by
        accident. ``process_exit_note`` records *why* the exit was not confirmed
        (see ExitConfirmation) so an unreleased guard is explainable.
        """
        job_id = job['job_id']
        current_version = job.get('version', 1)
        new_status = 'COMPLETED' if success else 'FAILED'
        now = datetime.now().isoformat()

        try:
            # Prepare results
            job_results = {
                'result_type': 'SUCCESS' if success else 'FAILURE',
                'completed_at': now
            }

            # This 'if' block correctly handles the 'result' argument
            if result:
                job_results.update(result)

            if error:
                job_results['error'] = str(error)

            if process_exit_note:
                job_results['process_exit_note'] = str(process_exit_note)

            # Update the job with the new status using optimistic locking
            try:
                self.table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression='''
                        SET #status = :new_status, 
                            updated_at = :now, 
                            completed_at = :now,
                            job_results = :job_results,
                            process_exit_confirmed = :process_exited,
                            version = :new_version
                    ''',
                    ConditionExpression='version = :current_version',
                    ExpressionAttributeNames={'#status': 'status'},
                    ExpressionAttributeValues={
                        ':new_status': new_status,
                        ':now': now,
                        ':job_results': json.dumps(job_results),
                        ':process_exited': bool(process_exited),
                        ':current_version': current_version,
                        ':new_version': current_version + 1
                    }
                )

                logger.info(f"Job {job_id} marked as {new_status}")

            except ClientError as e:
                if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                    logger.warning(f"Job {job_id} was modified by another process, completion state may not be accurate")
                else:
                    raise
        except Exception as e:
            logger.error(f"Error completing job {job_id}: {e}")

    def _job_process_group(self, process, job_id: str):
        """The process group this job owns, or None if it does not own one.

        Jobs are started with ``start_new_session=True`` so the child leads its
        own session and group; everything it spawns inherits that group. A child
        that shares the poller's own group predates that change (or the call
        failed), and signalling it would take the poller down with it — so it is
        reported as "no owned group", which the caller treats as unconfirmable.
        """
        try:
            pgid = os.getpgid(process.pid)
        except Exception as lookup_error:
            logger.warning(f"Job {job_id}: cannot read the child's process group ({lookup_error}).")
            return None
        try:
            if pgid == os.getpgid(0):
                logger.error(
                    f"Job {job_id}: child shares the poller's process group; refusing to signal it."
                )
                return None
        except Exception:
            return None
        return pgid

    @staticmethod
    def _pid_confirmed_gone(pid: int) -> bool:
        """True only if ``pid`` is *definitively* gone (ESRCH), not merely unread.

        Used to tell a pid that exited mid-scan (safe to drop from the live
        count) apart from one whose ``/proc`` entry simply could not be read
        (uncertain — must not be dropped). Anything other than a confirmed
        ``ProcessLookupError`` means the pid still exists.
        """
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            # EPERM or anything else: the pid still exists, just not ours.
            return False
        return False

    @staticmethod
    def _live_group_members(pgid) -> Optional[List[int]]:
        """PIDs still *running* in the group, or None when that is uncertain.

        A zombie is an entry in the process table, not a running process: it has
        already exited and cannot spend provider money or write a row. It stays
        an entry until its parent reaps it, and a grandchild orphaned by the
        job's parent is re-parented to PID 1 — which in a container is whatever
        the image's command is (``tail -f /dev/null`` under the CI compose file,
        `bash` under the delphi image's own CMD), not an init that reaps. So a
        group emptied of live processes can keep answering ``killpg(pgid, 0)``
        forever, and a wait for it to disappear would never return.

        ``None`` means the scan could not be completed with certainty; the caller
        must then treat the group as still live, because an incomplete
        observation never authorizes an exit. That covers /proc being
        unavailable (macOS, BSD — where a reaping init makes the ``killpg``
        answer sufficient), the directory failing to list, and any member whose
        state could not be read (permission error, short read, malformed data).
        A member is dropped from the count only for a definitive reason: it is a
        zombie/dead entry, it is not in this group, or its ``/proc`` entry is
        confirmed gone (ESRCH on recheck) because it exited mid-scan.
        """
        if not os.path.isdir('/proc'):
            return None
        try:
            entries = os.listdir('/proc')
        except OSError:
            # Cannot enumerate the process table: unknown, not empty.
            return None
        live = []
        for entry in entries:
            if not entry.isdigit():
                continue
            pid = int(entry)
            try:
                with open(f'/proc/{entry}/stat', 'rb') as stat_file:
                    data = stat_file.read()
            except FileNotFoundError:
                # The pid may have exited between listdir and open. Drop it only
                # if that is confirmed; a pid that still exists but could not be
                # read is uncertainty, not absence.
                if JobProcessor._pid_confirmed_gone(pid):
                    continue
                return None
            except OSError:
                # Permission or any other read error: cannot classify -> unknown.
                return None
            # comm can contain spaces and parentheses; everything after the last
            # ')' is state, ppid, pgrp, ...
            fields = data.rpartition(b')')[2].split()
            if len(fields) < 3:
                # Short or malformed read: cannot classify -> unknown.
                return None
            state, pgrp = fields[0], fields[2]
            try:
                member_pgid = int(pgrp)
            except ValueError:
                # Cannot tell whether this member is in the group -> unknown.
                return None
            if member_pgid != pgid:
                continue
            if state in (b'Z', b'X', b'x'):
                continue
            live.append(pid)
        return live

    @staticmethod
    def _reap_group(pgid) -> None:
        """Reap the poller's now-dead children in this process group.

        With the poller a child-subreaper, a job's orphaned grandchildren
        re-parent here; collecting their zombies keeps ``killpg(pgid, 0)`` an
        honest witness of live membership — a zombie left unreaped would keep
        the group answering ``killpg`` even though nothing in it can do work.
        Scoped to the group with ``P_PGID`` so a worker confirming one job never
        reaps another concurrent job's child (each job leads its own group). The
        job's own session-leader child is reaped by its ``subprocess`` object
        before any confirmation runs, so this only ever collects re-parented
        descendants. Best-effort: any error leaves the reap for the next pass.
        """
        while True:
            try:
                info = os.waitid(os.P_PGID, pgid, os.WEXITED | os.WNOHANG)
            except ChildProcessError:
                return  # no children of ours remain in this group
            except (OSError, ValueError):
                return
            except Exception:
                return
            if info is None:
                # A child of ours is still in the group but has not exited.
                return

    @staticmethod
    def _process_group_alive(pgid) -> bool:
        """True while the group may still hold a process that can do work.

        When the poller is a child-subreaper (``mark_child_subreaper`` succeeded,
        Linux) the kernel is the authority: reap the group's dead members, then a
        ``killpg(pgid, 0)`` that raises ESRCH proves the group empty. This is not
        an enumeration and so has no snapshot race — a zombie cannot linger to
        fake liveness (it is reaped), and a just-forked successor is a live member
        that keeps ``killpg`` succeeding until it too exits and is reaped. Adding
        scan passes could never make that guarantee; the kernel can.

        Without the subreaper (macOS/BSD, or prctl failed) orphaned grandchildren
        re-parent to an init this process cannot reap through, so it falls back to
        the best-effort ``_process_group_alive_by_scan``.
        """
        if pgid is None:
            return False
        if _child_subreaper_set:
            JobProcessor._reap_group(pgid)
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                # ESRCH: nothing — live or zombie — remains. Proven empty.
                return False
            except PermissionError:
                # A live member exists and is not ours to signal.
                return True
            except Exception:
                return True
            # killpg succeeded after reaping every dead member, so a live member
            # remains.
            return True
        return JobProcessor._process_group_alive_by_scan(pgid)

    @staticmethod
    def _process_group_alive_by_scan(pgid) -> bool:
        """Best-effort emptiness by /proc scan, used only without a subreaper.

        Returns ``False`` only for a group that looks empty across
        ``GROUP_EMPTY_STABLE_PASSES`` consecutive passes, each re-checked with
        ``killpg(pgid, 0)``: ESRCH proves it gone; EPERM means a live member not
        ours to signal; success means an entry remains — a zombie, absent from
        the next live pass, or a successor a pass missed, present in it. An
        incomplete scan (``_live_group_members`` returns ``None``) is reported as
        alive, never as an authorized exit. This cannot defeat an N-generation
        fork race — only the subreaper path can — so it is used solely where the
        subreaper is unavailable, and the confirmation is documented best-effort.
        """
        if pgid is None:
            return False
        empty_passes = 0
        while True:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                # The group no longer exists: definitively empty.
                return False
            except PermissionError:
                # Something in the group is alive and not ours to signal.
                return True
            except Exception:
                return True
            live = JobProcessor._live_group_members(pgid)
            if live is None:
                # An incomplete scan is not proof of an empty group.
                return True
            if live:
                return True
            empty_passes += 1
            if empty_passes >= GROUP_EMPTY_STABLE_PASSES:
                return False
            # killpg still succeeds but no live member was seen. Give a member a
            # pass may have missed — a successor forked mid-scan — a moment to
            # surface, then confirm emptiness with another pass.
            time.sleep(GROUP_EMPTY_RECHECK_PAUSE_SECONDS)

    @staticmethod
    def _best_effort_signal_group(pgid, job_id: str) -> None:
        """SIGTERM then SIGKILL the group, best-effort, without waiting.

        Used on the fail-closed path: killpg needs no subreaper, so leftover
        members are still stopped — but the caller does not, and must not, treat
        this as proof the tree is gone.
        """
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                return
            except Exception as signal_error:
                logger.warning(f"Job {job_id}: could not signal process group {pgid}: {signal_error}")

    def _decline_without_fence(self, pgid, job_id: str) -> 'ExitConfirmation':
        """Fail closed: stop the group best-effort, but never confirm it gone.

        Without the kernel reaper fence a /proc scan cannot prove a process group
        empty (it is not a snapshot), so no scan result may authorize an exit.
        The scan is attached to the log only as diagnostics.
        """
        self._best_effort_signal_group(pgid, job_id)
        logger.warning(
            f"Job {job_id}: no kernel process-reaper fence (child-subreaper unavailable); "
            f"refusing to confirm the process tree exited. Diagnostics: process group "
            f"{pgid} live members (best-effort /proc scan): {self._live_group_members(pgid)}. "
            f"The job's submission guard will not be released."
        )
        return ExitConfirmation.UNCONFIRMED

    def confirm_process_tree_gone(self, pgid, job_id: str) -> 'ExitConfirmation':
        """Try to prove the job's process group is empty. See ExitConfirmation.

        Every completion that claims `process_exit_confirmed` goes through here,
        not just the timeout and error paths. A parent that exits — with any
        status, including 0 — does not take its own subprocesses with it, so
        `process.wait()` returning is evidence about one process and not about
        the tree.

        Returns CONFIRMED only when the kernel exit fence (child-subreaper) is in
        place and the group is proven empty. Without that fence this fails closed
        (UNCONFIRMED): a /proc scan cannot prove an empty group, so it must never
        release the guard, even for a group that happens to look empty. If the
        group was never owned, the claim is declined (LIVE).
        """
        if pgid is None:
            return ExitConfirmation.LIVE
        if not _child_subreaper_set:
            return self._decline_without_fence(pgid, job_id)
        if not self._process_group_alive(pgid):
            return ExitConfirmation.CONFIRMED
        logger.warning(
            f"Job {job_id}: process group {pgid} still has members after the job's "
            f"parent exited (live members: {self._live_group_members(pgid)})."
        )
        for sig, label in ((signal.SIGTERM, 'terminated'), (signal.SIGKILL, 'killed')):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                return ExitConfirmation.CONFIRMED
            except Exception as signal_error:
                logger.warning(f"Job {job_id}: could not signal process group {pgid}: {signal_error}")
            deadline = time.time() + CHILD_TERMINATE_GRACE_SECONDS
            while self._process_group_alive(pgid) and time.time() < deadline:
                time.sleep(0.05)
            if not self._process_group_alive(pgid):
                logger.warning(f"Job {job_id}: leftover job processes {label}.")
                return ExitConfirmation.CONFIRMED
        logger.error(
            f"Job {job_id}: process group {pgid} still has live members; not claiming an exit."
        )
        return ExitConfirmation.LIVE

    def stop_child_process(self, process, job_id: str, pgid=None) -> 'ExitConfirmation':
        """Stop a job's whole process tree and join it. See ExitConfirmation.

        Marking a job FAILED while its processes are still running leaves an
        orphan that can still submit provider work, update the job row, or
        create a checker row *after* the server has concluded the job finished.
        The job is not failed until the work is.

        Stopping only the direct child is not enough: a FULL_PIPELINE child is
        `run_delphi.py`, which itself launches and waits on reset/math/UMAP
        subprocesses. Signalling the job's **process group** reaches those
        grandchildren; without an owned group there is nothing to signal them
        with, and this reports LIVE rather than claiming an exit it cannot see.

        Like confirm_process_tree_gone, this returns CONFIRMED only under the
        kernel fence; without it, it stops the group best-effort but fails closed
        (UNCONFIRMED). It proves the local process tree is gone, not that a
        provider request the tree already sent has been reconciled — that is what
        the outstanding-work sweep and `checker_schedule_failed` are for.
        """
        if process is None:
            return ExitConfirmation.CONFIRMED

        if pgid is None:
            pgid = self._job_process_group(process, job_id)
        if pgid is None:
            # Stop what we can, then decline to make the claim.
            try:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=CHILD_TERMINATE_GRACE_SECONDS)
            except Exception as kill_error:
                logger.error(f"Job {job_id}: could not stop the child: {kill_error}")
            logger.error(
                f"Job {job_id}: no owned process group; cannot confirm descendants exited."
            )
            return ExitConfirmation.LIVE

        if not _child_subreaper_set:
            # Fail closed: signal the group and join the direct child, but a
            # /proc scan cannot prove the tree gone, so decline the claim.
            self._best_effort_signal_group(pgid, job_id)
            try:
                process.wait(timeout=CHILD_TERMINATE_GRACE_SECONDS)
            except Exception:
                pass
            logger.warning(
                f"Job {job_id}: no kernel process-reaper fence (child-subreaper unavailable); "
                f"stopped process group {pgid} best-effort but cannot confirm the tree exited "
                f"(diagnostics: {self._live_group_members(pgid)}). The job's submission guard "
                f"will not be released."
            )
            return ExitConfirmation.UNCONFIRMED

        for sig, label in ((signal.SIGTERM, 'terminated'), (signal.SIGKILL, 'killed')):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                pass
            except Exception as signal_error:
                logger.warning(f"Job {job_id}: could not signal process group {pgid}: {signal_error}")
            try:
                process.wait(timeout=CHILD_TERMINATE_GRACE_SECONDS)
            except Exception:
                pass
            # Re-parented grandchildren are reaped by the poller (subreaper) a
            # moment later, so give the group a bounded chance to disappear
            # before escalating.
            deadline = time.time() + CHILD_TERMINATE_GRACE_SECONDS
            while self._process_group_alive(pgid) and time.time() < deadline:
                time.sleep(0.05)
            if not self._process_group_alive(pgid):
                logger.warning(
                    f"Job {job_id}: job process tree {label} before the job was marked failed."
                )
                return ExitConfirmation.CONFIRMED

        # Report the failure without the exit claim rather than pretending.
        logger.error(
            f"Job {job_id}: process group {pgid} still has live members; not claiming an exit."
        )
        return ExitConfirmation.LIVE

    def _complete_with_confirmation(self, job, success, confirmation: 'ExitConfirmation', error=None) -> None:
        """Complete a job, releasing the guard only on a CONFIRMED exit.

        A CONFIRMED tree sets ``process_exit_confirmed=True``; LIVE and
        UNCONFIRMED both leave it False and record why, so an unreleased guard is
        explainable and a fail-closed exit reads like a timeout to the server.
        """
        self.complete_job(
            job,
            success,
            error=error,
            process_exited=confirmation.confirmed,
            process_exit_note=confirmation.note,
        )

    def process_job(self, job: Dict[str, Any]) -> None:
        """Processes a claimed job by executing the correct script with real-time log handling."""
        job_id = job['job_id']
        job_type = job.get('job_type')
        conversation_id = job.get('conversation_id')
        timeout_seconds = int(job.get('timeout_seconds', 3600))

        self.update_job_logs(job, {'level': 'INFO', 'message': f'Worker {self.worker_id} starting job {job_id}'})

        child_process = None
        job_pgid = None
        try:
            # 1. Build the command
            job_config = json.loads(job.get('job_config', '{}'))
            include_moderation = job_config.get('include_moderation', False)
            exclude_comment_selections = job_config.get('exclude_comment_selections', True)
            app_path = os.environ.get('DELPHI_APP_PATH', '/app')
            if job_type == 'CREATE_NARRATIVE_BATCH':
                model = os.environ.get("ANTHROPIC_MODEL")
                if not model: raise ValueError("ANTHROPIC_MODEL must be set")
                max_batch_size = job_config.get('max_batch_size', 20)
                cmd = ['python', f'{app_path}/umap_narrative/801_narrative_report_batch.py', f'--conversation_id={conversation_id}', f'--model={model}', f'--include_moderation={include_moderation}', f'--exclude_comment_selections={exclude_comment_selections}', f'--max-batch-size={str(max_batch_size)}']
                if job_config.get('no_cache'): cmd.append('--no-cache')
            elif job_type == 'AWAITING_NARRATIVE_BATCH':
                cmd_job_id = job.get('batch_job_id', job_id)
                cmd = ['python', f'{app_path}/umap_narrative/803_check_batch_status.py', f'--job-id={cmd_job_id}']
            else: # FULL_PIPELINE
                # Base command
                cmd = ['python', f'{app_path}/run_delphi.py', f'--zid={conversation_id}', f'--include_moderation={include_moderation}', f'--exclude_comment_selections={exclude_comment_selections}',]
                # Check for report_id and append if it exists
                report_id = job.get('report_id')
                if report_id:
                    cmd.append(f'--rid={report_id}')
                    self.update_job_logs(job, {'level': 'INFO', 'message': f"Passing report_id {report_id} to run_delphi.py"})


            # 2. Execute the command and stream logs to prevent deadlocks
            self.update_job_logs(job, {'level': 'INFO', 'message': f'Executing command: {" ".join(cmd)}'})
            
            env = os.environ.copy()
            env['DELPHI_JOB_ID'] = job_id
            env['DELPHI_REPORT_ID'] = str(job.get('report_id', conversation_id))
            
            # start_new_session puts the child in its own session and process
            # group, so everything it spawns can be signalled as one tree when
            # the job has to be stopped. See stop_child_process.
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, universal_newlines=True, env=env, start_new_session=True)
            child_process = process
            # Read the group id now, while the leader is certainly alive. After
            # the parent exits there is nothing left to ask, and the group may
            # still hold its subprocesses.
            job_pgid = self._job_process_group(process, job_id)

            start_time = time.time()
            for line in iter(process.stdout.readline, ''):
                # Log each line of output as it arrives
                self.update_job_logs(job, {'level': 'INFO', 'message': f"[stdout] {line.strip()}"})
                if time.time() - start_time > timeout_seconds:
                    raise subprocess.TimeoutExpired(cmd, timeout_seconds)

            process.stdout.close()
            return_code = process.wait()

            # 3. Handle the results
            success = (return_code == 0)
            # process.wait() has joined the parent, which says nothing about
            # what the parent left running. Confirm the whole group is empty —
            # stopping anything still in it — before any completion claims the
            # job's processes are gone. This applies to a clean exit as much as
            # a failing one: a zero exit code does not reap subprocesses.
            if job_type == 'AWAITING_NARRATIVE_BATCH':
                if return_code == EXIT_CODE_PROCESSING_CONTINUES:
                    self.release_lock(job, is_still_processing=True)
                else:
                    confirmation = self.confirm_process_tree_gone(job_pgid, job_id)
                    self._complete_with_confirmation(job, success, confirmation, error=f"Script failed with exit code {return_code}" if not success else None)

            elif job_type == 'CREATE_NARRATIVE_BATCH':
                confirmation = self.confirm_process_tree_gone(job_pgid, job_id)
                if success:
                    logger.info(f"Job {job_id}: CREATE_NARRATIVE_BATCH completed successfully.")
                    self._complete_with_confirmation(job, True, confirmation)
                else:
                    self._complete_with_confirmation(job, False, confirmation, error=f"CREATE_NARRATIVE_BATCH script failed with exit code {return_code}")

            else: # Handle all other synchronous job types
                confirmation = self.confirm_process_tree_gone(job_pgid, job_id)
                self._complete_with_confirmation(job, success, confirmation, error=f"Process exited with code {return_code}" if not success else None)

        except subprocess.TimeoutExpired:
            logger.error(f"Job {job_id} timed out after {timeout_seconds} seconds.")
            # Stop the child before marking the job failed: a timed-out process
            # that is still alive can keep spending provider money and can still
            # create a checker row after the job looks finished.
            confirmation = self.stop_child_process(child_process, job_id, job_pgid)
            self._complete_with_confirmation(job, False, confirmation, error=f"Job process timed out after {timeout_seconds}s.")
        except Exception as e:
            logger.error(f"Critical error processing job {job_id}: {e}", exc_info=True)
            confirmation = self.stop_child_process(child_process, job_id, job_pgid)
            self._complete_with_confirmation(job, False, confirmation, error=f"Critical poller error: {str(e)}")


def should_process_job(instance_type: str, job_actual_size: str) -> bool:
    """
    Decide whether a worker of the given instance type should process a job of
    the given size.

    The dedicated "large" worker ASG is scaled to zero, so the normal/default
    worker class now processes ALL job sizes. "large" remains an opt-in,
    large-only class (set INSTANCE_SIZE=large) for anyone who re-enables that
    ASG; "dev" processes anything. get_job_actual_size is still consulted for
    logging/visibility.
    """
    if instance_type == "large":
        return job_actual_size == "large"
    # 'default', 'small', 'dev' and anything else: process every size.
    return True


def poll_and_process(processor: JobProcessor, interval: int = 10):
    """The main loop for a worker thread."""
    logger.info(f"Worker {processor.worker_id} starting job polling...")
    while running:
        claimed_job = None
        try:
            # Step 1: Find the next available job.
            job_to_process = processor.find_pending_job()

            if job_to_process:
                conversation_id_str = job_to_process.get("conversation_id")

                if conversation_id_str:
                    job_actual_size = processor.get_job_actual_size(conversation_id_str)
                else:
                    job_actual_size = "normal"

                instance_type = processor.instance_type
                can_process = should_process_job(instance_type, job_actual_size)

                if not can_process:
                    logger.info(f"Worker instance type '{instance_type}' cannot process job '{job_to_process['job_id']}' of size '{job_actual_size}'. Skipping for now.")
                    # Sleep for the interval so this worker doesn't hammer the queue checking the same job.
                    time.sleep(interval)
                    continue # This correctly skips to the next iteration of the while loop.

                # If we can process it, attempt to claim it.
                claimed_job = processor.claim_job(job_to_process)

                # Only proceed if the claim was successful.
                if claimed_job:
                    processor.process_job(claimed_job)
            else:
                # If no jobs are found, wait for the full interval.
                time.sleep(interval)

        except Exception as e:
            logger.error(f"Critical error in polling loop for worker {processor.worker_id}: {e}", exc_info=True)
            if claimed_job:
                processor.complete_job(claimed_job, False, error="Polling loop crashed during processing")
            time.sleep(interval * 6)


def main():
    # This function is correct.
    parser = argparse.ArgumentParser(description='Delphi Job Poller Service')
    parser.add_argument('--endpoint-url', type=str, default=None)
    parser.add_argument('--region', type=str, default='us-east-1')
    parser.add_argument('--interval', type=int, default=10)
    parser.add_argument('--max-workers', type=int, default=1)
    parser.add_argument('--log-level', type=str, default='INFO', choices=['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'])
    args = parser.parse_args()

    logger.setLevel(getattr(logging, args.log_level))

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info("Starting Delphi Job Poller Service...")

    # Become the reaper for orphaned job descendants before any job is spawned,
    # so process-exit confirmation can trust the kernel (killpg -> ESRCH) instead
    # of scanning /proc. On Linux this must succeed or the poller refuses to
    # start; on other platforms it falls back to fail-closed confirmation.
    ensure_process_exit_fence()

    try:
        processor = JobProcessor(endpoint_url=args.endpoint_url, region=args.region)
        threads = []
        for i in range(args.max_workers):
            t = threading.Thread(target=poll_and_process, args=(processor, args.interval), daemon=True)
            t.start()
            threads.append(t)
            logger.info(f"Started worker thread {i+1}")

        while running and any(t.is_alive() for t in threads):
            time.sleep(1)

        logger.info("All workers have stopped. Exiting.")
    except Exception as e:
        logger.error(f"Error in main function: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
