"""
Tests for the embedding engine.
"""

import numpy as np
import pytest

from polismath_commentgraph.core.embedding import EmbeddingEngine


@pytest.fixture
def embedding_engine():
    """Create an embedding engine for testing."""
    return EmbeddingEngine()


def test_embed_text(embedding_engine):
    """Test embedding a single text."""
    text = "This is a test comment."
    embedding = embedding_engine.embed_text(text)

    # Check shape and type
    assert isinstance(embedding, np.ndarray)
    assert embedding.shape == (embedding_engine.vector_dim,)

    # Check that the embedding is not all zeros
    assert not np.allclose(embedding, 0)


def test_embed_batch(embedding_engine):
    """Test embedding a batch of texts."""
    texts = ["This is the first comment.", "This is the second comment.", "This is the third comment."]
    embeddings = embedding_engine.embed_batch(texts)

    # Check shape and type
    assert isinstance(embeddings, np.ndarray)
    assert embeddings.shape == (len(texts), embedding_engine.vector_dim)

    # Check that embeddings are not all zeros
    assert not np.allclose(embeddings, 0)


def test_embed_empty_text(embedding_engine):
    """Test embedding an empty text."""
    text = ""
    embedding = embedding_engine.embed_text(text)

    # Should return a zero vector
    assert np.allclose(embedding, 0)


def test_embed_empty_batch(embedding_engine):
    """Test embedding an empty batch."""
    texts = []
    embeddings = embedding_engine.embed_batch(texts)

    # Should return an empty array
    assert isinstance(embeddings, np.ndarray)
    assert embeddings.shape == (0,)


def test_calculate_similarity(embedding_engine):
    """Test calculating similarity between embeddings."""
    # Create two similar texts
    text1 = "Dogs are wonderful pets."
    text2 = "I love dogs as pets."

    # Create a dissimilar text
    text3 = "Economic policy affects inflation rates."

    # Get embeddings
    embedding1 = embedding_engine.embed_text(text1)
    embedding2 = embedding_engine.embed_text(text2)
    embedding3 = embedding_engine.embed_text(text3)

    # Calculate similarities
    similarity_similar = embedding_engine.calculate_similarity(embedding1, embedding2)
    similarity_dissimilar = embedding_engine.calculate_similarity(embedding1, embedding3)

    # Similar texts should have higher similarity
    assert similarity_similar > similarity_dissimilar

    # Check that similarity is between -1 and 1
    assert -1.0 <= similarity_similar <= 1.0
    assert -1.0 <= similarity_dissimilar <= 1.0


def test_find_nearest_neighbors(embedding_engine):
    """Test finding nearest neighbors."""
    # Create a set of embeddings
    texts = [
        "Dogs are wonderful pets.",
        "I love dogs as pets.",
        "Cats make great companions.",
        "Economic policy affects inflation rates.",
        "Inflation is a measure of price increases.",
    ]

    embeddings = embedding_engine.embed_batch(texts)

    # Find nearest neighbors for the first embedding
    query_embedding = embeddings[0]
    nearest = embedding_engine.find_nearest_neighbors(query_embedding, embeddings, k=3)

    # Check return values
    assert "indices" in nearest
    assert "distances" in nearest
    assert len(nearest["indices"]) == 3
    assert len(nearest["distances"]) == 3

    # The SentenceTransformer can vary, so don't check exact indices,
    # just verify that the distances are sorted
    assert all(nearest["distances"][i] <= nearest["distances"][i + 1] for i in range(len(nearest["distances"]) - 1))


def test_find_nearest_neighbors_empty(embedding_engine):
    """Test finding nearest neighbors with empty embeddings."""
    query_embedding = np.random.rand(embedding_engine.vector_dim)
    embeddings = np.array([])

    nearest = embedding_engine.find_nearest_neighbors(query_embedding, embeddings)

    assert nearest["indices"] == []
    assert nearest["distances"] == []
