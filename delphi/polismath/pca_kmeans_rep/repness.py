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

from polismath.utils.general import AGREE, DISAGREE


# Statistical constants
Z_90 = 1.645  # Z-score for 90% confidence
Z_95 = 1.96   # Z-score for 95% confidence

# Pseudocount for Bayesian smoothing (Laplace smoothing / additive smoothing)
#
# Why use pseudocounts?
# - Prevents extreme probabilities (0 or 1) when sample sizes are small
# - With PSEUDO_COUNT = 1.5, we effectively add 0.75 "virtual" agrees and
#   0.75 "virtual" disagrees to each comment's vote count
# - This pulls probabilities toward 0.5 (the prior), with the effect diminishing
#   as sample size grows
# - Formula: p_agree = (n_agree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT)
#
# Example: With 3 agrees out of 4 votes:
#   - Raw probability: 3/4 = 0.75
#   - Smoothed (PSEUDO_COUNT=1.5): (3 + 0.75) / (4 + 1.5) = 3.75/5.5 ≈ 0.68
PSEUDO_COUNT = 1.5


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
    group_votes = votes[group_members]

    # Count agrees, disagrees, and total votes
    n_agree = np.sum(group_votes == AGREE)
    n_disagree = np.sum(group_votes == DISAGREE)
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


# =============================================================================
# Vectorized DataFrame-native functions for multi-group operations
# =============================================================================

def prop_test_vectorized(p: pd.Series, n: pd.Series, p0: float = 0.5) -> pd.Series:
    """
    Vectorized one-proportion z-test.

    Args:
        p: Series of observed proportions
        n: Series of number of observations
        p0: Expected proportion under null hypothesis (default: 0.5)

    Returns:
        Series of z-scores
    """
    se = np.sqrt(p0 * (1 - p0) / n)
    z = (p - p0) / se
    # Handle edge cases: n=0, p0=0, p0=1 all result in 0
    z = z.fillna(0.0)
    z = z.replace([np.inf, -np.inf], 0.0)
    return z


def two_prop_test_vectorized(p1: pd.Series, n1: pd.Series,
                             p2: pd.Series, n2: pd.Series) -> pd.Series:
    """
    Vectorized two-proportion z-test.

    Args:
        p1: Series of first proportions
        n1: Series of number of observations for first proportion
        p2: Series of second proportions
        n2: Series of number of observations for second proportion

    Returns:
        Series of z-scores
    """
    # Pooled probability
    p_pooled = (p1 * n1 + p2 * n2) / (n1 + n2)

    # Standard error
    se = np.sqrt(p_pooled * (1 - p_pooled) * (1/n1 + 1/n2))

    # Z-score calculation
    z = (p1 - p2) / se

    # Handle edge cases
    z = z.fillna(0.0)
    z = z.replace([np.inf, -np.inf], 0.0)
    return z


