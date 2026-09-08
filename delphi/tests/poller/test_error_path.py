"""Error handling per design §3: on a failing conv update, dump conv+batch to an
errorconv JSON, retry once, then park the zid (circuit breaker).

Mirrors Clojure handle-errors (conv_man.clj:291-323): conv-update-dump + requeue
to the retry-chan.  Our retry_cap=1 caps replays before parking.
"""

import json

from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import CoalescedBatch
from unittest.mock import MagicMock


class FakePool:
    """A synchronous stand-in for ConversationWorkerPool that OWNS parked truth
    the same way the real pool does (P-022 R04), so ``service._parked`` — now a
    read-through view of the pool — reflects reality. It records submit/park/
    unpark calls for assertions without spawning worker threads (these tests
    drive ``_handle_zid`` / ``_poll_votes_once`` directly)."""

    def __init__(self):
        self._parked = set()
        self.submitted = []
        self.park_calls = []
        self.unpark_calls = []

    def submit(self, zid, message_type, batch):
        if zid in self._parked:
            return
        self.submitted.append((zid, message_type, batch))

    def park(self, zid):
        self.park_calls.append(zid)
        self._parked.add(zid)

    def unpark(self, zid):
        self.unpark_calls.append(zid)
        self._parked.discard(zid)

    def is_parked(self, zid):
        return zid in self._parked

    def parked_zids(self):
        return set(self._parked)


def _service(tmp_path, retry_cap=1):
    pg = MagicMock()
    cfg = PollerConfig(dump_dir=str(tmp_path), retry_cap=retry_cap)
    svc = MathPollerService(pg, cfg)
    svc._pool = FakePool()  # capture requeue / park without real threads
    return svc


def _dumps(tmp_path, zid):
    return sorted(tmp_path.glob(f"errorconv-zid{zid}-*.json"))


class TestErrorPath:
    def test_first_failure_dumps_and_retries(self, tmp_path, monkeypatch):
        svc = _service(tmp_path)
        monkeypatch.setattr(
            svc, "_run_engine",
            lambda zid, c: (_ for _ in ()).throw(RuntimeError("kaboom")),
        )
        batch = CoalescedBatch(votes=[{"pid": "1", "tid": "1", "vote": 1}], moderation=[])

        svc._handle_zid(5, batch)

        dumps = _dumps(tmp_path, 5)
        assert len(dumps) == 1, "a dump file must be written on failure"
        # dump contains the batch + error + traceback
        payload = json.loads(dumps[0].read_text())
        assert payload["zid"] == 5
        assert "kaboom" in payload["error"]
        assert payload["batch"]["votes"] == [{"pid": "1", "tid": "1", "vote": 1}]
        # retry: batch requeued, zid NOT parked yet
        assert svc._pool.submitted, "the batch must be requeued on the first failure"
        assert 5 not in svc._parked
        assert svc._pool.park_calls == []

    def test_second_failure_parks_zid(self, tmp_path, monkeypatch):
        svc = _service(tmp_path)
        monkeypatch.setattr(
            svc, "_run_engine",
            lambda zid, c: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        batch = CoalescedBatch(votes=[{"pid": "1"}], moderation=[])

        svc._handle_zid(5, batch)  # attempt 1 -> retry
        svc._handle_zid(5, batch)  # attempt 2 -> park (exceeds retry_cap=1)

        assert 5 in svc._parked
        assert svc._pool.park_calls == [5]
        assert len(_dumps(tmp_path, 5)) == 2  # dumped on each failure

    def test_parked_zid_is_skipped(self, tmp_path, monkeypatch):
        svc = _service(tmp_path)
        monkeypatch.setattr(
            svc, "_run_engine",
            lambda zid, c: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        batch = CoalescedBatch(votes=[{"pid": "1"}], moderation=[])
        svc._handle_zid(5, batch)
        svc._handle_zid(5, batch)  # now parked (2 dumps)
        svc._handle_zid(5, batch)  # skipped: no engine call, no new dump
        assert len(_dumps(tmp_path, 5)) == 2

    def test_success_clears_retry_counter(self, tmp_path, monkeypatch):
        svc = _service(tmp_path)
        calls = {"n": 0}

        def flaky(zid, c):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("transient")
            # succeeds on retry

        monkeypatch.setattr(svc, "_run_engine", flaky)
        batch = CoalescedBatch(votes=[{"pid": "1"}], moderation=[])
        svc._handle_zid(7, batch)  # fail -> retry
        svc._handle_zid(7, batch)  # success -> counter cleared
        assert 7 not in svc._parked
        assert svc._retry_counts.get(7) is None

    def test_new_batch_unparks_a_parked_zid(self, tmp_path, monkeypatch):
        """T8: a parked zid self-heals when a NEW batch arrives on the next poll
        cycle (Clojure retry-chan equivalent) — a transient blip must not leave
        the zid dead until process restart."""
        svc = _service(tmp_path)
        monkeypatch.setattr(
            svc, "_run_engine",
            lambda zid, c: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        batch = CoalescedBatch(votes=[{"pid": "1"}], moderation=[])
        svc._handle_zid(5, batch)  # attempt 1 -> retry
        svc._handle_zid(5, batch)  # attempt 2 -> park
        assert 5 in svc._parked

        # A new poll cycle delivers a fresh batch for zid 5.
        svc._pg.poll_votes_since.return_value = [{"zid": 5, "created": 100}]
        svc._vote_wm = 0
        svc._poll_votes_once()

        assert 5 not in svc._parked
        assert svc._retry_counts.get(5) is None
        assert svc._pool.unpark_calls == [5]
        assert svc._pool.submitted[-1] == (5, "votes", [{"zid": 5, "created": 100}])


def test_pool_unpark_reenables_dispatch():
    """T8: ConversationWorkerPool.unpark re-enables dispatch for a parked zid."""
    from polismath.poller.worker_pool import ConversationWorkerPool, VOTES

    seen = []
    pool = ConversationWorkerPool(lambda z, c: seen.append(z), max_workers=1)
    try:
        pool.park(5)
        pool.submit(5, VOTES, [1])          # dropped while parked
        assert pool.join(timeout=2)
        assert seen == []
        pool.unpark(5)
        assert not pool.is_parked(5)
        pool.submit(5, VOTES, [1])          # now dispatched
        assert pool.join(timeout=2)
        assert seen == [5]
    finally:
        pool.shutdown()
