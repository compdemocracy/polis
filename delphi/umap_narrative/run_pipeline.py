#!/usr/bin/env python3
"""
Process Polis conversation from PostgreSQL and generate visualizations.

This script fetches conversation data from PostgreSQL, processes it using
EVōC for clustering, and generates interactive visualizations with topic labeling.
"""

import os
import sys
import json
import time
import logging
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime
import decimal
import traceback
from pathlib import Path
from tqdm.auto import tqdm
import boto3
from boto3.dynamodb.conditions import Key

# Import from installed packages
import evoc
import datamapplot
from sentence_transformers import SentenceTransformer
from umap import UMAP
from sklearn.feature_extraction.text import CountVectorizer, TfidfTransformer

# Import from local modules
from polismath_commentgraph.utils.storage import PostgresClient, DynamoDBStorage
from polismath_commentgraph.utils.converter import DataConverter
from polismath_commentgraph.core.embedding import EmbeddingEngine
from polismath_commentgraph.core.clustering import ClusteringEngine

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def setup_environment(db_host=None, db_port=None, db_name=None, db_user=None, db_password=None):
    """Set up environment variables for database connections."""
    # PostgreSQL settings - Prefer POSTGRES_* variables over DATABASE_* variables
    postgres_host = os.environ.get('POSTGRES_HOST')
    postgres_port = os.environ.get('POSTGRES_PORT')
    postgres_db = os.environ.get('POSTGRES_DB')
    postgres_user = os.environ.get('POSTGRES_USER')
    postgres_password = os.environ.get('POSTGRES_PASSWORD')
    
    # Priority: 1. Command line args, 2. POSTGRES_* env vars, 3. DATABASE_* env vars, 4. defaults
    
    # Host
    if db_host:
        os.environ['DATABASE_HOST'] = db_host
        os.environ['POSTGRES_HOST'] = db_host
    elif postgres_host:
        os.environ['DATABASE_HOST'] = postgres_host
    elif not os.environ.get('DATABASE_HOST'):
        os.environ['DATABASE_HOST'] = 'localhost'
        # Also set POSTGRES_HOST for consistency
        if not postgres_host:
            os.environ['POSTGRES_HOST'] = 'localhost'
    
    # Port
    if db_port:
        os.environ['DATABASE_PORT'] = str(db_port)
        os.environ['POSTGRES_PORT'] = str(db_port)
    elif postgres_port:
        os.environ['DATABASE_PORT'] = postgres_port
    elif not os.environ.get('DATABASE_PORT'):
        os.environ['DATABASE_PORT'] = '5432'
        # Also set POSTGRES_PORT for consistency
        if not postgres_port:
            os.environ['POSTGRES_PORT'] = '5432'
    
    # Database name
    if db_name:
        os.environ['DATABASE_NAME'] = db_name
        os.environ['POSTGRES_DB'] = db_name
    elif postgres_db:
        os.environ['DATABASE_NAME'] = postgres_db
    elif not os.environ.get('DATABASE_NAME'):
        os.environ['DATABASE_NAME'] = 'polisDB_prod_local_mar14'
        # Also set POSTGRES_DB for consistency
        if not postgres_db:
            os.environ['POSTGRES_DB'] = 'polisDB_prod_local_mar14'
    
    # User
    if db_user:
        os.environ['DATABASE_USER'] = db_user
        os.environ['POSTGRES_USER'] = db_user
    elif postgres_user:
        os.environ['DATABASE_USER'] = postgres_user
    elif not os.environ.get('DATABASE_USER'):
        os.environ['DATABASE_USER'] = 'postgres'
        # Also set POSTGRES_USER for consistency
        if not postgres_user:
            os.environ['POSTGRES_USER'] = 'postgres'
    
    # Password
    if db_password:
        os.environ['DATABASE_PASSWORD'] = db_password
        os.environ['POSTGRES_PASSWORD'] = db_password
    elif postgres_password:
        os.environ['DATABASE_PASSWORD'] = postgres_password
    elif not os.environ.get('DATABASE_PASSWORD'):
        os.environ['DATABASE_PASSWORD'] = ''
        # Also set POSTGRES_PASSWORD for consistency
        if not postgres_password:
            os.environ['POSTGRES_PASSWORD'] = ''
    
    # Ensure DATABASE_URL is set if not already - needed by some components
    if not os.environ.get('DATABASE_URL'):
        # Use POSTGRES_* variables if available, otherwise construct from DATABASE_* variables
        host = os.environ.get('POSTGRES_HOST') or os.environ.get('DATABASE_HOST')
        port = os.environ.get('POSTGRES_PORT') or os.environ.get('DATABASE_PORT')
        db = os.environ.get('POSTGRES_DB') or os.environ.get('DATABASE_NAME')
        user = os.environ.get('POSTGRES_USER') or os.environ.get('DATABASE_USER')
        password = os.environ.get('POSTGRES_PASSWORD') or os.environ.get('DATABASE_PASSWORD')
        
        # Construct DATABASE_URL
        if password:
            os.environ['DATABASE_URL'] = f"postgresql://{user}:{password}@{host}:{port}/{db}"
        else:
            os.environ['DATABASE_URL'] = f"postgresql://{user}@{host}:{port}/{db}"
    
    # Print database connection info
    logger.info(f"Database connection info:")
    logger.info(f"- HOST: {os.environ.get('POSTGRES_HOST') or os.environ.get('DATABASE_HOST')}")
    logger.info(f"- PORT: {os.environ.get('POSTGRES_PORT') or os.environ.get('DATABASE_PORT')}")
    logger.info(f"- DATABASE: {os.environ.get('POSTGRES_DB') or os.environ.get('DATABASE_NAME')}")
    logger.info(f"- USER: {os.environ.get('POSTGRES_USER') or os.environ.get('DATABASE_USER')}")
    logger.info(f"- DATABASE_URL: {os.environ.get('DATABASE_URL').replace(os.environ.get('POSTGRES_PASSWORD') or '', '*****')}")
    
    # DynamoDB settings (for local DynamoDB)
    # Don't override if already set in environment
    dynamo_endpoint = os.environ.get('DYNAMODB_ENDPOINT')
    if not dynamo_endpoint:
        os.environ['DYNAMODB_ENDPOINT'] = 'http://localhost:8000'
        logger.info("Setting default DynamoDB endpoint: http://localhost:8000")
    else:
        logger.info(f"Using existing DynamoDB endpoint: {dynamo_endpoint}")
    
    # Always set these credentials for local development if not already set
    if not os.environ.get('AWS_ACCESS_KEY_ID'):
        os.environ['AWS_ACCESS_KEY_ID'] = 'fakeMyKeyId'
    
    if not os.environ.get('AWS_SECRET_ACCESS_KEY'):
        os.environ['AWS_SECRET_ACCESS_KEY'] = 'fakeSecretAccessKey'
    
    if not os.environ.get('AWS_DEFAULT_REGION') and not os.environ.get('AWS_REGION'):
        os.environ['AWS_DEFAULT_REGION'] = 'us-west-2'

def fetch_conversation_data(zid, skip_postgres=False, postgres_for_comments_only=True):
    """
    Fetch conversation data, trying DynamoDB first and optionally falling back to PostgreSQL.
    
    Args:
        zid: Conversation ID
        skip_postgres: If True, only use DynamoDB and don't fall back to PostgreSQL
        postgres_for_comments_only: If True, still use PostgreSQL for comment texts even if skip_postgres is True
        
    Returns:
        comments: List of comment dictionaries
        metadata: Dictionary with conversation metadata
    """
    # First try to load from DynamoDB
    logger.info(f"Attempting to load conversation {zid} from DynamoDB...")
    try:
        # Initialize DynamoDB storage
        dynamo_storage = DynamoDBStorage(
            region_name='us-west-2',
            endpoint_url=os.environ.get('DYNAMODB_ENDPOINT')
        )
        
        # Get conversation metadata from PCA results table
        try:
            config_table = dynamo_storage.dynamodb.Table('Delphi_PCAConversationConfig')
            config_response = config_table.get_item(Key={'zid': str(zid)})
            
            if 'Item' in config_response:
                logger.info(f"Found conversation metadata in DynamoDB for {zid}")
                meta = config_response['Item']
                math_tick = meta.get('latest_math_tick')
                
                if math_tick:
                    logger.info(f"Found math tick {math_tick} in PCA config")
                    # Get comment data from Delphi_CommentRouting table
                    try:
                        zid_tick = f"{zid}:{math_tick}"
                        comments_table = dynamo_storage.dynamodb.Table('Delphi_CommentRouting')
                        response = comments_table.query(
                            KeyConditionExpression=boto3.dynamodb.conditions.Key('zid_tick').eq(zid_tick)
                        )
                        
                        comment_items = response.get('Items', [])
                        # Handle pagination if needed
                        while 'LastEvaluatedKey' in response:
                            response = comments_table.query(
                                KeyConditionExpression=boto3.dynamodb.conditions.Key('zid_tick').eq(zid_tick),
                                ExclusiveStartKey=response['LastEvaluatedKey']
                            )
                            comment_items.extend(response.get('Items', []))
                        
                        if comment_items:
                            logger.info(f"Found {len(comment_items)} comments in DynamoDB")
                            
                            # We need to get comment texts from PostgreSQL since they're not in DynamoDB
                            # Get PostgreSQL connection temporarily
                            postgres_client = PostgresClient()
                            postgres_client.initialize()
                            
                            # Get comment texts from PostgreSQL if not skipped entirely
                            if skip_postgres and not postgres_for_comments_only:
                                logger.warning("PostgreSQL lookup for comment texts is disabled, using placeholders")
                                # Create placeholder texts based on comment IDs
                                all_comments = [{'tid': cid, 'txt': f"Comment {cid} (text unavailable)"} 
                                                for cid in [item['comment_id'] for item in comment_items]]
                            else:
                                # Always try to get actual comment texts from PostgreSQL
                                try:
                                    if skip_postgres and postgres_for_comments_only:
                                        logger.info("Getting comment texts from PostgreSQL (postgres_for_comments_only=True overrides skip_postgres)")
                                    else:
                                        logger.info("Getting comment texts from PostgreSQL" + (" (even in skip_postgres mode)" if skip_postgres else ""))
                                    all_comments = postgres_client.get_comments_by_conversation(zid)
                                    postgres_client.shutdown()
                                except Exception as e:
                                    logger.warning(f"Failed to get comment texts from PostgreSQL: {e}, using placeholders")
                                    # Fall back to placeholders if PostgreSQL access fails
                                    all_comments = [{'tid': cid, 'txt': f"Comment {cid} (text unavailable)"} 
                                                    for cid in [item['comment_id'] for item in comment_items]]
                            
                            # Create a mapping of comment IDs to texts
                            comment_texts = {str(c['tid']): c['txt'] for c in all_comments}
                            
                            # Merge comment data from DynamoDB with texts from PostgreSQL
                            comments = []
                            for item in comment_items:
                                comment_id = item['comment_id']
                                if comment_id in comment_texts:
                                    comments.append({
                                        'tid': comment_id,
                                        'zid': zid,
                                        'txt': comment_texts[comment_id],
                                        'priority': item.get('priority', 0),
                                        'active': True  # Assume active
                                    })
                            
                            # Create metadata
                            metadata = {
                                'conversation_id': str(zid),
                                'zid': zid,
                                'conversation_name': meta.get('topic', f"Conversation {zid}"),
                                'description': '',
                                'num_comments': len(comments),
                                'num_participants': meta.get('participant_count', 0),
                                'source': 'dynamo',
                                'math_tick': math_tick
                            }
                            
                            logger.info(f"Successfully loaded {len(comments)} comments from DynamoDB")
                            return comments, metadata
                    except Exception as e:
                        logger.warning(f"Error loading comment data from DynamoDB: {e}")
                        logger.warning("Falling back to PostgreSQL")
        except Exception as e:
            logger.warning(f"Error checking PCA config: {e}")
            logger.warning("Falling back to PostgreSQL")
    except Exception as e:
        logger.warning(f"Error accessing DynamoDB: {e}")
        if skip_postgres:
            logger.error("DynamoDB access failed and PostgreSQL fallback is disabled")
            return None, None
        logger.warning("Falling back to PostgreSQL")
    
    # Fall back to PostgreSQL if not skipped
    if skip_postgres:
        logger.info("Skipping PostgreSQL load as requested")
        return None, None
        
    logger.warning(f"DEPRECATED: Falling back to PostgreSQL for conversation {zid}. PostgreSQL support will be removed in a future release.")
    logger.warning("Please ensure your data is stored in DynamoDB for future compatibility.")
    postgres_client = PostgresClient()
    
    try:
        # Initialize connection
        postgres_client.initialize()
        
        # Get conversation metadata
        conversation = postgres_client.get_conversation_by_id(zid)
        if not conversation:
            logger.error(f"Conversation {zid} not found in database.")
            return None, None
        
        # Get comments - include all comments, regardless of active status
        comments = postgres_client.get_comments_by_conversation(zid)
        logger.info(f"Retrieved {len(comments)} comments from conversation {zid}")
        
        # Count active and inactive for logging purposes only
        active_count = sum(1 for c in comments if c.get('active', True))
        inactive_count = sum(1 for c in comments if not c.get('active', True))
        logger.info(f"Comment counts - Active: {active_count}, Inactive: {inactive_count}, Total: {len(comments)}")
        
        # Create metadata
        metadata = {
            'conversation_id': str(zid),
            'zid': zid,
            'conversation_name': conversation.get('topic', f"Conversation {zid}"),
            'description': conversation.get('description', ''),
            'created': str(conversation.get('created', '')),
            'modified': str(conversation.get('modified', '')),
            'owner': conversation.get('owner', ''),
            'num_comments': len(comments),
            'active_count': active_count,
            'inactive_count': inactive_count,
            'source': 'postgres'
        }
        
        return comments, metadata
    
    except Exception as e:
        logger.error(f"Error fetching conversation from PostgreSQL: {str(e)}")
        import traceback
        logger.error(traceback.format_exc())
        return None, None
    
    finally:
        # Clean up connection
        postgres_client.shutdown()

