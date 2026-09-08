"""M1 & M2 (P-019): poller recovery orchestration.

These drive the REAL ``MathPollerService`` and REAL ``ConversationWorkerPool``
(threads, coalescing, retry, park) with a lightweight fake Conversation and fake
Postgres/writer, asserting FINAL VOTE CONTENTS — not merely that a dispatch
happened. They cover:

* M1 — a vote that fails and parks its zid is recovered from authoritative
  history both (a) when a later batch arrives (unpark self-heal) and (b) when NO
  later batch arrives (periodic reconciler).
* M2 — a newer revote queued while an older write is failing wins by timestamp;
  and the write-before-cache ordering never double-applies a retried batch.
"""

import copy

import pytest

from polismath.poller import service as service_module
from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import VOTES


class FakeConv:
    """Mirrors the FIXED Conversation semantics: created-timestamp wins on
    duplicate (pid, tid); update_* return copies; recompute can be made to fail a
    configurable number of times to inject compute failures."""

    def __init__(self, conversation_id=None, last_updated=None, values=None):
        self.conversation_id = conversation_id
        self.last_updated = last_updated if last_updated is not None else 0
        self.values = dict(values or {})
        # (pid, tid) -> created, so a later apply can honour created-order wins.
        self._created = {}
        self.apply_log = []

    def update_votes(self, payload, recompute=False):
        result = copy.deepcopy(self)
        result.apply_log = self.apply_log + [tuple(
            (v["pid"], v["tid"], v["vote"], v.get("created", 0)) for v in payload["votes"]
        )]
        for v in payload["votes"]:
            key = (v["pid"], v["tid"])
            created = v.get("created", 0)
            # created-order wins (stable: equal-created keeps later payload row).
            if created >= result._created.get(key, float("-inf")):
                result.values[key] = v["vote"]
                result._created[key] = created
        result.last_updated = max(self.last_updated, payload.get("lastVoteTimestamp", 0))
        return result

    def update_moderation(self, mods, recompute=False):
        return copy.deepcopy(self)

    def recompute(self):
        if type(self).failures_remaining > 0:
            type(self).failures_remaining -= 1
            raise RuntimeError("injected compute failure")
        return self

    failures_remaining = 0


class FakePg:
    """Authoritative vote store. ``poll_votes`` returns FULL history (what the
    server persisted), which is how recovery re-reads the lost interval; the
    watermark only gates ``poll_votes_since``."""

    def __init__(self, votes=None):
        self.votes = list(votes or [])

    def poll_votes_since(self, ts):
        return [v for v in self.votes if v["created"] > ts]

    def poll_moderation_since(self, ts):
        return []

    def poll_votes(self, zid, since):
        return sorted(
            (v for v in self.votes if v["zid"] == zid), key=lambda v: v["created"]
        )

    def poll_moderation(self, zid, since):
        return []

    def load_math_main(self, zid):
        return None


class FakeWriter:
    def __init__(self, pg=None):
        self.writes = []
        self.before_write = None

    def write_conv_updates(self, zid, conv):
        if self.before_write is not None:
            cb, self.before_write = self.before_write, None
            cb()  # may raise to inject a write failure
        self.writes.append(copy.deepcopy(conv))


def _vote(zid, pid, tid, value, created):
    return {"zid": zid, "pid": pid, "tid": tid, "vote": value, "created": created}


@pytest.fixture
def svc(monkeypatch):
    monkeypatch.setattr(service_module, "Conversation", FakeConv)
    FakeConv.failures_remaining = 0
    pg = FakePg()
    s = MathPollerService(pg, PollerConfig(worker_pool_size=1, retry_cap=1))
    s._writer = FakeWriter()
    s._ensure_runtime()
    yield s
    s._pool.shutdown()


def _drain(s):
    assert s._pool.join(timeout=5), "worker pool did not drain in time"


class TestM1ParkRecovery:
    def test_failed_vote_recovered_after_unpark(self, svc):
        """cached conv → vote A fails twice → parked → vote B arrives → unpark:
        FINAL persisted state must contain vote A (not just B)."""
        pg = svc._pg
        pg.votes = [_vote(1, 0, 0, 1, 5), _vote(1, 1, 1, 1, 10)]  # baseline + A
        svc._convs[1] = FakeConv(1, last_updated=5, values={(0, 0): 1})
        svc._convs[1]._created[(0, 0)] = 5
        svc._vote_wm = 9  # so A@10 is polled, baseline@5 already applied

        FakeConv.failures_remaining = 2  # A fails both attempts -> park
        svc._poll_votes_once()
        _drain(svc)
        assert 1 in svc._parked and svc._vote_wm == 10

        pg.votes.append(_vote(1, 2, 2, -1, 20))  # vote B
        svc._poll_votes_once()
        _drain(svc)

        final = svc._writer.writes[-1]
        assert 1 not in svc._parked and svc._vote_wm == 20
        assert (1, 1) in final.values, "vote A must be recovered from history"
        assert (2, 2) in final.values, "vote B must be present"
        assert final.values[(1, 1)] == 1

    def test_reconciler_recovers_parked_zid_with_no_new_vote(self, svc):
        """parked zid, NO subsequent vote, reconciler runs → recovered."""
        pg = svc._pg
        pg.votes = [_vote(1, 0, 0, 1, 5), _vote(1, 1, 1, 1, 10)]
        svc._convs[1] = FakeConv(1, last_updated=5, values={(0, 0): 1})
        svc._convs[1]._created[(0, 0)] = 5
        svc._vote_wm = 9

        FakeConv.failures_remaining = 2
        svc._poll_votes_once()
        _drain(svc)
        assert 1 in svc._parked

        # No new votes arrive; the reconciler must still recover the interval.
        svc._reconcile_once()
        _drain(svc)

        final = svc._writer.writes[-1]
        assert 1 not in svc._parked
        assert (1, 1) in final.values, "vote A recovered by the reconciler"


class TestM2RetryOrder:
    def test_newer_revote_wins_when_older_write_fails(self, svc):
        """old +1@10 fails at write; newer −1@20 queued during the failure; final
        persisted vote is −1 with timestamp 20."""
        older = _vote(1, 1, 1, 1, 10)
        newer = _vote(1, 1, 1, -1, 20)
        svc._convs[1] = FakeConv(1, last_updated=0)

        def fail_after_newer_queued():
            svc._pool.submit(1, VOTES, [newer])  # newer arrives mid-write
            raise RuntimeError("injected transient write failure")

        svc._writer.before_write = fail_after_newer_queued
        svc._pool.submit(1, VOTES, [older])
        _drain(svc)

        final = svc._writer.writes[-1]
        assert final.values[(1, 1)] == -1, "newer revote must win"
        assert final.last_updated == 20

    def test_write_before_cache_does_not_double_apply(self, svc):
        """A write that fails once then succeeds must apply the batch exactly ONCE
        — the retry re-derives from the last-good (pre-batch) cached conv, not
        from an already-updated one cached before the failed write."""
        svc._convs[1] = FakeConv(1, last_updated=0)
        batch = [_vote(1, 1, 1, 1, 10)]

        def fail_once():
            raise RuntimeError("transient write failure")

        svc._writer.before_write = fail_once
        svc._pool.submit(1, VOTES, batch)
        _drain(svc)

        final = svc._writer.writes[-1]
        assert final.values[(1, 1)] == 1
        assert final.last_updated == 10
        assert len(final.apply_log) == 1, "batch must be applied exactly once"
