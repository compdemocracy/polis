#!/usr/bin/env python3
"""
Generate LLM topic names for clusters using Ollama.

This script connects to PostgreSQL and DynamoDB to get necessary data,
generates meaningful topic names for clusters using Ollama LLM,
and saves the results to DynamoDB.

Usage:
    python generate_llm_topic_names.py --conversation_id 36324 --layer 0 
    # Model will default to OLLAMA_MODEL environment variable or "llama3.1:8b" if not specified

Features:
- Runs as a separate step after the core clustering pipeline
- Directly connects to PostgreSQL for comment texts
- Reads cluster data from DynamoDB 
- Generates descriptive topic names with LLM
- Only loads what's needed, making it memory efficient
- Can be run for specific layers or a full conversation
"""

import os
import sys
import json
import time
import logging
import argparse
import numpy as np
import pandas as pd
from datetime import datetime
from tqdm import tqdm
from pathlib import Path
from boto3.dynamodb.conditions import Key, Attr

# Import from local modules
from polismath_commentgraph.utils.storage import DynamoDBStorage
from polismath_commentgraph.utils.converter import DataConverter
from polismath_commentgraph.schemas.dynamo_models import LLMTopicName

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def setup_environment(dynamo_endpoint=None):
    """Set up environment variables for DynamoDB connection."""
    # DynamoDB settings (for local DynamoDB)
    if dynamo_endpoint:
        os.environ['DYNAMODB_ENDPOINT'] = dynamo_endpoint
    elif not os.environ.get('DYNAMODB_ENDPOINT'):
        # Log the endpoint being used
        endpoint = os.environ.get('DYNAMODB_ENDPOINT')
        logger.info(f"Using DynamoDB endpoint: {endpoint}")
    
    # Set up dummy credentials for local DynamoDB if not already set
    if not os.environ.get('AWS_ACCESS_KEY_ID'):
        os.environ['AWS_ACCESS_KEY_ID'] = 'fakeMyKeyId'
    
    if not os.environ.get('AWS_SECRET_ACCESS_KEY'):
        os.environ['AWS_SECRET_ACCESS_KEY'] = 'fakeSecretAccessKey'
    
    if not os.environ.get('AWS_DEFAULT_REGION'):
        os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'
    
    logger.info(f"DynamoDB endpoint: {os.environ.get('DYNAMODB_ENDPOINT')}")
    logger.info(f"AWS region: {os.environ.get('AWS_DEFAULT_REGION')}")

def check_ollama_availability():
    """Check if Ollama is available and working."""
    try:
        import ollama
        import os
        
        # Check if OLLAMA_HOST is set in environment
        ollama_host = os.environ.get('OLLAMA_HOST')
        if ollama_host:
            logger.info(f"Using OLLAMA_HOST from environment: {ollama_host}")
            # Try to set the host for the Ollama client
            try:
                # For newer versions of ollama client
                ollama.client._CLIENT_BASE_URL = ollama_host
                logger.info(f"Set Ollama client base URL to {ollama_host}")
            except:
                logger.warning("Could not set ollama.client._CLIENT_BASE_URL, falling back to environment variable")
                # The client will pick up OLLAMA_HOST automatically in newer versions
                pass
        
        # Just check if we can connect to Ollama API
        # Don't try to list models which might be causing issues
        logger.info("Checking Ollama connection...")
        # Get the model name from environment or default to llama3.1:8b
        model_name = os.environ.get("OLLAMA_MODEL")
        logger.info(f"Checking Ollama connection with model: {model_name}")
        # Simple ping to verify Ollama is running
        ollama.embeddings(model=model_name, prompt="test")
        logger.info("Ollama is available")
        return True
    except ImportError:
        logger.error("Ollama not installed. Please install with: pip install ollama")
        return False
    except Exception as e:
        logger.error(f"Error connecting to Ollama: {e}")
        return False

def get_conversation_output_path(conversation_id, output_base_dir="polis_data"):
    """Get the output path for visualization files for a conversation."""
    # Handle string or integer conversation_id
    conversation_str = str(conversation_id)
    
    # Construct path to visualization directory
    output_path = os.path.join(output_base_dir, conversation_str, "python_output")
    
    # Create directories for multilayer visualizations
    multilayer_dir = os.path.join(output_path, "comments_multilayer")
    enhanced_dir = os.path.join(output_path, "comments_enhanced_multilayer")
    os.makedirs(multilayer_dir, exist_ok=True)
    os.makedirs(enhanced_dir, exist_ok=True)
    
    return {
        "base": output_path,
        "multilayer": multilayer_dir,
        "enhanced": enhanced_dir
    }

