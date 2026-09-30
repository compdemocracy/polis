"""P-072: the poller's readiness/liveness lines (polismath.poller.readiness)."""

import json
import re
import threading
import time
from dataclasses import dataclass, field
from typing import List

import pytest

from polismath.poller import readiness as rd
from polismath.poller.readiness import (
    ReadinessConfigError,
    ReadinessReporter,
    ReadinessSettings,
    parse_readiness,
    parse_stale,
    parse_test,
)
from polismath.poller.worker_pool import BACKFILL, VOTES, ConversationWorkerPool

T0 = 1_790_000_000_000
RUN = "0123456789ab"


@dataclass
class Cfg:
    database_url: str = "postgresql://user:secret@host/db"
    math_env: str = "python"
    vote_interval_ms: int = 1000
    allowlist: List[int] = field(default_factory=list)


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def snapshot(*, last=None, successes=(0, 0), failures=0, live_age=None, backfill_age=None,
             sweep=None, drain=None, config="fedcba987654"):
    return {
        "discovery": {"successes": min(successes), "consecutive": min(successes),
                      "last_success_ms": last, "failures_since_success": failures,
                      "last_error": "database" if failures else None,
                      "last_error_ms": last if failures else None},
        "queue": {"pending": 1 if live_age is not None else 0, "in_flight": 0, "parked": 0,
                  "oldest_live_age_ms": live_age, "oldest_backfill_age_ms": backfill_age,
                  "oldest_work_age_ms": max(live_age or 0, backfill_age or 0)},
        "sweep": sweep, "drain": drain,
        "admission": {"budget_mb": 4000, "reserved_mb": 0, "granted": 0, "held": 0, "waiting": 0},
        "config": config, "loop_marks": tuple(successes),
    }


def reporter(settings=None, env=None, clock=None):
    out = []
    r = ReadinessReporter(settings or ReadinessSettings(), Cfg(), run=RUN,
                          env=env if env is not None else {"HOSTNAME": "abc"},
                          clock_ms=clock or Clock(), emit=out.append)
    return r, out


# --------------------------------------------------------------------------- #
# Line shape and closed vocabulary
# --------------------------------------------------------------------------- #
def test_standby_line_is_closed_and_waiting():
    r, out = reporter()
    lines = r.tick()
    assert lines == out and len(lines) == 1
    assert lines[0].startswith("math_poller readiness/1 role=standby progress=waiting {")
    body = parse_readiness(lines[0])
    assert body["role"] == "standby" and body["seq"] == 1 and body["run"] == RUN
    assert set(body) - {"_silenced"} == set(rd.LINE_KEYS)
    assert body["sweep"] is None and body["drain"] is None and body["config"] is None


def test_every_leaf_is_a_count_clock_label_or_digest():
    """No ids, no content: strings are closed labels or hex digests."""
    r, _ = reporter(env={"MATH_POLLER_INSTANCE_ID": "i-0abc", "MATH_POLLER_SOURCE_COMMIT": "a" * 40,
                         "MATH_POLLER_IMAGE_DIGEST": "sha256:" + "b" * 64})
    sweep = {"sweep_no": 3, "finished_ms": T0 - 5000, "run": RUN, "config": "fedcba987654",
             "status": "COMPLETE", "unresolved": 0, "parked_live": 0, "in_flight": 0}
    r.set_source(lambda: snapshot(last=T0 - 1000, successes=(5, 5), sweep=sweep,
                                  drain={"run": RUN, "drained_ms": T0 - 2000}))
    r.became_primary()
    body = parse_readiness(r.tick()[0])
    labels = set(rd.ROLES) | set(rd.PROGRESS) | set(rd.SWEEP_STATUS) | set(rd.INSTANCE_SOURCES) | {
        rd.SCHEMA}

    def walk(v):
        if isinstance(v, dict):
            for k, x in v.items():
                if k != "_silenced":
                    walk(x)
        elif isinstance(v, str):
            assert v in labels or re.fullmatch(r"(sha256:)?[0-9a-f]{12,64}", v), v
        else:
            assert v is None or type(v) in (int, bool), v
    walk(body)
    assert body["source_commit"] == "a" * 40 and body["image_digest"] == "sha256:" + "b" * 64
    assert body["instance_source"] == "instance_id"
    assert "i-0abc" not in json.dumps(body)


