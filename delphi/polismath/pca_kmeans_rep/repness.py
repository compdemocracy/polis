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


# Statistical constants — one-tailed z-scores, matching Clojure (stats.clj)
# and Python's own stats.py (z_sig_90, z_sig_95).
# One-tailed: P(Z > z) = α, i.e. the entire rejection region is on one side.
Z_90 = 1.2816  # Z-score for 90% confidence (one-tailed)
Z_95 = 1.6449  # Z-score for 95% confidence (one-tailed)

# Pseudocount for Bayesian smoothing (Beta prior)
#
# Why use pseudocounts?
# - Prevents extreme probabilities (0 or 1) when sample sizes are small
# - With PSEUDO_COUNT = 2.0, we add 1 "virtual" agree and 1 "virtual" disagree
#   to each comment's vote count — equivalent to using a Beta(2,2) prior and
#   taking the posterior mode (MAP) estimate
# - This pulls probabilities toward 0.5, with the effect diminishing as n grows
# - Formula (MAP under Beta(2,2)): p_agree = (n_agree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT)
#                                  i.e.      (n_agree + 1) / (n_votes + 2)
#
# Matches Clojure's implementation (repness.clj).
PSEUDO_COUNT = 2.0


def z_score_sig_90(z: float) -> bool:
    """
    Check if z-score is significant at 90% confidence level.
    
    Args:
        z: Z-score to check
        
    Returns:
        True if significant at 90% confidence
    """
    return z > Z_90


def z_score_sig_95(z: float) -> bool:
    """
    Check if z-score is significant at 95% confidence level.
    
    Args:
        z: Z-score to check
        
    Returns:
        True if significant at 95% confidence
    """
    return z > Z_95


def prop_test(succ: int, n: int) -> float:
    """
    One-proportion z-test, matching Clojure's stats/prop-test (stats.clj:10-15).

    Clojure formula:
        (let [[succ n] (map inc [succ n])]
          (* 2 (sqrt n) (+ (/ succ n) -0.5)))

    Which simplifies to: 2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)

    This is a Wilson-score-like test with built-in +1 pseudocount (Laplace
    smoothing). Unlike the standard z-test ((p - p0) / sqrt(p0*(1-p0)/n)),
    the +1 terms regularize extreme values for small samples, preventing
    spurious significance in small Polis groups.

    Note: the pseudocount here (+1 to succ and n, i.e. Beta(1,1)) is
    independent of the PSEUDO_COUNT used for pa/pd computation (Beta(2,2)).
    Clojure's prop-test takes raw success counts, not pre-smoothed
    probabilities.

    Args:
        succ: Number of successes (e.g. agrees or disagrees)
        n: Total number of trials (votes seen)

    Returns:
        Z-score (positive means succ/n > 0.5)
    """
    if n == 0:
        return 0.0
    # Apply +1 pseudocount to both numerator and denominator
    succ_pc = succ + 1
    n_pc = n + 1
    return 2 * math.sqrt(n_pc) * (succ_pc / n_pc - 0.5)


