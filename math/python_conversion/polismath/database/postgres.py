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
from typing import Dict, List, Optional, Tuple, Union, Any, Set, Callable
from datetime import datetime
import re
import urllib.parse
from contextlib import contextmanager
import asyncio

import sqlalchemy as sa
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.dialects.postgresql import JSON, JSONB
from sqlalchemy.pool import QueuePool
from sqlalchemy.sql import text
import numpy as np
import pandas as pd

# Set up logging
logger = logging.getLogger(__name__)

# Base class for SQLAlchemy models
Base = declarative_base()


class PostgresConfig:
    """Configuration for PostgreSQL connection."""
    
    def __init__(self, 
                url: Optional[str] = None,
                host: Optional[str] = None,
                port: Optional[int] = None,
                database: Optional[str] = None,
                user: Optional[str] = None,
                password: Optional[str] = None,
                pool_size: Optional[int] = None,
                max_overflow: Optional[int] = None,
                ssl_mode: Optional[str] = None,
                math_env: Optional[str] = None):
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
            self.host = host or os.environ.get('DATABASE_HOST', 'localhost')
            self.port = port or int(os.environ.get('DATABASE_PORT', '5432'))
            self.database = database or os.environ.get('DATABASE_NAME', 'polis')
            self.user = user or os.environ.get('DATABASE_USER', 'postgres')
            self.password = password or os.environ.get('DATABASE_PASSWORD', '')
        
        # Set pool configuration
        self.pool_size = pool_size or int(os.environ.get('DATABASE_POOL_SIZE', '5'))
        self.max_overflow = max_overflow or int(os.environ.get('DATABASE_MAX_OVERFLOW', '10'))
        
        # Set SSL mode
        self.ssl_mode = ssl_mode or os.environ.get('DATABASE_SSL_MODE', 'prefer')
        
        # Set math environment
        self.math_env = math_env or os.environ.get('MATH_ENV', 'dev')
    
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
        
        # Add SSL mode if needed
        if self.ssl_mode and self.ssl_mode != 'prefer':
            uri += f"?sslmode={self.ssl_mode}"
        
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
            password=os.environ.get('DATABASE_PASSWORD'),
            math_env=os.environ.get('MATH_ENV')
        )


# Define database models
class MathMain(Base):
    """Stores main mathematical results for conversations."""
    
    __tablename__ = 'math_main'
    
    zid = sa.Column(sa.Integer, primary_key=True)
    math_env = sa.Column(sa.String, primary_key=True)
    last_vote_timestamp = sa.Column(sa.TIMESTAMP)
    last_mod_timestamp = sa.Column(sa.TIMESTAMP)
    data = sa.Column(JSONB)
    
    def __repr__(self):
        return f"<MathMain(zid={self.zid}, math_env='{self.math_env}')>"


class MathTicks(Base):
    """Tracks computational ticks for conversations."""
    
    __tablename__ = 'math_ticks'
    
    zid = sa.Column(sa.Integer, primary_key=True)
    math_env = sa.Column(sa.String, primary_key=True)
    total = sa.Column(sa.Integer, default=0)
    
    def __repr__(self):
        return f"<MathTicks(zid={self.zid}, math_env='{self.math_env}', total={self.total})>"


class MathPtptStats(Base):
    """Stores participant statistics."""
    
    __tablename__ = 'math_ptptstats'
    
    zid = sa.Column(sa.Integer, primary_key=True)
    math_env = sa.Column(sa.String, primary_key=True)
    data = sa.Column(JSONB)
    
    def __repr__(self):
        return f"<MathPtptStats(zid={self.zid}, math_env='{self.math_env}')>"


class MathReportCorrelationMatrix(Base):
    """Stores correlation matrices for reports."""
    
    __tablename__ = 'math_report_correlationmatrix'
    
    zid = sa.Column(sa.Integer, primary_key=True)
    math_env = sa.Column(sa.String, primary_key=True)
    data = sa.Column(JSONB)
    
    def __repr__(self):
        return f"<MathReportCorrelationMatrix(zid={self.zid}, math_env='{self.math_env}')>"


