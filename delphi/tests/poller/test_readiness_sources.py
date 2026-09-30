"""P-072: the evidence sources behind the readiness line — the backfill's last
sweep and drain, the service's discovery counters, and one run id for both."""

from unittest.mock import MagicMock

import psycopg2
import pytest

from polismath.poller import backfill as bf
from polismath.poller.readiness import ReadinessReporter, ReadinessSettings, parse_readiness
from polismath.poller.service import MathPollerService, PollerConfig

from .test_backfill import NOW, FakeDb, drain, make


# --------------------------------------------------------------------------- #
# Backfill: sweep summary and DRAINED
# --------------------------------------------------------------------------- #
def test_no_sweep_yet():
    t = make(FakeDb())
    sweep, dr = t.sched.readiness()
    assert sweep is None and dr == {"run": t.sched.run_id, "drained_ms": None}


def test_complete_sweep_summary_binds_run_and_config(caplog):
    db = FakeDb()
    db.add(1, 10)
    db.add(2, 20)
    t = make(db)
    caplog.set_level("WARNING")
    drain(t)
    # A sweep that found work is not COMPLETE; the next, empty one is.
    assert t.sched.readiness()[0]["status"] == "NOT_COMPLETE"
    start = t.clock.t
    drain(t)
    sweep, _ = t.sched.readiness()
    assert start < t.clock.t
    assert sweep == {"sweep_no": 2, "finished_ms": int(t.clock.t * 1000), "run": t.sched.run_id,
                     "config": t.sched.config.digest(), "status": "COMPLETE", "unresolved": 0,
                     "parked_live": 0, "in_flight": 0}
    # The verbatim sweep line carries the same run/config/sweep number.
    assert (f"math-backfill sweep=1 run={t.sched.run_id} config={t.sched.config.digest()}"
            in caplog.text)
    assert f"math-backfill COMPLETE run={t.sched.run_id} sweep=2" in caplog.text


def test_unresolved_sweep_is_not_complete():
    db = FakeDb()
    db.add(1, 10)
    t = make(db, max_attempts=1)
    t.host.compute_fail.add(1)
    drain(t)
    sweep, _ = t.sched.readiness()
    assert sweep["status"] == "NOT_COMPLETE" and sweep["unresolved"] == 1


def test_unreadable_aggregate_is_unknown():
    t = make(FakeDb())
    t.sched._store.label_counts = lambda cutoff: (_ for _ in ()).throw(RuntimeError("down"))
    t.sched._finish_sweep(NOW)
    assert t.sched.readiness()[0]["status"] == "UNKNOWN"


def test_parked_live_blocks_complete():
    t = make(FakeDb())
    t.host.parked_live = 2
    t.sched._finish_sweep(NOW)
    sweep = t.sched.readiness()[0]
    assert sweep["status"] == "NOT_COMPLETE" and sweep["parked_live"] == 2


def test_drained_time_is_set_on_drain_and_cleared_on_resume():
    db = FakeDb()
    db.add(1, 10)
    t = make(db)
    assert t.sched.step()[0] == "admitted"
    t.sched.toggle_pause()
    t.sched.step()
    assert t.sched.readiness()[1]["drained_ms"] is None  # the job is still in flight
    t.sched.run_job(1)
    t.host.pending.discard(1)
    t.clock.t += 7
    t.sched.step()
    assert t.sched.readiness()[1] == {"run": t.sched.run_id, "drained_ms": int((NOW + 7) * 1000)}
    t.sched.toggle_pause()
    t.sched.step()
    assert t.sched.readiness()[1]["drained_ms"] is None


def test_run_id_is_adopted_and_checked():
    t = make(FakeDb())
    sched = bf.BackfillScheduler(t.host, t.sched._store, t.sched.config, clock=t.clock,
                                 rss_fn=lambda: 0, release_fn=lambda: None, run_id="abcdef012345")
    assert sched.run_id == "abcdef012345"
    with pytest.raises(bf.ConfigError):
        bf.BackfillScheduler(t.host, t.sched._store, t.sched.config, clock=t.clock,
                             rss_fn=lambda: 0, release_fn=lambda: None, run_id="zid-7")


# --------------------------------------------------------------------------- #
# Service: discovery counters and the snapshot
# --------------------------------------------------------------------------- #
def _service(**kw):
    pg = MagicMock()
    pg.poll_votes_since.return_value = []
    pg.poll_moderation_since.return_value = []
    svc = MathPollerService(pg, PollerConfig(), **kw)
    svc._ensure_runtime()
    return svc, pg


def test_snapshot_before_any_poll():
    svc, _ = _service()
    try:
        snap = svc.readiness_snapshot()
        assert snap["discovery"]["successes"] == 0 and snap["discovery"]["last_success_ms"] is None
        assert snap["queue"]["pending"] == 0 and snap["sweep"] is None and snap["config"] is None
        assert set(snap["admission"]) == {"budget_mb", "reserved_mb", "granted", "held", "waiting"}
    finally:
        svc._pool.shutdown()


def test_discovery_is_the_weaker_loop():
    svc, _ = _service()
    try:
        svc._note_poll("votes")
        svc._note_poll("votes")
        d = svc.readiness_snapshot()["discovery"]
        assert d["successes"] == 0 and d["last_success_ms"] is None  # moderation never ran
        svc._note_poll("moderation")
        d = svc.readiness_snapshot()["discovery"]
        assert d["successes"] == 1 and d["consecutive"] == 1 and d["last_success_ms"] is not None
        svc._note_poll("moderation", psycopg2.OperationalError("password=hunter2"))
        d = svc.readiness_snapshot()["discovery"]
        assert d["failures_since_success"] == 1 and d["consecutive"] == 0
        assert d["last_error"] == "database" and "hunter2" not in repr(d)
        svc._note_poll("moderation")
        assert svc.readiness_snapshot()["discovery"]["failures_since_success"] == 0
    finally:
        svc._pool.shutdown()


def test_poll_loops_record_success_and_failure(monkeypatch):
    svc, pg = _service()
    try:
        calls = {"n": 0}

        def poll(_wm):
            calls["n"] += 1
            if calls["n"] == 2:
                raise TimeoutError()
            if calls["n"] >= 3:
                svc._stop.set()
            return []
        pg.poll_votes_since.side_effect = poll
        svc.config.vote_interval_ms = 1
        svc._vote_loop()
        h = svc._health["votes"]
        assert h["successes"] == 2 and h["last_error"] == "timeout" and h["failures_since_success"] == 0
    finally:
        svc._pool.shutdown()


def test_service_passes_its_run_id_to_the_backfill(monkeypatch):
    seen = {}

    def fake_build(host, pg, config, **kwargs):
        seen.update(kwargs)
        return MagicMock(config=config)
    monkeypatch.setattr(bf, "build_scheduler", fake_build)
    svc, _ = _service(backfill_config=bf.BackfillConfig(enabled=True), run_id="0123456789ab")
    try:
        assert seen == {"run_id": "0123456789ab"} and svc.run_id == "0123456789ab"
    finally:
        svc._pool.shutdown()


def test_reporter_over_a_real_service_line_validates():
    svc, _ = _service()
    try:
        r = ReadinessReporter(ReadinessSettings(), svc.config, run="0123456789ab",
                              env={"HOSTNAME": "h"}, emit=lambda line: None)
        r.set_source(svc.readiness_snapshot)
        svc._note_poll("votes")
        svc._note_poll("moderation")
        r.became_primary()
        body = parse_readiness(r.tick()[0])
        assert body["role"] == "primary" and body["discovery"]["successes"] == 1
    finally:
        svc._pool.shutdown()
