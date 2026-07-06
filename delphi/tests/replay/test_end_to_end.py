"""End-to-end schedule recovery on synthetic ground truth.

Metrics, chosen to respect identifiability (calibrated empirically
2026-07-06, probes in the session journal):

- **Posterior localization** (primary): for each true cut, the median over
  posterior samples of the distance to the nearest sampled cut. Observed:
  median 1 vote, p90 2 votes, in BOTH eras. This is the R2-relevant
  property — downstream consumers use the posterior, not the MAP.
- **Any-hit coverage@3**: fraction of true cuts with a sampled cut within
  ±3 votes, per sample. Observed ≥ 0.92 everywhere.
- **MAP matched displacement** (loose regression guard only): optimal
  1-1 assignment (scipy) between MAP and true cuts. The MAP is a fragile
  summary in emission-flat stretches — a single insertion cascades — so
  bounds are deliberately loose.

Era B carries emission information only at dom flips; era A (varied
weights) is information-rich. Both rely on the physics prior: forced cuts,
min-spacing, emission delay, and the soft renewal idle penalty.
"""

import numpy as np
from scipy.optimize import linear_sum_assignment

from polismath.replay.dp import PriorConfig, sample_schedules
from polismath.replay.scan import infer_schedule
from polismath.replay.synthetic import SimConfig, simulate


def _matched_median(map_schedule, true_schedule):
    a = np.array(sorted(map_schedule))
    b = np.array(sorted(true_schedule))
    cost = np.abs(a[:, None] - b[None, :])
    r, c = linear_sum_assignment(cost)
    return float(np.median(cost[r, c]))


def _localization(samples, true_schedule):
    """(median, p90) over true cuts of median-over-samples nearest distance."""
    per_cut = []
    for tc in true_schedule:
        dists = [min(abs(s - tc) for s in sch) for sch in samples if sch]
        per_cut.append(np.median(dists))
    return float(np.median(per_cut)), float(np.percentile(per_cut, 90))


def _coverage(samples, true_schedule, w=3):
    hits = []
    for tc in true_schedule:
        hits.append(np.mean([min(abs(s - tc) for s in sch) <= w for sch in samples if sch]))
    return float(np.mean(hits))


def _run(cfg, era=None, t_exact=True, n_samples=200, **infer_kw):
    r = simulate(cfg)
    prior = (
        PriorConfig(log_gamma=0.0, t_range=(len(r.true_schedule), len(r.true_schedule)))
        if t_exact
        else PriorConfig(log_gamma=-3.0)
    )
    res = infer_schedule(
        r.dataset,
        era=era or cfg.era,
        poll_interval_ms=int(cfg.poll_interval_s * 1000),
        compute_ms=int(cfg.compute_time_s * 1000),
        prior=prior,
        compute_jitter=max(cfg.compute_jitter, 0.25),
        idle_lambda_per_s=0.1,
        **infer_kw,
    )
    samples = (
        sample_schedules(res.state, n_samples, np.random.default_rng(1))
        if n_samples
        else []
    )
    return r, res, samples


def _moderate_cfg(**kw):
    # compute_time_s=30 + jitter puts the sim in the interesting regime:
    # ~5 votes per segment, few forced cuts, stochastic ground truth
    # (probed 2026-07-06: n≈220-240, T≈45-55, forced≈4)
    base = dict(
        era="B", n_participants=25, n_comments=15, duration_s=1800.0,
        poll_interval_s=1.0, compute_time_s=30.0, compute_jitter=0.25, seed=0,
    )
    base.update(kw)
    return SimConfig(**base)


class TestRecoveryEraB:
    def test_forced_cuts_all_recovered(self):
        r, res, _ = _run(_moderate_cfg(seed=1), n_samples=0)
        assert res.lattice.forced <= set(res.dp.map_schedule)
        assert res.lattice.forced <= set(r.true_schedule)

    def test_posterior_localization_moderate(self):
        r, res, samples = _run(_moderate_cfg(seed=2))
        med, p90 = _localization(samples, r.true_schedule)
        assert med <= 2.0, f"median localization {med}"
        assert p90 <= 5.0, f"p90 localization {p90}"
        assert _coverage(samples, r.true_schedule) >= 0.85

    def test_aggregate_calibration_over_seeds(self):
        meds, covs, matched = [], [], []
        for seed in range(100, 106):
            r, res, samples = _run(_moderate_cfg(seed=seed))
            med, _ = _localization(samples, r.true_schedule)
            meds.append(med)
            covs.append(_coverage(samples, r.true_schedule))
            matched.append(_matched_median(res.dp.map_schedule, r.true_schedule))
        assert np.median(meds) <= 2.0, meds
        assert np.mean(covs) >= 0.85, covs
        assert min(covs) >= 0.75, covs
        assert np.median(matched) <= 12.0, matched  # loose MAP guard


