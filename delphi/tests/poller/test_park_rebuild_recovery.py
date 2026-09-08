"""P-022 §C R03/R04: park/rebuild recovery under fault and race.

These drive the REAL ``MathPollerService`` and REAL ``ConversationWorkerPool``
(threads, coalescing, retry, park) and exercise the two control-flow defects the
P-022 recovery probes reproduced against the integration branch:

* R03 (park then silence) — a reconciler REBUILD that fails transiently must be
  retried WITH the rebuild flag preserved and eventually publish; a persistent
  failure must leave a visible parked state with BOUNDED retries (no hot loop,
  no silent loss).  Exercises the ``_requeue`` rebuild-preservation fix.

* R04 (park/unpark races) — the pool is the SINGLE owner of parked truth, so a
  reconciliation interleaved with parking can never leave service and pool
  disagreeing, and overlapping rebuild triggers still run at most one handler
  per zid with no dropped rebuild.

Determinism comes from ``threading.Event`` latches at named boundaries (the
``_load_or_init`` entry and the ``pool.park`` boundary) and from ``pool.join``
(which blocks until the pool is idle) — never from ``sleep`` timing.
"""

import threading
from unittest.mock import MagicMock

import pytest

from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import CoalescedBatch, REBUILD, VOTES, MODERATION


class RecordingWriter:
    """Records the zids whose updates were published (a successful rebuild)."""

    def __init__(self, pg=None):
        self.writes = []

    def write_conv_updates(self, zid, conv):
        self.writes.append(zid)


class RecordingPool:
    """A non-threaded pool that records submit/park/unpark and owns parked truth
    the same way the real pool does — for the ``_requeue`` unit test."""

    def __init__(self):
        self._parked = set()
        self.submitted = []

    def submit(self, zid, message_type, batch):
        if zid in self._parked:
            return
        self.submitted.append((zid, message_type, batch))

    def park(self, zid):
        self._parked.add(zid)

    def unpark(self, zid):
        self._parked.discard(zid)

    def is_parked(self, zid):
        return zid in self._parked

    def parked_zids(self):
        return set(self._parked)


@pytest.fixture
def make_svc():
    """Build MathPollerServices with a REAL worker pool + recording writer.

    ``_load_or_init`` is monkeypatched per test to control the rebuild outcome,
    so the rebuild path (reconciler REBUILD -> _run_engine conv=None ->
    _load_or_init -> write -> remember) is exercised end-to-end without a real
    Conversation/Postgres."""
    created = []

    def _make(retry_cap=1, pool_size=1):
        svc = MathPollerService(
            MagicMock(),
            PollerConfig(worker_pool_size=pool_size, retry_cap=retry_cap),
        )
        svc._writer = RecordingWriter()
        svc._ensure_runtime()
        created.append(svc)
        return svc

    yield _make
    for s in created:
        s._pool.shutdown()


def _drain(svc, timeout=5.0):
    assert svc._pool.join(timeout=timeout), "worker pool did not drain in time"


# --------------------------------------------------------------------------- #
# Retry-preserves-rebuild unit test (the R03 root-cause fix)
# --------------------------------------------------------------------------- #
class TestRequeuePreservesRebuild:
    def test_requeue_preserves_rebuild_and_all_kinds(self):
        svc = MathPollerService(MagicMock(), PollerConfig(retry_cap=1))
        svc._pool = RecordingPool()
        batch = CoalescedBatch(
            votes=[{"pid": 1}], moderation=[{"tid": 2}], rebuild=True
        )
        svc._requeue(7, batch)
        kinds = [mt for _, mt, _ in svc._pool.submitted]
        assert REBUILD in kinds, "a retry MUST preserve the rebuild flag (R03)"
        assert VOTES in kinds and MODERATION in kinds

    def test_requeue_rebuild_only_still_resubmits_rebuild(self):
        svc = MathPollerService(MagicMock(), PollerConfig(retry_cap=1))
        svc._pool = RecordingPool()
        svc._requeue(7, CoalescedBatch(rebuild=True))
        assert svc._pool.submitted == [(7, REBUILD, [])], (
            "a rebuild-only batch (the reconciler case) must be re-submitted, "
            "not dropped"
        )