def compute_group_comment_stats_df(votes_long: pd.DataFrame,
                                   group_clusters: List[Dict[str, Any]]) -> pd.DataFrame:
    """
    Compute vote counts and probabilities for all (group, comment) pairs.

    This is the vectorized version of comment_stats() that operates on all
    groups and comments simultaneously.

    Args:
        votes_long: Long-format DataFrame with columns:
            - 'participant': participant ID
            - 'comment': comment ID
            - 'vote': vote value (AGREE, DISAGREE, PASS, or NaN)
        group_clusters: List of group clusters

    Returns:
        DataFrame indexed by (group_id, comment) with columns:
            - na: number of agrees
            - nd: number of disagrees
            - ns: number of votes (agrees + disagrees)
            - pa: probability of agree (with pseudocount smoothing)
            - pd: probability of disagree (with pseudocount smoothing)
            - pat: proportion test z-score for agree
            - pdt: proportion test z-score for disagree
            - ra: representativeness ratio for agree (group vs other)
            - rd: representativeness ratio for disagree (group vs other)
            - rat: representativeness test z-score for agree
            - rdt: representativeness test z-score for disagree
            - agree_metric: metric for agree representativeness
            - disagree_metric: metric for disagree representativeness
            - repful: 'agree' or 'disagree' based on which is more representative
    """
    # Build participant -> group mapping
    ptpt_to_group = {}
    for group in group_clusters:
        for member in group['members']:
            ptpt_to_group[member] = group['id']

    # Drop NaN votes (unvoted) first - this applies to all participants
    votes_only = votes_long.dropna(subset=['vote'])

    if votes_only.empty:
        # Return empty DataFrame with correct schema
        return pd.DataFrame(columns=['na', 'nd', 'ns', 'pa', 'pd', 'pat', 'pdt'])

    # Compute total counts per comment BEFORE filtering to group members
    # This matches the old behavior where "other" included ALL participants
    # not in the current group (even those not in any cluster)
    total_counts = votes_only.groupby('comment').agg(
        total_agree=('vote', lambda x: (x == AGREE).sum()),
        total_disagree=('vote', lambda x: (x == DISAGREE).sum()),
    )
    total_counts['total_votes'] = total_counts['total_agree'] + total_counts['total_disagree']

    # Now add group column and filter to only group members
    votes_with_group = votes_only.copy()
    votes_with_group['group_id'] = votes_with_group['participant'].map(ptpt_to_group)

    # Keep only votes from participants in some group (for group-specific counts)
    votes_in_groups = votes_with_group.dropna(subset=['group_id'])

    if votes_in_groups.empty:
        # Return empty DataFrame with correct schema
        return pd.DataFrame(columns=['na', 'nd', 'ns', 'pa', 'pd', 'pat', 'pdt'])

    # Get all unique comments that have at least one vote (from anyone)
    all_comments = total_counts.index.tolist()

    # Get all group IDs
    all_group_ids = [group['id'] for group in group_clusters]

    # Compute vote counts per (group, comment) for votes from group members
    group_counts = votes_in_groups.groupby(['group_id', 'comment']).agg(
        na=('vote', lambda x: (x == AGREE).sum()),
        nd=('vote', lambda x: (x == DISAGREE).sum()),
    )
    group_counts['ns'] = group_counts['na'] + group_counts['nd']

    # Create full index with all (group, comment) combinations to match old behavior
    # Old implementation: for each group, iterate over ALL comments (that have any votes)
    full_index = pd.MultiIndex.from_product(
        [all_group_ids, all_comments],
        names=['group_id', 'comment']
    )

    # Reindex to include all combinations, filling missing with 0
    group_counts = group_counts.reindex(full_index, fill_value=0)

    # Join total counts to group counts
    stats_df = group_counts.join(total_counts, on='comment')

    # Compute "other" counts (everyone not in this group)
    stats_df['other_agree'] = stats_df['total_agree'] - stats_df['na']
    stats_df['other_disagree'] = stats_df['total_disagree'] - stats_df['nd']
    stats_df['other_votes'] = stats_df['total_votes'] - stats_df['ns']

    # Compute probabilities with pseudocounts (Bayesian smoothing)
    # For group
    stats_df['pa'] = (stats_df['na'] + PSEUDO_COUNT/2) / (stats_df['ns'] + PSEUDO_COUNT)
    stats_df['pd'] = (stats_df['nd'] + PSEUDO_COUNT/2) / (stats_df['ns'] + PSEUDO_COUNT)

    # Handle ns == 0 case: default to uninformative prior (0.5)
    zero_mask = stats_df['ns'] == 0
    stats_df.loc[zero_mask, 'pa'] = 0.5
    stats_df.loc[zero_mask, 'pd'] = 0.5

    # For "other" group
    stats_df['other_pa'] = (stats_df['other_agree'] + PSEUDO_COUNT/2) / (stats_df['other_votes'] + PSEUDO_COUNT)
    stats_df['other_pd'] = (stats_df['other_disagree'] + PSEUDO_COUNT/2) / (stats_df['other_votes'] + PSEUDO_COUNT)

    other_zero_mask = stats_df['other_votes'] == 0
    stats_df.loc[other_zero_mask, 'other_pa'] = 0.5
    stats_df.loc[other_zero_mask, 'other_pd'] = 0.5

    # Compute proportion tests (group vs 0.5)
    stats_df['pat'] = prop_test_vectorized(stats_df['pa'], stats_df['ns'], 0.5)
    stats_df['pdt'] = prop_test_vectorized(stats_df['pd'], stats_df['ns'], 0.5)

    # Compute representativeness ratios (group vs other)
    stats_df['ra'] = stats_df['pa'] / stats_df['other_pa']
    stats_df['rd'] = stats_df['pd'] / stats_df['other_pd']

    # Handle division by zero (other_pa or other_pd == 0)
    stats_df['ra'] = stats_df['ra'].replace([np.inf, -np.inf], 1.0).fillna(1.0)
    stats_df['rd'] = stats_df['rd'].replace([np.inf, -np.inf], 1.0).fillna(1.0)

    # Compute representativeness tests (two-proportion z-test: group vs other)
    stats_df['rat'] = two_prop_test_vectorized(
        stats_df['pa'], stats_df['ns'],
        stats_df['other_pa'], stats_df['other_votes']
    )
    stats_df['rdt'] = two_prop_test_vectorized(
        stats_df['pd'], stats_df['ns'],
        stats_df['other_pd'], stats_df['other_votes']
    )

    # Compute metrics
    # agree_metric = pa * (|pat| + |rat|)
    # disagree_metric = (1 - pd) * (|pdt| + |rdt|)
    stats_df['agree_metric'] = stats_df['pa'] * (stats_df['pat'].abs() + stats_df['rat'].abs())
    stats_df['disagree_metric'] = (1 - stats_df['pd']) * (stats_df['pdt'].abs() + stats_df['rdt'].abs())

    # Determine repful ('agree' or 'disagree')
    # Logic: if pa > 0.5 and ra > 1.0 -> 'agree'
    #        elif pd > 0.5 and rd > 1.0 -> 'disagree'
    #        else: use higher metric
    conditions = [
        (stats_df['pa'] > 0.5) & (stats_df['ra'] > 1.0),
        (stats_df['pd'] > 0.5) & (stats_df['rd'] > 1.0),
    ]
    choices = ['agree', 'disagree']
    stats_df['repful'] = np.select(conditions, choices,
                                   default=np.where(stats_df['agree_metric'] >= stats_df['disagree_metric'],
                                                    'agree', 'disagree'))

    return stats_df


