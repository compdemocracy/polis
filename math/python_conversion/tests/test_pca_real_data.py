#!/usr/bin/env python3
"""
Direct test of PCA implementation with real data.
Demonstrates that our PCA fixes work directly on the data.
"""

import os
import sys
import numpy as np
import pandas as pd
from typing import Dict, List, Any, Union, Optional

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.math.named_matrix import NamedMatrix
from polismath.math.pca import pca_project_named_matrix

def load_votes_from_csv(votes_path: str, limit: Optional[int] = None) -> np.ndarray:
    """Load votes from a CSV file."""
    # Read CSV
    if limit:
        df = pd.read_csv(votes_path, nrows=limit)
    else:
        df = pd.read_csv(votes_path)
    
    # Get unique participant and comment IDs
    ptpt_ids = sorted(df['voter-id'].unique())
    cmt_ids = sorted(df['comment-id'].unique())
    
    # Create a matrix of NaNs
    vote_matrix = np.full((len(ptpt_ids), len(cmt_ids)), np.nan)
    
    # Fill the matrix with votes
    ptpt_map = {pid: i for i, pid in enumerate(ptpt_ids)}
    cmt_map = {cid: i for i, cid in enumerate(cmt_ids)}
    
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
        vote_matrix[ptpt_map[pid], cmt_map[cid]] = vote_val
    
    # Create a NamedMatrix
    return NamedMatrix(
        matrix=vote_matrix,
        rownames=[str(pid) for pid in ptpt_ids],
        colnames=[str(cid) for cid in cmt_ids]
    )

def test_pca_projection(dataset_name: str) -> None:
    """Test PCA projection on a real dataset."""
    print(f"Testing PCA on {dataset_name} dataset")
    
    # Set paths based on dataset name
    if dataset_name == 'biodiversity':
        data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'real_data/biodiversity'))
        votes_path = os.path.join(data_dir, '2025-03-18-2000-3atycmhmer-votes.csv')
    elif dataset_name == 'vw':
        data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'real_data/vw'))
        votes_path = os.path.join(data_dir, '2025-03-18-1954-4anfsauat2-votes.csv')
    else:
        raise ValueError(f"Unknown dataset: {dataset_name}")
    
    # Load votes
    vote_matrix = load_votes_from_csv(votes_path)
    
    print(f"Vote matrix shape: {vote_matrix.values.shape}")
    print(f"Number of participants: {len(vote_matrix.rownames())}")
    print(f"Number of comments: {len(vote_matrix.colnames())}")
    
    # Perform PCA - this should not raise an exception
    try:
        pca_results, projections = pca_project_named_matrix(vote_matrix)
        print("PCA projection succeeded!")
        
        # Print PCA results shape
        print(f"PCA center shape: {pca_results['center'].shape}")
        print(f"PCA components shape: {pca_results['comps'].shape}")
        
        # Print projections stats
        print(f"Number of projections: {len(projections)}")
        
        # Calculate some simple statistics on projections
        proj_array = np.array(list(projections.values()))
        min_x = np.min(proj_array[:, 0])
        max_x = np.max(proj_array[:, 0])
        min_y = np.min(proj_array[:, 1])
        max_y = np.max(proj_array[:, 1])
        
        print(f"X range: [{min_x:.2f}, {max_x:.2f}]")
        print(f"Y range: [{min_y:.2f}, {max_y:.2f}]")
        
        # Calculate number of unique clusters
        from sklearn.cluster import KMeans
        kmeans = KMeans(n_clusters=3, random_state=42).fit(proj_array)
        labels = kmeans.labels_
        unique_clusters = np.unique(labels)
        
        print(f"Number of clusters: {len(unique_clusters)}")
        for i in unique_clusters:
            count = np.sum(labels == i)
            print(f"  Cluster {i}: {count} participants")
        
    except Exception as e:
        print(f"Error during PCA: {e}")
        # If PCA fails, the fixes are not complete
        print("PCA projection FAILED - more fixes needed")

if __name__ == "__main__":
    # Test both datasets
    test_pca_projection('biodiversity')
    print("\n" + "="*50 + "\n")
    test_pca_projection('vw')