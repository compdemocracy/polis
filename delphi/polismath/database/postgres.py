"""
PostgreSQL database integration for Pol.is math.

This module provides functionality for connecting to PostgreSQL and
performing database operations for the Pol.is math system.
"""

import os
import json
import logging
import time
import threading
from typing import Dict, List, Optional, Tuple, Union, Any, Callable
from datetime import datetime
import re
import urllib.parse
from contextlib import contextmanager
import asyncio

import sqlalchemy as sa
from sqlalchemy.orm import DeclarativeBase, sessionmaker, scoped_session
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import text
import numpy as np
import pandas as pd

from polismath.utils.general import postgres_vote_to_delphi
from polismath.utils.serialization import convert_numpy_types
from polismath.utils.vote_convention import (
    STORAGE_AGREE_VALUE,
    validate_storage_agree_value,
)

# Set up logging
logger = logging.getLogger(__name__)


# Base class for SQLAlchemy models
class Base(DeclarativeBase):
    """Base class for all SQLAlchemy models."""

    pass


class PostgresConfig:
    """Configuration for PostgreSQL connection."""

    def __init__(
        self,
        url: Optional[str] = None,
        host: Optional[str] = None,
        port: Optional[int] = None,
        database: Optional[str] = None,
        user: Optional[str] = None,
        password: Optional[str] = None,
        pool_size: Optional[int] = None,
        max_overflow: Optional[int] = None,
        ssl_mode: Optional[str] = None,
        math_env: Optional[str] = None,
    ):
        """
        Initialize PostgreSQL configuration.

        Args:
            url: Database URL (overrides other connection parameters if provided)
            host: Database host
            port: Database port
            database: Database name
            user: Database user
            password: Database password
            pool_size: Connection pool size
            max_overflow: Maximum overflow connections
            ssl_mode: SSL mode (disable, allow, prefer, require, verify-ca, verify-full)
            math_env: Math environment identifier
        """
        # Parse URL if provided
        if url:
            self._parse_url(url)
        else:
            self.host = host or os.environ.get("DATABASE_HOST", "localhost")
            self.port = port or int(os.environ.get("DATABASE_PORT", 5432))
            self.database = database or os.environ.get("DATABASE_NAME", "polis")
            self.user = user or os.environ.get("DATABASE_USER", "postgres")
            self.password = password or os.environ.get("DATABASE_PASSWORD", "")

        # Set pool configuration with better empty value handling
        pool_size_str = os.environ.get("DATABASE_POOL_SIZE", "")
        self.pool_size = pool_size or (int(pool_size_str) if pool_size_str else 5)

        max_overflow_str = os.environ.get("DATABASE_MAX_OVERFLOW", "")
        self.max_overflow = max_overflow or (
            int(max_overflow_str) if max_overflow_str else 10
        )

        # Set SSL mode
        self.ssl_mode = ssl_mode or os.environ.get("DATABASE_SSL_MODE", "require")

        # Set math environment
        self.math_env = math_env or os.environ.get("MATH_ENV", "dev")

    def _parse_url(self, url: str) -> None:
        """
        Parse a database URL into components.

        Args:
            url: Database URL in format postgresql://user:password@host:port/database
        """
        # Use environment variable if url is not provided
        if not url:
            url = os.environ.get("DATABASE_URL", "")

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
        if path.startswith("/"):
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
    def from_env(cls) -> "PostgresConfig":
        """
        Create a configuration from environment variables.

        Returns:
            PostgresConfig instance
        """
        # Check for DATABASE_URL
        url = os.environ.get("DATABASE_URL")
        if url:
            return cls(url=url)

        # Use individual environment variables
        return cls(
            host=os.environ.get("DATABASE_HOST"),
            port=int(os.environ.get("DATABASE_PORT", 5432)),
            database=os.environ.get("DATABASE_NAME"),
            user=os.environ.get("DATABASE_USER"),
            password=os.environ.get("DATABASE_PASSWORD"),
            math_env=os.environ.get("MATH_ENV"),
        )