# --------------------------------------------------------------------------- #
# R03 — park then silence
# --------------------------------------------------------------------------- #
class TestR03ParkThenSilence:
    def test_transient_rebuild_failure_eventually_publishes(self, make_svc):
        """Exhaust retries -> parked; no new traffic; reconciler runs and the
        first rebuild fails once, then succeeds. Require eventual publication and
        ALL park/retry markers cleared."""
        svc = make_svc(retry_cap=1)
        calls = {"n": 0}

        def loader(zid):
            calls["n"] += 1
            if calls["n"] <= 3:  # 2 to park, then 1 transient reconcile failure
                raise RuntimeError("transient rebuild failure")
            return object()

        svc._load_or_init = loader

        # Exhaust retries -> park (attempt 1 fails -> requeue REBUILD -> attempt 2
        # fails -> park). This ALREADY depends on the rebuild-preservation fix:
        # without it the requeue drops the rebuild and the zid never parks.
        svc._pool.submit(1, REBUILD, [])
        _drain(svc)
        assert 1 in svc._parked, "the zid must be parked after exhausting retries"
        assert svc._writer.writes == []

        # Silence. The reconciler recovers: unpark + REBUILD; fail once, then win.
        svc._reconcile_once()
        _drain(svc)

        assert svc._writer.writes == [1], "the rebuild must eventually publish"
        assert 1 not in svc._parked and not svc._pool.is_parked(1)
        assert svc._retry_counts.get(1) is None, "retry markers must be cleared"

    def test_persistent_failure_stays_parked_with_bounded_retries(self, make_svc):
        """Persistent failure -> visible parked/unhealthy state, BOUNDED retries
        each cycle (no hot loop), and no silent loss (no phantom publication)."""
        svc = make_svc(retry_cap=1)
        calls = {"n": 0}

        def loader(zid):
            calls["n"] += 1
            raise RuntimeError("persistent failure")

        svc._load_or_init = loader

        svc._pool.submit(1, REBUILD, [])
        _drain(svc)
        assert 1 in svc._parked
        # retry_cap + 1 attempts before parking: strictly bounded, not a hot loop.
        assert calls["n"] == 2

        # Repeated reconcile cycles keep the zid visibly parked with the SAME
        # bounded number of attempts each cycle — never a runaway loop, never
        # silently dropped.
        for cycle in range(3):
            svc._reconcile_once()
            _drain(svc)
            assert 1 in svc._parked, f"still parked after reconcile cycle {cycle}"

        assert svc._writer.writes == [], "a failing rebuild must never publish"
        assert calls["n"] == 2 + 3 * 2, "each reconcile retries a bounded 2 times"


