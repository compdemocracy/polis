#!/usr/bin/env python3
"""
Process Polis conversation from PostgreSQL, generate embeddings, and perform clustering.

This script fetches conversation data from PostgreSQL, processes it using
EVōC for hierarchical clustering, and stores results in DynamoDB for further processing.
"""

import os
import sys
import json
import time
import logging
import numpy as np
import pandas as pd
from datetime import datetime
from pathlib import Path
from tqdm.auto import tqdm

# Import from installed packages
import evoc
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
    
    # Log the endpoint being used
    endpoint = os.environ.get('DYNAMODB_ENDPOINT')
    logger.info(f"Using DynamoDB endpoint: {endpoint}")
    
    # Set these only if not already in environment
    if not os.environ.get('AWS_ACCESS_KEY_ID'):
        os.environ['AWS_ACCESS_KEY_ID'] = 'fakeMyKeyId'
    if not os.environ.get('AWS_SECRET_ACCESS_KEY'):
        os.environ['AWS_SECRET_ACCESS_KEY'] = 'fakeSecretAccessKey'
    if not os.environ.get('AWS_REGION') and not os.environ.get('AWS_DEFAULT_REGION'):
        os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'

def fetch_conversation_data(zid):
    """
    Fetch conversation data from PostgreSQL.
    
    Args:
        zid: Conversation ID
        
    Returns:
        comments: List of comment dictionaries
        metadata: Dictionary with conversation metadata
    """
    logger.info(f"Fetching conversation {zid} from PostgreSQL...")
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
            'inactive_count': inactive_count
        }
        
        return comments, metadata
    
    except Exception as e:
        logger.error(f"Error fetching conversation: {str(e)}")
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
    model_name = os.environ.get("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")
    logger.info(f"Using model: {model_name}")
    embedding_model = SentenceTransformer(model_name)
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

def generate_basic_cluster_labels(cluster_characteristics):
    """
    Generate basic topic labels for clusters based on their characteristics.
    This function only creates numeric topic labels (Topic 1, Topic 2, etc.)
    
    Args:
        cluster_characteristics: Dictionary with cluster characterizations
        
    Returns:
        cluster_labels: Dictionary mapping cluster IDs to basic topic labels
    """
    cluster_labels = {}
    
    # Create numeric topic labels
    for cluster_id in cluster_characteristics.keys():
        cluster_labels[cluster_id] = f"Topic {cluster_id}"
    
    return cluster_labels


def process_layers_and_store_characteristics(
    conversation_id,
    cluster_layers,
    comment_texts,
    output_dir=None,
    dynamo_storage=None
):
    """
    Process layers and store cluster characteristics in DynamoDB.
    
    Args:
        conversation_id: Conversation ID string
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Optional directory to save data as JSON (not typically used)
        dynamo_storage: Optional DynamoDBStorage object for storing in DynamoDB
        
    Returns:
        Dictionary with layer data including characteristics and basic topic names
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
            with open(os.path.join(output_dir, f"{conversation_id}_layer_{layer_idx}_characteristics.json"), 'w') as f:
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




def process_conversation(zid, export_dynamo=True):
    """
    Main function to process a conversation, generate embeddings, and perform clustering.
    
    Args:
        zid: Conversation ID
        export_dynamo: Whether to export results to DynamoDB
    """
    # Fetch data from PostgreSQL
    comments, metadata = fetch_conversation_data(zid)
    if not comments:
        logger.error("Failed to fetch conversation data.")
        return False
    
    conversation_id = str(zid)
    conversation_name = metadata.get('conversation_name', f"Conversation {zid}")
    region = os.environ.get('AWS_REGION')
    
    # Process comments
    document_map, document_vectors, cluster_layers, comment_texts, comment_ids = process_comments(
        comments, conversation_id
    )
    
    # Initialize DynamoDB storage
    dynamo_storage = None
    if export_dynamo:
        dynamo_storage = DynamoDBStorage(
            region_name=region,
            endpoint_url=os.environ.get('DYNAMODB_ENDPOINT')
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
        
        # Store embeddings
        logger.info("Storing comment embeddings...")
        embedding_models = DataConverter.batch_convert_embeddings(
            conversation_id,
            document_vectors
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
    
    # Process layers and store characteristics
    layer_data = process_layers_and_store_characteristics(
        conversation_id,
        cluster_layers,
        comment_texts,
        output_dir=None,  # No output directory needed
        dynamo_storage=dynamo_storage
    )
    
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
    
    args = parser.parse_args()
    
    # Set up environment
    setup_environment(
        db_host=args.db_host,
        db_port=args.db_port,
        db_name=args.db_name,
        db_user=args.db_user,
        db_password=args.db_password
    )
    
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
        
        # Process comments to get embeddings and clustering
        document_map, document_vectors, cluster_layers, comment_texts, comment_ids = process_comments(
            mock_comments, str(args.zid)
        )
        
        # Process with mock data (store in DynamoDB if requested)
        if not args.no_dynamo:
            dynamo_storage = DynamoDBStorage(
                region_name='us-east-1',
                endpoint_url=os.environ.get('DYNAMODB_ENDPOINT')
            )
            
            # Store conversation metadata
            logger.info("Storing conversation metadata...")
            conversation_meta = DataConverter.create_conversation_meta(
                str(args.zid),
                document_vectors,
                cluster_layers,
                mock_metadata
            )
            dynamo_storage.create_conversation_meta(conversation_meta)
            
            # Process and store cluster data
            layer_data = process_layers_and_store_characteristics(
                str(args.zid),
                cluster_layers,
                comment_texts,
                output_dir=None,
                dynamo_storage=dynamo_storage
            )
    else:
        # Process with real data from PostgreSQL
        process_conversation(args.zid, export_dynamo=not args.no_dynamo)

if __name__ == "__main__":
    main()