def test_poller_config_digest_ignores_the_database_url():
    a = rd.config_digest(Cfg(database_url="postgresql://a:1@h/db"))
    b = rd.config_digest(Cfg(database_url="postgresql://b:2@h/db"))
    c = rd.config_digest(Cfg(math_env="other"))
    assert a == b != c and re.fullmatch("[0-9a-f]{12}", a)


def test_malformed_identity_values_are_dropped_not_logged():
    ident = rd.identity({"HOSTNAME": "h", "MATH_POLLER_SOURCE_COMMIT": "not-a-commit",
                         "MATH_POLLER_IMAGE_DIGEST": "latest"})
    assert ident["source_commit"] is None and ident["image_digest"] is None
    assert ident["instance_source"] == "hostname"


def test_validate_line_refuses_extra_keys_and_open_labels():
    r, _ = reporter()
    body = json.loads(r.tick()[0].split(" ", 4)[4])
    rd.validate_line(body)
    for bad in ({**body, "zid": 7}, {**body, "role": "leader"}, {**body, "progress": "fine"},
                {**body, "run": "xyz"}):
        with pytest.raises(ValueError):
            rd.validate_line(bad)


def test_header_must_agree_with_body():
    r, _ = reporter()
    line = r.tick()[0].replace("role=standby", "role=primary", 1)
    with pytest.raises(ValueError):
        parse_readiness(line)


def test_parse_ignores_other_lines_and_log_prefixes():
    r, _ = reporter()
    line = r.tick()[0]
    prefixed = "2026-09-29 12:00:00,000 WARNING [readiness] math_poller.readiness: " + line
    assert parse_readiness(prefixed)["seq"] == 1
    assert parse_readiness("Polled 3 votes since watermark 5") is None
    assert parse_stale(line) is None and parse_test(line) is None


# --------------------------------------------------------------------------- #
# Progress, roles and transitions
# --------------------------------------------------------------------------- #
def test_primary_heartbeat_needs_discovery_progress_between_lines():
    clock = Clock()
    r, _ = reporter(clock=clock)
    state = {"s": snapshot()}
    r.set_source(lambda: state["s"])
    first = r.became_primary()  # noqa: F841 - logs at once
    assert parse_readiness(r.tick()[0])["progress"] == "starting"
    clock.t += 60_000
    state["s"] = snapshot(last=clock.t - 500, successes=(60, 60))
    assert "role=primary progress=ok " in r.tick()[0]
    clock.t += 60_000
    # The vote loop did not complete since the previous line.
    state["s"] = snapshot(last=clock.t - 61_000, successes=(60, 120))
    assert "progress=no_poll" in r.tick()[0]
    clock.t += 60_000
    state["s"] = snapshot(last=clock.t - 100, successes=(120, 180), failures=1)
    assert "progress=no_poll" in r.tick()[0]


def test_stale_discovery_emits_the_stale_line():
    clock = Clock()
    r, _ = reporter(clock=clock)
    r.set_source(lambda: snapshot(last=clock.t - 601_000, successes=(9, 9)))
    r.became_primary()
    lines = r.tick()
    assert "progress=stale" in lines[0] and len(lines) == 2
    stale = parse_stale(lines[1])
    assert stale["reason"] == "discovery" and stale["age_ms"] == 601_000 and stale["run"] == RUN


def test_never_polled_primary_goes_stale_after_the_bound():
    clock = Clock()
    r, _ = reporter(clock=clock)
    r.set_source(lambda: snapshot())
    r.became_primary()
    clock.t += 599_000
    assert len(r.tick()) == 1
    clock.t += 2_000
    lines = r.tick()
    assert "progress=stale" in lines[0] and parse_stale(lines[1])["reason"] == "discovery"


def test_stuck_live_work_is_not_a_heartbeat():
    clock = Clock()
    r, _ = reporter(clock=clock)
    marks = {"n": 1}

    def src():
        marks["n"] += 1
        return snapshot(last=clock.t - 100, successes=(marks["n"],) * 2, live_age=700_000)
    r.set_source(src)
    r.became_primary()
    lines = r.tick()
    assert "progress=stuck" in lines[0] and parse_stale(lines[1])["reason"] == "queue"


