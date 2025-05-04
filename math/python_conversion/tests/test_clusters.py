"""
Tests for the clustering module.
"""

import pytest
import numpy as np
import pandas as pd
import sys
import os
import random

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.math.clusters import (
    Cluster, euclidean_distance, init_clusters, same_clustering,
    assign_points_to_clusters, update_cluster_centers, filter_empty_clusters,
    cluster_step, most_distal, split_cluster, clean_start_clusters,
    kmeans, distance_matrix, silhouette, clusters_to_dict, clusters_from_dict,
    cluster_named_matrix
)
from polismath.math.named_matrix import NamedMatrix


# Set random seed for reproducibility
random.seed(42)
np.random.seed(42)


class TestCluster:
    """Tests for the Cluster class."""
    
    def test_init(self):
        """Test Cluster initialization."""
        center = np.array([1.0, 2.0])
        members = [1, 3, 5]
        cluster = Cluster(center, members, 0)
        
        assert np.array_equal(cluster.center, center)
        assert cluster.members == members
        assert cluster.id == 0
        
        # Test with defaults
        cluster_default = Cluster(center)
        assert np.array_equal(cluster_default.center, center)
        assert cluster_default.members == []
        assert cluster_default.id is None
    
    def test_add_member(self):
        """Test adding a member to a cluster."""
        cluster = Cluster(np.array([1.0, 2.0]))
        
        cluster.add_member(5)
        assert cluster.members == [5]
        
        cluster.add_member(3)
        assert cluster.members == [5, 3]
    
    def test_clear_members(self):
        """Test clearing members from a cluster."""
        cluster = Cluster(np.array([1.0, 2.0]), [1, 2, 3])
        
        cluster.clear_members()
        assert cluster.members == []
    
    def test_update_center(self):
        """Test updating a cluster center."""
        data = np.array([
            [1.0, 1.0],
            [2.0, 2.0],
            [3.0, 3.0]
        ])
        
        # Test unweighted update
        cluster = Cluster(np.array([0.0, 0.0]), [0, 1])
        cluster.update_center(data)
        assert np.allclose(cluster.center, [1.5, 1.5])
        
        # Test weighted update
        weights = np.array([1.0, 3.0, 1.0])
        cluster = Cluster(np.array([0.0, 0.0]), [0, 1])
        cluster.update_center(data, weights)
        # Weighted average: (1*[1,1] + 3*[2,2]) / (1+3) = [1.75, 1.75]
        assert np.allclose(cluster.center, [1.75, 1.75])
        
        # Test empty cluster
        cluster = Cluster(np.array([5.0, 5.0]), [])
        cluster.update_center(data)
        # Center should remain unchanged
        assert np.allclose(cluster.center, [5.0, 5.0])


