"""
DynamoDB schema definitions for Polis comment graph microservice.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, model_validator


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

    vector: list[float]
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
    cluster_layers: list[ClusterLayer]
    metadata: dict[str, Any] = {}


class CommentEmbedding(BaseModel):
    """Embedding vector for a single comment.

    Note: UMAP coordinates are stored as "position" in UMAPGraph table where source_id = target_id = comment_id.
    Nearest neighbors are stored as edges in UMAPGraph where either source_id or target_id = comment_id.
    """

    conversation_id: str
    comment_id: int
    embedding: Embedding


class CommentCluster(BaseModel):
    """Cluster assignments for a single comment across layers."""

    conversation_id: str
    comment_id: int
    is_outlier: bool = False
    # We'll add layer-specific cluster IDs dynamically during initialization
    layer0_cluster_id: int | None = None
    layer1_cluster_id: int | None = None
    layer2_cluster_id: int | None = None
    layer3_cluster_id: int | None = None
    layer4_cluster_id: int | None = None
    distance_to_centroid: dict[str, float] | None = None
    cluster_confidence: dict[str, float] | None = None


class ClusterTopic(BaseModel):
    """Topic information for a cluster."""

    conversation_id: str
    cluster_key: str  # format: "layer{layer_id}_{cluster_id}"
    layer_id: int
    cluster_id: int
    topic_label: str
    size: int
    sample_comments: list[str]
    centroid_coordinates: Coordinates
    top_words: list[str] | None = None
    top_tfidf_scores: list[float] | None = None
    parent_cluster: ClusterReference | None = None
    child_clusters: list[ClusterReference] | None = None


class UMAPGraphEdge(BaseModel):
    """Edge in the UMAP graph structure.

    Note: When source_id equals target_id, this represents a node with its position.
    Otherwise, this represents an edge between two nodes."""

    conversation_id: str
    edge_id: str  # format: "{source_id}_{target_id}"
    source_id: int
    target_id: int
    weight: float
    distance: float
    is_nearest_neighbor: bool = True
    shared_cluster_layers: list[int] = []
    position: Coordinates | None = None  # Only present when source_id = target_id


class ClusterCharacteristic(BaseModel):
    """Characteristics of a cluster based on TF-IDF analysis."""

    conversation_id: str
    cluster_key: str | None = None  # format: "layer{layer_id}_{cluster_id}" - auto-generated
    layer_id: int
    cluster_id: int
    size: int
    top_words: list[str]
    top_tfidf_scores: list[float]
    sample_comments: list[str]

    @model_validator(mode="before")
    @classmethod
    def create_cluster_key(cls, values: Any) -> Any:
        """Create the cluster_key if not provided."""
        if isinstance(values, dict):
            if "cluster_key" not in values and "layer_id" in values and "cluster_id" in values:
                values["cluster_key"] = f"layer{values['layer_id']}_{values['cluster_id']}"
        return values


class EnhancedTopicName(BaseModel):
    """Enhanced topic name with keywords, based on TF-IDF analysis."""

    conversation_id: str
    topic_key: str | None = None  # format: "layer{layer_id}_{cluster_id}" - auto-generated
    layer_id: int
    cluster_id: int
    topic_name: str  # Format: "Keywords: word1, word2, word3, ..."

    @model_validator(mode="before")
    @classmethod
    def create_topic_key(cls, values: Any) -> Any:
        """Create the topic_key if not provided."""
        if isinstance(values, dict):
            if "topic_key" not in values and "layer_id" in values and "cluster_id" in values:
                values["topic_key"] = f"layer{values['layer_id']}_{values['cluster_id']}"
        return values


class LLMTopicName(BaseModel):
    """LLM-generated topic name."""

    conversation_id: str
    topic_key: str | None = None  # format: "layer{layer_id}_{cluster_id}" - auto-generated
    layer_id: int
    cluster_id: int
    topic_name: str  # LLM-generated name
    model_name: str = "unknown"  # Name of the LLM model used
    job_id: str | None = None  # ID of the job that generated this topic name
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())

    @model_validator(mode="before")
    @classmethod
    def create_topic_key(cls, values: Any) -> Any:
        """Create the topic_key if not provided."""
        if isinstance(values, dict):
            if "topic_key" not in values and "layer_id" in values and "cluster_id" in values:
                values["topic_key"] = f"layer{values['layer_id']}_{values['cluster_id']}"
        return values


class CommentText(BaseModel):
    """Original comment text and metadata."""

    conversation_id: str
    comment_id: int
    body: str
    created: str | None = None
    author_id: str | None = None
    agree_vote_count: int | None = 0
    disagree_vote_count: int | None = 0
    pass_vote_count: int | None = 0
    meta: dict[str, Any] = {}


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
    author_id: str | None = None
    created: str | None = None
    metadata: dict[str, Any] | None = None


class EmbeddingResponse(BaseModel):
    """Response model for comment embedding."""

    embedding: list[float]
    comment_id: int
    conversation_id: str


class ClusterAssignmentResponse(BaseModel):
    """Response model for cluster assignments."""

    comment_id: int
    conversation_id: str
    cluster_assignments: dict[str, int]  # layer_id -> cluster_id
    confidence_scores: dict[str, float]  # layer_id -> confidence


class SimilarCommentResponse(BaseModel):
    """Response model for similar comments."""

    comment_id: int
    similarity: float
    text: str | None = None


class RoutingResponse(BaseModel):
    """Response model for comment routing."""

    embedding: list[float]
    similar_comments: list[SimilarCommentResponse]
    predicted_clusters: dict[str, dict[str, int | float]]  # layer_id -> {cluster_id, confidence}


class VisualizationDataResponse(BaseModel):
    """Response model for visualization data."""

    conversation_id: str
    layer_id: int
    comments: list[dict[str, Any]]
    clusters: list[dict[str, Any]]


class CommentExtremity(BaseModel):
    """Extremity values for a comment."""

    conversation_id: str
    comment_id: str
    extremity_value: float  # Raw max difference
    calculation_method: str  # e.g. "max_vote_diff"
    calculation_timestamp: str = Field(default_factory=lambda: datetime.now().isoformat())
    component_values: dict[str, float]  # {"agree_diff": 0.5, "disagree_diff": 0.3, "pass_diff": 0.1}
