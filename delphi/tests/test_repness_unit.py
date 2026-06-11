"""
Tests for the representativeness module.
"""

import pytest
import numpy as np
import pandas as pd
import sys
import os

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.pca_kmeans_rep.repness import (
    PSEUDO_COUNT,
    z_score_sig_90, z_score_sig_95, conv_repness,
    # DataFrame-native vectorized functions
    prop_test_vectorized, two_prop_test_vectorized, compute_group_comment_stats_df,
)
from polismath.utils.general import AGREE, DISAGREE, PASS
from polismath.conversation.conversation import Conversation


class TestStatisticalFunctions:
    """Tests for the statistical utility functions."""
    
    def test_z_score_significance(self):
        """Test z-score significance checks."""
        # 90% confidence — one-tailed, strict >, matching Clojure
        assert z_score_sig_90(2.0)
        assert not z_score_sig_90(1.2816)   # boundary: not significant (strict >)
        assert not z_score_sig_90(-1.2816)  # negative: not significant (one-tailed)
        assert not z_score_sig_90(1.0)
        assert not z_score_sig_90(1.28)

        # 95% confidence — one-tailed, strict >, matching Clojure
        assert z_score_sig_95(2.5)
        assert not z_score_sig_95(1.6449)   # boundary: not significant (strict >)
        assert not z_score_sig_95(-1.6449)  # negative: not significant (one-tailed)
        assert not z_score_sig_95(1.5)
        assert not z_score_sig_95(1.64)
    

class TestIntegration:
    """Integration tests for the representativeness module."""
    
    def test_conv_repness(self):
        """Test the main representativeness calculation function."""
        # Create a test vote matrix
        vote_data = np.array([
            [1, 1, -1, None],  # Participant 1
            [1, 1, -1, 1],     # Participant 2
            [-1, -1, 1, -1],   # Participant 3
            [-1, -1, 1, 1]     # Participant 4
        ])
        
        row_names = ['p1', 'p2', 'p3', 'p4']
        col_names = ['c1', 'c2', 'c3', 'c4']
        
        vote_matrix = pd.DataFrame(vote_data, index=row_names, columns=col_names)
        
        # Create group clusters
        group_clusters = [
            {'id': 1, 'members': ['p1', 'p2']},  # Group 1: mostly agrees with c1, c2
            {'id': 2, 'members': ['p3', 'p4']}   # Group 2: mostly agrees with c3
        ]
        
        # Calculate representativeness
        repness_result = conv_repness(vote_matrix, group_clusters)
        
        # Check result structure
        assert 'comment_ids' in repness_result
        assert 'group_repness' in repness_result
        assert 'consensus_comments' in repness_result
        
        # Check group repness
        assert 1 in repness_result['group_repness']
        assert 2 in repness_result['group_repness']
        
        # Group 1 should identify c1/c2 as representative
        group1_rep_ids = [s['comment_id'] for s in repness_result['group_repness'][1]]
        assert 'c1' in group1_rep_ids or 'c2' in group1_rep_ids
        
        # Group 2 should identify c3 as representative
        group2_rep_ids = [s['comment_id'] for s in repness_result['group_repness'][2]]
        assert 'c3' in group2_rep_ids
    
    def test_participant_stats(self):
        """Test participant statistics calculation via vectorized method."""
        # Create a test vote matrix
        vote_data = np.array([
            [1, 1, -1, None],  # Participant 1
            [1, 1, -1, 1],     # Participant 2
            [-1, -1, 1, -1],   # Participant 3
            [-1, -1, 1, 1]     # Participant 4
        ])

        row_names = ['p1', 'p2', 'p3', 'p4']
        col_names = ['c1', 'c2', 'c3', 'c4']

        vote_matrix = pd.DataFrame(vote_data, index=row_names, columns=col_names)

        # Create group clusters. _compute_participant_info_optimized only
        # reads 'id' and 'members'; 'center' is unused but kept to mirror
        # the production cluster schema.
        group_clusters = [
            {'id': 1, 'members': ['p1', 'p2'], 'center': [0.0]},
            {'id': 2, 'members': ['p3', 'p4'], 'center': [0.0]}
        ]

        # Calculate participant stats using vectorized method
        conv = Conversation("test")
        ptpt_stats = conv._compute_participant_info_optimized(vote_matrix, group_clusters)

        # Check result structure
        assert 'participant_ids' in ptpt_stats
        assert 'stats' in ptpt_stats

        # Check participant stats
        for ptpt_id in row_names:
            assert ptpt_id in ptpt_stats['stats']
            stats = ptpt_stats['stats'][ptpt_id]

            assert 'n_agree' in stats
            assert 'n_disagree' in stats
            assert 'n_votes' in stats
            assert 'group' in stats
            assert 'group_correlations' in stats

        # Check specific stats
        p1_stats = ptpt_stats['stats']['p1']
        assert p1_stats['n_agree'] == 2
        assert p1_stats['n_disagree'] == 1
        assert p1_stats['group'] == 1


