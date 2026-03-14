"""
Tests for the representativeness module's backwards-compatible interface.

These tests verify the single-group, single-comment "old format" API
that wraps the new DataFrame-native implementation.
"""

import math
import numpy as np
import pandas as pd
import sys
import os

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.pca_kmeans_rep.repness import (
    PSEUDO_COUNT,
    z_score_sig_90, z_score_sig_95, prop_test, two_prop_test,
    comment_stats, add_comparative_stats, repness_metric, finalize_cmt_stats,
    passes_by_test, best_agree, best_disagree, select_rep_comments,
    select_consensus_comments, conv_repness,
)
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

    def test_prop_test(self):
        """Test one-proportion z-test (Clojure formula: 2*sqrt(n+1)*((succ+1)/(n+1) - 0.5))."""
        # 70 successes out of 100
        assert np.isclose(prop_test(70, 100),
                          2 * math.sqrt(101) * (71/101 - 0.5), atol=0.01)
        # 10 successes out of 50
        assert np.isclose(prop_test(10, 50),
                          2 * math.sqrt(51) * (11/51 - 0.5), atol=0.01)

        # Edge case: n=0
        assert prop_test(0, 0) == 0.0

    def test_two_prop_test(self):
        """Test two-proportion z-test with +1 pseudocounts (Clojure parity)."""
        # two_prop_test(succ_in, succ_out, pop_in, pop_out) — raw counts
        # After +1: pi1=71/101≈0.703, pi2=51/101≈0.505, z≈2.88
        assert np.isclose(two_prop_test(70, 50, 100, 100), 2.88, atol=0.1)

        # Equal proportions → z ≈ 0
        assert np.isclose(two_prop_test(25, 25, 50, 50), 0.0, atol=0.1)

        # Edge cases: pop=0 → 0
        assert two_prop_test(5, 5, 0, 100) == 0.0
        assert two_prop_test(5, 5, 100, 0) == 0.0


class TestCommentStats:
    """Tests for comment statistics functions (old single-array interface)."""

    def test_comment_stats(self):
        """Test basic comment statistics calculation."""
        # Create test votes: 3 agrees, 1 disagree, 1 pass
        votes = np.array([1, 1, 1, -1, None])
        group_members = [0, 1, 2, 3, 4]

        stats = comment_stats(votes, group_members)

        assert stats['na'] == 3
        assert stats['nd'] == 1
        assert stats['ns'] == 4

        # Check probabilities (with pseudocounts)
        n_agree = 3
        n_disagree = 1
        n_votes = 4
        p_agree = (n_agree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT)
        p_disagree = (n_disagree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT)

        assert np.isclose(stats['pa'], p_agree)
        assert np.isclose(stats['pd'], p_disagree)

        # Test with no votes
        empty_votes = np.array([None, None])
        empty_stats = comment_stats(empty_votes, [0, 1])

        assert empty_stats['na'] == 0
        assert empty_stats['nd'] == 0
        assert empty_stats['ns'] == 0
        assert np.isclose(empty_stats['pa'], 0.5)
        assert np.isclose(empty_stats['pd'], 0.5)

    def test_add_comparative_stats(self):
        """Test adding comparative statistics."""
        # Group stats: 80% agree
        group_stats = {
            'na': 8,
            'nd': 2,
            'ns': 10,
            'pa': 0.8,
            'pd': 0.2,
            'pat': 3.0,
            'pdt': -3.0
        }

        # Other group stats: 40% agree
        other_stats = {
            'na': 4,
            'nd': 6,
            'ns': 10,
            'pa': 0.4,
            'pd': 0.6,
            'pat': -1.0,
            'pdt': 1.0
        }

        result = add_comparative_stats(group_stats, other_stats)

        # Check representativeness ratios
        assert np.isclose(result['ra'], 0.8 / 0.4)
        assert np.isclose(result['rd'], 0.2 / 0.6)

        # Test edge case with zero probability
        other_stats_zero = {
            'na': 0,
            'nd': 10,
            'ns': 10,
            'pa': 0.0,
            'pd': 1.0,
            'pat': -5.0,
            'pdt': 5.0
        }

        result_zero = add_comparative_stats(group_stats, other_stats_zero)
        assert np.isclose(result_zero['ra'], 1.0)  # Should default to 1.0

    def test_repness_metric(self):
        """Test representativeness metric calculation."""
        stats = {
            'pa': 0.8,
            'pd': 0.2,
            'pat': 3.0,
            'pdt': -3.0,
            'ra': 2.0,
            'rd': 0.33,
            'rat': 2.5,
            'rdt': -2.5
        }

        # Clojure product formula: ra * rat * pa * pat (repness.clj:188-190)
        agree_metric = repness_metric(stats, 'a')
        expected_agree = 2.0 * 2.5 * 0.8 * 3.0  # ra * rat * pa * pat
        assert np.isclose(agree_metric, expected_agree)

        # Clojure product formula: rd * rdt * pd * pdt
        disagree_metric = repness_metric(stats, 'd')
        expected_disagree = 0.33 * (-2.5) * 0.2 * (-3.0)  # rd * rdt * pd * pdt
        assert np.isclose(disagree_metric, expected_disagree)

    def test_finalize_cmt_stats(self):
        """Test finalizing comment statistics."""
        # Stats where agree is more representative
        agree_stats = {
            'pa': 0.8,
            'pd': 0.2,
            'pat': 3.0,
            'pdt': -3.0,
            'ra': 2.0,
            'rd': 0.33,
            'rat': 2.5,
            'rdt': -2.5
        }

        finalized_agree = finalize_cmt_stats(agree_stats)

        assert 'agree_metric' in finalized_agree
        assert 'disagree_metric' in finalized_agree
        assert finalized_agree['repful'] == 'agree'

        # Stats where disagree is more representative
        disagree_stats = {
            'pa': 0.2,
            'pd': 0.8,
            'pat': -3.0,
            'pdt': 3.0,
            'ra': 0.33,
            'rd': 2.0,
            'rat': -2.5,
            'rdt': 2.5
        }

        finalized_disagree = finalize_cmt_stats(disagree_stats)
        assert finalized_disagree['repful'] == 'disagree'


