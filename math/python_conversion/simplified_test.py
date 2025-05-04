#!/usr/bin/env python3
"""
Simplified test script for PCA and clustering components.
This script only tests the core math functions without the full package dependencies.
"""

import os
import sys
import numpy as np
import pandas as pd
from typing import Dict, List, Any
import traceback

# Define simplified versions of the core math functions

def normalize_vector(v: np.ndarray) -> np.ndarray:
    """Normalize a vector to unit length."""
    norm = np.linalg.norm(v)
    if norm == 0:
        return v
    return v / norm

def xtxr(data: np.ndarray, vec: np.ndarray) -> np.ndarray:
    """Calculate X^T * X * r where X is data and r is vec."""
    return data.T @ (data @ vec)

def power_iteration(data: np.ndarray, iters: int = 100) -> np.ndarray:
    """Find the first eigenvector of data using power iteration."""
    n_cols = data.shape[1]
    
    # Start with a random vector
    rng = np.random.RandomState(42)
    vector = rng.rand(n_cols)
    vector = normalize_vector(vector)
    
    for i in range(iters):
        # Compute product
        product = xtxr(data, vector)
        
        # Check for zero product
        if np.all(np.abs(product) < 1e-10):
            vector = rng.rand(n_cols)
            continue
            
        # Normalize
        new_vector = normalize_vector(product)
        
        # Check for convergence
        if np.abs(np.dot(new_vector, vector)) > 0.9999:
            return new_vector
            
        vector = new_vector
    
    return vector

def pca_simple(data: np.ndarray, n_comps: int = 2) -> Dict[str, np.ndarray]:
    """Simple PCA implementation."""
    # Center the data
    center = np.mean(data, axis=0)
    centered = data - center
    
    # Find components
    components = []
    factored_data = centered.copy()
    
    for i in range(n_comps):
        # Find component using power iteration
        comp = power_iteration(factored_data)
        components.append(comp)
        
        # Factor out this component
        if i < n_comps - 1:
            # Project onto comp
            proj = np.outer(factored_data @ comp, comp)
            # Remove projection
            factored_data = factored_data - proj
    
    return {
        'center': center,
        'comps': np.array(components)
    }

def project_data(data: np.ndarray, pca_results: Dict[str, np.ndarray]) -> np.ndarray:
    """Project data onto principal components."""
    centered = data - pca_results['center']
    return centered @ pca_results['comps'].T

def kmeans_clustering(projections: np.ndarray, n_clusters: int = 3) -> List[Dict[str, Any]]:
    """Simple k-means clustering."""
    from sklearn.cluster import KMeans
    
    kmeans = KMeans(n_clusters=n_clusters, random_state=42)
    labels = kmeans.fit_predict(projections)
    centers = kmeans.cluster_centers_
    
    # Build cluster results
    clusters = []
    for i in range(n_clusters):
        members = np.where(labels == i)[0].tolist()
        clusters.append({
            'id': i,
            'members': members,
            'center': centers[i]
        })
    
    return clusters

def load_votes(dataset_name: str) -> tuple:
    """Load votes from a dataset."""
    # Set paths based on dataset
    if dataset_name == 'biodiversity':
        votes_path = os.path.join('real_data/biodiversity', '2025-03-18-2000-3atycmhmer-votes.csv')
    elif dataset_name == 'vw':
        votes_path = os.path.join('real_data/vw', '2025-03-18-1954-4anfsauat2-votes.csv')
    else:
        raise ValueError(f"Unknown dataset: {dataset_name}")
    
    # Read votes from CSV
    df = pd.read_csv(votes_path)
    
    # Get unique participant and comment IDs
    ptpt_ids = sorted(df['voter-id'].unique())
    cmt_ids = sorted(df['comment-id'].unique())
    
    # Create a matrix of NaNs
    vote_matrix = np.full((len(ptpt_ids), len(cmt_ids)), np.nan)
    
    # Create row and column maps
    ptpt_map = {pid: i for i, pid in enumerate(ptpt_ids)}
    cmt_map = {cid: i for i, cid in enumerate(cmt_ids)}
    
    # Fill the matrix with votes
    for _, row in df.iterrows():
        pid = row['voter-id']
        cid = row['comment-id']
        
        # Convert vote to numeric value
        try:
            vote_val = float(row['vote'])
            # Normalize to ensure only -1, 0, or 1
            if vote_val > 0:
                vote_val = 1.0
            elif vote_val < 0:
                vote_val = -1.0
            else:
                vote_val = 0.0
        except ValueError:
            # Handle text values
            vote_text = str(row['vote']).lower()
            if vote_text == 'agree':
                vote_val = 1.0
            elif vote_text == 'disagree':
                vote_val = -1.0
            else:
                vote_val = 0.0  # Pass or unknown
        
        # Add vote to matrix
        r_idx = ptpt_map[pid]
        c_idx = cmt_map[cid]
        vote_matrix[r_idx, c_idx] = vote_val
    
    return vote_matrix, ptpt_ids, cmt_ids

def run_test(dataset_name: str) -> None:
    """Run a test on a dataset."""
    print(f"\n============== Testing Simplified Math Pipeline: {dataset_name} ==============\n")
    
    try:
        # Load votes
        print("Loading votes...")
        vote_matrix, ptpt_ids, cmt_ids = load_votes(dataset_name)
        
        print(f"Matrix shape: {vote_matrix.shape}")
        print(f"Number of participants: {len(ptpt_ids)}")
        print(f"Number of comments: {len(cmt_ids)}")
        
        # Handle missing values
        print("Preprocessing data...")
        vote_matrix_clean = np.nan_to_num(vote_matrix, nan=0.0)
        
        # Run PCA
        print("Running PCA...")
        pca_results = pca_simple(vote_matrix_clean)
        
        print(f"PCA completed successfully")
        print(f"Center shape: {pca_results['center'].shape}")
        print(f"Components shape: {pca_results['comps'].shape}")
        
        # Project data
        print("Projecting data...")
        projections = project_data(vote_matrix_clean, pca_results)
        
        print(f"Number of projections: {projections.shape[0]}")
        print(f"Mean coordinates: [{np.mean(projections[:, 0]):.3f}, {np.mean(projections[:, 1]):.3f}]")
        print(f"Std: [{np.std(projections[:, 0]):.3f}, {np.std(projections[:, 1]):.3f}]")
        
        # Cluster data
        print("Clustering data...")
        n_clusters = 3
        clusters = kmeans_clustering(projections, n_clusters)
        
        for i, cluster in enumerate(clusters):
            print(f"Cluster {i+1}: {len(cluster['members'])} participants")
            print(f"  Center: [{cluster['center'][0]:.3f}, {cluster['center'][1]:.3f}]")
        
        print("\nSimplified math pipeline test SUCCESSFUL!")
        
    except Exception as e:
        print(f"Error during processing: {e}")
        traceback.print_exc()
        print("Simplified math pipeline test FAILED!")


if __name__ == "__main__":
    # Run tests on both datasets
    run_test('biodiversity')
    print("\n" + "="*70)
    run_test('vw')