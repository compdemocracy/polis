#!/usr/bin/env python3
"""
Direct test of PCA implementation with real data.
This script processes the real data files and runs the PCA implementation directly.
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from typing import Dict, List, Any

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.pca_kmeans_rep.named_matrix import NamedMatrix
from polismath.pca_kmeans_rep.pca import pca_project_named_matrix

def load_votes(dataset_name: str) -> NamedMatrix:
    """
    Load votes from a dataset and create a NamedMatrix.
    
    Args:
        dataset_name: 'biodiversity' or 'vw'
        
    Returns:
        NamedMatrix with vote data
    """
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
    
    # Convert to DataFrame and create NamedMatrix
    df_matrix = pd.DataFrame(
        vote_matrix,
        index=[str(pid) for pid in ptpt_ids],
        columns=[str(cid) for cid in cmt_ids]
    )
    
    return NamedMatrix(df_matrix, enforce_numeric=True)

def test_pca_implementation(dataset_name: str) -> None:
    """
    Test the PCA implementation on a real dataset.
    
    Args:
        dataset_name: 'biodiversity' or 'vw'
    """
    print(f"Testing PCA on {dataset_name} dataset")
    
    # Load votes into a NamedMatrix
    vote_matrix = load_votes(dataset_name)
    
    print(f"Matrix shape: {vote_matrix.values.shape}")
    print(f"Number of participants: {len(vote_matrix.rownames())}")
    print(f"Number of comments: {len(vote_matrix.colnames())}")
    
    # Run PCA
    try:
        print("Running PCA...")
        pca_results, projections = pca_project_named_matrix(vote_matrix)
        
        # Check PCA results
        print(f"PCA completed successfully")
        print(f"Center shape: {pca_results['center'].shape}")
        print(f"Components shape: {pca_results['comps'].shape}")
        
        # Check projections
        print(f"Number of projections: {len(projections)}")
        
        # Analyze projections
        proj_array = np.array(list(projections.values()))
        
        # Calculate simple stats
        x_mean = np.mean(proj_array[:, 0])
        y_mean = np.mean(proj_array[:, 1])
        x_std = np.std(proj_array[:, 0])
        y_std = np.std(proj_array[:, 1])
        
        print(f"X mean: {x_mean:.2f}, std: {x_std:.2f}")
        print(f"Y mean: {y_mean:.2f}, std: {y_std:.2f}")
        
        # Try clustering 
        from sklearn.cluster import KMeans
        n_clusters = 3
        kmeans = KMeans(n_clusters=n_clusters, random_state=42)
        labels = kmeans.fit_predict(proj_array)
        
        # Count points in each cluster
        for i in range(n_clusters):
            count = np.sum(labels == i)
            print(f"Cluster {i+1}: {count} participants")
        
        print("PCA implementation is WORKING CORRECTLY with real data")
        
    except Exception as e:
        print(f"Error during PCA: {e}")
        import traceback
        traceback.print_exc()
        print("PCA implementation FAILED with real data")

if __name__ == "__main__":
    # Test on both datasets
    test_pca_implementation('biodiversity')
    print("\n" + "="*50 + "\n")
    test_pca_implementation('vw')