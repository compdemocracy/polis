"""
Comparison of custom K-means implementation with scikit-learn's KMeans.

This test compares the performance and results of our custom K-means implementation
from polismath.math.clusters with scikit-learn's KMeans implementation.
"""

import sys
import os
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.datasets import make_blobs
import time
import pytest

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.math.clusters import (
    Cluster, init_clusters, kmeans, silhouette, cluster_named_matrix
)
from polismath.math.named_matrix import NamedMatrix

# Set random seed for reproducibility
np.random.seed(42)


def generate_test_data(n_samples=200, n_features=2, n_clusters=3, cluster_std=1.0):
    """Generate synthetic test data with known clusters."""
    X, y = make_blobs(
        n_samples=n_samples,
        n_features=n_features,
        centers=n_clusters,
        cluster_std=cluster_std,
        random_state=42
    )
    return X, y


def test_initialization_consistency():
    """Test that the initialization produces similar assignments between implementations."""
    # Generate test data
    X, _ = generate_test_data(n_samples=100, n_clusters=4)
    
    # Initialize clusters with our custom method
    clusters = init_clusters(X, 4)
    
    # Extract centers for sklearn initialization
    initial_centers = np.array([cluster.center for cluster in clusters])
    
    # Assign points using our implementation
    for cluster in clusters:
        cluster.clear_members()
    
    # Assign points to clusters
    for i, point in enumerate(X):
        min_dist = float('inf')
        nearest_cluster = None
        
        for cluster in clusters:
            dist = np.linalg.norm(point - cluster.center)
            if dist < min_dist:
                min_dist = dist
                nearest_cluster = cluster
        
        if nearest_cluster is not None:
            nearest_cluster.add_member(i)
    
    # Get assignments from our implementation
    custom_assignments = np.zeros(X.shape[0], dtype=int)
    for i, cluster in enumerate(clusters):
        for member in cluster.members:
            custom_assignments[member] = i
            
    # Run sklearn with same initial centers and minimum iterations
    sklearn_kmeans = KMeans(
        n_clusters=4,
        init=initial_centers,
        n_init=1,
        max_iter=1  # Minimum allowed value
    )
    sklearn_kmeans.fit(X)
    sklearn_labels = sklearn_kmeans.labels_
    
    # Match the clusters (since labels may be different)
    mapping = {}
    for i in range(4):  # For each of our clusters
        if i in custom_assignments:  # If this cluster has any points assigned
            # Find points in this cluster
            points_in_cluster = np.where(custom_assignments == i)[0]
            # Find the most common sklearn label for these points
            sklearn_labels_for_cluster = sklearn_labels[points_in_cluster]
            most_common = np.bincount(sklearn_labels_for_cluster).argmax()
            mapping[i] = most_common
    
    # Map our assignments to sklearn's labeling scheme
    mapped_assignments = np.array([mapping.get(a, -1) for a in custom_assignments])
    
    # Calculate agreement percentage
    agreement = np.mean(mapped_assignments == sklearn_labels) * 100
    print(f"Assignment agreement: {agreement:.2f}%")
    
    # We should have fairly high agreement (at least 80%)
    assert agreement > 80.0, f"Assignment agreement too low: {agreement:.2f}%"


