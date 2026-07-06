"""Tests for polismath.replay.weights — prefix statistics and era A/B priority formulas.

Era A formula (pre-2025-03-20 production, conversation.clj priority-metric):
    w = [ (1 - p_hat) * (E + 1) * a_hat * (1 + 8 * 2^(-S/5)) ]^2
    p_hat = (P + 1) / (S + 2),  a_hat = (A + 1) / (S + 2),  S = A + D + P
Meta comments: w = 7^2 = 49 exactly.
Era B (post-2025-03-20, truthy-0 regression): every tid in the priorities
domain gets 49; tids outside default to 1.0 at the caller.
"""

import pytest

from polismath.replay.types import ReplayDataset, Vote, VoteEvent
from polismath.replay.weights import (
    DEFAULT_WEIGHT,
    META_WEIGHT,
    PrefixStats,
    era_a_weights,
    era_b_weights,
    prefix_stats_at_slots,
)


def _ve(k, pid, tid, sign, t_ms=None):
    return VoteEvent(
        k=k, t_ms=t_ms if t_ms is not None else k * 1000, pid=pid, tid=tid,
        sign=sign, is_revote=False,
    )


def era_a_expected(A, D, P, E=0.0):
    """Longhand reference implementation of the era-A formula."""
    S = A + D + P
    p_hat = (P + 1) / (S + 2)
    a_hat = (A + 1) / (S + 2)
    imp = (1 - p_hat) * (E + 1) * a_hat
    boost = 1 + 8 * 2 ** (-S / 5)
    return (imp * boost) ** 2


class TestPrefixStats:
    def test_push_counts_by_sign(self):
        st = PrefixStats.empty()
        st.push(_ve(1, 1, 7, Vote.AGREE))
        st.push(_ve(2, 2, 7, Vote.DISAGREE))
        st.push(_ve(3, 3, 7, Vote.PASS))
        st.push(_ve(4, 1, 8, Vote.AGREE))
        assert (st.A[7], st.D[7], st.P[7]) == (1, 1, 1)
        assert st.A[8] == 1
        assert st.dom == {7, 8}

    def test_revote_flips_latest_wins(self):
        st = PrefixStats.empty()
        st.push(_ve(1, 1, 7, Vote.AGREE))
        st.push(VoteEvent(k=2, t_ms=2000, pid=1, tid=7, sign=Vote.DISAGREE, is_revote=True))
        assert (st.A[7], st.D[7]) == (0, 1)
        assert st.S(7) == 1  # revote does not inflate seen count
        assert st.dom == {7}

    def test_snapshot_is_independent(self):
        st = PrefixStats.empty()
        st.push(_ve(1, 1, 7, Vote.AGREE))
        snap = st.snapshot()
        st.push(_ve(2, 2, 7, Vote.AGREE))
        assert snap.A[7] == 1
        assert st.A[7] == 2


class TestEraB:
    def test_dom_gets_49_and_absent_is_excluded(self):
        st = PrefixStats.empty()
        st.push(_ve(1, 1, 7, Vote.AGREE))
        w = era_b_weights(st)
        assert w == {7: META_WEIGHT}
        assert META_WEIGHT == 49.0
        assert DEFAULT_WEIGHT == 1.0


class TestEraA:
    def test_single_agree_zero_extremity(self):
        st = PrefixStats.empty()
        st.push(_ve(1, 1, 7, Vote.AGREE))
        w = era_a_weights(st, extremity={}, meta_tids=set())
        assert w[7] == pytest.approx(era_a_expected(1, 0, 0, 0.0), rel=1e-12)
        # numeric literal guard against silent formula drift
        assert w[7] == pytest.approx(12.5297263, rel=1e-6)

    def test_extremity_scales_by_e_plus_one_squared(self):
        st = PrefixStats.empty()
        st.push(_ve(1, 1, 7, Vote.AGREE))
        base = era_a_weights(st, extremity={}, meta_tids=set())[7]
        w = era_a_weights(st, extremity={7: 2.5}, meta_tids=set())[7]
        assert w == pytest.approx(base * 3.5**2, rel=1e-12)

    def test_meta_is_exactly_49_regardless_of_stats(self):
        st = PrefixStats.empty()
        for k in range(1, 11):
            st.push(_ve(k, k, 7, Vote.DISAGREE))
        w = era_a_weights(st, extremity={7: 3.0}, meta_tids={7})
        assert w[7] == 49.0

    def test_pass_heavy_comment_downweighted(self):
        st_pass = PrefixStats.empty()
        st_agree = PrefixStats.empty()
        for k in range(1, 5):
            st_pass.push(_ve(k, k, 7, Vote.PASS))
            st_agree.push(_ve(k, k, 7, Vote.AGREE))
        w_pass = era_a_weights(st_pass, extremity={}, meta_tids=set())[7]
        w_agree = era_a_weights(st_agree, extremity={}, meta_tids=set())[7]
        assert w_pass < w_agree
        assert w_pass == pytest.approx(era_a_expected(0, 0, 4), rel=1e-12)

    def test_fresh_bubble_boost_decays_with_s(self):
        # same A-fraction, more votes -> lower boost factor
        st_small = PrefixStats.empty()
        st_small.push(_ve(1, 1, 7, Vote.AGREE))
        st_big = PrefixStats.empty()
        for k in range(1, 21):
            st_big.push(_ve(k, k, 7, Vote.AGREE))
        w_small = era_a_weights(st_small, extremity={}, meta_tids=set())[7]
        w_big = era_a_weights(st_big, extremity={}, meta_tids=set())[7]
        assert w_big == pytest.approx(era_a_expected(20, 0, 0), rel=1e-12)
        # boost shrinks from ~7.96 toward 1; a_hat grows; net effect here: check both raw values
        assert w_small == pytest.approx(12.5297263, rel=1e-6)


class TestPrefixStatsAtSlots:
    def test_snapshots_at_requested_slots(self):
        ds = ReplayDataset.build(
            [(1000, 1, 7, 1), (2000, 2, 7, 1), (3000, 3, 8, -1), (4000, 4, 8, 0)]
        )
        stats = prefix_stats_at_slots(ds.votes, [2, 4])
        assert set(stats) == {2, 4}
        assert stats[2].A[7] == 2
        assert 8 not in stats[2].dom
        assert stats[4].D[8] == 1 and stats[4].P[8] == 1

    def test_empty_slots_list(self):
        ds = ReplayDataset.build([(1000, 1, 7, 1)])
        assert prefix_stats_at_slots(ds.votes, []) == {}
