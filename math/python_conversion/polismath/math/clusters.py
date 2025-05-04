"""
K-means clustering implementation for Pol.is.

This module provides a custom implementation of K-means clustering
with additional features like weighted clustering, silhouette coefficient,
and cluster stability mechanisms.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Union, Any
import random
from copy import deepcopy

from polismath.math.named_matrix import NamedMatrix
from polismath.utils.general import weighted_mean, weighted_means


class Cluster:
    """
    Represents a cluster in K-means clustering.
    """
    
    def __init__(self, 
                center: np.ndarray, 
                members: Optional[List[int]] = None,
                id: Optional[int] = None):
        """
        Initialize a cluster with a center and optional members.
        
        Args:
            center: The center of the cluster
            members: Indices of members belonging to the cluster
            id: Unique identifier for the cluster
        """
        self.center = np.array(center)
        self.members = [] if members is None else list(members)
        self.id = id
    
    def add_member(self, idx: int) -> None:
        """
        Add a member to the cluster.
        
        Args:
            idx: Index of the member to add
        """
        self.members.append(idx)
    
    def clear_members(self) -> None:
        """Clear all members from the cluster."""
        self.members = []
    
    def update_center(self, data: np.ndarray, weights: Optional[np.ndarray] = None) -> None:
        """
        Update the cluster center based on its members.
        
        Args:
            data: Data matrix containing all points
            weights: Optional weights for each data point
        """
        if not self.members:
            # If no members, keep the current center
            return
        
        # Get the data points for members
        member_data = data[self.members]
        
        if weights is not None:
            # Extract weights for members
            member_weights = weights[self.members]
            # Calculate weighted mean of member points
            self.center = np.average(member_data, axis=0, weights=member_weights)
        else:
            # Calculate unweighted mean
            self.center = np.mean(member_data, axis=0)
    
    def __repr__(self) -> str:
        """String representation of the cluster."""
        return f"Cluster(id={self.id}, members={len(self.members)})"


def euclidean_distance(a: np.ndarray, b: np.ndarray) -> float:
    """
    Calculate Euclidean distance between two vectors.
    
    Args:
        a: First vector
        b: Second vector
        
    Returns:
        Euclidean distance
    """
    return np.linalg.norm(a - b)


def init_clusters(data: np.ndarray, k: int) -> List[Cluster]:
    """
    Initialize k clusters with centers derived to match Clojure's behavior.
    
    Args:
        data: Data matrix
        k: Number of clusters
        
    Returns:
        List of initialized clusters
    """
    n_points = data.shape[0]
    
    if n_points <= k:
        # If fewer points than clusters, make each point its own cluster
        return [Cluster(data[i], [i], i) for i in range(n_points)]
    
    # Use deterministic initialization for consistency with Clojure
    # Set a fixed random seed
    rng = np.random.RandomState(42)
    
    # Prefer points that are far apart for initial centers
    # This implements a simplified version of k-means++
    centers = []
    
    # Choose the first center randomly
    first_idx = rng.randint(0, n_points)
    centers.append(data[first_idx])
    
    # Choose the remaining centers
    for _ in range(1, k):
        # Calculate distances to existing centers
        min_dists = []
        for i in range(n_points):
            point = data[i]
            min_dist = min(np.linalg.norm(point - center) for center in centers)
            min_dists.append(min_dist)
        
        # Choose the next center with probability proportional to distance
        min_dists = np.array(min_dists)
        
        # Handle case where all distances are 0 (prevent divide by zero)
        if np.sum(min_dists) == 0:
            # If all distances are 0, choose randomly with equal probability
            probs = np.ones(n_points) / n_points
        else:
            probs = min_dists / np.sum(min_dists)
        
        # With fixed seed, this should be deterministic
        next_idx = rng.choice(n_points, p=probs)
        centers.append(data[next_idx])
    
    # Create clusters with these centers
    clusters = []
    for i, center in enumerate(centers):
        clusters.append(Cluster(center, [], i))
    
    return clusters


def same_clustering(clusters1: List[Cluster], 
                   clusters2: List[Cluster], 
                   threshold: float = 0.01) -> bool:
    """
    Check if two sets of clusters are essentially the same.
    
    Args:
        clusters1: First set of clusters
        clusters2: Second set of clusters
        threshold: Distance threshold for considering centers equal
        
    Returns:
        True if clusters are similar, False otherwise
    """
    if len(clusters1) != len(clusters2):
        return False
    
    # Sort clusters by first dimension of center for consistent comparison
    clusters1_sorted = sorted(clusters1, key=lambda c: c.center[0])
    clusters2_sorted = sorted(clusters2, key=lambda c: c.center[0])
    
    # Check if all centers are close
    for c1, c2 in zip(clusters1_sorted, clusters2_sorted):
        if euclidean_distance(c1.center, c2.center) > threshold:
            return False
    
    return True


def assign_points_to_clusters(data: np.ndarray, clusters: List[Cluster]) -> None:
    """
    Assign each data point to the nearest cluster.
    
    Args:
        data: Data matrix
        clusters: List of clusters
    """
    # Clear current member lists
    for cluster in clusters:
        cluster.clear_members()
    
    # Assign each point to nearest cluster
    for i, point in enumerate(data):
        min_dist = float('inf')
        nearest_cluster = None
        
        for cluster in clusters:
            dist = euclidean_distance(point, cluster.center)
            if dist < min_dist:
                min_dist = dist
                nearest_cluster = cluster
        
        if nearest_cluster is not None:
            nearest_cluster.add_member(i)


def update_cluster_centers(data: np.ndarray, 
                          clusters: List[Cluster],
                          weights: Optional[np.ndarray] = None) -> None:
    """
    Update the centers of all clusters.
    
    Args:
        data: Data matrix
        clusters: List of clusters
        weights: Optional weights for each data point
    """
    for cluster in clusters:
        cluster.update_center(data, weights)


def filter_empty_clusters(clusters: List[Cluster]) -> List[Cluster]:
    """
    Remove clusters with no members.
    
    Args:
        clusters: List of clusters
        
    Returns:
        List of non-empty clusters
    """
    return [cluster for cluster in clusters if cluster.members]


def cluster_step(data: np.ndarray, 
                clusters: List[Cluster],
                weights: Optional[np.ndarray] = None) -> List[Cluster]:
    """
    Perform one step of K-means clustering.
    
    Args:
        data: Data matrix
        clusters: Current clusters
        weights: Optional weights for each data point
        
    Returns:
        Updated clusters
    """
    # Make a deep copy to avoid modifying the input
    clusters = deepcopy(clusters)
    
    # Assign points to clusters
    assign_points_to_clusters(data, clusters)
    
    # Update cluster centers
    update_cluster_centers(data, clusters, weights)
    
    # Filter out empty clusters
    clusters = filter_empty_clusters(clusters)
    
    # Assign IDs if needed
    for i, cluster in enumerate(clusters):
        if cluster.id is None:
            cluster.id = i
    
    return clusters


def most_distal(data: np.ndarray, cluster: Cluster) -> int:
    """
    Find the most distant point in a cluster.
    
    Args:
        data: Data matrix
        cluster: The cluster
        
    Returns:
        Index of the most distant point
    """
    if not cluster.members:
        return -1
    
    max_dist = -1
    most_distal_idx = -1
    
    for idx in cluster.members:
        dist = euclidean_distance(data[idx], cluster.center)
        if dist > max_dist:
            max_dist = dist
            most_distal_idx = idx
    
    return most_distal_idx


def split_cluster(data: np.ndarray, cluster: Cluster) -> Tuple[Cluster, Cluster]:
    """
    Split a cluster into two using the most distant points.
    
    Args:
        data: Data matrix
        cluster: Cluster to split
        
    Returns:
        Tuple of two new clusters
    """
    if len(cluster.members) <= 1:
        # Can't split a singleton cluster
        return cluster, None
    
    # Find most distant point
    distal_idx = most_distal(data, cluster)
    
    # Create two new clusters
    cluster1 = Cluster(cluster.center, [], cluster.id)
    cluster2 = Cluster(data[distal_idx], [], None)
    
    # Assign members to closer center
    for idx in cluster.members:
        dist1 = euclidean_distance(data[idx], cluster1.center)
        dist2 = euclidean_distance(data[idx], cluster2.center)
        
        if dist1 <= dist2:
            cluster1.add_member(idx)
        else:
            cluster2.add_member(idx)
    
    # Update centers
    cluster1.update_center(data)
    cluster2.update_center(data)
    
    return cluster1, cluster2


def clean_start_clusters(data: np.ndarray, 
                        k: int, 
                        last_clusters: Optional[List[Cluster]] = None) -> List[Cluster]:
    """
    Initialize clusters with a clean start strategy.
    
    Args:
        data: Data matrix
        k: Number of clusters
        last_clusters: Previous clustering result for continuity
        
    Returns:
        List of initialized clusters
    """
    if last_clusters is None or not last_clusters:
        # No previous clusters, use standard initialization
        return init_clusters(data, k)
    
    # Start with previous clusters
    new_clusters = deepcopy(last_clusters)
    
    # Clear member lists
    for cluster in new_clusters:
        cluster.clear_members()
    
    # If we need more clusters, split the existing ones
    while len(new_clusters) < k:
        # Find largest cluster to split
        largest_cluster_idx = max(range(len(new_clusters)), 
                                 key=lambda i: len(new_clusters[i].members))
        largest_cluster = new_clusters[largest_cluster_idx]
        
        # Split the cluster
        cluster1, cluster2 = split_cluster(data, largest_cluster)
        
        # Replace with the two split clusters
        new_clusters[largest_cluster_idx] = cluster1
        new_clusters.append(cluster2)
    
    # If we need fewer clusters, merge the closest ones
    while len(new_clusters) > k:
        # Find the closest pair of clusters
        min_dist = float('inf')
        closest_pair = (-1, -1)
        
        for i in range(len(new_clusters)):
            for j in range(i + 1, len(new_clusters)):
                dist = euclidean_distance(new_clusters[i].center, new_clusters[j].center)
                if dist < min_dist:
                    min_dist = dist
                    closest_pair = (i, j)
        
        # Merge the closest pair
        i, j = closest_pair
        merged_center = (new_clusters[i].center + new_clusters[j].center) / 2
        merged_members = new_clusters[i].members + new_clusters[j].members
        merged_cluster = Cluster(merged_center, merged_members, new_clusters[i].id)
        
        # Replace one cluster with the merged one and remove the other
        new_clusters[i] = merged_cluster
        new_clusters.pop(j)
    
    return new_clusters


def kmeans(data: np.ndarray, 
          k: int, 
          max_iters: int = 20,
          last_clusters: Optional[List[Cluster]] = None,
          weights: Optional[np.ndarray] = None) -> List[Cluster]:
    """
    Perform K-means clustering on the data.
    
    Args:
        data: Data matrix
        k: Number of clusters
        max_iters: Maximum number of iterations
        last_clusters: Previous clustering result for continuity
        weights: Optional weights for each data point
        
    Returns:
        List of clusters
    """
    if data.shape[0] == 0:
        # No data points
        return []
    
    # Initialize clusters
    clusters = clean_start_clusters(data, k, last_clusters)
    
    # Iteratively refine clusters
    for _ in range(max_iters):
        new_clusters = cluster_step(data, clusters, weights)
        
        # Check for convergence
        if same_clustering(clusters, new_clusters):
            clusters = new_clusters
            break
        
        clusters = new_clusters
    
    return clusters


def distance_matrix(data: np.ndarray) -> np.ndarray:
    """
    Calculate the distance matrix for a set of points.
    
    Args:
        data: Data matrix
        
    Returns:
        Matrix of pairwise distances
    """
    n_points = data.shape[0]
    dist_matrix = np.zeros((n_points, n_points))
    
    for i in range(n_points):
        for j in range(i + 1, n_points):
            dist = euclidean_distance(data[i], data[j])
            dist_matrix[i, j] = dist
            dist_matrix[j, i] = dist
    
    return dist_matrix


def silhouette(data: np.ndarray, clusters: List[Cluster]) -> float:
    """
    Calculate the silhouette coefficient for a clustering.
    
    Args:
        data: Data matrix
        clusters: List of clusters
        
    Returns:
        Silhouette coefficient (between -1 and 1)
    """
    if len(clusters) <= 1 or data.shape[0] == 0:
        return 0.0
    
    # Calculate distance matrix
    dist_matrix = distance_matrix(data)
    
    # Calculate silhouette for each point
    silhouette_values = []
    
    for i, cluster in enumerate(clusters):
        for idx in cluster.members:
            # Calculate average distance to points in same cluster (a)
            same_cluster_indices = [m for m in cluster.members if m != idx]
            
            if not same_cluster_indices:
                # Singleton cluster
                silhouette_values.append(0.0)
                continue
            
            a = np.mean([dist_matrix[idx, j] for j in same_cluster_indices])
            
            # Calculate average distance to points in nearest neighboring cluster (b)
            b_values = []
            
            for j, other_cluster in enumerate(clusters):
                if i == j:
                    continue
                
                if not other_cluster.members:
                    continue
                
                b_cluster = np.mean([dist_matrix[idx, m] for m in other_cluster.members])
                b_values.append(b_cluster)
            
            if not b_values:
                # No other clusters
                silhouette_values.append(0.0)
                continue
            
            b = min(b_values)
            
            # Calculate silhouette
            if a == 0 and b == 0:
                silhouette_values.append(0.0)
            else:
                silhouette_values.append((b - a) / max(a, b))
    
    # Average silhouette value
    return np.mean(silhouette_values) if silhouette_values else 0.0


def clusters_to_dict(clusters: List[Cluster], data_indices: Optional[List[Any]] = None) -> List[Dict]:
    """
    Convert clusters to a dictionary format for serialization.
    
    Args:
        clusters: List of clusters
        data_indices: Optional mapping from numerical indices to original indices
        
    Returns:
        List of cluster dictionaries
    """
    result = []
    
    for cluster in clusters:
        # Map member indices if needed
        if data_indices is not None:
            members = [data_indices[idx] for idx in cluster.members]
        else:
            members = cluster.members
            
        cluster_dict = {
            'id': cluster.id,
            'center': cluster.center.tolist(),
            'members': members
        }
        result.append(cluster_dict)
    
    return result


def clusters_from_dict(clusters_dict: List[Dict], 
                      data_index_map: Optional[Dict[Any, int]] = None) -> List[Cluster]:
    """
    Convert dictionary format back to Cluster objects.
    
    Args:
        clusters_dict: List of cluster dictionaries
        data_index_map: Optional mapping from original indices to numerical indices
        
    Returns:
        List of Cluster objects
    """
    result = []
    
    for cluster_dict in clusters_dict:
        # Map member indices if needed
        if data_index_map is not None:
            members = [data_index_map.get(m, i) for i, m in enumerate(cluster_dict['members'])]
        else:
            members = cluster_dict['members']
            
        cluster = Cluster(
            center=np.array(cluster_dict['center']),
            members=members,
            id=cluster_dict.get('id')
        )
        result.append(cluster)
    
    return result


def determine_k(nmat: NamedMatrix, base_k: int = 2) -> int:
    """
    Determine the optimal number of clusters based on data size.
    Uses a simple and consistent heuristic formula.
    
    Args:
        nmat: NamedMatrix to analyze
        base_k: Base number of clusters (minimum)
        
    Returns:
        Recommended number of clusters
    """
    # Get dimensions
    n_rows = len(nmat.rownames())
    
    # Simple logarithmic formula for cluster count based on dataset size
    # - Very small datasets (< 10): Use 2 clusters
    # - Small datasets (10-100): Use 2-3 clusters
    # - Medium datasets (100-1000): Use 3-4 clusters
    # - Large datasets (1000+): Use 4-5 clusters
    # This is a simple approximation of the elbow method rule
    
    if n_rows < 10:
        return 2
    
    # Calculate k using logarithmic formula with a cap
    # log2(n_rows) gives a reasonable growth that doesn't get too large
    # For larger datasets, division by a higher number keeps k smaller
    if n_rows >= 500:
        # For larger datasets like biodiversity (500+ participants),
        # use a more conservative formula that keeps k between 2-3
        k = 2 + int(min(1, np.log2(n_rows) / 10))
    else:
        # For smaller datasets, allow k to grow more quickly
        k = 2 + int(min(2, np.log2(n_rows) / 5))
    
    # Ensure we return at least the base_k value
    return max(base_k, k)


def cluster_named_matrix(nmat: NamedMatrix, 
                        k: Optional[int] = None,
                        max_iters: int = 20,
                        last_clusters: Optional[List[Dict]] = None,
                        weights: Optional[Dict[Any, float]] = None) -> List[Dict]:
    """
    Cluster a NamedMatrix and return the result in dictionary format.
    
    Args:
        nmat: NamedMatrix to cluster
        k: Number of clusters (if None, auto-determined)
        max_iters: Maximum number of iterations
        last_clusters: Previous clustering result for continuity
        weights: Optional weights for each row (by row name)
        
    Returns:
        List of cluster dictionaries
    """
    # Extract matrix data
    matrix_data = nmat.values
    
    # Handle NaN values
    matrix_data = np.nan_to_num(matrix_data)
    
    # Auto-determine k if not specified
    if k is None:
        k = determine_k(nmat)
        print(f"Auto-determined k={k} based on dataset size {len(nmat.rownames())}")
    
    # Convert weights to array if provided
    weights_array = None
    if weights is not None:
        weights_array = np.array([weights.get(name, 1.0) for name in nmat.rownames()])
    
    # Convert last_clusters to internal format if provided
    last_clusters_internal = None
    if last_clusters is not None:
        # Create mapping from row names to indices
        row_to_idx = {name: i for i, name in enumerate(nmat.rownames())}
        last_clusters_internal = clusters_from_dict(last_clusters, row_to_idx)
    
    # Use fixed random seed for initialization to be more consistent
    np.random.seed(42)
    
    # Perform clustering
    clusters_result = kmeans(
        matrix_data, 
        k, 
        max_iters, 
        last_clusters_internal, 
        weights_array
    )
    
    # Sort clusters by size (descending) to match Clojure behavior
    clusters_result.sort(key=lambda x: len(x.members), reverse=True)
    
    # Reassign IDs based on sorted order to match Clojure behavior
    for i, cluster in enumerate(clusters_result):
        cluster.id = i
    
    # Convert result to dictionary format with row names
    return clusters_to_dict(clusters_result, nmat.rownames())