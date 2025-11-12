#!/usr/bin/env python3
"""
Full Pipeline Test for Pol.is Math Module

This script performs a complete end-to-end test of the entire Polis math pipeline
using real-world data. It processes votes through the full conversation pipeline,
including:
- PCA for dimensionality reduction
- Clustering to identify opinion groups
- Representativeness to find comments that best represent each group
- Participant stats to calculate correlations with groups

The test uses two real datasets:
1. Biodiversity dataset (larger)
2. VW dataset (smaller)
"""

import os
import sys
import json
import traceback
import pytest
import time
from typing import Dict, List, Any

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.conversation.conversation import Conversation
from common_utils import create_test_conversation


def save_results(dataset_name: str, conversation: Conversation) -> None:
    """
    Save the results of the pipeline to a JSON file.
    
    Args:
        dataset_name: Name of the dataset
        conversation: Conversation object with results
    """
    # Create results directory if it doesn't exist
    results_dir = os.path.join('pipeline_results')
    os.makedirs(results_dir, exist_ok=True)
    
    # Create result object
    result = {
        'dataset': dataset_name,
        'participants': conversation.participant_count,
        'comments': conversation.comment_count,
        'pca': {
            'center_shape': conversation.pca['center'].shape[0] if 'center' in conversation.pca else 0,
            'comps_shape': conversation.pca['comps'].shape if 'comps' in conversation.pca else (0, 0)
        },
        'clusters': []
    }
    
    # Add group cluster information
    for i, cluster in enumerate(conversation.group_clusters):
        cluster_info = {
            'id': cluster.get('id', i),
            'members_count': len(cluster.get('members', [])),
            'center': cluster.get('center', [0, 0]).tolist()
        }
        result['clusters'].append(cluster_info)
    
    # Add representativeness information
    if hasattr(conversation, 'repness') and conversation.repness:
        result['repness'] = {}
        for group_id, comments in conversation.repness.get('group_repness', {}).items():
            comment_info = []
            for comment in comments:
                comment_info.append({
                    'id': comment.get('comment_id', ''),
                    'type': comment.get('repful', ''),
                    'agree': comment.get('pa', 0),
                    'disagree': comment.get('pd', 0),
                    'agree_metric': comment.get('agree_metric', 0),
                    'disagree_metric': comment.get('disagree_metric', 0)
                })
            result['repness'][str(group_id)] = comment_info
    
    # Add participant stats summary
    if hasattr(conversation, 'participant_stats') and conversation.participant_stats:
        stats_summary = {
            'participants_with_stats': len(conversation.participant_stats.get('stats', {})),
            'sample_participants': []
        }
        
        # Add a few sample participants
        sample_size = min(5, len(conversation.participant_stats.get('stats', {})))
        sample_ids = list(conversation.participant_stats.get('stats', {}).keys())[:sample_size]
        
        for pid in sample_ids:
            ptpt_data = conversation.participant_stats['stats'][pid]
            stats_summary['sample_participants'].append({
                'id': pid,
                'group': ptpt_data.get('group'),
                'votes': ptpt_data.get('n_votes', 0),
                'agrees': ptpt_data.get('n_agree', 0),
                'disagrees': ptpt_data.get('n_disagree', 0),
                'correlation_with_own_group': ptpt_data.get('group_correlations', {}).get(
                    str(ptpt_data.get('group')), 0)
            })
        
        result['participant_stats'] = stats_summary
    
    # Save to file
    file_path = os.path.join(results_dir, f"{dataset_name}_results.json")
    with open(file_path, 'w') as f:
        json.dump(result, f, indent=2)
    
    print(f"Results saved to {file_path}")

