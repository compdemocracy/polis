"""
DynamoDB schema definitions for Polis comment graph microservice.
"""

from typing import Dict, List, Optional, Any, Union
from datetime import datetime
from pydantic import BaseModel, Field, root_validator


class UMAPParameters(BaseModel):
    """UMAP configuration parameters."""
    n_components: int = 2
    metric: str = "cosine"
    n_neighbors: int = 15
    min_dist: float = 0.1


class EVOCParameters(BaseModel):
    """EVOC clustering parameters."""
    min_samples: int = 5
    min_cluster_size: int = 5


class ClusterLayer(BaseModel):
    """Information about a clustering layer."""
    layer_id: int
    num_clusters: int
    description: str


class Coordinates(BaseModel):
    """2D coordinates for UMAP projection."""
    x: float
    y: float


class Embedding(BaseModel):
    """Vector embedding for a comment."""
    vector: List[float]
    dimensions: int
    model: str


class ClusterReference(BaseModel):
    """Reference to a cluster in another layer."""
    layer_id: int
    cluster_id: int


class ConversationMeta(BaseModel):
    """Metadata for a conversation."""
    conversation_id: str
    processed_date: str
    num_comments: int
    num_participants: int = 0
    embedding_model: str
    umap_parameters: UMAPParameters
    evoc_parameters: EVOCParameters
    cluster_layers: List[ClusterLayer]
    metadata: Dict[str, Any] = {}


class CommentEmbedding(BaseModel):
    """Embedding vector for a single comment.
    
    Note: UMAP coordinates are stored as "position" in UMAPGraph table where source_id = target_id = comment_id.
    Nearest neighbors are stored as edges in UMAPGraph where either source_id or target_id = comment_id."""
    # Natural business keys (backwards compatible)
    conversation_id: str
    comment_id: int
    
    # Job relationship fields (optional for backwards compatibility)
    job_id: Optional[str] = None
    parent_job_id: Optional[str] = None
    root_job_id: Optional[str] = None
    job_stage: Optional[str] = None
    
    # Embedding data
    embedding: Embedding
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())


class CommentCluster(BaseModel):
    """Cluster assignments for a single comment across layers."""
    # Natural business keys (backwards compatible)
    conversation_id: str
    comment_id: int
    
    # Job relationship fields (optional for backwards compatibility)
    job_id: Optional[str] = None
    parent_job_id: Optional[str] = None
    root_job_id: Optional[str] = None
    job_stage: Optional[str] = None
    
    # Cluster assignment fields
    is_outlier: bool = False
    layer0_cluster_id: Optional[int] = None
    layer1_cluster_id: Optional[int] = None
    layer2_cluster_id: Optional[int] = None
    layer3_cluster_id: Optional[int] = None
    layer4_cluster_id: Optional[int] = None
    distance_to_centroid: Optional[Dict[str, float]] = None
    cluster_confidence: Optional[Dict[str, float]] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())


class ClusterTopic(BaseModel):
    """Topic information for a cluster."""
    conversation_id: str
    cluster_key: str  # format: "layer{layer_id}_{cluster_id}"
    layer_id: int
    cluster_id: int
    topic_label: str
    size: int
    sample_comments: List[str]
    centroid_coordinates: Coordinates
    top_words: Optional[List[str]] = None
    top_tfidf_scores: Optional[List[float]] = None
    parent_cluster: Optional[ClusterReference] = None
    child_clusters: Optional[List[ClusterReference]] = None
    
    # Job relationship fields (optional for backwards compatibility)
    job_id: Optional[str] = None
    parent_job_id: Optional[str] = None
    root_job_id: Optional[str] = None
    job_stage: Optional[str] = None


class UMAPGraphEdge(BaseModel):
    """Edge in the UMAP graph structure.
    
    Note: When source_id equals target_id, this represents a node with its position.
    Otherwise, this represents an edge between two nodes."""
    # Natural business keys (backwards compatible)
    conversation_id: str
    edge_id: str  # format: "{source_id}_{target_id}"
    
    # Job relationship fields (optional for backwards compatibility)
    job_id: Optional[str] = None
    parent_job_id: Optional[str] = None
    root_job_id: Optional[str] = None
    job_stage: Optional[str] = None
    
    # Edge data fields
    source_id: int
    target_id: int
    weight: float
    distance: float
    is_nearest_neighbor: bool = True
    shared_cluster_layers: List[int] = []
    position: Optional[Coordinates] = None  # Only present when source_id = target_id
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())


