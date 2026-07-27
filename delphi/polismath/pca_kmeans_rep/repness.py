"""
Representativeness calculation for Pol.is.

This module calculates which comments best represent each opinion group,
using statistical tests to determine significance.
"""

import numpy as np
import pandas as pd
from typing import Any, Dict, Iterable, List, Optional, Tuple

from polismath.utils.engine_mode import ENGINE_MODE_LEGACY, resolve_engine_mode
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
        n: Series of trial counts. In all current callers this is `ns` = the
           count of ALL non-nil votes INCLUDING PASS (`notna().sum()`),
           matching Clojure's `count-votes` with no vote arg
           (`(count (filter identity votes))` — 0/PASS is truthy in Clojure,
           repness.clj:56-61; ns-PASS fix 2026-06-11). If you call this from
           elsewhere, supply the PASS-inclusive non-nil count, NOT `na + nd`.

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
                                   group_clusters: List[Dict[str, Any]],
                                   tid_order: Optional[List[Any]] = None) -> pd.DataFrame:
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
            - ns: number of votes (agrees + disagrees + PASS, Clojure parity;
                  see repness.clj:56-61, :70)
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

    # Add group column and identify votes from clustered participants
    votes_with_group = votes_only.copy()
    votes_with_group['group_id'] = votes_with_group['participant'].map(ptpt_to_group)

    # Keep only votes from participants in some group (for group-specific counts)
    votes_in_groups = votes_with_group.dropna(subset=['group_id'])

    # Totals feed the "other" (rest) side of the comparison below.
    #
    # clojure-legacy: Clojure's rest-stats sum per-group comment-stats over
    # the OTHER GROUPS only (utils/mapv-rest, repness.clj:125-131), and group
    # membership is unfolded through base clusters — so votes from
    # participants in NO cluster never enter the comparison. Totals must
    # therefore come from clustered voters only (FP-69c7a13580/FP-faac8c6125).
    #
    # improved: keeps the historical behavior where "other" included ALL
    # participants not in the current group (even those not in any cluster).
    #
    # total_votes counts agree + disagree + PASS, matching Clojure's
    # `count-votes` (math/src/polismath/math/repness.clj:56-61, :70).
    # `count-votes` called with no `vote` arg uses `identity` as the filter
    # predicate; in Clojure 0 is truthy, so PASS (0) votes are kept. NaN
    # entries are already dropped above. Use size() to count non-NaN rows.
    total_source = (
        votes_in_groups
        if resolve_engine_mode() == ENGINE_MODE_LEGACY
        else votes_only
    )
    total_counts = total_source.groupby('comment').agg(
        total_agree=('vote', lambda x: (x == AGREE).sum()),
        total_disagree=('vote', lambda x: (x == DISAGREE).sum()),
        total_votes=('vote', 'size'),
    )
    # The comment universe stays votes_only-based in BOTH modes (Clojure
    # iterates every matrix column; a comment voted on only by unclustered
    # participants still gets an all-zero stats row).
    all_voted_comments = votes_only['comment'].unique()
    total_counts = total_counts.reindex(all_voted_comments, fill_value=0)

    if votes_in_groups.empty:
        # Return empty DataFrame with correct schema
        return pd.DataFrame(columns=['na', 'nd', 'ns', 'pa', 'pd', 'pat', 'pdt'])

    # Get all unique comments that have at least one vote (from anyone).
    # With tid_order (clojure-legacy), rows follow Clojure's named-matrix
    # column order (first-vote arrival) so downstream stable sorts break
    # exact-score ties identically; unknown comments keep their default
    # position at the tail (defensive — tid_order normally covers all).
    all_comments = total_counts.index.tolist()
    if tid_order is not None:
        known = set(all_comments)
        ordered = [t for t in tid_order if t in known]
        ordered_set = set(ordered)
        all_comments = ordered + [t for t in all_comments if t not in ordered_set]

    # Get all group IDs
    all_group_ids = [group['id'] for group in group_clusters]

    # Compute vote counts per (group, comment) for votes from group members.
    #
    # ns counts agree + disagree + PASS, matching Clojure's `count-votes`
    # (math/src/polismath/math/repness.clj:56-61, :70). `count-votes` with
    # no `vote` arg uses `identity` as filter; in Clojure 0 is truthy, so
    # PASS (0) votes count. NaN entries were already dropped above. Use
    # size() to count non-NaN rows.
    group_counts = votes_in_groups.groupby(['group_id', 'comment']).agg(
        na=('vote', lambda x: (x == AGREE).sum()),
        nd=('vote', lambda x: (x == DISAGREE).sum()),
        ns=('vote', 'size'),
    )

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


