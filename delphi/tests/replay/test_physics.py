"""Tests for polismath.replay.physics — L0 forced cuts and the candidate lattice.

Soundness is the load-bearing property: a *forced* slot claims the production
worker MUST have recomputed exactly there. A false forced cut poisons the DP
(all schedules without it get -inf), so `forced ⊆ true_schedule` on synthetic
ground truth is the critical test.
"""

from polismath.replay.physics import CandidateLattice, build_lattice, forced_slots
from polismath.replay.synthetic import SimConfig, simulate
from polismath.replay.types import ReplayDataset


def _ds_with_gaps():
    # votes at 0,1,2, 100, 101, 200 seconds
    times_s = [0, 1, 2, 100, 101, 200]
    return ReplayDataset.build(
        [(t * 1000, pid, pid % 3, 1) for pid, t in enumerate(times_s)]
    )


class TestForcedSlots:
    def test_gaps_above_threshold_force_cuts(self):
        ds = _ds_with_gaps()
        # threshold = poll 1s + compute 5s = 6s: gaps 3->4 (98s) and 5->6 (99s)
        assert forced_slots(ds, poll_interval_ms=1000, compute_ms=5000) == {3, 5}

    def test_downtime_suppresses_forcing(self):
        ds = _ds_with_gaps()
        forced = forced_slots(
            ds,
            poll_interval_ms=1000,
            compute_ms=5000,
            downtime_ms=[(2_500, 99_000)],
        )
        assert forced == {5}

    def test_small_gaps_never_forced(self):
        ds = _ds_with_gaps()
        assert forced_slots(ds, poll_interval_ms=1000, compute_ms=200_000) == set()

    def test_empty_dataset(self):
        ds = ReplayDataset.build([])
        assert forced_slots(ds, 1000, 5000) == set()

    def test_soundness_on_synthetic_ground_truth(self):
        for seed in range(5):
            cfg = SimConfig(
                era="B", n_participants=25, n_comments=15,
                duration_s=1800.0, poll_interval_s=1.0, compute_time_s=5.0,
                seed=seed,
            )
            r = simulate(cfg)
            forced = forced_slots(r.dataset, poll_interval_ms=1000, compute_ms=5000)
            assert forced <= set(r.true_schedule), (
                f"seed {seed}: false forced cuts {forced - set(r.true_schedule)}"
            )
            assert forced, f"seed {seed}: sparse-arrival sim should force some cuts"


class TestBuildLattice:
    def _ds_n(self, n):
        return ReplayDataset.build([(k * 1000, k, k % 4, 1) for k in range(1, n + 1)])

    def test_forced_and_extra_included(self):
        ds = self._ds_n(6)
        lat = build_lattice(ds, forced={3, 5}, extra={1}, burst_stride=100)
        assert isinstance(lat, CandidateLattice)
        assert set(lat.slots) >= {1, 3, 5}
        assert lat.forced == {3, 5}
        assert lat.slots == sorted(set(lat.slots))

    def test_stride_one_fills_everything(self):
        ds = self._ds_n(6)
        lat = build_lattice(ds, forced={3}, extra=set(), burst_stride=1)
        assert lat.slots == [1, 2, 3, 4, 5, 6]

    def test_burst_thinning_covers_long_runs(self):
        ds = self._ds_n(100)
        lat = build_lattice(ds, forced={50}, extra=set(), burst_stride=8)
        # every slot is within stride distance of a candidate
        for s in range(1, 101):
            assert min(abs(s - c) for c in lat.slots) < 8

    def test_cap_keeps_all_forced(self):
        ds = self._ds_n(100)
        forced = {10, 20, 30, 40, 50, 60}
        lat = build_lattice(ds, forced=forced, extra=set(range(1, 101)), max_slots=10)
        assert forced <= set(lat.slots)
        assert len(lat.slots) <= 10

    def test_extra_outside_range_ignored(self):
        ds = self._ds_n(5)
        lat = build_lattice(ds, forced=set(), extra={0, 3, 99}, burst_stride=100)
        assert 0 not in lat.slots and 99 not in lat.slots and 3 in lat.slots
