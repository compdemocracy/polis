"""
Utilities for converting between data formats for the Polis comment graph microservice.
"""

import numpy as np
import json
import os
from typing import Dict, List, Any, Optional, Tuple, Union
import logging
from datetime import datetime
from decimal import Decimal

# Configure logging
logger = logging.getLogger(__name__)
from ..schemas.dynamo_models import (
    ConversationMeta,
    CommentEmbedding,
    CommentCluster,
    ClusterTopic,
    UMAPGraphEdge,
    ClusterCharacteristic,
    EnhancedTopicName,
    LLMTopicName,
    # CommentText - removed to avoid duplicating data in DynamoDB
    UMAPParameters,
    EVOCParameters,
    ClusterLayer,
    Embedding,
    Coordinates,
    ClusterReference
)

logger = logging.getLogger(__name__)

class DataConverter:
    """
    Converts between file-based data formats and DynamoDB schema models.
    Handles conversion of NumPy arrays, JSON files, and CSV data to the
    appropriate schema models.
    """
    
    @staticmethod
    def convert_floats_to_decimal(obj: Any) -> Any:
        """
        Recursively converts all floating-point numbers to Decimal for DynamoDB compatibility.
        
        Args:
            obj: Input object to convert
            
        Returns:
            Object with all floating-point numbers converted to Decimal
        """
        if isinstance(obj, float):
            return Decimal(str(obj))
        elif isinstance(obj, dict):
            return {k: DataConverter.convert_floats_to_decimal(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [DataConverter.convert_floats_to_decimal(item) for item in obj]
        elif isinstance(obj, np.ndarray):
            return [DataConverter.convert_floats_to_decimal(item) for item in obj.tolist()]
        elif isinstance(obj, np.float32) or isinstance(obj, np.float64):
            return Decimal(str(obj))
        elif isinstance(obj, np.int32) or isinstance(obj, np.int64):
            return int(obj)
        return obj
    
    @staticmethod
    def prepare_for_dynamodb(item: Dict[str, Any]) -> Dict[str, Any]:
        """
        Prepare a dictionary for storage in DynamoDB by converting floats to Decimals.
        
        Args:
            item: Dictionary to prepare
            
        Returns:
            Dictionary with all floating-point numbers converted to Decimal
        """
        return DataConverter.convert_floats_to_decimal(item)
    
    @staticmethod
    def numpy_to_list(array: np.ndarray) -> List:
        """
        Convert a NumPy array to a Python list.
        
        Args:
            array: NumPy array to convert
            
        Returns:
            Python list representation of the array
        """
        if array is None:
            return []
        return array.tolist()
    
    @staticmethod
    def create_conversation_meta(
        conversation_id: str,
        document_vectors: np.ndarray,
        cluster_layers: List[np.ndarray],
        metadata: Dict[str, Any] = None
    ) -> ConversationMeta:
        """
        Create a ConversationMeta model from raw data.
        
        Args:
            conversation_id: ID of the conversation
            document_vectors: Embedding vectors for all comments
            cluster_layers: List of cluster label arrays, one per layer
            metadata: Additional metadata dictionary
            
        Returns:
            ConversationMeta model object
        """
        # Create layer info
        cluster_layer_info = []
        for i, layer in enumerate(cluster_layers):
            # Count non-noise clusters
            num_clusters = len(np.unique(layer[layer >= 0]))
            
            # Create layer description
            description = 'Fine-grained grouping'
            if i == len(cluster_layers) - 1:
                description = 'Coarse grouping'
            elif i > 0:
                description = f'Medium grouping (layer {i})'
            
            cluster_layer_info.append(
                ClusterLayer(
                    layer_id=i,
                    num_clusters=num_clusters,
                    description=description
                )
            )
        
        # Create UMAP parameters (with defaults)
        umap_params = UMAPParameters()
        
        # Create EVOC parameters (with defaults)
        evoc_params = EVOCParameters()
        
        # Create the model
        meta = ConversationMeta(
            conversation_id=conversation_id,
            processed_date=datetime.now().isoformat(),
            num_comments=len(document_vectors),
            num_participants=metadata.get('num_participants', 0) if metadata else 0,
            embedding_model=os.environ.get("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2"),
            umap_parameters=umap_params,
            evoc_parameters=evoc_params,
            cluster_layers=cluster_layer_info,
            metadata=metadata or {}
        )
        
        return meta
    
    @staticmethod
    def create_comment_embedding(
        conversation_id: str,
        comment_id: int,
        vector: np.ndarray
    ) -> CommentEmbedding:
        """
        Create a CommentEmbedding model from raw data.
        
        Args:
            conversation_id: ID of the conversation
            comment_id: ID of the comment
            vector: Embedding vector
            
        Returns:
            CommentEmbedding model object
        """
        # Create the embedding object
        embedding = Embedding(
            vector=vector.tolist() if isinstance(vector, np.ndarray) else vector,
            dimensions=len(vector),
            model=os.environ.get("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")
        )
        
        # Create the model with just the embedding vector
        model = CommentEmbedding(
            conversation_id=conversation_id,
            comment_id=int(comment_id),
            embedding=embedding
        )
        
        return model
    
    @staticmethod
    def create_comment_cluster(
        conversation_id: str,
        comment_id: int,
        cluster_layers: List[np.ndarray],
        distances: Optional[Dict[str, float]] = None,
        confidences: Optional[Dict[str, float]] = None
    ) -> CommentCluster:
        """
        Create a CommentCluster model from raw data.
        
        Args:
            conversation_id: ID of the conversation
            comment_id: ID of the comment
            cluster_layers: List of cluster label arrays, one per layer
            distances: Optional dictionary of distances to centroids
            confidences: Optional dictionary of cluster confidence scores
            
        Returns:
            CommentCluster model object
        """
        # Create base data dictionary
        data = {
            'conversation_id': conversation_id,
            'comment_id': comment_id,  # Will be converted to Decimal by Pydantic model
            'is_outlier': False
        }
        
        # Add layer cluster IDs
        for i, layer in enumerate(cluster_layers):
            if comment_id < len(layer):
                # Ensure proper conversion path for numpy values
                # First convert to a Python float via string to avoid precision issues
                # Then convert to int for cluster IDs (or keep as -1 for outliers)
                try:
                    if layer[comment_id] >= 0:
                        cluster_id = int(float(str(layer[comment_id])))
                    else:
                        cluster_id = -1
                    data[f'layer{i}_cluster_id'] = cluster_id
                except (ValueError, TypeError) as e:
                    logger.warning(f"Conversion error for cluster ID at layer {i}, comment {comment_id}: {e}")
                    # Use a safe default
                    data[f'layer{i}_cluster_id'] = 0
                
                # Mark as outlier if any layer has -1
                if cluster_id == -1:
                    data['is_outlier'] = True
        
        # Add distances and confidences if available
        if distances:
            # Convert all float values to Decimal for DynamoDB compatibility
            data['distance_to_centroid'] = {k: float(v) for k, v in distances.items()}
        
        if confidences:
            # Convert all float values to Decimal for DynamoDB compatibility
            data['cluster_confidence'] = {k: float(v) for k, v in confidences.items()}
        
        # Create the model directly from the data dict
        # The model creation will use pydantic to validate the types
        # DataConverter.prepare_for_dynamodb will handle the proper conversion to Decimal
        model = CommentCluster(**DataConverter.prepare_for_dynamodb(data))
        
        return model
    
    @staticmethod
    def create_cluster_topic(
        conversation_id: str,
        layer_id: int,
        cluster_id: int,
        topic_label: str,
        size: int,
        centroid: np.ndarray,
        sample_comments: List[str],
        top_words: Optional[List[str]] = None,
        top_tfidf_scores: Optional[List[float]] = None,
        parent_cluster: Optional[Dict[str, int]] = None,
        child_clusters: Optional[List[Dict[str, int]]] = None
    ) -> ClusterTopic:
        """
        Create a ClusterTopic model from raw data.
        
        Args:
            conversation_id: ID of the conversation
            layer_id: ID of the layer
            cluster_id: ID of the cluster
            topic_label: Label for the topic
            size: Number of comments in the cluster
            centroid: Centroid coordinates
            sample_comments: List of sample comment texts
            top_words: Optional list of top words
            top_tfidf_scores: Optional list of TF-IDF scores
            parent_cluster: Optional parent cluster reference
            child_clusters: Optional list of child cluster references
            
        Returns:
            ClusterTopic model object
        """
        # Create cluster key
        cluster_key = f'layer{layer_id}_{cluster_id}'
        
        # Create centroid coordinates
        centroid_coords = Coordinates(
            x=float(centroid[0]) if isinstance(centroid, np.ndarray) else float(centroid['x']),
            y=float(centroid[1]) if isinstance(centroid, np.ndarray) else float(centroid['y'])
        )
        
        # Create parent cluster reference if provided
        parent_ref = None
        if parent_cluster:
            parent_ref = ClusterReference(
                layer_id=parent_cluster['layer_id'],
                cluster_id=parent_cluster['cluster_id']
            )
        
        # Create child cluster references if provided
        child_refs = None
        if child_clusters:
            child_refs = [
                ClusterReference(
                    layer_id=child['layer_id'],
                    cluster_id=child['cluster_id']
                )
                for child in child_clusters
            ]
        
        # Create the model
        model = ClusterTopic(
            conversation_id=conversation_id,
            cluster_key=cluster_key,
            layer_id=layer_id,
            cluster_id=cluster_id,
            topic_label=topic_label,
            size=size,
            sample_comments=sample_comments,
            centroid_coordinates=centroid_coords,
            top_words=top_words,
            top_tfidf_scores=top_tfidf_scores,
            parent_cluster=parent_ref,
            child_clusters=child_refs
        )
        
        return model
    
    @staticmethod
    def create_graph_edge(
        conversation_id: str,
        source_id: int,
        target_id: int,
        weight: float,
        distance: float,
        is_nearest_neighbor: bool,
        shared_layers: List[int],
        position: Optional[np.ndarray] = None
    ) -> UMAPGraphEdge:
        """
        Create a UMAPGraphEdge model from raw data.
        
        Args:
            conversation_id: ID of the conversation
            source_id: ID of the source comment
            target_id: ID of the target comment
            weight: Edge weight
            distance: Edge distance
            is_nearest_neighbor: Whether this is a nearest neighbor edge
            shared_layers: List of layer IDs where both comments are in the same cluster
            position: Optional 2D coordinates for the node (only used when source_id = target_id)
            
        Returns:
            UMAPGraphEdge model object
        """
        # For standard edges (not nodes), ensure source_id < target_id
        if source_id != target_id and source_id > target_id:
            source_id, target_id = target_id, source_id
            
        edge_id = f'{source_id}_{target_id}'
        
        # Create coordinates object if provided and this is a node
        position_coords = None
        if position is not None and source_id == target_id:
            position_coords = Coordinates(
                x=float(position[0]),
                y=float(position[1])
            )
        
        # Create the model
        model = UMAPGraphEdge(
            conversation_id=conversation_id,
            edge_id=edge_id,
            source_id=int(source_id),
            target_id=int(target_id),
            weight=float(weight),
            distance=float(distance),
            is_nearest_neighbor=bool(is_nearest_neighbor),
            shared_cluster_layers=shared_layers,
            position=position_coords
        )
        
        return model
    
    @staticmethod
    def create_cluster_characteristic(
        conversation_id: str,
        layer_id: int,
        cluster_id: int,
        size: int,
        top_words: List[str],
        top_tfidf_scores: List[float],
        sample_comments: List[str]
    ) -> ClusterCharacteristic:
        """
        Create a ClusterCharacteristic model from raw data.
        
        Args:
            conversation_id: ID of the conversation
            layer_id: ID of the layer
            cluster_id: ID of the cluster
            size: Size of the cluster
            top_words: List of top words in the cluster
            top_tfidf_scores: List of TF-IDF scores for the top words
            sample_comments: List of sample comments from the cluster
            
        Returns:
            ClusterCharacteristic model object
        """
        # Create the model
        model = ClusterCharacteristic(
            conversation_id=conversation_id,
            layer_id=layer_id,
            cluster_id=cluster_id,
            size=size,
            top_words=top_words,
            top_tfidf_scores=top_tfidf_scores,
            sample_comments=sample_comments
        )
        
        return model
    
    @staticmethod
    def create_enhanced_topic_name(
        conversation_id: str,
        layer_id: int,
        cluster_id: int,
        topic_name: str
    ) -> EnhancedTopicName:
        """
        Create an EnhancedTopicName model from raw data.
        
        Args:
            conversation_id: ID of the conversation
            layer_id: ID of the layer
            cluster_id: ID of the cluster
            topic_name: Enhanced topic name
            
        Returns:
            EnhancedTopicName model object
        """
        # Create the model
        model = EnhancedTopicName(
            conversation_id=conversation_id,
            layer_id=layer_id,
            cluster_id=cluster_id,
            topic_name=topic_name
        )
        
        return model
    
    @staticmethod
    def create_llm_topic_name(
        conversation_id: str,
        layer_id: int,
        cluster_id: int,
        topic_name: str,
        model_name: str = "unknown",
        job_id: Optional[str] = None  # Added job_id
    ) -> LLMTopicName:
        """
        Create an LLMTopicName model from raw data.
        
        Args:
            conversation_id: ID of the conversation
            layer_id: ID of the layer
            cluster_id: ID of the cluster
            topic_name: LLM-generated topic name
            model_name: Name of the LLM model used
            job_id: ID of the job that generated this topic name
            
        Returns:
            LLMTopicName model object
        """
        if not job_id:
            # Fallback if job_id is not provided, though it should be
            logger.warning("job_id not provided to create_llm_topic_name, using 'unknown_job'")
            job_id = "unknown_job"

        # Create the model
        model = LLMTopicName(
            conversation_id=conversation_id,
            topic_key=f"{job_id}#{layer_id}#{cluster_id}", # New topic_key format
            layer_id=layer_id, # Stored for easier filtering if needed, though part of key
            cluster_id=cluster_id,
            topic_name=topic_name,
            model_name=model_name,
            created_at=datetime.now().isoformat(),
            job_id=job_id # Store job_id as a top-level attribute
        )
        
        return model
    
    @staticmethod
    def batch_convert_cluster_characteristics(
        conversation_id: str,
        characteristics_dict: Dict[str, Dict[str, Any]],
        layer_id: int
    ) -> List[ClusterCharacteristic]:
        """
        Convert batch of cluster characteristics from dictionary to model objects.
        
        Args:
            conversation_id: ID of the conversation
            characteristics_dict: Dictionary of cluster characteristics
            layer_id: Layer ID for the characteristics
            
        Returns:
            List of ClusterCharacteristic model objects
        """
        characteristics = []
        
        for cluster_id_str, characteristic_data in characteristics_dict.items():
            try:
                cluster_id = int(cluster_id_str)
                
                characteristic = DataConverter.create_cluster_characteristic(
                    conversation_id=conversation_id,
                    layer_id=layer_id,
                    cluster_id=cluster_id,
                    size=characteristic_data.get('size', 0),
                    top_words=characteristic_data.get('top_words', []),
                    top_tfidf_scores=characteristic_data.get('top_tfidf_scores', []),
                    sample_comments=characteristic_data.get('sample_comments', [])
                )
                
                characteristics.append(characteristic)
            except (ValueError, KeyError) as e:
                logger.error(f"Error converting cluster characteristic {cluster_id_str}: {e}")
        
        return characteristics
    
    @staticmethod
    def batch_convert_enhanced_topic_names(
        conversation_id: str,
        topic_names_dict: Dict[str, str],
        layer_id: int
    ) -> List[EnhancedTopicName]:
        """
        Convert batch of enhanced topic names from dictionary to model objects.
        
        Args:
            conversation_id: ID of the conversation
            topic_names_dict: Dictionary of enhanced topic names
            layer_id: Layer ID for the topic names
            
        Returns:
            List of EnhancedTopicName model objects
        """
        topic_names = []
        
        for cluster_id_str, topic_name in topic_names_dict.items():
            try:
                cluster_id = int(cluster_id_str)
                
                enhanced_topic_name = DataConverter.create_enhanced_topic_name(
                    conversation_id=conversation_id,
                    layer_id=layer_id,
                    cluster_id=cluster_id,
                    topic_name=topic_name
                )
                
                topic_names.append(enhanced_topic_name)
            except ValueError as e:
                logger.error(f"Error converting enhanced topic name {cluster_id_str}: {e}")
        
        return topic_names
    
    @staticmethod
    def batch_convert_llm_topic_names(
        conversation_id: str,
        topic_names_dict: Dict[str, str],
        layer_id: int,
        model_name: str = "unknown",
        job_id: Optional[str] = None # Added job_id
    ) -> List[LLMTopicName]:
        """
        Convert batch of LLM-generated topic names from dictionary to model objects.
        
        Args:
            conversation_id: ID of the conversation
            topic_names_dict: Dictionary of LLM-generated topic names
            layer_id: Layer ID for the topic names
            model_name: Name of the LLM model used
            job_id: ID of the job that generated these topic names
            
        Returns:
            List of LLMTopicName model objects
        """
        topic_names = []
        
        for cluster_id_str, topic_name in topic_names_dict.items():
            try:
                cluster_id = int(cluster_id_str)
                
                llm_topic_name = DataConverter.create_llm_topic_name(
                    conversation_id=conversation_id,
                    layer_id=layer_id,
                    cluster_id=cluster_id,
                    topic_name=topic_name,
                    model_name=model_name,
                    job_id=job_id
                )
                
                topic_names.append(llm_topic_name)
            except ValueError as e:
                logger.error(f"Error converting LLM topic name {cluster_id_str}: {e}")
        
        return topic_names
    
    @staticmethod
    # ======================================================
    # REMOVED: create_comment_text method
    # Comment texts are stored in PostgreSQL as the single source of truth
    # This eliminates data duplication and ensures data consistency
    # ======================================================
    
    @staticmethod
    def batch_convert_embeddings(
        conversation_id: str,
        document_vectors: np.ndarray
    ) -> List[CommentEmbedding]:
        """
        Convert batch of embeddings from NumPy arrays to model objects.
        
        Args:
            conversation_id: ID of the conversation
            document_vectors: Matrix of embedding vectors
            
        Returns:
            List of CommentEmbedding model objects
        """
        embeddings = []
        
        for i in range(len(document_vectors)):
            # Create model with just the embedding vectors
            # UMAP coordinates and nearest neighbors are stored exclusively in UMAPGraph
            embedding = DataConverter.create_comment_embedding(
                conversation_id=conversation_id,
                comment_id=i,
                vector=document_vectors[i]
            )
            
            embeddings.append(embedding)
        
        return embeddings
        
    @staticmethod
    def batch_convert_umap_edges(
        conversation_id: str,
        document_map: np.ndarray,
        cluster_layers: List[np.ndarray],
        k_neighbors: int = 5
    ) -> List[UMAPGraphEdge]:
        """
        Convert UMAP projection data to graph edges and nodes with positions.
        
        Args:
            conversation_id: ID of the conversation
            document_map: Matrix of 2D coordinates
            cluster_layers: List of cluster label arrays
            k_neighbors: Number of nearest neighbors to store
            
        Returns:
            List of UMAPGraphEdge model objects (both edges and nodes)
        """
        edges = []
        generated_edges = set()
        
        # Calculate threshold distance for significant connections
        all_distances = []
        for i in range(min(100, len(document_map))):
            distances = np.sqrt(np.sum((document_map - document_map[i])**2, axis=1))
            all_distances.extend(distances)
        all_distances = np.array(all_distances)
        distance_threshold = np.percentile(all_distances, 5)  # Bottom 5% of distances
        
        # Generate nodes with positions first
        for i in range(len(document_map)):
            # Create a self-edge (node) with position
            node = DataConverter.create_graph_edge(
                conversation_id=conversation_id,
                source_id=i,
                target_id=i,  # Self-edge = node
                weight=1.0,   # Self-similarity is maximum
                distance=0.0, # Self-distance is zero
                is_nearest_neighbor=False,
                shared_layers=[layer_id for layer_id, layer in enumerate(cluster_layers) 
                              if i < len(layer) and layer[i] >= 0],
                position=document_map[i]  # Store actual UMAP coordinates
            )
            
            edges.append(node)
        
        # Generate edges between nodes
        for i in range(len(document_map)):
            # Find nearest neighbors
            distances = np.sqrt(np.sum((document_map - document_map[i])**2, axis=1))
            nearest_indices = np.argsort(distances)[1:k_neighbors+1]  # Skip self
            nearest_distances = distances[nearest_indices]
            
            for j, (neighbor_idx, distance) in enumerate(zip(nearest_indices, nearest_distances)):
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
                    if (i < len(layer) and neighbor_idx < len(layer) and 
                        layer[i] >= 0 and layer[neighbor_idx] >= 0 and 
                        layer[i] == layer[neighbor_idx]):
                        shared_layers.append(layer_id)
                
                # Create edge
                edge = DataConverter.create_graph_edge(
                    conversation_id=conversation_id,
                    source_id=i,
                    target_id=neighbor_idx,
                    weight=1.0 - distance,  # Convert distance to similarity
                    distance=float(distance),
                    is_nearest_neighbor=True,
                    shared_layers=shared_layers
                )
                
                edges.append(edge)
        
        return edges
    
    @staticmethod
    def batch_convert_clusters(
        conversation_id: str,
        cluster_layers: List[np.ndarray],
        document_map: np.ndarray
    ) -> List[CommentCluster]:
        """
        Convert batch of clusters from NumPy arrays to model objects.
        
        Args:
            conversation_id: ID of the conversation
            cluster_layers: List of cluster label arrays
            document_map: Matrix of 2D coordinates
            
        Returns:
            List of CommentCluster model objects
        """
        clusters = []
        
        # Generate distances to centroids and confidences
        distances_map = {}
        confidence_map = {}
        
        for comment_id in range(len(document_map)):
            distances = {}
            confidences = {}
            
            for layer_id, layer in enumerate(cluster_layers):
                if comment_id < len(layer):
                    cluster_id = layer[comment_id]
                    
                    if cluster_id >= 0:
                        # Find all comments in this cluster
                        cluster_indices = np.where(layer == cluster_id)[0]
                        
                        if len(cluster_indices) > 0:
                            # Calculate centroid
                            centroid = np.mean(document_map[cluster_indices], axis=0)
                            
                            # Calculate distance
                            distance = np.sqrt(np.sum((document_map[comment_id] - centroid)**2))
                            distances[f'layer{layer_id}'] = float(distance)
                            
                            # Simple confidence score based on distance
                            max_distance = 5.0  # Assuming UMAP usually keeps points within this range
                            confidence = max(0.0, min(1.0, 1.0 - (distance / max_distance)))
                            confidences[f'layer{layer_id}'] = float(confidence)
            
            if distances:
                distances_map[comment_id] = distances
            
            if confidences:
                confidence_map[comment_id] = confidences
        
        # Create cluster models
        for comment_id in range(min(len(layer) for layer in cluster_layers) if cluster_layers else 0):
            # Create model
            cluster = DataConverter.create_comment_cluster(
                conversation_id=conversation_id,
                comment_id=comment_id,
                cluster_layers=cluster_layers,
                distances=distances_map.get(comment_id),
                confidences=confidence_map.get(comment_id)
            )
            
            clusters.append(cluster)
        
        return clusters
    
    @staticmethod
    def batch_convert_topics(
        conversation_id: str,
        cluster_layers: List[np.ndarray],
        document_map: np.ndarray,
        topic_names: Dict[str, Dict[str, str]] = None,
        characteristics: Dict[str, Dict[str, Any]] = None,
        comments: List[Dict[str, Any]] = None
    ) -> List[ClusterTopic]:
        """
        Convert batch of topics from raw data to model objects.
        
        Args:
            conversation_id: ID of the conversation
            cluster_layers: List of cluster label arrays
            document_map: Matrix of 2D coordinates
            topic_names: Optional dictionary of topic names by layer and cluster ID
            characteristics: Optional dictionary of cluster characteristics
            comments: Optional list of comment dictionaries
            
        Returns:
            List of ClusterTopic model objects
        """
        topics = []
        
        # Determine parent-child relationships between layers
        parent_child_map = {}
        
        for layer_id in range(len(cluster_layers)):
            if layer_id > 0:
                # This layer has parents
                parent_layer_id = layer_id - 1
                
                # Initialize the parent map for this layer
                if f'layer{layer_id}' not in parent_child_map:
                    parent_child_map[f'layer{layer_id}'] = {'parents': {}, 'children': {}}
                
                # Initialize the children map for the parent layer
                if f'layer{parent_layer_id}' not in parent_child_map:
                    parent_child_map[f'layer{parent_layer_id}'] = {'parents': {}, 'children': {}}
                
                # Create the maps
                for comment_id in range(len(cluster_layers[0])):
                    if comment_id < len(cluster_layers[layer_id]) and comment_id < len(cluster_layers[parent_layer_id]):
                        current_cluster = cluster_layers[layer_id][comment_id]
                        parent_cluster = cluster_layers[parent_layer_id][comment_id]
                        
                        if current_cluster >= 0 and parent_cluster >= 0:
                            # Update parent map
                            if current_cluster not in parent_child_map[f'layer{layer_id}']['parents']:
                                parent_child_map[f'layer{layer_id}']['parents'][current_cluster] = {}
                            
                            if parent_cluster not in parent_child_map[f'layer{layer_id}']['parents'][current_cluster]:
                                parent_child_map[f'layer{layer_id}']['parents'][current_cluster][parent_cluster] = 0
                            
                            parent_child_map[f'layer{layer_id}']['parents'][current_cluster][parent_cluster] += 1
                            
                            # Update children map
                            if parent_cluster not in parent_child_map[f'layer{parent_layer_id}']['children']:
                                parent_child_map[f'layer{parent_layer_id}']['children'][parent_cluster] = {}
                            
                            if current_cluster not in parent_child_map[f'layer{parent_layer_id}']['children'][parent_cluster]:
                                parent_child_map[f'layer{parent_layer_id}']['children'][parent_cluster][current_cluster] = 0
                            
                            parent_child_map[f'layer{parent_layer_id}']['children'][parent_cluster][current_cluster] += 1
        
        # Process each layer
        for layer_id, layer in enumerate(cluster_layers):
            # Get unique clusters (excluding noise)
            unique_clusters = np.unique(layer)
            unique_clusters = unique_clusters[unique_clusters >= 0]
            
            # Get layer characteristics and names
            layer_chars = {}
            if characteristics and f'layer{layer_id}' in characteristics:
                layer_chars = characteristics[f'layer{layer_id}']
            
            layer_names = {}
            if topic_names and f'layer{layer_id}' in topic_names:
                layer_names = topic_names[f'layer{layer_id}']
            
            # Process each cluster
            for cluster_id in unique_clusters:
                cluster_id_int = int(cluster_id)
                
                # Get comments in this cluster
                cluster_indices = np.where(layer == cluster_id)[0]
                
                # Calculate centroid
                centroid = np.mean(document_map[cluster_indices], axis=0) if len(cluster_indices) > 0 else np.zeros(2)
                
                # Get topic name
                topic_label = layer_names.get(str(cluster_id_int), f'Cluster {cluster_id_int}')
                
                # Get sample comments
                sample_comments = []
                if comments:
                    # Try to get actual comments
                    for idx in cluster_indices[:min(3, len(cluster_indices))]:
                        if idx < len(comments):
                            try:
                                comment_text = comments[idx].get('comment', comments[idx].get('body', ''))
                                if comment_text:
                                    sample_comments.append(comment_text)
                            except:
                                pass
                
                # If no actual comments, use placeholders
                if not sample_comments:
                    sample_comments = [f'Sample comment for cluster {cluster_id_int}']
                
                # Get characteristics
                chars = {}
                if str(cluster_id_int) in layer_chars:
                    chars = layer_chars[str(cluster_id_int)]
                
                # Get top words and TF-IDF scores if available
                top_words = chars.get('top_words')
                top_tfidf_scores = chars.get('top_tfidf_scores')
                
                # Determine parent cluster
                parent_cluster = None
                if f'layer{layer_id}' in parent_child_map and 'parents' in parent_child_map[f'layer{layer_id}']:
                    parents = parent_child_map[f'layer{layer_id}']['parents'].get(cluster_id_int, {})
                    if parents:
                        # Get most common parent
                        parent_id = max(parents.items(), key=lambda x: x[1])[0]
                        parent_cluster = {
                            'layer_id': layer_id - 1,
                            'cluster_id': int(parent_id)
                        }
                
                # Determine child clusters
                child_clusters = None
                if f'layer{layer_id}' in parent_child_map and 'children' in parent_child_map[f'layer{layer_id}']:
                    children = parent_child_map[f'layer{layer_id}']['children'].get(cluster_id_int, {})
                    if children:
                        # Get all children
                        child_clusters = [
                            {
                                'layer_id': layer_id + 1,
                                'cluster_id': int(child_id)
                            }
                            for child_id in children.keys()
                        ]
                
                # Create model
                topic = DataConverter.create_cluster_topic(
                    conversation_id=conversation_id,
                    layer_id=layer_id,
                    cluster_id=cluster_id_int,
                    topic_label=topic_label,
                    size=len(cluster_indices),
                    centroid=centroid,
                    sample_comments=sample_comments,
                    top_words=top_words,
                    top_tfidf_scores=top_tfidf_scores,
                    parent_cluster=parent_cluster,
                    child_clusters=child_clusters
                )
                
                topics.append(topic)
        
        return topics