def test_a_long_backfill_job_alone_is_not_stuck():
    clock = Clock()
    r, _ = reporter(clock=clock)
    marks = {"n": 1}

    def src():
        marks["n"] += 1
        return snapshot(last=clock.t - 100, successes=(marks["n"],) * 2, backfill_age=3_600_000)
    r.set_source(src)
    r.became_primary()
    r.tick()
    lines = r.tick()
    assert "progress=ok" in lines[0] and len(lines) == 1
    assert parse_readiness(lines[0])["queue"]["oldest_work_age_ms"] == 3_600_000


def test_standby_never_emits_stale_or_heartbeat_even_with_old_evidence():
    clock = Clock()
    r, _ = reporter(clock=clock)
    r.set_source(lambda: snapshot(last=clock.t - 9_000_000))
    lines = r.tick()
    assert len(lines) == 1 and "role=standby progress=waiting" in lines[0]


def test_holder_to_standby_on_lock_loss():
    clock = Clock()
    r, out = reporter(clock=clock)
    r.set_source(lambda: snapshot(last=clock.t - 10, successes=(3, 3)))
    assert r.role == "standby"
    r.became_primary()
    assert r.role == "primary" and "role=primary" in out[-1]
    r.lock_lost()
    assert r.role == "standby" and "role=standby progress=waiting" in out[-1]
    seqs = [parse_readiness(line)["seq"] for line in out]
    assert seqs == sorted(seqs) == list(range(1, len(seqs) + 1))


def test_sequence_is_monotonic_across_roles():
    r, _ = reporter()
    seqs = []
    for i in range(5):
        if i == 2:
            r.became_primary()
        seqs.append(parse_readiness(r.tick()[-1 if i != 2 else 0])["seq"])
    assert seqs == sorted(set(seqs))


def test_snapshot_failure_does_not_stop_the_line():
    r, _ = reporter()

    def boom():
        raise RuntimeError("zid 7 exploded")
    r.set_source(boom)
    line = r.tick()[0]
    assert "zid" not in line and parse_readiness(line)["discovery"]["successes"] == 0


def test_error_classes_are_closed():
    import psycopg2
    assert rd.classify_error(TimeoutError()) == "timeout"
    assert rd.classify_error(psycopg2.OperationalError("x")) == "database"
    assert rd.classify_error(ValueError("secret text")) == "other"


# --------------------------------------------------------------------------- #
# Settings, interval and the alert test
# --------------------------------------------------------------------------- #
def test_settings_defaults_and_env():
    s = ReadinessSettings.from_env({})
    assert (s.interval_s, s.stale_s, s.alert_nonce, s.silence_s) == (60.0, 600.0, None, 0.0)
    s = ReadinessSettings.from_env({rd.INTERVAL_ENV: "15", rd.STALE_ENV: "120"})
    assert (s.interval_s, s.stale_s) == (15.0, 120.0)


@pytest.mark.parametrize("env", [
    {rd.INTERVAL_ENV: "0"}, {rd.INTERVAL_ENV: "nan"}, {rd.INTERVAL_ENV: "1e309"},
    {rd.INTERVAL_ENV: "abc"}, {rd.STALE_ENV: "5"}, {rd.INTERVAL_ENV: "300", rd.STALE_ENV: "400"},
    {rd.ALERT_SILENCE_ENV: "-1"},
])
def test_bad_settings_refuse(env):
    with pytest.raises(ReadinessConfigError):
        ReadinessSettings.from_env(env)


def test_bad_alert_nonce_is_ignored_not_fatal():
    assert ReadinessSettings.from_env({rd.ALERT_TEST_ENV: "Not Hex"}).alert_nonce is None


def test_interval_drives_the_thread():
    out = []
    lock = threading.Lock()

    def emit(line):
        with lock:
            out.append(line)
    r = ReadinessReporter(ReadinessSettings(interval_s=0.05, stale_s=600), Cfg(), run=RUN,
                          env={"HOSTNAME": "h"}, emit=emit)
    r.settings.interval_s = 0.05  # below the env floor, for the test only
    r.start()
    time.sleep(0.4)
    r.stop()
    with lock:
        n = len(out)
    assert 4 <= n <= 14
    assert parse_readiness(out[-1])["interval_s"] == 0


