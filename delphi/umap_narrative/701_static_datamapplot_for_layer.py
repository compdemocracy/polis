#!/usr/bin/env python3
"""
Generate static DataMapPlot visualizations for a specific layer of a conversation.

This script:
1. Reuses data loading logic from 700_datamapplot_for_layer.py
2. Uses datamapplot's static visualization capabilities
3. Generates high-quality static images with labels over points
"""

import os
import argparse
import pandas as pd
import numpy as np
import json
import boto3
from boto3.dynamodb.conditions import Key
import logging
import sys
import traceback
import time
import datamapplot

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Import directly from the existing codebase
app_path = os.environ.get('DELPHI_APP_PATH', '/app')
sys.path.insert(0, app_path)
try:
    from polismath_commentgraph.utils.storage import DynamoDBStorage, PostgresClient
except ImportError:
    logger.warning("Could not import from polismath_commentgraph - running in standalone mode")
    
    # Simplified DynamoDBStorage class if we can't import the original
    class DynamoDBStorage:
        def __init__(self, endpoint_url=None):
            self.endpoint_url = endpoint_url or os.environ.get("DYNAMODB_ENDPOINT", "http://dynamodb-local:8000")
            self.region = os.environ.get("AWS_REGION", "us-east-1")
            self.dynamodb = boto3.resource('dynamodb', endpoint_url=self.endpoint_url, region_name=self.region)
            
            # Define table names using the new Delphi_ naming scheme
            self.table_names = {
                'comment_embeddings': 'Delphi_CommentEmbeddings',
                'comment_clusters': 'Delphi_CommentHierarchicalClusterAssignments',
                'llm_topic_names': 'Delphi_CommentClustersLLMTopicNames',
                'umap_graph': 'Delphi_UMAPGraph'
            }

