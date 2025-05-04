"""
Representativeness calculation for Pol.is.

This module calculates which comments best represent each opinion group,
using statistical tests to determine significance.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Union, Any
from copy import deepcopy
import math
from scipy import stats

from polismath.math.named_matrix import NamedMatrix
from polismath.utils.general import agree, disagree, pass_vote


# Statistical constants
Z_90 = 1.645  # Z-score for 90% confidence
Z_95 = 1.96   # Z-score for 95% confidence
PSEUDO_COUNT = 1.5  # Pseudocount for Bayesian smoothing


def z_score_sig_90(z: float) -> bool:
    """
    Check if z-score is significant at 90% confidence level.
    
    Args:
        z: Z-score to check
        
    Returns:
        True if significant at 90% confidence
    """
    return abs(z) >= Z_90


def z_score_sig_95(z: float) -> bool:
    """
    Check if z-score is significant at 95% confidence level.
    
    Args:
        z: Z-score to check
        
    Returns:
        True if significant at 95% confidence
    """
    return abs(z) >= Z_95


def prop_test(p: float, n: int, p0: float) -> float:
    """
    One-proportion z-test.
    
    Args:
        p: Observed proportion
        n: Number of observations
        p0: Expected proportion under null hypothesis
        
    Returns:
        Z-score
    """
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
    """
    Two-proportion z-test.
    
    Args:
        p1: First proportion
        n1: Number of observations for first proportion
        p2: Second proportion
        n2: Number of observations for second proportion
        
    Returns:
        Z-score
    """
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


def comment_stats(votes: np.ndarray, group_members: List[int]) -> Dict[str, Any]:
    """
    Calculate basic stats for a comment within a group.
    
    Args:
        votes: Array of votes (-1, 0, 1, or None) for the comment
        group_members: Indices of group members
        
    Returns:
        Dictionary of statistics
    """
    # Filter votes to only include group members
    group_votes = [votes[i] for i in group_members if i < len(votes)]
    
    # Count agrees, disagrees, and total votes
    n_agree = sum(1 for v in group_votes if agree(v))
    n_disagree = sum(1 for v in group_votes if disagree(v))
    n_votes = n_agree + n_disagree
    
    # Calculate probabilities with pseudocounts (Bayesian smoothing)
    p_agree = (n_agree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT) if n_votes > 0 else 0.5
    p_disagree = (n_disagree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT) if n_votes > 0 else 0.5
    
    # Calculate significance tests
    p_agree_test = prop_test(p_agree, n_votes, 0.5) if n_votes > 0 else 0.0
    p_disagree_test = prop_test(p_disagree, n_votes, 0.5) if n_votes > 0 else 0.0
    
    # Return stats
    return {
        'na': n_agree,
        'nd': n_disagree,
        'ns': n_votes,
        'pa': p_agree,
        'pd': p_disagree,
        'pat': p_agree_test,
        'pdt': p_disagree_test
    }


def add_comparative_stats(comment_stats: Dict[str, Any], 
                         other_stats: Dict[str, Any]) -> Dict[str, Any]:
    """
    Add comparative statistics between a group and others.
    
    Args:
        comment_stats: Statistics for the group
        other_stats: Statistics for other groups combined
        
    Returns:
        Enhanced statistics with comparative measures
    """
    result = deepcopy(comment_stats)
    
    # Calculate representativeness ratios
    result['ra'] = result['pa'] / other_stats['pa'] if other_stats['pa'] > 0 else 1.0
    result['rd'] = result['pd'] / other_stats['pd'] if other_stats['pd'] > 0 else 1.0
    
    # Calculate representativeness tests
    result['rat'] = two_prop_test(
        result['pa'], result['ns'], 
        other_stats['pa'], other_stats['ns']
    )
    
    result['rdt'] = two_prop_test(
        result['pd'], result['ns'], 
        other_stats['pd'], other_stats['ns']
    )
    
    return result


def repness_metric(stats: Dict[str, Any], key_prefix: str) -> float:
    """
    Calculate a representativeness metric for ranking.
    
    Args:
        stats: Statistics for a comment/group
        key_prefix: 'a' for agreement, 'd' for disagreement
        
    Returns:
        Composite representativeness score
    """
    # Get the relevant probability and test values
    p = stats[f'p{key_prefix}']
    p_test = stats[f'p{key_prefix}t']
    r = stats[f'r{key_prefix}']
    r_test = stats[f'r{key_prefix}t']
    
    # Take probability into account
    p_factor = p if key_prefix == 'a' else (1 - p)
    
    # Calculate composite score
    return p_factor * (abs(p_test) + abs(r_test))


def finalize_cmt_stats(stats: Dict[str, Any]) -> Dict[str, Any]:
    """
    Finalize comment statistics and determine if agree or disagree is more representative.
    
    Args:
        stats: Statistics for a comment/group
        
    Returns:
        Finalized statistics with best representativeness
    """
    result = deepcopy(stats)
    
    # Calculate agree and disagree metrics
    result['agree_metric'] = repness_metric(stats, 'a')
    result['disagree_metric'] = repness_metric(stats, 'd')
    
    # Determine whether agree or disagree is more representative
    if result['pa'] > 0.5 and result['ra'] > 1.0:
        # More agree than disagree, and more than other groups
        result['repful'] = 'agree'
    elif result['pd'] > 0.5 and result['rd'] > 1.0:
        # More disagree than agree, and more than other groups
        result['repful'] = 'disagree'
    else:
        # Use the higher metric
        if result['agree_metric'] >= result['disagree_metric']:
            result['repful'] = 'agree'
        else:
            result['repful'] = 'disagree'
    
    return result


def passes_by_test(stats: Dict[str, Any], repful: str, p_thresh: float = 0.5) -> bool:
    """
    Check if comment passes significance tests.
    
    Args:
        stats: Statistics for a comment/group
        repful: 'agree' or 'disagree'
        p_thresh: Probability threshold
        
    Returns:
        True if passes significance tests
    """
    key_prefix = 'a' if repful == 'agree' else 'd'
    p = stats[f'p{key_prefix}']
    p_test = stats[f'p{key_prefix}t']
    r_test = stats[f'r{key_prefix}t']
    
    # Check if proportion is high enough
    if p < p_thresh:
        return False
    
    # Check significance tests
    return z_score_sig_90(p_test) and z_score_sig_90(r_test)


def best_agree(all_stats: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Filter for best agreement comments.
    
    Args:
        all_stats: List of comment statistics
        
    Returns:
        Filtered list of comments that are best representatives by agreement
    """
    # Filter to comments more agreed with than disagreed with
    agree_stats = [s for s in all_stats if s['pa'] > s['pd']]
    
    # Filter to comments that pass significance tests
    passing = [s for s in agree_stats if passes_by_test(s, 'agree')]
    
    if passing:
        return passing
    else:
        return agree_stats