def load_comment_texts(conversation_id, dynamo_storage=None, output_base_dir="polis_data"):
    """
    Load comment texts directly from PostgreSQL.
    
    Args:
        conversation_id: Conversation ID
        dynamo_storage: Optional DynamoDBStorage instance
        output_base_dir: Base directory for output files (not used)
        
    Returns:
        Dictionary mapping comment_id to text or None if not found
    """
    # Connect to PostgreSQL directly
    from polismath_commentgraph.utils.storage import PostgresClient
    
    logger.info(f"Loading comments directly from PostgreSQL for conversation {conversation_id}")
    postgres_client = PostgresClient()
    
    try:
        # Initialize connection
        postgres_client.initialize()
        
        # Get comments
        comments = postgres_client.get_comments_by_conversation(int(conversation_id))
        
        if not comments:
            logger.error(f"No comments found in PostgreSQL for conversation {conversation_id}")
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

def load_layer_data(conversation_id, job_id, layer_id, dynamo_storage=None, output_base_dir="polis_data"):
    """
    Load cluster data for a specific layer.
    
    Args:
        conversation_id: Conversation ID
        layer_id: Layer ID to load
        dynamo_storage: Optional DynamoDBStorage instance
        output_base_dir: Base directory for output files
        
    Returns:
        Dictionary with cluster data or None if not found
    """
    if not dynamo_storage:
        logger.error("DynamoDB storage is required")
        return None
        
    # Initialize return data
    layer_data = {
        "clusters": {},
        "characteristics": {},
        "enhanced_topic_names": {},
        "comment_texts": None
    }
    
    # Load comment texts directly from PostgreSQL
    layer_data["comment_texts"] = load_comment_texts(conversation_id, dynamo_storage, output_base_dir)
    if not layer_data["comment_texts"]:
        logger.warning("Could not load comment texts from PostgreSQL")
    
    # Load cluster assignments from DynamoDB using CommentClusters table
    try:
        # Get conversation metadata to make sure the layer exists
        meta = dynamo_storage.get_conversation_meta(job_id, conversation_id)
        if not meta or 'cluster_layers' not in meta:
            logger.error(f"No metadata or cluster_layers found for conversation {conversation_id}")
            return None
            
        # Check if layer exists
        cluster_layers = meta.get('cluster_layers', [])
        layer_exists = False
        for layer in cluster_layers:
            if layer.get('layer_id') == layer_id:
                layer_exists = True
                break
                
        if not layer_exists:
            logger.error(f"Layer {layer_id} does not exist in metadata")
            return None
        
        # Query CommentClusters to get cluster assignments
        logger.info(f"Loading clusters for layer {layer_id} from DynamoDB...")
        
        # Get all comment clusters for this job
        table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['comment_clusters'])
        response = table.query(
            KeyConditionExpression=Key('job_id').eq(job_id)
        )
        clusters = response.get('Items', [])
        
        # Handle pagination if needed
        while 'LastEvaluatedKey' in response:
            response = table.query(
                KeyConditionExpression=Key('job_id').eq(job_id),
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            clusters.extend(response.get('Items', []))
        
        # Create a mapping of cluster IDs to comment IDs for this layer
        for cluster in clusters:
            layer_cluster_id = cluster.get(f'layer{layer_id}_cluster_id')
            if layer_cluster_id is not None:
                comment_id = cluster.get('comment_id')
                if comment_id is not None:
                    if layer_cluster_id not in layer_data["clusters"]:
                        layer_data["clusters"][layer_cluster_id] = []
                    layer_data["clusters"][layer_cluster_id].append(comment_id)
        
        logger.info(f"Loaded {len(layer_data['clusters'])} clusters for layer {layer_id}")
    except Exception as e:
        logger.error(f"Error loading clusters from DynamoDB: {e}")
        return None
    
    # Try to load cluster characteristics from DynamoDB
    try:
        logger.info(f"Loading cluster characteristics for layer {layer_id} from DynamoDB...")
        characteristics = dynamo_storage.get_cluster_characteristics_by_layer(
            job_id, layer_id, conversation_id
        )
        
        # Convert to dictionary
        for char in characteristics:
            cluster_id = char.get('cluster_id')
            if cluster_id is not None:
                # Convert cluster_id to int for consistent keys
                layer_data["characteristics"][int(cluster_id)] = char
        
        logger.info(f"Loaded {len(characteristics)} cluster characteristics from DynamoDB")
    except Exception as e:
        logger.error(f"Error loading cluster characteristics from DynamoDB: {e}")
    
    # Validate that we have at least the minimum required data
    if not layer_data["clusters"]:
        logger.error("No clusters found for this layer")
        return None
    
    if not layer_data["characteristics"]:
        logger.warning("No cluster characteristics found, will generate topic names without them")
    
    return layer_data

def generate_topic_names(layer_data, conversation_name=None, model_name=None, provider_type=None):
    """
    Generate topic names using Ollama LLM.
    
    Args:
        layer_data: Dictionary with layer data
        conversation_name: Optional name of the conversation for context
        model_name: Ollama model name to use
        
    Returns:
        Dictionary mapping cluster IDs to topic names
    """
    try:
        import ollama
        import os
        
        # Check if OLLAMA_HOST is set in environment
        ollama_host = os.environ.get('OLLAMA_HOST')
        if ollama_host:
            logger.info(f"Using OLLAMA_HOST from environment: {ollama_host}")
            # Try to set the host for the Ollama client
            try:
                # For newer versions of ollama client
                ollama.client._CLIENT_BASE_URL = ollama_host
                logger.info(f"Set Ollama client base URL to {ollama_host}")
            except:
                logger.warning("Could not set ollama.client._CLIENT_BASE_URL, falling back to environment variable")
                # The client will pick up OLLAMA_HOST automatically in newer versions
                pass
    except ImportError:
        logger.error("Ollama not installed. Please install with: pip install ollama")
        return {}
    
    logger.info(f"Generating topic names using Ollama model {model_name}...")
    
    # Get cluster assignments and comment texts
    clusters = layer_data["clusters"]
    comment_texts = layer_data["comment_texts"]
    characteristics = layer_data["characteristics"]
    
    # If no comment texts available, can't generate names
    if not comment_texts:
        logger.error("No comment texts available, cannot generate topic names")
        return {}
    
    # Function to get topic labels via Ollama
    def get_topic_name(cluster_id):
        # Get comment IDs for this cluster
        comment_ids = clusters.get(cluster_id, [])
        
        # Get comments for this cluster
        cluster_comments = []
        for comment_id in comment_ids:
            if comment_id in comment_texts:
                cluster_comments.append(comment_texts[comment_id])
        
        # If no comments available, use a generic name
        if not cluster_comments:
            return f"Topic {cluster_id}"
        
        # Get characteristics if available
        top_words = []
        if cluster_id in characteristics:
            char = characteristics[cluster_id]
            top_words = char.get('top_words', [])
        
        # Create prompt
        prompt_prefix = f"For conversation {conversation_name or 'topic'}: " if conversation_name else ""
        
        # Add keywords to the prompt if available
        if top_words:
            prompt_prefix += f"Keywords for this cluster: {', '.join(top_words[:5])}. "
        
        prompt = f"{prompt_prefix}Please provide a concise topic label (3-5 words max) for the following group of comments. Return ONLY the label without any intro text like 'Here are the topic labels:' or quotation marks:\n\n"
        
        # Include up to 5 example comments (prefer shorter ones)
        comment_lengths = [(i, len(comment)) for i, comment in enumerate(cluster_comments)]
        comment_lengths.sort(key=lambda x: x[1])  # Sort by length
        selected_indices = [idx for idx, _ in comment_lengths[:min(5, len(comment_lengths))]]
        
        for j, idx in enumerate(selected_indices):
            prompt += f"{j+1}. {cluster_comments[idx]}\n"
        
        prompt += "\nTopic label:"
        
        try:
            # Using the Ollama API with the chat endpoint
            response = ollama.chat(
                model=model_name,
                messages=[{"role": "user", "content": prompt}]
            )
            
            # Get the response text from the appropriate field
            if isinstance(response, dict) and 'message' in response and 'content' in response['message']:
                topic_text = response['message']['content'].strip()
            else:
                # Handle API changes or different response formats
                logger.warning(f"Unexpected response format: {response}")
                if hasattr(response, 'strip'):
                    topic_text = response.strip()
                else:
                    return f"Topic {cluster_id}"
            
            # Try to extract just the label
            lines = topic_text.split('\n')
            topic = lines[0]  # First line is likely the label
            
            # Further clean up to ensure it's just a label
            topic = topic.replace("Topic label:", "").strip()
            
            # Remove common LLM prefixes
            prefixes_to_remove = [
                "Here are the topic labels:",
                "Here are the topic labels",
                "Here is the topic label:",
                "Here is the topic label",
                "The topic label is:",
                "The topic label is",
                "Topic name:",
                "Topic name",
                "Label:",
                "Label"
            ]
            
            for prefix in prefixes_to_remove:
                if topic.startswith(prefix):
                    topic = topic[len(prefix):].strip()
            
            # Remove quotes if they're present (handle any quote combination)
            topic = topic.strip('"\'')  # Strip both double and single quotes
            
            # Remove common formats like "1. Topic Name" or "- Topic Name"
            if topic.startswith("1. ") or topic.startswith("- "):
                topic = topic[3:].strip()
                
            if len(topic) > 50:  # If it's too long, truncate
                topic = topic[:50] + "..."
            
            # Log the generated topic name with more visibility
            logger.info(f"Generated topic for cluster {cluster_id}: '{topic}'")
                
            return topic
        except Exception as e:
            logger.error(f"Error generating topic with Ollama for cluster {cluster_id}: {e}")
            return f"Topic {cluster_id}"
    
    # Create a mapping of cluster IDs to topic names
    cluster_ids = list(clusters.keys())
    logger.info(f"Generating topic names for {len(cluster_ids)} clusters...")
    cluster_topic_names = {}
    
    for cluster_id in tqdm(cluster_ids, desc="Generating topic names"):
        # Skip negative cluster IDs (noise points)
        if int(cluster_id) < 0:
            cluster_topic_names[int(cluster_id)] = "Unclustered"
            continue
            
        # Get topic name
        topic_name = get_topic_name(cluster_id)
        
        # Store the topic name properly - avoid using the default value
        if topic_name == f"Topic {cluster_id}":
            # Try again with a different prompt if we got the default value
            logger.warning(f"Got default topic name for cluster {cluster_id}, trying again with simpler prompt")
            
            comment_ids = clusters.get(cluster_id, [])
            cluster_comments = []
            for comment_id in comment_ids:
                if comment_id in comment_texts:
                    cluster_comments.append(comment_texts[comment_id])
            
            if cluster_comments:
                # Try a simpler prompt
                try:
                    prompt = f"Based on these comments, give a very short topic label (3-5 words max). IMPORTANT: Return ONLY the label itself with no introduction or quotation marks:\n\n"
                    for i, comment in enumerate(cluster_comments[:3]):
                        prompt += f"{i+1}. {comment}\n"
                    prompt += "\nTopic label:"
                    
                    response = ollama.chat(
                        model=model_name,
                        messages=[{"role": "user", "content": prompt}]
                    )
                    if 'message' in response and 'content' in response['message']:
                        topic_text = response['message']['content'].strip()
                        topic_name = topic_text.split('\n')[0].strip().replace("Topic label:", "").strip()
                        
                        # Remove common LLM prefixes (same as above)
                        prefixes_to_remove = [
                            "Here are the topic labels:",
                            "Here are the topic labels",
                            "Here is the topic label:",
                            "Here is the topic label",
                            "The topic label is:",
                            "The topic label is",
                            "Topic name:",
                            "Topic name",
                            "Label:",
                            "Label"
                        ]
                        
                        for prefix in prefixes_to_remove:
                            if topic_name.startswith(prefix):
                                topic_name = topic_name[len(prefix):].strip()
                        
                        # Remove quotes if present - handle any quote combination
                        topic_name = topic_name.strip('"\'')
                        
                        # Remove common formats like "1. Topic Name" or "- Topic Name"
                        if topic_name.startswith("1. ") or topic_name.startswith("- "):
                            topic_name = topic_name[3:].strip()
                        
                        logger.info(f"Got better topic name for cluster {cluster_id}: '{topic_name}'")
                except Exception as e:
                    logger.error(f"Error getting alternative topic name: {e}")
        
        cluster_topic_names[int(cluster_id)] = topic_name
        logger.info(f"Stored final topic name for cluster {cluster_id}: '{topic_name}'")
        
        # No sleep between requests to speed up processing
        # time.sleep(0.5)
    
    # Always add "Unclustered" for noise points
    cluster_topic_names[-1] = "Unclustered"
    
    logger.info(f"Generated {len(cluster_topic_names)} topic names")
    return cluster_topic_names

def save_topic_names(conversation_id, job_id, layer_id, topic_names, model_name, dynamo_storage=None, output_base_dir="polis_data"):
    """
    Save generated topic names to DynamoDB.
    
    Args:
        conversation_id: Conversation ID
        layer_id: Layer ID
        topic_names: Dictionary mapping cluster IDs to topic names
        model_name: Name of the LLM model used
        dynamo_storage: Optional DynamoDBStorage instance
        output_base_dir: Base directory for output files (not used)
        
    Returns:
        True if successful, False otherwise
    """
    if not dynamo_storage:
        logger.error("DynamoDB storage is required")
        return False
    
    # Save to DynamoDB
    try:
        logger.info(f"Saving LLM topic names to DynamoDB...")
        
        # Convert to model objects
        from datetime import datetime
        
        # Debug: print what we're about to save
        logger.info(f"Topic names to save: {topic_names}")
        
        # Create LLMTopicName objects directly
        topic_models = []
        for cluster_id, topic_name in topic_names.items():
            # Double-check we're not using placeholder names
            if topic_name == f"Topic {cluster_id}":
                logger.warning(f"Using placeholder name 'Topic {cluster_id}' - this suggests Ollama didn't return a proper name")
            
            # Check if topic_name is empty or just whitespace
            if not topic_name or not topic_name.strip():
                logger.warning(f"Empty topic name for cluster {cluster_id} - likely truncated by LLM prefix removal")
            
            topic_key = f"layer{layer_id}_{cluster_id}"
            
            # Prepend the layer_cluster format to ensure uniqueness
            # Format: "0_5: Environmental Ethics" or "0_3:" for empty names
            # Special handling for "Unclustered" (-1 cluster)
            if int(cluster_id) == -1 and topic_name == "Unclustered":
                prefixed_topic_name = f"{layer_id}_{cluster_id}: Unclustered"
            else:
                prefixed_topic_name = f"{layer_id}_{cluster_id}: {topic_name}" if topic_name.strip() else f"{layer_id}_{cluster_id}:"
            
            model = {
                'job_id': job_id,
                'topic_key': topic_key,
                'conversation_id': conversation_id,
                'layer_id': layer_id,
                'cluster_id': int(cluster_id),
                'topic_name': prefixed_topic_name,
                'model_name': model_name,
                'created_at': datetime.now().isoformat()
            }
            topic_models.append(model)
            logger.info(f"Added topic model for cluster {cluster_id}: {prefixed_topic_name}")
        
        # Store in batch
        success_count = 0
        failure_count = 0
        
        # Process in batches of 25 (DynamoDB batch limit)
        table = dynamo_storage.dynamodb.Table(dynamo_storage.table_names['llm_topic_names'])
        
        for i in range(0, len(topic_models), 25):
            batch = topic_models[i:i + 25]
            
            try:
                with table.batch_writer() as writer:
                    for topic_model in batch:
                        writer.put_item(Item=topic_model)
                        logger.info(f"Saved topic for cluster {topic_model['cluster_id']}: {topic_model['topic_name']}")
                success_count += len(batch)
            except Exception as e:
                logger.error(f"Error in batch write operation: {e}")
                failure_count += len(batch)
        
        logger.info(f"Stored {success_count} LLM topic names with {failure_count} failures")
        return success_count > 0
        
    except Exception as e:
        logger.error(f"Error saving topic names to DynamoDB: {e}")
        return False

def update_visualization_with_llm_names(conversation_id, layer_id, topic_names, layer_data, output_base_dir="polis_data"):
    """
    Create a new visualization with LLM-generated topic names.
    
    Args:
        conversation_id: Conversation ID
        layer_id: Layer ID
        topic_names: Dictionary mapping cluster IDs to topic names
        layer_data: Dictionary with layer data
        output_base_dir: Base directory for output files
        
    Returns:
        Path to the saved visualization file
    """
    # Get output paths
    paths = get_conversation_output_path(conversation_id, output_base_dir)
    
    # Get required data
    document_map = layer_data["document_map"]
    cluster_layer = layer_data["cluster_layer"]
    comment_texts = layer_data["comment_texts"]
    
    # If any required data is missing, we can't create visualization
    if document_map is None or cluster_layer is None:
        logger.error("Missing required data for visualization")
        return None
    
    # Create labels for visualization
    labels_for_viz = np.array([
        topic_names.get(label, "Unclustered") if label >= 0 else "Unclustered"
        for label in cluster_layer
    ])
    
    # Create enhanced visualization
    layer_file = os.path.join(paths["enhanced"], f"{conversation_id}_comment_layer_{layer_id}_llm_named.html")
    
    try:
        layer_figure = datamapplot.create_interactive_plot(
            document_map,             # 2D coordinates for the data map
            labels_for_viz,           # Cluster labels for each data point
            hover_text=comment_texts, # Text to show on hover
            title=f"{conversation_id} Layer {layer_id} - {len(np.unique(cluster_layer[cluster_layer >= 0]))} topics with LLM names",
            sub_title=f"Comment clustering - Layer {layer_id} with LLM-generated topic labels",
            min_fontsize=12,
            max_fontsize=18, 
            point_radius_min_pixels=2,
            point_radius_max_pixels=10,
            width="100%",
            height=800
        )
        
        # Save the figure
        layer_figure.save(layer_file)
        logger.info(f"Saved visualization with LLM topic names to {layer_file}")
        
        return layer_file
    except Exception as e:
        logger.error(f"Error creating visualization: {e}")
        return None

def update_conversation_with_ollama(conversation_id, job_id, layer_id=None, model_name=None, output_base_dir="polis_data", dynamo_endpoint=None, start_cluster=None, end_cluster=None):
    """
    Update a conversation with Ollama-generated topic names.
    
    Args:
        conversation_id: Conversation ID
        layer_id: Optional specific layer ID to update (if None, update all layers)
        model_name: Ollama model name to use
        output_base_dir: Base directory for output files
        dynamo_endpoint: Optional DynamoDB endpoint URL
        start_cluster: Starting cluster ID for processing a range (inclusive)
        end_cluster: Ending cluster ID for processing a range (inclusive)
        
    Returns:
        True if successful, False otherwise
    """
    # Set up environment
    setup_environment(dynamo_endpoint)
    
    # Get model name from environment variable or use default
    if model_name is None:
        model_name = os.environ.get("OLLAMA_MODEL")
        logger.info(f"Using model from environment: {model_name}")
    
    # Check Ollama availability
    if not check_ollama_availability():
        logger.error("Ollama not available, cannot continue")
        return False
    
    # Initialize DynamoDB storage
    dynamo_storage = DynamoDBStorage(
        endpoint_url=os.environ.get('DYNAMODB_ENDPOINT')
    )
    
    # Get conversation metadata (for name)
    conversation_name = None
    try:
        meta = dynamo_storage.get_conversation_meta(job_id, conversation_id)
        if meta:
            conversation_name = meta.get('conversation_name') or meta.get('metadata', {}).get('conversation_name')
            if not conversation_name:
                conversation_name = f"Conversation {conversation_id}"
    except Exception as e:
        logger.error(f"Error getting conversation metadata: {e}")
        conversation_name = f"Conversation {conversation_id}"
    
    logger.info(f"Processing conversation {conversation_id}: {conversation_name}")
    
    # If layer_id is specified, process just that layer
    if layer_id is not None:
        return update_layer_with_ollama(
            conversation_id, job_id, layer_id, conversation_name, 
            model_name, output_base_dir, dynamo_storage,
            start_cluster, end_cluster
        )
    
    # Otherwise, try to get all available layers
    try:
        meta = dynamo_storage.get_conversation_meta(job_id, conversation_id)
        if meta and 'cluster_layers' in meta:
            layers = meta['cluster_layers']
            layer_ids = [layer['layer_id'] for layer in layers]
            
            logger.info(f"Found {len(layer_ids)} layers: {layer_ids}")
            
            # Process each layer
            results = []
            for layer_id in layer_ids:
                result = update_layer_with_ollama(
                    conversation_id, job_id, layer_id, conversation_name, 
                    model_name, output_base_dir, dynamo_storage,
                    start_cluster, end_cluster
                )
                results.append(result)
            
            # Return True if any layer was successfully updated
            return any(results)
        else:
            logger.warning("No layer information found in metadata, trying default layers 0-2")
            # Try default layers 0, 1, 2
            results = []
            for layer_id in range(3):
                result = update_layer_with_ollama(
                    conversation_id, job_id, layer_id, conversation_name, 
                    model_name, output_base_dir, dynamo_storage,
                    start_cluster, end_cluster
                )
                results.append(result)
            
            # Return True if any layer was successfully updated
            return any(results)
    except Exception as e:
        logger.error(f"Error processing conversation layers: {e}")
        return False

def update_layer_with_ollama(conversation_id, job_id, layer_id, conversation_name, model_name, output_base_dir, dynamo_storage, start_cluster=None, end_cluster=None):
    """
    Update a specific layer with Ollama-generated topic names.
    
    Args:
        conversation_id: Conversation ID
        layer_id: Layer ID to update
        conversation_name: Name of the conversation
        model_name: Ollama model name to use
        output_base_dir: Base directory for output files (not used)
        dynamo_storage: DynamoDBStorage instance
        start_cluster: Starting cluster ID for processing a range (inclusive)
        end_cluster: Ending cluster ID for processing a range (inclusive)
        
    Returns:
        True if successful, False otherwise
    """
    logger.info(f"Processing layer {layer_id} for conversation {conversation_id}")
    
    # Load layer data
    layer_data = load_layer_data(
        conversation_id, job_id, layer_id, dynamo_storage, output_base_dir
    )
    
    if not layer_data:
        logger.error(f"Failed to load layer data for layer {layer_id}")
        return False
    
    # If a cluster range is specified, filter the clusters
    clusters = layer_data["clusters"]
    if start_cluster is not None and end_cluster is not None:
        logger.info(f"Processing cluster range from {start_cluster} to {end_cluster}")
        filtered_clusters = {}
        for cluster_id, comment_ids in clusters.items():
            if int(cluster_id) >= start_cluster and int(cluster_id) <= end_cluster:
                filtered_clusters[cluster_id] = comment_ids
        
        # Replace the clusters with the filtered ones
        layer_data["clusters"] = filtered_clusters
        logger.info(f"Filtered from {len(clusters)} to {len(filtered_clusters)} clusters")
    
    # Generate topic names with Ollama
    topic_names = generate_topic_names(
        layer_data, conversation_name, model_name
    )
    
    if not topic_names:
        logger.error("Failed to generate topic names")
        return False
    
    # Save topic names to DynamoDB only
    success = save_topic_names(
        conversation_id, job_id, layer_id, topic_names, model_name, 
        dynamo_storage, output_base_dir
    )
    
    return success

def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Update cluster topics with Ollama-generated names')
    parser.add_argument('--conversation_id', type=str, required=True,
                      help='Conversation ID to process')
    parser.add_argument('--job_id', type=str, required=True,
                      help='Job ID - used as the primary key for DynamoDB queries')
    parser.add_argument('--layer', type=int, required=False, default=None,
                      help='Specific layer ID to update (default: all layers)')
    parser.add_argument('--model', type=str, default=None,
                      help='Ollama model to use (default: uses OLLAMA_MODEL env var or llama3.1:8b)')
    parser.add_argument('--output_dir', type=str, default="polis_data",
                      help='Base directory for output files (default: polis_data)')
    parser.add_argument('--dynamo_endpoint', type=str, default=None,
                      help='DynamoDB endpoint URL')
    parser.add_argument('--start_cluster', type=int, default=None,
                      help='Starting cluster ID for processing a range (inclusive)')
    parser.add_argument('--end_cluster', type=int, default=None,
                      help='Ending cluster ID for processing a range (inclusive)')
    
    args = parser.parse_args()
    
    logger.info(f"Starting update_with_ollama_standalone.py for conversation {args.conversation_id}")
    
    success = update_conversation_with_ollama(
        args.conversation_id,
        args.job_id,
        layer_id=args.layer,
        model_name=args.model,
        output_base_dir=args.output_dir,
        dynamo_endpoint=args.dynamo_endpoint,
        start_cluster=args.start_cluster,
        end_cluster=args.end_cluster
    )
    
    if success:
        logger.info(f"Successfully updated topics for conversation {args.conversation_id}")
        return 0
    else:
        logger.error(f"Failed to update topics for conversation {args.conversation_id}")
        return 1

if __name__ == "__main__":
    sys.exit(main())