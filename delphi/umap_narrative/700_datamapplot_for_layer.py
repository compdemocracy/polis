#!/usr/bin/env python3
"""
Generate DataMapPlot visualization for a specific layer of a conversation using data from PostgreSQL and DynamoDB.

This script:
1. Connects to both PostgreSQL (for comment data) and DynamoDB (for cluster data)
2. Retrieves UMAP coordinates and topic names for a specified conversation and layer
3. Generates an interactive visualization using DataMapPlot
"""

import os
import sys
import json
import logging
import argparse
import numpy as np
import pandas as pd
import datamapplot
from pathlib import Path
import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

# Import from local modules
from polismath_commentgraph.utils.storage import PostgresClient, DynamoDBStorage

def s3_upload_file(local_file_path: str, s3_key: str) -> str or bool:
    """
    Uploads a file to an S3-compatible object store, handling both local and
    AWS environments holistically.

    This function relies on Boto3's default credential provider chain.
    - In an AWS environment (like EC2 or ECS), it will automatically use the
      instance's IAM role.
    - For local development, it will use credentials from environment variables
      (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) or your ~/.aws/credentials file.

    Bucket Creation:
    - It checks if the target bucket exists.
    - If the bucket does not exist AND a custom endpoint_url is provided (indicating
      a local environment like MinIO), it will attempt to create the bucket.
    - It will NOT attempt to create a bucket in the default AWS environment,
      as this is a security risk and production buckets should be managed as
      infrastructure-as-code.

    Args:
        local_file_path (str): The local path to the file to upload.
        s3_key (str): The destination key (path) in the S3 bucket.

    Returns:
        str: The final URL of the uploaded object if successful.
        bool: False if the upload fails for any reason.
    """
    endpoint_url = os.environ.get('AWS_S3_ENDPOINT') or None
    bucket_name = os.environ.get('AWS_S3_BUCKET_NAME', 'polis-delphi')
    region = os.environ.get('AWS_REGION', 'us-east-1')

    logger.info("Initializing S3 client for upload...")
    logger.info(f"  Bucket: {bucket_name}, Region: {region}")
    logger.info(f"  Endpoint URL: {endpoint_url if endpoint_url else 'Default AWS S3'}")
    logger.info("  Credentials: Using Boto3's default provider chain (env, ~/.aws, IAM role).")

    try:
        s3_client = boto3.client(
            's3',
            region_name=region,
            endpoint_url=endpoint_url
        )

        # Check for Bucket and Create if Local ---
        try:
            s3_client.head_bucket(Bucket=bucket_name)
            logger.info(f"Bucket '{bucket_name}' already exists.")
        except ClientError as e:
            # If a 404 (Not Found) or 403 (Forbidden) on non-existent bucket occurs
            error_code = e.response.get("Error", {}).get("Code")
            if error_code in ['404', 'NoSuchBucket', '403']:
                logger.warning(f"Bucket '{bucket_name}' not found or not accessible (Error: {error_code}).")
                
                # CRITICAL: Only attempt to create the bucket in a local dev environment.
                if endpoint_url:
                    logger.info(f"Local endpoint detected. Attempting to create bucket '{bucket_name}'...")
                    s3_client.create_bucket(Bucket=bucket_name)
                    logger.info(f"Bucket '{bucket_name}' created successfully.")
                else:
                    # In production, the bucket must already exist. This is a configuration error.
                    logger.error("Bucket not found in AWS environment. Please create the S3 bucket via your infrastructure management tools (e.g., CDK, Terraform, CloudFormation).")
                    raise e
            else:
                logger.error(f"Unexpected error while checking for bucket: {e}")
                raise
        logger.info(f"Uploading '{local_file_path}' to s3://{bucket_name}/{s3_key}")
        
        extra_args = {}

        if local_file_path.endswith('.html'):
            extra_args['ContentType'] = 'text/html'
        elif local_file_path.endswith('.png'):
            extra_args['ContentType'] = 'image/png'
        elif local_file_path.endswith('.svg'):
            extra_args['ContentType'] = 'image/svg+xml'

        s3_client.upload_file(
            local_file_path,
            bucket_name,
            s3_key,
            ExtraArgs=extra_args
        )

        if endpoint_url:
            url = f"{endpoint_url.strip('/')}/{bucket_name}/{s3_key}"
        else:
            url = f"https://{bucket_name}.s3.amazonaws.com/{s3_key}"

        logger.info(f"File uploaded successfully. URL: {url}")
        return url

    except ClientError as e:
        # Catch Boto3-specific errors for more descriptive logging.
        if e.response.get("Error", {}).get("Code") == 'InvalidAccessKeyId':
            logger.error("FATAL: The AWS Access Key ID is invalid. Please check your environment variables (AWS_ACCESS_KEY_ID) or your ~/.aws/credentials file.")
        else:
            logger.error(f"An S3 client error occurred: {e}")
        return False
    except Exception as e:
        logger.error(f"An unexpected error occurred during the S3 upload process: {e}", exc_info=True)
        return False