class ClusterCharacteristic(BaseModel):
    """Characteristics of a cluster based on TF-IDF analysis."""
    # Natural business keys (backwards compatible)
    conversation_id: str
    cluster_key: str  # format: "layer{layer_id}_{cluster_id}"
    
    # Job correlation field (optional for backwards compatibility) 
    job_id: Optional[str] = None
    
    # Cluster data fields
    layer_id: int
    cluster_id: int
    size: int
    top_words: List[str]
    top_tfidf_scores: List[float]
    sample_comments: List[str]
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    
    @root_validator(pre=True)
    def create_cluster_key(cls, values):
        """Create the cluster_key if not provided."""
        if "cluster_key" not in values and "layer_id" in values and "cluster_id" in values:
            values["cluster_key"] = f"layer{values['layer_id']}_{values['cluster_id']}"
        return values


class EnhancedTopicName(BaseModel):
    """Enhanced topic name with keywords, based on TF-IDF analysis."""
    # Natural business keys (backwards compatible)
    conversation_id: str
    topic_key: str  # format: "layer{layer_id}_{cluster_id}"
    
    # Job correlation field (optional for backwards compatibility)
    job_id: Optional[str] = None
    
    # Topic data fields
    layer_id: int
    cluster_id: int
    topic_name: str  # Format: "Keywords: word1, word2, word3, ..."
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    
    @root_validator(pre=True)
    def create_topic_key(cls, values):
        """Create the topic_key if not provided."""
        if "topic_key" not in values and "layer_id" in values and "cluster_id" in values:
            values["topic_key"] = f"layer{values['layer_id']}_{values['cluster_id']}"
        return values


class LLMTopicName(BaseModel):
    """LLM-generated topic name."""
    # Natural business keys (backwards compatible)
    conversation_id: str
    topic_key: str  # format: "layer{layer_id}_{cluster_id}"
    
    # Job correlation field (optional for backwards compatibility)
    job_id: Optional[str] = None
    
    # Topic data fields
    layer_id: int
    cluster_id: int
    topic_name: str  # LLM-generated name
    model_name: str = "unknown"  # Name of the LLM model used
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    
    @root_validator(pre=True)
    def create_topic_key(cls, values):
        """Create the topic_key if not provided."""
        if "topic_key" not in values and "layer_id" in values and "cluster_id" in values:
            values["topic_key"] = f"layer{values['layer_id']}_{values['cluster_id']}"
        return values


class CommentText(BaseModel):
    """Original comment text and metadata."""
    conversation_id: str
    comment_id: int
    body: str
    created: Optional[str] = None
    author_id: Optional[str] = None
    agree_vote_count: Optional[int] = 0
    disagree_vote_count: Optional[int] = 0
    pass_vote_count: Optional[int] = 0
    meta: Dict[str, Any] = {}


class CommentMetadata(BaseModel):
    """Metadata for a comment."""
    is_seed: bool = False
    is_moderated: bool = True
    moderation_status: str = "approved"


# Request and response models for the API
class CommentRequest(BaseModel):
    """Request model for submitting a new comment."""
    text: str
    conversation_id: str
    author_id: Optional[str] = None
    created: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class EmbeddingResponse(BaseModel):
    """Response model for comment embedding."""
    embedding: List[float]
    comment_id: int
    conversation_id: str


class ClusterAssignmentResponse(BaseModel):
    """Response model for cluster assignments."""
    comment_id: int
    conversation_id: str
    cluster_assignments: Dict[str, int]  # layer_id -> cluster_id
    confidence_scores: Dict[str, float]  # layer_id -> confidence


class SimilarCommentResponse(BaseModel):
    """Response model for similar comments."""
    comment_id: int
    similarity: float
    text: Optional[str] = None


class RoutingResponse(BaseModel):
    """Response model for comment routing."""
    embedding: List[float]
    similar_comments: List[SimilarCommentResponse]
    predicted_clusters: Dict[str, Dict[str, Union[int, float]]]  # layer_id -> {cluster_id, confidence}


class VisualizationDataResponse(BaseModel):
    """Response model for visualization data."""
    conversation_id: str
    layer_id: int
    comments: List[Dict[str, Any]]
    clusters: List[Dict[str, Any]]
    
    
class CommentExtremity(BaseModel):
    """Extremity values for a comment."""
    conversation_id: str
    comment_id: str
    extremity_value: float  # Raw max difference
    calculation_method: str  # e.g. "max_vote_diff"
    calculation_timestamp: str = Field(default_factory=lambda: datetime.now().isoformat())
    component_values: Dict[str, float]  # {"agree_diff": 0.5, "disagree_diff": 0.3, "pass_diff": 0.1}