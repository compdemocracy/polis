"""
Tests for the DynamoDB storage utility.
"""

from contextlib import contextmanager
from unittest.mock import patch

import pytest

from polismath_commentgraph.schemas.dynamo_models import (
    ClusterLayer,
    CommentEmbedding,
    ConversationMeta,
    Coordinates,
    Embedding,
    EVOCParameters,
    UMAPParameters,
)
from polismath_commentgraph.utils.storage import DynamoDBStorage


class MockTable:
    """Mock DynamoDB table for testing."""

    def __init__(self, name):
        self.name = name
        self.items = {}

    def put_item(self, item):
        """Mock put_item method."""
        key_schema = {
            "Delphi_UMAPConversationConfig": ("conversation_id",),
            "Delphi_CommentEmbeddings": ("conversation_id", "comment_id"),
            "Delphi_CommentHierarchicalClusterAssignments": ("conversation_id", "comment_id"),
            "Delphi_CommentClustersStructureKeywords": ("conversation_id", "cluster_key"),
            "Delphi_UMAPGraph": ("conversation_id", "edge_id"),
            "CommentTexts": ("conversation_id", "comment_id"),
        }

        # Create a key based on the table's key schema
        if self.name in key_schema:
            key_attrs = key_schema[self.name]
            key = tuple(item[attr] for attr in key_attrs)
            self.items[key] = item
            return {"ResponseMetadata": {"HTTPStatusCode": 200}}
        else:
            raise Exception(f"Unknown table: {self.name}")

    def get_item(self, key):
        """Mock get_item method."""
        key_schema = {
            "Delphi_UMAPConversationConfig": ("conversation_id",),
            "Delphi_CommentEmbeddings": ("conversation_id", "comment_id"),
            "Delphi_CommentHierarchicalClusterAssignments": ("conversation_id", "comment_id"),
            "Delphi_CommentClustersStructureKeywords": ("conversation_id", "cluster_key"),
            "Delphi_UMAPGraph": ("conversation_id", "edge_id"),
            "CommentTexts": ("conversation_id", "comment_id"),
        }

        if self.name in key_schema:
            key_attrs = key_schema[self.name]
            key = tuple(key[attr] for attr in key_attrs)
            if key in self.items:
                return {"Item": self.items[key]}
            else:
                return {}
        else:
            raise Exception(f"Unknown table: {self.name}")

    def query(self, **kwargs):
        """Mock query method."""
        # Simple implementation that returns all items
        return {"Items": list(self.items.values())}

    def scan(self, **kwargs):
        """Mock scan method."""
        # Simple implementation that returns all items
        return {"Items": list(self.items.values())}

    @contextmanager
    def batch_writer(self):
        """Mock batch_writer context manager."""
        yield self


class MockDynamoDB:
    """Mock DynamoDB for testing."""

    def __init__(self):
        self.tables = {
            "Delphi_UMAPConversationConfig": MockTable("Delphi_UMAPConversationConfig"),
            "Delphi_CommentEmbeddings": MockTable("Delphi_CommentEmbeddings"),
            "Delphi_CommentHierarchicalClusterAssignments": MockTable("Delphi_CommentHierarchicalClusterAssignments"),
            "Delphi_CommentClustersStructureKeywords": MockTable("Delphi_CommentClustersStructureKeywords"),
            "Delphi_UMAPGraph": MockTable("Delphi_UMAPGraph"),
            "CommentTexts": MockTable("CommentTexts"),
        }

    def table(self, name):
        """Mock Table method."""
        if name in self.tables:
            return self.tables[name]
        else:
            raise Exception(f"Table not found: {name}")


# Create a patch for boto3
@pytest.fixture
def mock_dynamodb():
    """Mock DynamoDB resource."""
    with patch("boto3.resource") as mock_resource:
        mock_db = MockDynamoDB()
        mock_resource.return_value = mock_db
        yield mock_db


@pytest.fixture
def storage(mock_dynamodb):
    """Create a DynamoDBStorage instance with mocked DynamoDB."""
    return DynamoDBStorage(region_name="us-east-1")


def test_create_conversation_meta(storage, test_conversation_id):
    """Test creating conversation metadata."""

    # Create a sample ConversationMeta
    meta = ConversationMeta(
        conversation_id=test_conversation_id,
        processed_date="2023-04-01T12:00:00Z",
        num_comments=100,
        num_participants=50,
        embedding_model="all-MiniLM-L6-v2",
        umap_parameters=UMAPParameters(),
        evoc_parameters=EVOCParameters(),
        cluster_layers=[ClusterLayer(layer_id=0, num_clusters=10, description="Fine-grained")],
        metadata={"title": "Test Conversation"},
    )

    # Store the metadata
    result = storage.create_conversation_meta(meta)

    # Check result
    assert result is True

    # Retrieve the metadata
    retrieved = storage.get_conversation_meta(test_conversation_id)

    # Check retrieved data
    assert retrieved is not None
    assert retrieved["conversation_id"] == test_conversation_id
    assert retrieved["num_comments"] == 100
    assert retrieved["metadata"]["title"] == "Test Conversation"


def test_create_comment_embedding(storage, test_conversation_id):
    """Test creating a comment embedding."""

    # Create a sample CommentEmbedding
    embedding = CommentEmbedding(
        conversation_id=test_conversation_id,
        comment_id=42,
        embedding=Embedding(vector=[0.1, 0.2, 0.3], dimensions=3, model="all-MiniLM-L6-v2"),
        umap_coordinates=Coordinates(x=1.0, y=2.0),
        nearest_neighbors=[43, 44, 45],
        nearest_distances=[0.1, 0.2, 0.3],
    )

    # Store the embedding
    result = storage.create_comment_embedding(embedding)

    # Check result
    assert result is True

    # Retrieve the embedding
    retrieved = storage.get_comment_embedding(test_conversation_id, 42)

    # Check retrieved data
    assert retrieved is not None
    assert retrieved["conversation_id"] == test_conversation_id
    assert retrieved["comment_id"] == 42
    assert retrieved["embedding"]["vector"] == [0.1, 0.2, 0.3]
    assert retrieved["umap_coordinates"]["x"] == 1.0
    assert retrieved["nearest_neighbors"] == [43, 44, 45]


def test_batch_create_comment_embeddings(storage, test_conversation_id):
    """Test batch creating comment embeddings."""

    # Create sample CommentEmbeddings
    embeddings = []
    for i in range(3):
        embedding = CommentEmbedding(
            conversation_id=test_conversation_id,
            comment_id=i,
            embedding=Embedding(vector=[0.1 * i, 0.2 * i, 0.3 * i], dimensions=3, model="all-MiniLM-L6-v2"),
            umap_coordinates=Coordinates(x=1.0 * i, y=2.0 * i),
            nearest_neighbors=[i + 1, i + 2, i + 3],
            nearest_distances=[0.1, 0.2, 0.3],
        )
        embeddings.append(embedding)

    # Store the embeddings
    result = storage.batch_create_comment_embeddings(embeddings)

    # Check result
    assert result["success"] == 3
    assert result["failure"] == 0

    # Retrieve the embeddings
    for i in range(3):
        retrieved = storage.get_comment_embedding(test_conversation_id, i)

        # Check retrieved data
        assert retrieved is not None
        assert retrieved["conversation_id"] == test_conversation_id
        assert retrieved["comment_id"] == i
        assert retrieved["embedding"]["vector"] == [0.1 * i, 0.2 * i, 0.3 * i]