# =============================================================================
# D10: Selection helpers (Clojure parity for select-rep-comments)
# =============================================================================
#
# Ports of Clojure's `select-rep-comments` and its three predicates from
# math/src/polismath/math/repness.clj:133-281. Operate on per-(group, comment)
# dict rows produced by `compute_group_comment_stats_df` (via to_dict('records')).
# Per-row dict ops + small per-group iteration (rather than vectorized) because
# `beats_best_agr` has a 4-branch decision against a moving "current best"
# that updates during iteration; vectorizing would require multiple passes
# without saving lines (per-group N typically <500 comments).


def passes_by_test(s: Dict[str, Any]) -> bool:
    """
    Clojure passes-by-test? (repness.clj:165-170).

    True iff the agree side OR the disagree side passes z-sig-90 on BOTH
    the proportion test (pat/pdt) and the representativeness test (rat/rdt).
    No probability gate — pre-D10 Python's `pa >= 0.5` gate was a Python-only
    over-restriction without a Clojure analog.

        (or (and (z-sig-90? rat) (z-sig-90? pat))
            (and (z-sig-90? rdt) (z-sig-90? pdt)))
    """
    return (
        (z_score_sig_90(s['rat']) and z_score_sig_90(s['pat']))
        or (z_score_sig_90(s['rdt']) and z_score_sig_90(s['pdt']))
    )


def beats_best_by_test(s: Dict[str, Any], current_best_z: Optional[float]) -> bool:
    """
    Clojure beats-best-by-test? (repness.clj:133-139).

    True if `s` has a more-representative max(rat, rdt) than `current_best_z`,
    OR if there is no current best yet. Strict `>` (Clojure: `>`).

        (or (nil? current-best-z)
            (> (max rat rdt) current-best-z))
    """
    if current_best_z is None:
        return True
    return max(s['rat'], s['rdt']) > current_best_z


def beats_best_agr(s: Dict[str, Any],
                   current_best: Optional[Dict[str, Any]]) -> bool:
    """
    Clojure beats-best-agr? (repness.clj:142-162).

    Four mutually exclusive branches:

    1. `na == 0 and nd == 0`: reject. Comments with no votes never enter the
       best-agree slot (Clojure: `(= 0 na nd)` → false).
    2. `current_best` exists AND `current_best['ra'] > 1.0`: compare the
       4-way signed product `ra * rat * pa * pat`. New row must beat the
       current best on this product.
    3. `current_best` exists (else, i.e. `current_best['ra'] <= 1.0`):
       compare `pa * pat` only — "shoot for something generally agreed upon"
       when the current best isn't representative enough.
    4. No `current_best`: accept if `z90(pat)` OR `(ra > 1.0 AND pa > 0.5)`.

    `current_best` here is the RAW stats row (Clojure stores raw at
    repness.clj:250 so this comparator keeps the `ra/rat/pa/pat` surface).
    """
    if s['na'] == 0 and s['nd'] == 0:  # Branch 1.
        return False
    if current_best is not None and current_best['ra'] > 1.0:  # Branch 2.
        return (s['ra'] * s['rat'] * s['pa'] * s['pat']) > (
            current_best['ra'] * current_best['rat']
            * current_best['pa'] * current_best['pat']
        )
    if current_best is not None:  # Branch 3.
        return (s['pa'] * s['pat']) > (current_best['pa'] * current_best['pat'])
    # Branch 4.
    return z_score_sig_90(s['pat']) or (s['ra'] > 1.0 and s['pa'] > 0.5)