def select_rep_comments_df(stats_df: pd.DataFrame,
                           agree_count: int = 3,
                           disagree_count: int = 2) -> pd.DataFrame:
    """
    Select representative comments for a single group from a DataFrame.

    DataFrame-native version of select_rep_comments().

    Args:
        stats_df: DataFrame with comment statistics for ONE group
        agree_count: Number of agreement comments to select
        disagree_count: Number of disagreement comments to select

    Returns:
        DataFrame of selected representative comments
    """
    if stats_df.empty:
        return stats_df

    total_wanted = agree_count + disagree_count

    # Best agree: pa > pd and passes significance tests
    agree_candidates = stats_df[stats_df['pa'] > stats_df['pd']].copy()
    if not agree_candidates.empty:
        # Check significance: |pat| >= Z_90 and |rat| >= Z_90
        passing_agree = agree_candidates[
            (agree_candidates['pat'].abs() >= Z_90) &
            (agree_candidates['rat'].abs() >= Z_90) &
            (agree_candidates['pa'] >= 0.5)
        ]
        if not passing_agree.empty:
            agree_candidates = passing_agree

    # Best disagree: pd > pa and passes significance tests
    disagree_candidates = stats_df[stats_df['pd'] > stats_df['pa']].copy()
    if not disagree_candidates.empty:
        passing_disagree = disagree_candidates[
            (disagree_candidates['pdt'].abs() >= Z_90) &
            (disagree_candidates['rdt'].abs() >= Z_90) &
            (disagree_candidates['pd'] >= 0.5)
        ]
        if not passing_disagree.empty:
            disagree_candidates = passing_disagree

    # Sort candidates by metric
    if not agree_candidates.empty:
        agree_candidates = agree_candidates.sort_values('agree_metric', ascending=False)
    if not disagree_candidates.empty:
        disagree_candidates = disagree_candidates.sort_values('disagree_metric', ascending=False)

    # Select top N from each category
    selected_parts = []

    if not agree_candidates.empty:
        top_agree = agree_candidates.head(agree_count).copy()
        top_agree['repful'] = 'agree'
        selected_parts.append(top_agree)

    if not disagree_candidates.empty:
        top_disagree = disagree_candidates.head(disagree_count).copy()
        top_disagree['repful'] = 'disagree'
        selected_parts.append(top_disagree)

    if selected_parts:
        selected = pd.concat(selected_parts, ignore_index=False)
    else:
        selected = pd.DataFrame()

    # If we couldn't find enough, try to fill from available candidates
    # This matches the exact behavior of the old select_rep_comments() function:
    # - First fallback adds agree_comments[agree_count:min(len, total_wanted)] regardless of
    #   whether we exceed total_wanted (up to disagree_count more agrees)
    # - Second fallback only runs if STILL < total_wanted
    if len(selected) < total_wanted:
        # Try to add more agree comments
        # Old code: range(agree_count, min(len(agree_comments), agree_count + disagree_count))
        if not agree_candidates.empty and len(agree_candidates) > agree_count:
            extra_limit = min(len(agree_candidates), total_wanted)
            extra_agrees = agree_candidates.iloc[agree_count:extra_limit].copy()
            extra_agrees['repful'] = 'agree'
            selected = pd.concat([selected, extra_agrees], ignore_index=False)

        # Try to add more disagree comments (only if still not enough)
        # Old code: range(disagree_count, min(len(disagree_comments), agree_count + disagree_count))
        if len(selected) < total_wanted and not disagree_candidates.empty and len(disagree_candidates) > disagree_count:
            extra_limit = min(len(disagree_candidates), total_wanted)
            extra_disagrees = disagree_candidates.iloc[disagree_count:extra_limit].copy()
            extra_disagrees['repful'] = 'disagree'
            selected = pd.concat([selected, extra_disagrees], ignore_index=False)

    # Fallback: if still empty, take first row
    if selected.empty and not stats_df.empty:
        selected = stats_df.head(1).copy()
        selected['repful'] = selected['repful'].iloc[0] if 'repful' in selected.columns else 'agree'

    return selected


