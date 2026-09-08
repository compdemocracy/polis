"""Deterministic R06 schedules; no Postgres or timing-based race assumptions."""

import threading
from collections import OrderedDict
from unittest.mock import MagicMock

import pytest

from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import CoalescedBatch


@pytest.mark.parametrize("cap", [1, 2])
def test_eviction_between_lookup_and_touch_does_not_park(cap, tmp_path):
    svc = MathPollerService(
        MagicMock(),
        PollerConfig(conv_cache_cap=cap, retry_cap=0, dump_dir=str(tmp_path)),
    )
    svc._ensure_runtime()
    conv = MagicMock()
    svc._remember(1, conv)
    for zid in range(2, cap + 1):
        svc._remember(zid, object())

    lookup = threading.Barrier(2, timeout=5)
    release_touch = threading.Event()
    eviction_attempted = threading.Event()
    eviction_finished = threading.Event()
    errors = []

    class ObservedLock:
        """Signal actual lock contention, not merely a thread being started."""

        def __init__(self, lock):
            self.lock = lock

        def __enter__(self):
            if not self.lock.acquire(blocking=False):
                eviction_attempted.set()
                assert self.lock.acquire(timeout=5), "cache lock never released"

        def __exit__(self, *exc):
            self.lock.release()

    class LatchedCache(OrderedDict):
        def get(self, key, default=None):
            value = super().get(key, default)
            if key == 1 and value is not None:
                lookup.wait()
                assert release_touch.wait(5), "lookup was not released"
            return value

        def popitem(self, last=True):
            item = super().popitem(last=last)
            # Also release the test driver on the broken, unlocked code. It
            # will resume the lookup after eviction and expose the KeyError.
            eviction_attempted.set()
            return item

    svc._convs_lock = ObservedLock(
        getattr(svc, "_convs_lock", threading.Lock())
    )
    svc._convs = LatchedCache(svc._convs)
    svc._on_engine_error = MagicMock(wraps=svc._on_engine_error)
    svc._writer = MagicMock()

    def recompute():
        # Eviction must proceed while the engine holds a local conversation:
        # a lock spanning computation would deadlock this schedule.
        assert eviction_finished.wait(5), "eviction blocked by engine work"
        with svc._convs_lock:
            assert 1 not in svc._convs
        return conv

    conv.recompute.side_effect = recompute

    def evict():
        # After the touch, evict every old entry, including the active zid.
        for zid in range(cap + 1, 2 * cap + 1):
            svc._remember(zid, object())
        eviction_finished.set()

    def run(fn):
        try:
            fn()
        except BaseException as exc:
            errors.append(exc)

    worker = threading.Thread(
        target=run, args=(lambda: svc._handle_zid(1, CoalescedBatch()),),
        daemon=True,
    )
    evictor = threading.Thread(target=run, args=(evict,), daemon=True)
    worker.start()
    try:
        lookup.wait()  # The value has been read; move_to_end has not run.
        evictor.start()
        assert eviction_attempted.wait(5), "evictor never reached the cache"
    finally:
        release_touch.set()
        worker.join(timeout=10)
        if evictor.ident is not None:
            evictor.join(timeout=10)
        svc.stop()

    assert not worker.is_alive() and not evictor.is_alive()
    assert errors == []
    svc._on_engine_error.assert_not_called()
    assert svc._parked == set()
    conv.recompute.assert_called_once_with()
    svc._writer.write_conv_updates.assert_called_once_with(1, conv)
    assert svc._convs[1] is conv  # The evicted in-flight result was published.
    assert list(svc._convs)[-1] == 1
    assert len(svc._convs) == cap
    assert list(tmp_path.iterdir()) == []