# Configure logging with less verbosity
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(name)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Add a file handler to log to a file as well
def setup_file_logging(zid):
    """Set up file logging for a specific conversation."""
    try:
        # Create log directory if it doesn't exist
        log_dir = os.path.join("polis_data", str(zid), "logs")
        os.makedirs(log_dir, exist_ok=True)
        
        # Create a file handler
        log_file = os.path.join(log_dir, f"datamapplot_{zid}_{int(time.time())}.log")
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(logging.DEBUG)
        
        # Create a formatter and add it to the handler
        formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(name)s - %(message)s')
        file_handler.setFormatter(formatter)
        
        # Add the handler to the logger
        logger.addHandler(file_handler)
        logger.info(f"Logging to file: {log_file}")
    except Exception as e:
        logger.error(f"Failed to set up file logging: {e}")

# Function to log the Python environment
def log_environment_info():
    """Log information about the Python environment."""
    try:
        logger.info(f"Python version: {sys.version}")
        logger.info(f"Platform: {sys.platform}")
        logger.info(f"Current working directory: {os.getcwd()}")
        logger.info(f"Environment variables:")
        for key in ['PYTHONPATH', 'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 
                    'DATABASE_USER', 'DYNAMODB_ENDPOINT', 'AWS_DEFAULT_REGION']:
            logger.info(f"  {key}: {os.environ.get(key, 'Not set')}")
    except Exception as e:
        logger.error(f"Error logging environment info: {e}")

# Import these modules here to avoid circular imports
import sys
import time

def setup_environment(db_host=None, db_port=None, db_name=None, db_user=None, db_password=None):
    """Set up environment variables for database connections."""
    # PostgreSQL settings
    if db_host:
        os.environ['DATABASE_HOST'] = db_host
    elif not os.environ.get('DATABASE_HOST'):
        os.environ['DATABASE_HOST'] = 'localhost'
    
    if db_port:
        os.environ['DATABASE_PORT'] = str(db_port)
    elif not os.environ.get('DATABASE_PORT'):
        os.environ['DATABASE_PORT'] = '5432'
    
    if db_name:
        os.environ['DATABASE_NAME'] = db_name
    elif not os.environ.get('DATABASE_NAME'):
        os.environ['DATABASE_NAME'] = 'polisDB_prod_local_mar14'
    
    if db_user:
        os.environ['DATABASE_USER'] = db_user
    elif not os.environ.get('DATABASE_USER'):
        os.environ['DATABASE_USER'] = 'postgres'
    
    if db_password:
        os.environ['DATABASE_PASSWORD'] = db_password
    elif not os.environ.get('DATABASE_PASSWORD'):
        os.environ['DATABASE_PASSWORD'] = ''
    
    # Print database connection info
    logger.info(f"Database connection info:")
    logger.info(f"- HOST: {os.environ.get('DATABASE_HOST')}")
    logger.info(f"- PORT: {os.environ.get('DATABASE_PORT')}")
    logger.info(f"- DATABASE: {os.environ.get('DATABASE_NAME')}")
    logger.info(f"- USER: {os.environ.get('DATABASE_USER')}")
    
    # DynamoDB settings (for local DynamoDB)
    if not os.environ.get('DYNAMODB_ENDPOINT'):
            
        # Log the endpoint being used
        endpoint = os.environ.get('DYNAMODB_ENDPOINT')
        logger.info(f"Using DynamoDB endpoint: {endpoint}")
    if not os.environ.get('AWS_DEFAULT_REGION'):
        os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'
        
    # S3 settings
    if not os.environ.get('AWS_S3_BUCKET_NAME'):
        os.environ['AWS_S3_BUCKET_NAME'] = 'polis-delphi'
        
    logger.info(f"S3 Storage settings:")
    logger.info(f"- Endpoint: {os.environ.get('AWS_S3_ENDPOINT')}")
    logger.info(f"- Bucket: {os.environ.get('AWS_S3_BUCKET_NAME')}")
    logger.info(f"- Region: {os.environ.get('AWS_REGION')}")