def process_comments(comments, conversation_id):
    """
    Process comments with embedding and clustering.
    
    Args:
        comments: List of comment dictionaries
        conversation_id: Conversation ID string
        
    Returns:
        document_map: 2D projection of comment embeddings
        document_vectors: Comment embeddings
        cluster_layers: Hierarchy of cluster assignments
        comment_texts: List of comment text strings
        comment_ids: List of comment IDs
    """
    logger.info(f"Processing {len(comments)} comments for conversation {conversation_id}...")
    
    # Extract comment texts and IDs
    comment_texts = [c['txt'] for c in comments if c['txt'] and c['txt'].strip()]
    comment_ids = [c['tid'] for c in comments if c['txt'] and c['txt'].strip()]
    
    # Generate embeddings with SentenceTransformer
    logger.info("Generating embeddings with SentenceTransformer...")
    embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
    document_vectors = embedding_model.encode(comment_texts, show_progress_bar=True)
    
    # Generate 2D projection with UMAP
    logger.info("Generating 2D projection with UMAP...")
    document_map = UMAP(n_components=2, metric='cosine', random_state=42).fit_transform(document_vectors)
    
    # Cluster with EVōC
    logger.info("Clustering with EVōC...")
    try:
        clusterer = evoc.EVoC(min_samples=5)  # Set min_samples to avoid empty clusters
        cluster_labels = clusterer.fit_predict(document_vectors)
        cluster_layers = clusterer.cluster_layers_
        
        logger.info(f"Found {len(np.unique(cluster_labels))} clusters at the finest level")
        for i, layer in enumerate(cluster_layers):
            unique_clusters = np.unique(layer[layer >= 0])
            logger.info(f"Layer {i}: {len(unique_clusters)} clusters")
            
    except Exception as e:
        logger.error(f"Error during EVōC clustering: {e}")
        # Fallback to simple clustering
        from sklearn.cluster import KMeans
        
        logger.info("Falling back to KMeans clustering...")
        kmeans = KMeans(n_clusters=5, random_state=42)
        cluster_labels = kmeans.fit_predict(document_vectors)
        
        # Create a simple layered clustering for demonstration
        from sklearn.cluster import AgglomerativeClustering
        layer1 = AgglomerativeClustering(n_clusters=3).fit_predict(document_vectors)
        layer2 = AgglomerativeClustering(n_clusters=2).fit_predict(document_vectors)
        
        cluster_layers = [cluster_labels, layer1, layer2]
        logger.info(f"Created {len(cluster_layers)} cluster layers with fallback clustering")
    
    return document_map, document_vectors, cluster_layers, comment_texts, comment_ids

def characterize_comment_clusters(cluster_layer, comment_texts):
    """
    Characterize comment clusters by common themes and keywords.
    
    Args:
        cluster_layer: Cluster assignments for a specific layer
        comment_texts: List of comment text strings
        
    Returns:
        cluster_characteristics: Dictionary with cluster characterizations
    """
    # Create a dictionary to store cluster characteristics
    cluster_characteristics = {}
    
    # Get unique clusters
    unique_clusters = np.unique(cluster_layer)
    unique_clusters = unique_clusters[unique_clusters >= 0]  # Remove noise points (-1)
    
    # Create TF-IDF vectorizer
    vectorizer = CountVectorizer(max_features=1000, stop_words='english')
    transformer = TfidfTransformer()
    
    # Fit and transform the entire corpus
    X = vectorizer.fit_transform(comment_texts)
    X_tfidf = transformer.fit_transform(X)
    
    # Get feature names
    feature_names = vectorizer.get_feature_names_out()
    
    for cluster_id in unique_clusters:
        # Get cluster members
        cluster_members = np.where(cluster_layer == cluster_id)[0]
        
        if len(cluster_members) == 0:
            continue
            
        # Get comment texts for this cluster
        cluster_comments = [comment_texts[i] for i in cluster_members]
        
        # Find top words for this cluster by TF-IDF
        cluster_tfidf = X_tfidf[cluster_members].toarray().mean(axis=0)
        top_indices = np.argsort(cluster_tfidf)[-10:][::-1]  # Top 10 words
        top_words = [feature_names[i] for i in top_indices]
        
        # Get sample comments (shortest 3 for readability)
        comment_lengths = [len(comment) for comment in cluster_comments]
        shortest_indices = np.argsort(comment_lengths)[:3]  # 3 shortest comments
        sample_comments = [cluster_comments[i] for i in shortest_indices]
        
        # Add to cluster characteristics
        cluster_characteristics[int(cluster_id)] = {
            'size': len(cluster_members),
            'top_words': top_words,
            'top_tfidf_scores': [float(cluster_tfidf[i]) for i in top_indices],
            'sample_comments': sample_comments
        }
    
    return cluster_characteristics

def generate_cluster_topic_labels(cluster_characteristics, comment_texts=None, layer=None, conversation_name=None, use_ollama=False):
    """
    Generate topic labels for clusters based on their characteristics.
    
    Args:
        cluster_characteristics: Dictionary with cluster characterizations
        comment_texts: List of comment text strings (used for Ollama naming)
        layer: Cluster assignments for the current layer (used for Ollama naming)
        conversation_name: Name of the conversation (used for Ollama naming) 
        use_ollama: Whether to use Ollama for topic naming
        
    Returns:
        cluster_labels: Dictionary mapping cluster IDs to topic labels
    """
    cluster_labels = {}
    
    # Check if we should use Ollama
    if use_ollama and comment_texts is not None and layer is not None:
        try:
            import ollama
            logger.info("Using Ollama for cluster naming")
            
            # Function to get topic labels via Ollama
            def get_topic_name(comments, prompt_prefix=""):
                prompt = f"{prompt_prefix}Read these comments and provide ONLY a short topic label (3-5 words) that captures their essence. Do not include any explanations, introductions, or phrases like 'topic label' in your response. Reply with ONLY the topic label itself in quotes.\n\nComments:\n"
                for j, comment in enumerate(comments[:5]):  # Use first 5 comments as examples
                    prompt += f"{j+1}. {comment}\n"
                
                try:
                    # Get model name from environment variable or use default
                    model_name = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
                    logger.info(f"Using Ollama model from environment: {model_name}")
                    response = ollama.chat(
                        model=model_name,
                        messages=[{"role": "user", "content": prompt}]
                    )
                    
                    # Extract just the topic name with more thorough cleaning
                    raw_response = response['message']['content'].strip()
                    
                    # Clean up various prefixes
                    for prefix in ["Topic label:", "Here is a concise topic label:", "Here's a concise topic label:", 
                                  "Concise topic label:", "Topic:", "Label:"]:
                        if raw_response.startswith(prefix):
                            raw_response = raw_response.replace(prefix, "", 1).strip()
                    
                    # Get just the first line, as we only want the label
                    topic = raw_response.split('\n')[0].strip()
                    
                    # If there are quotes, extract just what's in the quotes
                    if '"' in topic:
                        quoted_parts = topic.split('"')
                        if len(quoted_parts) >= 3:  # Means there's content between quotes
                            topic = quoted_parts[1]
                    
                    # Remove asterisks and other markdown formatting
                    topic = topic.replace('*', '')
                    if len(topic) > 50:  # If it's too long, truncate
                        topic = topic[:50] + "..."
                    return topic
                except Exception as e:
                    logger.error(f"Error generating topic with Ollama: {e}")
                    return f"Topic {cluster_id}"
            
            # Generate labels using Ollama
            for cluster_id in cluster_characteristics.keys():
                if cluster_id < 0:  # Skip noise points
                    continue
                    
                # Get comments for this cluster
                cluster_indices = np.where(layer == cluster_id)[0]
                cluster_comments = [comment_texts[i] for i in cluster_indices]
                
                # Get topic name
                topic_name = get_topic_name(
                    cluster_comments, 
                    prompt_prefix=f"For conversation {conversation_name}: "
                )
                cluster_labels[cluster_id] = topic_name
                
                # Sleep briefly to avoid rate limiting
                time.sleep(0.5)
                
            logger.info(f"Generated {len(cluster_labels)} topic names using Ollama")
            return cluster_labels
            
        except ImportError:
            logger.error("Ollama not installed. Using conventional topic naming.")
            # Fall back to conventional naming
        except Exception as e:
            logger.error(f"Error using Ollama: {e}")
            # Fall back to conventional naming
    
    # Conventional topic naming (fallback or when Ollama is not requested)
    for cluster_id, characteristics in cluster_characteristics.items():
        top_words = characteristics.get('top_words', [])
        sample_comments = characteristics.get('sample_comments', [])
        
        label_parts = []
        
        # Add top words
        if len(top_words) > 0:
            label_parts.append("Keywords: " + ", ".join(top_words[:5]))
        
        # Add first sample comment (shortened)
        if len(sample_comments) > 0:
            first_comment = sample_comments[0]
            if len(first_comment) > 50:
                first_comment = first_comment[:47] + "..."
            label_parts.append("Example: " + first_comment)
        
        # Create the final label
        if label_parts:
            label = " | ".join(label_parts)
            # Truncate if too long
            if len(label) > 50:
                label = label[:47] + "..."
        else:
            label = f"Topic {cluster_id}"
        
        cluster_labels[cluster_id] = label
    
    return cluster_labels

