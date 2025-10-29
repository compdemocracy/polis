"""
Tests for the clustering engine.
"""

import numpy as np
import pytest

from polismath_commentgraph.core.clustering import ClusteringEngine


@pytest.fixture
def clustering_engine():
    """Create a clustering engine for testing."""
    return ClusteringEngine()


@pytest.fixture
def sample_embeddings():
    """Create sample embeddings for testing."""
    # Create synthetic embeddings with clear clusters
    np.random.seed(42)

    # Create three clusters
    cluster1 = np.random.randn(20, 10) + np.array([5, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    cluster2 = np.random.randn(15, 10) + np.array([-5, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    cluster3 = np.random.randn(10, 10) + np.array([0, 5, 0, 0, 0, 0, 0, 0, 0, 0])

    # Combine clusters
    embeddings = np.vstack([cluster1, cluster2, cluster3])

    return embeddings


def test_project_to_2d(clustering_engine, sample_embeddings):
    """Test projecting embeddings to 2D."""
    projection = clustering_engine.project_to_2d(sample_embeddings)

    # Check shape and type
    assert isinstance(projection, np.ndarray)
    assert projection.shape == (len(sample_embeddings), 2)

    # Check that the projection is not all zeros
    assert not np.allclose(projection, 0)


def test_project_to_2d_empty(clustering_engine):
    """Test projecting empty embeddings."""
    embeddings = np.array([])
    projection = clustering_engine.project_to_2d(embeddings)

    # Should return an empty array
    assert isinstance(projection, np.ndarray)
    assert projection.shape == (0,)


def test_evoc_cluster(clustering_engine, sample_embeddings):
    """Test clustering embeddings."""
    # First project to 2D
    projection = clustering_engine.project_to_2d(sample_embeddings)

    # Cluster the projection
    cluster_labels, probabilities = clustering_engine.evoc_cluster(projection)

    # Check shape and type
    assert isinstance(cluster_labels, np.ndarray)
    assert isinstance(probabilities, np.ndarray)
    assert cluster_labels.shape == (len(sample_embeddings),)
    assert probabilities.shape == (len(sample_embeddings),)

    # Check that we have at least one cluster
    assert len(np.unique(cluster_labels[cluster_labels >= 0])) > 0

    # Check that probabilities are between 0 and 1
    assert np.all((probabilities >= 0) & (probabilities <= 1))


def test_evoc_cluster_empty(clustering_engine):
    """Test clustering empty embeddings."""
    embeddings = np.array([])
    cluster_labels, probabilities = clustering_engine.evoc_cluster(embeddings)

    # Should return empty arrays
    assert isinstance(cluster_labels, np.ndarray)
    assert isinstance(probabilities, np.ndarray)
    assert cluster_labels.shape == (0,)
    assert probabilities.shape == (0,)


def test_fallback_clustering(clustering_engine, sample_embeddings):
    """Test fallback clustering."""
    # First project to 2D
    projection = clustering_engine.project_to_2d(sample_embeddings)

    # Call fallback clustering directly
    cluster_labels, probabilities = clustering_engine._fallback_clustering(projection)

    # Check shape and type
    assert isinstance(cluster_labels, np.ndarray)
    assert isinstance(probabilities, np.ndarray)
    assert cluster_labels.shape == (len(sample_embeddings),)
    assert probabilities.shape == (len(sample_embeddings),)

    # Check that we have at least two clusters (kmeans defaults to 2+ clusters)
    assert len(np.unique(cluster_labels)) >= 2

    # Check that probabilities are between 0 and 1
    assert np.all((probabilities >= 0) & (probabilities <= 1))


def test_create_clustering_layers(clustering_engine, sample_embeddings):
    """Test creating multiple clustering layers."""
    num_layers = 3
    layers = clustering_engine.create_clustering_layers(sample_embeddings, num_layers=num_layers)

    # Check that we have the right number of layers
    assert len(layers) == num_layers

    # Check that each layer has the right shape
    for layer in layers:
        assert isinstance(layer, np.ndarray)
        assert layer.shape == (len(sample_embeddings),)

    # Check that higher layers have fewer clusters
    if len(layers) > 1:
        for i in range(len(layers) - 1):
            num_clusters_current = len(np.unique(layers[i][layers[i] >= 0]))
            num_clusters_next = len(np.unique(layers[i + 1][layers[i + 1] >= 0]))
            assert num_clusters_current >= num_clusters_next


def test_analyze_cluster(clustering_engine, sample_embeddings):
    """Test analyzing a cluster."""
    # First project to 2D
    projection = clustering_engine.project_to_2d(sample_embeddings)

    # Cluster the projection
    cluster_labels, _ = clustering_engine.evoc_cluster(projection)

    # Get a valid cluster ID
    valid_clusters = np.unique(cluster_labels[cluster_labels >= 0])
    if len(valid_clusters) == 0:
        pytest.skip("No valid clusters found in test data")

    cluster_id = valid_clusters[0]

    # Create sample texts
    texts = [f"Sample text {i}" for i in range(len(sample_embeddings))]

    # Analyze the cluster
    characteristics = clustering_engine.analyze_cluster(texts, cluster_labels, cluster_id)

    # Check that the characteristics include basic information
    assert "size" in characteristics
    assert characteristics["size"] > 0
    assert "sample_comments" in characteristics
    assert len(characteristics["sample_comments"]) > 0