class WorkerTasks(Base):
    """Stores tasks for background workers."""
    
    __tablename__ = 'worker_tasks'
    
    id = sa.Column(sa.Integer, primary_key=True, autoincrement=True)
    math_env = sa.Column(sa.String)
    task_type = sa.Column(sa.String, index=True)
    task_data = sa.Column(JSONB)
    finished = sa.Column(sa.Boolean, default=False)
    created = sa.Column(sa.TIMESTAMP)
    
    def __repr__(self):
        return f"<WorkerTasks(id={self.id}, task_type='{self.task_type}', finished={self.finished})>"


class PostgresClient:
    """PostgreSQL client for Pol.is math."""
    
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
            self.engine = sa.create_engine(
                uri,
                pool_size=self.config.pool_size,
                max_overflow=self.config.max_overflow,
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
        
        with self.engine.connect() as conn:
            result = conn.execute(text(sql), params or {})
            return result.rowcount
    
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
            return result[0]['zinvite']
        
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
            return result[0]['zid']
        
        return None
    
    def poll_votes(self, 
                  zid: int, 
                  since: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """
        Poll for new votes in a conversation.
        
        Args:
            zid: Conversation ID
            since: Only get votes after this timestamp
            
        Returns:
            List of votes
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
        if since:
            sql += " AND created > :since"
            params["since"] = since
        
        # Execute query
        votes = self.query(sql, params)
        
        # Format votes for processing
        return [
            {
                "pid": str(v["pid"]),
                "tid": str(v["tid"]),
                "vote": int(v["vote"]),
                "created": v["created"]
            }
            for v in votes
        ]
    
    def poll_moderation(self, 
                       zid: int,
                       since: Optional[datetime] = None) -> Dict[str, Any]:
        """
        Poll for moderation changes in a conversation.
        
        Args:
            zid: Conversation ID
            since: Only get changes after this timestamp
            
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
        
        # Format moderation data
        mod_out_tids = []
        mod_in_tids = []
        meta_tids = []
        
        for m in mods:
            tid = str(m["tid"])
            
            # Check moderation status
            if m["mod"] == 1:
                mod_in_tids.append(tid)
            elif m["mod"] == -1:
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
            AND mod = -1
        """
        
        # Execute query
        mod_ptpts = self.query(sql_ptpts, params)
        
        # Format moderated participants
        mod_out_ptpts = [str(p["pid"]) for p in mod_ptpts]
        
        return {
            "mod_out_tids": mod_out_tids,
            "mod_in_tids": mod_in_tids,
            "meta_tids": meta_tids,
            "mod_out_ptpts": mod_out_ptpts
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
            math_main = session.query(MathMain).filter_by(
                zid=zid,
                math_env=self.config.math_env
            ).first()
            
            if not math_main:
                return None
            
            # Return data
            return {
                "zid": math_main.zid,
                "math_env": math_main.math_env,
                "last_vote_timestamp": math_main.last_vote_timestamp,
                "last_mod_timestamp": math_main.last_mod_timestamp,
                "data": math_main.data
            }
    
    def write_math_main(self, 
                       zid: int,
                       data: Dict[str, Any],
                       last_vote_timestamp: Optional[datetime] = None,
                       last_mod_timestamp: Optional[datetime] = None) -> None:
        """
        Write math results for a conversation.
        
        Args:
            zid: Conversation ID
            data: Math data
            last_vote_timestamp: Timestamp of last processed vote
            last_mod_timestamp: Timestamp of last processed moderation
        """
        with self.session() as session:
            # Check if record exists
            math_main = session.query(MathMain).filter_by(
                zid=zid,
                math_env=self.config.math_env
            ).first()
            
            if math_main:
                # Update existing record
                math_main.data = data
                
                if last_vote_timestamp:
                    math_main.last_vote_timestamp = last_vote_timestamp
                
                if last_mod_timestamp:
                    math_main.last_mod_timestamp = last_mod_timestamp
            else:
                # Create new record
                math_main = MathMain(
                    zid=zid,
                    math_env=self.config.math_env,
                    data=data,
                    last_vote_timestamp=last_vote_timestamp,
                    last_mod_timestamp=last_mod_timestamp
                )
                session.add(math_main)
    
    def write_participant_stats(self, 
                              zid: int,
                              data: Dict[str, Any]) -> None:
        """
        Write participant statistics for a conversation.
        
        Args:
            zid: Conversation ID
            data: Participant statistics data
        """
        with self.session() as session:
            # Check if record exists
            ptpt_stats = session.query(MathPtptStats).filter_by(
                zid=zid,
                math_env=self.config.math_env
            ).first()
            
            if ptpt_stats:
                # Update existing record
                ptpt_stats.data = data
            else:
                # Create new record
                ptpt_stats = MathPtptStats(
                    zid=zid,
                    math_env=self.config.math_env,
                    data=data
                )
                session.add(ptpt_stats)
    
    def write_correlation_matrix(self, 
                               zid: int,
                               data: Dict[str, Any]) -> None:
        """
        Write correlation matrix for a conversation.
        
        Args:
            zid: Conversation ID
            data: Correlation matrix data
        """
        with self.session() as session:
            # Check if record exists
            corr_matrix = session.query(MathReportCorrelationMatrix).filter_by(
                zid=zid,
                math_env=self.config.math_env
            ).first()
            
            if corr_matrix:
                # Update existing record
                corr_matrix.data = data
            else:
                # Create new record
                corr_matrix = MathReportCorrelationMatrix(
                    zid=zid,
                    math_env=self.config.math_env,
                    data=data
                )
                session.add(corr_matrix)
    
    def increment_math_tick(self, zid: int) -> int:
        """
        Increment the math tick counter for a conversation.
        
        Args:
            zid: Conversation ID
            
        Returns:
            New tick value
        """
        with self.session() as session:
            # Check if record exists
            math_ticks = session.query(MathTicks).filter_by(
                zid=zid,
                math_env=self.config.math_env
            ).first()
            
            if math_ticks:
                # Update existing record
                math_ticks.total += 1
                new_total = math_ticks.total
            else:
                # Create new record
                math_ticks = MathTicks(
                    zid=zid,
                    math_env=self.config.math_env,
                    total=1
                )
                session.add(math_ticks)
                new_total = 1
            
            # Commit and return new total
            session.commit()
            return new_total
    
    def poll_tasks(self, 
                  task_type: str,
                  limit: int = 10) -> List[Dict[str, Any]]:
        """
        Poll for pending worker tasks.
        
        Args:
            task_type: Type of task to poll for
            limit: Maximum number of tasks to return
            
        Returns:
            List of tasks
        """
        with self.session() as session:
            # Query for pending tasks
            tasks = session.query(WorkerTasks).filter_by(
                math_env=self.config.math_env,
                task_type=task_type,
                finished=False
            ).order_by(
                WorkerTasks.created
            ).limit(limit).all()
            
            # Format tasks
            return [
                {
                    "id": task.id,
                    "task_type": task.task_type,
                    "task_data": task.task_data,
                    "created": task.created
                }
                for task in tasks
            ]
    
    def mark_task_complete(self, task_id: int) -> None:
        """
        Mark a worker task as complete.
        
        Args:
            task_id: Task ID
        """
        with self.session() as session:
            # Find and update task
            task = session.query(WorkerTasks).filter_by(id=task_id).first()
            
            if task:
                task.finished = True
                session.commit()
    
    def create_task(self, 
                   task_type: str,
                   task_data: Dict[str, Any]) -> int:
        """
        Create a new worker task.
        
        Args:
            task_type: Type of task
            task_data: Task data
            
        Returns:
            Task ID
        """
        with self.session() as session:
            # Create new task
            task = WorkerTasks(
                math_env=self.config.math_env,
                task_type=task_type,
                task_data=task_data,
                finished=False,
                created=datetime.now()
            )
            session.add(task)
            session.commit()
            
            return task.id


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
                cls._client = PostgresClient(config)
                cls._client.initialize()
            
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