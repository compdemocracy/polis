"""
Storage utilities for the Polis comment graph microservice.
"""

import boto3


def _postgres_vote_to_delphi(pg_vote):
    """
    Convert PostgreSQL vote convention to Delphi convention.

    PostgreSQL/Server/Client: AGREE=-1, DISAGREE=+1, PASS=0
    Delphi internal:          AGREE=+1, DISAGREE=-1, PASS=0

    Note: The canonical definition is in polismath.utils.general.postgres_vote_to_delphi()
    This local copy exists because polismath_commentgraph is a separate package.
    """
    return pg_vote * -1


import os
import json
import logging
from typing import Dict, List, Any, Optional, Union
from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError
import numpy as np
from decimal import Decimal
from .converter import DataConverter
from ..schemas.dynamo_models import (
    ConversationMeta,
    CommentEmbedding,
    CommentCluster,
    ClusterTopic,
    UMAPGraphEdge,
    CommentText,
)

import sqlalchemy as sa
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.pool import QueuePool
from sqlalchemy.sql import text
import urllib.parse
from contextlib import contextmanager
from datetime import datetime

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
        return results[0]['zid'] if results else None

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


class DynamoDBStorage:
    """
    Provides methods for storing and retrieving data from DynamoDB.
    Implements CRUD operations for all schema tables.
    """

    def __init__(self, region_name: str = None, endpoint_url: str = None):
        """
        Initialize the DynamoDB storage with optional region and endpoint.

        Args:
            region_name: AWS region for DynamoDB
            endpoint_url: Optional endpoint URL for local DynamoDB
        """
        # Get settings from environment variables with fallbacks
        self.region_name = region_name or os.environ.get('AWS_REGION', 'us-east-1')
        self.endpoint_url = endpoint_url or os.environ.get('DYNAMODB_ENDPOINT')
        
        # Get AWS credentials from environment variables
        aws_access_key_id = os.environ.get('AWS_ACCESS_KEY_ID')
        aws_secret_access_key = os.environ.get('AWS_SECRET_ACCESS_KEY')
        
        # Initialize DynamoDB client and resource
        kwargs = {
            'region_name': self.region_name
        }
        
        # Add endpoint URL if provided
        if self.endpoint_url:
            kwargs['endpoint_url'] = self.endpoint_url
            
        # Add credentials if provided (for local testing)
        if aws_access_key_id and aws_secret_access_key:
            kwargs['aws_access_key_id'] = aws_access_key_id
            kwargs['aws_secret_access_key'] = aws_secret_access_key
        
        # Create the DynamoDB resource
        self.dynamodb = boto3.resource('dynamodb', **kwargs)
        
        # Define table names
        self.table_names = {
            'conversation_meta': 'Delphi_UMAPConversationConfig',
            'comment_embeddings': 'Delphi_CommentEmbeddings',
            'comment_clusters': 'Delphi_CommentHierarchicalClusterAssignments',
            'cluster_topics': 'Delphi_CommentClustersStructureKeywords',
            'umap_graph': 'Delphi_UMAPGraph',
            'cluster_characteristics': 'Delphi_CommentClustersFeatures',
            'llm_topic_names': 'Delphi_CommentClustersLLMTopicNames'
            # Note: CommentTexts table is intentionally excluded
            # Comment texts are stored in PostgreSQL as the single source of truth
        }

        # Check if tables exist and are accessible
        self._validate_tables()

        logger.info(f"DynamoDB storage initialized with region: {self.region_name}")

    def _validate_tables(self):
        """Check if the required tables exist and are accessible."""
        try:
            # Get list of existing tables
            existing_tables = self.dynamodb.meta.client.list_tables()['TableNames']
            
            # Check each required table
            for name, table_name in self.table_names.items():
                if table_name not in existing_tables:
                    logger.warning(f"Table {table_name} does not exist. Operations will fail.")
                else:
                    logger.info(f"Table {table_name} exists and is accessible.")
        except Exception as e:
            logger.error(f"Error validating DynamoDB tables: {str(e)}")

    def create_conversation_meta(self, meta: ConversationMeta) -> bool:
        """
        Store conversation metadata.

        Args:
            meta: Conversation metadata object

        Returns:
            True if successful, False otherwise
        """
        table = self.dynamodb.Table(self.table_names['conversation_meta'])
        
        try:
            # Use model_dump_json() for newer Pydantic or json() for older versions
            try:
                # Try newer Pydantic v2 method first
                item = json.loads(meta.model_dump_json())
            except AttributeError:
                # Fall back to older Pydantic v1 method
                item = json.loads(meta.json())

            # Convert floats to Decimal for DynamoDB
            item = DataConverter.prepare_for_dynamodb(item)

            table.put_item(Item=item)
            logger.info(f"Created conversation metadata for: {meta.conversation_id}")
            return True
        except ClientError as e:
            logger.error(f"Error creating conversation metadata: {str(e)}")
            return False

    def get_conversation_meta(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve conversation metadata.

        Args:
            conversation_id: ID of the conversation

        Returns:
            Conversation metadata dictionary or None if not found
        """
        table = self.dynamodb.Table(self.table_names['conversation_meta'])
        
        try:
            response = table.get_item(Key={'conversation_id': conversation_id})
            if 'Item' in response:
                logger.info(f"Retrieved metadata for conversation: {conversation_id}")
                return response['Item']
            else:
                logger.warning(f"No metadata found for conversation: {conversation_id}")
                return None
        except ClientError as e:
            logger.error(f"Error retrieving conversation metadata: {str(e)}")
            return None

    def list_conversations(self) -> List[Dict[str, Any]]:
        # NOT SURE IF THIS FUNCTION IS USED, BUT WE SHOULD REFACTOR IF USING TO AN GENERATOR USING YIELD, IN ORDER TO AVOID LOADING THE FULL TABLE INTO MEMORY, WHICH WILL CRASH THE APP IF IT GETS TO BIG
        """
        List all conversations.

        Returns:
            List of conversation metadata dictionaries
        """
        table = self.dynamodb.Table(self.table_names['conversation_meta'])
        
        try:
            response = table.scan()
            conversations = response.get('Items', [])
            
            # Handle pagination if needed
            while 'LastEvaluatedKey' in response:
                response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
                conversations.extend(response.get('Items', []))
            
            logger.info(f"Retrieved {len(conversations)} conversations")
            return conversations
        except ClientError as e:
            logger.error(f"Error listing conversations: {str(e)}")
            return []

    def create_comment_embedding(self, embedding: CommentEmbedding) -> bool:
        """
        Store a comment embedding.

        Args:
            embedding: Comment embedding object

        Returns:
            True if successful, False otherwise
        """
        table = self.dynamodb.Table(self.table_names['comment_embeddings'])
        
        try:
            # Convert to dictionary
            # Use model_dump_json() for newer Pydantic or json() for older versions
            try:
                # Try newer Pydantic v2 method first
                item = json.loads(embedding.model_dump_json())
            except AttributeError:
                # Fall back to older Pydantic v1 method
                item = json.loads(embedding.json())

            # Convert floats to Decimal for DynamoDB
            item = DataConverter.prepare_for_dynamodb(item)

            # Store in DynamoDB
            table.put_item(Item=item)

            logger.info(
                f"Created embedding for comment {embedding.comment_id} "
                f"in conversation {embedding.conversation_id}"
            )
            return True
        except ClientError as e:
            logger.error(f"Error creating comment embedding: {str(e)}")
            return False

    def get_comment_embedding(
        self, 
        conversation_id: str, 
        comment_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Retrieve a comment embedding.

        Args:
            conversation_id: ID of the conversation
            comment_id: ID of the comment

        Returns:
            Comment embedding dictionary or None if not found
        """
        table = self.dynamodb.Table(self.table_names['comment_embeddings'])
        
        try:
            response = table.get_item(
                Key={
                    'conversation_id': conversation_id,
                    'comment_id': comment_id
                }
            )
            
            if 'Item' in response:
                logger.info(
                    f"Retrieved embedding for comment {comment_id} "
                    f"in conversation {conversation_id}"
                )
                return response['Item']
            else:
                logger.warning(
                    f"No embedding found for comment {comment_id} "
                    f"in conversation {conversation_id}"
                )
                return None
        except ClientError as e:
            logger.error(f"Error retrieving comment embedding: {str(e)}")
            return None
    
    def batch_create_comment_embeddings(self, embeddings: List[CommentEmbedding]) -> Dict[str, int]:
        """
        Store multiple comment embeddings in batch.

        Args:
            embeddings: List of comment embedding objects

        Returns:
            Dictionary with success and failure counts
        """
        if not embeddings:
            return {'success': 0, 'failure': 0}
        
        table = self.dynamodb.Table(self.table_names['comment_embeddings'])
        
        success_count = 0
        failure_count = 0

        # Process in batches of 25 (DynamoDB batch limit)
        for i in range(0, len(embeddings), 25):
            batch = embeddings[i:i + 25]
            
            try:
                with table.batch_writer() as writer:
                    for embedding in batch:
                        try:
                            # Convert to dictionary
                            # Use model_dump_json() for newer Pydantic or json() for older versions
                            try:
                                # Try newer Pydantic v2 method first
                                item = json.loads(embedding.model_dump_json())
                            except AttributeError:
                                # Fall back to older Pydantic v1 method
                                item = json.loads(embedding.json())

                            # Convert floats to Decimal for DynamoDB
                            item = DataConverter.prepare_for_dynamodb(item)

                            # Write to batch
                            writer.put_item(Item=item)
                            success_count += 1
                        except Exception as e:
                            logger.error(
                                f"Error processing embedding for comment {embedding.comment_id}: {str(e)}"
                            )
                            failure_count += 1
            except ClientError as e:
                logger.error(f"Error in batch write operation: {str(e)}")
                # Count all items in this batch as failures
                failure_count += len(batch)
                success_count -= min(success_count, len(batch))

        logger.info(
            f"Batch created {success_count} comment embeddings with {failure_count} failures"
        )
        
        return {
            'success': success_count,
            'failure': failure_count
        }
    
    def create_comment_cluster(self, cluster: CommentCluster) -> bool:
        """
        Store a comment cluster assignment.

        Args:
            cluster: Comment cluster object

        Returns:
            True if successful, False otherwise
        """
        table = self.dynamodb.Table(self.table_names['comment_clusters'])
        
        try:
            # Convert to dictionary
            # Use model_dump_json() for newer Pydantic or json() for older versions
            try:
                # Try newer Pydantic v2 method first
                item = json.loads(cluster.model_dump_json())
            except AttributeError:
                # Fall back to older Pydantic v1 method
                item = json.loads(cluster.json())

            # Convert floats to Decimal for DynamoDB
            item = DataConverter.prepare_for_dynamodb(item)

            # Store in DynamoDB
            table.put_item(Item=item)

            logger.info(
                f"Created cluster assignment for comment {cluster.comment_id} "
                f"in conversation {cluster.conversation_id}"
            )
            return True
        except ClientError as e:
            logger.error(f"Error creating comment cluster: {str(e)}")
            return False
    
    def batch_create_comment_clusters(self, clusters: List[CommentCluster]) -> Dict[str, int]:
        """
        Store multiple comment cluster assignments in batch.

        Args:
            clusters: List of comment cluster objects

        Returns:
            Dictionary with success and failure counts
        """
        if not clusters:
            return {'success': 0, 'failure': 0}
        
        table = self.dynamodb.Table(self.table_names['comment_clusters'])
        
        success_count = 0
        failure_count = 0

        # Process in batches of 25 (DynamoDB batch limit)
        for i in range(0, len(clusters), 25):
            batch = clusters[i:i + 25]
            
            try:
                with table.batch_writer() as writer:
                    for cluster in batch:
                        try:
                            # Convert to dictionary
                            # Use model_dump_json() for newer Pydantic or json() for older versions
                            try:
                                # Try newer Pydantic v2 method first
                                item = json.loads(cluster.model_dump_json())
                            except AttributeError:
                                # Fall back to older Pydantic v1 method
                                item = json.loads(cluster.json())

                            # Make sure comment_id is a proper Decimal for DynamoDB
                            if 'comment_id' in item:
                                try:
                                    item['comment_id'] = Decimal(str(item['comment_id']))
                                except Exception as e:
                                    logger.error(f"Error converting comment_id to Decimal: {e}")
                                    item['comment_id'] = Decimal('0')
                            
                            # Make sure all cluster_id values are proper Decimals
                            for key in item:
                                if key.startswith('layer') and key.endswith('_cluster_id'):
                                    try:
                                        # Ensure proper Decimal conversion by going through string
                                        item[key] = Decimal(str(item[key])) if item[key] is not None else None
                                    except Exception as e:
                                        logger.error(f"Error converting {key} to Decimal: {e}")
                                        item[key] = Decimal('0')
                            
                            # Convert all values in nested dictionaries
                            for key in item:
                                if isinstance(item[key], dict):
                                    for inner_key, inner_value in item[key].items():
                                        if isinstance(inner_value, (int, float)):
                                            try:
                                                item[key][inner_key] = Decimal(str(inner_value))
                                            except Exception as e:
                                                logger.error(f"Error converting {key}.{inner_key} to Decimal: {e}")
                                                item[key][inner_key] = Decimal('0')
                            
                            # Convert all other floats to Decimal for DynamoDB
                            item = DataConverter.prepare_for_dynamodb(item)

                            # Write to batch
                            writer.put_item(Item=item)
                            success_count += 1
                        except Exception as e:
                            logger.error(
                                f"Error processing cluster for comment {cluster.comment_id}: {str(e)}"
                            )
                            failure_count += 1
            except ClientError as e:
                logger.error(f"Error in batch write operation: {str(e)}")
                # Count all items in this batch as failures
                failure_count += len(batch)
                success_count -= min(success_count, len(batch))

        logger.info(
            f"Batch created {success_count} comment clusters with {failure_count} failures"
        )
        
        return {
            'success': success_count,
            'failure': failure_count
        }
    
    def create_cluster_topic(self, topic: ClusterTopic) -> bool:
        """
        Store a cluster topic.

        Args:
            topic: Cluster topic object

        Returns:
            True if successful, False otherwise
        """
        table = self.dynamodb.Table(self.table_names['cluster_topics'])
        
        try:
            # Convert to dictionary
            # Use model_dump_json() for newer Pydantic or json() for older versions
            try:
                # Try newer Pydantic v2 method first
                item = json.loads(topic.model_dump_json())
            except AttributeError:
                # Fall back to older Pydantic v1 method
                item = json.loads(topic.json())

            # Convert floats to Decimal for DynamoDB
            item = DataConverter.prepare_for_dynamodb(item)

            # Store in DynamoDB
            table.put_item(Item=item)

            logger.info(
                f"Created topic for cluster {topic.cluster_id} in layer {topic.layer_id} "
                f"of conversation {topic.conversation_id}"
            )
            return True
        except ClientError as e:
            logger.error(f"Error creating cluster topic: {str(e)}")
            return False

    def batch_create_cluster_topics(self, topics: List[ClusterTopic]) -> Dict[str, int]:
        """
        Store multiple cluster topics in batch.

        Args:
            topics: List of cluster topic objects

        Returns:
            Dictionary with success and failure counts
        """
        if not topics:
            return {'success': 0, 'failure': 0}
        
        table = self.dynamodb.Table(self.table_names['cluster_topics'])
        
        success_count = 0
        failure_count = 0

        # Process in batches of 25 (DynamoDB batch limit)
        for i in range(0, len(topics), 25):
            batch = topics[i:i + 25]
            
            try:
                with table.batch_writer() as writer:
                    for topic in batch:
                        try:
                            # Convert to dictionary
                            # Use model_dump_json() for newer Pydantic or json() for older versions
                            try:
                                # Try newer Pydantic v2 method first
                                item = json.loads(topic.model_dump_json())
                            except AttributeError:
                                # Fall back to older Pydantic v1 method
                                item = json.loads(topic.json())

                            # Convert floats to Decimal for DynamoDB
                            item = DataConverter.prepare_for_dynamodb(item)

                            # Write to batch
                            writer.put_item(Item=item)
                            success_count += 1
                        except Exception as e:
                            logger.error(
                                f"Error processing topic for cluster {topic.cluster_key}: {str(e)}"
                            )
                            failure_count += 1
            except ClientError as e:
                logger.error(f"Error in batch write operation: {str(e)}")
                # Count all items in this batch as failures
                failure_count += len(batch)
                success_count -= min(success_count, len(batch))

        logger.info(
            f"Batch created {success_count} cluster topics with {failure_count} failures"
        )
        
        return {
            'success': success_count,
            'failure': failure_count
        }
    
    def get_cluster_topics_by_layer(
        self, 
        conversation_id: str, 
        layer_id: int
    ) -> List[Dict[str, Any]]:
        """
        Retrieve all topics for a specific layer.

        Args:
            conversation_id: ID of the conversation
            layer_id: Layer ID to retrieve topics for

        Returns:
            List of cluster topic dictionaries
        """
        table = self.dynamodb.Table(self.table_names['cluster_topics'])
        
        try:
            # Query by conversation ID and filter by layer_id
            response = table.query(
                KeyConditionExpression=Key('conversation_id').eq(conversation_id),
                FilterExpression=Attr('layer_id').eq(layer_id)
            )
            
            topics = response.get('Items', [])
            
            # Handle pagination if needed
            while 'LastEvaluatedKey' in response:
                response = table.query(
                    KeyConditionExpression=Key('conversation_id').eq(conversation_id),
                    FilterExpression=Attr('layer_id').eq(layer_id),
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
                topics.extend(response.get('Items', []))
            
            logger.info(
                f"Retrieved {len(topics)} topics for layer {layer_id} "
                f"in conversation {conversation_id}"
            )
            return topics
        except ClientError as e:
            logger.error(f"Error retrieving cluster topics: {str(e)}")
            return []

    def create_cluster_characteristic(self, characteristic):
        """
        Store a cluster characteristic.

        Args:
            characteristic: ClusterCharacteristic object

        Returns:
            True if successful, False otherwise
        """
        table = self.dynamodb.Table(self.table_names['cluster_characteristics'])
        
        try:
            # Convert to dictionary
            try:
                # Try newer Pydantic v2 method first
                item = json.loads(characteristic.model_dump_json())
            except AttributeError:
                # Fall back to older Pydantic v1 method
                item = json.loads(characteristic.json())

            # Convert floats to Decimal for DynamoDB
            item = DataConverter.prepare_for_dynamodb(item)

            # Store in DynamoDB
            table.put_item(Item=item)

            logger.info(
                f"Created characteristic for cluster {characteristic.cluster_id} in layer {characteristic.layer_id} "
                f"of conversation {characteristic.conversation_id}"
            )
            return True
        except ClientError as e:
            logger.error(f"Error creating cluster characteristic: {str(e)}")
            return False

    def batch_create_cluster_characteristics(self, characteristics):
        """
        Store multiple cluster characteristics in batch.

        Args:
            characteristics: List of ClusterCharacteristic objects

        Returns:
            Dictionary with success and failure counts
        """
        if not characteristics:
            return {'success': 0, 'failure': 0}
        
        table = self.dynamodb.Table(self.table_names['cluster_characteristics'])
        
        success_count = 0
        failure_count = 0

        # Process in batches of 25 (DynamoDB batch limit)
        for i in range(0, len(characteristics), 25):
            batch = characteristics[i:i + 25]
            
            try:
                with table.batch_writer() as writer:
                    for characteristic in batch:
                        try:
                            # Convert to dictionary
                            try:
                                # Try newer Pydantic v2 method first
                                item = json.loads(characteristic.model_dump_json())
                            except AttributeError:
                                # Fall back to older Pydantic v1 method
                                item = json.loads(characteristic.json())

                            # Convert floats to Decimal for DynamoDB
                            item = DataConverter.prepare_for_dynamodb(item)

                            # Write to batch
                            writer.put_item(Item=item)
                            success_count += 1
                        except Exception as e:
                            logger.error(
                                f"Error processing characteristic for cluster {characteristic.cluster_key}: {str(e)}"
                            )
                            failure_count += 1
            except ClientError as e:
                logger.error(f"Error in batch write operation: {str(e)}")
                # Count all items in this batch as failures
                failure_count += len(batch)
                success_count -= min(success_count, len(batch))

        logger.info(
            f"Batch created {success_count} cluster characteristics with {failure_count} failures"
        )
        
        return {
            'success': success_count,
            'failure': failure_count
        }
    
    def get_cluster_characteristics_by_layer(self, conversation_id, layer_id):
        """
        Retrieve all cluster characteristics for a specific layer.

        Args:
            conversation_id: ID of the conversation
            layer_id: Layer ID to retrieve characteristics for

        Returns:
            List of cluster characteristic dictionaries
        """
        table = self.dynamodb.Table(self.table_names['cluster_characteristics'])
        
        try:
            # Query by conversation ID and filter by layer_id
            response = table.query(
                KeyConditionExpression=Key('conversation_id').eq(conversation_id),
                FilterExpression=Attr('layer_id').eq(layer_id)
            )
            
            characteristics = response.get('Items', [])
            
            # Handle pagination if needed
            while 'LastEvaluatedKey' in response:
                response = table.query(
                    KeyConditionExpression=Key('conversation_id').eq(conversation_id),
                    FilterExpression=Attr('layer_id').eq(layer_id),
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
                characteristics.extend(response.get('Items', []))
            
            logger.info(
                f"Retrieved {len(characteristics)} cluster characteristics for layer {layer_id} "
                f"in conversation {conversation_id}"
            )
            return characteristics
        except ClientError as e:
            logger.error(f"Error retrieving cluster characteristics: {str(e)}")
            return []

    def create_enhanced_topic_name(self, topic_name):
        """
        Store an enhanced topic name.

        Args:
            topic_name: EnhancedTopicName object

        Returns:
            True if successful, False otherwise
        """
        table = self.dynamodb.Table(self.table_names['enhanced_topic_names'])
        
        try:
            # Convert to dictionary
            try:
                # Try newer Pydantic v2 method first
                item = json.loads(topic_name.model_dump_json())
            except AttributeError:
                # Fall back to older Pydantic v1 method
                item = json.loads(topic_name.json())

            # Convert floats to Decimal for DynamoDB
            item = DataConverter.prepare_for_dynamodb(item)

            # Store in DynamoDB
            table.put_item(Item=item)

            logger.info(
                f"Created enhanced topic name for cluster {topic_name.cluster_id} in layer {topic_name.layer_id} "
                f"of conversation {topic_name.conversation_id}"
            )
            return True
        except ClientError as e:
            logger.error(f"Error creating enhanced topic name: {str(e)}")
            return False

    def batch_create_enhanced_topic_names(self, topic_names):
        """
        Store multiple enhanced topic names in batch.

        Args:
            topic_names: List of EnhancedTopicName objects

        Returns:
            Dictionary with success and failure counts
        """
        if not topic_names:
            return {'success': 0, 'failure': 0}
        
        table = self.dynamodb.Table(self.table_names['enhanced_topic_names'])
        
        success_count = 0
        failure_count = 0

        # Process in batches of 25 (DynamoDB batch limit)
        for i in range(0, len(topic_names), 25):
            batch = topic_names[i:i + 25]
            
            try:
                with table.batch_writer() as writer:
                    for topic_name in batch:
                        try:
                            # Convert to dictionary
                            try:
                                # Try newer Pydantic v2 method first
                                item = json.loads(topic_name.model_dump_json())
                            except AttributeError:
                                # Fall back to older Pydantic v1 method
                                item = json.loads(topic_name.json())

                            # Convert floats to Decimal for DynamoDB
                            item = DataConverter.prepare_for_dynamodb(item)

                            # Write to batch
                            writer.put_item(Item=item)
                            success_count += 1
                        except Exception as e:
                            logger.error(
                                f"Error processing enhanced topic name for {topic_name.topic_key}: {str(e)}"
                            )
                            failure_count += 1
            except ClientError as e:
                logger.error(f"Error in batch write operation: {str(e)}")
                # Count all items in this batch as failures
                failure_count += len(batch)
                success_count -= min(success_count, len(batch))

        logger.info(
            f"Batch created {success_count} enhanced topic names with {failure_count} failures"
        )
        
        return {
            'success': success_count,
            'failure': failure_count
        }
    
    def create_llm_topic_name(self, topic_name):
        """
        Store an LLM-generated topic name.

        Args:
            topic_name: LLMTopicName object

        Returns:
            True if successful, False otherwise
        """
        table = self.dynamodb.Table(self.table_names['llm_topic_names'])
        
        try:
            # Convert to dictionary
            try:
                # Try newer Pydantic v2 method first
                item = json.loads(topic_name.model_dump_json())
            except AttributeError:
                # Fall back to older Pydantic v1 method
                item = json.loads(topic_name.json())

            # Convert floats to Decimal for DynamoDB
            item = DataConverter.prepare_for_dynamodb(item)

            # Store in DynamoDB
            table.put_item(Item=item)

            logger.info(
                f"Created LLM topic name for cluster {topic_name.cluster_id} in layer {topic_name.layer_id} "
                f"of conversation {topic_name.conversation_id}"
            )
            return True
        except ClientError as e:
            logger.error(f"Error creating LLM topic name: {str(e)}")
            return False

    def batch_create_llm_topic_names(self, topic_names):
        """
        Store multiple LLM-generated topic names in batch.

        Args:
            topic_names: List of LLMTopicName objects

        Returns:
            Dictionary with success and failure counts
        """
        if not topic_names:
            return {'success': 0, 'failure': 0}
        
        table = self.dynamodb.Table(self.table_names['llm_topic_names'])
        
        success_count = 0
        failure_count = 0

        # Process in batches of 25 (DynamoDB batch limit)
        for i in range(0, len(topic_names), 25):
            batch = topic_names[i:i + 25]
            
            try:
                with table.batch_writer() as writer:
                    for topic_name in batch:
                        try:
                            # Convert to dictionary
                            try:
                                # Try newer Pydantic v2 method first
                                item = json.loads(topic_name.model_dump_json())
                            except AttributeError:
                                # Fall back to older Pydantic v1 method
                                item = json.loads(topic_name.json())

                            # Convert floats to Decimal for DynamoDB
                            item = DataConverter.prepare_for_dynamodb(item)

                            # Write to batch
                            writer.put_item(Item=item)
                            success_count += 1
                        except Exception as e:
                            logger.error(
                                f"Error processing LLM topic name for {topic_name.topic_key}: {str(e)}"
                            )
                            failure_count += 1
            except ClientError as e:
                logger.error(f"Error in batch write operation: {str(e)}")
                # Count all items in this batch as failures
                failure_count += len(batch)
                success_count -= min(success_count, len(batch))

        logger.info(
            f"Batch created {success_count} LLM topic names with {failure_count} failures"
        )
        
        return {
            'success': success_count,
            'failure': failure_count
        }
    
    # Note: Methods for storing comment texts in DynamoDB have been intentionally removed
    # Comment texts are kept in PostgreSQL which serves as the single source of truth
    # This design decision avoids data duplication and ensures data consistency

    def create_comment_text(self, comment: CommentText) -> bool:
        """
        Method stub that logs a reminder that comments are not stored in DynamoDB.

        Args:
            comment: Comment text object (not used)

        Returns:
            Always False as operation is not supported
        """
        logger.warning(
            f"Ignoring request to store comment {comment.comment_id} in DynamoDB. "
            f"Comment texts are stored only in PostgreSQL."
        )
        return False

    def batch_create_comment_texts(self, comments: List[CommentText]) -> Dict[str, int]:
        """
        Method stub that logs a reminder that comments are not stored in DynamoDB.

        Args:
            comments: List of comment text objects (not used)

        Returns:
            Status dictionary showing 0 successes
        """
        if comments:
            logger.warning(
                f"Ignoring request to store {len(comments)} comments in DynamoDB. "
                f"Comment texts are stored only in PostgreSQL."
            )
        
        return {
            'success': 0,
            'failure': 0
        }
    
    def create_graph_edge(self, edge: UMAPGraphEdge) -> bool:
        """
        Store a graph edge.

        Args:
            edge: Graph edge object

        Returns:
            True if successful, False otherwise
        """
        table = self.dynamodb.Table(self.table_names['umap_graph'])
        
        try:
            # Convert to dictionary
            # Use model_dump_json() for newer Pydantic or json() for older versions
            try:
                # Try newer Pydantic v2 method first
                item = json.loads(edge.model_dump_json())
            except AttributeError:
                # Fall back to older Pydantic v1 method
                item = json.loads(edge.json())

            # Convert floats to Decimal for DynamoDB
            item = DataConverter.prepare_for_dynamodb(item)

            # Store in DynamoDB
            table.put_item(Item=item)

            return True
        except ClientError as e:
            logger.error(f"Error creating graph edge: {str(e)}")
            return False

    def batch_create_graph_edges(self, edges: List[UMAPGraphEdge]) -> Dict[str, int]:
        """
        Store multiple graph edges in batch.

        Args:
            edges: List of graph edge objects

        Returns:
            Dictionary with success and failure counts
        """
        if not edges:
            return {'success': 0, 'failure': 0}
        
        table = self.dynamodb.Table(self.table_names['umap_graph'])
        
        success_count = 0
        failure_count = 0

        # Process in batches of 25 (DynamoDB batch limit)
        for i in range(0, len(edges), 25):
            batch = edges[i:i + 25]
            
            try:
                with table.batch_writer() as writer:
                    for edge in batch:
                        try:
                            # Convert to dictionary
                            # Use model_dump_json() for newer Pydantic or json() for older versions
                            try:
                                # Try newer Pydantic v2 method first
                                item = json.loads(edge.model_dump_json())
                            except AttributeError:
                                # Fall back to older Pydantic v1 method
                                item = json.loads(edge.json())

                            # Convert floats to Decimal for DynamoDB
                            item = DataConverter.prepare_for_dynamodb(item)

                            # Write to batch
                            writer.put_item(Item=item)
                            success_count += 1
                        except Exception as e:
                            logger.error(
                                f"Error processing edge {edge.edge_id}: {str(e)}"
                            )
                            failure_count += 1
            except ClientError as e:
                logger.error(f"Error in batch write operation: {str(e)}")
                # Count all items in this batch as failures
                failure_count += len(batch)
                success_count -= min(success_count, len(batch))

        logger.info(
            f"Batch created {success_count} graph edges with {failure_count} failures"
        )
        
        return {
            'success': success_count,
            'failure': failure_count
        }
    
    def get_visualization_data(
        self, 
        conversation_id: str, 
        layer_id: int
    ) -> Dict[str, Any]:
        """
        Retrieve data needed for visualization.

        Args:
            conversation_id: ID of the conversation
            layer_id: Layer ID to retrieve data for

        Returns:
            Dictionary with comments and clusters for visualization
        """
        # Get all comment embeddings
        table = self.dynamodb.Table(self.table_names['comment_embeddings'])
        
        try:
            # Query comments by conversation ID
            response = table.query(
                KeyConditionExpression=Key('conversation_id').eq(conversation_id)
            )
            
            comments = response.get('Items', [])
            
            # Handle pagination if needed
            while 'LastEvaluatedKey' in response:
                response = table.query(
                    KeyConditionExpression=Key('conversation_id').eq(conversation_id),
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
                comments.extend(response.get('Items', []))
            
            # Get all comment clusters
            clusters_table = self.dynamodb.Table(self.table_names['comment_clusters'])
            
            response = clusters_table.query(
                KeyConditionExpression=Key('conversation_id').eq(conversation_id)
            )
            
            clusters = response.get('Items', [])
            
            # Handle pagination if needed
            while 'LastEvaluatedKey' in response:
                response = clusters_table.query(
                    KeyConditionExpression=Key('conversation_id').eq(conversation_id),
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
                clusters.extend(response.get('Items', []))
            
            # Get all topics
            topics = self.get_cluster_topics_by_layer(conversation_id, layer_id)

            # Combine data into visualization format
            comment_data = []
            for comment in comments:
                # Find matching cluster
                cluster_info = next(
                    (c for c in clusters if c['comment_id'] == comment['comment_id']), 
                    None
                )

                if cluster_info:
                    cluster_id = cluster_info.get(f'layer{layer_id}_cluster_id', -1)
                    
                    comment_data.append({
                        'id': comment['comment_id'],
                        'coordinates': comment['umap_coordinates'],
                        'cluster_id': cluster_id
                    })
            
            cluster_data = []
            for topic in topics:
                cluster_data.append({
                    'id': topic['cluster_id'],
                    'label': topic.get('topic_label', f"Cluster {topic['cluster_id']}"),
                    'size': topic.get('size', 0),
                    'centroid': topic.get('centroid_coordinates', {'x': 0, 'y': 0})
                })
            
            logger.info(
                f"Retrieved visualization data for layer {layer_id} in "
                f"conversation {conversation_id}: {len(comment_data)} comments, "
                f"{len(cluster_data)} clusters"
            )

            return {
                'conversation_id': conversation_id,
                'layer_id': layer_id,
                'comments': comment_data,
                'clusters': cluster_data
            }

        except ClientError as e:
            logger.error(f"Error retrieving visualization data: {str(e)}")
            return {
                'conversation_id': conversation_id,
                'layer_id': layer_id,
                'comments': [],
                'clusters': []
            }
