"""Tests for polismath.replay.correction — L2 self-normalized IS.

Samples come exactly from the L1 DP posterior q, and the target is
q(σ) · exp(delta(σ) + endpoint(σ)), so the self-normalized weight of a draw
is exp(delta + endpoint) — no density evaluation of q needed. `delta` is the
engine's emission log-likelihood correction relative to the L1 surrogate
(chain-dependent effects), and the endpoint potential scores the recorded
final blob. Assertions check the closed-form reweighting identities on
two-valued weight configurations — exact up to Monte-Carlo error.
"""

import math

import numpy as np
import pytest

from polismath.replay.correction import ISResult, is_correct
from polismath.replay.dp import PriorConfig
from polismath.replay.scan import infer_schedule
from polismath.replay.synthetic import SimConfig, simulate


class _DeltaEngine:
    """delta = bonus iff `slot` is in the schedule; fixed features."""

    def __init__(self, slot, bonus):
        self.slot, self.bonus = slot, bonus

    def forward(self, ds, schedule):
        delta = self.bonus if self.slot in schedule else 0.0
        return delta, np.array([float(len(schedule))])


class _NeutralEngine:
    def forward(self, ds, schedule):
        return 0.0, np.array([float(len(schedule))])


def _setup(seed=21):
    cfg = SimConfig(
        era="B", n_participants=10, n_comments=8, duration_s=600.0,
        poll_interval_s=1.0, compute_time_s=30.0, compute_jitter=0.25, seed=seed,
    )
    r = simulate(cfg)
    res = infer_schedule(
        r.dataset, era="B", poll_interval_ms=1000, compute_ms=30000,
        prior=PriorConfig(log_gamma=-1.0), compute_jitter=0.25,
        idle_lambda_per_s=0.1,
    )
    return r, res


class TestDeltaReweighting:
    def test_bonus_slot_marginal_matches_closed_form(self):
        r, res = _setup()
        # pick a slot with non-degenerate L1 marginal
        slot = max(
            (s for s, p in res.dp.cut_marginals.items() if 0.1 < p < 0.9),
            key=lambda s: min(res.dp.cut_marginals[s], 1 - res.dp.cut_marginals[s]),
            default=None,
        )
        assert slot is not None, "need an ambiguous slot for this test"
        bonus = 2.0
        rng = np.random.default_rng(7)
        out = is_correct(
            r.dataset, res.state, engine=_DeltaEngine(slot, bonus),
            n_samples=4000, rng=rng,
        )
        assert isinstance(out, ISResult)
        # empirical q-frequency of the slot among the drawn samples
        p_hat = float(np.mean([slot in s for s in out.schedules]))
        expected = p_hat * math.exp(bonus) / (p_hat * math.exp(bonus) + (1 - p_hat))
        got = out.weighted_marginals()[slot]
        assert got > p_hat, "bonus must increase the marginal"
        assert abs(got - expected) < 0.02
        # two-valued weights: ESS has a closed form
        w1, w0 = math.exp(bonus), 1.0
        s1, s0 = p_hat * w1, (1 - p_hat) * w0
        ess_frac = (s1 + s0) ** 2 / (p_hat * w1**2 + (1 - p_hat) * w0**2)
        assert abs(out.ess / 4000 - ess_frac) < 0.05

    def test_neutral_engine_is_identity(self):
        r, res = _setup()
        rng = np.random.default_rng(8)
        out = is_correct(
            r.dataset, res.state, engine=_NeutralEngine(), n_samples=2000, rng=rng,
        )
        assert out.ess == pytest.approx(2000, rel=1e-9)
        wm = out.weighted_marginals()
        for s, p in wm.items():
            emp = float(np.mean([s in sched for sched in out.schedules]))
            assert abs(p - emp) < 1e-9


class TestEndpointPotential:
    def test_endpoint_concentrates_on_matching_feature(self):
        r, res = _setup(seed=22)
        neutral = is_correct(
            r.dataset, res.state, engine=_NeutralEngine(), n_samples=3000,
            rng=np.random.default_rng(9),
        )
        length_counts = {}
        for s in neutral.schedules:
            length_counts[len(s)] = length_counts.get(len(s), 0) + 1
        assert len(length_counts) >= 2, "need length diversity for this test"
        target_len = sorted(length_counts)[0]
        out = is_correct(
            r.dataset, res.state, engine=_NeutralEngine(), n_samples=3000,
            rng=np.random.default_rng(9),
            endpoint_obs=np.array([float(target_len)]), endpoint_scale=0.25,
        )
        # weighted length distribution concentrates on target_len
        w = np.exp(out.log_weights - np.max(out.log_weights))
        w = w / w.sum()
        mass = sum(
            float(wi) for wi, s in zip(w, out.schedules) if len(s) == target_len
        )
        assert mass > 0.95

    def test_ess_degrades_gracefully_and_is_reported(self):
        r, res = _setup(seed=23)
        out = is_correct(
            r.dataset, res.state, engine=_NeutralEngine(), n_samples=500,
            rng=np.random.default_rng(10),
            endpoint_obs=np.array([1e9]), endpoint_scale=0.1,  # impossible obs
        )
        # all weights equal(ly terrible): normalized ESS returns ~n, but the
        # max log-weight is catastrophic and reported for diagnostics
        assert out.log_weights.max() < -1e6
        assert np.isfinite(out.ess)
