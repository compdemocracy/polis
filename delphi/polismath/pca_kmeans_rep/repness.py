"""
Representativeness calculation for Pol.is.

This module calculates which comments best represent each opinion group,
using statistical tests to determine significance.
"""

import numpy as np
import pandas as pd
from typing import Any, Dict, List

from polismath.utils.general import AGREE, DISAGREE


# Statistical constants
Z_90 = 1.2816  # One-tailed Z-score for 90% confidence (matches Clojure stats/z-sig-90?)
Z_95 = 1.6449  # One-tailed Z-score for 95% confidence (matches Clojure stats/z-sig-95?)

# Pseudocount for additive smoothing of agree/disagree proportions
#
# Why use pseudocounts?
# - Prevents extreme probabilities (0 or 1) when sample sizes are small.
# - With PSEUDO_COUNT = 2.0, we add 1 "virtual" agree and 1 "virtual" disagree
#   to each comment's vote count, then compute the proportion:
#       p_agree = (n_agree + 1) / (n_votes + 2)
#   Two equivalent ways to justify this formula — pick whichever framing you
#   know best:
#     * Frequentist/combinatorial: Laplace's rule of succession (the classic
#       +1/+2 add-one smoothing).
#     * Bayesian: the MAP (mode) estimate of the posterior under a Beta(2,2)
#       prior. (Not the posterior mean, which would be (n+2)/(ns+4).)
# - Pulls probabilities toward 0.5, with the effect diminishing as n grows.
# - General formula: p_agree = (n_agree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT)
#
# Matches Clojure's implementation (repness.clj, which applies the same +1/+2
# smoothing without justifying it in comments).
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


# =============================================================================
# Vectorized DataFrame-native functions for multi-group operations
# =============================================================================

def prop_test_vectorized(succ: pd.Series, n: pd.Series) -> pd.Series:
    """
    Vectorized one-proportion z-test, matching Clojure's stats/prop-test
    (math/src/polismath/math/stats.clj:10-15).

    Scalar equivalent (the formula this implements element-wise):

        def prop_test(succ, n):
            return 2 * sqrt(n + 1) * ((succ + 1) / (n + 1) - 0.5)

    Wilson-score-like test with built-in +1 pseudocount (Laplace / Beta(1,1)
    smoothing). The +1 terms regularize extreme values for small samples,
    preventing spurious significance in small Polis groups. Unlike the standard
    z-test ((p - p0) / sqrt(p0*(1-p0)/n)), this formulation never divides by
    zero — n=0 collapses to `2*sqrt(1)*(1/1 - 0.5) = 1.0` after smoothing.

    No n=0 short-circuit (Clojure parity — stats.clj:10-15 has no guard).

    Note: the pseudocount here (Beta(1,1)) is independent of the PSEUDO_COUNT
    used for pa/pd computation (Beta(2,2)). prop_test takes RAW success and
    trial counts, not pre-smoothed probabilities.

    Args:
        succ: Series of success counts (e.g. `na` or `nd` per row).
        n: Series of trial counts. In all current callers this is `ns = na + nd`
           (AGREE + DISAGREE per row) — PASS votes are NOT included, matching
           what Clojure passes as `n-trials`. If you call this from elsewhere,
           supply `na + nd` rather than a "total votes seen including pass" count.

    Returns:
        Series of z-scores. Positive when the smoothed proportion (succ+1)/(n+1)
        > 0.5 (equivalent to succ >= n/2). Differs slightly from raw-ratio
        succ/n > 0.5 because of the +1 pseudocount on both numerator and
        denominator.
    """
    succ_pc = succ + 1
    n_pc = n + 1
    z = 2 * np.sqrt(n_pc) * (succ_pc / n_pc - 0.5)
    # No n=0 short-circuit — Clojure parity (see scalar prop_test). n=0 rows
    # collapse to 1.0 via the +1 pseudocount; downstream callers do not gate on it.
    # numpy stubs lose Series-ness through np.sqrt, so pyright types z as NDArray
    # and can't see .fillna. See pyright #4081.
    z = z.fillna(0.0)  # pyright: ignore[reportAttributeAccessIssue]
    return z