def select_consensus_comments_df(stats_df: pd.DataFrame,
                                  n_groups: int) -> List[Dict[str, Any]]:
    """
    Select consensus comments from DataFrame.

    Args:
        stats_df: DataFrame with all (group, comment) statistics
        n_groups: Number of groups

    Returns:
        List of consensus comment dicts
    """
    if stats_df.empty:
        return []

    # Group by comment and check if all groups have high agreement
    stats_reset = stats_df.reset_index()
    comment_stats = stats_reset.groupby('comment').agg(
        min_pa=('pa', 'min'),
        avg_pa=('pa', 'mean'),
        group_count=('group_id', 'count')
    )

    # Filter to comments where all groups agree (pa > 0.6 for all)
    # and present in all groups
    consensus = comment_stats[
        (comment_stats['min_pa'] > 0.6) &
        (comment_stats['group_count'] == n_groups)
    ].copy()

    if consensus.empty:
        return []

    # Sort by average agreement and take top 2
    consensus = consensus.nlargest(2, 'avg_pa')

    # Convert to list of dicts using _stats_row_to_dict for legacy format
    result = []
    for comment_id in consensus.index:
        comment_rows = stats_reset[stats_reset['comment'] == comment_id]
        # Convert each row to legacy dict format
        stats_list = [_stats_row_to_dict(row) for _, row in comment_rows.iterrows()]
        result.append({
            'comment_id': comment_id,
            'avg_agree': consensus.loc[comment_id, 'avg_pa'],
            'repful': 'consensus',
            'stats': stats_list
        })

    return result


def _stats_row_to_dict(row: pd.Series) -> Dict[str, Any]:
    """Convert a stats DataFrame row to the legacy dict format."""
    return {
        'comment_id': row['comment'],
        'group_id': row['group_id'],
        'na': int(row['na']),
        'nd': int(row['nd']),
        'ns': int(row['ns']),
        'pa': row['pa'],
        'pd': row['pd'],
        'pat': row['pat'],
        'pdt': row['pdt'],
        'ra': row['ra'],
        'rd': row['rd'],
        'rat': row['rat'],
        'rdt': row['rdt'],
        'agree_metric': row['agree_metric'],
        'disagree_metric': row['disagree_metric'],
        'repful': row['repful'],
    }


