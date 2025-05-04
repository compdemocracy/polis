"""
Helper module for loading data in the GPU acceleration demo.
"""

import os
import numpy as np
import pandas as pd

def load_votes(dataset_name):
    """Load votes from CSV files."""
    # Try multiple potential paths to find the data
    # Start with current directory
    potential_paths = [
        f"real_data/{dataset_name}",                 # Direct from notebook dir
        f"../real_data/{dataset_name}",              # One level up
        f"../../real_data/{dataset_name}",           # Two levels up
        f"/Users/colinmegill/polis/math/python_conversion/real_data/{dataset_name}"  # Absolute path
    ]
    
    # Find first working path
    dataset_path = None
    for path in potential_paths:
        if os.path.exists(os.path.join(path, "votes.csv")):
            dataset_path = path
            break
    
    if not dataset_path:
        raise FileNotFoundError(f"Could not find {dataset_name} dataset. Tried paths: {potential_paths}")
    
    votes_path = os.path.join(dataset_path, "votes.csv")
    comments_path = os.path.join(dataset_path, "comments.csv")
    
    # Check if files exist
    if not os.path.exists(votes_path) or not os.path.exists(comments_path):
        raise FileNotFoundError(f"Dataset files not found at {dataset_path}. Please check the path.")
    
    # Load data
    votes_df = pd.read_csv(votes_path)
    comments_df = pd.read_csv(comments_path)
    
    # Get unique participant and comment IDs
    ptpt_ids = sorted(votes_df["voter-id"].unique())
    cmt_ids = sorted(comments_df["comment-id"].unique())
    
    # Create mapping dictionaries
    ptpt_idx = {pid: i for i, pid in enumerate(ptpt_ids)}
    cmt_idx = {cid: i for i, cid in enumerate(cmt_ids)}
    
    # Create vote matrix
    n_ptpts = len(ptpt_ids)
    n_cmts = len(cmt_ids)
    vote_matrix = np.full((n_ptpts, n_cmts), np.nan)
    
    # Fill vote matrix
    for _, row in votes_df.iterrows():
        ptpt_id = row["voter-id"]
        cmt_id = row["comment-id"]
        vote = row["vote"]
        
        if ptpt_id in ptpt_idx and cmt_id in cmt_idx:
            vote_matrix[ptpt_idx[ptpt_id], cmt_idx[cmt_id]] = vote
    
    print(f"Loaded {dataset_name} dataset with {n_ptpts} participants and {n_cmts} comments")
    return vote_matrix, ptpt_ids, cmt_ids

def create_synthetic_data(n_samples, n_features):
    """Create synthetic vote data."""
    np.random.seed(42)
    # Create random votes (-1, 0, 1) as floating point to support NaN
    votes = np.random.choice([-1.0, 0.0, 1.0], size=(n_samples, n_features), p=[0.4, 0.2, 0.4])
    # Introduce sparsity (about 70% NaN)
    mask = np.random.random(size=votes.shape) < 0.7
    votes[mask] = np.nan
    print(f"Created synthetic dataset with {n_samples} participants and {n_features} comments")
    return votes