def best_disagree(all_stats: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Filter for best disagreement comments.
    
    Args:
        all_stats: List of comment statistics
        
    Returns:
        Filtered list of comments that are best representatives by disagreement
    """
    # Filter to comments more disagreed with than agreed with
    disagree_stats = [s for s in all_stats if s['pd'] > s['pa']]
    
    # Filter to comments that pass significance tests
    passing = [s for s in disagree_stats if passes_by_test(s, 'disagree')]
    
    if passing:
        return passing
    else:
        return disagree_stats


def select_rep_comments(all_stats: List[Dict[str, Any]],
                       agree_count: int = 3,
                       disagree_count: int = 2) -> List[Dict[str, Any]]:
    """
    Select representative comments for a group.
    
    Args:
        all_stats: List of comment statistics
        agree_count: Number of agreement comments to select
        disagree_count: Number of disagreement comments to select
        
    Returns:
        List of selected representative comments
    """
    if not all_stats:
        return []
    
    # Start with best agreement comments
    agree_comments = best_agree(all_stats)
    
    # Sort by agreement metric
    agree_comments = sorted(
        agree_comments, 
        key=lambda s: s['agree_metric'], 
        reverse=True
    )
    
    # Start with best disagreement comments
    disagree_comments = best_disagree(all_stats)
    
    # Sort by disagreement metric
    disagree_comments = sorted(
        disagree_comments, 
        key=lambda s: s['disagree_metric'], 
        reverse=True
    )
    
    # Select top comments
    selected = []
    
    # Add agreement comments
    for i, cmt in enumerate(agree_comments):
        if i < agree_count:
            cmt_copy = deepcopy(cmt)
            cmt_copy['repful'] = 'agree'
            selected.append(cmt_copy)
    
    # Add disagreement comments
    for i, cmt in enumerate(disagree_comments):
        if i < disagree_count:
            cmt_copy = deepcopy(cmt)
            cmt_copy['repful'] = 'disagree'
            selected.append(cmt_copy)
    
    # If we couldn't find enough, try to add more from the other category
    if len(selected) < agree_count + disagree_count:
        # Add more agreement comments if needed
        if len(selected) < agree_count + disagree_count and len(agree_comments) > agree_count:
            for i in range(agree_count, min(len(agree_comments), agree_count + disagree_count)):
                cmt_copy = deepcopy(agree_comments[i])
                cmt_copy['repful'] = 'agree'
                selected.append(cmt_copy)
        
        # Add more disagreement comments if needed
        if len(selected) < agree_count + disagree_count and len(disagree_comments) > disagree_count:
            for i in range(disagree_count, min(len(disagree_comments), agree_count + disagree_count)):
                cmt_copy = deepcopy(disagree_comments[i])
                cmt_copy['repful'] = 'disagree'
                selected.append(cmt_copy)
    
    # If still not enough, at least ensure one comment
    if not selected and all_stats:
        # Just take the first one
        cmt_copy = deepcopy(all_stats[0])
        cmt_copy['repful'] = cmt_copy.get('repful', 'agree')
        selected.append(cmt_copy)
    
    return selected


def calculate_kl_divergence(p: np.ndarray, q: np.ndarray) -> float:
    """
    Calculate Kullback-Leibler divergence between two probability distributions.
    
    Args:
        p: First probability distribution
        q: Second probability distribution
        
    Returns:
        KL divergence
    """
    # Replace zeros to avoid division by zero
    p = np.where(p == 0, 1e-10, p)
    q = np.where(q == 0, 1e-10, q)
    
    return np.sum(p * np.log(p / q))


def select_consensus_comments(all_stats: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Select comments with broad consensus.
    
    Args:
        all_stats: List of comment statistics for all groups
        
    Returns:
        List of consensus comments
    """
    # Group by comment
    by_comment = {}
    for stat in all_stats:
        cid = stat['comment_id']
        if cid not in by_comment:
            by_comment[cid] = []
        by_comment[cid].append(stat)
    
    # Comments that have stats for all groups
    consensus_candidates = []
    
    for cid, stats in by_comment.items():
        # Check if all groups mostly agree
        all_agree = all(s['pa'] > 0.6 for s in stats)
        
        if all_agree:
            # Calculate average agreement
            avg_agree = sum(s['pa'] for s in stats) / len(stats)
            
            # Add as consensus candidate
            consensus_candidates.append({
                'comment_id': cid,
                'avg_agree': avg_agree,
                'repful': 'consensus',
                'stats': stats
            })
    
    # Sort by average agreement
    consensus_candidates.sort(key=lambda x: x['avg_agree'], reverse=True)
    
    # Take top 2
    return consensus_candidates[:2]


def conv_repness(vote_matrix: NamedMatrix, group_clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Calculate representativeness for all comments and groups.
    
    Args:
        vote_matrix: NamedMatrix of votes
        group_clusters: List of group clusters
        
    Returns:
        Dictionary with representativeness data for each group
    """
    # Extract and clean the matrix values
    matrix_values = vote_matrix.values.copy()
    
    # Ensure the matrix contains numeric values
    if not np.issubdtype(matrix_values.dtype, np.number):
        # Convert to numeric matrix with proper NaN handling
        numeric_matrix = np.zeros(matrix_values.shape, dtype=float)
        for i in range(matrix_values.shape[0]):
            for j in range(matrix_values.shape[1]):
                val = matrix_values[i, j]
                if pd.isna(val) or val is None:
                    numeric_matrix[i, j] = np.nan
                else:
                    try:
                        numeric_matrix[i, j] = float(val)
                    except (ValueError, TypeError):
                        numeric_matrix[i, j] = np.nan
        matrix_values = numeric_matrix
    
    # Replace NaNs with None for the algorithm
    matrix_values = np.where(np.isnan(matrix_values), None, matrix_values)
    
    # Create empty-result structure in case we need to return early
    empty_result = {
        'comment_ids': vote_matrix.colnames(),
        'group_repness': {group['id']: [] for group in group_clusters},
        'consensus_comments': [],
        'comment_repness': []  # Add a list for all comment repness data
    }
    
    # Check if we have enough data
    if matrix_values.shape[0] < 2 or matrix_values.shape[1] < 2:
        return empty_result
    
    # Result will hold repness data for each group
    result = {
        'comment_ids': vote_matrix.colnames(),
        'group_repness': {},
        'comment_repness': []  # Add a list for all comment repness data
    }
    
    # For each group, calculate representativeness
    all_stats = []
    
    for group in group_clusters:
        group_id = group['id']
        
        # Convert member IDs to indices with error handling
        group_members = []
        for m in group['members']:
            try:
                if m in vote_matrix.rownames():
                    idx = vote_matrix.rownames().index(m)
                    if 0 <= idx < matrix_values.shape[0]:
                        group_members.append(idx)
            except (ValueError, TypeError) as e:
                print(f"Error finding member {m} in matrix: {e}")
        
        if not group_members:
            # Skip empty groups
            result['group_repness'][group_id] = []
            continue
        
        # Calculate other members (all participants not in this group)
        all_indices = list(range(matrix_values.shape[0]))
        other_members = [i for i in all_indices if i not in group_members]
        
        # Stats for each comment
        group_stats = []
        
        for c_idx, comment_id in enumerate(vote_matrix.colnames()):
            if c_idx >= matrix_values.shape[1]:
                continue
                
            comment_votes = matrix_values[:, c_idx]
            
            # Skip comments with no votes
            if not any(v is not None for v in comment_votes):
                continue
                
            try:
                # Calculate stats for this group
                stats = comment_stats(comment_votes, group_members)
                
                # Calculate stats for other groups
                other_stats = comment_stats(comment_votes, other_members)
                
                # Add comparative stats
                stats = add_comparative_stats(stats, other_stats)
                
                # Finalize stats
                stats = finalize_cmt_stats(stats)
                
                # Add metadata
                stats['comment_id'] = comment_id
                stats['group_id'] = group_id
                
                group_stats.append(stats)
                all_stats.append(stats)
                
                # Also add to the comment_repness list
                repness = {
                    'tid': comment_id,
                    'gid': group_id,
                    'repness': stats.get('agree_metric', 0) if stats.get('repful') == 'agree' else stats.get('disagree_metric', 0),
                    'pa': stats.get('pa', 0),
                    'pd': stats.get('pd', 0)
                }
                result['comment_repness'].append(repness)
            except Exception as e:
                print(f"Error calculating stats for comment {comment_id} in group {group_id}: {e}")
                continue
        
        try:
            # Select representative comments for this group
            rep_comments = select_rep_comments(group_stats)
            
            # Store in result
            result['group_repness'][group_id] = rep_comments
        except Exception as e:
            print(f"Error selecting representative comments for group {group_id}: {e}")
            result['group_repness'][group_id] = []
    
    # Add consensus comments if there are multiple groups
    try:
        if len(group_clusters) > 1 and all_stats:
            result['consensus_comments'] = select_consensus_comments(all_stats)
        else:
            result['consensus_comments'] = []
    except Exception as e:
        print(f"Error selecting consensus comments: {e}")
        result['consensus_comments'] = []
    
    return result


def participant_stats(vote_matrix: NamedMatrix, group_clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Calculate statistics about participants.
    
    Args:
        vote_matrix: NamedMatrix of votes
        group_clusters: List of group clusters
        
    Returns:
        Dictionary with participant statistics
    """
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
    
    # For each participant, calculate statistics
    for p_idx, participant_id in enumerate(vote_matrix.rownames()):
        if p_idx >= matrix_values.shape[0]:
            continue
            
        participant_votes = matrix_values[p_idx, :]
        
        # Count votes (non-zero values are votes)
        n_agree = np.sum(participant_votes > 0)
        n_disagree = np.sum(participant_votes < 0)
        n_pass = np.sum(participant_votes == 0) - np.count_nonzero(np.isnan(participant_votes))
        n_votes = n_agree + n_disagree
        
        # Skip participants with no votes
        if n_votes == 0:
            continue
            
        # Find participant's group
        participant_group = None
        for group in group_clusters:
            if participant_id in group['members']:
                participant_group = group['id']
                break
        
        # Calculate agreement with each group
        group_agreements = {}
        
        for group in group_clusters:
            group_id = group['id']
            
            try:
                # Get group member indices
                group_members = []
                for m in group['members']:
                    if m in vote_matrix.rownames():
                        idx = vote_matrix.rownames().index(m)
                        if 0 <= idx < matrix_values.shape[0]:
                            group_members.append(idx)
                
                if not group_members or len(group_members) < 3:
                    # Skip groups with too few members
                    group_agreements[group_id] = 0.0
                    continue
                
                # Calculate group average votes for each comment
                group_vote_matrix = matrix_values[group_members, :]
                group_avg_votes = np.mean(group_vote_matrix, axis=0)
                
                # Get participant's votes
                participant_vote_vector = participant_votes
                
                # Calculate correlation if enough votes
                # Mask comments that have fewer than 3 votes from group members
                valid_comment_mask = np.sum(group_vote_matrix != 0, axis=0) >= 3
                
                if np.sum(valid_comment_mask) >= 3:  # At least 3 common votes
                    # Extract votes for valid comments
                    p_votes = participant_vote_vector[valid_comment_mask]
                    g_votes = group_avg_votes[valid_comment_mask]
                    
                    # Calculate correlation
                    if np.std(p_votes) > 0 and np.std(g_votes) > 0:
                        correlation = np.corrcoef(p_votes, g_votes)[0, 1]
                        if not np.isnan(correlation):
                            group_agreements[group_id] = correlation
                        else:
                            group_agreements[group_id] = 0.0
                    else:
                        group_agreements[group_id] = 0.0
                else:
                    group_agreements[group_id] = 0.0
                    
            except Exception as e:
                # Fallback for errors
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
    
    return result