def conv_repness(vote_matrix_df: pd.DataFrame, group_clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Calculate representativeness for all comments and groups.

    Uses a vectorized long-format DataFrame approach for efficiency.

    Args:
        vote_matrix_df: pd.DataFrame of matrix of votes (participants × comments)
            Values should be AGREE (1), DISAGREE (-1), PASS (0), or NaN (unvoted)
        group_clusters: List of group clusters, each with 'id' and 'members'

    Returns:
        Dictionary with representativeness data for each group:
            - comment_ids: list of comment IDs
            - group_repness: dict mapping group_id -> list of representative comments
            - consensus_comments: list of consensus comments
            - comment_repness: list of all comment repness data
    """
    # Create empty-result structure in case we need to return early
    empty_result = {
        'comment_ids': vote_matrix_df.columns.tolist(),
        'group_repness': {group['id']: [] for group in group_clusters},
        'consensus_comments': [],
        'comment_repness': []
    }

    # Check if we have enough data
    if vote_matrix_df.shape[0] < 2 or vote_matrix_df.shape[1] < 2:
        return empty_result

    # Convert wide-format to long-format DataFrame
    # Wide: participants × comments (values = votes)
    # Long: participant | comment | vote
    votes_long = vote_matrix_df.melt(
        ignore_index=False,
        var_name='comment',
        value_name='vote'
    ).reset_index(names='participant')

    # Ensure vote column is numeric (handle object dtype with None values)
    votes_long['vote'] = pd.to_numeric(votes_long['vote'], errors='coerce')

    # Compute all stats using vectorized function
    stats_df = compute_group_comment_stats_df(votes_long, group_clusters)

    if stats_df.empty:
        return empty_result

    # Reset index for easier manipulation
    stats_df_reset = stats_df.reset_index()

    # Build comment_repness list (vectorized)
    stats_df_reset['repness'] = np.where(
        stats_df_reset['repful'] == 'agree',
        stats_df_reset['agree_metric'],
        stats_df_reset['disagree_metric']
    )
    comment_repness = stats_df_reset[['comment', 'group_id', 'repness', 'pa', 'pd']].copy()
    comment_repness.columns = ['tid', 'gid', 'repness', 'pa', 'pd']

    # Build result structure
    result = {
        'comment_ids': vote_matrix_df.columns.tolist(),
        'group_repness': {},
        'comment_repness': comment_repness.to_dict('records')
    }

    # Select representative comments per group (DataFrame operations)
    for group in group_clusters:
        group_id = group['id']
        group_stats = stats_df_reset[stats_df_reset['group_id'] == group_id]

        if group_stats.empty:
            result['group_repness'][group_id] = []
            continue

        try:
            rep_df = select_rep_comments_df(group_stats)
            # Convert to list of dicts only at the end
            rep_comments = [_stats_row_to_dict(row) for _, row in rep_df.iterrows()]
            result['group_repness'][group_id] = rep_comments
        except Exception as e:
            print(f"Error selecting representative comments for group {group_id}: {e}")
            result['group_repness'][group_id] = []

    # Add consensus comments if there are multiple groups
    try:
        if len(group_clusters) > 1:
            result['consensus_comments'] = select_consensus_comments_df(
                stats_df, len(group_clusters)
            )
        else:
            result['consensus_comments'] = []
    except Exception as e:
        print(f"Error selecting consensus comments: {e}")
        result['consensus_comments'] = []

    return result


def participant_stats(vote_matrix: pd.DataFrame, group_clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Calculate statistics about participants.
    
    Args:
        vote_matrix: pd.DataFrame of votes
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
        'participant_ids': vote_matrix.index.tolist(),
        'stats': {}
    }
    
    # For each participant, calculate statistics
    for p_idx, participant_id in enumerate(vote_matrix.index):
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
                    if m in vote_matrix.index:
                        idx = vote_matrix.index.get_loc(m)
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