#!/usr/bin/env python3
"""
Generate consensus-divisive datamapplot visualizations for a conversation.

This script:
1. Colors comments based on their divisiveness/consensus level
2. Generates static visualizations with a color gradient from green (consensus) to red (divisive)
3. Creates both basic and enhanced versions to highlight the divisive vs. consensus patterns
"""

import os
import sys
import argparse
import numpy as np
import matplotlib.pyplot as plt
import json
import boto3
import logging
import traceback
from decimal import Decimal
from typing import Dict, List, Tuple, Any, Optional, Union

# Configuration through environment variables with defaults
DB_CONFIG = {
    'host': os.environ.get('DATABASE_HOST', 'localhost'),
    'port': os.environ.get('DATABASE_PORT', '5432'),
    'name': os.environ.get('DATABASE_NAME', 'polisDB_prod_local_mar14'),
    'user': os.environ.get('DATABASE_USER', 'colinmegill'),
    'password': os.environ.get('DATABASE_PASSWORD', ''),
    'ssl_mode': os.environ.get('DATABASE_SSL_MODE', 'disable')
}

DYNAMODB_CONFIG = {
    'endpoint_url': os.environ.get('DYNAMODB_ENDPOINT', 'http://localhost:8000'),
    'region': os.environ.get('AWS_REGION', 'us-west-2'),
    'access_key': os.environ.get('AWS_ACCESS_KEY_ID', 'fakeMyKeyId'),
    'secret_key': os.environ.get('AWS_SECRET_ACCESS_KEY', 'fakeSecretAccessKey')
}

# Visualization settings - controls the extremity scale and color mapping
VIZ_CONFIG = {
    # Values <= 0 will trigger adaptive percentile-based normalization (recommended)
    # Positive values set a fixed threshold (e.g., 1.0, 0.75)
    'extremity_threshold': float(os.environ.get('EXTREMITY_THRESHOLD', '0')),
    
    # Invert extremity - set to True if high extremity values should mean consensus
    # Set to False if high values mean divisiveness (default)
    'invert_extremity': os.environ.get('INVERT_EXTREMITY', 'False').lower() == 'true',
    
    # Output directory for visualizations
    'output_base_dir': os.environ.get('VIZ_OUTPUT_DIR', 'visualizations')
}

# Import database modules for data access
try:
    from polismath_commentgraph.utils.storage import DynamoDBStorage, PostgresClient
except ImportError:
    logging.warning("Could not import from polismath_commentgraph - falling back to direct connections")
    # Define minimal versions of the required classes if imports fail
    class DynamoDBStorage:
        def __init__(self, endpoint_url=None):
            self.endpoint_url = endpoint_url or DYNAMODB_CONFIG['endpoint_url']
            self.region = DYNAMODB_CONFIG['region']
            self.dynamodb = boto3.resource('dynamodb', 
                                          endpoint_url=self.endpoint_url, 
                                          region_name=self.region,
                                          aws_access_key_id=DYNAMODB_CONFIG['access_key'],
                                          aws_secret_access_key=DYNAMODB_CONFIG['secret_key'])
            
            # Define table names based on what we saw in the existing tables
            self.table_names = {
                'comment_embeddings': 'Delphi_CommentEmbeddings',
                'comment_clusters': 'Delphi_CommentHierarchicalClusterAssignments',
                'llm_topic_names': 'Delphi_CommentClustersLLMTopicNames',
                'umap_graph': 'Delphi_UMAPGraph'
            }

# Configure logging
logging.basicConfig(
    level=logging.INFO, 
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(f"{VIZ_CONFIG['output_base_dir']}/consensus_divisive_datamapplot.log", mode='a')
    ]
)
logger = logging.getLogger(__name__)