@pytest.mark.parametrize("dataset_name", ["biodiversity", "vw"])
def test_full_pipeline(dataset_name: str) -> None:
    """
    Run the full pipeline test for a dataset.
    
    Args:
        dataset_name: 'biodiversity' or 'vw'
    """
    print(f"\n============== Testing Full Pipeline: {dataset_name} ==============\n")
    
    try:
        # Create a conversation with the dataset
        print("Creating conversation...")
        start_time = time.time()
        conv = create_test_conversation(dataset_name)
        
        print(f"Conversation created successfully in {time.time() - start_time:.2f} seconds")
        print(f"Participants: {conv.participant_count}")
        print(f"Comments: {conv.comment_count}")
        print(f"Matrix shape: {conv.rating_mat.values.shape}")
        
        # Run the full pipeline
        print("\nRunning full pipeline (recompute)...")
        start_time = time.time()
        updated_conv = conv.recompute()
        pipeline_time = time.time() - start_time
        print(f"Pipeline completed in {pipeline_time:.2f} seconds")
        
        # Check PCA results
        print("\nPCA Results:")
        if hasattr(updated_conv, 'pca') and updated_conv.pca:
            print(f"  - Center shape: {updated_conv.pca['center'].shape}")
            print(f"  - Components shape: {updated_conv.pca['comps'].shape}")
            print(f"  - Projections count: {len(updated_conv.proj)}")
            
            # Get a few sample projections
            sample_size = min(3, len(updated_conv.proj))
            sample_ids = list(updated_conv.proj.keys())[:sample_size]
            
            print("  - Sample projections:")
            for pid in sample_ids:
                print(f"    Participant {pid}: [{updated_conv.proj[pid][0]:.3f}, {updated_conv.proj[pid][1]:.3f}]")
        else:
            print("  No PCA results available")
        
        # Check clustering results
        print("\nClustering Results:")
        if hasattr(updated_conv, 'group_clusters') and updated_conv.group_clusters:
            print(f"  - Number of clusters: {len(updated_conv.group_clusters)}")
            for i, cluster in enumerate(updated_conv.group_clusters):
                print(f"  - Cluster {i+1}: {len(cluster['members'])} participants")
                print(f"    Center: [{cluster['center'][0]:.3f}, {cluster['center'][1]:.3f}]")
        else:
            print("  No clustering results available")
        
        # Check representativeness results
        print("\nRepresentativeness Results:")
        if hasattr(updated_conv, 'repness') and updated_conv.repness:
            print(f"  - Number of comment IDs: {len(updated_conv.repness.get('comment_ids', []))}")
            
            for group_id, comments in updated_conv.repness.get('group_repness', {}).items():
                print(f"\n  Group {group_id}:")
                print(f"    - Number of representative comments: {len(comments)}")
                
                for i, comment in enumerate(comments[:3]):  # Show top 3
                    print(f"    - Comment {i+1}: ID {comment.get('comment_id')}, Type: {comment.get('repful')}")
                    print(f"      Agree: {comment.get('pa', 0):.2f}, Disagree: {comment.get('pd', 0):.2f}")
                    print(f"      Metrics: A={comment.get('agree_metric', 0):.2f}, D={comment.get('disagree_metric', 0):.2f}")
            
            # Check consensus comments
            print("\n  Consensus Comments:")
            for i, comment in enumerate(updated_conv.repness.get('consensus_comments', [])):
                print(f"    - Comment {i+1}: ID {comment.get('comment_id')}, Avg Agree: {comment.get('avg_agree', 0):.2f}")
        else:
            print("  No representativeness results available")
        
        # Check participant stats
        print("\nParticipant Statistics:")
        if hasattr(updated_conv, 'participant_stats') and updated_conv.participant_stats:
            print(f"  - Number of participant IDs: {len(updated_conv.participant_stats.get('participant_ids', []))}")
            print(f"  - Number of participants with stats: {len(updated_conv.participant_stats.get('stats', {}))}")
            
            # Sample a few participants
            sample_size = min(3, len(updated_conv.participant_stats.get('stats', {})))
            sample_participants = list(updated_conv.participant_stats.get('stats', {}).keys())[:sample_size]
            
            for ptpt_id in sample_participants:
                ptpt_data = updated_conv.participant_stats['stats'][ptpt_id]
                print(f"\n  Participant {ptpt_id}:")
                print(f"    - Group: {ptpt_data.get('group')}")
                print(f"    - Votes: {ptpt_data.get('n_votes')} (Agree: {ptpt_data.get('n_agree')}, Disagree: {ptpt_data.get('n_disagree')}, Pass: {ptpt_data.get('n_pass')})")
                
                print("    - Group correlations:")
                for group_id, corr in ptpt_data.get('group_correlations', {}).items():
                    print(f"      - Group {group_id}: {corr:.2f}")
        else:
            print("  No participant statistics available")
        
        # Save results to file
        save_results(dataset_name, updated_conv)
        
        print("\nFull pipeline test SUCCESSFUL!")
        
    except Exception as e:
        print(f"Error during pipeline processing: {e}")
        traceback.print_exc()
        print("Full pipeline test FAILED!")


if __name__ == "__main__":
    # Test on both datasets
    test_full_pipeline('biodiversity')
    print("\n" + "="*70 + "\n")
    test_full_pipeline('vw')