def test_alert_test_line_and_silenced_heartbeat():
    clock = Clock()
    nonce = "c0ffee" * 4
    r, out = reporter(settings=ReadinessSettings(alert_nonce=nonce, silence_s=1200), clock=clock)
    marks = {"n": 0}

    def src():
        marks["n"] += 1
        return snapshot(last=clock.t - 10, successes=(marks["n"],) * 2)
    r.set_source(src)
    test_line = r.alert_test()
    body = parse_test(test_line)
    assert body["nonce"] == nonce and body["silence_s"] == 1200 and body["run"] == RUN
    r.became_primary()
    clock.t += 60_000
    line = r.tick()[0]
    assert line.startswith("math_poller readiness_silenced/1 role=primary progress=ok ")
    assert parse_readiness(line)["_silenced"] is True
    clock.t += 1_200_000
    assert r.tick()[0].startswith("math_poller readiness/1 role=primary progress=ok ")


def test_no_alert_test_without_the_flag():
    r, out = reporter()
    assert r.alert_test() is None and out == []


# --------------------------------------------------------------------------- #
# The metric-filter phrases match exactly the lines they should
# --------------------------------------------------------------------------- #
HEARTBEAT_PHRASE = "math_poller readiness/1 role=primary progress=ok"
STALE_PHRASES = ("math_poller discovery_stale/1", "math_poller readiness_test/1")


def test_filter_phrases_select_only_the_intended_lines():
    clock = Clock()
    r, out = reporter(settings=ReadinessSettings(alert_nonce="ab" * 8), clock=clock)
    marks = {"n": 0, "last": clock.t}

    def src():
        marks["n"] += 1
        return snapshot(last=marks["last"], successes=(marks["n"],) * 2)
    r.set_source(src)
    r.alert_test()
    r.tick()                      # standby
    r.became_primary()            # ok
    clock.t += 700_000            # stale
    r.tick()
    heartbeat = [x for x in out if HEARTBEAT_PHRASE in x]
    stale = [x for x in out if any(p in x for p in STALE_PHRASES)]
    assert len(heartbeat) == 1 and "progress=ok" in heartbeat[0]
    assert len(stale) == 2  # the test line and one stale line
    # The phrases the CDK filters use are these literal strings.
    import pathlib
    cdk = pathlib.Path(__file__).resolve().parents[3] / "cdk" / "mathPollerAlarms.ts"
    if cdk.exists():
        text = cdk.read_text()
        assert HEARTBEAT_PHRASE in text and all(p in text for p in STALE_PHRASES)


# --------------------------------------------------------------------------- #
# The worker pool's queue ages
# --------------------------------------------------------------------------- #
def test_pool_queue_stats_age_live_and_backfill_separately():
    gate = threading.Event()
    started = threading.Event()

    def process(zid, batch):
        started.set()
        gate.wait(5)
    pool = ConversationWorkerPool(process, max_workers=1)
    now = {"t": 100.0}
    pool._clock = lambda: now["t"]
    try:
        assert pool.queue_stats()["oldest_work_age_ms"] == 0
        pool.submit(1, VOTES, [{"x": 1}])
        assert started.wait(5)
        now["t"] = 105.0
        pool.submit(2, BACKFILL, [])  # waits behind zid 1 (one worker)
        now["t"] = 130.0
        st = pool.queue_stats()
        assert st["in_flight"] == 1 and st["pending"] == 2
        assert st["oldest_live_age_ms"] == 30_000 and st["oldest_backfill_age_ms"] == 25_000
        assert st["oldest_work_age_ms"] == 30_000 and st["parked"] == 0
    finally:
        gate.set()
        assert pool.join(5)
        pool.shutdown()
    st = pool.queue_stats()
    assert st["pending"] == 0 and st["in_flight"] == 0 and st["oldest_live_age_ms"] is None


