"""R10: observable cycle failure, paced daemon recovery, and zid isolation."""

import logging
import threading
from unittest.mock import MagicMock, call

import pytest

from polismath.poller.service import (
    MathPollerService,
    PollerConfig,
    PoolDrainTimeout,
)
from polismath.poller.worker_pool import VOTES
from scripts import math_poller


def _service(**kwargs):
    pg = MagicMock()
    pg.poll_votes_since.return_value = []
    pg.poll_moderation_since.return_value = []
    return MathPollerService(pg, PollerConfig(**kwargs))


def test_pool_drain_timeout_is_a_specific_timeout_type():
    # The builtin TimeoutError is an OSError, so `except TimeoutError` around
    # poll_once would also swallow socket/DB timeouts. The subclass keeps every
    # existing handler matching while staying separately catchable.
    assert issubclass(PoolDrainTimeout, TimeoutError)
    assert not isinstance(TimeoutError("a socket timeout"), PoolDrainTimeout)


@pytest.mark.parametrize("drained", [True, False])
def test_once_cli_only_returns_success_after_pool_drains(
    monkeypatch, caplog, drained
):
    svc = _service()
    svc._pool = MagicMock()
    svc._pool.parked_zids.return_value = set()
    svc._pool.join.return_value = drained
    monkeypatch.setattr(math_poller, "_build_service", lambda config: svc)

    def errors():
        return [
            r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR
        ]

    if drained:
        assert math_poller.main(["--once"]) == 0
        assert errors() == []
    else:
        # A cycle that never drained is a CLI failure, just like a failed
        # SELECT; it must never return zero. It is reported through the
        # configured logger rather than as a bare excepthook traceback.
        assert math_poller.main(["--once"]) == 1
        assert errors() == [
            "Single poll cycle did not complete: Poll cycle worker pool did "
            "not drain within 120 seconds"
        ]
    assert svc._pool.join.call_args_list[0] == call(timeout=120.0)
    # Either way the pool is shut down inside main(), not left to the
    # concurrent.futures interpreter-exit hook.
    svc._pool.shutdown.assert_called_once_with(wait=True)


@pytest.mark.parametrize(
    "loop,cycle,interval,log_message,wait_first",
    [
        ("_vote_loop", "_poll_votes_once", "vote_interval_ms",
         "Vote poll cycle failed", False),
        ("_mod_loop", "_poll_moderation_once", "mod_interval_ms",
         "Moderation poll cycle failed", False),
        ("_reconcile_loop", "_reconcile_once", "reconcile_interval_ms",
         "Reconcile cycle failed", True),
    ],
)
def test_daemon_logs_failure_waits_and_runs_next_cycle(
    monkeypatch, caplog, loop, cycle, interval, log_message, wait_first
):
    svc = _service(**{interval: 137})
    events = []
    attempts = 0

    def poll():
        nonlocal attempts
        attempts += 1
        events.append("poll")
        if attempts == 1:
            raise TimeoutError("injected poll timeout")
        svc._stop.set()

    def wait(seconds):
        assert seconds == 0.137
        events.append("wait")
        return svc._stop.is_set()

    monkeypatch.setattr(svc, cycle, poll)
    monkeypatch.setattr(svc._stop, "wait", wait)
    getattr(svc, loop)()

    assert attempts == 2
    assert events == (["wait", "poll", "wait", "poll"] if wait_first else
                      ["poll", "wait", "poll", "wait"])
    assert [r.message for r in caplog.records] == [log_message]
    assert caplog.records[0].exc_info[0] is TimeoutError


def test_stalled_zid_does_not_block_healthy_zid_or_hide_timeout(monkeypatch):
    svc = _service(worker_pool_size=2)
    stalled = threading.Event()
    release = threading.Event()
    healthy = threading.Event()

    def process(zid, batch):
        if zid == 1:
            stalled.set()
            assert release.wait(10), "test did not release stalled worker"
        else:
            healthy.set()

    monkeypatch.setattr(svc, "_run_engine", process)
    svc._ensure_runtime()
    real_join = svc._pool.join

    def short_join(timeout):
        assert stalled.wait(5), "worker never reached the stall"
        return real_join(timeout=0.01)

    monkeypatch.setattr(svc._pool, "join", short_join)
    svc._pg.poll_votes_since.return_value = [
        {"zid": 1, "created": 1}, {"zid": 2, "created": 2}
    ]
    try:
        with pytest.raises(PoolDrainTimeout, match="worker pool did not drain"):
            svc.poll_once()
        assert healthy.wait(5), "healthy zid starved behind stalled zid"
        assert not release.is_set()
        release.set()
        assert real_join(timeout=5)
        monkeypatch.setattr(svc._pool, "join", real_join)
        svc._pg.poll_votes_since.return_value = []
        assert svc.poll_once() is None
    finally:
        release.set()
        svc._pool.shutdown(wait=True)


def test_poison_zid_has_bounded_retries_and_healthy_progress_with_one_worker(
    monkeypatch, tmp_path
):
    svc = _service(worker_pool_size=1, retry_cap=1, dump_dir=str(tmp_path))
    attempts = []
    completed = []

    def process(zid, batch):
        if zid == 1:
            attempts.append(zid)
            raise ValueError("poison zid")
        completed.extend((zid, row["cycle"]) for row in batch.votes)

    monkeypatch.setattr(svc, "_run_engine", process)
    svc._ensure_runtime()
    try:
        for cycle in range(3):
            # Enqueue poison first even with only one executor slot. The
            # circuit breaker must release that slot after its retry budget.
            svc._unpark(1)
            for zid in (1, 2, 3):
                svc._pool.submit(zid, VOTES, [{"cycle": cycle}])
            assert svc._pool.join(timeout=5)
            assert svc._parked == {1}
            assert len(attempts) == 2 * (cycle + 1)
            assert completed == [
                (zid, n) for n in range(cycle + 1) for zid in (2, 3)
            ]
    finally:
        svc._pool.shutdown(wait=True)
