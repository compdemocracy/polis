"""Real-data tests: loader, semi-synthetic recovery on real timings, smoke.

Semi-synthetic = keep the REAL vote arrival process (timestamps, participant
ids, bursts, overnight gaps) but regenerate which-comment marks under a
simulated worker + router. Ground truth is then known while the timing
physics is real — the strongest honest test short of production logs.

The full-real smoke run makes NO accuracy claim (no ground truth exists —
that is exactly the R2 problem); it asserts well-formedness, runtime, and
writes a diagnostics artifact to scratch/ for human review.
"""

import json
import time
from pathlib import Path

import numpy as np
import pytest

from polismath.replay.dp import PriorConfig, sample_schedules
from polismath.replay.emission import AvailabilityIndex, cumulative_loglik
from polismath.replay.real_data import dataset_dir, load_export_votes
from polismath.replay.scan import infer_schedule
from polismath.replay.synthetic import SimConfig, simulate
from polismath.replay.types import ReplayDataset
from polismath.replay.weights import era_b_weights, prefix_stats_at_slots

pytestmark = pytest.mark.skipif(
    dataset_dir("vw") is None, reason="public vw dataset not present"
)


def _localization(samples, true_schedule):
    per_cut = []
    for tc in true_schedule:
        dists = [min(abs(s - tc) for s in sch) for sch in samples if sch]
        per_cut.append(np.median(dists))
    return float(np.median(per_cut))


class TestLoader:
    def test_vw_loads_sorted_with_revotes(self):
        ds = load_export_votes("vw")
        assert ds.n == 4683
        t = [v.t_ms for v in ds.votes]
        assert t == sorted(t)
        n_revotes = sum(v.is_revote for v in ds.votes)
        # harness design doc: vw has 87 revoted (pid, tid) pairs
        assert 80 <= n_revotes <= 130, n_revotes
        assert set(ds.comments), "comments inferred from votes"


def _semi_synthetic(ds: ReplayDataset, compute_s: float, seed: int):
    """Regenerate marks on the real arrival skeleton; return (ds', truth)."""
    from bisect import bisect_right

    rng = np.random.default_rng(seed)
    t_ms = [v.t_ms for v in ds.votes]
    created = {c.tid: c.created_ms for c in ds.comments.values()}

    # worker: greedy busy-loop renewal over the real arrival times — the
    # first poll after (previous compute done AND a vote is pending) ingests
    # everything; matches the physics the inference assumes
    cuts: list[int] = []
    servable_at: list[tuple[float, int]] = []  # (time, cut_slot)
    worker_free = 0.0
    ingested = 0
    while ingested < ds.n:
        t_next = float(t_ms[ingested])  # first pending vote
        cut_t = max(worker_free, t_next) + 1000.0  # next poll tick
        slot = bisect_right(t_ms, cut_t)
        if slot <= ingested:  # numerical guard; should not happen
            slot = ingested + 1
        cuts.append(slot)
        dur = compute_s * 1000.0 * (1.0 + 0.25 * float(rng.uniform(-1, 1)))
        worker_free = cut_t + dur
        servable_at.append((worker_free, slot))
        ingested = slot

    # redraw marks: PL under the last servable era-B weights
    stats_at = prefix_stats_at_slots(ds.votes, cuts) if cuts else {}
    voted: dict[int, set[int]] = {}
    new_raw: list[tuple[int, int, int, int]] = []
    si = 0
    active: dict[int, float] = {}
    for k in range(1, ds.n + 1):
        v = ds.votes[k - 1]
        while si < len(servable_at) and servable_at[si][0] <= v.t_ms:
            active = era_b_weights(stats_at[servable_at[si][1]])
            si += 1
        if v.is_revote:
            prior_tids = sorted(voted.get(v.pid, set()))
            tid = prior_tids[int(rng.integers(len(prior_tids)))] if prior_tids else v.tid
            new_raw.append((v.t_ms, v.pid, tid, v.sign))
            continue
        avail = [
            tid
            for tid, c_ms in created.items()
            if c_ms <= v.t_ms and tid not in voted.get(v.pid, set())
        ]
        if not avail:
            new_raw.append((v.t_ms, v.pid, v.tid, v.sign))
            voted.setdefault(v.pid, set()).add(v.tid)
            continue
        w = np.array([active.get(t_, 1.0) for t_ in sorted(avail)])
        tid = int(rng.choice(sorted(avail), p=w / w.sum()))
        new_raw.append((v.t_ms, v.pid, tid, v.sign))
        voted.setdefault(v.pid, set()).add(tid)

    ds2 = ReplayDataset.build(new_raw, comments=ds.comments)
    return ds2, tuple(cuts)


