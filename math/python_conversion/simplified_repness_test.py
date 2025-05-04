#!/usr/bin/env python3
"""
Simplified test script for the representativeness calculation.
This script shows a simplified version of the repness calculation.
"""

import os
import sys
import numpy as np
import pandas as pd
from typing import Dict, List, Any
import traceback
import math

# Load data from the previous simplified test
from simplified_test import load_votes, pca_simple, project_data, kmeans_clustering

# Constants
Z_90 = 1.645  # Z-score for 90% confidence
PSEUDO_COUNT = 1.5  # Pseudocount for Bayesian smoothing

def prop_test(p: float, n: int, p0: float) -> float:
    """One-proportion z-test."""
    if n == 0 or p0 == 0 or p0 == 1:
        return 0.0
    
    # Calculate standard error
    se = math.sqrt(p0 * (1 - p0) / n)
    
    # Z-score calculation
    if se == 0:
        return 0.0
    else:
        return (p - p0) / se

def two_prop_test(p1: float, n1: int, p2: float, n2: int) -> float:
    """Two-proportion z-test."""
    if n1 == 0 or n2 == 0:
        return 0.0
    
    # Pooled probability
    p = (p1 * n1 + p2 * n2) / (n1 + n2)
    
    # Standard error
    se = math.sqrt(p * (1 - p) * (1/n1 + 1/n2))
    
    # Z-score calculation
    if se == 0:
        return 0.0
    else:
        return (p1 - p2) / se

def calculate_comment_stats(vote_matrix: np.ndarray, cluster_members: List[int], comment_idx: int) -> Dict[str, Any]:
    """Calculate statistics for a comment within a group."""
    # Get votes for this comment
    comment_votes = vote_matrix[:, comment_idx]
    
    # Filter votes to only include group members
    group_votes = [comment_votes[i] for i in cluster_members if i < len(comment_votes)]
    
    # Count agrees, disagrees, and total votes
    n_agree = sum(1 for v in group_votes if not np.isnan(v) and v > 0)
    n_disagree = sum(1 for v in group_votes if not np.isnan(v) and v < 0)
    n_votes = n_agree + n_disagree
    
    # Calculate probabilities with pseudocounts (Bayesian smoothing)
    p_agree = (n_agree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT) if n_votes > 0 else 0.5
    p_disagree = (n_disagree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT) if n_votes > 0 else 0.5
    
    # Calculate significance tests
    p_agree_test = prop_test(p_agree, n_votes, 0.5) if n_votes > 0 else 0.0
    p_disagree_test = prop_test(p_disagree, n_votes, 0.5) if n_votes > 0 else 0.0
    
    # Return stats
    return {
        'comment_idx': comment_idx,
        'na': n_agree,
        'nd': n_disagree,
        'ns': n_votes,
        'pa': p_agree,
        'pd': p_disagree,
        'pat': p_agree_test,
        'pdt': p_disagree_test
    }