def two_prop_test_vectorized(succ_in: pd.Series, succ_out: pd.Series,
                             pop_in: pd.Series, pop_out: pd.Series) -> pd.Series:
    """
    Vectorized two-proportion z-test with +1 pseudocount on all inputs,
    matching Clojure's stats/two-prop-test
    (math/src/polismath/math/stats.clj:18-33).

    Scalar equivalent (the formula this implements element-wise):

        def two_prop_test(succ_in, succ_out, pop_in, pop_out):
            s1, s2 = succ_in + 1, succ_out + 1
            p1, p2 = pop_in + 1, pop_out + 1
            pi1, pi2 = s1 / p1, s2 / p2
            pi_hat = (s1 + s2) / (p1 + p2)
            if pi_hat == 1.0:
                return 0.0  # Clojure: "could solve via limits" (stats.clj:26-27)
            se = sqrt(pi_hat * (1 - pi_hat) * (1/p1 + 1/p2))
            return (pi1 - pi2) / se

    +1 pseudocount (Laplace / Beta(1,1)) regularizes z-scores for small samples;
    Clojure increments all four inputs unconditionally via (map inc ...) so
    pop=0 becomes pop=1 and the test proceeds. The only early-return is
    pi_hat == 1.

    No pop_in/pop_out short-circuit (Clojure parity). Vectorized handling:
    - pi_hat == 1 → SE = 0 → z = NaN → fillna(0.0).
    - pi_hat > 1 (na > pop, unreachable in real data) → sqrt of negative → NaN → 0.0.
    - Division by zero → ±inf → replaced with 0.0.

    Args:
        succ_in: Series of success counts in the group (e.g. agrees).
        succ_out: Series of success counts outside the group.
        pop_in: Series of total vote counts in the group.
        pop_out: Series of total vote counts outside the group.

    Returns:
        Series of z-scores (positive means group proportion > other proportion).
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

    # No pop_in/pop_out short-circuit (Clojure parity — see scalar two_prop_test).
    # pi_hat==1 and pi_hat>1 (NaN from sqrt of negative) collapse to 0 via fillna;
    # division by 0 inf cases collapse via replace.
    z = z.fillna(0.0)
    z = z.replace([np.inf, -np.inf], 0.0)
    return z


def compute_group_comment_stats_df(votes_long: pd.DataFrame,
                                   group_clusters: List[Dict[str, Any]]) -> pd.DataFrame:
    """
    Compute vote counts and probabilities for all (group, comment) pairs.

    Vectorized port of Clojure's per-(group, comment) `comment-stats` recipe
    (math/src/polismath/math/repness.clj:64-100). Operates on all groups and
    comments simultaneously.

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

    # Compute metrics
    # Clojure (repness.clj:191-193): (* repness repness-test p-success p-test)
    #   agree_metric    = ra * rat * pa * pat
    #   disagree_metric = rd * rdt * pd * pdt
    # Signed product — no abs(). Negative z-scores flip the sign of the metric;
    # downstream selection sorts descending, so negative-metric comments rank
    # at the bottom of the candidate pool but are not filtered here.
    stats_df['agree_metric'] = (stats_df['ra'] * stats_df['rat']
                                 * stats_df['pa'] * stats_df['pat'])
    stats_df['disagree_metric'] = (stats_df['rd'] * stats_df['rdt']
                                    * stats_df['pd'] * stats_df['pdt'])

    # Clojure (repness.clj:178): (if (> rat rdt) ... :agree ... :disagree)
    # Pure comparison of rat vs rdt — no probability/ratio thresholds.
    stats_df['repful'] = np.where(stats_df['rat'] > stats_df['rdt'], 'agree', 'disagree')

    return stats_df


def select_rep_comments_df(stats_df: pd.DataFrame,
                           agree_count: int = 3,
                           disagree_count: int = 2) -> pd.DataFrame:
    """
    Select representative comments for a single group from a DataFrame.

    NOTE (PR 14a / D10): this is the current Python selection logic — a
    botched port that does not match Clojure's `select-rep-comments`
    (math/src/polismath/math/repness.clj:212-281). D10 will replace it with
    a single-pass reduce matching Clojure (up to 5 total, agrees-first,
    best-agree priority slot). Until then, this path is preserved as-is.

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
    """Convert a stats DataFrame row to the per-(group, comment) dict format
    consumed by `conv_repness` output (math blob `repness` / `comment_repness`)."""
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