class TestRecoveryEraA:
    def test_era_a_localizes_and_covers(self):
        meds, covs = [], []
        for seed in (3, 4, 5):
            r, res, samples = _run(_moderate_cfg(era="A", seed=seed))
            med, _ = _localization(samples, r.true_schedule)
            meds.append(med)
            covs.append(_coverage(samples, r.true_schedule))
        assert np.median(meds) <= 2.0, meds
        assert np.mean(covs) >= 0.85, covs

    def test_era_a_map_not_worse_than_era_b(self):
        matched = {"A": [], "B": []}
        for era in ("B", "A"):
            for seed in (3, 4, 5):
                r, res, _ = _run(_moderate_cfg(era=era, seed=seed), n_samples=0)
                matched[era].append(
                    _matched_median(res.dp.map_schedule, r.true_schedule)
                )
        assert np.median(matched["A"]) <= np.median(matched["B"]) + 2.0, matched


class TestEdgeCases:
    def test_zero_votes(self):
        r, res, _ = _run(_moderate_cfg(n_participants=0), t_exact=False, n_samples=0)
        assert r.dataset.n == 0
        assert res.dp.map_schedule == ()

    def test_single_vote(self):
        cfg = _moderate_cfg(
            n_participants=1, n_comments=3, mean_votes_per_participant=1.0,
            session_quit_prob=1.0, seed=6,
        )
        r, res, _ = _run(cfg, t_exact=False, n_samples=0)
        assert r.dataset.n >= 1
        assert res.dp.log_Z > -np.inf

    def test_single_burst_unconstrained_finds_few_cuts(self):
        cfg = _moderate_cfg(
            n_participants=8, duration_s=30.0, compute_time_s=3600.0,
            compute_jitter=0.0, arrival_rate_per_s=None, seed=7,
        )
        r, res, _ = _run(cfg, t_exact=False, n_samples=0)
        assert len(res.dp.map_schedule) <= max(2, len(r.true_schedule))

    def test_downtime_soundness(self):
        window = (600.0, 1200.0)
        cfg = _moderate_cfg(downtime=[window], seed=8)
        r = simulate(cfg)
        res = infer_schedule(
            r.dataset, era="B", poll_interval_ms=1000,
            compute_ms=int(cfg.compute_time_s * 1000),
            downtime_ms=[(int(window[0] * 1000), int(window[1] * 1000))],
            prior=PriorConfig(log_gamma=-3.0),
        )
        assert res.lattice.forced <= set(r.true_schedule)

    def test_fresh_comment_flood_is_informative(self):
        cfg = _moderate_cfg(n_comments=40, seed=9)
        r, res, samples = _run(cfg)
        med, _ = _localization(samples, r.true_schedule)
        assert med <= 2.0

    def test_exhaustion_regime(self):
        cfg = _moderate_cfg(
            n_comments=5, n_participants=40, mean_votes_per_participant=10.0,
            seed=10,
        )
        r, res, _ = _run(cfg, n_samples=0)
        assert res.dp.log_Z > -np.inf
        assert len(res.dp.map_schedule) == len(r.true_schedule)

    def test_mod_out_mid_stream(self):
        cfg = _moderate_cfg(mod_out=[(600.0, 0), (900.0, 1)], seed=11)
        r, res, samples = _run(cfg)
        med, _ = _localization(samples, r.true_schedule)
        assert med <= 2.0

    def test_constrained_matches_count(self):
        r, res, _ = _run(_moderate_cfg(seed=12), n_samples=0)
        assert len(res.dp.map_schedule) == len(r.true_schedule)

    def test_revote_heavy(self):
        cfg = _moderate_cfg(revote_prob=0.2, seed=13)
        r, res, samples = _run(cfg)
        med, _ = _localization(samples, r.true_schedule)
        assert med <= 2.0
