#!/usr/bin/env python3
"""
Test script to directly test the Conversation class with real data.
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
from polismath.conversation.conversation import Conversation

def create_test_conversation(dataset_name: str) -> Conversation:
    """
    Create a test conversation with real data.
    
    Args:
        dataset_name: 'biodiversity' or 'vw'
        
    Returns:
        Conversation with the dataset loaded
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
    
    # Convert to DataFrame 
    df_matrix = pd.DataFrame(
        vote_matrix,
        index=[str(pid) for pid in ptpt_ids],
        columns=[str(cid) for cid in cmt_ids]
    )
    
    # Create a NamedMatrix
    named_matrix = NamedMatrix(df_matrix, enforce_numeric=True)
    
    # Create a Conversation object
    conv = Conversation(dataset_name)
    
    # Set the raw_rating_mat and update stats
    conv.raw_rating_mat = named_matrix
    conv.rating_mat = named_matrix  # No moderation
    conv.participant_count = len(ptpt_ids)
    conv.comment_count = len(cmt_ids)
    
    return conv

def test_conversation(dataset_name: str) -> None:
    """
    Test the Conversation class with a real dataset.
    
    Args:
        dataset_name: 'biodiversity' or 'vw'
    """
    print(f"Testing Conversation with {dataset_name} dataset")
    
    # Create a conversation with the dataset
    try:
        print("Creating conversation...")
        conv = create_test_conversation(dataset_name)
        
        print(f"Conversation created successfully")
        print(f"Participants: {conv.participant_count}")
        print(f"Comments: {conv.comment_count}")
        print(f"Matrix shape: {conv.rating_mat.values.shape}")
        
        # Recompute the conversation
        print("Running recompute...")
        updated_conv = conv.recompute()
        
        # Check PCA results
        print(f"PCA Results:")
        print(f"  - Center shape: {updated_conv.pca['center'].shape}")
        print(f"  - Components shape: {updated_conv.pca['comps'].shape}")
        print(f"  - Projections count: {len(updated_conv.proj)}")
        
        # Check clustering results
        print(f"Clustering Results:")
        print(f"  - Number of clusters: {len(updated_conv.group_clusters)}")
        for i, cluster in enumerate(updated_conv.group_clusters):
            print(f"  - Cluster {i+1}: {len(cluster['members'])} participants")
        
        print("Conversation recompute SUCCESSFUL!")
        
    except Exception as e:
        print(f"Error during conversation processing: {e}")
        import traceback
        traceback.print_exc()
        print("Conversation recompute FAILED!")

if __name__ == "__main__":
    # Test on both datasets
    test_conversation('biodiversity')
    print("\n" + "="*50 + "\n")
    test_conversation('vw')