class TestClusteringUtils:
    """Tests for the clustering utility functions."""
    
    def test_euclidean_distance(self):
        """Test Euclidean distance calculation."""
        a = np.array([1.0, 2.0, 3.0])
        b = np.array([4.0, 5.0, 6.0])
        
        dist = euclidean_distance(a, b)
        # sqrt((4-1)^2 + (5-2)^2 + (6-3)^2) = sqrt(27) = 5.196
        assert np.isclose(dist, 5.196, atol=1e-3)
    
    def test_init_clusters(self):
        """Test cluster initialization."""
        data = np.array([
            [1.0, 1.0],
            [2.0, 2.0],
            [3.0, 3.0],
            [4.0, 4.0],
            [5.0, 5.0]
        ])
        
        # Initialize 3 clusters
        clusters = init_clusters(data, 3)
        
        assert len(clusters) == 3
        for i, cluster in enumerate(clusters):
            assert cluster.id == i
            assert len(cluster.members) == 0
            # Center should be one of the data points
            assert any(np.array_equal(cluster.center, point) for point in data)
        
        # Test when k > n_points
        clusters_large_k = init_clusters(data[:2], 3)
        assert len(clusters_large_k) == 2
        assert clusters_large_k[0].members == [0]
        assert clusters_large_k[1].members == [1]
    
    def test_same_clustering(self):
        """Test checking if clusterings are the same."""
        # Create two identical clusterings
        clusters1 = [
            Cluster(np.array([1.0, 1.0]), [0, 1]),
            Cluster(np.array([3.0, 3.0]), [2, 3])
        ]
        clusters2 = [
            Cluster(np.array([1.0, 1.0]), [0, 1]),
            Cluster(np.array([3.0, 3.0]), [2, 3])
        ]
        
        assert same_clustering(clusters1, clusters2)
        
        # Different number of clusters
        clusters3 = [
            Cluster(np.array([1.0, 1.0]), [0, 1]),
            Cluster(np.array([3.0, 3.0]), [2, 3]),
            Cluster(np.array([5.0, 5.0]), [4])
        ]
        assert not same_clustering(clusters1, clusters3)
        
        # Same number but different centers
        clusters4 = [
            Cluster(np.array([1.1, 1.1]), [0, 1]),
            Cluster(np.array([3.0, 3.0]), [2, 3])
        ]
        assert not same_clustering(clusters1, clusters4)
        
        # Different number of members shouldn't matter
        clusters5 = [
            Cluster(np.array([1.0, 1.0]), [0, 1, 4]),
            Cluster(np.array([3.0, 3.0]), [2, 3])
        ]
        assert same_clustering(clusters1, clusters5)
    
    def test_assign_points_to_clusters(self):
        """Test assigning points to clusters."""
        data = np.array([
            [1.0, 1.0],
            [2.0, 2.0],
            [5.0, 5.0],
            [6.0, 6.0]
        ])
        
        clusters = [
            Cluster(np.array([1.5, 1.5])),
            Cluster(np.array([5.5, 5.5]))
        ]
        
        assign_points_to_clusters(data, clusters)
        
        assert clusters[0].members == [0, 1]
        assert clusters[1].members == [2, 3]
    
    def test_update_cluster_centers(self):
        """Test updating cluster centers."""
        data = np.array([
            [1.0, 1.0],
            [2.0, 2.0],
            [5.0, 5.0],
            [6.0, 6.0]
        ])
        
        clusters = [
            Cluster(np.array([0.0, 0.0]), [0, 1]),
            Cluster(np.array([0.0, 0.0]), [2, 3])
        ]
        
        update_cluster_centers(data, clusters)
        
        assert np.allclose(clusters[0].center, [1.5, 1.5])
        assert np.allclose(clusters[1].center, [5.5, 5.5])
    
    def test_filter_empty_clusters(self):
        """Test filtering empty clusters."""
        clusters = [
            Cluster(np.array([1.0, 1.0]), [0, 1]),
            Cluster(np.array([3.0, 3.0]), []),
            Cluster(np.array([5.0, 5.0]), [2, 3])
        ]
        
        filtered = filter_empty_clusters(clusters)
        
        assert len(filtered) == 2
        assert filtered[0].members == [0, 1]
        assert filtered[1].members == [2, 3]


class TestClusterStep:
    """Tests for the cluster_step function."""
    
    def test_cluster_step(self):
        """Test one step of K-means clustering."""
        data = np.array([
            [1.0, 1.0],
            [2.0, 2.0],
            [5.0, 5.0],
            [6.0, 6.0]
        ])
        
        # Initial clusters with non-optimal centers
        clusters = [
            Cluster(np.array([0.0, 0.0])),
            Cluster(np.array([7.0, 7.0]))
        ]
        
        # Perform one step
        new_clusters = cluster_step(data, clusters)
        
        # Check that assignments and centers were updated
        assert len(new_clusters) == 2
        assert new_clusters[0].members == [0, 1]
        assert new_clusters[1].members == [2, 3]
        assert np.allclose(new_clusters[0].center, [1.5, 1.5])
        assert np.allclose(new_clusters[1].center, [5.5, 5.5])


class TestMostDistal:
    """Tests for the most_distal function."""
    
    def test_most_distal(self):
        """Test finding the most distant point in a cluster."""
        data = np.array([
            [1.0, 1.0],
            [2.0, 2.0],
            [3.0, 3.0],
            [10.0, 10.0]
        ])
        
        # Cluster with center at [2,2] and all points
        cluster = Cluster(np.array([2.0, 2.0]), [0, 1, 2, 3])
        
        # The most distal point should be [10,10]
        distal_idx = most_distal(data, cluster)
        assert distal_idx == 3
        
        # Test with empty cluster
        empty_cluster = Cluster(np.array([2.0, 2.0]), [])
        assert most_distal(data, empty_cluster) == -1


class TestSplitCluster:
    """Tests for the split_cluster function."""
    
    def test_split_cluster(self):
        """Test splitting a cluster into two."""
        data = np.array([
            [1.0, 1.0],
            [2.0, 2.0],
            [3.0, 3.0],
            [10.0, 10.0]
        ])
        
        # Cluster with center at [4,4] and all points
        cluster = Cluster(np.array([4.0, 4.0]), [0, 1, 2, 3], 0)
        
        # Split the cluster
        cluster1, cluster2 = split_cluster(data, cluster)
        
        # Check that the clusters were split
        assert cluster1.id == 0
        assert cluster2.id is None
        
        # The split should separate [0,1,2] from [3]
        assert set(cluster1.members + cluster2.members) == set([0, 1, 2, 3])
        assert len(cluster1.members) > 0
        assert len(cluster2.members) > 0
        
        # Test with singleton cluster
        singleton = Cluster(np.array([1.0, 1.0]), [0], 1)
        c1, c2 = split_cluster(data, singleton)
        assert c1 is singleton
        assert c2 is None


