"""Tests for polismath.replay.dp — the exact changepoint DP.

The oracle is exhaustive enumeration: every subset of the candidate lattice
(respecting forced slots and the count constraint) scored directly with
`log_posterior`. The DP must reproduce the enumeration's normalizer, cut
marginals, MAP, and sampling distribution to numerical precision — this is
what "exact" means and it is the property the whole design leans on.
"""

import itertools
import math
from collections import Counter

import numpy as np
import pytest

from polismath.replay.dp import (
    DPResult,
    PriorConfig,
    log_posterior,
    run_dp,
    sample_schedules,
    weights_for_lattice,
)
from polismath.replay.emission import AvailabilityIndex
from polismath.replay.physics import CandidateLattice
from polismath.replay.synthetic import SimConfig, simulate


def _small_case(era="B", seed=11):
    cfg = SimConfig(
        era=era,
        n_participants=8,
        n_comments=8,
        duration_s=600.0,
        poll_interval_s=1.0,
        compute_time_s=20.0,
        seed=seed,
    )
    r = simulate(cfg)
    assert 15 <= r.dataset.n <= 120, f"unexpected sim size n={r.dataset.n}"
    # small lattice: true cuts plus decoy neighbours, capped for enumeration
    slots = sorted(set(r.true_schedule) | {s + 2 for s in r.true_schedule if s + 2 <= r.dataset.n})[:7]
    lattice = CandidateLattice(slots=slots, forced=set())
    return r, lattice


def _enumerate(idx, lattice, weights_at, prior, eps=0.02):
    """Brute-force posterior over all valid schedules."""
    free = [s for s in lattice.slots if s not in lattice.forced]
    out = {}
    for r in range(len(free) + 1):
        for combo in itertools.combinations(free, r):
            sched = tuple(sorted(set(combo) | lattice.forced))
            lp = log_posterior(idx, lattice, weights_at, prior, sched, eps=eps)
            if lp > -math.inf:
                out[sched] = lp
    assert out, "enumeration produced no valid schedule"
    z = np.logaddexp.reduce(np.array(list(out.values())))
    return out, float(z)


def _marginals_from_enum(enum, z):
    marg: dict[int, float] = {}
    for sched, lp in enum.items():
        for s in sched:
            marg[s] = marg.get(s, 0.0) + math.exp(lp - z)
    return marg


class TestAgainstBruteForce:
    @pytest.mark.parametrize("era", ["B", "A"])
    def test_z_marginals_map_match(self, era):
        r, lattice = _small_case(era=era)
        idx = AvailabilityIndex(r.dataset)
        weights_at = weights_for_lattice(r.dataset, lattice, era=era)
        prior = PriorConfig(log_gamma=-2.0)

        result, state = run_dp(idx, lattice, weights_at, prior)
        enum, z = _enumerate(idx, lattice, weights_at, prior)

        assert result.log_Z == pytest.approx(z, abs=1e-9)
        enum_marg = _marginals_from_enum(enum, z)
        for s in lattice.slots:
            assert result.cut_marginals[s] == pytest.approx(
                enum_marg.get(s, 0.0), abs=1e-9
            )
        map_enum = max(enum, key=lambda s: enum[s])
        assert result.map_schedule == map_enum
        assert result.map_logpost == pytest.approx(enum[map_enum], abs=1e-9)

    def test_constrained_count_matches_bruteforce(self):
        r, lattice = _small_case()
        idx = AvailabilityIndex(r.dataset)
        weights_at = weights_for_lattice(r.dataset, lattice, era="B")
        prior = PriorConfig(log_gamma=0.0, t_range=(1, 2))

        result, _ = run_dp(idx, lattice, weights_at, prior)
        enum, z = _enumerate(idx, lattice, weights_at, prior)
        assert all(1 <= len(s) <= 2 for s in enum)
        assert result.log_Z == pytest.approx(z, abs=1e-9)
        enum_marg = _marginals_from_enum(enum, z)
        for s in lattice.slots:
            assert result.cut_marginals[s] == pytest.approx(
                enum_marg.get(s, 0.0), abs=1e-9
            )

    def test_forced_slot_has_marginal_one(self):
        r, lattice = _small_case()
        forced_slot = lattice.slots[1]
        lattice = CandidateLattice(slots=lattice.slots, forced={forced_slot})
        idx = AvailabilityIndex(r.dataset)
        weights_at = weights_for_lattice(r.dataset, lattice, era="B")
        result, _ = run_dp(idx, lattice, weights_at, PriorConfig(log_gamma=-2.0))
        assert result.cut_marginals[forced_slot] == pytest.approx(1.0, abs=1e-12)
        assert forced_slot in result.map_schedule
        # enumeration agreement under the constraint too
        _enum, z = _enumerate(idx, lattice, weights_at, PriorConfig(log_gamma=-2.0))
        assert result.log_Z == pytest.approx(z, abs=1e-9)

    def test_sampling_matches_enumeration(self):
        r, lattice = _small_case(seed=13)
        idx = AvailabilityIndex(r.dataset)
        weights_at = weights_for_lattice(r.dataset, lattice, era="B")
        prior = PriorConfig(log_gamma=-1.0)
        result, state = run_dp(idx, lattice, weights_at, prior)
        enum, z = _enumerate(idx, lattice, weights_at, prior)

        n_draws = 4000
        draws = sample_schedules(state, n_draws, np.random.default_rng(0))
        freq = Counter(draws)
        for sched, lp in enum.items():
            p = math.exp(lp - z)
            if p > 0.01:
                assert freq[sched] / n_draws == pytest.approx(p, abs=0.05)