def test_clustering_results():
    """Test that clustering results are similar between implementations."""
    # Generate several test datasets
    datasets = [
        generate_test_data(n_samples=50, n_features=2, n_clusters=3, cluster_std=0.5),
        generate_test_data(n_samples=100, n_features=5, n_clusters=4, cluster_std=1.0),
        generate_test_data(n_samples=200, n_features=10, n_clusters=6, cluster_std=1.5),
    ]
    
    for i, (X, true_labels) in enumerate(datasets):
        # Initialize clusters with our custom method
        custom_clusters = init_clusters(X, len(np.unique(true_labels)))
        
        # Extract centers for sklearn initialization
        initial_centers = np.array([cluster.center for cluster in custom_clusters])
        
        # Run our custom kmeans
        start_time_custom = time.time()
        custom_result = kmeans(X, len(np.unique(true_labels)), max_iters=20)
        custom_time = time.time() - start_time_custom
        
        # Extract custom assignments and centers
        custom_assignments = np.zeros(X.shape[0], dtype=int)
        for j, cluster in enumerate(custom_result):
            for member in cluster.members:
                custom_assignments[member] = j
        
        custom_centers = np.array([cluster.center for cluster in custom_result])
        
        # Run sklearn kmeans with our initial centers
        start_time_sklearn = time.time()
        sklearn_kmeans = KMeans(
            n_clusters=len(np.unique(true_labels)),
            init=initial_centers,
            n_init=1,
            max_iter=20
        )
        sklearn_result = sklearn_kmeans.fit(X)
        sklearn_time = time.time() - start_time_sklearn
        
        # Extract sklearn assignments and centers
        sklearn_assignments = sklearn_result.labels_
        sklearn_centers = sklearn_result.cluster_centers_
        
        # Calculate silhouette scores
        if len(np.unique(custom_assignments)) > 1:  # Only if more than one cluster has elements
            custom_silhouette = silhouette(X, custom_result)
            sklearn_silhouette = silhouette_score(X, sklearn_assignments)
        else:
            custom_silhouette = 0
            sklearn_silhouette = 0
        
        # Print results
        print(f"\nDataset {i+1} Results:")
        print(f"Custom KMeans time: {custom_time:.5f}s")
        print(f"Sklearn KMeans time: {sklearn_time:.5f}s")
        print(f"Custom silhouette: {custom_silhouette:.5f}")
        print(f"Sklearn silhouette: {sklearn_silhouette:.5f}")
        
        # Calculate assignment similarity
        # Map cluster ids to match between implementations (greedy matching)
        mapping = {}
        for clust_id in range(len(np.unique(custom_assignments))):
            mask = custom_assignments == clust_id
            if np.any(mask):
                # Find most common sklearn_cluster for points in this custom cluster
                sklearn_clusters = sklearn_assignments[mask]
                most_common = np.bincount(sklearn_clusters).argmax()
                mapping[clust_id] = most_common
        
        # Apply mapping
        mapped_custom = np.array([mapping.get(a, a) for a in custom_assignments])
        
        # Calculate agreement percentage (after mapping)
        agreement = np.mean(mapped_custom == sklearn_assignments) * 100
        print(f"Assignment agreement: {agreement:.2f}%")
        
        # Compare cluster centers
        center_diffs = []
        for custom_center in custom_centers:
            # Find closest sklearn center
            min_dist = min(np.linalg.norm(custom_center - sklearn_center) 
                         for sklearn_center in sklearn_centers)
            center_diffs.append(min_dist)
        
        avg_center_diff = np.mean(center_diffs)
        print(f"Average center difference: {avg_center_diff:.5f}")
        
        # Assert reasonable agreement
        assert agreement > 80.0, f"Assignment agreement too low: {agreement:.2f}%"
        assert avg_center_diff < 0.5, f"Center difference too high: {avg_center_diff:.5f}"
        assert abs(custom_silhouette - sklearn_silhouette) < 0.2, f"Silhouette scores differ too much"