def create_comment_hover_info(cluster_layer, cluster_characteristics, comment_texts):
    """
    Create hover text information for comments based on cluster characteristics.
    
    Args:
        cluster_layer: Cluster assignments for a specific layer
        cluster_characteristics: Dictionary with cluster characterizations
        comment_texts: List of comment text strings
        
    Returns:
        hover_info: List of hover text strings for each comment
    """
    hover_info = []
    for i, (text, cluster_id) in enumerate(zip(comment_texts, cluster_layer)):
        if cluster_id >= 0 and cluster_id in cluster_characteristics:
            characteristics = cluster_characteristics[cluster_id]
            
            # Create hover text with the comment and cluster info
            hover_text = f"{text}\n\n"
            hover_text += f"Cluster {cluster_id} - Size: {characteristics['size']}\n"
            
            # Add top keywords
            if 'top_words' in characteristics:
                hover_text += "Keywords: " + ", ".join(characteristics['top_words'][:5])
        else:
            hover_text = f"{text}\n\nUnclustered"
            
        hover_info.append(hover_text)
    
    return hover_info

def create_basic_layer_visualization(
    output_path,
    file_prefix, 
    data_map, 
    cluster_layer, 
    cluster_characteristics,
    cluster_labels,
    hover_info,
    title,
    sub_title
):
    # Convert any Decimal values in data_map to float
    import decimal
    if isinstance(data_map, np.ndarray) and data_map.size > 0:
        # Check if we have Decimal objects that need conversion
        if isinstance(data_map.flat[0], decimal.Decimal):
            logger.debug("Converting Decimal values in data_map to float")
            data_map = np.array([[float(x) for x in point] for point in data_map], dtype=np.float64)
    """
    Create a basic visualization with numeric topic labels for a specific layer.
    
    Args:
        output_path: Path to save the visualization
        file_prefix: Prefix for the output file
        data_map: 2D coordinates of data points
        cluster_layer: Cluster assignments for a specific layer
        cluster_characteristics: Dictionary with cluster characterizations
        cluster_labels: Dictionary mapping cluster IDs to topic labels
        hover_info: Hover text for each data point
        title: Title for the visualization
        sub_title: Subtitle for the visualization
    
    Returns:
        file_path: Path to the saved visualization
    """
    # Safety check: Ensure data_map is not empty
    if len(data_map) == 0:
        logger.error(f"Cannot create visualization for {file_prefix}: data_map is empty (shape: {data_map.shape})")
        return None
        
    # Safety check: Make sure we have cluster assignments
    if len(cluster_layer) == 0:
        logger.error(f"Cannot create visualization for {file_prefix}: cluster_layer is empty (shape: {cluster_layer.shape})")
        return None
        
    # Safety check: Make sure arrays have matching dimensions
    if len(data_map) != len(cluster_layer):
        logger.error(f"Cannot create visualization for {file_prefix}: data_map length ({len(data_map)}) doesn't match cluster_layer length ({len(cluster_layer)})")
        return None
        
    # Safety check: Make sure we have hover info
    if not hover_info or len(hover_info) == 0:
        logger.warning(f"No hover_info provided for {file_prefix}. Creating default hover text.")
        hover_info = [f"Comment {i}" for i in range(len(data_map))]
        
    # Safety check: Make sure hover_info length matches data_map
    if len(hover_info) != len(data_map):
        logger.warning(f"hover_info length ({len(hover_info)}) doesn't match data_map length ({len(data_map)}). Adjusting...")
        # Adjust hover_info to match data_map length
        if len(hover_info) < len(data_map):
            # Extend hover_info with default values
            hover_info.extend([f"Comment {i+len(hover_info)}" for i in range(len(data_map) - len(hover_info))])
        else:
            # Truncate hover_info
            hover_info = hover_info[:len(data_map)]
    
    # Create labels vector
    # Debug the cluster_labels keys and a sample of cluster_layer values
    logger.debug(f"cluster_labels keys: {list(cluster_labels.keys())[:5]} (type: {type(next(iter(cluster_labels.keys()), None))})")
    sample_clusters = cluster_layer[cluster_layer >= 0][:5] if len(cluster_layer[cluster_layer >= 0]) > 0 else []
    logger.debug(f"Sample cluster_layer values: {sample_clusters} (type: {type(sample_clusters[0]) if len(sample_clusters) > 0 else 'N/A'})")
    
    # Fix: Convert integer keys to strings when looking up in cluster_labels dictionary
    labels_for_viz = np.array([
        cluster_labels.get(str(label), "Unlabelled") if label >= 0 else "Unlabelled"
        for label in cluster_layer
    ])
    
    # Create interactive visualization
    logger.info(f"Creating basic visualization for {file_prefix}...")
    viz_file = os.path.join(output_path, f"{file_prefix}.html")
    
    try:
        logger.debug(f"Visualization input arrays: data_map shape: {data_map.shape}, labels_for_viz shape: {labels_for_viz.shape}, hover_info length: {len(hover_info)}")
        
        # Handle single-label datasets which can cause datamapplot to fail
        if len(np.unique(labels_for_viz)) <= 1:
            logger.warning(f"Only one unique label found. Adding dummy labels to prevent datamapplot errors.")
            
            # Create a modified labels array with artificial variation to prevent errors
            modified_labels = np.array(labels_for_viz)
            
            # Assign a different dummy label to ~5% of points
            num_points = len(modified_labels)
            num_to_change = max(2, int(num_points * 0.05))
            
            # Use evenly distributed indices
            change_indices = np.arange(num_points)[::max(1, num_points//num_to_change)][:num_to_change]
            
            # Change labels for these points
            if all(label == "Unlabelled" for label in modified_labels):
                modified_labels[change_indices] = "Dummy Label"
            else:
                modified_labels[change_indices] = "Unlabelled"
                
            logger.info(f"Modified {num_to_change} labels ({num_to_change/num_points:.1%} of total) to ensure datamapplot works")
            
            # Use the modified labels for visualization
            labels_for_viz = modified_labels
            
        interactive_figure = datamapplot.create_interactive_plot(
            data_map,
            labels_for_viz,
            hover_text=hover_info,
            title=title,
            sub_title=sub_title,
            point_radius_min_pixels=2,
            point_radius_max_pixels=10,
            width="100%",
            height=800
        )
        
        # Save the visualization
        interactive_figure.save(viz_file)
        logger.info(f"Saved basic visualization to {viz_file}")
        return viz_file
    except Exception as e:
        logger.error(f"Error creating basic visualization: {e}")
        # Log more details about the error
        import traceback
        logger.error(f"Detailed error traceback: {traceback.format_exc()}")
        logger.error(f"Input data shapes: data_map: {data_map.shape}, labels_for_viz: {labels_for_viz.shape}, hover_info: {len(hover_info)}")
        return None

def create_named_layer_visualization(
    output_path,
    file_prefix, 
    data_map, 
    cluster_layer, 
    cluster_labels,
    hover_info,
    title,
    sub_title
):
    # Convert any Decimal values in data_map to float
    import decimal
    if isinstance(data_map, np.ndarray) and data_map.size > 0:
        # Check if we have Decimal objects that need conversion
        if isinstance(data_map.flat[0], decimal.Decimal):
            logger.debug("Converting Decimal values in data_map to float")
            data_map = np.array([[float(x) for x in point] for point in data_map], dtype=np.float64)
    """
    Create a named visualization with explicit topic labels for a specific layer.
    
    Args:
        output_path: Path to save the visualization
        file_prefix: Prefix for the output file
        data_map: 2D coordinates of data points
        cluster_layer: Cluster assignments for a specific layer
        cluster_labels: Dictionary mapping cluster IDs to topic labels
        hover_info: Hover text for each data point
        title: Title for the visualization
        sub_title: Subtitle for the visualization
    
    Returns:
        file_path: Path to the saved visualization
    """
    # Safety check: Ensure data_map is not empty
    if len(data_map) == 0:
        logger.error(f"Cannot create visualization for {file_prefix}: data_map is empty (shape: {data_map.shape})")
        return None
        
    # Safety check: Make sure we have cluster assignments
    if len(cluster_layer) == 0:
        logger.error(f"Cannot create visualization for {file_prefix}: cluster_layer is empty (shape: {cluster_layer.shape})")
        return None
        
    # Safety check: Make sure arrays have matching dimensions
    if len(data_map) != len(cluster_layer):
        logger.error(f"Cannot create visualization for {file_prefix}: data_map length ({len(data_map)}) doesn't match cluster_layer length ({len(cluster_layer)})")
        return None
        
    # Safety check: Make sure we have hover info
    if not hover_info or len(hover_info) == 0:
        logger.warning(f"No hover_info provided for {file_prefix}. Creating default hover text.")
        hover_info = [f"Comment {i}" for i in range(len(data_map))]
        
    # Safety check: Make sure hover_info length matches data_map
    if len(hover_info) != len(data_map):
        logger.warning(f"hover_info length ({len(hover_info)}) doesn't match data_map length ({len(data_map)}). Adjusting...")
        # Adjust hover_info to match data_map length
        if len(hover_info) < len(data_map):
            # Extend hover_info with default values
            hover_info.extend([f"Comment {i+len(hover_info)}" for i in range(len(data_map) - len(hover_info))])
        else:
            # Truncate hover_info
            hover_info = hover_info[:len(data_map)]
    
    # Create labels vector
    # Debug the cluster_labels keys and a sample of cluster_layer values
    logger.debug(f"cluster_labels keys: {list(cluster_labels.keys())[:5]} (type: {type(next(iter(cluster_labels.keys()), None))})")
    sample_clusters = cluster_layer[cluster_layer >= 0][:5] if len(cluster_layer[cluster_layer >= 0]) > 0 else []
    logger.debug(f"Sample cluster_layer values: {sample_clusters} (type: {type(sample_clusters[0]) if len(sample_clusters) > 0 else 'N/A'})")
    
    # Fix: Convert integer keys to strings when looking up in cluster_labels dictionary
    labels_for_viz = np.array([
        cluster_labels.get(str(label), "Unlabelled") if label >= 0 else "Unlabelled"
        for label in cluster_layer
    ])
    
    # Create interactive visualization
    logger.info(f"Creating named visualization for {file_prefix}...")
    viz_file = os.path.join(output_path, f"{file_prefix}.html")
    
    try:
        logger.debug(f"Visualization input arrays: data_map shape: {data_map.shape}, labels_for_viz shape: {labels_for_viz.shape}, hover_info length: {len(hover_info)}")
        
        # Handle single-label datasets which can cause datamapplot to fail
        if len(np.unique(labels_for_viz)) <= 1:
            logger.warning(f"Only one unique label found. Adding dummy labels to prevent datamapplot errors.")
            
            # Create a modified labels array with artificial variation to prevent errors
            modified_labels = np.array(labels_for_viz)
            
            # Assign a different dummy label to ~5% of points
            num_points = len(modified_labels)
            num_to_change = max(2, int(num_points * 0.05))
            
            # Use evenly distributed indices
            change_indices = np.arange(num_points)[::max(1, num_points//num_to_change)][:num_to_change]
            
            # Change labels for these points
            if all(label == "Unlabelled" for label in modified_labels):
                modified_labels[change_indices] = "Dummy Label"
            else:
                modified_labels[change_indices] = "Unlabelled"
                
            logger.info(f"Modified {num_to_change} labels ({num_to_change/num_points:.1%} of total) to ensure datamapplot works")
            
            # Use the modified labels for visualization
            labels_for_viz = modified_labels
            
        interactive_figure = datamapplot.create_interactive_plot(
            data_map,
            labels_for_viz,
            hover_text=hover_info,
            title=title,
            sub_title=sub_title,
            point_radius_min_pixels=2,
            point_radius_max_pixels=10,
            width="100%",
            height=800
        )
        
        # Save the visualization
        interactive_figure.save(viz_file)
        logger.info(f"Saved named visualization to {viz_file}")
        return viz_file
    except Exception as e:
        logger.error(f"Error creating named visualization: {e}")
        # Log more details about the error
        import traceback
        logger.error(f"Detailed error traceback: {traceback.format_exc()}")
        logger.error(f"Input data shapes: data_map: {data_map.shape}, labels_for_viz: {labels_for_viz.shape}, hover_info: {len(hover_info)}")
        return None

def process_layers_and_store_characteristics(
    conversation_id,
    cluster_layers,
    comment_texts,
    output_dir=None,
    dynamo_storage=None
):
    """
    Process layers and store cluster characteristics and enhanced topic names in DynamoDB.
    
    Args:
        conversation_id: Conversation ID string
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Optional directory to save visualization data as JSON
        dynamo_storage: Optional DynamoDBStorage object for storing in DynamoDB
        
    Returns:
        Dictionary with layer data including characteristics and enhanced topic names
    """
    layer_data = {}
    
    for layer_idx, cluster_layer in enumerate(cluster_layers):
        logger.info(f"Processing layer {layer_idx} with {len(np.unique(cluster_layer[cluster_layer >= 0]))} clusters...")
        
        # Generate cluster characteristics
        cluster_characteristics = characterize_comment_clusters(
            cluster_layer, comment_texts
        )
        
        # Create basic numeric topic names
        numeric_labels = {str(i): f"Topic {i}" for i in np.unique(cluster_layer[cluster_layer >= 0])}
        
        # Store layer data
        layer_data[layer_idx] = {
            'characteristics': cluster_characteristics,
            'numeric_topic_names': numeric_labels
        }
        
        # Save data to files if output directory provided
        if output_dir:
            # Save cluster characteristics
            with open(os.path.join(output_dir, f"{conversation_id}_comment_layer_{layer_idx}_characteristics.json"), 'w') as f:
                json_compatible = json.dumps(cluster_characteristics, default=lambda x: float(x) if isinstance(x, np.float32) else x)
                f.write(json_compatible)
            
            # Save numeric topic names
            with open(os.path.join(output_dir, f"{conversation_id}_layer_{layer_idx}_topic_names.json"), 'w') as f:
                json.dump(numeric_labels, f, indent=2)
        
        # Store in DynamoDB if provided
        if dynamo_storage:
            # Convert and store cluster characteristics
            logger.info(f"Storing cluster characteristics for layer {layer_idx} in DynamoDB...")
            characteristic_models = DataConverter.batch_convert_cluster_characteristics(
                conversation_id,
                cluster_characteristics,
                layer_idx
            )
            result = dynamo_storage.batch_create_cluster_characteristics(characteristic_models)
            logger.info(f"Stored {result['success']} cluster characteristics with {result['failure']} failures")
    
    logger.info(f"Processing of layers and storing characteristics complete!")
    return layer_data


def create_static_datamapplot(
    conversation_id,
    document_map,
    cluster_layer,
    cluster_labels,
    output_dir,
    layer_num=0
):
    # Convert any Decimal values in document_map to float
    import decimal
    if isinstance(document_map, np.ndarray) and document_map.size > 0:
        # Check if we have Decimal objects that need conversion
        if isinstance(document_map.flat[0], decimal.Decimal):
            logger.debug("Converting Decimal values in document_map to float for static datamapplot")
            document_map = np.array([[float(x) for x in point] for point in document_map], dtype=np.float64)
    """
    Generate static datamapplot visualizations for a layer.
    
    Args:
        conversation_id: Conversation ID string
        document_map: 2D coordinates for visualization
        cluster_layer: Cluster assignments for this layer
        cluster_labels: Dictionary mapping cluster IDs to topic names
        output_dir: Directory to save visualizations
        layer_num: Layer number (default 0)
        
    Returns:
        Boolean indicating success
    """
    logger.info(f"Generating static datamapplot for conversation {conversation_id}, layer {layer_num}")
    
    try:
        # Create visualization directory if it doesn't exist
        # Default location in the project structure
        vis_dir = os.path.join("visualizations", str(conversation_id))
        os.makedirs(vis_dir, exist_ok=True)
        
        # Also ensure the output directory exists in the pipeline's structure
        # This is typically polis_data/zid/python_output/comments_enhanced_multilayer
        os.makedirs(output_dir, exist_ok=True)
        
        # Prepare label strings with topic names
        def clean_topic_name(name):
            # Remove asterisks from topic names (e.g., "**Topic Name**" becomes "Topic Name")
            if isinstance(name, str):
                return name.replace('*', '')
            return name
            
        # Create labels vector
        label_strings = np.array([
            clean_topic_name(cluster_labels.get(label, f"Topic {label}")) if label >= 0 else "Unclustered"
            for label in cluster_layer
        ])
        
        # Check if we have enough unique labels to create a meaningful visualization
        unique_labels = set(cluster_layer)
        unique_non_noise = [label for label in unique_labels if label >= 0]
        
        if len(unique_non_noise) == 0:
            logger.warning(f"Layer {layer_num} has no clusters (only noise). Skipping visualization.")
            return False
        
        if len(unique_non_noise) == 1:
            logger.warning(f"Layer {layer_num} has only one cluster. Using simplified visualization settings.")
            # For single-cluster visualizations, turn off dynamic sizing to avoid array indexing issues
            use_dynamic_size = False
        else:
            use_dynamic_size = True
        
        # Generate the static plot - it returns (fig, ax) tuple
        fig, ax = datamapplot.create_plot(
            document_map,
            label_strings,
            title=f"Conversation {conversation_id} - Layer {layer_num}",
            label_over_points=True,           # Place labels directly over the point clusters
            dynamic_label_size=use_dynamic_size,  # Vary label size based on cluster size if we have multiple clusters
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
        
        # Save to both locations: default visualizations directory and pipeline output
        
        # 1. Save to visualizations directory
        # Regular PNG
        static_png = os.path.join(vis_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_static.png")
        fig.savefig(static_png, dpi=300, bbox_inches='tight')
        logger.info(f"Saved static PNG to {static_png}")
        
        # High resolution PNG for presentations
        presentation_png = os.path.join(vis_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_presentation.png")
        fig.savefig(presentation_png, dpi=600, bbox_inches='tight')
        logger.info(f"Saved high-resolution PNG to {presentation_png}")
        
        # SVG for vector graphics
        svg_file = os.path.join(vis_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_static.svg")
        fig.savefig(svg_file, format='svg', bbox_inches='tight')
        logger.info(f"Saved vector SVG to {svg_file}")
        
        # 2. Save the same files to the pipeline output directory
        if output_dir != vis_dir:
            # Regular PNG
            output_static_png = os.path.join(output_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_static.png")
            fig.savefig(output_static_png, dpi=300, bbox_inches='tight')
            logger.info(f"Saved static PNG to pipeline output: {output_static_png}")
            
            # High resolution PNG for presentations
            output_presentation_png = os.path.join(output_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_presentation.png")
            fig.savefig(output_presentation_png, dpi=600, bbox_inches='tight')
            logger.info(f"Saved high-resolution PNG to pipeline output: {output_presentation_png}")
            
            # SVG for vector graphics
            output_svg_file = os.path.join(output_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_static.svg")
            fig.savefig(output_svg_file, format='svg', bbox_inches='tight')
            logger.info(f"Saved vector SVG to pipeline output: {output_svg_file}")
        
        return True
        
    except Exception as e:
        logger.error(f"Error generating static datamapplot: {str(e)}")
        logger.error(traceback.format_exc())
        return False

def create_visualizations(
    conversation_id,
    conversation_name,
    document_map,
    cluster_layers,
    comment_texts,
    output_dir,
    layer_data=None
):
    """
    Create visualizations based on processed layer data.
    
    Args:
        conversation_id: Conversation ID string
        conversation_name: Name of the conversation
        document_map: 2D coordinates for visualization
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Directory to save visualizations
        layer_data: Optional dictionary with layer data including characteristics and enhanced topic names
        
    Returns:
        The path to the index file
    """
    # Safety check: Make sure document_map is not empty
    if len(document_map) == 0:
        logger.error(f"Cannot create visualizations: document_map is empty. Generating synthetic data for visualization...")
        # Generate synthetic data for visualization
        num_comments = len(comment_texts)
        if num_comments > 0:
            # Create synthetic random 2D positions
            np.random.seed(42)  # For reproducibility
            document_map = np.random.rand(num_comments, 2) * 10  # Scale up for visibility
            logger.info(f"Generated synthetic document_map with shape: {document_map.shape}")
        else:
            logger.error(f"Cannot create visualizations: no comments available.")
            return None
    
    # If layer_data not provided, generate it
    if layer_data is None:
        logger.info("Layer data not provided, generating it...")
        layer_data = {}
        for layer_idx, cluster_layer in enumerate(cluster_layers):
            # Generate cluster characteristics
            characteristics = characterize_comment_clusters(
                cluster_layer, comment_texts
            )
            
            # Create basic numeric topic names
            numeric_labels = {i: f"Topic {i}" for i in np.unique(cluster_layer[cluster_layer >= 0])}
            
            layer_data[layer_idx] = {
                'characteristics': characteristics,
                'numeric_topic_names': numeric_labels
            }
    
    # Create visualizations
    layer_files = []
    layer_info = []
    
    for layer_idx, cluster_layer in enumerate(cluster_layers):
        if layer_idx not in layer_data:
            logger.warning(f"No layer data for layer {layer_idx}, skipping visualization...")
            continue
            
        # Get characteristics and numeric topic names
        characteristics = layer_data[layer_idx]['characteristics']
        numeric_topic_names = layer_data[layer_idx]['numeric_topic_names']
        
        # Create hover information
        hover_info = create_comment_hover_info(
            cluster_layer, characteristics, comment_texts
        )
        
        # Calculate number of unique clusters (excluding noise)
        unique_non_noise = len(np.unique(cluster_layer[cluster_layer >= 0]))
        logger.info(f"Layer {layer_idx} has {unique_non_noise} unique clusters (excluding noise)")
        
        # Additional safety check: Ensure arrays have matching dimensions
        if len(document_map) != len(cluster_layer):
            logger.warning(f"Document map length ({len(document_map)}) doesn't match cluster layer length ({len(cluster_layer)}). Adjusting...")
            if len(document_map) > len(cluster_layer):
                # Truncate document_map to match cluster_layer
                document_map = document_map[:len(cluster_layer)]
                logger.info(f"Truncated document_map to shape {document_map.shape}")
            else:
                # Truncate cluster_layer to match document_map
                cluster_layer = cluster_layer[:len(document_map)]
                logger.info(f"Truncated cluster_layer to length {len(cluster_layer)}")
                # Recalculate unique_non_noise after truncation
                unique_non_noise = len(np.unique(cluster_layer[cluster_layer >= 0]))
                logger.info(f"After truncation, layer {layer_idx} has {unique_non_noise} unique clusters")
        
        # Create basic visualization - skip if no clusters
        if unique_non_noise == 0:
            logger.warning(f"Layer {layer_idx} has no clusters (only noise). Skipping basic visualization.")
            basic_file = None
        else:
            try:
                logger.info(f"Creating basic visualization for {conversation_id}_comment_layer_{layer_idx}_basic...")
                basic_file = create_basic_layer_visualization(
                    output_dir,
                    f"{conversation_id}_comment_layer_{layer_idx}_basic",
                    document_map,
                    cluster_layer,
                    characteristics,
                    numeric_topic_names,
                    hover_info,
                    f"{conversation_name} Comment Layer {layer_idx} - {unique_non_noise} topics",
                    f"Comment topics with numeric labels"
                )
            except Exception as e:
                logger.error(f"Error creating basic visualization: {str(e)}")
                import traceback
                logger.error(f"Detailed error traceback: {traceback.format_exc()}")
                logger.error(f"Input data shapes: document_map: {document_map.shape}, cluster_layer: {cluster_layer.shape}, hover_info: {len(hover_info)}")
                basic_file = None
        
        # Create named visualization with just numeric topic names for now
        # (LLM names will be added in a separate step later)
        if unique_non_noise == 0:
            logger.warning(f"Layer {layer_idx} has no clusters (only noise). Skipping named visualization.")
            named_file = None
        else:
            try:
                logger.info(f"Creating named visualization for {conversation_id}_comment_layer_{layer_idx}_named...")
                named_file = create_named_layer_visualization(
                    output_dir,
                    f"{conversation_id}_comment_layer_{layer_idx}_named",
                    document_map,
                    cluster_layer,
                    numeric_topic_names,
                    hover_info,
                    f"{conversation_name} Comment Layer {layer_idx} - {unique_non_noise} topics",
                    f"Comment topics (to be updated with LLM topic names)"
                )
            except Exception as e:
                logger.error(f"Error creating named visualization: {str(e)}")
                import traceback
                logger.error(f"Detailed error traceback: {traceback.format_exc()}")
                logger.error(f"Input data shapes: document_map: {document_map.shape}, cluster_layer: {cluster_layer.shape}, hover_info: {len(hover_info)}")
                named_file = None
        
        # Generate static datamapplot visualizations
        # Skip if layer has too few unique clusters (excluding noise)
        unique_non_noise = len(np.unique(cluster_layer[cluster_layer >= 0]))
        if unique_non_noise == 0:
            logger.warning(f"Layer {layer_idx} has no clusters (only noise). Skipping static datamapplot.")
        else:
            logger.info(f"Generating static datamapplot for layer {layer_idx} with {unique_non_noise} unique clusters...")
            success = create_static_datamapplot(
                conversation_id,
                document_map,
                cluster_layer,
                numeric_topic_names,
                output_dir,
                layer_idx
            )
            if not success:
                logger.warning(f"Failed to create static datamapplot for layer {layer_idx}")
        
        # Generate consensus/divisive visualization 
        try:
            logger.info(f"Generating consensus/divisive visualization for layer {layer_idx}...")
            # Use subprocess to run as a separate process to avoid any memory leaks
            import subprocess
            script_path = os.path.join(os.path.dirname(__file__), "702_consensus_divisive_datamapplot.py")
            command = [
                "python", script_path, 
                "--zid", str(conversation_id),
                "--layer", str(layer_idx), 
                "--output_dir", output_dir
            ]
            
            # Run the script with appropriate environment variables
            env = os.environ.copy()
            process = subprocess.Popen(
                command,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True
            )
            stdout, stderr = process.communicate()
            
            if process.returncode != 0:
                logger.warning(f"Consensus/divisive visualization failed: {stderr}")
            else:
                logger.info(f"Consensus/divisive visualization for layer {layer_idx} completed successfully")
                
        except Exception as e:
            logger.warning(f"Error running consensus/divisive visualization: {e}")
        
        # Add to list of layer files and info
        if named_file:
            layer_files.append(named_file)
            layer_info.append((layer_idx, len(np.unique(cluster_layer[cluster_layer >= 0]))))
    
    # Create index file
    index_file = create_enhanced_multilayer_index(
        output_dir,
        conversation_id,
        layer_files,
        layer_info
    )
    
    logger.info(f"Visualization creation complete!")
    logger.info(f"Index file available at: {index_file}")
    
    # Try to open in browser
    try:
        import webbrowser
        webbrowser.open(f"file://{index_file}")
    except:
        pass
        
    return index_file


def process_layers_and_create_visualizations(
    conversation_id,
    conversation_name,
    document_map,
    cluster_layers,
    comment_texts,
    output_dir,
    use_ollama=False,
    dynamo_storage=None
):
    """
    Process layers, store data, and create visualizations.
    
    Args:
        conversation_id: Conversation ID string
        conversation_name: Name of the conversation
        document_map: 2D coordinates for visualization
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Directory to save visualizations
        use_ollama: Whether to use Ollama for topic naming (deprecated, will be moved to separate script)
        dynamo_storage: Optional DynamoDBStorage object for storing in DynamoDB
    """
    # Process layers and store characteristics
    layer_data = process_layers_and_store_characteristics(
        conversation_id,
        cluster_layers,
        comment_texts,
        output_dir=output_dir,
        dynamo_storage=dynamo_storage
    )
    
    # Create visualizations with basic numeric labels
    index_file = create_visualizations(
        conversation_id,
        conversation_name,
        document_map,
        cluster_layers,
        comment_texts,
        output_dir,
        layer_data=layer_data
    )
    
    # If Ollama is requested, warn that this is deprecated
    if use_ollama:
        logger.warning(
            "Ollama topic naming is moving to a separate process to improve reliability. "
            "Use the new update_with_ollama.py script to update topic names with LLM after processing."
        )
        
        # For backward compatibility, still run with Ollama if requested
        for layer_idx, cluster_layer in enumerate(cluster_layers):
            characteristics = layer_data[layer_idx]['characteristics']
            
            # Generate topic labels with Ollama
            logger.info(f"Generating LLM topic names for layer {layer_idx} with Ollama...")
            cluster_labels = generate_cluster_topic_labels(
                characteristics,
                comment_texts=comment_texts,
                layer=cluster_layer,
                conversation_name=conversation_name,
                use_ollama=True
            )
            
            # Save LLM topic names
            with open(os.path.join(output_dir, f"{conversation_id}_comment_layer_{layer_idx}_labels.json"), 'w') as f:
                json.dump(cluster_labels, f, indent=2)
            
            # Store in DynamoDB if provided
            if dynamo_storage:
                logger.info(f"Storing LLM topic names for layer {layer_idx} in DynamoDB...")
                # Get model name from environment variable or use default
                model_name = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
                llm_topic_models = DataConverter.batch_convert_llm_topic_names(
                    conversation_id,
                    cluster_labels,
                    layer_idx,
                    model_name=model_name  # Model used by Ollama
                )
                result = dynamo_storage.batch_create_llm_topic_names(llm_topic_models)
                logger.info(f"Stored {result['success']} LLM topic names with {result['failure']} failures")
                
            # Create a new static datamapplot with the LLM labels
            logger.info(f"Generating static datamapplot with LLM labels for layer {layer_idx}...")
            create_static_datamapplot(
                conversation_id,
                document_map,
                cluster_layer,
                cluster_labels,
                output_dir,
                layer_idx
            )
    
    return index_file

def create_enhanced_multilayer_index(
    output_path,
    conversation_name,
    layer_files,
    layer_info
):
    """
    Create an index HTML file linking to all enhanced layer visualizations.
    
    Args:
        output_path: Path to save the index file
        conversation_name: Name of the conversation
        layer_files: List of paths to layer visualization files
        layer_info: List of tuples (layer_idx, num_clusters) for each layer
    
    Returns:
        file_path: Path to the saved index file
    """
    index_file = os.path.join(output_path, f"{conversation_name}_comment_enhanced_index.html")
    
    with open(index_file, 'w') as f:
        f.write(f"""<!DOCTYPE html>
<html>
<head>
    <title>{conversation_name} - Enhanced Multi-layer Comment Visualization</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 20px; }}
        h1 {{ color: #333; }}
        .layer-container {{ margin-bottom: 30px; }}
        .description {{ margin-bottom: 10px; }}
        iframe {{ border: 1px solid #ddd; width: 100%; height: 600px; }}
        .button-container {{ margin-bottom: 10px; }}
        .button {{
            background-color: #4CAF50;
            border: none;
            color: white;
            padding: 10px 20px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 16px;
            margin: 4px 2px;
            cursor: pointer;
            border-radius: 4px;
        }}
        .view-options {{
            margin: 10px 0;
            display: flex;
            gap: 10px;
        }}
        .view-link {{
            padding: 5px 10px;
            background-color: #f0f0f0;
            color: #333;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
        }}
        .view-link:hover {{
            background-color: #e0e0e0;
        }}
        .active {{
            background-color: #007BFF;
            color: white;
        }}
        .static-downloads {{
            margin: 10px 0;
            padding: 10px;
            background-color: #f8f9fa;
            border-radius: 4px;
            border: 1px solid #e9ecef;
        }}
        .static-downloads h3 {{
            margin-top: 0;
            font-size: 16px;
        }}
        .static-downloads a {{
            display: inline-block;
            margin-right: 15px;
            color: #0066cc;
            text-decoration: none;
        }}
        .static-downloads a:hover {{
            text-decoration: underline;
        }}
    </style>
</head>
<body>
    <h1>{conversation_name} - Enhanced Multi-layer Comment Visualization</h1>
    <p>This page provides access to different layers of clustering granularity with topic labeling:</p>
    
    <div class="button-container">
        <button class="button" onclick="window.location.reload();">Refresh Page</button>
    </div>
""")
        
        # Add links to each layer
        for (layer_idx, num_clusters), file_path in zip(layer_info, layer_files):
            file_name = os.path.basename(file_path)
            basic_view_file = file_name.replace("_named.html", "_enhanced.html")
            named_view_file = file_name
            
            # Static file references
            static_png = f"{conversation_name}_layer_{layer_idx}_datamapplot_static.png"
            presentation_png = f"{conversation_name}_layer_{layer_idx}_datamapplot_presentation.png"
            static_svg = f"{conversation_name}_layer_{layer_idx}_datamapplot_static.svg"
            
            # Consensus/divisive visualization references
            consensus_png = f"{conversation_name}_consensus_divisive_colored_map.png"
            consensus_enhanced = f"{conversation_name}_consensus_divisive_enhanced.png"
            
            description = "Fine-grained grouping" if layer_idx == 0 else "Coarser grouping" if layer_idx == len(layer_info) - 1 else "Medium granularity"
            
            f.write(f"""
    <div class="layer-container">
        <h2>Layer {layer_idx}</h2>
        <p class="description">{description} with topic labels</p>
        <div class="view-options">
            <a href="{basic_view_file}" class="view-link " target="_blank">Basic View</a>
            <a href="{named_view_file}" class="view-link active" target="_blank">Named View (LLM-labeled)</a>
        </div>
        
        <div class="static-downloads">
            <h3>Static Visualizations:</h3>
            <a href="{static_png}" target="_blank">Standard PNG</a>
            <a href="{presentation_png}" target="_blank">Presentation PNG (HiRes)</a>
            <a href="{static_svg}" target="_blank">Vector SVG</a>
        </div>
        
        <div class="static-downloads">
            <h3>Consensus/Divisive Visualizations:</h3>
            <a href="{consensus_png}" target="_blank">Consensus Map</a>
            <a href="{consensus_enhanced}" target="_blank">Enhanced Consensus Map</a>
            <p><strong>Color legend:</strong> Green = Consensus Comments, Yellow = Mixed Opinions, Red = Divisive Comments</p>
        </div>
        
        <iframe src="{named_view_file}"></iframe>
    </div>
""")
        
        f.write("""
</body>
</html>
""")
    
    logger.info(f"Created enhanced multi-layer index at {index_file}")
    return index_file


def load_processed_data_from_dynamo(dynamo_storage, conversation_id, math_tick=None, skip_postgres=False, postgres_for_comments_only=True):
    """
    Load pre-processed embeddings and cluster assignments from DynamoDB.
    
    This allows the UMAP pipeline to skip expensive computation steps when data
    is already available from the math pipeline.
    
    Args:
        dynamo_storage: DynamoDB storage instance
        conversation_id: Conversation ID
        math_tick: Optional math tick to use for retrieving from specific version
        skip_postgres: Whether to skip PostgreSQL entirely
        postgres_for_comments_only: If True, still try to get comment texts from PostgreSQL even if skip_postgres is True
        
    Returns:
        None if data not found or error occurs, otherwise a dictionary with:
        - document_vectors: Comment embeddings
        - document_map: 2D UMAP projection
        - cluster_layers: Hierarchy of cluster assignments
        - comment_texts: List of comment text strings  
        - comment_ids: List of comment IDs
    """
    logger.info(f"Attempting to load pre-processed data for conversation {conversation_id} from DynamoDB")
    
    try:
        # First check if we have a PCA configuration in the math pipeline output
        pca_config_table = dynamo_storage.dynamodb.Table('Delphi_PCAConversationConfig')
        config_response = pca_config_table.get_item(Key={'zid': str(conversation_id)})
        
        if 'Item' not in config_response:
            logger.warning(f"No PCA configuration found for conversation {conversation_id}")
            return None
            
        pca_config = config_response['Item']
        
        # Get the math tick to use
        if math_tick is None:
            math_tick = pca_config.get('latest_math_tick')
            if not math_tick:
                logger.warning(f"No math tick found in PCA config for conversation {conversation_id}")
                return None
        
        logger.info(f"Using math tick {math_tick} for conversation {conversation_id}")
        zid_tick = f"{conversation_id}:{math_tick}"
        
        # Check if we have UMAP data already
        try:
            umap_config_table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['conversation_meta'])
            umap_config_response = umap_config_table.get_item(Key={'conversation_id': str(conversation_id)})
            
            if 'Item' in umap_config_response:
                logger.info(f"Found existing UMAP data for conversation {conversation_id}")
                
                # Now try to load all the components we need
                
                # 1. Load all comment embeddings
                embedding_table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['comment_embeddings'])
                response = embedding_table.query(
                    KeyConditionExpression=Key('conversation_id').eq(str(conversation_id))
                )
                
                comment_embeddings = response.get('Items', [])
                # Handle pagination if needed
                while 'LastEvaluatedKey' in response:
                    response = embedding_table.query(
                        KeyConditionExpression=Key('conversation_id').eq(str(conversation_id)),
                        ExclusiveStartKey=response['LastEvaluatedKey']
                    )
                    comment_embeddings.extend(response.get('Items', []))
                
                if not comment_embeddings:
                    logger.warning(f"No comment embeddings found for conversation {conversation_id}")
                    return None
                
                logger.info(f"Found {len(comment_embeddings)} comment embeddings")
                
                # 2. Get comment cluster assignments
                cluster_table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['comment_clusters'])
                response = cluster_table.query(
                    KeyConditionExpression=Key('conversation_id').eq(str(conversation_id))
                )
                
                comment_clusters = response.get('Items', [])
                # Handle pagination if needed
                while 'LastEvaluatedKey' in response:
                    response = cluster_table.query(
                        KeyConditionExpression=Key('conversation_id').eq(str(conversation_id)),
                        ExclusiveStartKey=response['LastEvaluatedKey']
                    )
                    comment_clusters.extend(response.get('Items', []))
                
                if not comment_clusters:
                    logger.warning(f"No comment clusters found for conversation {conversation_id}")
                    return None
                
                logger.info(f"Found {len(comment_clusters)} comment cluster assignments")
                
                # Get list of comment IDs and order
                comment_ids = []
                comment_texts = []
                
                # Sort the embeddings by comment_id
                comment_embeddings.sort(key=lambda x: int(x.get('comment_id', 0)))
                
                # Extract embeddings as numpy array
                document_vectors = []
                document_map = []
                
                # Get comment texts from PostgreSQL or create placeholders
                # Always try to get texts from PostgreSQL unless explicitly disabled with skip_postgres=True
                # and postgres_for_comments_only=False
                try:
                    if skip_postgres and not postgres_for_comments_only:
                        logger.warning("PostgreSQL lookup for comment texts is disabled, using placeholders")
                        # Create text placeholders with IDs from the extracted comment_ids
                        # First populate comment_ids from embeddings to ensure we have them
                        comment_ids = [str(emb.get('comment_id', '')) for emb in comment_embeddings]
                        all_comments = [{'tid': cid, 'txt': f"Comment {cid} (text unavailable)"} 
                                      for cid in comment_ids]
                    else:
                        if skip_postgres and postgres_for_comments_only:
                            logger.info("Getting comment texts from PostgreSQL (postgres_for_comments_only=True overrides skip_postgres)")
                        else:
                            logger.info("Getting comment texts from PostgreSQL")
                        postgres_client = PostgresClient()
                        postgres_client.initialize()
                        all_comments = postgres_client.get_comments_by_conversation(int(conversation_id))
                        postgres_client.shutdown()
                except Exception as e:
                    logger.warning(f"Failed to get comment texts from PostgreSQL: {e}, using placeholders")
                    # Fall back to placeholders if PostgreSQL access fails
                    comment_ids = [str(emb.get('comment_id', '')) for emb in comment_embeddings]
                    all_comments = [{'tid': cid, 'txt': f"Comment {cid} (text unavailable)"} 
                                  for cid in comment_ids]
                
                # Create a mapping of comment IDs to texts
                comment_id_to_text = {str(c['tid']): c['txt'] for c in all_comments}
                
                # Clear existing arrays before building
                comment_ids = []
                comment_texts = []
                document_vectors = []
                document_map = []
                
                # Log the number of embeddings and matching comments
                logger.info(f"Total embeddings: {len(comment_embeddings)}")
                logger.info(f"Available comment texts: {len(comment_id_to_text)}")
                
                # Track matched and missing comments
                matched_count = 0
                missing_texts = []
                missing_embeddings = []
                
                # Build the ordered lists and arrays
                for embedding in comment_embeddings:
                    comment_id = str(embedding.get('comment_id'))
                    
                    # Track comments with missing text
                    if comment_id not in comment_id_to_text:
                        missing_texts.append(comment_id)
                        continue
                        
                    # Successfully matched comment
                    matched_count += 1
                    
                    # Add to ordered lists
                    comment_ids.append(comment_id)
                    comment_texts.append(comment_id_to_text[comment_id])
                    
                    # Check for vector in embedding
                    has_vector = False
                    
                    # Add to vectors
                    # Check for embedding vector in different formats
                    if 'embedding_vector' in embedding:
                        # Direct vector field (older format)
                        embed_vector = embedding['embedding_vector']
                        if isinstance(embed_vector, str):
                            embed_vector = [float(x) for x in embed_vector.split(',')]
                        document_vectors.append(embed_vector)
                        has_vector = True
                    elif 'embedding' in embedding:
                        # Nested embedding object (newer format)
                        embed_obj = embedding['embedding']
                        if isinstance(embed_obj, dict) and 'vector' in embed_obj:
                            # Get vector from nested object
                            embed_vector = embed_obj['vector']
                            if isinstance(embed_vector, str):
                                embed_vector = [float(x) for x in embed_vector.split(',')]
                            document_vectors.append(embed_vector)
                            has_vector = True
                    
                    # Track comments with missing embeddings
                    if not has_vector:
                        missing_embeddings.append(comment_id)
                    
                    # Add to 2D mapping (check in both the dedicated field and legacy formats)
                    
                    # First try the dedicated field format (if this is a Pydantic model)
                    # Detailed debug logging temporarily removed for production use
                    
                    if hasattr(embedding, 'umap_coordinates') and embedding.umap_coordinates is not None:
                        coords = embedding.umap_coordinates
                        if hasattr(coords, 'x') and hasattr(coords, 'y'):
                            document_map.append([coords.x, coords.y])
                    # Then try legacy dictionary formats
                    elif isinstance(embedding, dict):
                        # Try direct umap_coordinates field
                        if 'umap_coordinates' in embedding:
                            coords = embedding['umap_coordinates']
                            if isinstance(coords, list) and len(coords) == 2:
                                document_map.append(coords)
                            elif isinstance(coords, dict) and 'x' in coords and 'y' in coords:
                                document_map.append([coords['x'], coords['y']])
                        # Try position field (alternative location)
                        elif 'position' in embedding:
                            pos = embedding['position']
                            if isinstance(pos, dict) and 'x' in pos and 'y' in pos:
                                document_map.append([pos['x'], pos['y']])
                        # Try embedded umap_coordinates within embedding structure
                        elif 'embedding' in embedding and isinstance(embedding['embedding'], dict):
                            embed_obj = embedding['embedding']
                            if 'umap_coordinates' in embed_obj:
                                embed_coords = embed_obj['umap_coordinates']
                                if isinstance(embed_coords, list) and len(embed_coords) == 2:
                                    document_map.append(embed_coords)
                                elif isinstance(embed_coords, dict) and 'x' in embed_coords and 'y' in embed_coords:
                                    document_map.append([embed_coords['x'], embed_coords['y']])
                
                # Log match statistics
                logger.info(f"Successfully matched {matched_count} comments between PostgreSQL and DynamoDB")
                if missing_texts:
                    logger.warning(f"Found {len(missing_texts)} comments with embeddings but missing text")
                    logger.warning(f"Example missing comment IDs: {missing_texts[:5]}")
                if missing_embeddings:
                    logger.warning(f"Found {len(missing_embeddings)} comments with text but missing embedding vectors")
                    logger.warning(f"Example missing embedding IDs: {missing_embeddings[:5]}")
                
                # Convert to numpy arrays
                document_vectors = np.array(document_vectors)
                document_map = np.array(document_map)
                
                # Print debug information about array shapes
                logger.info(f"After conversion - document_vectors shape: {document_vectors.shape}")
                logger.info(f"After conversion - document_map shape: {document_map.shape}")
                
                # Basic info about extracted data
                if len(document_map) == 0 and len(document_vectors) > 0:
                    logger.warning("UMAP coordinates are missing in DynamoDB")
                
                # If both document_vectors and document_map are empty, we need to create synthetic data
                if len(document_vectors) == 0 and len(comment_texts) > 0:
                    logger.warning(f"document_vectors is empty but we have {len(comment_texts)} comments. Generating synthetic embeddings...")
                    try:
                        # Create synthetic random embeddings (just for visualization)
                        document_vectors = np.random.rand(len(comment_texts), 384)  # Standard embedding dimension
                        logger.info(f"Generated synthetic document_vectors with shape: {document_vectors.shape}")
                    except Exception as e:
                        logger.error(f"Failed to generate synthetic embeddings: {e}")
                
                # If document_map is empty but we have document_vectors, generate UMAP projection
                if len(document_map) == 0 and len(document_vectors) > 0:
                    logger.warning("document_map is empty but document_vectors exists. Generating UMAP projection...")
                    try:
                        from umap import UMAP
                        # Add more detailed logging about document_vectors
                        logger.info(f"Document vectors type: {type(document_vectors)}")
                        logger.info(f"Document vectors shape: {document_vectors.shape if hasattr(document_vectors, 'shape') else 'no shape attribute'}")
                        # Make sure document_vectors is a properly shaped numpy array
                        if not isinstance(document_vectors, np.ndarray):
                            document_vectors = np.array(document_vectors)
                            logger.info(f"Converted document_vectors to numpy array with shape: {document_vectors.shape}")
                        
                        logger.info(f"Creating UMAP instance with n_components=2, metric='cosine'")
                        umap_instance = UMAP(n_components=2, metric='cosine', random_state=42)
                        logger.info(f"Fitting UMAP and transforming document_vectors...")
                        document_map = umap_instance.fit_transform(document_vectors)
                        logger.info(f"Generated document_map with shape: {document_map.shape}")
                    except Exception as e:
                        logger.error(f"Failed to generate UMAP projection: {e}")
                        logger.error(traceback.format_exc())
                        
                    # If UMAP fails or isn't available, fall back to random 2D points
                    if len(document_map) == 0 and len(document_vectors) > 0:
                        logger.warning("Falling back to random 2D points for visualization...")
                        
                        # Get the number of points needed
                        if isinstance(document_vectors, np.ndarray):
                            num_points = document_vectors.shape[0]
                        else:
                            num_points = len(document_vectors)
                            
                        # Generate random 2D points
                        np.random.seed(42)  # Use fixed seed for reproducibility
                        document_map = np.random.rand(num_points, 2) * 10  # Scale up for visibility
                        logger.info(f"Generated random document_map with shape: {document_map.shape}")
                
                # Get max number of layers
                max_layer = 0
                for cluster in comment_clusters:
                    for key in cluster:
                        if key.startswith('layer') and key.endswith('_cluster_id'):
                            layer_id = int(key.replace('layer', '').replace('_cluster_id', ''))
                            max_layer = max(max_layer, layer_id)
                
                # Initialize cluster layers
                cluster_layers = [np.zeros(len(comment_ids), dtype=int) for _ in range(max_layer + 1)]
                
                # Map comment IDs to indices
                comment_id_to_idx = {comment_id: i for i, comment_id in enumerate(comment_ids)}
                
                # Fill in cluster assignments
                for cluster in comment_clusters:
                    comment_id = str(cluster.get('comment_id'))
                    if comment_id in comment_id_to_idx:
                        idx = comment_id_to_idx[comment_id]
                        for layer_id in range(max_layer + 1):
                            layer_key = f'layer{layer_id}_cluster_id'
                            if layer_key in cluster and cluster[layer_key] is not None:
                                try:
                                    # Convert to int, handling various formats
                                    if isinstance(cluster[layer_key], dict) and 'N' in cluster[layer_key]:
                                        # DynamoDB NumberAttribute format
                                        cluster_id = int(cluster[layer_key]['N'])
                                    else:
                                        cluster_id = int(cluster[layer_key])
                                    cluster_layers[layer_id][idx] = cluster_id
                                except (TypeError, ValueError) as e:
                                    logger.warning(f"Skipping invalid cluster ID for comment {comment_id}, layer {layer_id}: {cluster[layer_key]}")
                                    # Skip this assignment but continue processing others
                
                logger.info(f"Successfully loaded pre-processed data with {len(comment_ids)} comments and {len(cluster_layers)} layers")
                
                return {
                    'document_vectors': document_vectors,
                    'document_map': document_map,
                    'cluster_layers': cluster_layers,
                    'comment_texts': comment_texts,
                    'comment_ids': comment_ids,
                    'source': 'dynamo_pre_processed'
                }
                
        except Exception as e:
            logger.error(f"Error loading pre-processed UMAP data: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return None
    
    except Exception as e:
        logger.error(f"Error checking for pre-processed data: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return None

def process_conversation(zid, export_dynamo=True, use_ollama=False, use_precomputed=True, skip_postgres=False, postgres_for_comments_only=True):
    """
    Main function to process a conversation and generate visualizations.
    
    Args:
        zid: Conversation ID
        export_dynamo: Whether to export results to DynamoDB
        use_ollama: Whether to use Ollama for topic naming
        use_precomputed: Whether to try using pre-computed data from DynamoDB
        skip_postgres: Whether to skip PostgreSQL entirely
        postgres_for_comments_only: If True, still use PostgreSQL for comment texts even if skip_postgres is True
    """
    # Create conversation directory
    output_dir = os.path.join("polis_data", str(zid), "python_output", "comments_enhanced_multilayer")
    os.makedirs(output_dir, exist_ok=True)
    
    # Initialize DynamoDB storage if requested
    dynamo_storage = None
    if export_dynamo or use_precomputed:
        # Use endpoint from environment if available
        endpoint_url = os.environ.get('DYNAMODB_ENDPOINT')
        logger.info(f"Using DynamoDB endpoint from environment: {endpoint_url}")
        
        dynamo_storage = DynamoDBStorage(
            region_name='us-west-2',
            endpoint_url=endpoint_url
        )
    
    # Try to load pre-processed data if requested
    precomputed_data = None
    if use_precomputed and dynamo_storage:
        precomputed_data = load_processed_data_from_dynamo(
            dynamo_storage, 
            str(zid), 
            skip_postgres=skip_postgres,
            postgres_for_comments_only=postgres_for_comments_only
        )
    
    # If we have pre-computed data, use it directly
    if precomputed_data:
        logger.info("Using pre-computed data from DynamoDB")
        document_map = precomputed_data['document_map']  
        document_vectors = precomputed_data['document_vectors']
        cluster_layers = precomputed_data['cluster_layers']
        comment_texts = precomputed_data['comment_texts']
        comment_ids = precomputed_data['comment_ids']
        
        # Print debug information about array shapes
        logger.info(f"Precomputed document_vectors shape: {document_vectors.shape}")
        logger.info(f"Precomputed document_map shape: {document_map.shape}")
        
        # If both document_vectors and document_map are empty, we need to create synthetic data
        if len(document_vectors) == 0 and len(comment_texts) > 0:
            logger.warning(f"Precomputed document_vectors is empty but we have {len(comment_texts)} comments. Generating synthetic embeddings...")
            try:
                # Create synthetic random embeddings (just for visualization)
                document_vectors = np.random.rand(len(comment_texts), 384)  # Standard embedding dimension
                logger.info(f"Generated synthetic document_vectors with shape: {document_vectors.shape}")
            except Exception as e:
                logger.error(f"Failed to generate synthetic embeddings: {e}")
        
        # If document_map is empty but we have document_vectors, generate a new UMAP projection
        if len(document_map) == 0 and len(document_vectors) > 0:
            logger.warning("Precomputed document_map is empty but document_vectors exists. Generating UMAP projection...")
            try:
                from umap import UMAP
                document_map = UMAP(n_components=2, metric='cosine', random_state=42).fit_transform(document_vectors)
                logger.info(f"Generated document_map with shape: {document_map.shape}")
            except Exception as e:
                logger.error(f"Failed to generate UMAP projection: {e}")
                
            # If UMAP fails or isn't available, fall back to random 2D points
            if len(document_map) == 0 and len(document_vectors) > 0:
                logger.warning("Falling back to random 2D points for visualization...")
                document_map = np.random.rand(len(document_vectors), 2) * 10  # Scale up for visibility
                logger.info(f"Generated random document_map with shape: {document_map.shape}")
        
        # Get necessary metadata
        conversation_id = str(zid)
        
        # Still need to fetch basic metadata for conversation name
        _, metadata = fetch_conversation_data(zid, skip_postgres=skip_postgres, postgres_for_comments_only=postgres_for_comments_only)
        conversation_name = metadata.get('conversation_name', f"Conversation {zid}")
        
        # Add source information to metadata
        metadata['source'] = 'dynamo_pre_processed'
        metadata['precomputed'] = True
    else:
        # Fallback to standard processing path
        # Fetch data from PostgreSQL or DynamoDB
        comments, metadata = fetch_conversation_data(zid, skip_postgres=skip_postgres, postgres_for_comments_only=postgres_for_comments_only)
        if not comments:
            logger.error("Failed to fetch conversation data.")
            return False
        
        conversation_id = str(zid)
        conversation_name = metadata.get('conversation_name', f"Conversation {zid}")
        
        # Process comments
        document_map, document_vectors, cluster_layers, comment_texts, comment_ids = process_comments(
            comments, conversation_id
        )
        
        # Store basic data in DynamoDB
        logger.info(f"Storing basic data in DynamoDB for conversation {conversation_id}...")
        
        # Store conversation metadata
        logger.info("Storing conversation metadata...")
        conversation_meta = DataConverter.create_conversation_meta(
            conversation_id,
            document_vectors,
            cluster_layers,
            metadata
        )
        dynamo_storage.create_conversation_meta(conversation_meta)
        
        # Store embeddings with UMAP coordinates
        logger.info("Storing comment embeddings with UMAP coordinates...")
        embedding_models = DataConverter.batch_convert_embeddings(
            conversation_id,
            document_vectors,
            document_map  # Pass document_map to the converter to store UMAP coordinates
        )
        result = dynamo_storage.batch_create_comment_embeddings(embedding_models)
        logger.info(f"Stored {result['success']} embeddings with {result['failure']} failures")
        
        # Store UMAP graph edges
        logger.info("Storing UMAP graph edges...")
        edge_models = DataConverter.batch_convert_umap_edges(
            conversation_id,
            document_map,
            cluster_layers
        )
        result = dynamo_storage.batch_create_graph_edges(edge_models)
        logger.info(f"Stored {result['success']} UMAP graph edges with {result['failure']} failures")
        
        # Store cluster assignments
        logger.info("Storing comment cluster assignments...")
        cluster_models = DataConverter.batch_convert_clusters(
            conversation_id,
            cluster_layers,
            document_map
        )
        result = dynamo_storage.batch_create_comment_clusters(cluster_models)
        logger.info(f"Stored {result['success']} cluster assignments with {result['failure']} failures")
        
        # Store cluster topics (basic info only)
        logger.info("Storing cluster topics...")
        topic_models = DataConverter.batch_convert_topics(
            conversation_id,
            cluster_layers,
            document_map,
            topic_names={},  # No topic names yet
            characteristics={},  # No characteristics yet
            comments=[{'body': comment['txt']} for comment in comments]
        )
        result = dynamo_storage.batch_create_cluster_topics(topic_models)
        logger.info(f"Stored {result['success']} topics with {result['failure']} failures")
    
    # Process layers, store characteristics, and create visualizations
    process_layers_and_create_visualizations(
        conversation_id,
        conversation_name,
        document_map,
        cluster_layers,
        comment_texts,
        output_dir,
        use_ollama=use_ollama,
        dynamo_storage=dynamo_storage
    )
    
    # Save metadata
    with open(os.path.join(output_dir, f"{conversation_id}_metadata.json"), 'w') as f:
        # Custom encoder to handle Decimal, numpy types, etc.
        class CustomJSONEncoder(json.JSONEncoder):
            def default(self, obj):
                if isinstance(obj, decimal.Decimal):
                    return float(obj)
                if isinstance(obj, (np.int64, np.int32, np.int16, np.int8)):
                    return int(obj)
                if isinstance(obj, (np.float64, np.float32, np.float16)):
                    return float(obj)
                if isinstance(obj, np.ndarray):
                    return obj.tolist()
                return super().default(obj)
        
        json.dump(metadata, f, indent=2, cls=CustomJSONEncoder)
    
    logger.info(f"Processing of conversation {conversation_id} complete!")
    
    return True

def main():
    """Main entry point."""
    # Parse arguments
    import argparse
    parser = argparse.ArgumentParser(description='Process Polis conversation from PostgreSQL')
    parser.add_argument('--zid', type=int, required=False, default=22154,
                      help='Conversation ID to process')
    parser.add_argument('--no-dynamo', action='store_true',
                      help='Skip exporting to DynamoDB')
    parser.add_argument('--db-host', type=str, default=None,
                       help='PostgreSQL host')
    parser.add_argument('--db-port', type=int, default=None,
                       help='PostgreSQL port')
    parser.add_argument('--db-name', type=str, default=None,
                       help='PostgreSQL database name')
    parser.add_argument('--db-user', type=str, default=None,
                       help='PostgreSQL user')
    parser.add_argument('--db-password', type=str, default=None,
                       help='PostgreSQL password')
    parser.add_argument('--use-mock-data', action='store_true',
                       help='Use mock data instead of connecting to PostgreSQL')
    parser.add_argument('--use-ollama', action='store_true',
                       help='Use Ollama for topic naming')
    parser.add_argument('--use-precomputed', action='store_true',
                       help='Use pre-computed data from DynamoDB if available')
    parser.add_argument('--use-dynamodb', action='store_true',
                       help='Prioritize DynamoDB for data source over PostgreSQL')
    parser.add_argument('--skip-postgres-load', action='store_true',
                       help='Skip PostgreSQL load entirely, only use DynamoDB')
    
    args = parser.parse_args()
    
    # Set up environment
    setup_environment(
        db_host=args.db_host,
        db_port=args.db_port,
        db_name=args.db_name,
        db_user=args.db_user,
        db_password=args.db_password
    )
    
    # Log parameter usage
    if args.use_ollama:
        logger.info("Ollama will be used for topic naming")
    
    if args.use_precomputed:
        logger.info("Will attempt to use pre-computed data from DynamoDB")
        
    if args.use_dynamodb:
        logger.info("DynamoDB will be prioritized as data source")
        
    if args.skip_postgres_load:
        logger.info("PostgreSQL load will be skipped entirely")
        
    # DynamoDB is used by default - set environment variables
    os.environ['PREFER_DYNAMODB'] = 'true'
    os.environ['USE_DYNAMODB'] = 'true'
    
    # Only disable DynamoDB if explicitly requested (for backward compatibility)
    if args.no_dynamo:
        logger.warning("DEPRECATED: PostgreSQL-only mode is deprecated and will be removed in a future release.")
        os.environ['PREFER_DYNAMODB'] = 'false'
        os.environ['USE_DYNAMODB'] = 'false'
    
    # Process conversation
    if args.use_mock_data:
        logger.info("Using mock data instead of connecting to PostgreSQL")
        # Create mock comments data
        mock_comments = []
        for i in range(100):
            mock_comments.append({
                'tid': i,
                'zid': args.zid,
                'txt': f"This is a mock comment {i} for testing purposes without PostgreSQL connection.",
                'created': datetime.now().isoformat(),
                'pid': i % 20,  # Mock 20 different participants
                'active': True
            })
        
        # Create mock metadata
        mock_metadata = {
            'conversation_id': str(args.zid),
            'zid': args.zid,
            'conversation_name': f"Mock Conversation {args.zid}",
            'description': "Mock conversation for testing without PostgreSQL",
            'created': datetime.now().isoformat(),
            'modified': datetime.now().isoformat(),
            'owner': 'mock_user',
            'num_comments': len(mock_comments)
        }
        
        # Process with mock data
        document_map, document_vectors, cluster_layers, comment_texts, comment_ids = process_comments(
            mock_comments, str(args.zid)
        )
        
        # Store in DynamoDB if requested
        if not args.no_dynamo:
            # Warning: store_in_dynamo method doesn't exist and is left here from earlier version
            # Use DynamoDBStorage to upload mock data
            dynamo_storage = DynamoDBStorage(
                region_name='us-west-2',
                endpoint_url=os.environ.get('DYNAMODB_ENDPOINT')
            )
            
            # Prepare and upload conversation config
            conversation_meta = DataConverter.create_conversation_meta(
                str(args.zid),
                document_vectors,
                cluster_layers,
                mock_metadata
            )
            dynamo_storage.create_conversation_meta(conversation_meta)
            
            logger.info("Mock data stored in DynamoDB")
        
        # Process each layer and create visualizations
        output_dir = os.path.join("polis_data", str(args.zid), "python_output", "comments_enhanced_multilayer")
        os.makedirs(output_dir, exist_ok=True)
        
        process_layers_and_create_visualizations(
            str(args.zid),
            mock_metadata.get('conversation_name'),
            document_map,
            cluster_layers,
            comment_texts,
            output_dir,
            use_ollama=args.use_ollama
        )
    else:
        # By default, still use PostgreSQL for comment texts even if using DynamoDB for everything else
        postgres_for_comments_only = not args.skip_postgres_load
        
        # Process with DynamoDB by default, fallback to PostgreSQL if needed
        success = process_conversation(
            args.zid, 
            export_dynamo=True,  # Always export to DynamoDB 
            use_ollama=args.use_ollama,
            use_precomputed=True,  # Always try to use precomputed data
            skip_postgres=args.skip_postgres_load or os.environ.get('PREFER_DYNAMODB') == 'true',
            postgres_for_comments_only=postgres_for_comments_only
        )
        
        # Report success or failure
        if success:
            logger.info(f"Successfully processed conversation {args.zid}")
            sys.exit(0)
        else:
            logger.error(f"Failed to process conversation {args.zid}")
            sys.exit(1)

if __name__ == "__main__":
    main()