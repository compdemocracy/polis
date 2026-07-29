"""Tests for polismath.replay.synthetic — the ground-truth generator.

The simulator reproduces the production data-generating process: poller
physics (1 s polls, blocking compute, downtime, restarts), weighted routing
under era A/B priorities with default-1 for unknown tids, censoring, revotes,
moderation. Every test pins a behaviour the inference layers rely on.
"""

import numpy as np

from polismath.replay.synthetic import SimConfig, simulate
from polismath.replay.weights import META_WEIGHT


def _cfg(**kw):
    base = dict(
        era="B",
        n_participants=25,
        n_comments=15,
        duration_s=1800.0,
        poll_interval_s=1.0,
        compute_time_s=5.0,
        seed=42,
    )
    base.update(kw)
    return SimConfig(**base)


class TestDeterminism:
    def test_same_seed_same_output(self):
        r1, r2 = simulate(_cfg()), simulate(_cfg())
        assert [(v.t_ms, v.pid, v.tid, v.sign) for v in r1.dataset.votes] == [
            (v.t_ms, v.pid, v.tid, v.sign) for v in r2.dataset.votes
        ]
        assert r1.true_schedule == r2.true_schedule
        assert r1.tick_count == r2.tick_count

    def test_different_seed_differs(self):
        r1, r2 = simulate(_cfg()), simulate(_cfg(seed=43))
        assert [(v.t_ms, v.tid) for v in r1.dataset.votes] != [
            (v.t_ms, v.tid) for v in r2.dataset.votes
        ]


class TestScheduleSanity:
    def test_nonempty_and_strictly_increasing(self):
        r = simulate(_cfg())
        assert r.dataset.n > 50, "sim should produce a substantial conversation"
        assert len(r.true_schedule) >= 3
        assert list(r.true_schedule) == sorted(set(r.true_schedule))
        assert all(1 <= s <= r.dataset.n for s in r.true_schedule)
        r.dataset.validate_schedule(r.true_schedule)

    def test_cut_spacing_respects_compute_time(self):
        r = simulate(_cfg(compute_time_s=30.0))
        gaps = np.diff(r.true_cut_times_ms)
        assert (gaps >= 30_000).all()

    def test_tick_count_accounting(self):
        r = simulate(_cfg(restarts=[600.0, 1200.0]))
        assert r.tick_count == len(r.true_schedule) + 1 + 2

    def test_downtime_has_no_cuts(self):
        window = (600.0, 1200.0)
        r = simulate(_cfg(downtime=[window]))
        inside = [
            t for t in r.true_cut_times_ms if window[0] * 1000 < t < window[1] * 1000
        ]
        assert inside == []


class TestRoutingGroundTruth:
    def test_era_b_segment_weights_are_49_on_dom(self):
        r = simulate(_cfg())
        assert r.weights_by_segment[0] == {}  # uniform before first recompute
        for w in r.weights_by_segment[1:]:
            assert w, "post-cut weight maps must not be empty"
            assert all(val == META_WEIGHT for val in w.values())

    def test_era_a_weights_are_varied(self):
        r = simulate(_cfg(era="A", extremity=None))
        later = r.weights_by_segment[-1]
        assert len(set(round(v, 9) for v in later.values())) > 1

    def test_no_unflagged_duplicate_votes(self):
        r = simulate(_cfg(revote_prob=0.05, seed=7))
        seen = set()
        for v in r.dataset.votes:
            pair = (v.pid, v.tid)
            assert v.is_revote == (pair in seen)
            seen.add(pair)

    def test_revotes_generated_when_enabled(self):
        r = simulate(_cfg(revote_prob=0.15, seed=7))
        assert any(v.is_revote for v in r.dataset.votes)

    def test_votes_reference_known_comments(self):
        r = simulate(_cfg())
        assert {v.tid for v in r.dataset.votes} <= set(r.dataset.comments)


class TestModerationAndEdges:
    def test_mod_out_stops_serving(self):
        r = simulate(_cfg(mod_out=[(300.0, 0)], seed=3))
        # tid 0 is a seed comment created at t=0; after 300 s it may not be
        # served again (revotes are injected outside routing and excluded).
        late_first_votes = [
            v
            for v in r.dataset.votes
            if v.tid == 0 and not v.is_revote and v.t_ms > 300_000
        ]
        assert late_first_votes == []
        assert any(m.tid == 0 and m.mod == -1 for m in r.dataset.mod_events)

    def test_zero_participants(self):
        r = simulate(_cfg(n_participants=0))
        assert r.dataset.n == 0
        assert r.true_schedule == ()
        assert r.tick_count == 1

    def test_single_burst_yields_single_cut(self):
        # all participants arrive within 1 s while compute takes longer than
        # the remaining conversation -> at most a couple of cuts
        r = simulate(
            _cfg(
                n_participants=8,
                duration_s=30.0,
                compute_time_s=3600.0,
                arrival_rate_per_s=None,
                seed=5,
            )
        )
        assert len(r.true_schedule) <= 2