def _finalize_row_for_output(row: Dict[str, Any], *,
                             is_best_agree: bool = False) -> Dict[str, Any]:
    """
    Format a per-(group, comment) stats row for the final repness output
    (math blob `repness` / `group_repness`).

    Mirrors Clojure `finalize-cmt-stats` (repness.clj:173-188) plus the
    best-agree flagging at repness.clj:262-264.

    When `is_best_agree=True`, two extra keys are added:
        - `best_agree`: True
        - `n_agree`: the raw `na` (preserves the agree count even when the
          row is classified as 'disagree' by `rat > rdt`).

    Key naming uses Python convention (underscored). Clojure-style hyphens
    (`repful-for`, `n-agree`, etc.) are deferred to a future math-blob
    alignment PR (see PLAN.md "Pending — needs team discussion").

    `agree_metric` / `disagree_metric` are read directly from the row
    (produced by `compute_group_comment_stats_df`) rather than recomputed.
    Recomputing here would duplicate the formula at repness.clj:191-193 in
    two places and risk drift if it ever changes (decision D10.8.3).
    """
    repful = 'agree' if row['rat'] > row['rdt'] else 'disagree'
    finalized: Dict[str, Any] = {
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
        'repful': repful,
    }
    if is_best_agree:
        finalized['best_agree'] = True
        finalized['n_agree'] = int(row['na'])
    return finalized


