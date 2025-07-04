#!/usr/bin/env python3
"""
DynamoDB client for Polis math system.

This module provides a client for interacting with Amazon DynamoDB
to store and retrieve Polis conversation mathematical analysis data.
"""

import boto3
import time
import os
import logging
import json
import numpy as np
from typing import Dict, Any, List, Optional, Union

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class DynamoDBClient:
    """Client for interacting with DynamoDB for Polis math data."""
    
    def __init__(self, 
                endpoint_url: Optional[str] = None,
                region_name: str = 'us-east-1',
                aws_access_key_id: Optional[str] = None,
                aws_secret_access_key: Optional[str] = None):
        """
        Initialize DynamoDB client.
        
        Args:
            endpoint_url: URL for the DynamoDB service
            region_name: AWS region name
            aws_access_key_id: AWS access key ID (uses environment variables if None)
            aws_secret_access_key: AWS secret access key (uses environment variables if None)
        """
        self.endpoint_url = endpoint_url
        self.region_name = region_name
        self.aws_access_key_id = aws_access_key_id
        self.aws_secret_access_key = aws_secret_access_key
        
        self.dynamodb = None
        self.tables = {}
        
    def initialize(self):
        """Initialize DynamoDB connection and create tables if needed."""
        # Set up environment variables for credentials if not provided and not already set
        if not self.aws_access_key_id and not os.environ.get('AWS_ACCESS_KEY_ID'):
            os.environ['AWS_ACCESS_KEY_ID'] = 'dummy'
        
        if not self.aws_secret_access_key and not os.environ.get('AWS_SECRET_ACCESS_KEY'):
            os.environ['AWS_SECRET_ACCESS_KEY'] = 'dummy'
        
        # Create DynamoDB client
        kwargs = {
            'region_name': self.region_name
        }
        
        if self.endpoint_url:
            kwargs['endpoint_url'] = self.endpoint_url
        
        if self.aws_access_key_id and self.aws_secret_access_key:
            kwargs['aws_access_key_id'] = self.aws_access_key_id
            kwargs['aws_secret_access_key'] = self.aws_secret_access_key
            
        self.dynamodb = boto3.resource('dynamodb', **kwargs)
        
        # Create tables if they don't exist
        self._ensure_tables_exist()
    
    def _ensure_tables_exist(self):
        """Ensure all required tables exist."""
        # List existing tables
        existing_tables = [t.name for t in self.dynamodb.tables.all()]
        logger.info(f"Existing DynamoDB tables: {existing_tables}")
        
        # Define table schemas
        table_schemas = {
            # Main conversation metadata table
            'Delphi_PCAConversationConfig': {
                'KeySchema': [
                    {'AttributeName': 'zid', 'KeyType': 'HASH'}
                ],
                'AttributeDefinitions': [
                    {'AttributeName': 'zid', 'AttributeType': 'S'}
                ],
                'ProvisionedThroughput': {
                    'ReadCapacityUnits': 5,
                    'WriteCapacityUnits': 5
                }
            },
            # PCA and cluster data
            'Delphi_PCAResults': {
                'KeySchema': [
                    {'AttributeName': 'zid', 'KeyType': 'HASH'},
                    {'AttributeName': 'math_tick', 'KeyType': 'RANGE'}
                ],
                'AttributeDefinitions': [
                    {'AttributeName': 'zid', 'AttributeType': 'S'},
                    {'AttributeName': 'math_tick', 'AttributeType': 'N'}
                ],
                'ProvisionedThroughput': {
                    'ReadCapacityUnits': 5,
                    'WriteCapacityUnits': 5
                }
            },
            # Group data
            'Delphi_KMeansClusters': {
                'KeySchema': [
                    {'AttributeName': 'zid_tick', 'KeyType': 'HASH'},
                    {'AttributeName': 'group_id', 'KeyType': 'RANGE'}
                ],
                'AttributeDefinitions': [
                    {'AttributeName': 'zid_tick', 'AttributeType': 'S'},
                    {'AttributeName': 'group_id', 'AttributeType': 'N'}
                ],
                'ProvisionedThroughput': {
                    'ReadCapacityUnits': 5,
                    'WriteCapacityUnits': 5
                }
            },
            # Comment data with priorities
            'Delphi_CommentRouting': {
                'KeySchema': [
                    {'AttributeName': 'zid_tick', 'KeyType': 'HASH'},
                    {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
                ],
                'AttributeDefinitions': [
                    {'AttributeName': 'zid_tick', 'AttributeType': 'S'},
                    {'AttributeName': 'comment_id', 'AttributeType': 'S'}
                ],
                'ProvisionedThroughput': {
                    'ReadCapacityUnits': 5,
                    'WriteCapacityUnits': 5
                }
            },
            # Representativeness data
            'Delphi_RepresentativeComments': {
                'KeySchema': [
                    {'AttributeName': 'zid_tick_gid', 'KeyType': 'HASH'},
                    {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
                ],
                'AttributeDefinitions': [
                    {'AttributeName': 'zid_tick_gid', 'AttributeType': 'S'},
                    {'AttributeName': 'comment_id', 'AttributeType': 'S'}
                ],
                'ProvisionedThroughput': {
                    'ReadCapacityUnits': 5,
                    'WriteCapacityUnits': 5
                }
            },
            # Participant projection data
            'Delphi_PCAParticipantProjections': {
                'KeySchema': [
                    {'AttributeName': 'zid_tick', 'KeyType': 'HASH'},
                    {'AttributeName': 'participant_id', 'KeyType': 'RANGE'}
                ],
                'AttributeDefinitions': [
                    {'AttributeName': 'zid_tick', 'AttributeType': 'S'},
                    {'AttributeName': 'participant_id', 'AttributeType': 'S'}
                ],
                'ProvisionedThroughput': {
                    'ReadCapacityUnits': 5,
                    'WriteCapacityUnits': 5
                }
            }
        }
        
        # Create tables if they don't exist
        for table_name, schema in table_schemas.items():
            if table_name in existing_tables:
                logger.info(f"Table {table_name} already exists")
                self.tables[table_name] = self.dynamodb.Table(table_name)
                continue
            
            try:
                logger.info(f"Creating table {table_name}")
                table = self.dynamodb.create_table(
                    TableName=table_name,
                    **schema
                )
                
                # Wait for table creation
                table.meta.client.get_waiter('table_exists').wait(TableName=table_name)
                logger.info(f"Created table {table_name}")
                
                self.tables[table_name] = table
            except Exception as e:
                logger.error(f"Error creating table {table_name}: {e}")
    
    def _numpy_to_list(self, obj):
        """Convert numpy arrays to lists for JSON serialization."""
        import decimal
        
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        elif isinstance(obj, list):
            return [self._numpy_to_list(item) for item in obj]
        elif isinstance(obj, dict):
            return {k: self._numpy_to_list(v) for k, v in obj.items()}
        elif isinstance(obj, (np.int64, np.int32, np.int16, np.int8)):
            return int(obj)
        elif isinstance(obj, (np.float64, np.float32, np.float16)):
            # Convert float to Decimal for DynamoDB compatibility
            return decimal.Decimal(str(float(obj)))
        elif isinstance(obj, float):
            # Convert Python float to Decimal for DynamoDB compatibility
            return decimal.Decimal(str(obj))
        return obj
    
    def _replace_floats_with_decimals(self, obj):
        """
        Recursively replace all float values with Decimal objects.
        This is needed for DynamoDB compatibility.
        
        Args:
            obj: Any Python object that might contain floats
            
        Returns:
            Object with all floats replaced by Decimal
        """
        import decimal
        
        if isinstance(obj, float):
            return decimal.Decimal(str(obj))
        elif isinstance(obj, dict):
            return {k: self._replace_floats_with_decimals(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self._replace_floats_with_decimals(x) for x in obj]
        elif isinstance(obj, tuple):
            return tuple(self._replace_floats_with_decimals(x) for x in obj)
        else:
            return obj
            
    def write_conversation(self, conv) -> bool:
        """
        Write a conversation's mathematical analysis data to DynamoDB,
        including all projections for all participants.
        
        Args:
            conv: Conversation object with math analysis data
            
        Returns:
            Success status
        """
        import decimal
        
        try:
            # Get conversation ID as string
            zid = str(conv.conversation_id)
            logger.info(f"Writing conversation {zid} to DynamoDB")
            
            # Convert conversation to optimized DynamoDB format
            dynamo_data = conv.to_dynamo_dict() if hasattr(conv, 'to_dynamo_dict') else None
            
            # Generate a math tick (version identifier)
            # Use the one from dynamo_data if available, otherwise create a new one
            math_tick = dynamo_data.get('math_tick', int(time.time())) if dynamo_data else int(time.time())
            
            # Create composite ID for related tables
            zid_tick = f"{zid}:{math_tick}"
            
            # 1. Write to Delphi_PCAConversationConfig table
            conversations_table = self.tables.get('Delphi_PCAConversationConfig')
            if conversations_table:
                if dynamo_data:
                    # Use pre-formatted data
                    conversations_table.put_item(Item={
                        'zid': zid,
                        'latest_math_tick': math_tick,
                        'participant_count': dynamo_data.get('participant_count', 0),
                        'comment_count': dynamo_data.get('comment_count', 0),
                        'group_count': dynamo_data.get('group_count', 0),
                        'last_updated': int(time.time())
                    })
                else:
                    # Use legacy method
                    conversations_table.put_item(Item={
                        'zid': zid,
                        'latest_math_tick': math_tick,
                        'participant_count': conv.participant_count,
                        'comment_count': conv.comment_count,
                        'group_count': len(conv.group_clusters) if hasattr(conv, 'group_clusters') else 0,
                        'last_updated': int(time.time())
                    })
                logger.info(f"Written conversation metadata for {zid}")
            else:
                logger.warning("Delphi_PCAConversationConfig table not available")
            
            # 2. Write to Delphi_PCAResults table
            analysis_table = self.tables.get('Delphi_PCAResults')
            if analysis_table:
                if dynamo_data:
                    # Use pre-formatted data
                    analysis_table.put_item(Item={
                        'zid': zid,
                        'math_tick': math_tick,
                        'timestamp': int(time.time()),
                        'participant_count': dynamo_data.get('participant_count', 0),
                        'comment_count': dynamo_data.get('comment_count', 0),
                        'group_count': dynamo_data.get('group_count', 0),
                        'pca': dynamo_data.get('pca', {}),
                        'consensus_comments': dynamo_data.get('consensus', {}).get('agree', [])
                    })
                else:
                    # Legacy format
                    # Prepare PCA data
                    pca_data = {}
                    if hasattr(conv, 'pca') and conv.pca:
                        pca_data = {
                            'center': self._numpy_to_list(conv.pca.get('center', [])),
                            'components': self._numpy_to_list(conv.pca.get('comps', []))
                        }
                        # Replace floats with Decimal for DynamoDB
                        pca_data = self._replace_floats_with_decimals(pca_data)
                    
                    # Create the analysis record with Decimal conversion
                    consensus_comments = self._numpy_to_list(conv.consensus) if hasattr(conv, 'consensus') else []
                    consensus_comments = self._replace_floats_with_decimals(consensus_comments)
                    
                    analysis_table.put_item(Item={
                        'zid': zid,
                        'math_tick': math_tick,
                        'timestamp': int(time.time()),
                        'participant_count': conv.participant_count,
                        'comment_count': conv.comment_count,
                        'group_count': len(conv.group_clusters) if hasattr(conv, 'group_clusters') else 0,
                        'pca': pca_data,
                        'consensus_comments': consensus_comments
                    })
                logger.info(f"Written analysis data for {zid}")
            else:
                logger.warning("Delphi_PCAResults table not available")
            
            # 3. Write to Delphi_KMeansClusters table
            groups_table = self.tables.get('Delphi_KMeansClusters')
            if groups_table:
                if dynamo_data and 'group_clusters' in dynamo_data:
                    # Use pre-formatted data with Python-native keys
                    with groups_table.batch_writer() as batch:
                        for group in dynamo_data.get('group_clusters', []):
                            group_id = group.get('id', 0)
                            members = group.get('members', [])
                            
                            # Store all members without truncation
                            batch.put_item(Item={
                                'zid_tick': zid_tick,
                                'group_id': group_id,
                                'center': group.get('center', []),
                                'member_count': len(members),
                                'members': members,
                            })
                elif hasattr(conv, 'group_clusters'):
                    # Legacy format
                    with groups_table.batch_writer() as batch:
                        for group in conv.group_clusters:
                            group_id = group.get('id', 0)
                            members = group.get('members', [])
                            center = self._numpy_to_list(group.get('center', []))
                            
                            # Convert any floats to Decimal
                            center = self._replace_floats_with_decimals(center)
                            
                            # Create the group record with all members
                            batch.put_item(Item={
                                'zid_tick': zid_tick,
                                'group_id': group_id,
                                'center': center,
                                'member_count': len(members),
                                'members': self._numpy_to_list(members),
                            })
                logger.info(f"Written group data for {zid}")
            else:
                logger.warning("Delphi_KMeansClusters table not available or no group data")
            
            # 4. Write to Delphi_CommentRouting table
            comments_table = self.tables.get('Delphi_CommentRouting')
            if comments_table:
                if dynamo_data and 'votes_base' in dynamo_data:
                    # Use pre-formatted data with Python-native keys
                    with comments_table.batch_writer() as batch:
                        votes_base = dynamo_data.get('votes_base', {})
                        priorities = dynamo_data.get('comment_priorities', {})
                        consensus_scores = dynamo_data.get('group_consensus', {})
                        
                        for comment_id, vote_stats in votes_base.items():
                            batch.put_item(Item={
                                'zid_tick': zid_tick,
                                'comment_id': str(comment_id),
                                'priority': priorities.get(comment_id, 0),
                                'stats': vote_stats,
                                'consensus_score': consensus_scores.get(comment_id, decimal.Decimal('0'))
                            })
                else:
                    # Legacy format
                    # Get comment priorities
                    comment_priorities = {}
                    if hasattr(conv, 'comment_priorities'):
                        comment_priorities = conv.comment_priorities
                    
                    # Get vote stats
                    comment_stats = {}
                    if hasattr(conv, 'vote_stats') and 'comment_stats' in conv.vote_stats:
                        comment_stats = conv.vote_stats['comment_stats']
                    
                    # Get consensus scores
                    consensus_scores = {}
                    if hasattr(conv, '_compute_group_aware_consensus'):
                        consensus_scores = conv._compute_group_aware_consensus()
                    
                    # Write comment data
                    with comments_table.batch_writer() as batch:
                        for comment_id in comment_stats:
                            # Convert float values to Decimal
                            stats = self._numpy_to_list(comment_stats.get(comment_id, {}))
                            stats = self._replace_floats_with_decimals(stats)
                            consensus_score = self._replace_floats_with_decimals(consensus_scores.get(comment_id, 0))
                            
                            batch.put_item(Item={
                                'zid_tick': zid_tick,
                                'comment_id': str(comment_id),
                                'priority': comment_priorities.get(comment_id, 0),
                                'stats': stats,
                                'consensus_score': consensus_score
                            })
                logger.info(f"Written comment data for {zid}")
            else:
                logger.warning("Delphi_CommentRouting table not available")
            
            # 5. Write to Delphi_RepresentativeComments table
            repness_table = self.tables.get('Delphi_RepresentativeComments')
            if repness_table:
                if dynamo_data and 'repness' in dynamo_data and 'comment_repness' in dynamo_data['repness']:
                    # Use pre-formatted data with Python-native keys
                    with repness_table.batch_writer() as batch:
                        for item in dynamo_data['repness']['comment_repness']:
                            group_id = item.get('group_id', 0)
                            comment_id = item.get('comment_id', '')
                            
                            # Create composite key for group representativeness
                            zid_tick_gid = f"{zid}:{math_tick}:{group_id}"

                            logger.debug(f"working on comment {comment_id}")
                            
                            batch.put_item(Item={
                                'zid_tick_gid': zid_tick_gid,
                                'comment_id': str(comment_id),
                                'repness': item.get('repness', decimal.Decimal('0')),
                                'group_id': group_id
                            })
                elif hasattr(conv, 'repness') and 'comment_repness' in conv.repness:
                    # Legacy format
                    with repness_table.batch_writer() as batch:
                        for item in conv.repness['comment_repness']:
                            group_id = item.get('gid', 0)
                            comment_id = item.get('tid', '')
                            repness_value = item.get('repness', 0)
                            
                            # Convert float to Decimal
                            repness_value = self._replace_floats_with_decimals(repness_value)
                            
                            # Create composite key for group representativeness
                            zid_tick_gid = f"{zid}:{math_tick}:{group_id}"

                            logger.debug(f"working on comment {comment_id}")
                            
                            batch.put_item(Item={
                                'zid_tick_gid': zid_tick_gid,
                                'comment_id': str(comment_id),
                                'repness': repness_value,
                                'group_id': group_id
                            })
                logger.info(f"Written representativeness data for {zid}")
            else:
                logger.warning("Delphi_RepresentativeComments table not available or no repness data")
            
            # 6. Write to Delphi_PCAParticipantProjections table (most time-consuming for large conversations)
            projections_table = self.tables.get('Delphi_PCAParticipantProjections')
            if projections_table and hasattr(conv, 'proj'):
                logger.info(f"Writing projection data for {len(conv.proj)} participants...")
                
                # Create a mapping of participants to their groups
                participant_groups = {}
                if hasattr(conv, 'group_clusters'):
                    for group in conv.group_clusters:
                        group_id = group.get('id', 0)
                        for member in group.get('members', []):
                            participant_groups[member] = group_id
                    
                # Use a more efficient batch writing approach with adaptive chunking for very large datasets
                batch_size = 25  # Amazon DynamoDB max batch size is 25
                total_participants = len(conv.proj)
                participant_items = []
                
                # For very large datasets (like Pakistan with 18,000+ participants), optimize batch size and logging
                log_interval = max(1, min(total_participants // 10, 1000))  # Log every ~10% of progress
                processed_count = 0
                last_log_time = time.time()
                
                # Process projections
                logger.info(f"Starting batch processing of {total_participants} participant projections")
                proj_start = time.time()
                
                for participant_id, coords in conv.proj.items():
                    # Convert coordinates to Decimal
                    coordinates = self._numpy_to_list(coords)
                    coordinates = self._replace_floats_with_decimals(coordinates)
                    
                    # Create the item
                    participant_items.append({
                        'zid_tick': zid_tick,
                        'participant_id': str(participant_id),
                        'coordinates': coordinates,
                        'group_id': participant_groups.get(participant_id, -1)
                    })
                    
                    processed_count += 1
                    
                    # If we've reached the batch size or it's the last item, write the batch
                    if len(participant_items) >= batch_size or processed_count == total_participants:
                        # Write this batch
                        with projections_table.batch_writer() as batch:
                            for item in participant_items:
                                batch.put_item(Item=item)
                        
                        # Log progress at appropriate intervals
                        now = time.time()
                        if processed_count % log_interval == 0 or processed_count == total_participants:
                            progress_pct = (processed_count / total_participants) * 100
                            elapsed = now - proj_start
                            item_rate = processed_count / elapsed if elapsed > 0 else 0
                            remaining = (total_participants - processed_count) / item_rate if item_rate > 0 else 0
                            
                            logger.info(f"Written {processed_count}/{total_participants} participants ({progress_pct:.1f}%) - "
                                      f"{item_rate:.1f} items/sec, est. remaining: {remaining:.1f}s")
                            
                            # Update last log time
                            last_log_time = now
                        
                        # Clear the batch
                        participant_items = []
                
                # Log completion for the entire projection process
                proj_time = time.time() - proj_start
                logger.info(f"Participant projection processing completed in {proj_time:.2f}s - "
                          f"average rate: {total_participants/proj_time:.1f} items/sec")
                
                logger.info(f"Written projection data for {zid}")
            else:
                logger.warning("Delphi_PCAParticipantProjections table not available or no projection data")
            
            logger.info(f"Successfully written conversation data for {zid}")
            return True
            
        except Exception as e:
            logger.error(f"Error writing conversation to DynamoDB: {e}")
            import traceback
            traceback.print_exc()
            return False
            
    def write_projections_separately(self, conv) -> bool:
        """
        Write participant projections separately for large conversations.
        This method optimizes for reliability with very large conversations (10,000+ participants)
        by using smaller batch sizes and processing data in chunks.
        
        Args:
            conv: Conversation object with projection data
            
        Returns:
            Success status (True if projections were written successfully)
        """
        import decimal
        
        try:
            # Get conversation ID as string
            zid = str(conv.conversation_id)
            logger.info(f"Writing projections separately for large conversation {zid}")
            
            # Get the latest math tick from the database
            conversations_table = self.tables.get('Delphi_PCAConversationConfig')
            if not conversations_table:
                logger.error(f"Delphi_PCAConversationConfig table not available")
                return False
                
            # Look up the math tick that was used for the other tables
            response = conversations_table.get_item(Key={'zid': zid})
            if 'Item' not in response:
                logger.error(f"Conversation {zid} not found in DynamoDB")
                return False
                
            math_tick = response['Item'].get('latest_math_tick')
            if not math_tick:
                logger.error(f"No math tick found for conversation {zid}")
                return False
                
            # Create composite ID for related tables
            zid_tick = f"{zid}:{math_tick}"
            
            # Check if projections table exists
            projections_table = self.tables.get('Delphi_PCAParticipantProjections')
            if not projections_table:
                logger.error(f"Delphi_PCAParticipantProjections table not available")
                return False
                
            # Create a mapping of participants to their groups
            participant_groups = {}
            if hasattr(conv, 'group_clusters'):
                for group in conv.group_clusters:
                    group_id = group.get('id', 0)
                    for member in group.get('members', []):
                        participant_groups[member] = group_id
            
            # Calculate processing parameters - adaptive based on conversation size
            total_participants = len(conv.proj)
            is_very_large = total_participants > 10000
            
            # DynamoDB has a max batch size of 25, but we use smaller batches for very large datasets
            batch_size = 10 if is_very_large else 25
            
            # Larger chunks increase throughput but consume more memory
            chunk_size = 100 if is_very_large else 500
            
            # Calculate how many chunks we'll process
            chunks = []
            participants = list(conv.proj.keys())
            
            for i in range(0, total_participants, chunk_size):
                chunk_keys = participants[i:i+chunk_size]
                chunks.append(chunk_keys)
                
            logger.info(f"Processing {total_participants} projections in {len(chunks)} chunks "
                       f"with batch size {batch_size}")
            
            # Track progress
            total_success = 0
            total_errors = 0
            overall_start = time.time()
            
            # Process each chunk
            for chunk_idx, chunk_keys in enumerate(chunks):
                chunk_start = time.time()
                logger.info(f"Processing chunk {chunk_idx+1}/{len(chunks)} with {len(chunk_keys)} participants")
                
                # Prepare to process this chunk
                batch_items = []
                processed_in_chunk = 0
                
                # Process each participant in this chunk
                for participant_id in chunk_keys:
                    if participant_id not in conv.proj:
                        continue
                        
                    # Get projection coordinates
                    coords = conv.proj[participant_id]
                    
                    # Convert coordinates to DynamoDB-compatible format
                    coordinates = self._numpy_to_list(coords)
                    coordinates = self._replace_floats_with_decimals(coordinates)
                    
                    # Create the item for DynamoDB
                    batch_items.append({
                        'zid_tick': zid_tick,
                        'participant_id': str(participant_id),
                        'coordinates': coordinates,
                        'group_id': participant_groups.get(participant_id, -1)
                    })
                    
                    processed_in_chunk += 1
                    
                    # Write a batch when we reach batch size or end of chunk
                    if len(batch_items) >= batch_size or processed_in_chunk == len(chunk_keys):
                        try:
                            # Write this batch
                            with projections_table.batch_writer() as batch:
                                for item in batch_items:
                                    batch.put_item(Item=item)
                                    
                            total_success += len(batch_items)
                        except Exception as e:
                            logger.error(f"Error writing batch in chunk {chunk_idx+1}: {e}")
                            total_errors += len(batch_items)
                            
                        # Clear the batch for next round
                        batch_items = []
                
                # Log progress for this chunk
                chunk_time = time.time() - chunk_start
                items_per_sec = processed_in_chunk / chunk_time if chunk_time > 0 else 0
                progress_pct = (chunk_idx + 1) / len(chunks) * 100
                
                logger.info(f"Chunk {chunk_idx+1}/{len(chunks)} completed in {chunk_time:.2f}s "
                           f"({items_per_sec:.1f} items/sec) - {progress_pct:.1f}% complete")
            
            # Log final results
            total_time = time.time() - overall_start
            logger.info(f"Projection processing completed in {total_time:.2f}s: "
                       f"{total_success} successful, {total_errors} errors")
            
            # Verify that projections were actually written
            if total_success > 0:
                verification_response = projections_table.query(
                    KeyConditionExpression=boto3.dynamodb.conditions.Key('zid_tick').eq(zid_tick),
                    Limit=5
                )
                
                if 'Items' in verification_response and verification_response['Items']:
                    logger.info(f"Verified projections were successfully written for {zid}")
                    return True
                else:
                    logger.error(f"No projections found after write operation for {zid}")
                    return False
            else:
                logger.error(f"No projections were successfully written")
                return False
            
        except Exception as e:
            logger.error(f"Error writing projections separately: {e}")
            import traceback
            traceback.print_exc()
            return False
    
    def read_conversation_meta(self, zid: str) -> Dict[str, Any]:
        """
        Read conversation metadata from DynamoDB.
        
        Args:
            zid: Conversation ID
            
        Returns:
            Conversation metadata
        """
        try:
            conversations_table = self.tables.get('Delphi_PCAConversationConfig')
            if not conversations_table:
                logger.warning("Delphi_PCAConversationConfig table not available")
                return {}
            
            response = conversations_table.get_item(Key={'zid': str(zid)})
            if 'Item' not in response:
                logger.warning(f"No metadata found for conversation {zid}")
                return {}
            
            return response['Item']
        except Exception as e:
            logger.error(f"Error reading conversation metadata: {e}")
            return {}
    
    def read_latest_math(self, zid: str) -> Dict[str, Any]:
        """
        Read the latest math analysis data for a conversation.
        
        Args:
            zid: Conversation ID
            
        Returns:
            Math analysis data
        """
        try:
            # First get the latest math tick
            meta = self.read_conversation_meta(zid)
            if not meta or 'latest_math_tick' not in meta:
                logger.warning(f"No latest math tick found for conversation {zid}")
                return {}
            
            math_tick = meta['latest_math_tick']
            return self.read_math_by_tick(zid, math_tick)
        except Exception as e:
            logger.error(f"Error reading latest math: {e}")
            return {}
    
    def read_math_by_tick(self, zid: str, math_tick: int) -> Dict[str, Any]:
        """
        Read math analysis data for a specific version.
        
        Args:
            zid: Conversation ID
            math_tick: Math version timestamp
            
        Returns:
            Math analysis data reconstructed in a format compatible with Conversation.from_dict()
        """
        try:
            zid = str(zid)
            zid_tick = f"{zid}:{math_tick}"
            result = {
                'conversation_id': zid,
                'last_updated': int(time.time()),
                'group_clusters': [],
                'proj': {},
                'repness': {
                    'comment_repness': []
                },
                'vote_stats': {
                    'comment_stats': {}
                },
                'comment_priorities': {}
            }
            
            # 1. Get analysis data
            analysis_table = self.tables.get('Delphi_PCAResults')
            if analysis_table:
                response = analysis_table.get_item(Key={'zid': zid, 'math_tick': math_tick})
                if 'Item' in response:
                    analysis = response['Item']
                    result['participant_count'] = analysis.get('participant_count', 0)
                    result['comment_count'] = analysis.get('comment_count', 0)
                    
                    # Set PCA data
                    if 'pca' in analysis:
                        result['pca'] = {
                            'center': analysis['pca'].get('center', []),
                            'comps': analysis['pca'].get('components', [])
                        }
                    
                    # Set consensus
                    result['consensus'] = analysis.get('consensus_comments', [])
            
            # 2. Get groups data
            groups_table = self.tables.get('Delphi_KMeansClusters')
            if groups_table:
                response = groups_table.query(
                    KeyConditionExpression='zid_tick = :zid_tick',
                    ExpressionAttributeValues={':zid_tick': zid_tick}
                )
                
                if 'Items' in response:
                    for group in response['Items']:
                        result['group_clusters'].append({
                            'id': group.get('group_id', 0),
                            'center': group.get('center', []),
                            'members': group.get('members', [])
                        })
            
            # 3. Get comment data
            comments_table = self.tables.get('Delphi_CommentRouting')
            if comments_table:
                response = comments_table.query(
                    KeyConditionExpression='zid_tick = :zid_tick',
                    ExpressionAttributeValues={':zid_tick': zid_tick}
                )
                
                if 'Items' in response:
                    for comment in response['Items']:
                        comment_id = comment.get('comment_id', '')
                        result['vote_stats']['comment_stats'][comment_id] = comment.get('stats', {})
                        result['comment_priorities'][comment_id] = comment.get('priority', 0)
            
            # 4. Get representativeness data
            repness_table = self.tables.get('Delphi_RepresentativeComments')
            if repness_table:
                # Query for each group
                for group in result['group_clusters']:
                    group_id = group.get('id', 0)
                    zid_tick_gid = f"{zid}:{math_tick}:{group_id}"
                    
                    response = repness_table.query(
                        KeyConditionExpression='zid_tick_gid = :zid_tick_gid',
                        ExpressionAttributeValues={':zid_tick_gid': zid_tick_gid}
                    )
                    
                    if 'Items' in response:
                        for item in response['Items']:
                            result['repness']['comment_repness'].append({
                                'gid': group_id,
                                'tid': item.get('comment_id', ''),
                                'repness': item.get('repness', 0)
                            })
            
            # 5. Get projection data
            projections_table = self.tables.get('Delphi_PCAParticipantProjections')
            if projections_table:
                response = projections_table.query(
                    KeyConditionExpression='zid_tick = :zid_tick',
                    ExpressionAttributeValues={':zid_tick': zid_tick}
                )
                
                if 'Items' in response:
                    for projection in response['Items']:
                        participant_id = projection.get('participant_id', '')
                        coords = projection.get('coordinates', [0, 0])
                        result['proj'][participant_id] = coords
            
            return result
            
        except Exception as e:
            logger.error(f"Error reading math data: {e}")
            import traceback
            traceback.print_exc()
            return {}