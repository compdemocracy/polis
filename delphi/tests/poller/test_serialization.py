"""Thread-safety: strict per-zid serialization + bounded cross-zid concurrency.

Verifies the ConversationWorkerPool guarantee that mirrors Clojure's one-go-loop-
per-conv model: two batches for the SAME zid are never processed concurrently,
while DIFFERENT zids may run in parallel up to max_workers.
"""

import threading
import time

from polismath.poller.worker_pool import ConversationWorkerPool


class TestPerZidSerialization:
    def test_same_zid_batches_never_interleave(self):
        active = 0
        max_concurrent = 0
        call_count = 0
        lock = threading.Lock()

        def process(zid, coalesced):
            nonlocal active, max_concurrent, call_count
            with lock:
                active += 1
                call_count += 1
                max_concurrent = max(max_concurrent, active)
            time.sleep(0.03)
            with lock:
                active -= 1

        pool = ConversationWorkerPool(process, max_workers=4)
        # Submit in waves with a small gap so some batches arrive WHILE the zid
        # is being processed -> forces >1 sequential process cycle for zid 7.
        for i in range(6):
            pool.submit(7, "votes", [{"i": i}])
            time.sleep(0.015)

        assert pool.join(timeout=10) is True
        pool.shutdown()

        assert call_count >= 2, "expected multiple sequential cycles for the zid"
        assert max_concurrent == 1, "same zid must never run on two workers at once"

    def test_different_zids_run_concurrently(self):
        # A 2-party barrier only clears if two zids are processed at the same
        # time; if the pool serialized across zids it would time out (broken).
        barrier = threading.Barrier(2)
        broken = []

        def process(zid, coalesced):
            try:
                barrier.wait(timeout=5)
            except threading.BrokenBarrierError as e:  # pragma: no cover
                broken.append(e)

        pool = ConversationWorkerPool(process, max_workers=2)
        pool.submit(1, "votes", [{}])
        pool.submit(2, "votes", [{}])

        assert pool.join(timeout=10) is True
        pool.shutdown()
        assert not broken, "distinct zids should be able to run concurrently"


class TestParking:
    def test_parked_zid_is_not_processed(self):
        seen = []

        def process(zid, coalesced):
            seen.append(zid)

        pool = ConversationWorkerPool(process, max_workers=2)
        pool.park(9)
        pool.submit(9, "votes", [{}])
        assert pool.join(timeout=5) is True
        pool.shutdown()
        assert 9 not in seen
        assert pool.is_parked(9) is True