def select_rep_comments_df(stats_df: pd.DataFrame,
                           mod_out: Optional[Iterable[int]] = None,
                           preserve_order: bool = False
                           ) -> Tuple[pd.DataFrame, Optional[Dict[str, Any]]]:
    """
    Select representative comments for a single group (Clojure parity).

    Single-pass reduce over the group's (gid, tid) rows, mirroring
    `select-rep-comments` in math/src/polismath/math/repness.clj:212-281.

    Per-row state {sufficient, best, best_agree}:
      - `passes_by_test(row)` → append finalized row to `sufficient`.
      - `:sufficient` still empty AND `beats_best_by_test` → update `best`.
      - `beats_best_agr(row, best_agree)` → store RAW row as new `best_agree`.

    Final assembly (decision S2 / D10.4):
      - `sufficient` non-empty: dedup best_agree from sufficient → sort by
        agree/disagree metric (descending, signed product per repness.clj:191)
        → take up to 5 (post-prepend → 4 sufficient max) → agrees-before-
        disagrees on the sufficient slice. The best-agree dict is returned
        SEPARATELY so the DataFrame stays clean (no NaN best_agree/n_agree
        columns when the slot is empty).
      - Else: `(empty_df, best_agree_dict)` if best_agree exists, else
        `(single_row_df_for_best, None)` if best exists, else
        `(empty_df, None)`.

    Args:
        stats_df: DataFrame with comment statistics for ONE group, schema
            as produced by `compute_group_comment_stats_df`.
        mod_out: Optional iterable of tids to exclude (moderated-out comments).
            Filter applied before the reduce (Clojure repness.clj:222).

    Returns:
        `(rep_df, best_agree_dict)` tuple:
          - `rep_df`: DataFrame of finalized rep-comment rows in math-blob
            shape (see `_finalize_row_for_output`) — does NOT include the
            best-agree slot, and carries NO `best_agree`/`n_agree` columns.
            Already ordered agrees-before-disagrees and capped so that
            `len(rep_df) + (1 if best_agree_dict else 0) <= 5`.
          - `best_agree_dict`: Standalone finalized dict for the best-agree
            slot (with `best_agree=True` and `n_agree=<na>`), or `None` if
            no candidate qualified. The caller is responsible for prepending
            it to the flat output list.
    """
    empty_df: pd.DataFrame = pd.DataFrame()

    if stats_df.empty:
        return empty_df, None

    # `is not None`, not truthiness: mod_out may be a numpy array / pandas
    # Index, whose bare truth value raises for len>1 (Copilot 2026-07-04).
    mod_out_set = set(mod_out) if mod_out is not None else set()
    sufficient: List[Dict[str, Any]] = []
    best: Optional[Dict[str, Any]] = None
    # Track best's max(rat, rdt) as a sidecar scalar so we never have to mutate
    # `best` itself with synthetic comparison keys. Avoids the leak/pop dance
    # of stashing a `_max_rt` inside the finalized dict (decision D10.8.4).
    best_max_rt: Optional[float] = None
    best_agree: Optional[Dict[str, Any]] = None

    # Iteration order decides ties: all Clojure beats-*? predicates use
    # strict `>` so the FIRST row at a tied score wins, and repness-sort is
    # a stable sort over the iteration order (repness.clj:196-200).
    #
    # preserve_order=True (clojure-legacy via conv_repness's tid_order): rows
    # already follow Clojure's named-matrix column order — first-vote ARRIVAL
    # order, which is NOT tid-ascending in general (verified on the vw replay:
    # clj tids open [24, 19, 47, …]) — so iterate as-given.
    #
    # preserve_order=False (improved / direct callers): sort by `comment`
    # ascending for deterministic ties (decision D10.8.1; its "insertion
    # order == ascending" cold-start assumption holds only for tid-ordered
    # vote streams, hence the legacy path above).
    iter_df = (
        stats_df
        if preserve_order
        else stats_df.sort_values('comment', kind='mergesort')
    )

    for row in iter_df.to_dict('records'):
        if row['comment'] in mod_out_set:
            continue
        if passes_by_test(row):
            sufficient.append(_finalize_row_for_output(row))
        # Update `best` only while sufficient is still empty (Clojure parity).
        if not sufficient:
            if beats_best_by_test(row, best_max_rt):
                best = _finalize_row_for_output(row)
                best_max_rt = max(row['rat'], row['rdt'])
        # `best_agree` stores RAW row (Clojure repness.clj:250) so subsequent
        # `beats_best_agr` calls keep the ra/rat/pa/pat surface.
        if beats_best_agr(row, best_agree):
            best_agree = row

    # Build the standalone best-agree dict (or None) once — used in every
    # assembly branch below.
    best_agree_dict: Optional[Dict[str, Any]] = (
        _finalize_row_for_output(best_agree, is_best_agree=True)
        if best_agree is not None else None
    )

    # Assembly.
    if not sufficient:
        if best_agree_dict is not None:
            # Best-agree slot returned separately; rep_df stays empty.
            return empty_df, best_agree_dict
        if best is not None:
            return pd.DataFrame([best]), None
        return empty_df, None

    # Sufficient non-empty path.
    best_agree_tid = best_agree['comment'] if best_agree is not None else None
    # Dedup best_agree from sufficient (caller will re-prepend it).
    deduped = [s for s in sufficient if s['comment_id'] != best_agree_tid]

    # Sort each row by its winning-side metric (signed product, per Clojure
    # repness.clj:191-193). Clojure (repness.clj:191-200) sorts by a single
    # `:repness-metric` field that `finalize-cmt-stats` populates per the
    # winning side. We achieve equivalent ranking by reading `agree_metric`
    # for repful=='agree' rows and `disagree_metric` otherwise — same
    # comparator value, just a different key per row (decision D10.8.2).
    def _sort_key(s: Dict[str, Any]) -> float:
        return s['agree_metric'] if s['repful'] == 'agree' else s['disagree_metric']
    deduped.sort(key=_sort_key, reverse=True)

    # TODO(parity-eviction): the cap of 5 INCLUDING the best-agree slot can
    # evict the 5th-highest-metric `sufficient` entry — a strong dissenting
    # view may be silently dropped by a weak agree-priority one. Mirrors
    # Clojure exactly for parity; flagged in PLAN.md
    # "Pending — needs team discussion".
    cap = 5 - (1 if best_agree_dict is not None else 0)
    capped = deduped[:cap]

    # agrees-before-disagrees (Clojure repness.clj:203-209). Stable partition.
    agrees = [c for c in capped if c['repful'] == 'agree']
    disagrees = [c for c in capped if c['repful'] == 'disagree']
    rep_df = pd.DataFrame(agrees + disagrees)

    return rep_df, best_agree_dict


