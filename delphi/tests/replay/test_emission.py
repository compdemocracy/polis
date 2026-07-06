"""Tests for polismath.replay.emission — Plackett-Luce mark likelihood.

Per-vote term (non-revotes only), under a fixed weight map w with default 1:

    log[ (1-eps) * w(c_k) / sum_{c in S_k} w(c)  +  eps / |S_k| ]

with S_k = {c : created <= t_k, mod-gate OK at t_k, not yet voted by pid_k}.
The voted comment itself is always retained in S_k (guard, warns on
inconsistency). All expected values below are hand-computed.
"""

import math

import numpy as np
import pytest

from polismath.replay.emission import AvailabilityIndex, cumulative_loglik, segment_loglik
from polismath.replay.types import CommentMeta, ModEvent, ReplayDataset


def _cm(*tids, created_ms=0):
    return {t: CommentMeta(tid=t, created_ms=created_ms) for t in tids}


class TestUniformWeights:
    def _ds(self):
        # two comments, both created at t=0
        return ReplayDataset.build(
            [(1000, 1, 7, 1), (2000, 1, 8, 1), (3000, 2, 8, 1)],
            comments=_cm(7, 8),
        )

    def test_cumulative_terms(self):
        idx = AvailabilityIndex(self._ds())
        cum = cumulative_loglik(idx, weights={}, eps=0.0)
        # k=1: p1 chooses among {7,8} -> log(1/2)
        # k=2: p1 has voted 7, chooses among {8} -> log(1) = 0
        # k=3: p2 chooses among {7,8} -> log(1/2)
        expected = [0.0, math.log(0.5), math.log(0.5), math.log(0.25)]
        np.testing.assert_allclose(cum, expected, rtol=1e-12)

    def test_segment_is_cum_difference(self):
        idx = AvailabilityIndex(self._ds())
        cum = cumulative_loglik(idx, weights={}, eps=0.0)
        assert segment_loglik(idx, {}, 1, 3, eps=0.0) == pytest.approx(cum[3] - cum[1])
        assert segment_loglik(idx, {}, 0, 3, eps=0.0) == pytest.approx(cum[3])


class TestWeighted:
    def test_forty_nine_to_one_contrast(self):
        ds = ReplayDataset.build(
            [(1000, 1, 7, 1), (2000, 2, 8, 1)], comments=_cm(7, 8)
        )
        idx = AvailabilityIndex(ds)
        cum = cumulative_loglik(idx, weights={7: 49.0}, eps=0.0)
        # k=1: 49/(49+1); k=2: fresh comment 8 has default weight 1 -> 1/50
        assert cum[1] == pytest.approx(math.log(49 / 50), rel=1e-12)
        assert cum[2] - cum[1] == pytest.approx(math.log(1 / 50), rel=1e-12)

    def test_exhaustion_single_choice_is_zero(self):
        ds = ReplayDataset.build(
            [(1000, 1, 7, 1), (2000, 1, 8, 1)], comments=_cm(7, 8)
        )
        idx = AvailabilityIndex(ds)
        cum = cumulative_loglik(idx, weights={7: 49.0, 8: 3.0}, eps=0.0)
        # k=2: p1 already voted 7; only {8} remains -> log(1)
        assert cum[2] - cum[1] == pytest.approx(0.0, abs=1e-12)


class TestModeration:
    def test_mod_out_leaves_denominator(self):
        ds = ReplayDataset.build(
            [(1000, 1, 7, 1), (2000, 2, 9, 1), (3000, 1, 8, 1), (4000, 2, 7, 1)],
            comments=_cm(7, 8, 9),
            mod_events=[ModEvent(t_ms=2500, tid=9, mod=-1)],
        )
        idx = AvailabilityIndex(ds)
        cum = cumulative_loglik(idx, weights={}, eps=0.0)
        terms = np.diff(cum)
        # k=1: {7,8,9} -> log(1/3); k=2: p2 among {7,8,9} -> log(1/3)
        # k=3: 9 modded out at 2500; p1 voted 7 -> {8} -> 0
        # k=4: p2 voted 9 (now gone, must NOT double-subtract) -> {7,8} -> log(1/2)
        np.testing.assert_allclose(
            terms,
            [math.log(1 / 3), math.log(1 / 3), 0.0, math.log(1 / 2)],
            rtol=1e-12,
        )

    def test_strict_moderation_requires_mod_in(self):
        ds = ReplayDataset.build(
            [(1000, 1, 8, 1)],
            comments=_cm(7, 8),
            mod_events=[ModEvent(t_ms=500, tid=8, mod=1)],
            strict_moderation=True,
        )
        idx = AvailabilityIndex(ds)
        cum = cumulative_loglik(idx, weights={}, eps=0.0)
        # only 8 is modded-in; 7 is not available under strict -> log(1)
        assert cum[1] == pytest.approx(0.0, abs=1e-12)

    def test_vote_on_unavailable_comment_guarded(self, caplog):
        ds = ReplayDataset.build(
            [(2000, 1, 7, 1)],
            comments=_cm(7, 8),
            mod_events=[ModEvent(t_ms=1500, tid=7, mod=-1)],
        )
        idx = AvailabilityIndex(ds)
        with caplog.at_level("WARNING"):
            cum = cumulative_loglik(idx, weights={}, eps=0.0)
        # guard restores 7 into its own choice set: {7 (guarded), 8} -> log(1/2)
        assert cum[1] == pytest.approx(math.log(0.5), rel=1e-12)
        assert any("unavailable" in r.message for r in caplog.records)


class TestRevotesAndEps:
    def test_revote_contributes_zero(self):
        ds = ReplayDataset.build(
            [(1000, 1, 7, 1), (2000, 1, 7, -1), (3000, 2, 7, 1)],
            comments=_cm(7, 8),
        )
        idx = AvailabilityIndex(ds)
        cum = cumulative_loglik(idx, weights={}, eps=0.0)
        assert cum[2] == pytest.approx(cum[1], abs=1e-15)

    def test_eps_mixture_value(self):
        ds = ReplayDataset.build([(1000, 1, 8, 1)], comments=_cm(7, 8))
        idx = AvailabilityIndex(ds)
        cum = cumulative_loglik(idx, weights={7: 49.0}, eps=0.02)
        expected = math.log(0.98 * (1 / 50) + 0.02 / 2)
        assert cum[1] == pytest.approx(expected, rel=1e-12)

    def test_comment_created_later_not_available_before(self):
        cm = {7: CommentMeta(7, created_ms=0), 8: CommentMeta(8, created_ms=2500)}
        ds = ReplayDataset.build(
            [(1000, 1, 7, 1), (3000, 2, 7, 1)], comments=cm
        )
        idx = AvailabilityIndex(ds)
        cum = cumulative_loglik(idx, weights={}, eps=0.0)
        terms = np.diff(cum)
        # k=1: only {7} exists -> 0.0 ; k=2: {7,8} -> log(1/2)
        np.testing.assert_allclose(terms, [0.0, math.log(0.5)], rtol=1e-12)