def test_parking_keeps_unresolved_live_age():
    """P-072 review R2: parking drops the queued messages, not the age of the
    unresolved live work; a zid that succeeded leaves no age behind."""
    gate = threading.Event()
    now = {"t": 0.0}
    pool = ConversationWorkerPool(lambda z, b: gate.wait(5), max_workers=1)
    pool._clock = lambda: now["t"]
    try:
        pool.submit(1, VOTES, [1])
        pool.submit(2, VOTES, [2])
        pool.park(2)
        assert pool.queue_stats()["parked"] == 1
    finally:
        gate.set()
        pool.join(5)
    now["t"] = 3600.0
    st = pool.queue_stats()
    assert st["parked"] == 1 and st["pending"] == 0 and st["in_flight"] == 0
    assert st["oldest_live_age_ms"] == 3_600_000 == st["oldest_work_age_ms"]
    pool.shutdown()


class _FailingThenOk:
    """A process function that fails (the service's retry path returns False,
    its park path parks) until told to succeed."""

    def __init__(self, pool_ref, mode="retry"):
        self.pool_ref = pool_ref
        self.mode = mode
        self.ok = False
        self.calls = 0

    def __call__(self, zid, batch):
        self.calls += 1
        if self.ok:
            return True
        if self.mode == "park":
            self.pool_ref[0].park(zid)
            return None
        return False


def _pool_with(fn_factory, clock):
    ref = [None]
    fn = fn_factory(ref)
    pool = ConversationWorkerPool(fn, max_workers=1)
    pool._clock = lambda: clock["t"]
    ref[0] = pool
    return pool, fn


def _progress_of(pool, clock, reporter_state):
    """One readiness tick over this pool with healthy discovery."""
    r, marks = reporter_state
    marks[0] += 1
    snap = snapshot(last=T0 + int(clock["t"] * 1000) - 10, successes=(marks[0], marks[0]))
    snap["queue"] = pool.queue_stats()
    r.set_source(lambda: snap)
    return parse_readiness(r.tick()[0])


@pytest.mark.parametrize("mode", ["retry", "park"])
def test_repeated_unsuccessful_recovery_goes_stuck_with_healthy_polling(mode):
    """Twelve failed recovery cycles over an hour while discovery succeeds
    every time: the live work stays unresolved from its first arrival, so
    the holder reports stuck (not ok) once it passes the bound."""
    clock = {"t": 0.0}
    pool, fn = _pool_with(lambda ref: _FailingThenOk(ref, mode), clock)
    rclock = Clock()
    r, _ = reporter(clock=rclock)
    r.became_primary()
    state = (r, [0])
    progress = []
    try:
        for i in range(12):
            clock["t"] = i * 300.0
            rclock.t = T0 + int(clock["t"] * 1000)
            pool.unpark(1)  # the reconciler / a new batch unparks and resubmits
            assert pool.submit(1, VOTES, [{"created": i}])
            assert pool.join(5)
            body = _progress_of(pool, clock, state)
            progress.append(body["progress"])
            assert body["queue"]["oldest_live_age_ms"] == int(clock["t"] * 1000)
        assert progress[:3] == ["ok", "ok", "ok"]  # 0, 300 and 600 s: inside the bound
        assert set(progress[3:]) == {"stuck"}, progress
        # Recovery succeeds: the condition clears.
        fn.ok = True
        clock["t"] += 300.0
        rclock.t = T0 + int(clock["t"] * 1000)
        pool.unpark(1)
        assert pool.submit(1, VOTES, [{"created": 99}])
        assert pool.join(5)
        body = _progress_of(pool, clock, state)
        assert body["queue"]["oldest_live_age_ms"] is None and body["progress"] == "ok"
    finally:
        pool.shutdown()


def test_stalled_reconciler_keeps_parked_work_ageing():
    """A parked zid nobody retries (the reconciler stalled) ages with the
    clock and turns the holder stuck, while discovery stays healthy."""
    clock = {"t": 0.0}
    pool, _ = _pool_with(lambda ref: _FailingThenOk(ref, "park"), clock)
    rclock = Clock()
    r, _ = reporter(clock=rclock)
    r.became_primary()
    try:
        assert pool.submit(1, VOTES, [{"created": 1}])
        assert pool.join(5)
        assert pool.is_parked(1)
        for t, want in ((300.0, "ok"), (601.0, "stuck"), (3600.0, "stuck")):
            clock["t"] = t
            rclock.t = T0 + int(t * 1000)
            body = _progress_of(pool, clock, (r, [int(t)]))
            assert body["progress"] == want and body["queue"]["parked"] == 1
    finally:
        pool.shutdown()


