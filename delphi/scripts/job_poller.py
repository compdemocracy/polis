#!/usr/bin/env python3
"""
Delphi Job Poller Service

This script runs as a daemon to poll the Delphi_JobQueue for pending jobs
and execute them.
"""

import argparse
from contextlib import contextmanager
import sqlalchemy as sa
from sqlalchemy.orm import DeclarativeBase, sessionmaker, scoped_session
from sqlalchemy.dialects.postgresql import JSON, JSONB
from sqlalchemy.pool import QueuePool
from sqlalchemy.sql import text
from typing import Any, Dict, List, Optional
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
            pool_recycle=300  # Recycle connections after 5 minutes
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
        
        Args:
            zid: Conversation ID
            
        Returns:
            List of votes
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
        
        return self.query(sql, {"zid": zid})
    
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
        return results[0]['zid'] if results else None

# Configure logging
logging.basicConfig(level=logging.INFO, 
                   format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('delphi_poller')

# Global flag for graceful shutdown
running = True

# Exit code from 803_check_batch_status.py script if batch is still processing
EXIT_CODE_PROCESSING_CONTINUES = 3

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

    def claim_job(self, job):
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

    def complete_job(self, job, success, result=None, error=None):
        """Mark a job as completed or failed using optimistic locking."""
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
            
            # Update the job with the new status using optimistic locking
            try:
                self.table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression='''
                        SET #status = :new_status, 
                            updated_at = :now, 
                            completed_at = :now,
                            job_results = :job_results,
                            version = :new_version
                    ''',
                    ConditionExpression='version = :current_version',
                    ExpressionAttributeNames={'#status': 'status'},
                    ExpressionAttributeValues={
                        ':new_status': new_status,
                        ':now': now,
                        ':job_results': json.dumps(job_results),
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

    def process_job(self, job):
        """Processes a claimed job by executing the correct script with real-time log handling."""
        job_id = job['job_id']
        job_type = job.get('job_type')
        conversation_id = job.get('conversation_id')
        timeout_seconds = int(job.get('timeout_seconds', 3600))

        self.update_job_logs(job, {'level': 'INFO', 'message': f'Worker {self.worker_id} starting job {job_id}'})
        
        try:
            # 1. Build the command
            job_config = json.loads(job.get('job_config', '{}'))
            include_moderation = job_config.get('include_moderation', False)
            if job_type == 'CREATE_NARRATIVE_BATCH':
                model = os.environ.get("ANTHROPIC_MODEL")
                if not model: raise ValueError("ANTHROPIC_MODEL must be set")
                max_batch_size = job_config.get('max_batch_size', 20)
                cmd = ['python', '/app/umap_narrative/801_narrative_report_batch.py', f'--conversation_id={conversation_id}', f'--model={model}', f'--include_moderation={include_moderation}', f'--max-batch-size={str(max_batch_size)}']
                if job_config.get('no_cache'): cmd.append('--no-cache')
            elif job_type == 'AWAITING_NARRATIVE_BATCH':
                cmd_job_id = job.get('batch_job_id', job_id)
                cmd = ['python', '/app/umap_narrative/803_check_batch_status.py', f'--job-id={cmd_job_id}']
            else: # FULL_PIPELINE
                # Base command
                cmd = ['python', '/app/run_delphi.py', f'--zid={conversation_id}', f'--include_moderation={include_moderation}',]
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
            
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, universal_newlines=True, env=env)

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
            if job_type == 'AWAITING_NARRATIVE_BATCH':
                if return_code == EXIT_CODE_PROCESSING_CONTINUES:
                    self.release_lock(job, is_still_processing=True)
                else:
                    self.complete_job(job, success, error=f"Script failed with exit code {return_code}" if not success else None)
            
            elif job_type == 'CREATE_NARRATIVE_BATCH':
                if success:
                    logger.info(f"Job {job_id}: CREATE_NARRATIVE_BATCH completed successfully.")
                    self.complete_job(job, True)
                else:
                    self.complete_job(job, False, error=f"CREATE_NARRATIVE_BATCH script failed with exit code {return_code}")

            else: # Handle all other synchronous job types
                self.complete_job(job, success, error=f"Process exited with code {return_code}" if not success else None)

        except subprocess.TimeoutExpired:
            logger.error(f"Job {job_id} timed out after {timeout_seconds} seconds.")
            self.complete_job(job, False, error=f"Job process timed out after {timeout_seconds}s.")
        except Exception as e:
            logger.error(f"Critical error processing job {job_id}: {e}", exc_info=True)
            self.complete_job(job, False, error=f"Critical poller error: {str(e)}")


def poll_and_process(processor, interval=10):
    """The main loop for a worker thread."""
    logger.info(f"Worker {processor.worker_id} starting job polling...")
    while running:
        claimed_job = None
        try:
            # Step 1: Find the next available job.
            job_to_process = processor.find_pending_job()
            
            if job_to_process:
                conversation_id_str = job_to_process.get('conversation_id')
                
                if conversation_id_str:
                    job_actual_size = processor.get_job_actual_size(conversation_id_str)
                else:
                    job_actual_size = "normal"
                
                can_process = False
                instance_type = processor.instance_type
                
                if instance_type == "large":
                    # A large instance ONLY processes large jobs.
                    can_process = (job_actual_size == "large")
                else: # This covers 'small' and the 'default' type.
                    # Small/default instances ONLY process normal-sized jobs.
                    can_process = (job_actual_size == "normal")

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