class TestVectorizedFunctions:
    """Tests for DataFrame-native vectorized functions."""

    @staticmethod
    def _prop_test_reference(succ, n):
        """Closed-form Clojure prop-test (stats.clj:10-15). +1 pseudocount, no n=0 guard."""
        return 2 * np.sqrt(n + 1) * ((succ + 1) / (n + 1) - 0.5)

    @staticmethod
    def _two_prop_test_reference(succ_in, succ_out, pop_in, pop_out):
        """Closed-form Clojure two-prop-test (stats.clj:18-33). +1 pseudocount on all 4."""
        s1, s2 = succ_in + 1, succ_out + 1
        p1, p2 = pop_in + 1, pop_out + 1
        pi1, pi2 = s1 / p1, s2 / p2
        pi_hat = (s1 + s2) / (p1 + p2)
        if pi_hat == 1.0:
            return 0.0
        se = np.sqrt(pi_hat * (1 - pi_hat) * (1/p1 + 1/p2))
        return (pi1 - pi2) / se

    def test_prop_test_vectorized(self):
        """Test vectorized one-proportion z-test (Clojure formula)."""
        succ = pd.Series([70, 10, 50])
        n = pd.Series([100, 50, 100])

        result = prop_test_vectorized(succ, n)

        # Compare with closed-form reference
        for i, (s, m) in enumerate(zip(succ, n)):
            assert np.isclose(result.iloc[i], self._prop_test_reference(s, m), atol=0.01)

    def test_prop_test_vectorized_edge_cases(self):
        """Vectorized prop test n=0 → 1.0 (Clojure parity, no short-circuit).

        (0, 0) → (1, 1) after +1 → 2*sqrt(1)*(1/1 - 0.5) = 1.0.
        """
        succ = pd.Series([0, 70])
        n = pd.Series([0, 100])

        result = prop_test_vectorized(succ, n)

        assert np.isclose(result.iloc[0], 1.0, atol=1e-10)
        assert not np.isnan(result.iloc[1])  # normal case

    def test_two_prop_test_vectorized(self):
        """Test vectorized two-proportion z-test with +1 pseudocounts."""
        # Now takes raw counts: (succ_in, succ_out, pop_in, pop_out)
        succ_in = pd.Series([70, 10])
        succ_out = pd.Series([50, 15])
        pop_in = pd.Series([100, 50])
        pop_out = pd.Series([100, 50])

        result = two_prop_test_vectorized(succ_in, succ_out, pop_in, pop_out)

        # Compare with closed-form reference
        for i, (sin, sout, pin, pout) in enumerate(zip(succ_in, succ_out, pop_in, pop_out)):
            assert np.isclose(result.iloc[i],
                              self._two_prop_test_reference(sin, sout, pin, pout),
                              atol=0.01)

    def test_two_prop_test_vectorized_edge_cases(self):
        """Vectorized two-prop test: pop=0 must match Clojure parity (no short-circuit).

        Clojure (stats.clj:18-33) applies (map inc ...) to all four inputs, so
        pop=0 → pop=1 and the test proceeds. Hand-verified reference values pin
        the behavior on the two relevant boundaries.
        """
        # Row 0: (5, 5, 0, 100) — pop_in=0 → expect large positive z (≈18.35)
        # Row 1: (5, 5, 0, 10)  — pop_in=0 AND pi_hat=1 by coincidence → 0
        succ_in  = pd.Series([5, 5])
        succ_out = pd.Series([5, 5])
        pop_in   = pd.Series([0, 0])
        pop_out  = pd.Series([100, 10])

        result = two_prop_test_vectorized(succ_in, succ_out, pop_in, pop_out)

        # Row 0: closed-form via the reference helper.
        assert np.isclose(result.iloc[0],
                          self._two_prop_test_reference(5, 5, 0, 100), atol=0.01)
        assert np.isclose(result.iloc[0], 18.3476, atol=0.01)
        # Row 1: pi_hat=1 coincidence after +1 → 0.0 (closed-form returns 0).
        assert result.iloc[1] == 0.0

    def test_compute_group_comment_stats_df(self):
        """Test vectorized computation of group/comment statistics."""
        # Create test data in long format
        votes_long = pd.DataFrame({
            'participant': ['p1', 'p1', 'p2', 'p2', 'p3', 'p3', 'p4', 'p4'],
            'comment': ['c1', 'c2', 'c1', 'c2', 'c1', 'c2', 'c1', 'c2'],
            'vote': [1, 1, 1, 1, -1, -1, -1, -1]  # AGREE=1, DISAGREE=-1
        })

        group_clusters = [
            {'id': 1, 'members': ['p1', 'p2']},  # Group 1: agrees with c1, c2
            {'id': 2, 'members': ['p3', 'p4']}   # Group 2: disagrees with c1, c2
        ]

        stats_df = compute_group_comment_stats_df(votes_long, group_clusters)

        # Check that we have stats for all group/comment combinations
        assert len(stats_df) == 4  # 2 groups x 2 comments

        # Check group 1, comment c1 stats
        g1_c1 = stats_df.loc[(1, 'c1')]
        assert g1_c1['na'] == 2  # 2 agrees
        assert g1_c1['nd'] == 0  # 0 disagrees
        assert g1_c1['ns'] == 2  # 2 total votes

        # Check group 2, comment c1 stats
        g2_c1 = stats_df.loc[(2, 'c1')]
        assert g2_c1['na'] == 0  # 0 agrees
        assert g2_c1['nd'] == 2  # 2 disagrees
        assert g2_c1['ns'] == 2  # 2 total votes

        # Check that probabilities are computed
        assert 'pa' in stats_df.columns
        assert 'pd' in stats_df.columns
        assert 'pat' in stats_df.columns
        assert 'pdt' in stats_df.columns

        # Check that comparative stats are computed
        assert 'ra' in stats_df.columns
        assert 'rd' in stats_df.columns
        assert 'rat' in stats_df.columns
        assert 'rdt' in stats_df.columns

        # Check that metrics are computed
        assert 'agree_metric' in stats_df.columns
        assert 'disagree_metric' in stats_df.columns
        assert 'repful' in stats_df.columns

    def test_compute_group_comment_stats_df_with_nan_votes(self):
        """Test that NaN votes are properly excluded."""
        # Create test data with some NaN votes
        votes_long = pd.DataFrame({
            'participant': ['p1', 'p1', 'p2', 'p2', 'p3', 'p3'],
            'comment': ['c1', 'c2', 'c1', 'c2', 'c1', 'c2'],
            'vote': [1, np.nan, 1, 1, -1, -1]  # p1 didn't vote on c2
        })

        group_clusters = [
            {'id': 1, 'members': ['p1', 'p2']},
            {'id': 2, 'members': ['p3']}
        ]

        stats_df = compute_group_comment_stats_df(votes_long, group_clusters)

        # Group 1, c2 should have only 1 vote (from p2, since p1's NaN is dropped)
        g1_c2 = stats_df.loc[(1, 'c2')]
        assert g1_c2['ns'] == 1  # Only p2's vote counted

    def test_compute_group_comment_stats_df_empty(self):
        """Test handling of empty input."""
        votes_long = pd.DataFrame(columns=['participant', 'comment', 'vote'])
        group_clusters = [{'id': 1, 'members': ['p1']}]

        stats_df = compute_group_comment_stats_df(votes_long, group_clusters)

        assert stats_df.empty

    def test_compute_group_comment_stats_consistency_with_conv_repness(self):
        """Sanity: per-(gid, tid) pa/pd from compute_group_comment_stats_df match
        the values surfaced in conv_repness's comment_repness output."""
        # Create test data
        vote_data = np.array([
            [1, 1, -1],   # p1
            [1, -1, 1],   # p2
            [-1, 1, -1],  # p3
            [-1, -1, 1]   # p4
        ], dtype=float)

        row_names = ['p1', 'p2', 'p3', 'p4']
        col_names = ['c1', 'c2', 'c3']
        vote_matrix = pd.DataFrame(vote_data, index=row_names, columns=col_names)

        group_clusters = [
            {'id': 1, 'members': ['p1', 'p2']},
            {'id': 2, 'members': ['p3', 'p4']}
        ]

        # Get vectorized results
        votes_long = vote_matrix.melt(
            ignore_index=False,
            var_name='comment',
            value_name='vote'
        ).reset_index(names='participant')
        stats_df = compute_group_comment_stats_df(votes_long, group_clusters)

        # Compare with scalar results from conv_repness
        repness_result = conv_repness(vote_matrix, group_clusters)

        # Check that we have the same number of comment_repness entries
        assert len(repness_result['comment_repness']) == len(stats_df)

        # Check a few specific values
        for entry in repness_result['comment_repness']:
            gid = entry['gid']
            tid = entry['tid']
            df_row = stats_df.loc[(gid, tid)]

            assert np.isclose(entry['pa'], df_row['pa'], atol=1e-10)
            assert np.isclose(entry['pd'], df_row['pd'], atol=1e-10)