class TestCleanStartClusters:
    """Tests for the clean_start_clusters function."""
    
    def test_clean_start_no_last_clusters(self):
        """Test clean_start_clusters with no previous clusters."""
        data = np.array([
            [1.0, 1.0],
            [2.0, 2.0],
            [5.0, 5.0],
            [6.0, 6.0]
        ])
        
        # Should behave like init_clusters when no last_clusters
        clusters = clean_start_clusters(data, 2)
        
        assert len(clusters) == 2
        assert len(clusters[0].members) == 0
        assert len(clusters[1].members) == 0
    
    def test_clean_start_with_last_clusters(self):
        """Test clean_start_clusters with previous clusters."""
        data = np.array([
            [1.0, 1.0],
            [2.0, 2.0],
            [5.0, 5.0],
            [6.0, 6.0]
        ])
        
        # Previous clusters
        last_clusters = [
            Cluster(np.array([1.5, 1.5]), [0, 1], 0),
            Cluster(np.array([5.5, 5.5]), [2, 3], 1)
        ]
        
        # Same number of clusters
        clusters = clean_start_clusters(data, 2, last_clusters)
        
        assert len(clusters) == 2
        assert clusters[0].id == 0
        assert clusters[1].id == 1
        assert np.allclose(clusters[0].center, [1.5, 1.5])
        assert np.allclose(clusters[1].center, [5.5, 5.5])
        assert clusters[0].members == []  # Members are cleared
        
        # More clusters than before
        clusters_more = clean_start_clusters(data, 3, last_clusters)
        
        assert len(clusters_more) == 3
        
        # Fewer clusters than before
        clusters_fewer = clean_start_clusters(data, 1, last_clusters)
        
        assert len(clusters_fewer) == 1


class TestKMeans:
    """Tests for the kmeans function."""
    
    def test_kmeans_basic(self):
        """Test basic K-means clustering."""
        # Create data with two clear clusters
        data = np.array([
            [1.0, 1.0],
            [1.5, 1.5],
            [5.0, 5.0],
            [5.5, 5.5]
        ])
        
        # Run K-means
        clusters = kmeans(data, 2)
        
        # Should find the two clusters
        assert len(clusters) == 2
        
        # Sort clusters by first coordinate of center
        clusters.sort(key=lambda c: c.center[0])
        
        # Check cluster assignments
        assert set(clusters[0].members) == set([0, 1])
        assert set(clusters[1].members) == set([2, 3])
        
        # Check cluster centers
        assert np.allclose(clusters[0].center, [1.25, 1.25])
        assert np.allclose(clusters[1].center, [5.25, 5.25])
    
    def test_kmeans_weighted(self):
        """Test weighted K-means clustering."""
        # Create data with two clusters but weighted
        data = np.array([
            [1.0, 1.0],  # Weight 1
            [2.0, 2.0],  # Weight 3
            [5.0, 5.0],  # Weight 1
            [6.0, 6.0]   # Weight 1
        ])
        
        weights = np.array([1.0, 3.0, 1.0, 1.0])
        
        # Run weighted K-means
        clusters = kmeans(data, 2, weights=weights)
        
        # Should find the two clusters
        assert len(clusters) == 2
        
        # Sort clusters by first coordinate of center
        clusters.sort(key=lambda c: c.center[0])
        
        # First cluster center should be weighted toward [2,2]
        assert np.allclose(clusters[0].center, [1.75, 1.75], atol=1e-1)
    
    def test_kmeans_empty_data(self):
        """Test K-means with empty data."""
        data = np.array([]).reshape(0, 2)
        
        clusters = kmeans(data, 3)
        assert clusters == []
    
    def test_kmeans_fewer_points_than_k(self):
        """Test K-means when there are fewer points than clusters."""
        data = np.array([
            [1.0, 1.0],
            [5.0, 5.0]
        ])
        
        clusters = kmeans(data, 3)
        assert len(clusters) == 2


