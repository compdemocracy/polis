"""
Optimized participant info computation module.

This module provides an optimized version of the participant_info computation
used in the Conversation class, specifically focused on improving performance.
"""

import numpy as np
import pandas as pd
import time
import logging
from typing import Dict, List, Any

from polismath.math.named_matrix import NamedMatrix

logger = logging.getLogger(__name__)

def compute_participant_info_optimized(vote_matrix: NamedMatrix, group_clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Optimized version of the participant info computation.
    
    Args:
        vote_matrix: The vote matrix containing participant votes
        group_clusters: The group clusters from clustering
        
    Returns:
        Dictionary with participant information including group correlations
    """
    start_time = time.time()
    
    if not group_clusters:
        return {}
    
    # Extract values and ensure they're numeric
    matrix_values = vote_matrix.values.copy()
    
    # Convert to numeric matrix with NaN for missing values
    if not np.issubdtype(matrix_values.dtype, np.number):
        numeric_values = np.zeros(matrix_values.shape, dtype=float)
        for i in range(matrix_values.shape[0]):
            for j in range(matrix_values.shape[1]):
                val = matrix_values[i, j]
                if pd.isna(val) or val is None:
                    numeric_values[i, j] = np.nan
                else:
                    try:
                        numeric_values[i, j] = float(val)
                    except (ValueError, TypeError):
                        numeric_values[i, j] = np.nan
        matrix_values = numeric_values
    
    # Replace NaNs with zeros for correlation calculation
    matrix_values = np.nan_to_num(matrix_values, nan=0.0)
    
    # Create result structure
    result = {
        'participant_ids': vote_matrix.rownames(),
        'stats': {}
    }
    
    prep_time = time.time() - start_time
    logger.info(f"Participant stats prep time: {prep_time:.2f}s")
    
    # For each participant, calculate statistics
    participant_count = len(vote_matrix.rownames())
    logger.info(f"Processing statistics for {participant_count} participants...")
    
    # OPTIMIZATION 1: Precompute mappings and lookup tables
    
    # Precompute mapping of participant IDs to indices for faster lookups
    ptpt_idx_map = {ptpt_id: idx for idx, ptpt_id in enumerate(vote_matrix.rownames())}
    
    # Precompute group membership lookups
    ptpt_group_map = {}
    for group in group_clusters:
        for member in group['members']:
            ptpt_group_map[member] = group['id']
    
    # OPTIMIZATION 2: Precompute group data
    
    # Precompute group member indices for each group
    group_member_indices = {}
    for group in group_clusters:
        group_id = group['id']
        member_indices = []
        for member in group['members']:
            if member in ptpt_idx_map:
                idx = ptpt_idx_map[member]
                if 0 <= idx < matrix_values.shape[0]:
                    member_indices.append(idx)
        group_member_indices[group_id] = member_indices
    
    # OPTIMIZATION 3: Precompute group vote matrices and average votes
    
    # Precompute group vote matrices and their valid comment masks
    group_vote_matrices = {}
    group_avg_votes = {}
    group_valid_masks = {}
    
    for group_id, member_indices in group_member_indices.items():
        if len(member_indices) >= 3:  # Only calculate for groups with enough members
            # Extract the group vote matrix
            group_vote_matrix = matrix_values[member_indices, :]
            group_vote_matrices[group_id] = group_vote_matrix
            
            # Calculate average votes per comment for this group
            group_avg_votes[group_id] = np.mean(group_vote_matrix, axis=0)
            
            # Precompute which comments have at least 3 votes from this group
            group_valid_masks[group_id] = np.sum(group_vote_matrix != 0, axis=0) >= 3
    
    # OPTIMIZATION 4: Use vectorized operations for participant stats
    
    process_start = time.time()
    batch_start = time.time()
    
    for p_idx, participant_id in enumerate(vote_matrix.rownames()):
        if p_idx >= matrix_values.shape[0]:
            continue
            
        # Print progress for large participant sets
        if participant_count > 100 and p_idx % 100 == 0:
            now = time.time()
            elapsed = now - process_start
            batch_time = now - batch_start
            batch_start = now
            percent = (p_idx / participant_count) * 100
            logger.info(f"Processed {p_idx}/{participant_count} participants ({percent:.1f}%) - " +
                       f"Elapsed: {elapsed:.2f}s, Batch: {batch_time:.4f}s")
        
        # Get participant votes
        participant_votes = matrix_values[p_idx, :]
        
        # Count votes using vectorized operations
        n_agree = np.sum(participant_votes > 0)
        n_disagree = np.sum(participant_votes < 0)
        n_pass = np.sum(participant_votes == 0) 
        n_votes = n_agree + n_disagree
        
        # Skip participants with no votes
        if n_votes == 0:
            continue
            
        # Find participant's group using precomputed mapping
        participant_group = ptpt_group_map.get(participant_id)
        
        # OPTIMIZATION 5: Efficient group correlation calculation
        
        # Calculate agreement with each group - optimized version
        group_agreements = {}
        
        for group_id, member_indices in group_member_indices.items():
            if len(member_indices) < 3:
                # Skip groups with too few members
                group_agreements[group_id] = 0.0
                continue
            
            if group_id not in group_avg_votes or group_id not in group_valid_masks:
                group_agreements[group_id] = 0.0
                continue
                
            # Use precomputed data
            g_votes = group_avg_votes[group_id]
            valid_mask = group_valid_masks[group_id]
            
            if np.sum(valid_mask) >= 3:  # At least 3 valid comments
                # Extract only valid comment votes
                p_votes = participant_votes[valid_mask]
                g_votes_valid = g_votes[valid_mask]
                
                # Fast correlation calculation
                p_std = np.std(p_votes)
                g_std = np.std(g_votes_valid)
                
                if p_std > 0 and g_std > 0:
                    # Use numpy's built-in correlation (faster and more numerically stable)
                    correlation = np.corrcoef(p_votes, g_votes_valid)[0, 1]
                    
                    if not np.isnan(correlation):
                        group_agreements[group_id] = correlation
                    else:
                        group_agreements[group_id] = 0.0
                else:
                    group_agreements[group_id] = 0.0
            else:
                group_agreements[group_id] = 0.0
        
        # Store participant stats
        result['stats'][participant_id] = {
            'n_agree': int(n_agree),
            'n_disagree': int(n_disagree),
            'n_pass': int(n_pass),
            'n_votes': int(n_votes),
            'group': participant_group,
            'group_correlations': group_agreements
        }
    
    total_time = time.time() - start_time
    process_time = time.time() - process_start
    logger.info(f"Participant stats completed in {total_time:.2f}s (preparation: {prep_time:.2f}s, processing: {process_time:.2f}s)")
    logger.info(f"Processed {len(result['stats'])} participants with {len(group_clusters)} groups")
    
    return result