# Define database models
class MathMain(Base):
    """Stores main mathematical results for conversations."""

    __tablename__ = "math_main"

    zid = sa.Column(sa.Integer, primary_key=True)
    math_env = sa.Column(sa.String, primary_key=True)
    data = sa.Column(JSONB, nullable=False)
    last_vote_timestamp = sa.Column(sa.BigInteger, nullable=False)
    caching_tick = sa.Column(sa.BigInteger, nullable=False, default=0)
    math_tick = sa.Column(sa.BigInteger, nullable=False, default=-1)
    modified = sa.Column(sa.BigInteger, server_default=text("now_as_millis()"))

    def __repr__(self):
        return f"<MathMain(zid={self.zid}, math_env='{self.math_env}')>"


class MathTicks(Base):
    """Tracks computational ticks for conversations."""

    __tablename__ = "math_ticks"

    zid = sa.Column(sa.Integer, primary_key=True)
    math_env = sa.Column(sa.String, primary_key=True)
    math_tick = sa.Column(sa.BigInteger, nullable=False, default=0)
    caching_tick = sa.Column(sa.BigInteger, nullable=False, default=0)
    modified = sa.Column(
        sa.BigInteger, nullable=False, server_default=text("now_as_millis()")
    )

    def __repr__(self):
        return f"<MathTicks(zid={self.zid}, math_env='{self.math_env}', math_tick={self.math_tick})>"


class MathPtptStats(Base):
    """Stores participant statistics."""

    __tablename__ = "math_ptptstats"

    zid = sa.Column(sa.Integer, primary_key=True)
    math_env = sa.Column(sa.String, primary_key=True)
    math_tick = sa.Column(sa.BigInteger, nullable=False, default=-1)
    data = sa.Column(JSONB, nullable=False)
    modified = sa.Column(sa.BigInteger, server_default=text("now_as_millis()"))

    def __repr__(self):
        return f"<MathPtptStats(zid={self.zid}, math_env='{self.math_env}')>"


class MathBidToPid(Base):
    """Stores the base-cluster bid -> participant-id mapping (server consumes it
    via server/src/utils/participants.ts).  Mirrors the Clojure math_bidtopid
    table written by upload-math-bidtopid (postgres.clj:369-380)."""

    __tablename__ = "math_bidtopid"

    zid = sa.Column(sa.Integer, primary_key=True)
    math_env = sa.Column(sa.String, primary_key=True)
    math_tick = sa.Column(sa.BigInteger, nullable=False, default=-1)
    data = sa.Column(JSONB, nullable=False)
    modified = sa.Column(sa.BigInteger, server_default=text("now_as_millis()"))

    def __repr__(self):
        return f"<MathBidToPid(zid={self.zid}, math_env='{self.math_env}')>"


class MathReportCorrelationMatrix(Base):
    """Stores correlation matrices for reports."""

    __tablename__ = "math_report_correlationmatrix"

    rid = sa.Column(sa.BigInteger, primary_key=True)
    math_env = sa.Column(sa.String, primary_key=True)
    data = sa.Column(JSONB)
    math_tick = sa.Column(sa.BigInteger, nullable=False, default=-1)
    modified = sa.Column(sa.BigInteger, server_default=text("now_as_millis()"))

    def __repr__(self):
        return (
            f"<MathReportCorrelationMatrix(rid={self.rid}, math_env='{self.math_env}')>"
        )


class WorkerTasks(Base):
    """Stores tasks for background workers."""

    __tablename__ = "worker_tasks"

    # Use composite primary key of created + math_env
    created = sa.Column(
        sa.BigInteger, server_default=text("now_as_millis()"), primary_key=True
    )
    math_env = sa.Column(sa.String, nullable=False, primary_key=True)
    attempts = sa.Column(sa.SmallInteger, nullable=False, default=0)
    task_data = sa.Column(JSONB, nullable=False)
    task_type = sa.Column(sa.String(99))
    task_bucket = sa.Column(sa.BigInteger)
    finished_time = sa.Column(sa.BigInteger)

    def __repr__(self):
        return f"<WorkerTasks(task_type='{self.task_type}', finished_time={self.finished_time})"