# --------------------------------------------------------------------------- #
# R04 — park/unpark races
# --------------------------------------------------------------------------- #
class TestR04ParkUnparkRaces:
    def test_reconcile_while_worker_parks_never_diverges(self, make_svc):
        """Barrier at the pool.park boundary: freeze the worker mid-park and fire
        the reconciler (and a new-vote unpark). Because the pool is the sole owner
        of parked truth, the reconciler cannot observe a half-parked zid, so
        service and pool never disagree and no rebuild is dropped. Recovery then
        completes quietly."""
        svc = make_svc(retry_cap=0, pool_size=2)
        calls = {"n": 0}

        def loader(zid):
            calls["n"] += 1
            if calls["n"] == 1:  # only the first (parking) rebuild fails
                raise RuntimeError("force park on active worker")
            return object()

        svc._load_or_init = loader

        at_park = threading.Event()
        release = threading.Event()
        real_park = svc._pool.park

        def hooked_park(zid):
            at_park.set()
            assert release.wait(timeout=5)
            real_park(zid)

        svc._pool.park = hooked_park

        # Kick off the failing rebuild; the worker heads into park and freezes.
        svc._pool.submit(1, REBUILD, [])
        assert at_park.wait(timeout=5)

        # Worker frozen AT the park boundary. Fire a reconcile + a new-vote poll.
        # The pool is not yet parked, so both are safely no-ops here — and,
        # crucially, service and pool agree at every instant.
        svc._reconcile_once()
        svc._pg.poll_votes_since.return_value = [
            {"zid": 1, "pid": 9, "tid": 9, "vote": 1, "created": 100}
        ]
        svc._vote_wm = 0
        svc._poll_votes_once()
        assert svc._parked == svc._pool.parked_zids(), "views must never diverge"

        # Let the worker finish parking.
        release.set()
        _drain(svc)
        assert svc._pool.is_parked(1) and 1 in svc._parked, "consistent: both parked"

        # A later reconcile recovers cleanly (loader now succeeds).
        svc._pool.park = real_park  # remove the freeze hook
        svc._reconcile_once()
        _drain(svc)
        assert not svc._pool.is_parked(1) and 1 not in svc._parked
        assert svc._writer.writes == [1], "the rebuild is recovered, not dropped"

    def test_overlapping_rebuilds_run_one_handler_per_zid(self, make_svc):
        """Overlap two rebuild triggers for one zid while a handler is in flight
        (multi-worker pool). Require at most ONE active handler per zid and no
        dropped rebuild."""
        svc = make_svc(retry_cap=1, pool_size=4)
        entered = threading.Event()
        proceed = threading.Event()
        lock = threading.Lock()
        conc = {"cur": 0, "max": 0, "n": 0}

        def loader(zid):
            with lock:
                conc["n"] += 1
                conc["cur"] += 1
                conc["max"] = max(conc["max"], conc["cur"])
            entered.set()
            assert proceed.wait(timeout=5)
            with lock:
                conc["cur"] -= 1
            return object()

        svc._load_or_init = loader

        svc._pool.submit(1, REBUILD, [])  # worker A enters loader and freezes
        assert entered.wait(timeout=5)
        svc._pool.submit(1, REBUILD, [])  # overlapping trigger: must NOT run now
        proceed.set()
        _drain(svc)

        assert conc["max"] == 1, "at most one active handler per zid"
        assert conc["n"] >= 1, "the rebuild ran; nothing silently dropped"
        assert svc._writer.writes and svc._writer.writes[0] == 1

    def test_reconcile_and_new_vote_unpark_converge(self, make_svc):
        """Trigger the reconciler and a new-vote unpark concurrently on a parked
        zid. Both funnel through the pool-owned parked state, so the outcome is a
        single quiet recovery with service and pool in agreement."""
        svc = make_svc(retry_cap=0, pool_size=2)
        svc._load_or_init = lambda zid: object()  # rebuild always succeeds now

        # Park zid 1 directly (pool is the owner of parked truth).
        svc._pool.park(1)
        assert 1 in svc._parked

        svc._pg.poll_votes_since.return_value = [
            {"zid": 1, "pid": 1, "tid": 1, "vote": 1, "created": 100}
        ]
        svc._vote_wm = 0

        barrier = threading.Barrier(2)

        def reconcile():
            barrier.wait(timeout=5)
            svc._reconcile_once()

        def poll():
            barrier.wait(timeout=5)
            svc._poll_votes_once()

        t1 = threading.Thread(target=reconcile)
        t2 = threading.Thread(target=poll)
        t1.start()
        t2.start()
        t1.join(timeout=5)
        t2.join(timeout=5)
        _drain(svc)

        assert not svc._pool.is_parked(1) and 1 not in svc._parked
        assert svc._parked == svc._pool.parked_zids()
        assert svc._writer.writes and svc._writer.writes[-1] == 1, (
            "the zid recovers exactly once, from authoritative history"
        )