def test_weighted_clustering():
    """Test weighted clustering comparison."""
    # Generate test data
    X, true_labels = generate_test_data(n_samples=100, n_clusters=3)
    
    # Generate random weights
    weights = np.random.rand(X.shape[0]) * 5 + 0.5  # Weights between 0.5 and 5.5
    
    # Initialize clusters with our custom method
    custom_clusters = init_clusters(X, 3)
    
    # Extract centers for sklearn initialization
    initial_centers = np.array([cluster.center for cluster in custom_clusters])
    
    # Run our custom weighted kmeans
    custom_result = kmeans(X, 3, weights=weights)
    
    # Extract custom assignments and centers
    custom_assignments = np.zeros(X.shape[0], dtype=int)
    for j, cluster in enumerate(custom_result):
        for member in cluster.members:
            custom_assignments[member] = j
    
    custom_centers = np.array([cluster.center for cluster in custom_result])
    
    # Run sklearn kmeans (note: sklearn KMeans doesn't directly support sample weights)
    # So we implement a workaround by duplicating points according to weights
    # This is not efficient but works for testing purposes
    indices = []
    for i, w in enumerate(weights):
        # Add each point w times (rounded)
        count = max(1, int(round(w)))
        indices.extend([i] * count)
    
    weighted_X = X[indices]
    
    sklearn_kmeans = KMeans(
        n_clusters=3,
        init=initial_centers,
        n_init=1,
        max_iter=20
    )
    sklearn_result = sklearn_kmeans.fit(weighted_X)
    
    # For each point in the original dataset, find its assignment
    sklearn_assignments = np.zeros(X.shape[0], dtype=int)
    for i in range(X.shape[0]):
        # Find nearest center
        distances = np.linalg.norm(X[i] - sklearn_result.cluster_centers_, axis=1)
        sklearn_assignments[i] = np.argmin(distances)
    
    # Calculate assignment similarity (with mapping like before)
    mapping = {}
    for clust_id in range(3):
        mask = custom_assignments == clust_id
        if np.any(mask):
            sklearn_clusters = sklearn_assignments[mask]
            most_common = np.bincount(sklearn_clusters).argmax()
            mapping[clust_id] = most_common
    
    # Apply mapping
    mapped_custom = np.array([mapping.get(a, a) for a in custom_assignments])
    
    # Calculate agreement percentage (after mapping)
    agreement = np.mean(mapped_custom == sklearn_assignments) * 100
    print(f"\nWeighted clustering assignment agreement: {agreement:.2f}%")
    
    # Agreement may be lower since sklearn doesn't directly support weights
    assert agreement > 50.0, f"Weighted assignment agreement too low: {agreement:.2f}%"


def test_performance_scaling():
    """Test performance scaling with dataset size."""
    sizes = [100, 500, 1000]
    dimensions = [2, 10, 20]
    
    results = []
    
    for n in sizes:
        for d in dimensions:
            # Generate test data
            X, _ = generate_test_data(n_samples=n, n_features=d, n_clusters=3)
            
            # Get the same initial centers
            custom_clusters = init_clusters(X, 3)
            initial_centers = np.array([cluster.center for cluster in custom_clusters])
            
            # Time our implementation
            start_time = time.time()
            _ = kmeans(X, 3, max_iters=20)
            custom_time = time.time() - start_time
            
            # Time sklearn implementation
            start_time = time.time()
            sklearn_kmeans = KMeans(
                n_clusters=3,
                init=initial_centers,
                n_init=1,
                max_iter=20
            )
            _ = sklearn_kmeans.fit(X)
            sklearn_time = time.time() - start_time
            
            # Record results
            results.append({
                'samples': n,
                'dimensions': d,
                'custom_time': custom_time,
                'sklearn_time': sklearn_time,
                'ratio': custom_time / sklearn_time if sklearn_time > 0 else float('inf')
            })
    
    # Print performance comparison
    print("\nPerformance Scaling Results:")
    for result in results:
        print(f"Samples: {result['samples']}, Dimensions: {result['dimensions']}, " +
              f"Custom: {result['custom_time']:.5f}s, Sklearn: {result['sklearn_time']:.5f}s, " +
              f"Ratio: {result['ratio']:.2f}x")
    
    # No assertion here, just collecting performance data


if __name__ == "__main__":
    # Run all tests
    test_initialization_consistency()
    test_clustering_results()
    test_weighted_clustering()
    test_performance_scaling()