def load_comment_texts(zid):
    """
    Load comment texts from PostgreSQL.
    
    Args:
        zid: Conversation ID
        
    Returns:
        Dictionary mapping comment_id to text
    """
    logger.info(f"Loading comments directly from PostgreSQL for conversation {zid}")
    postgres_client = PostgresClient()
    
    try:
        # Initialize connection
        postgres_client.initialize()
        
        # Get comments
        comments = postgres_client.get_comments_by_conversation(int(zid))
        
        if not comments:
            logger.error(f"No comments found in PostgreSQL for conversation {zid}")
            return None
            
        # Create a dictionary of comment_id to text
        comment_dict = {comment['tid']: comment['txt'] for comment in comments if comment.get('txt')}
        
        logger.info(f"Loaded {len(comment_dict)} comments from PostgreSQL")
        return comment_dict
        
    except Exception as e:
        logger.error(f"Error loading comments from PostgreSQL: {e}")
        return None
        
    finally:
        # Clean up connection
        postgres_client.shutdown()

def load_conversation_data_from_dynamo(zid, layer_id, dynamo_storage):
    """
    Load data from DynamoDB for a specific conversation and layer.
    
    Args:
        zid: Conversation ID
        layer_id: Layer ID
        dynamo_storage: DynamoDBStorage instance
        
    Returns:
        Dictionary with data from DynamoDB
    """
    logger.info(f"Loading data from DynamoDB for conversation {zid}, layer {layer_id}")
    
    # Initialize data dictionary
    data = {
        "comment_positions": {},
        "cluster_assignments": {},
        "topic_names": {}
    }
    
    # Try to get conversation metadata
    try:
        logger.debug(f"Getting conversation metadata for {zid}...")
        meta = dynamo_storage.get_conversation_meta(zid)
        if not meta:
            logger.error(f"No metadata found for conversation {zid}")
            return None
            
        logger.info(f"Conversation name: {meta.get('conversation_name', f'Conversation {zid}')}")
        logger.debug(f"Metadata: {meta}")
        data["meta"] = meta
    except Exception as e:
        logger.error(f"Error getting conversation metadata: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return None
    
    # Load comment embeddings to get comment IDs in order
    try:
        # Query CommentEmbeddings for this conversation
        logger.info(f"Loading comment embeddings to get full comment list...")
        table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['comment_embeddings'])
        logger.debug(f"CommentEmbeddings table name: {dynamo_storage.table_names['comment_embeddings']}")
        
        response = table.query(
            KeyConditionExpression=Key('conversation_id').eq(str(zid))
        )
        embeddings = response.get('Items', [])
        
        # Handle pagination if needed
        while 'LastEvaluatedKey' in response:
            logger.debug(f"Handling pagination for comment embeddings...")
            response = table.query(
                KeyConditionExpression=Key('conversation_id').eq(str(zid)),
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            embeddings.extend(response.get('Items', []))
        
        # Extract comment IDs in order
        comment_ids = [int(item['comment_id']) for item in embeddings]
        data["comment_ids"] = comment_ids
        logger.info(f"Loaded {len(comment_ids)} comment IDs from embeddings")
        logger.debug(f"Sample comment IDs: {comment_ids[:5] if comment_ids else []}")
    except Exception as e:
        logger.error(f"Error retrieving comment embeddings: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        
    # Get comment clusters
    try:
        # Query CommentClusters for this conversation
        logger.info(f"Loading cluster assignments from CommentClusters...")
        table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['comment_clusters'])
        logger.debug(f"CommentClusters table name: {dynamo_storage.table_names['comment_clusters']}")
        
        response = table.query(
            KeyConditionExpression=Key('conversation_id').eq(str(zid))
        )
        clusters = response.get('Items', [])
        
        # Handle pagination if needed
        while 'LastEvaluatedKey' in response:
            logger.debug(f"Handling pagination for comment clusters...")
            response = table.query(
                KeyConditionExpression=Key('conversation_id').eq(str(zid)),
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            clusters.extend(response.get('Items', []))
        
        logger.info(f"Retrieved {len(clusters)} comment cluster assignments")
        
        # Log sample item for debugging
        if clusters:
            logger.debug(f"Sample CommentClusters item: {clusters[0]}")
        
        # Check if any items have position data
        position_items = [item for item in clusters if 'position' in item and isinstance(item['position'], dict)]
        logger.debug(f"Number of items with position field: {len(position_items)}")
        
        # Extract positions and cluster assignments for the specified layer
        position_column = f"position"
        cluster_column = f"layer{layer_id}_cluster_id"
        
        logger.debug(f"Looking for position column '{position_column}' and cluster column '{cluster_column}'")
        positions_found = 0
        clusters_found = 0
        
        for item in clusters:
            comment_id = int(item.get('comment_id'))
            if comment_id is None:
                continue
                
            # Extract position
            if position_column in item and isinstance(item[position_column], dict):
                pos = item[position_column]
                if 'x' in pos and 'y' in pos:
                    data["comment_positions"][comment_id] = [float(pos['x']), float(pos['y'])]
                    positions_found += 1
                    if positions_found <= 3:  # Log first few positions
                        logger.debug(f"Found position for comment {comment_id} in CommentClusters: {pos}")
            
            # Extract cluster assignment for this layer
            if cluster_column in item and item[cluster_column] is not None:
                data["cluster_assignments"][comment_id] = int(item[cluster_column])
                clusters_found += 1
            else:
                # Assign -1 for unclustered points when no assignment exists
                data["cluster_assignments"][comment_id] = -1
                logger.debug(f"Comment {comment_id} has no cluster assignment for layer {layer_id}, marking as unclustered.")
        
        logger.info(f"Extracted {positions_found} positions and {clusters_found} cluster assignments")
        
        # If positions were not found, try to get them from UMAP graph
        if len(data["comment_positions"]) == 0:
            logger.info("No positions found in CommentClusters, fetching from UMAPGraph...")
            
            # Try to get positions from the UMAPGraph table
            try:
                # Get all edges from UMAPGraph for this conversation
                umap_table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['umap_graph'])
                logger.debug(f"UMAPGraph table name: {dynamo_storage.table_names['umap_graph']}")
                
                response = umap_table.query(
                    KeyConditionExpression=Key('conversation_id').eq(str(zid))
                )
                edges = response.get('Items', [])
                
                # Handle pagination if needed
                while 'LastEvaluatedKey' in response:
                    logger.debug(f"Handling pagination for UMAP graph...")
                    response = umap_table.query(
                        KeyConditionExpression=Key('conversation_id').eq(str(zid)),
                        ExclusiveStartKey=response['LastEvaluatedKey']
                    )
                    edges.extend(response.get('Items', []))
                
                logger.info(f"Retrieved {len(edges)} edges from UMAPGraph")
                
                # Check how many edges have position data
                edges_with_position = [e for e in edges if 'position' in e and isinstance(e['position'], dict)]
                logger.debug(f"Number of edges with position field: {len(edges_with_position)}")
                
                # Check how many are self-referencing edges
                self_ref_edges = [e for e in edges if 'source_id' in e and 'target_id' in e and str(e['source_id']) == str(e['target_id'])]
                logger.debug(f"Number of self-referencing edges: {len(self_ref_edges)}")
                
                # Check how many self-referencing edges have position data
                self_ref_with_pos = [e for e in self_ref_edges if 'position' in e and isinstance(e['position'], dict)]
                logger.debug(f"Number of self-referencing edges with position: {len(self_ref_with_pos)}")
                
                # Extract positions from edges - only self-referring edges have position data
                positions = {}
                position_count = 0
                
                for edge in edges:
                    # Check if this edge has position information
                    if 'position' in edge and isinstance(edge['position'], dict) and 'x' in edge['position'] and 'y' in edge['position']:
                        pos = edge['position']
                        
                        # Check if this is a self-referencing edge
                        is_self_ref = False
                        if 'source_id' in edge and 'target_id' in edge:
                            is_self_ref = str(edge['source_id']) == str(edge['target_id'])
                        
                        # Only self-referencing edges contain the position data
                        if is_self_ref:
                            comment_id = int(edge['source_id'])
                            positions[comment_id] = [float(pos['x']), float(pos['y'])]
                            position_count += 1
                            
                            # Don't log individual positions as they're too verbose
                            pass
                
                logger.debug(f"Extracted {position_count} positions from self-referencing edges")
                
                # Map positions to comment IDs
                for comment_id in data["cluster_assignments"].keys():
                    if comment_id in positions:
                        data["comment_positions"][comment_id] = positions[comment_id]
                
                logger.info(f"Extracted {len(data['comment_positions'])} positions from UMAPGraph")
                
                # If we still don't have all positions, check if we can use the comment embeddings
                if len(data['comment_positions']) < len(data['cluster_assignments']):
                    logger.info(f"Still missing positions for {len(data['cluster_assignments']) - len(data['comment_positions'])} comments")
                    
                    # Log some IDs that are missing positions
                    missing_ids = [cid for cid in data['cluster_assignments'].keys() if cid not in data['comment_positions']]
                    logger.debug(f"Sample missing comment IDs: {missing_ids[:5] if missing_ids else []}")
            except Exception as e:
                logger.error(f"Error retrieving positions from UMAPGraph: {e}")
                import traceback
                logger.error(f"Traceback: {traceback.format_exc()}")
    except Exception as e:
        logger.error(f"Error retrieving comment clusters: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
    
    # Get topic names from LLMTopicNames
    try:
        # Query LLMTopicNames for this conversation and layer
        logger.info(f"Loading topic names from LLMTopicNames...")
        table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['llm_topic_names'])
        logger.debug(f"LLMTopicNames table name: {dynamo_storage.table_names['llm_topic_names']}")
        
        response = table.query(
            KeyConditionExpression=Key('conversation_id').eq(str(zid))
        )
        topic_names = response.get('Items', [])
        
        # Handle pagination if needed
        while 'LastEvaluatedKey' in response:
            logger.debug(f"Handling pagination for topic names...")
            response = table.query(
                KeyConditionExpression=Key('conversation_id').eq(str(zid)),
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            topic_names.extend(response.get('Items', []))
        
        # Log sample item for debugging
        if topic_names:
            logger.debug(f"Sample LLMTopicNames item: {topic_names[0]}")
            
        # Filter to this layer and extract topic names
        topic_count = 0
        for item in topic_names:
            if str(item.get('layer_id')) == str(layer_id):
                cluster_id = item.get('cluster_id')
                if cluster_id is not None:
                    topic_name = item.get('topic_name', f"Topic {cluster_id}")
                    data["topic_names"][int(cluster_id)] = topic_name
                    topic_count += 1
                    
                    if topic_count <= 3:  # Log first few topic names
                        logger.debug(f"Found topic name for cluster {cluster_id}: {topic_name}")
        
        logger.info(f"Retrieved {len(data['topic_names'])} topic names for layer {layer_id}")
    except Exception as e:
        logger.error(f"Error retrieving topic names: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
    
    # Final sanity checks
    if not data["comment_positions"]:
        logger.error("No comment positions found in any table. Visualization will fail.")
    
    return data

def create_visualization(zid, layer_id, data, comment_texts, output_dir=None):
    """
    Create and save a visualization for a specific layer.
    
    Args:
        zid: Conversation ID
        layer_id: Layer ID
        data: Dictionary with data from DynamoDB
        comment_texts: Dictionary mapping comment_id to text
        output_dir: Optional directory to save the visualization
        
    Returns:
        Path to the saved visualization
    """
    # Re-import datamapplot here to ensure it's available in this function scope
    import datamapplot
    logger.info(f"Starting visualization creation for conversation {zid}, layer {layer_id}")
    
    try:
        # Setup output directory if specified
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
            logger.debug(f"Using provided output directory: {output_dir}")
        else:
            output_dir = os.path.join("polis_data", str(zid), "python_output")
            os.makedirs(output_dir, exist_ok=True)
            logger.debug(f"Created default output directory: {output_dir}")
        
        # Get conversation name
        conversation_name = data.get("meta", {}).get("conversation_name", f"Conversation {zid}")
        logger.debug(f"Using conversation name: {conversation_name}")
        
        # Prepare data for visualization
        positions = data.get("comment_positions", {})
        cluster_assignments = data.get("cluster_assignments", {})
        topic_names = data.get("topic_names", {})
        
        # Log what we have for visualization
        logger.debug(f"Data for visualization:")
        logger.debug(f"- Positions: {len(positions)} items")
        logger.debug(f"- Cluster assignments: {len(cluster_assignments)} items")
        logger.debug(f"- Topic names: {len(topic_names)} items")
        
        # Check if we have positions
        if not positions:
            logger.error("No position data found for comments")
            return None
        
        # Create arrays for 2D coordinates and labels
        comment_ids = sorted(positions.keys())
        logger.debug(f"Number of comments with positions: {len(comment_ids)}")
        
        if len(comment_ids) == 0:
            logger.error("No comments with positions found")
            return None
        
        # Log a sample of the comment IDs and their positions
        if comment_ids:
            logger.debug(f"Sample comment IDs: {comment_ids[:5]}")
            for cid in comment_ids[:3]:
                logger.debug(f"Comment {cid} position: {positions[cid]}")
        
        # Create document_map array
        logger.debug(f"Creating document_map array for {len(comment_ids)} comments")
        
        # Initialize an empty array 
        document_map_list = []
        for cid in comment_ids:
            pos = positions.get(cid)
            if pos is not None:
                document_map_list.append(pos)
            else:
                logger.warning(f"Missing position for comment ID {cid} - this should not happen")
                
        # Convert to numpy array
        document_map = np.array(document_map_list)
        logger.info(f"Created document_map with shape {document_map.shape}")
        
        # Create cluster assignments array
        logger.debug(f"Creating cluster assignments array")
        cluster_labels_list = []
        for cid in comment_ids:
            cluster_labels_list.append(cluster_assignments.get(cid, -1))
            
        cluster_labels = np.array(cluster_labels_list)
        
        # Debug: Check if all comments are unclustered in this layer
        unique_clusters = np.unique(cluster_labels)
        logger.info(f"Unique cluster labels in this layer: {unique_clusters}")
        
        # Check if we have valid clusters (not just -1 which is unclustered)
        if len(unique_clusters) == 1 and unique_clusters[0] == -1:
            logger.warning(f"All comments are unclustered in layer {layer_id}, will continue with visualization anyway")
        
        # Create hover text array with comment ID and text
        logger.debug(f"Creating hover text array")
        hover_text = []
        missing_texts = 0
        for cid in comment_ids:
            text = comment_texts.get(cid, "")
            if not text:
                missing_texts += 1
            hover_text.append(f"Comment {cid}: {text}")
        
        if missing_texts > 0:
            logger.warning(f"Missing text for {missing_texts} comments")
        
        # Create label strings using the topic names and clean up formatting (remove asterisks)
        logger.debug(f"Creating label strings array")
        def clean_topic_name(name):
            # Remove asterisks from topic names (e.g., "**Topic Name**" becomes "Topic Name")
            if isinstance(name, str):
                return name.replace('*', '')
            return name
        
        label_strings_list = []
        for label in cluster_labels:
            if label >= 0:
                label_strings_list.append(clean_topic_name(topic_names.get(label, f"Topic {label}")))
            else:
                label_strings_list.append("Unclustered")
                
        label_strings = np.array(label_strings_list)
        
        # Create visualization
        logger.info(f"Creating visualization for conversation {zid}, layer {layer_id}...")
        viz_file = os.path.join(output_dir, f"{zid}_layer_{layer_id}_datamapplot.html")
        
        try:
            # Debug info before visualization
            logger.info(f"Document map shape: {document_map.shape}")
            logger.info(f"Label strings shape: {label_strings.shape}")
            logger.info(f"Hover text length: {len(hover_text)}")
            logger.info(f"Number of unique labels: {len(np.unique(label_strings))}")
            logger.info(f"Sample labels: {np.unique(label_strings)[:5]}")
            
            # For large number of clusters (like layer 0), use cvd_safer=True to avoid the interp error
            num_unique_labels = len(np.unique(label_strings))
            
            # Generate interactive visualization with safer coloring for layers with many clusters
            # Set specific color for unclustered comments (cluster -1) as darker grey
            noise_color = "#aaaaaa"  # Darker grey color for unclustered comments
            
            # Create a dictionary to sort points by cluster - unclustered (-1) should be LAST in the array
            # so they appear at the bottom layer in the visualization
            logger.debug(f"Sorting points by cluster")
            sorted_indices = np.argsort([0 if x == -1 else 1 for x in cluster_labels])
            document_map = document_map[sorted_indices]
            label_strings = label_strings[sorted_indices]
            hover_text = [hover_text[i] for i in sorted_indices]
            
            logger.debug(f"Creating visualization with datamapplot")
            logger.debug(f"- Document map shape: {document_map.shape}")
            logger.debug(f"- Label strings shape: {label_strings.shape}")
            logger.debug(f"- Hover text length: {len(hover_text)}")
            
            # Verify the input arrays are not empty
            if document_map.size == 0:
                logger.error("Document map is empty! Cannot create visualization.")
                return None
                
            if len(label_strings) == 0:
                logger.error("Label strings array is empty! Cannot create visualization.")
                return None
                
            if len(hover_text) == 0:
                logger.error("Hover text array is empty! Cannot create visualization.")
                return None
                
            # Verify the input arrays have matching dimensions
            if document_map.shape[0] != len(label_strings):
                logger.error(f"Document map shape {document_map.shape} doesn't match label strings length {len(label_strings)}!")
                return None
                
            if document_map.shape[0] != len(hover_text):
                logger.error(f"Document map shape {document_map.shape} doesn't match hover text length {len(hover_text)}!")
                return None
            
            logger.debug(f"Creating interactive plot...")
            interactive_figure = datamapplot.create_interactive_plot(
                document_map,
                label_strings,
                hover_text=hover_text,
                title="",
                sub_title="",
                point_radius_min_pixels=2,
                point_radius_max_pixels=10,
                width="100%",
                height=800,
                noise_label="Unclustered",  # The label for uncategorized comments
                noise_color=noise_color,    # Darker grey color for uncategorized
                cvd_safer=True if num_unique_labels > 50 else False  # Use CVD-safer coloring for layers with many clusters
            )
            
            # Save the visualization locally
            logger.debug(f"Saving visualization to {viz_file}")
            interactive_figure.save(viz_file)
            logger.info(f"Saved visualization to {viz_file}")
            
            # Upload to S3
            try:
                # Get job ID and report ID from environment variables
                job_id = os.environ.get('DELPHI_JOB_ID', 'unknown')
                report_id = os.environ.get('DELPHI_REPORT_ID', 'unknown')
                
                # Create S3 key using report_id and job ID to avoid exposing ZIDs
                s3_key = f"visualizations/{report_id}/{job_id}/layer_{layer_id}_datamapplot.html"
                s3_url = s3_upload_file(viz_file, s3_key)
                
                if s3_url:
                    logger.info(f"Visualization uploaded to S3: {s3_url}")
                    # Save S3 URL to file for reference
                    url_file = os.path.join(os.path.dirname(viz_file), f"{zid}_layer_{layer_id}_s3_url.txt")
                    with open(url_file, 'w') as f:
                        f.write(s3_url)
                    logger.info(f"S3 URL saved to {url_file}")
                else:
                    logger.warning("Failed to upload visualization to S3")
            except Exception as s3_error:
                logger.error(f"Error uploading to S3: {s3_error}")
                import traceback
                logger.error(f"S3 upload traceback: {traceback.format_exc()}")
            
            return viz_file
        except Exception as e:
            logger.error(f"Error creating visualization: {e}")
            # Print full traceback for debugging
            import traceback
            logger.error(f"Full traceback: {traceback.format_exc()}")
            
            # Try to capture the datamapplot version
            try:
                import datamapplot
                logger.info(f"Datamapplot version: {datamapplot.__version__ if hasattr(datamapplot, '__version__') else 'unknown'}")
            except:
                pass
                
            return None
    except Exception as outer_e:
        logger.error(f"Outer error in create_visualization: {outer_e}")
        import traceback
        logger.error(f"Outer traceback: {traceback.format_exc()}")
        return None

def generate_visualization(zid, layer_id=0, output_dir=None, dynamo_endpoint=None):
    """
    Generate visualization for a specific conversation and layer.
    
    Args:
        zid: Conversation ID
        layer_id: Optional Layer ID (default: 0)
        output_dir: Optional directory to save the visualization
        dynamo_endpoint: Optional DynamoDB endpoint URL
        
    Returns:
        Path to the saved visualization
    """
    try:
        # Set up file logging first
        setup_file_logging(zid)
        
        # Log environment information
        logger.info(f"Starting visualization generation for conversation {zid}, layer {layer_id}")
        log_environment_info()
        
        # Setup environment
        setup_environment()
        logger.debug("Environment setup complete")
        
        # Set DynamoDB endpoint if provided
        if dynamo_endpoint:
            logger.info(f"Using provided DynamoDB endpoint: {dynamo_endpoint}")
            os.environ['DYNAMODB_ENDPOINT'] = dynamo_endpoint
        
        logger.info(f"DynamoDB endpoint: {os.environ.get('DYNAMODB_ENDPOINT')}")

        region = os.environ.get('AWS_REGION')
        
        # Initialize DynamoDB storage
        dynamo_storage = DynamoDBStorage(
            endpoint_url=os.environ.get('DYNAMODB_ENDPOINT'),
            region_name=region
        )
        logger.debug("DynamoDB storage initialized")
        
        # Log DynamoDB table names
        logger.debug(f"DynamoDB table names: {dynamo_storage.table_names}")
        
        # Load comment texts from PostgreSQL
        logger.info("Loading comment texts from PostgreSQL...")
        comment_texts = load_comment_texts(zid)
        if not comment_texts:
            logger.error("Failed to load comment texts")
            return None
        logger.info(f"Successfully loaded {len(comment_texts)} comment texts")
        
        # Load data from DynamoDB
        logger.info(f"Loading data from DynamoDB for conversation {zid}, layer {layer_id}...")
        data = load_conversation_data_from_dynamo(zid, layer_id, dynamo_storage)
        if not data:
            logger.error("Failed to load data from DynamoDB")
            return None
        
        # Log the data we retrieved
        logger.info(f"Data summary:")
        logger.info(f"- Comment IDs: {len(data.get('comment_ids', []))}")
        logger.info(f"- Comment positions: {len(data.get('comment_positions', {}))}")
        logger.info(f"- Cluster assignments: {len(data.get('cluster_assignments', {}))}")
        logger.info(f"- Topic names: {len(data.get('topic_names', {}))}")
        
        # Log more detailed information about positions for debugging
        positions = data.get('comment_positions', {})
        if positions:
            # Log a few sample positions
            sample_ids = list(positions.keys())[:5]
            logger.debug(f"Sample positions: {[(cid, positions[cid]) for cid in sample_ids]}")
            
            # Check and log position statistics
            x_values = [pos[0] for pos in positions.values()]
            y_values = [pos[1] for pos in positions.values()]
            if x_values and y_values:
                logger.debug(f"Position X range: {min(x_values)} to {max(x_values)}")
                logger.debug(f"Position Y range: {min(y_values)} to {max(y_values)}")
        else:
            logger.error("No positions found in the data")
        
        # Create and save visualization
        logger.info("Creating visualization...")
        viz_file = create_visualization(zid, layer_id, data, comment_texts, output_dir)
        
        if viz_file:
            logger.info(f"Successfully generated visualization for conversation {zid}, layer {layer_id}")
            logger.info(f"Visualization saved to: {viz_file}")
            return viz_file
        else:
            logger.error(f"Failed to generate visualization for conversation {zid}, layer {layer_id}")
            return None
            
    except Exception as e:
        logger.error(f"Unexpected error in generate_visualization: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return None

def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Generate DataMapPlot visualization for a layer of a conversation')
    parser.add_argument('--conversation_id', '--zid', type=str, required=True,
                      help='Conversation ID to process')
    parser.add_argument('--layer', type=int, default=0,
                      help='Layer ID to visualize (default: 0)')
    parser.add_argument('--output_dir', type=str, default=None,
                      help='Directory to save the visualization')
    parser.add_argument('--dynamo_endpoint', type=str, default=None,
                      help='DynamoDB endpoint URL')
    
    args = parser.parse_args()
    
    logger.info(f"Generating visualization for conversation {args.conversation_id}, layer {args.layer}")
    
    viz_file = generate_visualization(
        args.conversation_id,
        layer_id=args.layer,
        output_dir=args.output_dir,
        dynamo_endpoint=args.dynamo_endpoint
    )
    
    if viz_file:
        print(f"Visualization saved to: {viz_file}")
        print(f"View in browser: file://{viz_file}")
        return 0
    else:
        print("Failed to generate visualization")
        return 1

if __name__ == "__main__":
    sys.exit(main())