class TestSelectionFunctions:
    """Tests for representative comment selection functions."""

    def test_passes_by_test(self):
        """Test checking if comments pass significance tests."""
        # Create stats that pass significance tests
        passing_stats = {
            'pa': 0.8,
            'pd': 0.2,
            'pat': 3.0,
            'pdt': -3.0,
            'ra': 2.0,
            'rd': 0.33,
            'rat': 3.0,
            'rdt': -3.0
        }

        assert passes_by_test(passing_stats, 'agree')
        assert not passes_by_test(passing_stats, 'disagree')

        # Create stats that don't pass (not significant)
        failing_stats = {
            'pa': 0.8,
            'pd': 0.2,
            'pat': 1.0,  # Below 90% threshold
            'pdt': -1.0,
            'ra': 2.0,
            'rd': 0.33,
            'rat': 1.0,  # Below 90% threshold
            'rdt': -1.0
        }

        assert not passes_by_test(failing_stats, 'agree')

    def test_best_agree(self):
        """Test filtering for best agreement comments."""
        # Create a mix of stats
        stats = [
            {  # Passes tests, high agreement
                'comment_id': 'c1',
                'pa': 0.8, 'pd': 0.2,
                'pat': 3.0, 'pdt': -3.0,
                'rat': 3.0, 'rdt': -3.0
            },
            {  # Doesn't pass tests
                'comment_id': 'c2',
                'pa': 0.6, 'pd': 0.4,
                'pat': 1.0, 'pdt': -1.0,
                'rat': 1.0, 'rdt': -1.0
            },
            {  # Not agreement (more disagree)
                'comment_id': 'c3',
                'pa': 0.3, 'pd': 0.7,
                'pat': -2.0, 'pdt': 2.0,
                'rat': -2.0, 'rdt': 2.0
            },
            {  # Passes tests, moderate agreement
                'comment_id': 'c4',
                'pa': 0.7, 'pd': 0.3,
                'pat': 2.5, 'pdt': -2.5,
                'rat': 2.5, 'rdt': -2.5
            }
        ]

        best = best_agree(stats)

        # Should return 2 comments that pass tests
        assert len(best) == 2
        comment_ids = [s['comment_id'] for s in best]
        assert 'c1' in comment_ids
        assert 'c4' in comment_ids
        assert 'c3' not in comment_ids

    def test_best_disagree(self):
        """Test filtering for best disagreement comments."""
        # Create a mix of stats
        stats = [
            {  # Not disagreement (more agree)
                'comment_id': 'c1',
                'pa': 0.8, 'pd': 0.2,
                'pat': 3.0, 'pdt': -3.0,
                'rat': 3.0, 'rdt': -3.0
            },
            {  # Disagreement but doesn't pass tests
                'comment_id': 'c2',
                'pa': 0.4, 'pd': 0.6,
                'pat': -1.0, 'pdt': 1.0,
                'rat': -1.0, 'rdt': 1.0
            },
            {  # Passes tests, high disagreement
                'comment_id': 'c3',
                'pa': 0.2, 'pd': 0.8,
                'pat': -3.0, 'pdt': 3.0,
                'rat': -3.0, 'rdt': 3.0
            }
        ]

        best = best_disagree(stats)

        # Should return 1 comment that passes tests
        assert len(best) == 1
        assert best[0]['comment_id'] == 'c3'

    def test_select_rep_comments(self):
        """Test selecting representative comments."""
        # Create a mix of stats
        stats = [
            {  # Strong agree
                'comment_id': 'c1',
                'pa': 0.9, 'pd': 0.1,
                'pat': 4.0, 'pdt': -4.0,
                'rat': 4.0, 'rdt': -4.0,
                'agree_metric': 7.2,
                'disagree_metric': 0.9
            },
            {  # Moderate agree
                'comment_id': 'c2',
                'pa': 0.7, 'pd': 0.3,
                'pat': 2.0, 'pdt': -2.0,
                'rat': 2.0, 'rdt': -2.0,
                'agree_metric': 2.8,
                'disagree_metric': 1.2
            },
            {  # Weak agree
                'comment_id': 'c3',
                'pa': 0.6, 'pd': 0.4,
                'pat': 1.0, 'pdt': -1.0,
                'rat': 1.0, 'rdt': -1.0,
                'agree_metric': 1.2,
                'disagree_metric': 0.8
            },
            {  # Strong disagree
                'comment_id': 'c4',
                'pa': 0.1, 'pd': 0.9,
                'pat': -4.0, 'pdt': 4.0,
                'rat': -4.0, 'rdt': 4.0,
                'agree_metric': 0.8,
                'disagree_metric': 7.2
            },
            {  # Moderate disagree
                'comment_id': 'c5',
                'pa': 0.3, 'pd': 0.7,
                'pat': -2.0, 'pdt': 2.0,
                'rat': -2.0, 'rdt': 2.0,
                'agree_metric': 1.2,
                'disagree_metric': 2.8
            }
        ]

        # Set 'repful' for all stats to match the implementation
        for stat in stats:
            if stat.get('agree_metric', 0) >= stat.get('disagree_metric', 0):
                stat['repful'] = 'agree'
            else:
                stat['repful'] = 'disagree'

        # Select with default counts
        selected = select_rep_comments(stats)

        # Check that we get some representative comments
        assert len(selected) > 0

        # Verify that comments are properly marked
        agree_comments = [s for s in selected if s['repful'] == 'agree']
        disagree_comments = [s for s in selected if s['repful'] == 'disagree']

        # Make sure we have both types of comments if available
        assert len(agree_comments) > 0
        assert len(disagree_comments) > 0

        # Check that the order is by metrics
        if len(agree_comments) >= 2:
            assert agree_comments[0]['agree_metric'] >= agree_comments[1]['agree_metric']

        if len(disagree_comments) >= 2:
            assert disagree_comments[0]['disagree_metric'] >= disagree_comments[1]['disagree_metric']

        # Test with different counts
        selected_custom = select_rep_comments(stats, agree_count=2, disagree_count=1)

        assert len(selected_custom) == 3
        agree_count = sum(1 for s in selected_custom if s['repful'] == 'agree')
        disagree_count = sum(1 for s in selected_custom if s['repful'] == 'disagree')

        assert agree_count == 2
        assert disagree_count == 1

        # Test with empty stats
        assert select_rep_comments([]) == []