class PostgresClient:
    """PostgreSQL client for Pol.is math."""

    def __init__(
        self,
        config: Optional[PostgresConfig] = None,
        storage_agree_value: int = STORAGE_AGREE_VALUE,
    ):
        """
        Initialize PostgreSQL client.

        Args:
            config: PostgreSQL configuration
            storage_agree_value: the DECLARED raw storage sign of AGREE in the
                database this client reads, -1 or +1 (P-022-G rev4). Validated
                here so an unknown convention fails at construction rather than
                silently mis-signing every vote at ingress. Production remains
                -1 until the P-023 storage migration.
        """
        self.storage_agree_value = validate_storage_agree_value(
            storage_agree_value)
        self.config = config or PostgresConfig.from_env()
        self.engine = None
        self.session_factory = None
        self.Session = None
        self._lock = threading.RLock()
        self._initialized = False

    def initialize(self) -> None:
        """
        Initialize the database connection.
        """
        with self._lock:
            if self._initialized:
                return

            # Create engine
            uri = self.config.get_uri()
            # POSTGRES_CONNECT_TIMEOUT (seconds) caps the TCP socket-level
            # connect() call. Default 30s is conservative for production
            # (transient slowness, scale-up); CI and local dev override to
            # 5s for fast fail when the DB isn't running. Without it, an
            # unreachable DB causes the process to hang for the OS default
            # (often 60-120s+). See delphi/CLAUDE.md "Environment Variables".
            connect_timeout = int(os.environ.get("POSTGRES_CONNECT_TIMEOUT", "30"))
            self.engine = sa.create_engine(
                uri,
                pool_size=self.config.pool_size,
                max_overflow=self.config.max_overflow,
                pool_recycle=300,  # Recycle connections after 5 minutes
                connect_args={"connect_timeout": connect_timeout},
                # pool_pre_ping=True validates each connection on checkout,
                # so stale connections (e.g. DB restarts, idle timeouts in
                # cloud Postgres) are dropped and replaced transparently.
                # Tiny overhead per checkout; standard SQLAlchemy practice
                # for long-running services. Note this does NOT replace
                # connect_timeout — pre-ping only acts on already-pooled
                # connections, not on the initial socket connect.
                pool_pre_ping=True,
            )

            # Create session factory
            self.session_factory = sessionmaker(bind=self.engine)
            self.Session = scoped_session(self.session_factory)

            # Mark as initialized
            self._initialized = True

            logger.info(
                f"Initialized PostgreSQL connection to {self.config.host}:{self.config.port}/{self.config.database}"
            )

    def shutdown(self) -> None:
        """
        Shut down the database connection.
        """
        with self._lock:
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

    def query(
        self, sql: str, params: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
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

    def execute(self, sql: str, params: Optional[Dict[str, Any]] = None) -> int:
        """
        Execute a SQL statement.

        Args:
            sql: SQL statement
            params: Query parameters

        Returns:
            Number of affected rows
        """
        if not self._initialized:
            self.initialize()

        with self.engine.begin() as conn:
            result = conn.execute(text(sql), params or {})
            return result.rowcount

    def _write_returning(
        self, sql: str, params: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """Execute a writing statement inside a COMMITTED transaction and return
        any RETURNING rows.

        ``query()`` uses ``engine.connect()`` (SQLAlchemy 2.0 "commit as you go"),
        which rolls back on close — fine for SELECTs but it silently discards
        INSERT/UPDATEs.  The upsert writers (math_main / math_ticks / math_bidtopid
        / math_ptptstats) MUST persist, so they route through here:
        ``engine.begin()`` commits on successful exit.
        """
        if not self._initialized:
            self.initialize()

        with self.engine.begin() as conn:
            result = conn.execute(text(sql), params or {})
            if result.returns_rows:
                return [dict(row) for row in result.mappings().all()]
            return []

    def get_zinvite_from_zid(self, zid: int) -> Optional[str]:
        """
        Get the zinvite (conversation code) for a conversation ID.

        Args:
            zid: Conversation ID

        Returns:
            Zinvite code, or None if not found
        """
        sql = "SELECT zinvite FROM zinvites WHERE zid = :zid"
        result = self.query(sql, {"zid": zid})

        if result:
            return result[0]["zinvite"]

        return None

    def get_zid_from_zinvite(self, zinvite: str) -> Optional[int]:
        """
        Get the conversation ID for a zinvite code.

        Args:
            zinvite: Conversation code

        Returns:
            Conversation ID, or None if not found
        """
        sql = "SELECT zid FROM zinvites WHERE zinvite = :zinvite"
        result = self.query(sql, {"zinvite": zinvite})

        if result:
            return result[0]["zid"]

        return None

    def poll_votes(
        self, zid: int, since: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Poll for new votes in a conversation.

        Vote signs are flipped at this PostgreSQL boundary:
        - PostgreSQL stores: AGREE=-1, DISAGREE=+1
        - Delphi expects:    AGREE=+1, DISAGREE=-1

        Args:
            zid: Conversation ID
            since: Only get votes after this timestamp — epoch MILLIS (int),
                matching the BIGINT ``votes.created`` column (a datetime would
                make Postgres error on the bigint comparison)

        Returns:
            List of votes with signs converted to Delphi convention
        """
        params = {"zid": zid}

        # Build SQL query
        sql = """
        SELECT
            zid,
            tid,
            pid,
            vote,
            created
        FROM
            votes
        WHERE
            zid = :zid
        """

        # Add timestamp filter if provided
        if since is not None:
            sql += " AND created > :since"
            params["since"] = since

        # Row order matters for parity: Clojure conv-poll orders by
        # [:zid :tid :pid :created] (postgres.clj:197-212).  update_votes assigns
        # base-cluster IDs by first-appearance order of participants, which seeds
        # k-means; a different row order changes k.  So we must ORDER identically.
        sql += " ORDER BY zid, tid, pid, created"

        # Execute query
        votes = self.query(sql, params)

        # Format votes for processing, flipping sign at PostgreSQL boundary.
        # pid AND tid are kept as the DB's native int (votes.pid/tid are both
        # INTEGER) — NOT str()-wrapped. Found live (2026-07-24, poller-
        # equivalence harness, session 2): the pid cast was the ONLY source
        # of a Type-mismatch divergence in math_main.base-clusters.members
        # against Clojure (which holds an int pid throughout) —
        # Conversation.update_votes is deliberately type-agnostic at ingress
        # ("Preserve original type", both pid AND tid) and
        # raw_rating_mat/rating_mat are ALWAYS rebuilt fresh from these two
        # methods on every load-or-init (never restored via from_dict — see
        # polismath/poller/__init__.py's "load-or-init finding" docstring),
        # so removing the cast is a one-point fix with no other code changes
        # needed. Session 3 (same day): fixing pid alone left tid's OWN
        # str() cast unmasked — a live vw full-run then showed the SAME
        # Type-mismatch pattern on zid/tids[]/repness.*.tid, traced to this
        # same cast. The certified/CSV replay driver never cast tid either,
        # and matched clj int-for-int across 20 cross-validated entries —
        # the evidence that authorized this fix. See also poll_moderation
        # below, which needed the SAME fix for mod_out_tids/mod_in_tids/
        # meta_tids/mod_out_ptpts to stay type-consistent with these two.
        return [
            {
                "pid": v["pid"],
                "tid": v["tid"],
                "vote": postgres_vote_to_delphi(
                    int(v["vote"]), self.storage_agree_value),
                "created": v["created"],
            }
            for v in votes
        ]

    def poll_votes_since(self, since: int) -> List[Dict[str, Any]]:
        """
        Global vote poll across ALL conversations since a watermark.

        Mirrors the Clojure vote poller query (postgres.clj:132-145):
            SELECT * FROM votes WHERE created > watermark
            ORDER BY zid, tid, pid, created
        Signs are flipped to the Delphi convention at this ingress boundary.

        Args:
            since: Watermark (millis since epoch); returns rows with created > since

        Returns:
            List of votes {zid, pid, tid, vote, created}, sign-flipped, ordered.
        """
        rows = self.query(
            """
            SELECT zid, tid, pid, vote, created
            FROM votes
            WHERE created > :since
            ORDER BY zid, tid, pid, created
            """,
            {"since": since},
        )
        # pid AND tid kept as the DB's native int — see poll_votes's
        # docstring/comment above for the full root-cause rationale
        # (2026-07-24 live findings, sessions 2-3).
        return [
            {
                "zid": int(v["zid"]),
                "pid": v["pid"],
                "tid": v["tid"],
                "vote": postgres_vote_to_delphi(
                    int(v["vote"]), self.storage_agree_value),
                "created": v["created"],
            }
            for v in rows
        ]

    def poll_moderation_since(self, since: int) -> List[Dict[str, Any]]:
        """
        Global moderation poll across ALL conversations since a watermark.

        Mirrors the Clojure mod poller query (postgres.clj:148-161):
            SELECT * FROM comments WHERE modified > watermark
            ORDER BY zid, tid, modified
        Returns the raw changed-comment rows so the caller can group by zid and
        advance the watermark to max(modified).  The per-zid worker then
        re-derives the FULL current moderation state via poll_moderation(zid).

        Args:
            since: Watermark (millis since epoch); rows with modified > since

        Returns:
            List of {zid, tid, modified, mod, is_meta}.
        """
        rows = self.query(
            """
            SELECT zid, tid, modified, mod, is_meta
            FROM comments
            WHERE modified > :since
            ORDER BY zid, tid, modified
            """,
            {"since": since},
        )
        return [
            {
                "zid": int(m["zid"]),
                "tid": int(m["tid"]),
                "modified": m["modified"],
                "mod": m["mod"],
                "is_meta": m["is_meta"],
            }
            for m in rows
        ]

    def get_report_comment_selections(
        self, zid: int, rid: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Get report comment selections for a conversation.

        This retrieves records from report_comment_selections table which tracks
        which comments should be included or excluded from reports:
        - selection = 1: comment should be included in the report
        - selection = -1: comment should be excluded from the report

        Args:
            zid: Conversation ID (required)
            rid: Report ID (optional, if not provided returns selections for all reports)

        Returns:
            List of dictionaries with keys: rid, tid, selection, zid, modified
        """
        params = {"zid": zid}

        sql = """
        SELECT
            rid,
            tid,
            selection,
            zid,
            modified
        FROM
            report_comment_selections
        WHERE
            zid = :zid
        """

        if rid is not None:
            sql += " AND rid = :rid"
            params["rid"] = rid

        return self.query(sql, params)

    def poll_moderation(
        self, zid: int, since: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Poll for moderation changes in a conversation.

        Args:
            zid: Conversation ID
            since: Only get changes after this timestamp — epoch MILLIS (int),
                matching the BIGINT ``comments.modified`` column

        Returns:
            Dictionary with moderation data
        """
        params = {"zid": zid}

        # Build SQL query for moderated comments
        sql_mods = """
        SELECT
            tid,
            modified,
            mod,
            is_meta
        FROM
            comments
        WHERE
            zid = :zid
        """

        # Add timestamp filter if provided
        if since:
            sql_mods += " AND modified > :since"
            params["since"] = since

        # Execute query
        mods = self.query(sql_mods, params)

        # Format moderation data. tid is kept as the DB's native int — NOT
        # str()-wrapped (2026-07-24 live finding, session 3): mod_out_tids
        # feeds Conversation._apply_moderation's
        # ``[c for c in self.mod_out_tids if c in self.rating_mat.columns]``
        # intersection UNCONDITIONALLY (no engine-mode branch, unlike the
        # participant-ban check below) — left str while poll_votes/
        # poll_votes_since's tid became int, that intersection would ALWAYS
        # be empty, silently disabling moderated-out comment zeroing in the
        # live poller. poll_moderation_since (the OTHER, global-watermark
        # variant) already used int(m["tid"]) and was never affected.
        mod_out_tids = []
        mod_in_tids = []
        meta_tids = []

        for m in mods:
            tid = m["tid"]

            # Check moderation status with support for string values
            mod_value = m["mod"]
            if mod_value == 1 or mod_value == "1":
                mod_in_tids.append(tid)
            elif mod_value == -1 or mod_value == "-1":
                mod_out_tids.append(tid)

            # Check meta status
            if m["is_meta"]:
                meta_tids.append(tid)

        # Build SQL query for moderated participants
        sql_ptpts = """
        SELECT
            pid
        FROM
            participants
        WHERE
            zid = :zid
            AND (mod = -1 OR mod = '-1')
        """

        # Execute query
        mod_ptpts = self.query(sql_ptpts, params)

        # Format moderated participants. pid kept as the DB's native int —
        # NOT str()-wrapped (2026-07-24 live finding, session 3): keeps this
        # consistent with poll_votes/poll_votes_since's (also-int) pid, for
        # Conversation._apply_moderation's ``p not in self.mod_out_ptpts``
        # check ('improved' engine mode only — 'clojure-legacy' intentionally
        # leaks bans and skips this check entirely, so this specific fix has
        # no observable effect in the mode this harness runs in, but matters
        # for 'improved' mode elsewhere).
        mod_out_ptpts = [p["pid"] for p in mod_ptpts]

        return {
            "mod_out_tids": mod_out_tids,
            "mod_in_tids": mod_in_tids,
            "meta_tids": meta_tids,
            "mod_out_ptpts": mod_out_ptpts,
        }

    def load_math_main(self, zid: int) -> Optional[Dict[str, Any]]:
        """
        Load math results for a conversation.

        Args:
            zid: Conversation ID

        Returns:
            Math data, or None if not found
        """
        with self.session() as session:
            # Query for math main data
            math_main = (
                session.query(MathMain)
                .filter_by(zid=zid, math_env=self.config.math_env)
                .first()
            )

            if not math_main:
                return None

            # Return data with all fields
            return {
                "zid": math_main.zid,
                "math_env": math_main.math_env,
                "data": math_main.data,
                "last_vote_timestamp": math_main.last_vote_timestamp,
                "caching_tick": math_main.caching_tick,
                "math_tick": math_main.math_tick,
                "modified": math_main.modified,
            }

    def write_math_main(
        self,
        zid: int,
        data: Dict[str, Any],
        last_vote_timestamp: Optional[int] = None,
        caching_tick: Optional[int] = None,
        math_tick: Optional[int] = None,
    ) -> None:
        """
        Write math results for a conversation (Clojure upload-math-main parity).

        caching_tick is NEVER taken from the caller: it is derived in-SQL exactly
        as Clojure does (postgres.clj:323-338):

            caching_tick = COALESCE(
                (SELECT max(caching_tick) + 1 FROM math_main WHERE math_env = ?),
                1)

        so the TS server's prefetch (pca.ts:84-151 polls caching_tick > last) sees
        a strictly increasing, per-math_env cursor.  The `caching_tick` parameter
        is accepted for signature compatibility but ignored.

        Args:
            zid: Conversation ID
            data: Math data (JSON blob stored verbatim)
            last_vote_timestamp: Timestamp of last processed vote
            caching_tick: Ignored (derived in SQL); kept for back-compat
            math_tick: Current math tick (shared with the other writes this cycle)
        """
        last_vote_timestamp = (
            last_vote_timestamp
            if last_vote_timestamp is not None
            else int(time.time() * 1000)
        )
        # NOTE: math_env appears twice in the params — once for the row value and
        # once inside the caching_tick subquery (mirrors Clojure's duplicated ?).
        self._write_returning(
            """
            insert into math_main
                (zid, math_env, last_vote_timestamp, math_tick, data, caching_tick)
            values
                (:zid, :math_env, :last_vote_timestamp, :math_tick,
                 cast(:data as jsonb),
                 COALESCE((select max(caching_tick) + 1 from math_main
                           where math_env = :math_env), 1))
            on conflict (zid, math_env)
            do update set modified = now_as_millis(),
                          data = excluded.data,
                          last_vote_timestamp = excluded.last_vote_timestamp,
                          math_tick = excluded.math_tick,
                          caching_tick = excluded.caching_tick
            returning zid;
            """,
            {
                "zid": zid,
                "math_env": self.config.math_env,
                "last_vote_timestamp": last_vote_timestamp,
                "math_tick": math_tick if math_tick is not None else -1,
                "data": json.dumps(data, default=convert_numpy_types),
            },
        )

    def write_math_bidtopid(
        self, zid: int, data: Dict[str, Any], math_tick: Optional[int] = None
    ) -> None:
        """
        Write the bid -> participant-id mapping (Clojure upload-math-bidtopid,
        postgres.clj:369-380).  Net-new writer: the TS server's
        getBidIndexToPidMapping / getPidsForGid (participants.ts) depend on it.

        Args:
            zid: Conversation ID
            data: prep-bidToPid blob {"zid", "bidToPid", "lastVoteTimestamp"}
            math_tick: Current math tick (shared with the other writes this cycle)
        """
        self._write_returning(
            """
            insert into math_bidtopid (zid, math_env, math_tick, data)
            values (:zid, :math_env, :math_tick, cast(:data as jsonb))
            on conflict (zid, math_env)
            do update set modified = now_as_millis(),
                          data = excluded.data,
                          math_tick = excluded.math_tick
            returning zid;
            """,
            {
                "zid": zid,
                "math_env": self.config.math_env,
                "math_tick": math_tick if math_tick is not None else -1,
                "data": json.dumps(data, default=convert_numpy_types),
            },
        )

    def write_participant_stats(
        self, zid: int, data: Dict[str, Any], math_tick: Optional[int] = None
    ) -> None:
        """
        Write participant statistics (Clojure upload-math-ptptstats parity,
        postgres.clj:350-361).  Writes math_tick so the three data tables share
        the single tick minted for the cycle (conv_man.clj:158-169).

        Args:
            zid: Conversation ID
            data: Participant statistics data (prep-ptpt-stats blob)
            math_tick: Current math tick (shared with the other writes this cycle)
        """
        self._write_returning(
            """
            insert into math_ptptstats (zid, math_env, math_tick, data)
            values (:zid, :math_env, :math_tick, cast(:data as jsonb))
            on conflict (zid, math_env)
            do update set modified = now_as_millis(),
                          data = excluded.data,
                          math_tick = excluded.math_tick
            returning zid;
            """,
            {
                "zid": zid,
                "math_env": self.config.math_env,
                "math_tick": math_tick if math_tick is not None else -1,
                "data": json.dumps(data, default=convert_numpy_types),
            },
        )

    def write_correlation_matrix(self, rid: int, data: Dict[str, Any]) -> None:
        """
        Write correlation matrix for a report.

        Args:
            rid: Report ID
            data: Correlation matrix data
        """
        with self.session() as session:
            # Check if record exists
            corr_matrix = (
                session.query(MathReportCorrelationMatrix)
                .filter_by(rid=rid, math_env=self.config.math_env)
                .first()
            )

            if corr_matrix:
                # Update existing record
                corr_matrix.data = data
            else:
                # Create new record
                corr_matrix = MathReportCorrelationMatrix(
                    rid=rid,
                    math_env=self.config.math_env,
                    data=data,
                    math_tick=-1,  # Use default value
                )
                session.add(corr_matrix)

    def increment_math_tick(self, zid: int) -> int:
        """
        Atomically increment the math tick counter for a conversation.

        Clojure inc-math-tick (postgres.clj:292-295) does this in a SINGLE
        statement so concurrent writers never race a read-modify-write:

            insert into math_ticks (zid, math_env) values (?, ?)
            on conflict (zid, math_env)
            do update set modified = now_as_millis(),
                          math_tick = (math_ticks.math_tick + 1)
            returning math_tick;

        Args:
            zid: Conversation ID

        Returns:
            New tick value
        """
        rows = self._write_returning(
            """
            insert into math_ticks (zid, math_env) values (:zid, :math_env)
            on conflict (zid, math_env)
            do update set modified = now_as_millis(),
                          math_tick = (math_ticks.math_tick + 1)
            returning math_tick;
            """,
            {"zid": zid, "math_env": self.config.math_env},
        )
        return rows[0]["math_tick"]

    def poll_tasks(
        self, task_type: str, last_timestamp: int = 0, limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Poll for pending worker tasks.

        Args:
            task_type: Type of task to poll for
            last_timestamp: Only get tasks created after this timestamp
            limit: Maximum number of tasks to return

        Returns:
            List of tasks
        """
        with self.session() as session:
            # Query for pending tasks
            tasks = (
                session.query(WorkerTasks)
                .filter(
                    WorkerTasks.math_env == self.config.math_env,
                    WorkerTasks.task_type == task_type,
                    WorkerTasks.created > last_timestamp,
                    WorkerTasks.finished_time.is_(None),
                )
                .order_by(WorkerTasks.created)
                .limit(limit)
                .all()
            )

            # Format tasks (matching Clojure implementation)
            return [
                {
                    "created": task.created,
                    "math_env": task.math_env,
                    "attempts": task.attempts,
                    "task_type": task.task_type,
                    "task_data": task.task_data,
                    "task_bucket": task.task_bucket,
                    "finished_time": task.finished_time,
                }
                for task in tasks
            ]

    def mark_task_complete(self, task_type: str, task_bucket: int) -> None:
        """
        Mark a worker task as complete.

        Args:
            task_type: Type of task
            task_bucket: Task bucket ID
        """
        with self.session() as session:
            # Find and update tasks matching type and bucket
            now = int(time.time() * 1000)
            (
                session.query(WorkerTasks)
                .filter(
                    WorkerTasks.math_env == self.config.math_env,
                    WorkerTasks.task_type == task_type,
                    WorkerTasks.task_bucket == task_bucket,
                    WorkerTasks.finished_time.is_(None),
                )
                .update({WorkerTasks.finished_time: now}, synchronize_session=False)
            )
            session.commit()

    def create_task(
        self,
        task_type: str,
        task_data: Dict[str, Any],
        task_bucket: Optional[int] = None,
    ) -> None:
        """
        Create a new worker task.

        Args:
            task_type: Type of task
            task_data: Task data
            task_bucket: Optional task bucket ID
        """
        with self.session() as session:
            # Create new task
            task = WorkerTasks(
                math_env=self.config.math_env,
                task_type=task_type,
                task_data=task_data,
                task_bucket=task_bucket,
                attempts=0,
                finished_time=None,
            )
            session.add(task)
            session.commit()


class PostgresManager:
    """
    Singleton manager for PostgreSQL database connections.
    """

    _instance = None
    _client = None
    _lock = threading.RLock()

    @classmethod
    def get_client(cls, config: Optional[PostgresConfig] = None) -> PostgresClient:
        """
        Get the PostgreSQL client instance.

        Args:
            config: Optional PostgreSQL configuration

        Returns:
            PostgresClient instance
        """
        with cls._lock:
            if cls._client is None:
                # Create a new client
                cls._client = PostgresClient(config)

                # Make sure to actually initialize the client
                try:
                    logger.info("Initializing PostgreSQL client...")
                    cls._client.initialize()
                    logger.info("PostgreSQL client initialized successfully")
                except Exception as e:
                    logger.error(f"Error initializing PostgreSQL client: {e}")
                    # Reset client to None to allow retry
                    cls._client = None
                    raise e

            # Make sure client is initialized before returning
            if cls._client and not cls._client._initialized:
                try:
                    logger.info("Ensuring PostgreSQL client is initialized...")
                    cls._client.initialize()
                except Exception as e:
                    logger.error(f"Error initializing PostgreSQL client: {e}")
                    # Reset client to None to allow retry
                    cls._client = None
                    raise e

            return cls._client

    @classmethod
    def shutdown(cls) -> None:
        """
        Shut down the PostgreSQL client.
        """
        with cls._lock:
            if cls._client is not None:
                cls._client.shutdown()
                cls._client = None