class TestNsIncludesPassVotes:
    """ns / total_votes must count agree + disagree + PASS (Clojure parity).

    Clojure (math/src/polismath/math/repness.clj:56-61, :70):
        (defn- count-votes [votes & [vote]]
          (let [filt-fn (if vote #(= vote %) identity)]
            (count (filter filt-fn votes))))
        ...
        :ns (fnk [votes] (count-votes votes))

    `count-votes` is called with no `vote` arg → `filt-fn = identity`. In
    Clojure, 0 is truthy, so `(filter identity ...)` keeps every non-nil
    entry — including PASS (0). Therefore ns = na + nd + np (PASS count).

    Python had ns = na + nd, silently dropping PASS. Every downstream metric
    (pa, pd, pat, pdt, ra, rd, rat, rdt, agree_metric, disagree_metric,
    consensus stats) was off whenever PASS votes existed. D5 BlobInjection
    tests bypassed `compute_group_comment_stats_df` entirely (they feed a
    pre-baked stats blob), so the bug was invisible there — pure-formula
    tests are the only way to RED it.
    """

    def test_ns_includes_pass_votes(self):
        """ns counts AGREE + DISAGREE + PASS, not just AGREE + DISAGREE."""
        # 5 ptpts, 1 comment, mixed votes: 2 agree, 1 disagree, 2 pass.
        # Clojure ns = count of all non-nil = 5.
        # Buggy Python ns = na + nd = 3.
        votes_long = pd.DataFrame({
            'participant': ['p1', 'p2', 'p3', 'p4', 'p5'],
            'comment': ['c1'] * 5,
            'vote': [AGREE, AGREE, DISAGREE, PASS, PASS],
        })
        group_clusters = [{'id': 0, 'members': ['p1', 'p2', 'p3', 'p4', 'p5']}]

        stats_df = compute_group_comment_stats_df(votes_long, group_clusters)
        row = stats_df.loc[(0, 'c1')]

        assert row['na'] == 2
        assert row['nd'] == 1
        assert row['ns'] == 5, (
            f"ns should include PASS (Clojure parity); got {row['ns']}"
        )

    def test_ns_all_pass_column(self):
        """All-PASS column: na=0, nd=0, ns=3 (not 0)."""
        votes_long = pd.DataFrame({
            'participant': ['p1', 'p2', 'p3'],
            'comment': ['c1'] * 3,
            'vote': [PASS, PASS, PASS],
        })
        group_clusters = [{'id': 0, 'members': ['p1', 'p2', 'p3']}]

        stats_df = compute_group_comment_stats_df(votes_long, group_clusters)
        row = stats_df.loc[(0, 'c1')]

        assert row['na'] == 0
        assert row['nd'] == 0
        assert row['ns'] == 3, (
            f"All-PASS column should still have ns=3 (Clojure parity); "
            f"got {row['ns']}"
        )

    def test_ns_mixed_with_nan_only_explicit_votes_count(self):
        """NaN (unvoted) must NOT count; only explicit AGREE/DISAGREE/PASS do."""
        # 6 ptpts on c1: 1 agree, 1 disagree, 2 pass, 2 unvoted (NaN).
        # Clojure parity: ns = 4 (the 4 explicit votes). NaN never counts.
        votes_long = pd.DataFrame({
            'participant': ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
            'comment': ['c1'] * 6,
            'vote': [AGREE, DISAGREE, PASS, PASS, np.nan, np.nan],
        })
        group_clusters = [{'id': 0, 'members': ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']}]

        stats_df = compute_group_comment_stats_df(votes_long, group_clusters)
        row = stats_df.loc[(0, 'c1')]

        assert row['na'] == 1
        assert row['nd'] == 1
        assert row['ns'] == 4, (
            f"ns must include PASS but exclude NaN; got {row['ns']}"
        )

    def test_other_votes_includes_other_group_pass(self):
        """`other_votes` = total_votes - ns must include PASS in BOTH halves.

        Two groups, one comment. Group 0 votes [AGREE, PASS], group 1 votes
        [DISAGREE, PASS]. Total na=1, nd=1, total_votes (Clojure) = 4.
        Group 0: na=1, nd=0, ns=2 → other_votes=2 (the group-1 disagree + pass).
        Group 1: na=0, nd=1, ns=2 → other_votes=2 (the group-0 agree + pass).
        """
        votes_long = pd.DataFrame({
            'participant': ['p1', 'p2', 'p3', 'p4'],
            'comment': ['c1'] * 4,
            'vote': [AGREE, PASS, DISAGREE, PASS],
        })
        group_clusters = [
            {'id': 0, 'members': ['p1', 'p2']},
            {'id': 1, 'members': ['p3', 'p4']},
        ]

        stats_df = compute_group_comment_stats_df(votes_long, group_clusters)

        g0 = stats_df.loc[(0, 'c1')]
        assert g0['na'] == 1
        assert g0['nd'] == 0
        assert g0['ns'] == 2, f"group 0 ns should include its PASS; got {g0['ns']}"
        assert g0['other_votes'] == 2, (
            f"group 0 other_votes should include group-1 PASS; "
            f"got {g0['other_votes']}"
        )

        g1 = stats_df.loc[(1, 'c1')]
        assert g1['na'] == 0
        assert g1['nd'] == 1
        assert g1['ns'] == 2, f"group 1 ns should include its PASS; got {g1['ns']}"
        assert g1['other_votes'] == 2, (
            f"group 1 other_votes should include group-0 PASS; "
            f"got {g1['other_votes']}"
        )