def _assemble_rep_comments(stats_df: pd.DataFrame,
                           mod_out: Optional[Iterable[int]] = None,
                           preserve_order: bool = False
                           ) -> List[Dict[str, Any]]:
    """Thin wrapper around `select_rep_comments_df` that returns the flat
    output list (best-agree slot prepended, then the DataFrame's rows,
    then re-partitioned agrees-before-disagrees so a `repful='disagree'`
    best-agree slot lands in the disagrees section as in pre-S2).

    Decision S2: `select_rep_comments_df` returns a `(rep_df, best_agree_dict)`
    tuple so the DataFrame stays clean (no NaN extra-key columns). Most
    callers — including `conv_repness` and the D10 synthetic tests — want
    the flat List[Dict] form, so we keep one place that does the prepend
    and the final agrees-before-disagrees stable partition.
    """
    rep_df, best_agree_dict = select_rep_comments_df(
        stats_df, mod_out=mod_out, preserve_order=preserve_order)
    head: List[Dict[str, Any]] = [best_agree_dict] if best_agree_dict is not None else []
    tail: List[Dict[str, Any]] = (
        rep_df.to_dict('records') if not rep_df.empty else []
    )
    combined = head + tail
    # Re-run agrees-before-disagrees stable partition so the best-agree slot
    # ends up in the correct section per its own `repful`. This mirrors the
    # pre-S2 behaviour where best_agree was prepended into a single list and
    # then partitioned (Clojure repness.clj:203-209).
    agrees = [c for c in combined if c['repful'] == 'agree']
    disagrees = [c for c in combined if c['repful'] == 'disagree']
    return agrees + disagrees


# =============================================================================
# D11: Consensus comment selection (Clojure parity)
# =============================================================================
#
# Ports of Clojure's `consensus-stats` and `select-consensus-comments`
# (math/src/polismath/math/repness.clj:284-323).
#
# Conceptually different from rep-comment selection: consensus stats are
# computed over the FULL conversation (no group split — `add-comparitive-stats`
# is NOT called). Two independent top-5 lists are then built — one for "agree
# consensus" (pa > 0.5 AND z-sig-90 on pat) ordered by `pa * pat`, one for
# "disagree consensus" (pd > 0.5 AND z-sig-90 on pdt) ordered by `pd * pdt`.

def consensus_stats_df(vote_matrix_df: pd.DataFrame,
                       mod_out: Optional[Iterable[int]] = None
                       ) -> pd.DataFrame:
    """
    Compute per-comment consensus stats across the whole conversation.

    Vectorized port of Clojure `consensus-stats` (repness.clj:284-290). Unlike
    `compute_group_comment_stats_df`, no group split and no `ra/rd/rat/rdt`
    (Clojure's `add-comparitive-stats` is not called here).

    Args:
        vote_matrix_df: Wide-format vote matrix (participants × comments).
            Values in {AGREE, DISAGREE, PASS, NaN}.
        mod_out: Optional iterable of tids to exclude. Belt-and-braces with
            D15 column-zeroing: moderated-out columns auto-fail the `pa > 0.5`
            filter downstream (na=nd=0 → pa=pd=0.5), but the explicit filter
            matches Clojure's behaviour (repness.clj:296).

    Returns:
        DataFrame indexed by tid with columns [na, nd, ns, pa, pd, pat, pdt].
    """
    # Per-column counts. `vote_matrix_df` may have NaN for unvoted cells;
    # those count as neither agree nor disagree.
    na = (vote_matrix_df == AGREE).sum(axis=0).astype(int)
    nd = (vote_matrix_df == DISAGREE).sum(axis=0).astype(int)
    # ns counts all non-nil votes (incl. PASS) — Clojure parity, repness.clj:56-61.
    ns = vote_matrix_df.notna().sum(axis=0).astype(int)

    df = pd.DataFrame({'na': na, 'nd': nd, 'ns': ns})
    df.index.name = 'tid'

    # pa, pd with PSEUDO_COUNT smoothing.
    # Scalar equivalent: pa = (na + 1) / (ns + 2), pd = (nd + 1) / (ns + 2)
    df['pa'] = (df['na'] + PSEUDO_COUNT / 2) / (df['ns'] + PSEUDO_COUNT)
    df['pd'] = (df['nd'] + PSEUDO_COUNT / 2) / (df['ns'] + PSEUDO_COUNT)
    zero_mask = df['ns'] == 0
    df.loc[zero_mask, 'pa'] = 0.5
    df.loc[zero_mask, 'pd'] = 0.5

    # Proportion-test z-scores.
    df['pat'] = prop_test_vectorized(df['na'], df['ns'])
    df['pdt'] = prop_test_vectorized(df['nd'], df['ns'])

    # `is not None`, not truthiness: mod_out may be a numpy array / pandas
    # Index, whose bare truth value raises for len>1 (Copilot 2026-07-04).
    if mod_out is not None:
        mod_out_set = set(mod_out)
        df = df[~df.index.isin(mod_out_set)]

    return df