def test_live_work_arriving_during_a_successful_run_ages_from_its_own_arrival():
    gate, started = threading.Event(), threading.Event()
    clock = {"t": 0.0}

    def process(zid, batch):
        started.set()
        gate.wait(5)
    pool = ConversationWorkerPool(process, max_workers=1)
    pool._clock = lambda: clock["t"]
    try:
        pool.submit(1, VOTES, [1])
        assert started.wait(5)
        clock["t"] = 50.0
        pool.submit(1, VOTES, [2])  # arrives mid-run
        gate.set()
        assert pool.join(5)
        assert pool.queue_stats()["oldest_live_age_ms"] is None
    finally:
        pool.shutdown()


def test_idle_and_long_backfill_stay_distinct_from_stuck_live_work():
    """Healthy idle discovery is ok; a long backfill job is not live work."""
    gate, started = threading.Event(), threading.Event()
    clock = {"t": 0.0}

    def process(zid, batch):
        started.set()
        gate.wait(5)
    pool = ConversationWorkerPool(process, max_workers=1)
    pool._clock = lambda: clock["t"]
    rclock = Clock()
    r, _ = reporter(clock=rclock)
    r.became_primary()
    try:
        assert _progress_of(pool, clock, (r, [1]))["progress"] == "ok"  # idle
        pool.submit(9, BACKFILL, [])
        assert started.wait(5)
        clock["t"] = 3600.0
        rclock.t = T0 + 3_600_000
        body = _progress_of(pool, clock, (r, [2]))
        assert body["queue"]["oldest_backfill_age_ms"] == 3_600_000
        assert body["queue"]["oldest_live_age_ms"] is None and body["progress"] == "ok"
    finally:
        gate.set()
        pool.join(5)
        pool.shutdown()


def test_explicit_disposition_clears_unresolved_age():
    clock = {"t": 0.0}
    pool, _ = _pool_with(lambda ref: _FailingThenOk(ref, "park"), clock)
    try:
        pool.submit(1, VOTES, [1])
        assert pool.join(5)
        clock["t"] = 1000.0
        assert pool.queue_stats()["oldest_live_age_ms"] == 1_000_000
        pool.dispose_unresolved(1)
        assert pool.queue_stats()["oldest_live_age_ms"] is None
    finally:
        pool.shutdown()


def test_an_exception_in_the_process_function_keeps_the_age():
    clock = {"t": 0.0}

    def boom(zid, batch):
        raise RuntimeError("x")
    pool = ConversationWorkerPool(boom, max_workers=1)
    pool._clock = lambda: clock["t"]
    try:
        pool.submit(1, VOTES, [1])
        assert pool.join(5)
        clock["t"] = 10.0
        assert pool.queue_stats()["oldest_live_age_ms"] == 10_000
    finally:
        pool.shutdown()


# --------------------------------------------------------------------------- #
# The lock-loss line never blocks (P-072 review R1)
# --------------------------------------------------------------------------- #
def test_lock_lost_never_calls_the_snapshot_source():
    clock = Clock()
    r, out = reporter(clock=clock)
    calls = []
    r.set_source(lambda: calls.append(1) or snapshot(last=clock.t - 10, successes=(3, 3)))
    r.became_primary()
    n = len(calls)
    line = r.lock_lost()
    assert len(calls) == n, "lock_lost must not take a fresh snapshot"
    assert line == out[-1] and "role=standby progress=waiting" in line
    assert parse_readiness(line)["discovery"]["successes"] == 3  # the last snapshot


def test_lock_lost_returns_at_once_while_a_tick_holds_the_reporter_lock():
    clock = Clock()
    r, out = reporter(clock=clock)
    entered, release = threading.Event(), threading.Event()

    def blocked():
        entered.set()
        release.wait(10)
        return snapshot(last=clock.t, successes=(1, 1))
    r.set_source(blocked)
    t = threading.Thread(target=r.tick, daemon=True)
    t.start()
    assert entered.wait(5)
    started = time.monotonic()
    assert r.lock_lost() is None  # the line is dropped, not waited for
    assert time.monotonic() - started < 0.05
    assert r.role == "standby"
    release.set()
    t.join(5)
