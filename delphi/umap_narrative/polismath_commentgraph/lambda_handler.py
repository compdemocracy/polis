"""
AWS Lambda handler for polismath_commentgraph.

This module provides the Lambda function handlers for processing comments
and running the clustering.
"""

import json
import logging
import os
import time
import traceback
from datetime import datetime
from typing import Any, Dict, List

import boto3
import numpy as np

from .core.clustering import ClusteringEngine
from .core.embedding import EmbeddingEngine
from .schemas.dynamo_models import (
    CommentCluster,
    CommentEmbedding,
    UMAPGraphEdge,
    # CommentText - removed to avoid duplication with PostgreSQL
)
from .utils.converter import DataConverter
from .utils.storage import DynamoDBStorage, PostgresClient

# Configure logging
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Initialize service objects - reused across Lambda invocations
embedding_engine = EmbeddingEngine()
clustering_engine = ClusteringEngine()
dynamo_storage = DynamoDBStorage()
postgres_client = PostgresClient()


def parse_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    Parse the Lambda event to extract needed information.

    Args:
        event: Lambda event object

    Returns:
        Parsed event data
    """
    logger.info(f"Parsing event: {json.dumps(event, default=str)}")

    # Check if this is an SNS event
    if "Records" in event and len(event["Records"]) > 0:
        record = event["Records"][0]
        if "Sns" in record:
            # Parse SNS message
            message = json.loads(record["Sns"]["Message"])
            logger.info(f"Parsed SNS message: {json.dumps(message, default=str)}")
            return message
        elif "eventSource" in record and record["eventSource"] == "aws:sqs":
            # Parse SQS message
            message = json.loads(record["body"])
            logger.info(f"Parsed SQS message: {json.dumps(message, default=str)}")
            return message

    # If not an SNS/SQS event, return the event as is
    return event


def get_comment_data(conversation_id: str) -> List[Dict[str, Any]]:
    """
    Get comment data from PostgreSQL.

    Args:
        conversation_id: Conversation ID string

    Returns:
        List of comments
    """
    # Convert string ID to integer (Postgres uses integer IDs)
    try:
        if conversation_id.isdigit():
            zid = int(conversation_id)
        else:
            # Try to lookup by zinvite/slug
            zid = postgres_client.get_conversation_id_by_slug(conversation_id)
            if zid is None:
                logger.error(f"Conversation not found for id: {conversation_id}")
                return []

        logger.info(f"Retrieving comments for conversation {zid}")

        # Get all comments for this conversation
        comments = postgres_client.get_comments_by_conversation(zid)
        logger.info(f"Retrieved {len(comments)} comments from PostgreSQL")

        # Format comments for processing
        comment_data = []
        for comment in comments:
            comment_data.append(
                {
                    "comment_id": comment["tid"],
                    "text": comment["txt"],
                    "created": comment.get("created", ""),
                    "author_id": comment.get("pid", ""),
                }
            )

        return comment_data
    except Exception as e:
        logger.error(f"Error getting comment data: {str(e)}")
        logger.error(traceback.format_exc())
        return []


def process_conversation(conversation_id: str) -> Dict[str, Any]:
    """
    Process a conversation with EVOC clustering.

    Args:
        conversation_id: Conversation ID

    Returns:
        Processing results
    """
    start_time = time.time()
    logger.info(f"Processing conversation: {conversation_id}")

    # Get comments from PostgreSQL
    comment_data = get_comment_data(conversation_id)

    if not comment_data:
        logger.error(f"No comments found for conversation: {conversation_id}")
        return {
            "success": False,
            "error": "No comments found",
            "conversation_id": conversation_id,
        }

    # Extract text and IDs
    comments = [c["text"] for c in comment_data]
    comment_ids = [c["comment_id"] for c in comment_data]

    # Generate embeddings
    logger.info(f"Generating embeddings for {len(comments)} comments")
    embedding_start = time.time()
    embeddings = embedding_engine.embed_batch(comments)
    embedding_time = time.time() - embedding_start
    logger.info(f"Embeddings generated in {embedding_time:.2f}s")

    # Project to 2D
    logger.info("Projecting embeddings to 2D using UMAP")
    projection_start = time.time()
    projection = clustering_engine.project_to_2d(embeddings)
    projection_time = time.time() - projection_start
    logger.info(f"Projection completed in {projection_time:.2f}s")

    # Create clustering layers
    logger.info("Creating clustering layers")
    clustering_start = time.time()
    cluster_layers = clustering_engine.create_clustering_layers(
        embeddings, num_layers=4
    )
    clustering_time = time.time() - clustering_start
    logger.info(f"Clustering completed in {clustering_time:.2f}s")

    # Create conversation metadata
    metadata = {
        "conversation_name": conversation_id,
        "processed_date": datetime.now().isoformat(),
        "num_comments": len(comments),
        "num_clusters": len(np.unique(cluster_layers[0][cluster_layers[0] >= 0])),
        "cluster_layers": [
            len(np.unique(layer[layer >= 0])) for layer in cluster_layers
        ],
    }

    # Store in DynamoDB
    logger.info("Storing results in DynamoDB")
    dynamo_start = time.time()

    # Create and store conversation metadata
    conversation_meta = DataConverter.create_conversation_meta(
        conversation_id, embeddings, cluster_layers, metadata
    )
    dynamo_storage.create_conversation_meta(conversation_meta)

    # Convert and store embeddings
    embedding_models = []
    for i, embedding in enumerate(embeddings):
        # Calculate nearest neighbors
        distances = np.sqrt(np.sum((projection - projection[i]) ** 2, axis=1))
        nearest_indices = np.argsort(distances)[1:6]  # Skip self
        nearest_distances = distances[nearest_indices]

        model = DataConverter.create_comment_embedding(
            conversation_id, comment_ids[i] if i < len(comment_ids) else i, embedding
        )

        embedding_models.append(model)

    # Batch store embeddings
    result = dynamo_storage.batch_create_comment_embeddings(embedding_models)
    logger.info(
        f"Stored {result['success']} embeddings with {result['failure']} failures"
    )

    # Convert and store clusters
    cluster_models = DataConverter.batch_convert_clusters(
        conversation_id, cluster_layers, projection, comment_ids
    )

    # Batch store clusters
    result = dynamo_storage.batch_create_comment_clusters(cluster_models)
    logger.info(
        f"Stored {result['success']} cluster assignments with {result['failure']} failures"
    )

    # Convert and store topics
    topic_models = DataConverter.batch_convert_topics(
        conversation_id,
        cluster_layers,
        projection,
        comments,  # This is comment_texts from process_comments
        topic_names={},  # No topic names yet
        characteristics={},  # No characteristics yet
    )

    # Batch store topics
    result = dynamo_storage.batch_create_cluster_topics(topic_models)
    logger.info(f"Stored {result['success']} topics with {result['failure']} failures")

    # Create and store graph edges
    edges = []

    # Calculate threshold distance for significant connections
    all_distances = []
    for i in range(min(100, len(projection))):
        distances = np.sqrt(np.sum((projection - projection[i]) ** 2, axis=1))
        all_distances.extend(distances)
    all_distances = np.array(all_distances)
    distance_threshold = np.percentile(all_distances, 5)  # Bottom 5% of distances

    # Generate sample edges
    generated_edges = set()
    for i in range(len(projection)):
        # Find nearest neighbors
        distances = np.sqrt(np.sum((projection - projection[i]) ** 2, axis=1))
        nearest_indices = np.argsort(distances)[1:6]  # Skip self
        nearest_distances = distances[nearest_indices]

        for j, (neighbor_idx, distance) in enumerate(
            zip(nearest_indices, nearest_distances)
        ):
            # Only create edge once (avoid duplicates)
            edge_key = tuple(sorted([i, neighbor_idx]))
            if edge_key in generated_edges:
                continue

            generated_edges.add(edge_key)

            # Only include significant connections
            if distance > distance_threshold:
                continue

            # Determine shared cluster layers
            shared_layers = []
            for layer_id, layer in enumerate(cluster_layers):
                if (
                    layer[i] >= 0
                    and layer[neighbor_idx] >= 0
                    and layer[i] == layer[neighbor_idx]
                ):
                    shared_layers.append(layer_id)

            comment_id_i = comment_ids[i] if i < len(comment_ids) else i
            comment_id_j = (
                comment_ids[neighbor_idx]
                if neighbor_idx < len(comment_ids)
                else neighbor_idx
            )

            edge = DataConverter.create_graph_edge(
                conversation_id,
                comment_id_i,
                comment_id_j,
                distance,
                distance,
                True,
                shared_layers,
            )

            edges.append(edge)

    # Batch store edges
    result = dynamo_storage.batch_create_graph_edges(edges)
    logger.info(
        f"Stored {result['success']} graph edges with {result['failure']} failures"
    )

    # Create and store comment texts
    text_models = []

    for i, comment_data_item in enumerate(comment_data):
        comment_id = comment_data_item["comment_id"]
        text = comment_data_item["text"]
        created = comment_data_item.get("created", "")
        author_id = comment_data_item.get("author_id", "")

        model = DataConverter.create_comment_text(
            conversation_id, comment_id, text, created=created, author_id=author_id
        )

        text_models.append(model)

    # Batch store texts
    result = dynamo_storage.batch_create_comment_texts(text_models)
    logger.info(
        f"Stored {result['success']} comment texts with {result['failure']} failures"
    )

    dynamo_time = time.time() - dynamo_start
    logger.info(f"DynamoDB storage completed in {dynamo_time:.2f}s")

    total_time = time.time() - start_time
    logger.info(f"Total processing time: {total_time:.2f}s")

    return {
        "success": True,
        "conversation_id": conversation_id,
        "num_comments": len(comments),
        "num_clusters": metadata["num_clusters"],
        "processing_time": {
            "total": total_time,
            "embedding": embedding_time,
            "projection": projection_time,
            "clustering": clustering_time,
            "storage": dynamo_time,
        },
    }


def process_new_comment(comment_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Process a single new comment and update DynamoDB.

    Args:
        comment_data: Comment data including conversation_id, comment_id, and text

    Returns:
        Processing results
    """
    start_time = time.time()
    logger.info(f"Processing new comment: {json.dumps(comment_data, default=str)}")

    # Extract data
    conversation_id = comment_data.get("conversation_id")
    comment_id = comment_data.get("comment_id")
    text = comment_data.get("text")

    if not all([conversation_id, comment_id, text]):
        logger.error("Missing required fields in comment data")
        return {
            "success": False,
            "error": "Missing required fields",
            "comment_data": comment_data,
        }

    # Generate embedding for new comment
    logger.info(
        f"Generating embedding for comment {comment_id} in conversation {conversation_id}"
    )
    embedding = embedding_engine.embed_text(text)

    # Get existing data from DynamoDB
    meta = dynamo_storage.get_conversation_meta(conversation_id)
    if not meta:
        logger.error(f"Conversation {conversation_id} not found in DynamoDB")
        return {
            "success": False,
            "error": "Conversation not found",
            "conversation_id": conversation_id,
        }

    # Get all existing comment embeddings
    table = dynamo_storage.dynamodb.Table(
        dynamo_storage.table_names["comment_embeddings"]
    )
    response = table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("conversation_id").eq(
            conversation_id
        )
    )
    existing_embeddings = response.get("Items", [])

    # Handle pagination if needed
    while "LastEvaluatedKey" in response:
        response = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("conversation_id").eq(
                conversation_id
            ),
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )
        existing_embeddings.extend(response.get("Items", []))

    # Convert to numpy array
    existing_vectors = []
    for item in existing_embeddings:
        existing_vectors.append(np.array(item["embedding"]["vector"]))

    existing_vectors = np.array(existing_vectors)

    # Add new embedding to the array
    all_vectors = np.concatenate([existing_vectors, embedding.reshape(1, -1)])

    # Project to 2D
    projection = clustering_engine.project_to_2d(all_vectors)

    # New comment's projection is the last one
    new_projection = projection[-1]

    # Create clusters using all vectors
    cluster_layers = clustering_engine.create_clustering_layers(
        all_vectors, num_layers=4
    )

    # Extract cluster assignments for the new comment
    new_clusters = {}
    for layer_idx, layer in enumerate(cluster_layers):
        new_clusters[f"layer{layer_idx}_cluster_id"] = int(layer[-1])

    # Calculate nearest neighbors
    distances = np.sqrt(np.sum((projection[:-1] - new_projection) ** 2, axis=1))
    nearest_indices = np.argsort(distances)[:5]
    nearest_distances = distances[nearest_indices]

    # Create nearest neighbor indices and distances - these are indices in the original list
    nearest_neighbor_indices = []
    for idx in nearest_indices:
        nearest_neighbor_indices.append(int(existing_embeddings[idx]["comment_id"]))

    # Create and store comment embedding
    embedding_model = CommentEmbedding(
        conversation_id=conversation_id,
        comment_id=int(comment_id),
        embedding=DataConverter.create_embedding_model(embedding),
    )

    dynamo_storage.create_comment_embedding(embedding_model)

    # Create and store comment cluster
    cluster_model = CommentCluster(
        conversation_id=conversation_id, comment_id=int(comment_id), **new_clusters
    )

    dynamo_storage.create_comment_cluster(cluster_model)

    # Note: Comment texts are not stored in DynamoDB
    # They are kept in PostgreSQL as the single source of truth
    # This avoids data duplication and ensures consistency

    # Create and store graph edges to nearest neighbors
    edges = []
    for i, (neighbor_idx, distance) in enumerate(
        zip(nearest_indices, nearest_distances)
    ):
        neighbor_id = int(existing_embeddings[neighbor_idx]["comment_id"])

        # Determine shared cluster layers
        shared_layers = []
        for layer_id, layer in enumerate(cluster_layers):
            new_cluster = layer[-1]
            neighbor_cluster = layer[neighbor_idx]
            if (
                new_cluster >= 0
                and neighbor_cluster >= 0
                and new_cluster == neighbor_cluster
            ):
                shared_layers.append(layer_id)

        edge = UMAPGraphEdge(
            conversation_id=conversation_id,
            edge_id=f"{comment_id}_{neighbor_id}",
            source_id=int(comment_id),
            target_id=neighbor_id,
            weight=1.0 - distance,  # Convert distance to similarity
            distance=float(distance),
            is_nearest_neighbor=True,
            shared_cluster_layers=shared_layers,
        )

        edges.append(edge)

    # Store edges
    for edge in edges:
        dynamo_storage.create_graph_edge(edge)

    total_time = time.time() - start_time
    logger.info(f"Processed new comment in {total_time:.2f}s")

    return {
        "success": True,
        "conversation_id": conversation_id,
        "comment_id": comment_id,
        "processing_time": total_time,
        "cluster_assignments": new_clusters,
    }


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    AWS Lambda handler function.

    Args:
        event: Lambda event object
        context: Lambda context object

    Returns:
        Lambda response
    """
    try:
        # Parse the incoming event
        data = parse_event(event)

        # Determine the type of event
        event_type = data.get("event_type", "process_conversation")

        if event_type == "process_conversation":
            # Process an entire conversation
            conversation_id = data.get("conversation_id")
            if not conversation_id:
                return {
                    "statusCode": 400,
                    "body": json.dumps(
                        {"error": "Missing conversation_id", "event": event}
                    ),
                }

            result = process_conversation(conversation_id)

            return {"statusCode": 200, "body": json.dumps(result, default=str)}

        elif event_type == "process_comment":
            # Process a single new comment
            comment_data = data.get("comment_data")
            if not comment_data:
                return {
                    "statusCode": 400,
                    "body": json.dumps(
                        {"error": "Missing comment_data", "event": event}
                    ),
                }

            result = process_new_comment(comment_data)

            return {"statusCode": 200, "body": json.dumps(result, default=str)}

        else:
            return {
                "statusCode": 400,
                "body": json.dumps(
                    {"error": f"Unknown event_type: {event_type}", "event": event}
                ),
            }

    except Exception as e:
        logger.error(f"Error processing Lambda event: {str(e)}")
        logger.error(traceback.format_exc())

        return {
            "statusCode": 500,
            "body": json.dumps(
                {"error": str(e), "trace": traceback.format_exc(), "event": event}
            ),
        }