def calculate_repness(vote_matrix: np.ndarray, clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Calculate representativeness for comments and groups."""
    n_comments = vote_matrix.shape[1]
    result = {
        'group_repness': {}
    }
    
    # For each group, calculate representativeness
    for group_idx, group in enumerate(clusters):
        group_id = group['id']
        group_members = group['members']
        other_members = [i for i in range(vote_matrix.shape[0]) if i not in group_members]
        
        # Calculate stats for all comments for this group
        group_stats = []
        
        for comment_idx in range(n_comments):
            # Get stats for this comment for this group
            group_comment_stats = calculate_comment_stats(vote_matrix, group_members, comment_idx)
            
            # Get stats for this comment for other groups
            other_comment_stats = calculate_comment_stats(vote_matrix, other_members, comment_idx)
            
            # Add comparative stats
            # Calculate representativeness ratios
            ra = group_comment_stats['pa'] / other_comment_stats['pa'] if other_comment_stats['pa'] > 0 else 1.0
            rd = group_comment_stats['pd'] / other_comment_stats['pd'] if other_comment_stats['pd'] > 0 else 1.0
            
            # Calculate representativeness tests
            rat = two_prop_test(
                group_comment_stats['pa'], group_comment_stats['ns'], 
                other_comment_stats['pa'], other_comment_stats['ns']
            )
            
            rdt = two_prop_test(
                group_comment_stats['pd'], group_comment_stats['ns'], 
                other_comment_stats['pd'], other_comment_stats['ns']
            )
            
            # Add to group stats with comparative metrics
            combined_stats = {
                **group_comment_stats,
                'ra': ra,
                'rd': rd,
                'rat': rat,
                'rdt': rdt
            }
            
            # Calculate agree/disagree metrics
            combined_stats['agree_metric'] = combined_stats['pa'] * (abs(combined_stats['pat']) + abs(combined_stats['rat']))
            combined_stats['disagree_metric'] = combined_stats['pd'] * (abs(combined_stats['pdt']) + abs(combined_stats['rdt']))
            
            # Determine whether agree or disagree is more representative
            if combined_stats['pa'] > 0.5 and combined_stats['ra'] > 1.0:
                combined_stats['repful'] = 'agree'
            elif combined_stats['pd'] > 0.5 and combined_stats['rd'] > 1.0:
                combined_stats['repful'] = 'disagree'
            else:
                if combined_stats['agree_metric'] >= combined_stats['disagree_metric']:
                    combined_stats['repful'] = 'agree'
                else:
                    combined_stats['repful'] = 'disagree'
            
            group_stats.append(combined_stats)
        
        # Select top comments by agree/disagree metrics
        agree_comments = sorted(
            [s for s in group_stats if s['pa'] > s['pd']],
            key=lambda s: s['agree_metric'],
            reverse=True
        )[:3]  # Take top 3 agree comments
        
        disagree_comments = sorted(
            [s for s in group_stats if s['pd'] > s['pa']],
            key=lambda s: s['disagree_metric'],
            reverse=True
        )[:2]  # Take top 2 disagree comments
        
        # Combine selected comments
        selected = agree_comments + disagree_comments
        
        # Store in result
        result['group_repness'][group_id] = selected
    
    return result

def run_test(dataset_name: str) -> None:
    """Run a test on a dataset."""
    print(f"\n============== Testing Simplified Repness: {dataset_name} ==============\n")
    
    try:
        # Load votes
        print("Loading votes...")
        vote_matrix, ptpt_ids, cmt_ids = load_votes(dataset_name)
        
        print(f"Matrix shape: {vote_matrix.shape}")
        
        # Handle missing values for PCA and clustering
        print("Running PCA and clustering...")
        vote_matrix_clean = np.nan_to_num(vote_matrix, nan=0.0)
        pca_results = pca_simple(vote_matrix_clean)
        projections = project_data(vote_matrix_clean, pca_results)
        clusters = kmeans_clustering(projections, n_clusters=3)
        
        # Run representativeness calculation with original data (with NaNs)
        print("Calculating representativeness...")
        repness_results = calculate_repness(vote_matrix, clusters)
        
        # Print results
        print("\nRepresentativeness Results:")
        for group_id, comments in repness_results['group_repness'].items():
            print(f"\nGroup {group_id}:")
            print(f"  Number of representative comments: {len(comments)}")
            
            for i, comment in enumerate(comments):
                comment_idx = comment['comment_idx']
                comment_id = cmt_ids[comment_idx] if comment_idx < len(cmt_ids) else comment_idx
                
                print(f"  Comment {i+1}: ID {comment_id}, Type: {comment['repful']}")
                print(f"    Agree: {comment['pa']:.2f}, Disagree: {comment['pd']:.2f}")
                print(f"    Agree ratio: {comment.get('ra', 0):.2f}, Disagree ratio: {comment.get('rd', 0):.2f}")
                print(f"    Agree metric: {comment['agree_metric']:.2f}, Disagree metric: {comment['disagree_metric']:.2f}")
        
        print("\nSimplified representativeness test SUCCESSFUL!")
        
    except Exception as e:
        print(f"Error during processing: {e}")
        traceback.print_exc()
        print("Simplified representativeness test FAILED!")


if __name__ == "__main__":
    # Run tests on both datasets
    run_test('biodiversity')
    print("\n" + "="*70)
    run_test('vw')