class TestSemiSynthetic:
    def test_recovery_on_real_timing_skeleton(self):
        # vw is extremely bursty (median inter-vote gap 0 s, 90% <= 1 s), so
        # localization must be judged in TIME: the irreducible uncertainty is
        # the compute-jitter window (±18 s here), regardless of how many
        # votes land inside it. Probed 2026-07-06: med 9.8 s, p90 21 s.
        ds = load_export_votes("vw")
        compute_s = 60.0
        ds2, truth = _semi_synthetic(ds, compute_s=compute_s, seed=5)
        assert len(truth) >= 20, f"expected a real schedule, got {len(truth)} cuts"
        res = infer_schedule(
            ds2, era="B", poll_interval_ms=1000, compute_ms=int(compute_s * 1000),
            prior=PriorConfig(log_gamma=0.0, t_range=(len(truth), len(truth))),
            compute_jitter=0.3, idle_lambda_per_s=0.1,
        )
        samples = sample_schedules(res.state, 100, np.random.default_rng(2))
        t_ms = [v.t_ms for v in ds2.votes]
        time_loc = []
        for tc in truth:
            d = [
                min(abs(t_ms[min(s, ds2.n) - 1] - t_ms[tc - 1]) for s in sch) / 1000
                for sch in samples
                if sch
            ]
            time_loc.append(np.median(d))
        assert np.median(time_loc) <= 20.0, f"median time-loc {np.median(time_loc)}s"
        assert np.percentile(time_loc, 90) <= 45.0
        assert _localization(samples, truth) <= 60.0  # loose vote-index sanity
        assert res.lattice.forced <= set(truth), "physics soundness on real gaps"


class TestRealSmoke:
    def test_vw_full_pipeline_smoke_and_diagnostics(self):
        ds = load_export_votes("vw")
        start = time.monotonic()
        res = infer_schedule(
            ds, era="A", poll_interval_ms=1000, compute_ms=2000,
            prior=PriorConfig(log_gamma=-3.0),
            compute_jitter=0.5, idle_lambda_per_s=0.02,
            max_slots=400,
        )
        elapsed = time.monotonic() - start
        assert elapsed < 120.0, f"smoke inference took {elapsed:.0f}s"
        assert np.isfinite(res.dp.log_Z)
        assert all(0.0 <= p <= 1.0 + 1e-9 for p in res.dp.cut_marginals.values())
        top = sorted(
            res.dp.cut_marginals.items(), key=lambda kv: -kv[1]
        )[:10]
        out = {
            "dataset": "vw",
            "note": "diagnostic only — era-A weights with zero extremity, "
            "no ground truth exists (that is the R2 problem)",
            "n_votes": ds.n,
            "log_Z": res.dp.log_Z,
            "map_len": len(res.dp.map_schedule),
            "n_forced": len(res.lattice.forced),
            "top10_marginals": [[int(s), round(p, 4)] for s, p in top],
            "elapsed_s": round(elapsed, 1),
        }
        scratch = Path(__file__).resolve().parents[2] / "scratch"
        scratch.mkdir(exist_ok=True)
        (scratch / "r2-vw-smoke.json").write_text(json.dumps(out, indent=2))


class TestPerfGuard:
    def test_large_synthetic_runtime(self):
        cfg = SimConfig(
            era="B", n_participants=600, n_comments=60,
            mean_votes_per_participant=60.0, duration_s=43_200.0,
            poll_interval_s=1.0, compute_time_s=30.0, compute_jitter=0.25,
            arrival_rate_per_s=0.02, seed=3,
        )
        r = simulate(cfg)
        assert r.dataset.n >= 15_000, f"want a large conversation, got {r.dataset.n}"
        start = time.monotonic()
        res = infer_schedule(
            r.dataset, era="B", poll_interval_ms=1000, compute_ms=30_000,
            prior=PriorConfig(log_gamma=-3.0),
            compute_jitter=0.25, idle_lambda_per_s=0.1, max_slots=400,
        )
        elapsed = time.monotonic() - start
        assert np.isfinite(res.dp.log_Z)
        assert elapsed < 60.0, f"large-n inference took {elapsed:.0f}s"


class TestEmissionSweepScaling:
    def test_windowed_sweeps_are_bounded(self):
        # forced cuts bound per-left-node sweep length; verify the cum array
        # padding contract holds (values beyond k_stop equal cum[k_stop])
        ds = load_export_votes("vw")
        idx = AvailabilityIndex(ds)
        cum = cumulative_loglik(idx, weights={}, eps=0.0, k_stop=100)
        assert float(cum[100]) == float(cum[-1])