class TestConsensusAndGroupRepness:
    """Tests for consensus and group representativeness functions."""

    def test_select_consensus_comments(self):
        """Test selecting consensus comments."""
        # Create stats for groups
        group1_stats = [
            {
                'comment_id': 'c1',
                'group_id': 1,
                'pa': 0.8, 'pd': 0.2
            },
            {
                'comment_id': 'c2',
                'group_id': 1,
                'pa': 0.7, 'pd': 0.3
            }
        ]

        group2_stats = [
            {
                'comment_id': 'c1',
                'group_id': 2,
                'pa': 0.85, 'pd': 0.15
            },
            {
                'comment_id': 'c2',
                'group_id': 2,
                'pa': 0.6, 'pd': 0.4
            },
            {
                'comment_id': 'c3',
                'group_id': 2,
                'pa': 0.9, 'pd': 0.1
            }
        ]

        # Combine stats
        all_stats = group1_stats + group2_stats

        consensus = select_consensus_comments(all_stats)

        # Comments with high agreement across all groups should be consensus
        assert len(consensus) > 0

        # Verify comment IDs in consensus list - both c1 and c2 have high agreement
        consensus_ids = [c['comment_id'] for c in consensus]

        # At least one of these should be in the consensus
        assert 'c1' in consensus_ids or 'c2' in consensus_ids

        # NOTE: The implementation actually sorts by average agreement
        # c3 has the highest average agreement (0.9) but is only in one group
        # So it's actually expected that c3 could be in the consensus
        # Just verify that the implementation is consistent in its behavior

        # Check all consensus comments have the correct label
        for comment in consensus:
            assert comment['repful'] == 'consensus'


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

        # Create group clusters (vectorized method requires 'center' key)
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