class TestSilhouette:
    """Tests for the silhouette function."""
    
    def test_silhouette_coefficient(self):
        """Test silhouette coefficient calculation."""
        # Create data with two clear clusters
        data = np.array([
            [1.0, 1.0],
            [1.5, 1.5],
            [5.0, 5.0],
            [5.5, 5.5]
        ])
        
        # Create ideal clustering
        clusters = [
            Cluster(np.array([1.25, 1.25]), [0, 1]),
            Cluster(np.array([5.25, 5.25]), [2, 3])
        ]
        
        # Calculate silhouette
        s = silhouette(data, clusters)
        
        # Should be close to 1 for well-separated clusters
        assert s > 0.7
        
        # Create bad clustering
        bad_clusters = [
            Cluster(np.array([1.0, 1.0]), [0, 2]),
            Cluster(np.array([5.0, 5.0]), [1, 3])
        ]
        
        # Calculate silhouette
        bad_s = silhouette(data, bad_clusters)
        
        # Should be lower for bad clustering
        assert bad_s < s
    
    def test_silhouette_edge_cases(self):
        """Test silhouette coefficient edge cases."""
        data = np.array([
            [1.0, 1.0],
            [1.5, 1.5],
            [5.0, 5.0],
            [5.5, 5.5]
        ])
        
        # One cluster
        one_cluster = [
            Cluster(np.array([3.0, 3.0]), [0, 1, 2, 3])
        ]
        assert silhouette(data, one_cluster) == 0.0
        
        # Empty data
        empty_data = np.array([]).reshape(0, 2)
        assert silhouette(empty_data, one_cluster) == 0.0
        
        # Singleton clusters
        singleton_clusters = [
            Cluster(np.array([1.0, 1.0]), [0]),
            Cluster(np.array([1.5, 1.5]), [1]),
            Cluster(np.array([5.0, 5.0]), [2]),
            Cluster(np.array([5.5, 5.5]), [3])
        ]
        assert silhouette(data, singleton_clusters) == 0.0


class TestClusterSerialization:
    """Tests for cluster serialization functions."""
    
    def test_clusters_to_dict(self):
        """Test converting clusters to dictionary format."""
        clusters = [
            Cluster(np.array([1.0, 1.0]), [0, 1], 0),
            Cluster(np.array([5.0, 5.0]), [2, 3], 1)
        ]
        
        # Convert to dict
        clusters_dict = clusters_to_dict(clusters)
        
        assert len(clusters_dict) == 2
        assert clusters_dict[0]['id'] == 0
        assert clusters_dict[0]['center'] == [1.0, 1.0]
        assert clusters_dict[0]['members'] == [0, 1]
        
        # Test with data indices
        indices = ['a', 'b', 'c', 'd']
        clusters_dict_names = clusters_to_dict(clusters, indices)
        
        assert clusters_dict_names[0]['members'] == ['a', 'b']
        assert clusters_dict_names[1]['members'] == ['c', 'd']
    
    def test_clusters_from_dict(self):
        """Test converting dictionary format to clusters."""
        clusters_dict = [
            {'id': 0, 'center': [1.0, 1.0], 'members': ['a', 'b']},
            {'id': 1, 'center': [5.0, 5.0], 'members': ['c', 'd']}
        ]
        
        # Convert to clusters without index map
        clusters = clusters_from_dict(clusters_dict)
        
        assert len(clusters) == 2
        assert clusters[0].id == 0
        assert np.array_equal(clusters[0].center, [1.0, 1.0])
        assert clusters[0].members == ['a', 'b']
        
        # Test with index map
        index_map = {'a': 0, 'b': 1, 'c': 2, 'd': 3}
        clusters_mapped = clusters_from_dict(clusters_dict, index_map)
        
        assert clusters_mapped[0].members == [0, 1]
        assert clusters_mapped[1].members == [2, 3]


class TestClusterNamedMatrix:
    """Tests for clustering a NamedMatrix."""
    
    def test_cluster_named_matrix(self):
        """Test clustering a NamedMatrix."""
        # Create a NamedMatrix
        data = np.array([
            [1.0, 1.0],
            [1.5, 1.5],
            [5.0, 5.0],
            [5.5, 5.5]
        ])
        rownames = ['a', 'b', 'c', 'd']
        colnames = ['x', 'y']
        
        nmat = NamedMatrix(data, rownames, colnames)
        
        # Cluster the matrix
        clusters_dict = cluster_named_matrix(nmat, 2)
        
        assert len(clusters_dict) == 2
        
        # Check that all row names are in clusters
        all_members = []
        for cluster in clusters_dict:
            all_members.extend(cluster['members'])
        
        assert set(all_members) == set(rownames)
        
        # Test with weights
        weights = {'a': 1.0, 'b': 3.0, 'c': 1.0, 'd': 1.0}
        clusters_weighted = cluster_named_matrix(nmat, 2, weights=weights)
        
        assert len(clusters_weighted) == 2