def load_data_from_dynamo(zid, layer_id):
    """
    Load data from DynamoDB for visualization, using same approach as 700_datamapplot_for_layer.py
    
    Returns: dictionary with comment positions, cluster assignments, and topic names
    """
    logger.info(f"Loading data from DynamoDB for conversation {zid}, layer {layer_id}")
    
    # Initialize DynamoDB storage
    dynamo_storage = DynamoDBStorage(
        endpoint_url=os.environ.get('DYNAMODB_ENDPOINT', 'http://dynamodb-local:8000'),
    )
    
    # Initialize data dictionary
    data = {
        "comment_positions": {},
        "cluster_assignments": {},
        "topic_names": {}
    }
    
    # Get comment clusters
    try:
        # Query CommentClusters for this conversation
        logger.info(f"Loading cluster assignments from CommentClusters...")
        table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['comment_clusters'])
        logger.info(f"CommentClusters table name: {dynamo_storage.table_names['comment_clusters']}")
        
        response = table.query(
            KeyConditionExpression=Key('conversation_id').eq(str(zid))
        )
        clusters = response.get('Items', [])
        
        # Handle pagination if needed
        while 'LastEvaluatedKey' in response:
            response = table.query(
                KeyConditionExpression=Key('conversation_id').eq(str(zid)),
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            clusters.extend(response.get('Items', []))
        
        logger.info(f"Retrieved {len(clusters)} comment cluster assignments")
        
        # Check if any items have position data
        position_items = [item for item in clusters if 'position' in item and isinstance(item['position'], dict)]
        logger.info(f"Number of items with position field: {len(position_items)}")
        
        # Extract positions and cluster assignments for the specified layer
        position_column = f"position"
        cluster_column = f"layer{layer_id}_cluster_id"
        
        logger.info(f"Looking for position column '{position_column}' and cluster column '{cluster_column}'")
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
                        logger.info(f"Found position for comment {comment_id}: {pos}")
            
            # Extract cluster assignment for this layer
            if cluster_column in item:
                data["cluster_assignments"][comment_id] = int(item[cluster_column])
                clusters_found += 1
        
        logger.info(f"Extracted {positions_found} positions and {clusters_found} cluster assignments")
        
        # If positions were not found, try to get them from UMAP graph
        if len(data["comment_positions"]) == 0:
            logger.info("No positions found in CommentClusters, fetching from UMAPGraph...")
            
            # Try to get positions from the UMAPGraph table
            try:
                # Get all edges from UMAPGraph for this conversation
                umap_table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['umap_graph'])
                logger.info(f"UMAPGraph table name: {dynamo_storage.table_names['umap_graph']}")
                
                response = umap_table.query(
                    KeyConditionExpression=Key('conversation_id').eq(str(zid))
                )
                edges = response.get('Items', [])
                
                # Handle pagination if needed
                while 'LastEvaluatedKey' in response:
                    response = umap_table.query(
                        KeyConditionExpression=Key('conversation_id').eq(str(zid)),
                        ExclusiveStartKey=response['LastEvaluatedKey']
                    )
                    edges.extend(response.get('Items', []))
                
                logger.info(f"Retrieved {len(edges)} edges from UMAPGraph")
                
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
                
                logger.info(f"Extracted {position_count} positions from self-referencing edges")
                
                # Map positions to comment IDs
                for comment_id in data["cluster_assignments"].keys():
                    if comment_id in positions:
                        data["comment_positions"][comment_id] = positions[comment_id]
                
                logger.info(f"Extracted {len(data['comment_positions'])} positions from UMAPGraph")
            except Exception as e:
                logger.error(f"Error retrieving positions from UMAPGraph: {e}")
                logger.error(traceback.format_exc())
    except Exception as e:
        logger.error(f"Error retrieving comment clusters: {e}")
        logger.error(traceback.format_exc())
    
    # Get topic names from LLMTopicNames
    try:
        # Query LLMTopicNames for this conversation and layer
        logger.info(f"Loading topic names from LLMTopicNames...")
        table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['llm_topic_names'])
        logger.info(f"LLMTopicNames table name: {dynamo_storage.table_names['llm_topic_names']}")
        
        response = table.query(
            KeyConditionExpression=Key('conversation_id').eq(str(zid))
        )
        topic_names = response.get('Items', [])
        
        # Handle pagination if needed
        while 'LastEvaluatedKey' in response:
            response = table.query(
                KeyConditionExpression=Key('conversation_id').eq(str(zid)),
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            topic_names.extend(response.get('Items', []))
            
        # Filter to this layer and extract topic names
        topic_count = 0
        for item in topic_names:
            if str(item.get('layer_id')) == str(layer_id):
                cluster_id = item.get('cluster_id')
                if cluster_id is not None:
                    topic_name = item.get('topic_name', f"Topic {cluster_id}")
                    data["topic_names"][int(cluster_id)] = topic_name
                    topic_count += 1
        
        logger.info(f"Retrieved {len(data['topic_names'])} topic names for layer {layer_id}")
    except Exception as e:
        logger.error(f"Error retrieving topic names: {e}")
        logger.error(traceback.format_exc())
    
    return data

def load_comment_texts(zid):
    """
    Load comment texts from PostgreSQL.
    
    Args:
        zid: Conversation ID
        
    Returns:
        Dictionary mapping comment_id to text
    """
    logger.info(f"Loading comments from PostgreSQL for conversation {zid}")
    try:
        postgres_client = PostgresClient()
        
        # Initialize connection
        postgres_client.initialize()
        
        # Get comments
        comments = postgres_client.get_comments_by_conversation(int(zid))
        
        if not comments:
            logger.warning(f"No comments found in PostgreSQL for conversation {zid}")
            return {}
            
        # Create a dictionary of comment_id to text
        comment_dict = {comment['tid']: comment['txt'] for comment in comments if comment.get('txt')}
        
        logger.info(f"Loaded {len(comment_dict)} comments from PostgreSQL")
        return comment_dict
    except Exception as e:
        logger.warning(f"Error loading comments from PostgreSQL: {e}")
        return {}
    finally:
        # Clean up connection
        try:
            postgres_client.shutdown()
        except:
            pass

# Add S3 upload function
def s3_upload_file(local_file_path, s3_key):
    """
    Upload a file to S3
    
    Args:
        local_file_path: Path to the local file to upload
        s3_key: S3 key (path) where the file should be stored
        
    Returns:
        str: URL of the uploaded file if successful, False otherwise
    """
    # Get S3 settings from environment
    endpoint_url = os.environ.get('AWS_S3_ENDPOINT')
    access_key = os.environ.get('AWS_ACCESS_KEY_ID')
    secret_key = os.environ.get('AWS_SECRET_ACCESS_KEY')
    bucket_name = os.environ.get('AWS_S3_BUCKET_NAME')
    region = os.environ.get('AWS_REGION')

    if endpoint_url == "":
        endpoint_url = None

    if access_key == "":
        access_key = None

    if secret_key == "":
        secret_key = None
    
    try:
        # Create S3 client
        s3_client = boto3.client(
            's3',
            # endpoint_url=endpoint_url,
            # aws_access_key_id=access_key,
            # aws_secret_access_key=secret_key,
            region_name=region,
            # For MinIO/local development, these settings help
            # config=boto3.session.Config(signature_version='s3v4'),
            # verify=False
        )
        
        # Check if bucket exists, create if it doesn't
        try:
            s3_client.head_bucket(Bucket=bucket_name)
            logger.info(f"Bucket {bucket_name} exists")
        except Exception as e:
            logger.info(f"Bucket {bucket_name} doesn't exist or not accessible, creating... Error: {e}")
            
            try:
                # Create the bucket - for MinIO local we don't need LocationConstraint
                if endpoint_url:
                    if region == 'us-east-1' or 'localhost' in endpoint_url or 'minio' in endpoint_url:
                        s3_client.create_bucket(Bucket=bucket_name)
                else:
                    s3_client.create_bucket(
                        Bucket=bucket_name,
                        # CreateBucketConfiguration={'LocationConstraint': region} - not in us-east-1 - but in other regions
                    )
                
                # Apply bucket policy to make objects public-read
                bucket_policy = {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Sid": "PublicReadGetObject",
                            "Effect": "Allow",
                            "Principal": "*",
                            "Action": ["s3:GetObject"],
                            "Resource": [f"arn:aws:s3:::{bucket_name}/*"]
                        }
                    ]
                }
                
                # Set the bucket policy
                try:
                    s3_client.put_bucket_policy(
                        Bucket=bucket_name,
                        Policy=json.dumps(bucket_policy)
                    )
                    logger.info(f"Set public-read bucket policy for {bucket_name}")
                except Exception as policy_error:
                    logger.warning(f"Could not set bucket policy: {policy_error}")
                    # Continue anyway
            except Exception as create_error:
                logger.error(f"Failed to create bucket: {create_error}")
                raise
        
        # Upload file
        logger.info(f"Uploading {local_file_path} to s3://{bucket_name}/{s3_key}")
        
        # For HTML files, set content type correctly
        extra_args = {
        #     'ACL': 'public-read'  # Make object publicly readable - probably don't want this
        }
        
        # Set the correct content type based on file extension
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
                # Generate a URL for the uploaded file
                if endpoint_url.startswith('http://localhost') or endpoint_url.startswith('http://127.0.0.1'):
                    # For local development with MinIO
                    url = f"{endpoint_url}/{bucket_name}/{s3_key}"
                    # Clean up URL if needed
                    url = url.replace('///', '//')
                elif 'minio' in endpoint_url:
                    # For Docker container access to MinIO
                    url = f"{endpoint_url}/{bucket_name}/{s3_key}"
                    url = url.replace('///', '//')
                else:
                    # For AWS S3
                    if endpoint_url.startswith('https://s3.'):
                        # Standard AWS S3 endpoint
                        url = f"https://{bucket_name}.s3.amazonaws.com/{s3_key}"
                    else:
                        # Custom S3 endpoint
                        url = f"{endpoint_url}/{bucket_name}/{s3_key}"
        else:
            # Custom S3 endpoint
            url = f"{bucket_name}/{s3_key}"
        
        logger.info(f"File uploaded successfully to {url}")
        return url
        
    except Exception as e:
        logger.error(f"Error uploading file to S3: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def generate_static_datamapplot(zid, layer_num=0, output_dir=None):
    """Generate static datamapplot visualizations using datamapplot library"""
    logger.info(f"Generating static datamapplot for conversation {zid}, layer {layer_num}")
    
    try:
        # Load data from DynamoDB
        data = load_data_from_dynamo(zid, layer_num)
        
        # Check if we have valid data
        if not data["comment_positions"]:
            logger.error("No comment positions found. Cannot create visualization.")
            return False
        
        # Load comment texts for hover information
        comment_texts = load_comment_texts(zid)
        
        # Setup output directories
        app_path = os.environ.get('DELPHI_APP_PATH', '/app')
        container_dir = f"{app_path}/visualizations/{zid}"
        host_dir = f"/visualizations/{zid}"
        local_dir = f"/Users/colinmegill/polis/delphi/visualizations/{zid}"
        
        # Ensure directories exist
        os.makedirs(container_dir, exist_ok=True)
        if os.path.exists("/visualizations"):
            os.makedirs(host_dir, exist_ok=True)
        if not os.environ.get('AWS_S3_BUCKET_NAME'):
            os.environ['AWS_S3_BUCKET_NAME'] = 'polis-delphi'
        if not os.environ.get('AWS_REGION'):
            os.environ['AWS_REGION'] = 'us-east-1'
        
        # Prepare data for datamapplot
        positions = data["comment_positions"]
        clusters = data["cluster_assignments"] 
        topic_names = data["topic_names"]
        
        # Create arrays for datamapplot
        comment_ids = sorted(positions.keys())
        logger.info(f"Number of comments with positions: {len(comment_ids)}")
        
        # Create document_map array
        document_map_list = []
        for cid in comment_ids:
            pos = positions.get(cid)
            if pos is not None:
                document_map_list.append(pos)
            else:
                logger.warning(f"Missing position for comment ID {cid}")
                
        # Convert to numpy array
        document_map = np.array(document_map_list)
        logger.info(f"Created document_map with shape {document_map.shape}")
        
        # Create cluster assignments array
        cluster_labels_list = []
        for cid in comment_ids:
            cluster_labels_list.append(clusters.get(cid, -1))
            
        cluster_labels = np.array(cluster_labels_list)
        
        # Create hover text array with comment ID and text
        hover_text = []
        for cid in comment_ids:
            text = comment_texts.get(cid, "")
            hover_text.append(f"Comment {cid}: {text}")
        
        # Create label strings with topic names
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
        
        # Create visualization filenames
        static_html = f"{container_dir}/{zid}_layer_{layer_num}_datamapplot_static.html"
        static_png = f"{container_dir}/{zid}_layer_{layer_num}_datamapplot_static.png" 
        
        # Generate datamapplot static visualization with labels over points
        logger.info(f"Creating static visualization with labels over points...")
        
        # Generate static visualization with datamapplot.create_plot
        logger.info("Creating truly static visualization with datamapplot.create_plot...")
        
        # Generate the static plot - it returns (fig, ax) tuple
        fig, ax = datamapplot.create_plot(
            document_map,
            label_strings,
            title=f"Layer {layer_num}",
            label_over_points=True,           # Place labels directly over the point clusters
            dynamic_label_size=True,          # Vary label size based on cluster size
            dynamic_label_size_scaling_factor=0.75,
            max_font_size=28,                 # Maximum font size for labels
            min_font_size=12,                 # Minimum font size for labels
            label_wrap_width=15,              # Wrap long cluster names
            point_size=3,                     # Size of the data points
            noise_label="Unclustered",        # Label for uncategorized points
            noise_color="#aaaaaa",            # Grey color for uncategorized points
            color_label_text=True,            # Color the label text to match points
            cvd_safer=True                    # Use CVD-safer colors
        )
        
        # Use the figure to save the images
        static_png = f"{container_dir}/{zid}_layer_{layer_num}_datamapplot_static.png"
        fig.savefig(static_png, dpi=300, bbox_inches='tight')
        logger.info(f"Saved static PNG to {static_png}")
        
        # Save a higher resolution version for presentations
        presentation_png = f"{container_dir}/{zid}_layer_{layer_num}_datamapplot_presentation.png"
        fig.savefig(presentation_png, dpi=600, bbox_inches='tight')
        logger.info(f"Saved high-resolution PNG to {presentation_png}")
        
        # Save SVG for vector graphics
        svg_file = f"{container_dir}/{zid}_layer_{layer_num}_datamapplot_static.svg"
        fig.savefig(svg_file, format='svg', bbox_inches='tight')
        logger.info(f"Saved vector SVG to {svg_file}")
        
        # Copy to mounted volume if available
        if os.path.exists("/visualizations"):
            os.system(f"cp {static_png} {host_dir}/")
            os.system(f"cp {presentation_png} {host_dir}/")
            os.system(f"cp {svg_file} {host_dir}/")
            logger.info(f"Copied files to {host_dir}")
            
        # Upload files to S3
        try:
            # Create S3 keys for these files
            s3_urls = {}
            
            # Get job ID and report ID from environment variables
            job_id = os.environ.get('DELPHI_JOB_ID', 'unknown')
            report_id = os.environ.get('DELPHI_REPORT_ID', 'unknown')
            
            # Upload static PNG
            s3_key_png = f"visualizations/{report_id}/{job_id}/layer_{layer_num}_datamapplot_static.png"
            s3_url_png = s3_upload_file(static_png, s3_key_png)
            if s3_url_png:
                s3_urls["png"] = s3_url_png
                logger.info(f"Static PNG uploaded to S3: {s3_url_png}")
            
            # Upload presentation PNG
            s3_key_presentation = f"visualizations/{report_id}/{job_id}/layer_{layer_num}_datamapplot_presentation.png"
            s3_url_presentation = s3_upload_file(presentation_png, s3_key_presentation)
            if s3_url_presentation:
                s3_urls["presentation_png"] = s3_url_presentation
                logger.info(f"Presentation PNG uploaded to S3: {s3_url_presentation}")
            
            # Upload SVG
            s3_key_svg = f"visualizations/{report_id}/{job_id}/layer_{layer_num}_datamapplot_static.svg"
            s3_url_svg = s3_upload_file(svg_file, s3_key_svg)
            if s3_url_svg:
                s3_urls["svg"] = s3_url_svg
                logger.info(f"SVG uploaded to S3: {s3_url_svg}")
            
            # Save S3 URLs to a JSON file for reference
            if s3_urls:
                url_file = os.path.join(container_dir, f"{zid}_layer_{layer_num}_s3_urls.json")
                with open(url_file, 'w') as f:
                    json.dump(s3_urls, f, indent=2)
                logger.info(f"S3 URLs saved to {url_file}")
        except Exception as s3_error:
            logger.error(f"Error uploading to S3: {s3_error}")
            import traceback
            logger.error(f"S3 upload traceback: {traceback.format_exc()}")
        
        return True
        
    except Exception as e:
        logger.error(f"Error: {str(e)}")
        logger.error(traceback.format_exc())
        return False

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate static datamapplot")
    parser.add_argument("--zid", type=str, required=True, help="Conversation ID")
    parser.add_argument("--layer", type=int, default=0, help="Layer number")
    parser.add_argument("--output_dir", type=str, help="Output directory")
    
    args = parser.parse_args()
    success = generate_static_datamapplot(args.zid, args.layer, args.output_dir)
    
    if success:
        logger.info("Static datamapplot generation completed successfully")
    else:
        logger.error("Static datamapplot generation failed")
        sys.exit(1)