class TestMinSpacing:
    def test_min_spacing_matches_bruteforce(self):
        r, lattice = _small_case(seed=17)
        idx = AvailabilityIndex(r.dataset)
        weights_at = weights_for_lattice(r.dataset, lattice, era="B")
        prior = PriorConfig(log_gamma=-1.0)
        spacing = 60_000  # 60 s: aggressive, prunes many pairs

        result, state = run_dp(
            idx, lattice, weights_at, prior, min_spacing_ms=spacing
        )
        free = [s for s in lattice.slots if s not in lattice.forced]
        enum = {}
        for k in range(len(free) + 1):
            for combo in itertools.combinations(free, k):
                sched = tuple(sorted(set(combo) | lattice.forced))
                lp = log_posterior(
                    idx, lattice, weights_at, prior, sched,
                    eps=0.02, min_spacing_ms=spacing,
                )
                if lp > -math.inf:
                    enum[sched] = lp
        z = np.logaddexp.reduce(np.array(list(enum.values())))
        assert result.log_Z == pytest.approx(float(z), abs=1e-9)
        enum_marg = _marginals_from_enum(enum, z)
        for s in lattice.slots:
            assert result.cut_marginals[s] == pytest.approx(
                enum_marg.get(s, 0.0), abs=1e-9
            )
        # the constraint must actually bite in this construction
        unconstrained, _ = run_dp(idx, lattice, weights_at, prior)
        assert len(enum) < 2 ** len(free) or unconstrained.log_Z != result.log_Z


class TestEmissionDelay:
    def test_emission_delay_matches_bruteforce(self):
        r, lattice = _small_case(seed=19)
        idx = AvailabilityIndex(r.dataset)
        weights_at = weights_for_lattice(r.dataset, lattice, era="B")
        prior = PriorConfig(log_gamma=-1.0)
        delay = 20_000  # one compute time in the small case

        result, _ = run_dp(
            idx, lattice, weights_at, prior, emission_delay_ms=delay
        )
        free = [s for s in lattice.slots if s not in lattice.forced]
        enum = {}
        for k in range(len(free) + 1):
            for combo in itertools.combinations(free, k):
                sched = tuple(sorted(set(combo) | lattice.forced))
                lp = log_posterior(
                    idx, lattice, weights_at, prior, sched,
                    eps=0.02, emission_delay_ms=delay,
                )
                if lp > -math.inf:
                    enum[sched] = lp
        z = np.logaddexp.reduce(np.array(list(enum.values())))
        assert result.log_Z == pytest.approx(float(z), abs=1e-9)
        enum_marg = _marginals_from_enum(enum, z)
        for s in lattice.slots:
            assert result.cut_marginals[s] == pytest.approx(
                enum_marg.get(s, 0.0), abs=1e-9
            )
        # sanity: the delay actually changes the posterior in this case
        plain, _ = run_dp(idx, lattice, weights_at, prior)
        assert plain.log_Z != pytest.approx(result.log_Z, abs=1e-12)


class TestStructuralProperties:
    def test_empty_schedule_included_when_unforced(self):
        r, lattice = _small_case()
        idx = AvailabilityIndex(r.dataset)
        weights_at = weights_for_lattice(r.dataset, lattice, era="B")
        prior = PriorConfig(log_gamma=-2.0)
        enum, z = _enumerate(idx, lattice, weights_at, prior)
        assert () in enum
        lp_direct = log_posterior(idx, lattice, weights_at, prior, (), eps=0.02)
        assert lp_direct == pytest.approx(enum[()], abs=1e-12)

    def test_log_posterior_rejects_invalid(self):
        r, lattice = _small_case()
        idx = AvailabilityIndex(r.dataset)
        weights_at = weights_for_lattice(r.dataset, lattice, era="B")
        prior = PriorConfig()
        # slot not in lattice
        bad = (lattice.slots[0] + 1 if lattice.slots[0] + 1 not in lattice.slots else lattice.slots[0] - 1,)
        assert log_posterior(idx, lattice, weights_at, prior, bad) == -math.inf
        # missing forced slot
        lat_f = CandidateLattice(slots=lattice.slots, forced={lattice.slots[0]})
        w_f = weights_for_lattice(r.dataset, lat_f, era="B")
        assert (
            log_posterior(idx, lat_f, w_f, prior, (lattice.slots[1],)) == -math.inf
        )
        # count constraint violated
        prior_c = PriorConfig(t_range=(2, 3))
        assert log_posterior(idx, lattice, weights_at, prior_c, ()) == -math.inf

    def test_result_types(self):
        r, lattice = _small_case()
        idx = AvailabilityIndex(r.dataset)
        weights_at = weights_for_lattice(r.dataset, lattice, era="B")
        result, state = run_dp(idx, lattice, weights_at, PriorConfig())
        assert isinstance(result, DPResult)
        assert set(result.cut_marginals) == set(lattice.slots)
        assert all(0.0 <= p <= 1.0 + 1e-12 for p in result.cut_marginals.values())