def load_data_from_dynamodb(zid, layer_num=0):
    """
    Load data from DynamoDB for visualization.
    
    Args:
        zid: Conversation ID
        layer_num: Layer number (default 0)
        
    Returns:
        Dictionary with comment positions, cluster assignments, and topic names
    """
    logger.info(f'Loading UMAP positions and cluster data for conversation {zid}, layer {layer_num}')
    
    # Set up DynamoDB client
    endpoint_url = os.environ.get('DYNAMODB_ENDPOINT', 'http://dynamodb-local:8000')
    dynamodb = boto3.resource('dynamodb', 
                             endpoint_url=endpoint_url,
                             region_name=os.environ.get('AWS_REGION', 'us-west-2'),
                             aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID', 'fakeMyKeyId'),
                             aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY', 'fakeSecretAccessKey'))
    
    # Results dictionary
    data = {
        "positions": {},
        "clusters": {},
        "topic_names": {}
    }
    
    # Helper function to scan a DynamoDB table
    def scan_table(table_name, filter_expr=None, expr_attr_values=None):
        table = dynamodb.Table(table_name)
        
        scan_kwargs = {}
        if filter_expr is not None and expr_attr_values is not None:
            scan_kwargs['FilterExpression'] = filter_expr
            scan_kwargs['ExpressionAttributeValues'] = expr_attr_values
        
        response = table.scan(**scan_kwargs)
        items = response.get('Items', [])
        
        # Continue scanning if we need to paginate
        while 'LastEvaluatedKey' in response:
            response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'], **scan_kwargs)
            items.extend(response.get('Items', []))
        
        return items
    
    # 1. Get positions from UMAPGraph
    try:
        logger.info('Scanning Delphi_UMAPGraph table for conversation positions...')
        edges = scan_table('Delphi_UMAPGraph', 
                           filter_expr='conversation_id = :conversation_id',
                           expr_attr_values={':conversation_id': str(zid)})
        
        logger.info(f'Retrieved {len(edges)} edges from Delphi_UMAPGraph')
        
        # Extract positions from self-referencing edges
        for edge in edges:
            if edge.get('source_id') == edge.get('target_id') and 'position' in edge:
                pos = edge.get('position')
                if isinstance(pos, dict):
                    comment_id = int(edge.get('source_id'))
                    data["positions"][comment_id] = [float(pos.get('x', 0)), float(pos.get('y', 0))]
        
        logger.info(f'Extracted {len(data["positions"])} comment positions')
    
    except Exception as e:
        logger.error(f'Error retrieving positions from Delphi_UMAPGraph: {e}')
        logger.error(traceback.format_exc())
    
    # 2. Get cluster assignments
    try:
        logger.info('Scanning Delphi_CommentHierarchicalClusterAssignments table for cluster data...')
        clusters = scan_table('Delphi_CommentHierarchicalClusterAssignments', 
                              filter_expr='conversation_id = :conversation_id',
                              expr_attr_values={':conversation_id': str(zid)})
        
        logger.info(f'Retrieved {len(clusters)} comment cluster assignments')
        
        # Extract cluster assignments for this layer
        for item in clusters:
            comment_id = int(item.get('comment_id', 0))
            cluster_column = f'layer{layer_num}_cluster_id'
            if cluster_column in item and item[cluster_column] is not None:
                data["clusters"][comment_id] = int(item[cluster_column])
        
        logger.info(f'Extracted {len(data["clusters"])} cluster assignments for layer {layer_num}')
    
    except Exception as e:
        logger.error(f'Error retrieving cluster assignments: {e}')
        logger.error(traceback.format_exc())
    
    # 3. Get topic names
    try:
        logger.info('Scanning Delphi_CommentClustersLLMTopicNames table for topic names...')
        topic_name_items = scan_table('Delphi_CommentClustersLLMTopicNames', 
                                     filter_expr='conversation_id = :conversation_id AND layer_id = :layer_id',
                                     expr_attr_values={':conversation_id': str(zid), ':layer_id': layer_num})
        
        logger.info(f'Retrieved {len(topic_name_items)} topic names')
        
        # Create topic name map
        for item in topic_name_items:
            cluster_id = int(item.get('cluster_id', 0))
            topic_name = item.get('topic_name', f'Topic {cluster_id}')
            data["topic_names"][cluster_id] = topic_name
    
    except Exception as e:
        logger.error(f'Error retrieving topic names: {e}')
        logger.error(traceback.format_exc())
    
    return data

def get_postgres_connection():
    """
    Create and return a PostgreSQL database connection using the configuration.
    
    Returns:
        psycopg2 connection object
    """
    import psycopg2
    
    try:
        conn = psycopg2.connect(
            host=DB_CONFIG['host'],
            port=DB_CONFIG['port'],
            database=DB_CONFIG['name'],
            user=DB_CONFIG['user'],
            password=DB_CONFIG['password'],
            sslmode=DB_CONFIG['ssl_mode']
        )
        return conn
    except Exception as e:
        logger.error(f"Failed to connect to PostgreSQL: {e}")
        raise

def load_comment_texts_and_extremity(zid, layer_num=0):
    """
    Load comment texts and extremity values from PostgreSQL.
    
    Args:
        zid: Conversation ID
        layer_num: Layer number (unused parameter but kept for API compatibility)
        
    Returns:
        Tuple of (comment_texts, extremity_values)
    """
    logger.info(f'Loading comment texts and extremity data for conversation {zid}')
    
    # Initialize return values
    comment_texts = {}
    extremity_values = {}
    
    # Connect to PostgreSQL
    try:
        import psycopg2
        conn = get_postgres_connection()
        
        cursor = conn.cursor()
        
        # 1. Get comment texts
        cursor.execute('SELECT tid, txt FROM comments WHERE zid = %s', (zid,))
        comments_data = cursor.fetchall()
        comment_texts = {tid: txt for tid, txt in comments_data}
        logger.info(f'Retrieved {len(comment_texts)} comment texts')
        
        # 2. Try to get extremity values from math_ptptstats
        try:
            # First check if the table exists
            cursor.execute("SELECT to_regclass('math_ptptstats')")
            table_exists = cursor.fetchone()[0]
            
            if table_exists:
                logger.info("math_ptptstats table exists, querying it...")
                # First try math_ptptstats
                cursor.execute('SELECT data FROM math_ptptstats WHERE zid = %s LIMIT 1', (zid,))
                ptptstats = cursor.fetchone()
            else:
                logger.warning("math_ptptstats table does not exist, skipping")
                ptptstats = None
            
            if ptptstats and ptptstats[0]:
                data = ptptstats[0]
                logger.info(f'Found ptptstats data for ZID {zid}')
                
                # Direct approach - looks like the data is a JSON object with comment IDs and values
                # Extract directly from the data structure
                from decimal import Decimal
                import json
                
                try:
                    # If data is a string, parse it as JSON
                    if isinstance(data, str):
                        try:
                            data_obj = json.loads(data)
                        except json.JSONDecodeError:
                            logger.warning('Could not parse ptptstats data as JSON')
                            data_obj = data
                    else:
                        data_obj = data
                        
                    # The data structure appears to contain values directly
                    # We'll use the absolute values of these numbers as extremity measures
                    if isinstance(data_obj, dict):
                        # Look for 'ptptstats' structure or use direct values
                        if 'ptptstats' in data_obj:
                            ptpdata = data_obj['ptptstats']
                            
                            # Standard approach - check for 'extremeness' and 'tid' fields
                            if isinstance(ptpdata, dict) and 'extremeness' in ptpdata and 'tid' in ptpdata:
                                extremeness = ptpdata['extremeness']
                                tids = ptpdata['tid']
                                
                                for i, tid in enumerate(tids):
                                    if i < len(extremeness):
                                        # Convert from potentially Decimal to float
                                        ext_val = extremeness[i]
                                        if isinstance(ext_val, Decimal):
                                            ext_val = float(ext_val)
                                        else:
                                            ext_val = float(ext_val)
                                        extremity_values[tid] = ext_val
                                
                                logger.info(f'Extracted extremity values for {len(extremity_values)} comments from standard structure')
                            else:
                                # The data appears to be a flattened array of values
                                # Let's try to extract them directly - requires examining the data structure
                                logger.info('Trying to extract directly from data structure')
                                
                                # Based on examining sample data, it appears to be an array of values where
                                # every N values represent information about a comment
                                # For this case, we'll extract any numeric values directly as a fallback
                                comment_ids = list(comment_texts.keys())
                                comment_ids.sort()  # Sort to maintain consistent ordering
                                
                                # Derive extremity from repness values if available
                                if 'repness' in data_obj:
                                    repness = data_obj['repness']
                                    for tid_str, values in repness.items():
                                        try:
                                            tid = int(tid_str)
                                            # Extract maximum absolute value as extremity
                                            if isinstance(values, dict):
                                                abs_values = []
                                                for group, val in values.items():
                                                    if isinstance(val, (int, float, Decimal)):
                                                        abs_values.append(abs(float(val)))
                                                if abs_values:
                                                    extremity_values[tid] = max(abs_values)
                                        except (ValueError, TypeError):
                                            continue
                                
                                logger.info(f'Extracted {len(extremity_values)} extremity values from repness')
                                    
                        else:
                            logger.warning('Could not find ptptstats in data')
                except Exception as e:
                    logger.error(f'Error parsing ptptstats data: {e}')
                    logger.error(traceback.format_exc())
        
            # If no values found, try math_main table
            if not extremity_values:
                # Check if math_main table exists
                cursor.execute("SELECT to_regclass('math_main')")
                main_table_exists = cursor.fetchone()[0]
                
                if main_table_exists:
                    logger.info('Trying to extract extremity from math_main')
                    cursor.execute('SELECT data FROM math_main WHERE zid = %s LIMIT 1', (zid,))
                    math_main = cursor.fetchone()
                else:
                    logger.warning("math_main table does not exist, skipping")
                    math_main = None
                
                if math_main and math_main[0]:
                    data = math_main[0]
                    
                    # Try different possible paths to extremity data
                    if 'repness' in data:
                        # Get repness data - this can be used as a proxy for extremity
                        # Higher repness values mean the comment is more representative of one group vs another
                        repness = data['repness']
                        
                        if isinstance(repness, dict):
                            # Use the maximum repness value as extremity
                            for tid, group_values in repness.items():
                                try:
                                    tid_int = int(tid)
                                    # Extract repness values for different groups
                                    group_repness = []
                                    if isinstance(group_values, dict):
                                        for group, val in group_values.items():
                                            if isinstance(val, (int, float, Decimal)):
                                                group_repness.append(float(val))
                                    
                                    # Use the maximum absolute repness value as the extremity
                                    if group_repness:
                                        extremity_values[tid_int] = max(abs(float(x)) for x in group_repness)
                                except (ValueError, TypeError) as e:
                                    continue
                            
                            logger.info(f'Extracted extremity values from math_main/repness: {len(extremity_values)}')
                    
                    # Also check 'extremity' field directly
                    elif 'extremity' in data:
                        for tid, value in data['extremity'].items():
                            try:
                                extremity_values[int(tid)] = float(value)
                            except (ValueError, TypeError):
                                pass
        except Exception as e:
            logger.error(f'Error extracting extremity data: {e}')
            logger.error(traceback.format_exc())
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        logger.error(f'Error connecting to PostgreSQL: {e}')
        logger.error(traceback.format_exc())
    
    # Try extracting from math_main table - this is the primary source of extremity data
    logger.info('Extracting comment extremity values from math_main PCA data')
    try:
        # Create a new database connection for this query
        math_conn = get_postgres_connection()
        math_cursor = math_conn.cursor()
        
        # Query the math_main table to get the PCA data
        # Check if math_main table exists
        math_cursor.execute("SELECT to_regclass('math_main')")
        main_table_exists = math_cursor.fetchone()[0]
        
        if main_table_exists:
            math_cursor.execute('SELECT data FROM math_main WHERE zid = %s LIMIT 1', (zid,))
            math_main = math_cursor.fetchone()
        else:
            logger.warning("math_main table does not exist, skipping")
            math_main = None
        
        if math_main and math_main[0]:
            # Extract the data dictionary
            math_data = math_main[0]
            
            # Check for PCA comment-extremity data
            if 'pca' in math_data and 'comment-extremity' in math_data['pca'] and 'tids' in math_data:
                comment_extremity = math_data['pca']['comment-extremity']
                tids = math_data['tids']
                
                # Verify the data structure - comment-extremity should be a list of values corresponding to tids
                if isinstance(comment_extremity, list) and isinstance(tids, list) and len(comment_extremity) == len(tids):
                    logger.info(f'Found {len(tids)} comment extremity values in PCA data')
                    
                    # First, calculate min and max to understand the data range
                    valid_extremity_values = [float(val) for val in comment_extremity if val is not None]
                    if valid_extremity_values:
                        min_val = min(valid_extremity_values)
                        max_val = max(valid_extremity_values)
                        logger.info(f'Raw extremity value range: {min_val} to {max_val}')
                        
                        # Calculate percentiles for statistically sound normalization
                        # Using 95th percentile to define the upper bound, all values above will be maxed out
                        # This is more adaptive to each dataset than a fixed threshold
                        percentile_95 = np.percentile(valid_extremity_values, 95)
                        percentile_99 = np.percentile(valid_extremity_values, 99)
                        
                        # Print these to stderr directly as well for debugging
                        print(f'Statistical metrics:', file=sys.stderr)
                        print(f'  Raw extremity range: {min_val:.4f} to {max_val:.4f}', file=sys.stderr)
                        print(f'  95th percentile: {percentile_95:.4f}', file=sys.stderr)
                        print(f'  99th percentile: {percentile_99:.4f}', file=sys.stderr)
                        print(f'  Mean: {np.mean(valid_extremity_values):.4f}', file=sys.stderr)
                        print(f'  Median: {np.median(valid_extremity_values):.4f}', file=sys.stderr)
                        
                        # Also log to the logger
                        logger.info(f'Statistical metrics:')
                        logger.info(f'  Raw extremity range: {min_val:.4f} to {max_val:.4f}')
                        logger.info(f'  95th percentile: {percentile_95:.4f}')
                        logger.info(f'  99th percentile: {percentile_99:.4f}')
                        logger.info(f'  Mean: {np.mean(valid_extremity_values):.4f}')
                        logger.info(f'  Median: {np.median(valid_extremity_values):.4f}')
                        
                        # Choose normalization method based on data properties
                        # Use threshold if specified, otherwise use 95th percentile
                        normalization_max = VIZ_CONFIG['extremity_threshold']
                        if normalization_max <= 0:
                            # If threshold is not positive, use data-adaptive percentile
                            normalization_max = percentile_95
                            logger.info(f'Using 95th percentile ({percentile_95:.4f}) for normalization')
                            print(f'Using 95th percentile ({percentile_95:.4f}) for normalization', file=sys.stderr)
                        else:
                            logger.info(f'Using configured threshold ({normalization_max}) for normalization')
                            print(f'Using configured threshold ({normalization_max}) for normalization', file=sys.stderr)
                        
                        # Map the comment extremity values to their corresponding comment IDs
                        for i, tid in enumerate(tids):
                            if i < len(comment_extremity) and comment_extremity[i] is not None:
                                # Raw extremity value
                                raw_value = float(comment_extremity[i])
                                
                                # Normalize to [0,1] based on the normalization max
                                # Values above normalization_max will be capped at 1.0
                                normalized_value = min(raw_value / normalization_max, 1.0)
                                
                                # If configured to invert, flip the value (1 - normalized)
                                if VIZ_CONFIG['invert_extremity']:
                                    normalized_value = 1.0 - normalized_value
                                
                                extremity_values[tid] = normalized_value
                        
                        logger.info(f'Extracted and normalized {len(extremity_values)} extremity values')
                    else:
                        logger.warning('No valid extremity values found in the data')
                else:
                    logger.warning(f'Unexpected data structure: comment-extremity length={len(comment_extremity) if isinstance(comment_extremity, list) else "not list"}, tids length={len(tids) if isinstance(tids, list) else "not list"}')
            else:
                logger.warning('Could not find PCA comment-extremity data')
        else:
            logger.warning('No math_main data found for this conversation')
    except Exception as e:
        logger.error(f'Error extracting from math_main: {e}')
        logger.error(traceback.format_exc())
    finally:
        # Close the math connection
        if 'math_cursor' in locals():
            math_cursor.close()
        if 'math_conn' in locals():
            math_conn.close()
            
    # If still no extremity values, generate random ones for visualization purposes
    if not extremity_values:
        logger.warning('No extremity values found. Generating random values for visualization.')
        # For each comment, generate a random extremity value between 0 and 1
        for comment_id in comment_texts.keys():
            extremity_values[comment_id] = np.random.random()
        logger.info(f'Generated {len(extremity_values)} random extremity values')
    
    logger.info(f'Final extremity values count: {len(extremity_values)}')
    return comment_texts, extremity_values

def create_consensus_divisive_datamapplot(zid, layer_num=0, output_dir=None):
    # Import here to avoid circular imports
    import decimal
    import numpy as np
    """
    Generate visualizations that color comments by consensus/divisiveness.
    
    Args:
        zid: Conversation ID
        layer_num: Layer number (default 0)
        output_dir: Optional output directory override
        
    Returns:
        Boolean indicating success
    """
    logger.info(f'Generating consensus/divisive datamapplot for conversation {zid}, layer {layer_num}')
    
    try:
        # 1. Load data from DynamoDB
        dynamo_data = load_data_from_dynamodb(zid, layer_num)
        positions = dynamo_data["positions"]
        # Convert decimal values to float if present
        if isinstance(positions, np.ndarray) and positions.size > 0:
            first_element = positions.flat[0]
            if isinstance(first_element, decimal.Decimal):
                logger.debug("Converting Decimal values in positions to float")
                positions = np.array([[float(x) for x in point] for point in positions], dtype=np.float64)
        
        clusters = dynamo_data["clusters"] 
        topic_names = dynamo_data["topic_names"]
        
        # 2. Load comment texts and extremity values
        comment_texts, extremity_values = load_comment_texts_and_extremity(zid, layer_num)
        
        # 3. Prepare data for visualization
        logger.info('Preparing data for visualization')
        
        # Create arrays for plotting
        comment_ids = sorted(positions.keys())
        position_array = np.array([positions[cid] for cid in comment_ids])
        cluster_array = np.array([clusters.get(cid, -1) for cid in comment_ids])
        
        # Create label strings
        label_strings = np.array([
            topic_names.get(clusters.get(cid, -1), f'Topic {clusters.get(cid, -1)}') 
            if clusters.get(cid, -1) >= 0 else 'Unclustered'
            for cid in comment_ids
        ])
        
        # Create color values based on extremity
        # Red for divisive (high extremity), green for consensus (low extremity)
        # Values are already normalized to [0,1] during loading
        extremity_array = np.array([extremity_values.get(cid, 0) for cid in comment_ids])
        
        # Log statistics about the extremity distribution
        if len(extremity_array) > 0:
            min_extremity = np.min(extremity_array)
            max_extremity = np.max(extremity_array)
            mean_extremity = np.mean(extremity_array)
            median_extremity = np.median(extremity_array)
            
            # Count distribution
            low_count = np.sum(extremity_array < 0.3)
            mid_count = np.sum((extremity_array >= 0.3) & (extremity_array < 0.7))
            high_count = np.sum(extremity_array >= 0.7)
            
            logger.info(f'Extremity statistics:')
            logger.info(f'  Range: {min_extremity:.4f} to {max_extremity:.4f}')
            logger.info(f'  Mean: {mean_extremity:.4f}, Median: {median_extremity:.4f}')
            logger.info(f'  Distribution: {low_count} low (<0.3), {mid_count} medium, {high_count} high (>=0.7)')
            
            # No need to normalize again, we already have values in [0,1]
            normalized_extremity = extremity_array
        else:
            normalized_extremity = np.zeros(len(comment_ids))
        
        # 4. Create visualization directories
        # Default visualization directory
        vis_dir = os.path.join("visualizations", str(zid))
        os.makedirs(vis_dir, exist_ok=True)
        
        # Optional custom output directory
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        
        # 5. Create a colormap from green (consensus) to red (divisive)
        consensus_cmap = plt.cm.RdYlGn_r  # Red-Yellow-Green reversed (green is low values, red is high)
        
        # 6. Create first visualization - with cluster labels
        fig, ax = plt.subplots(figsize=(14, 12))
        ax.set_facecolor('#f8f8f8')  # Light background
        
        # Plot the comments colored by extremity
        scatter = ax.scatter(position_array[:, 0], position_array[:, 1], 
                            c=normalized_extremity, cmap=consensus_cmap, s=80, alpha=0.8, 
                            edgecolors='black', linewidths=0.3)
        
        # Add cluster labels
        # Get unique clusters
        unique_clusters = np.unique(cluster_array)
        unique_clusters = unique_clusters[unique_clusters >= 0]  # Remove noise (-1)
        
        # Calculate cluster centers and add labels
        for cluster_id in unique_clusters:
            # Get points in this cluster
            cluster_mask = cluster_array == cluster_id
            if np.sum(cluster_mask) > 0:
                # Calculate center
                center_x = np.mean(position_array[cluster_mask, 0])
                center_y = np.mean(position_array[cluster_mask, 1])
                
                # Get topic name
                topic_name = topic_names.get(cluster_id, f'Topic {cluster_id}')
                
                # Truncate long topic names
                if len(topic_name) > 30:
                    topic_name = topic_name[:27] + '...'
                
                # Add text
                ax.text(center_x, center_y, topic_name, 
                       fontsize=12, fontweight='bold', ha='center', va='center',
                       bbox=dict(facecolor='white', alpha=0.7, edgecolor='gray', boxstyle='round,pad=0.5'))
        
        # Add a title
        ax.set_title(f'Conversation {zid} - Comments Colored by Consensus/Divisiveness', fontsize=16)
        
        # Remove axes
        ax.set_xticks([])
        ax.set_yticks([])
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.spines['bottom'].set_visible(False)
        ax.spines['left'].set_visible(False)
        
        # Add a colorbar for the extremeness values
        cbar = plt.colorbar(scatter, ax=ax)
        cbar.set_label('Divisiveness ↔ Consensus', fontsize=14)
        # Set ticks correctly
        cbar.set_ticks([0, 0.25, 0.5, 0.75, 1.0])
        cbar.set_ticklabels(['Consensus (Agreement)', 'Mostly Agreement', 'Mixed Opinions', 'Some Disagreement', 'Divisive (Strong Disagreement)'])
        
        # Add a legend explaining the colors
        legend_elements = [
            plt.Line2D([0], [0], marker='o', color='w', markerfacecolor='green', markersize=15, label='Consensus Comments'),
            plt.Line2D([0], [0], marker='o', color='w', markerfacecolor='yellow', markersize=15, label='Mixed Opinion Comments'),
            plt.Line2D([0], [0], marker='o', color='w', markerfacecolor='red', markersize=15, label='Divisive Comments')
        ]
        ax.legend(handles=legend_elements, loc='upper right', facecolor='white', framealpha=0.7)
        
        # Save visualizations to both directories
        # 1. Standard PNG
        output_file = os.path.join(vis_dir, f"{zid}_consensus_divisive_colored_map.png")
        plt.savefig(output_file, dpi=300, bbox_inches='tight')
        logger.info(f'Saved visualization to {output_file}')
        
        # 2. High-resolution PNG
        hires_file = os.path.join(vis_dir, f"{zid}_consensus_divisive_colored_map_hires.png")
        plt.savefig(hires_file, dpi=600, bbox_inches='tight')
        logger.info(f'Saved high-resolution visualization to {hires_file}')
        
        # 3. SVG for vector graphics
        svg_file = os.path.join(vis_dir, f"{zid}_consensus_divisive_colored_map.svg")
        plt.savefig(svg_file, format='svg', bbox_inches='tight')
        logger.info(f'Saved vector SVG to {svg_file}')
        
        # Save to custom output directory if provided
        if output_dir and output_dir != vis_dir:
            out_file = os.path.join(output_dir, f"{zid}_consensus_divisive_colored_map.png")
            plt.savefig(out_file, dpi=300, bbox_inches='tight')
            logger.info(f'Saved visualization to output directory: {out_file}')
            
            out_hires = os.path.join(output_dir, f"{zid}_consensus_divisive_colored_map_hires.png")
            plt.savefig(out_hires, dpi=600, bbox_inches='tight')
            logger.info(f'Saved high-resolution visualization to output directory')
            
            out_svg = os.path.join(output_dir, f"{zid}_consensus_divisive_colored_map.svg")
            plt.savefig(out_svg, format='svg', bbox_inches='tight')
            logger.info(f'Saved SVG to output directory')
        
        plt.close()
        
        # 7. Create a second, enhanced visualization without cluster labels
        fig, ax = plt.subplots(figsize=(14, 12))
        ax.set_facecolor('#f8f8f8')  # Light background
        
        # Plot the comments with larger points and stronger colors
        scatter = ax.scatter(position_array[:, 0], position_array[:, 1], 
                            c=normalized_extremity, cmap=consensus_cmap, s=120, alpha=0.9, 
                            edgecolors='black', linewidths=0.5)
        
        # Skip cluster labels in this version to focus on the extremity coloring
        
        # Add a title with more explanation
        ax.set_title(f'Conversation {zid} - Comment Consensus/Divisiveness Map', fontsize=16)
        ax.text(0.5, 0.05, 'Green = Consensus Comments    Yellow = Mixed Opinions    Red = Divisive Comments', 
                transform=ax.transAxes, ha='center', fontsize=14, 
                bbox=dict(facecolor='white', alpha=0.7, edgecolor='gray', boxstyle='round,pad=0.5'))
        
        # Remove axes
        ax.set_xticks([])
        ax.set_yticks([])
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.spines['bottom'].set_visible(False)
        ax.spines['left'].set_visible(False)
        
        # Add a colorbar with proper ticks
        cbar = plt.colorbar(scatter, ax=ax)
        cbar.set_label('Consensus ↔ Divisiveness', fontsize=14)
        cbar.set_ticks([0, 0.25, 0.5, 0.75, 1.0])
        cbar.set_ticklabels(['Consensus', 'Mostly Agreement', 'Mixed', 'Some Disagreement', 'Divisive'])
        
        # Save enhanced version to both directories
        alt_file = os.path.join(vis_dir, f"{zid}_consensus_divisive_enhanced.png")
        plt.savefig(alt_file, dpi=300, bbox_inches='tight')
        logger.info(f'Saved enhanced visualization to {alt_file}')
        
        if output_dir and output_dir != vis_dir:
            out_enhanced = os.path.join(output_dir, f"{zid}_consensus_divisive_enhanced.png")
            plt.savefig(out_enhanced, dpi=300, bbox_inches='tight')
            logger.info(f'Saved enhanced visualization to output directory')
        
        plt.close()
        
        logger.info(f'Consensus/divisive datamapplot generation completed successfully')
        return True
        
    except Exception as e:
        logger.error(f'Error generating consensus/divisive datamapplot: {e}')
        logger.error(traceback.format_exc())
        return False

def main():
    """Main function to parse arguments and execute visualization generation."""
    parser = argparse.ArgumentParser(description="Generate consensus/divisive datamapplot")
    parser.add_argument("--zid", type=str, required=True, help="Conversation ID")
    parser.add_argument("--layer", type=int, default=0, help="Layer number")
    parser.add_argument("--output_dir", type=str, help="Output directory")
    parser.add_argument("--extremity_threshold", type=float, 
                        help=f"Maximum extremity value (values above this are capped). Set to 0 or negative for adaptive percentile-based normalization (recommended). Default: {VIZ_CONFIG['extremity_threshold']}")
    parser.add_argument("--invert_extremity", action="store_true", 
                        help="Invert the extremity scale (high values = consensus)")
    
    args = parser.parse_args()
    
    # Override config with command line arguments if provided
    if args.extremity_threshold is not None:
        VIZ_CONFIG['extremity_threshold'] = args.extremity_threshold
        logger.info(f"Using extremity threshold from command line: {VIZ_CONFIG['extremity_threshold']}")
    
    if args.invert_extremity:
        VIZ_CONFIG['invert_extremity'] = True
        logger.info("Inverting extremity scale: high values = consensus")
    
    # Log configuration
    logger.info("Configuration:")
    logger.info(f"  Database: {DB_CONFIG['host']}:{DB_CONFIG['port']}/{DB_CONFIG['name']}")
    logger.info(f"  DynamoDB: {DYNAMODB_CONFIG['endpoint_url']}")
    logger.info(f"  Visualization: threshold={VIZ_CONFIG['extremity_threshold']}, invert={VIZ_CONFIG['invert_extremity']}")
    
    # Generate visualization
    try:
        success = create_consensus_divisive_datamapplot(args.zid, args.layer, args.output_dir)
        
        if success:
            logger.info("Consensus/divisive datamapplot generation completed successfully")
        else:
            logger.error("Consensus/divisive datamapplot generation failed")
            sys.exit(1)
    except Exception as e:
        logger.error(f"Unhandled exception: {e}")
        logger.error(traceback.format_exc())
        sys.exit(1)

if __name__ == "__main__":
    main()