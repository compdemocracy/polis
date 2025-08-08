#!/usr/bin/env python3
"""
Test script to directly test the representativeness calculation with real data.
"""

import os
import sys
import json
import numpy as np
import pandas as pd
import traceback
from typing import Dict, List, Any

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.pca_kmeans_rep.named_matrix import NamedMatrix
from polismath.pca_kmeans_rep.repness import conv_repness, participant_stats
from polismath.conversation.conversation import Conversation
from direct_conversation_test import create_test_conversation

def test_repness_calculation(dataset_name: str) -> None:
    """
    Test the representativeness calculation with a real dataset.
    
    Args:
        dataset_name: 'biodiversity' or 'vw'
    """
    print(f"\nTesting representativeness calculation with {dataset_name} dataset")
    
    try:
        # Create a conversation with the dataset
        print("Creating conversation...")
        conv = create_test_conversation(dataset_name)
        
        print(f"Conversation created successfully")
        print(f"Participants: {conv.participant_count}")
        print(f"Comments: {conv.comment_count}")
        print(f"Matrix shape: {conv.rating_mat.values.shape}")
        
        # Run PCA and clustering first (needed for repness)
        print("Running PCA and clustering...")
        conv._compute_pca()
        conv._compute_clusters()
        
        # Get the vote matrix and group clusters
        vote_matrix = conv.rating_mat
        group_clusters = conv.group_clusters
        
        print(f"Number of clusters: {len(group_clusters)}")
        for i, cluster in enumerate(group_clusters):
            print(f"  - Cluster {i+1}: {len(cluster['members'])} participants")
        
        # Run representativeness calculation
        print("\nRunning representativeness calculation...")
        repness_results = conv_repness(vote_matrix, group_clusters)
        
        # Check the results
        print("\nRepresentativeness Results:")
        print(f"  - Number of comment IDs: {len(repness_results['comment_ids'])}")
        print(f"  - Number of groups with repness: {len(repness_results['group_repness'])}")
        
        for group_id, comments in repness_results['group_repness'].items():
            print(f"\n  Group {group_id}:")
            print(f"    - Number of representative comments: {len(comments)}")
            
            for i, comment in enumerate(comments):
                print(f"    - Comment {i+1}: ID {comment.get('comment_id')}, Type: {comment.get('repful')}")
                print(f"      Agree: {comment.get('pa', 0):.2f}, Disagree: {comment.get('pd', 0):.2f}")
                print(f"      Agree metric: {comment.get('agree_metric', 0):.2f}, Disagree metric: {comment.get('disagree_metric', 0):.2f}")
        
        # Check consensus comments
        print("\n  Consensus Comments:")
        for i, comment in enumerate(repness_results.get('consensus_comments', [])):
            print(f"    - Comment {i+1}: ID {comment.get('comment_id')}, Avg Agree: {comment.get('avg_agree', 0):.2f}")
        
        # Now test participant stats
        print("\nRunning participant statistics calculation...")
        ptpt_stats = participant_stats(vote_matrix, group_clusters)
        
        print("\nParticipant Statistics:")
        print(f"  - Number of participant IDs: {len(ptpt_stats.get('participant_ids', []))}")
        print(f"  - Number of participants with stats: {len(ptpt_stats.get('stats', {}))}")
        
        # Sample a few participants
        sample_size = min(3, len(ptpt_stats.get('stats', {})))
        sample_participants = list(ptpt_stats.get('stats', {}).keys())[:sample_size]
        
        for ptpt_id in sample_participants:
            ptpt_data = ptpt_stats['stats'][ptpt_id]
            print(f"\n  Participant {ptpt_id}:")
            print(f"    - Group: {ptpt_data.get('group')}")
            print(f"    - Votes: {ptpt_data.get('n_votes')} (Agree: {ptpt_data.get('n_agree')}, Disagree: {ptpt_data.get('n_disagree')}, Pass: {ptpt_data.get('n_pass')})")
            
            print("    - Group correlations:")
            for group_id, corr in ptpt_data.get('group_correlations', {}).items():
                print(f"      - Group {group_id}: {corr:.2f}")
        
        print("\nRepresentativeness calculation SUCCESSFUL!")
        
    except Exception as e:
        print(f"Error during representativeness calculation: {e}")
        traceback.print_exc()
        print("Representativeness calculation FAILED!")

if __name__ == "__main__":
    # Test on both datasets
    test_repness_calculation('biodiversity')
    print("\n" + "="*50)
    test_repness_calculation('vw')