def two_prop_test(succ_in: int, succ_out: int, pop_in: int, pop_out: int) -> float:
    """
    Two-proportion z-test with +1 pseudocount on all inputs.

    Matches Clojure's stats/two-prop-test (stats.clj:18-33):
      (let [[succ-in succ-out pop-in pop-out] (map inc [succ-in succ-out pop-in pop-out])
            pi1 (/ succ-in pop-in)
            pi2 (/ succ-out pop-out)
            pi-hat (/ (+ succ-in succ-out) (+ pop-in pop-out))]
        ...)

    The +1 pseudocount (Laplace smoothing) regularizes the z-score for small
    samples, preventing extreme values when group sizes are tiny.

    Args:
        succ_in: Number of successes in the group (e.g., agrees)
        succ_out: Number of successes outside the group
        pop_in: Total votes in the group
        pop_out: Total votes outside the group

    Returns:
        Z-score (positive means group proportion > other proportion)
    """
    if pop_in == 0 or pop_out == 0:
        return 0.0

    # Add +1 pseudocount to all four inputs (Clojure: map inc)
    s1 = succ_in + 1
    s2 = succ_out + 1
    p1 = pop_in + 1
    p2 = pop_out + 1

    pi1 = s1 / p1
    pi2 = s2 / p2
    pi_hat = (s1 + s2) / (p1 + p2)

    if pi_hat == 1.0:
        return 0.0

    se = math.sqrt(pi_hat * (1 - pi_hat) * (1/p1 + 1/p2))
    if se == 0:
        return 0.0
    return (pi1 - pi2) / se


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
    
    # Calculate significance tests — pass raw counts, matching Clojure's
    # (stats/prop-test na ns) and (stats/prop-test nd ns) (repness.clj:74-75)
    p_agree_test = prop_test(n_agree, n_votes) if n_votes > 0 else 0.0
    p_disagree_test = prop_test(n_disagree, n_votes) if n_votes > 0 else 0.0
    
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
    
    # Calculate representativeness tests — pass raw counts, matching Clojure's
    # (stats/two-prop-test (:na in-stats) (sum :na rest-stats)
    #                      (:ns in-stats) (sum :ns rest-stats))  (repness.clj:97-100)
    result['rat'] = two_prop_test(
        result['na'], other_stats['na'],
        result['ns'], other_stats['ns']
    )

    result['rdt'] = two_prop_test(
        result['nd'], other_stats['nd'],
        result['ns'], other_stats['ns']
    )
    
    return result


def repness_metric(stats: Dict[str, Any], key_prefix: str) -> float:
    """
    Calculate a representativeness metric for ranking.

    Matches Clojure's repness-metric (repness.clj:188-190):
        (* repness repness-test p-success p-test)

    This is a product of four signed values:
        For agree:   ra * rat * pa * pat
        For disagree: rd * rdt * pd * pdt

    The product formula is conservative: any factor near zero kills the
    entire metric, requiring ALL dimensions (probability, significance,
    relative representativeness) to be strong simultaneously.

    Args:
        stats: Statistics for a comment/group
        key_prefix: 'a' for agreement, 'd' for disagreement

    Returns:
        Composite representativeness score (signed)
    """
    p = stats[f'p{key_prefix}']
    p_test = stats[f'p{key_prefix}t']
    r = stats[f'r{key_prefix}']
    r_test = stats[f'r{key_prefix}t']

    return r * r_test * p * p_test


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

    # Determine whether agree or disagree is more representative.
    # Clojure (repness.clj:175-177): simple (if (> rat rdt) :agree :disagree)
    if stats['rat'] > stats['rdt']:
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

def prop_test_vectorized(succ: pd.Series, n: pd.Series) -> pd.Series:
    """
    Vectorized one-proportion z-test, matching Clojure's stats/prop-test.

    Formula: 2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)

    See prop_test() docstring for derivation and rationale.

    Args:
        succ: Series of success counts (e.g. agrees or disagrees)
        n: Series of total trial counts (votes seen)

    Returns:
        Series of z-scores
    """
    succ_pc = succ + 1
    n_pc = n + 1
    z = 2 * np.sqrt(n_pc) * (succ_pc / n_pc - 0.5)
    # Handle n=0 edge case (n_pc=1, succ_pc=1 → z = 2*1*(1/1 - 0.5) = 1.0,
    # but we want 0 for no-data rows)
    z = z.where(n > 0, 0.0)
    z = z.fillna(0.0)
    return z