def select_consensus_comments_df(
    cons_stats: pd.DataFrame,
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Select consensus comments (Clojure parity).

    Port of Clojure `select-consensus-comments` (repness.clj:293-323). Returns
    two independent top-5 lists — one for agree consensus, one for disagree
    consensus.

    Filters and ordering:
      - Agree: `pa > 0.5 AND z-sig-90(pat)`, sorted desc by `am = pa * pat`.
      - Disagree: `pd > 0.5 AND z-sig-90(pdt)`, sorted desc by `dm = pd * pdt`.

    Since `ns` counts all non-nil votes including PASS (ns ≥ na+nd),
    `pa + pd = (na+nd+PSEUDO_COUNT)/(ns+PSEUDO_COUNT) ≤ 1`, so pa and pd
    cannot both exceed 0.5 — the same tid cannot appear in both lists. (The
    equality pa+pd=1 holds only for PASS-free comments.)

    Args:
        cons_stats: DataFrame indexed by tid with cols [na, nd, ns, pa, pd,
            pat, pdt], as produced by `consensus_stats_df`.

    Returns:
        Dict shape `{'agree': [entries], 'disagree': [entries]}`. Each entry
        is `{tid, n-success, n-trials, p-success, p-test}` — EXACTLY the
        Clojure blob shape (repness.clj:181 + the ::consensus s/keys spec).
        This narrows the S1 deferral (2026-07-04): consensus entries flow
        raw into `result['consensus']` in to_dict / to_dynamo_dict, where
        server-helpers.ts:298-313 and client-report's
        majorityStrict.jsx:23-27 pluck `tid` — Python-convention keys broke
        both. Rep-comment entries keep `comment_id` until the deferred
        math-blob alignment PR.
    """
    if cons_stats.empty:
        return {'agree': [], 'disagree': []}

    df = cons_stats.copy()
    df['am'] = df['pa'] * df['pat']
    df['dm'] = df['pd'] * df['pdt']

    agree_filter = (df['pa'] > 0.5) & (df['pat'] > Z_90)
    disagree_filter = (df['pd'] > 0.5) & (df['pdt'] > Z_90)

    agree_top = df[agree_filter].nlargest(5, 'am')
    disagree_top = df[disagree_filter].nlargest(5, 'dm')

    def _agree_entry(tid: Any, row: pd.Series) -> Dict[str, Any]:
        return {
            'tid': int(tid),
            'n-success': int(row['na']),
            'n-trials': int(row['ns']),
            'p-success': float(row['pa']),
            'p-test': float(row['pat']),
        }

    def _disagree_entry(tid: Any, row: pd.Series) -> Dict[str, Any]:
        return {
            'tid': int(tid),
            'n-success': int(row['nd']),
            'n-trials': int(row['ns']),
            'p-success': float(row['pd']),
            'p-test': float(row['pdt']),
        }

    return {
        'agree': [_agree_entry(tid, row) for tid, row in agree_top.iterrows()],
        'disagree': [_disagree_entry(tid, row) for tid, row in disagree_top.iterrows()],
    }


def conv_repness(vote_matrix_df: pd.DataFrame,
                 group_clusters: List[Dict[str, Any]],
                 mod_out: Optional[Iterable[int]] = None,
                 tid_order: Optional[List[Any]] = None,
                 ) -> Dict[str, Any]:
    """
    Calculate representativeness for all comments and groups.

    Uses a vectorized long-format DataFrame approach for efficiency.

    Args:
        vote_matrix_df: pd.DataFrame of matrix of votes (participants × comments)
            Values should be AGREE (1), DISAGREE (-1), PASS (0), or NaN (unvoted)
        group_clusters: List of group clusters, each with 'id' and 'members'
        mod_out: Optional iterable of tids to exclude (moderated-out comments).
            Forwarded to `select_rep_comments_df` and `consensus_stats_df`.
            See `Conversation.mod_out_tids`.
        tid_order: Optional comment order for tie-breaking (clojure-legacy:
            first-vote arrival order == Clojure's named-matrix column order).
            When given, stats rows and consensus stats follow it and the
            selectors iterate as-given instead of tid-ascending, so
            exact-score ties resolve like Clojure's stable sorts.

    Returns:
        Dictionary with representativeness data for each group:
            - comment_ids: list of comment IDs
            - group_repness: dict mapping group_id -> list of representative comments
            - consensus_comments: dict `{'agree': [...], 'disagree': [...]}` after
              D11 (was a flat list pre-D11; Clojure parity per repness.clj:322-323)
            - comment_repness: list of all comment repness data
    """
    # Create empty-result structure in case we need to return early
    empty_result = {
        'comment_ids': vote_matrix_df.columns.tolist(),
        'group_repness': {group['id']: [] for group in group_clusters},
        'consensus_comments': {'agree': [], 'disagree': []},
        'comment_repness': []
    }

    # Clojure computes repness/consensus for ANY matrix (its best-agree
    # guarantee produces an entry even for a single-vote 1x1 conversation;
    # rest-stats over zero other groups fall back to the (0+1)/(0+2) prior —
    # every-vote step-0 oracle, journal 2026-07-22), so no size guard here.
    # (The former improved-mode <2 guard is parked:
    # POST_CUTOVER_IMPROVEMENTS.md item 2.)

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
    stats_df = compute_group_comment_stats_df(votes_long, group_clusters,
                                              tid_order=tid_order)

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

    # Coerce gid back to int. `compute_group_comment_stats_df` builds group_id via
    # `.map(ptpt_to_group)`, which injects NaN for ungrouped voters and upcasts the
    # whole column to float64; the NaN rows are dropped but the dtype stays float.
    # Without this, every gid flows out of `.to_dict('records')` below as a
    # numpy.float64, which boto3 rejects when writing Delphi_RepresentativeComments
    # ("Float types are not supported. Use Decimal types instead."). gid is always
    # an integral group id (sourced from the full (group_id, comment) index), so the
    # cast is lossless.
    comment_repness['gid'] = comment_repness['gid'].astype(int)

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
            # `select_rep_comments_df` now returns `(rep_df, best_agree_dict)`
            # (decision S2) so the DataFrame stays clean. Use the
            # `_assemble_rep_comments` wrapper to get the flat List[Dict] the
            # math blob expects (best-agree prepended, agrees-before-disagrees
            # partition applied). Forward `mod_out` from conv_repness (D11
            # added this kwarg).
            result['group_repness'][group_id] = _assemble_rep_comments(
                group_stats, mod_out=mod_out,
                preserve_order=tid_order is not None)
        except Exception as e:
            print(f"Error selecting representative comments for group {group_id}: {e}")
            result['group_repness'][group_id] = []

    # Consensus comments (D11 / PR 9). Whole-conversation stats, not per-group.
    # Clojure runs this unconditionally (conversation.clj:706-709) — no
    # `len(group_clusters) > 1` guard.
    try:
        cons_stats = consensus_stats_df(vote_matrix_df, mod_out=mod_out)
        if tid_order is not None and not cons_stats.empty:
            # Rank ties resolve by row order (nlargest keep='first'): follow
            # Clojure's column (arrival) order, unknown tids at the tail.
            known = set(cons_stats.index)
            ordered = [t for t in tid_order if t in known]
            ordered_set = set(ordered)
            ordered += [t for t in cons_stats.index if t not in ordered_set]
            cons_stats = cons_stats.reindex(ordered)
        result['consensus_comments'] = select_consensus_comments_df(cons_stats)
    except Exception as e:
        print(f"Error selecting consensus comments: {e}")
        result['consensus_comments'] = {'agree': [], 'disagree': []}

    return result