def two_prop_test_vectorized(succ_in: pd.Series, succ_out: pd.Series,
                             pop_in: pd.Series, pop_out: pd.Series) -> pd.Series:
    """
    Vectorized two-proportion z-test with +1 pseudocount on all inputs.

    Matches Clojure's stats/two-prop-test (stats.clj:18-33).
    See two_prop_test() scalar version for formula details.

    Args:
        succ_in: Series of success counts in the group
        succ_out: Series of success counts outside the group
        pop_in: Series of total vote counts in the group
        pop_out: Series of total vote counts outside the group

    Returns:
        Series of z-scores
    """
    # Add +1 pseudocount to all four inputs (Clojure: map inc)
    s1 = succ_in + 1
    s2 = succ_out + 1
    p1 = pop_in + 1
    p2 = pop_out + 1

    pi1 = s1 / p1
    pi2 = s2 / p2
    pi_hat = (s1 + s2) / (p1 + p2)

    se = np.sqrt(pi_hat * (1 - pi_hat) * (1/p1 + 1/p2))
    z = (pi1 - pi2) / se

    # Handle edge cases: pop_in=0 or pop_out=0 → 0, pi_hat=1 → 0
    z = z.where((pop_in > 0) & (pop_out > 0), 0.0)
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

    # Compute proportion tests — pass raw counts, matching Clojure's
    # (stats/prop-test na ns) and (stats/prop-test nd ns) (repness.clj:74-75)
    stats_df['pat'] = prop_test_vectorized(stats_df['na'], stats_df['ns'])
    stats_df['pdt'] = prop_test_vectorized(stats_df['nd'], stats_df['ns'])

    # Compute representativeness ratios (group vs other)
    stats_df['ra'] = stats_df['pa'] / stats_df['other_pa']
    stats_df['rd'] = stats_df['pd'] / stats_df['other_pd']

    # Handle division by zero (other_pa or other_pd == 0)
    stats_df['ra'] = stats_df['ra'].replace([np.inf, -np.inf], 1.0).fillna(1.0)
    stats_df['rd'] = stats_df['rd'].replace([np.inf, -np.inf], 1.0).fillna(1.0)

    # Compute representativeness tests — pass raw counts, matching Clojure's
    # (stats/two-prop-test (:na in-stats) (sum :na rest-stats)
    #                      (:ns in-stats) (sum :ns rest-stats))  (repness.clj:97-100)
    stats_df['rat'] = two_prop_test_vectorized(
        stats_df['na'], stats_df['other_agree'],
        stats_df['ns'], stats_df['other_votes']
    )
    stats_df['rdt'] = two_prop_test_vectorized(
        stats_df['nd'], stats_df['other_disagree'],
        stats_df['ns'], stats_df['other_votes']
    )

    # Compute metrics — Clojure product formula (repness.clj:188-190):
    # agree_metric = ra * rat * pa * pat
    # disagree_metric = rd * rdt * pd * pdt
    stats_df['agree_metric'] = stats_df['ra'] * stats_df['rat'] * stats_df['pa'] * stats_df['pat']
    stats_df['disagree_metric'] = stats_df['rd'] * stats_df['rdt'] * stats_df['pd'] * stats_df['pdt']

    # Determine repful ('agree' or 'disagree')
    # Clojure (repness.clj:175-177): simple (if (> rat rdt) :agree :disagree)
    stats_df['repful'] = np.where(stats_df['rat'] > stats_df['rdt'], 'agree', 'disagree')

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
        # Check significance: pat > Z_90 and rat > Z_90
        passing_agree = agree_candidates[
            (agree_candidates['pat'] > Z_90) &
            (agree_candidates['rat'] > Z_90) &
            (agree_candidates['pa'] >= 0.5)
        ]
        if not passing_agree.empty:
            agree_candidates = passing_agree

    # Best disagree: pd > pa and passes significance tests
    disagree_candidates = stats_df[stats_df['pd'] > stats_df['pa']].copy()
    if not disagree_candidates.empty:
        passing_disagree = disagree_candidates[
            (disagree_candidates['pdt'] > Z_90) &
            (disagree_candidates['rdt'] > Z_90) &
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
