"""R06 — LRU eviction while work is in flight (REAL Postgres).

P-022 §C required matrix:

    Cap=1/2, >=4 worker threads, barriers between cache get/touch/store while
    other zids evict.  Repeat touches/restarts, inspect final outputs and peak
    memory.  No KeyError, dropped handler or lost input; cache bookkeeping
    synchronized.  Compare restart geometry against a reference using the same
    restore seam, not an uninterrupted smoother trajectory.

The conversation cache is a bare ``OrderedDict`` mutated from pool threads with
no lock (``poller/service.py:278``; ``_remember`` at ``:479``, the LRU touch at
``:497``).  The barrier here sits at the named "cache get" boundary and holds
one worker between its ``self._convs.get(zid)`` and its
``self._convs.move_to_end(zid)`` while another worker's ``_remember`` evicts
that very key — P-019's unaddressed should-fix #5.
"""

import threading
from collections import OrderedDict

import pytest

from .conftest import (
    drain,
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F
from polismath.poller.worker_pool import VOTES

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"


class LatchedCache(OrderedDict):
    """An ``OrderedDict`` that can block INSIDE ``get`` for one named zid, and
    that announces every eviction it performs.

    This is the "barrier between cache get / touch / store" the matrix asks
    for: it freezes a worker at the exact instant between
    ``self._convs.get(zid)`` returning a conversation and the following
    ``self._convs.move_to_end(zid)`` LRU touch.  The latch fires ONCE, so the
    error path's own ``_convs.get`` cannot re-enter it.

    ``evicted`` records which zids ``popitem`` actually removed, and
    ``eviction_reached`` fires when a *concurrent* thread got as far as
    mutating the cache — see :class:`ObservedLock` for the other half.
    """

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.latch_zid = None
        self.arrived = threading.Event()
        self.release = threading.Event()
        self.eviction_reached = threading.Event()
        self.evicted = []
        self._latched = False

    def get(self, key, default=None):
        value = super().get(key, default)
        if key == self.latch_zid and value is not None and not self._latched:
            self._latched = True
            self.arrived.set()
            self.release.wait(timeout=30)
        return value

    def popitem(self, last=True):
        item = super().popitem(last=last)
        self.evicted.append(item[0])
        # Unblock the driver on UNLOCKED code: the evictor got all the way in.
        self.eviction_reached.set()
        return item


class ObservedLock:
    """A pass-through wrapper for the service's cache lock that reports real
    CONTENTION.

    The R06 race is staged from the LOCK BOUNDARY, not from inside ``get``
    (R06-cache-lock-report should-fix): once ``_run_engine``'s lookup and LRU
    touch run under ``_convs_lock``, a driver that calls ``svc._remember`` while
    worker A is latched inside ``get`` blocks on that very lock, so the schedule
    only unwinds when the latch's own 30 s timeout expires — after which the
    touch happens *before* the eviction and the documented interleaving is never
    staged at all.

    So the driver waits for ``eviction_reached`` instead, which fires from
    OUTSIDE the locked region in whichever way is possible:

    * unlocked code — the evictor reaches ``LatchedCache.popitem`` and really
      does remove the key in the window, exposing the ``KeyError``;
    * locked code — the evictor is refused the lock and blocks here, proving it
      arrived at the cache while worker A held the critical section.

    Either way the driver releases in milliseconds and the outcome is decided by
    the production code, not by a timeout.
    """

    def __init__(self, lock, reached: threading.Event):
        self._lock = lock
        self._reached = reached

    def __enter__(self):
        if not self._lock.acquire(blocking=False):
            self._reached.set()
            assert self._lock.acquire(timeout=30), "cache lock never released"
        return self

    def __exit__(self, *exc):
        self._lock.release()
        return False


def _assert_all_published(engine, zids):
    for zid in zids:
        tables = read_math_tables(engine, zid, MATH_ENV)
        problems = tables_are_coherent(tables)
        assert problems == [], f"zid {zid}: {problems}"
        fold = F.fold_votes(read_vote_events(engine, zid))
        assert F.check_published_against_fold(
            tables["main"]["data"], fold
        ) == [], f"zid {zid} disagrees with the fold"


# --------------------------------------------------------------------------- #
# Churn: a tiny cap with many zids must not lose anything
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("cap", [1, 2])
def test_cap_smaller_than_the_working_set_loses_nothing(engine, pg_url,
                                                        make_service, cap):
    """cap-1/cap-2 with 4 workers and 5 conversations, repeatedly touched: every
    zid must end with a coherent generation matching its own fold.  Eviction is
    a memory/latency trade, never a correctness one."""
    zids = [1, 2, 3, 4, 5]
    for zid in zids:
        seed_conversation(engine, zid=zid, n_ptpts=6, n_cmts=4)

    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=4,
                       conv_cache_cap=cap)
    for _ in range(3):          # repeat touches: every zid cycles through the LRU
        svc._vote_wm = 0
        svc.poll_once()

    assert len(svc._convs) <= cap, (
        f"cache grew past its cap: {len(svc._convs)} > {cap}"
    )
    _assert_all_published(engine, zids)


def test_evicted_conversation_reloads_identically_via_the_same_restore_seam(
    engine, pg_url, make_service
):
    """"Compare restart geometry against a reference using the SAME restore
    seam": a zid evicted and reloaded must publish the same blob as a cold
    service that loaded it through ``_load_or_init`` — not the same blob as an
    uninterrupted warm trajectory."""
    zids = [1, 2, 3]
    for zid in zids:
        seed_conversation(engine, zid=zid, n_ptpts=6, n_cmts=4)

    # Reference: a cold service, restoring zid 1 through _load_or_init.
    reference_svc = make_service(pg_url, math_env=MATH_ENV + "_ref",
                                 worker_pool_size=1, conv_cache_cap=0)
    reference_svc.poll_once()
    reference = read_math_tables(engine, 1, MATH_ENV + "_ref")["main"]["data"]

    # Subject: cap=1, so zid 1 is evicted by 2 and 3, then reloaded.
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                       conv_cache_cap=1)
    svc.poll_once()
    assert list(svc._convs) == [3], "zid 1 must have been evicted"
    svc._vote_wm = 0
    svc.poll_once()             # zid 1 reloads through the same restore seam
    subject = read_math_tables(engine, 1, MATH_ENV)["main"]["data"]

    for key in ("user-vote-counts", "votes-base", "lastVoteTimestamp", "n",
                "n-cmts", "base-clusters", "group-clusters"):
        assert subject[key] == reference[key], (
            f"reloaded zid 1 differs from the cold reference at {key!r}"
        )


def test_cache_stays_bounded_under_pool_concurrency(engine, pg_url,
                                                    make_service):
    """Peak cache occupancy — the memory proxy this suite can actually measure —
    must respect the cap even while four workers store concurrently."""
    zids = list(range(1, 9))
    for zid in zids:
        seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3)

    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=4,
                       conv_cache_cap=2)
    peak = {"n": 0}
    real_remember = svc._remember

    def watched_remember(zid, conv):
        real_remember(zid, conv)
        peak["n"] = max(peak["n"], len(svc._convs))

    svc._remember = watched_remember
    svc.poll_once()
    drain(svc)

    assert peak["n"] <= 2 + 1, (
        f"cache peaked at {peak['n']} entries with cap=2; the eviction loop is "
        "not keeping up with concurrent stores"
    )
    _assert_all_published(engine, zids)


# --------------------------------------------------------------------------- #
# The in-flight race itself
# --------------------------------------------------------------------------- #
@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (P-019 should-fix #5, unaddressed): the conversation cache is "
        "an unsynchronized OrderedDict. polismath/poller/service.py:497 reads "
        "`conv = self._convs.get(zid)` and then, as a separate step, calls "
        "`self._convs.move_to_end(zid)`; polismath/poller/service.py:489 "
        "concurrently evicts with `self._convs.popitem(last=False)` from "
        "another pool thread. With the key evicted in that window, move_to_end "
        "raises KeyError, which escapes _run_engine into _handle_zid's blanket "
        "except (:476) and is treated as an ENGINE error: the batch is retried "
        "or the healthy zid is PARKED, and an errorconv dump is written — a "
        "spurious failure caused purely by cache bookkeeping. P-022 §C R06 "
        "requires 'No KeyError, dropped handler or lost input; cache "
        "bookkeeping synchronized.' The fix is a lock (or a thread-safe cache) "
        "around get/touch/store/evict; that is a separate decision."
    ),
)
def test_lru_touch_racing_an_eviction_does_not_park_a_healthy_zid(
    engine, pg_url, make_service
):
    """Barrier at the cache-get boundary: hold worker A between its cache read
    and its LRU touch while another worker's ``_remember`` evicts that key.

    Worker A is doing perfectly healthy work on real, valid input; only the
    cache bookkeeping is racing.  It must not fail, and it must not park.

    The eviction runs on its OWN thread and the driver releases worker A as
    soon as that thread has reached the cache — either by evicting (unlocked
    code, which then loses the key under worker A and raises ``KeyError``) or by
    blocking on the cache lock (locked code, where the compound get/touch is
    atomic and nothing is lost).  Latching *inside* ``get`` and evicting from
    the driver, as this test used to do, deadlocks against a locked cache until
    the 30 s latch timeout expires and then stages the wrong order entirely
    (R06-cache-lock-report should-fix).  This version decides in milliseconds
    and is decided by the production code either way.
    """
    from polismath.poller.worker_pool import CoalescedBatch

    seeded = seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=4,
                       conv_cache_cap=1, retry_cap=0)
    svc.poll_once()
    assert 1 in svc._convs, "zid 1 must be warm before the race can be staged"

    cache = LatchedCache(svc._convs)
    svc._convs = cache
    cache.latch_zid = 1
    # Present on the fixed service, absent on today's; either way the evictor's
    # arrival at the cache becomes observable from outside the critical section.
    svc._convs_lock = ObservedLock(
        getattr(svc, "_convs_lock", threading.Lock()), cache.eviction_reached
    )

    errors = []
    newer = max(e["created"] for e in seeded.vote_events) + 1000
    batch = CoalescedBatch(votes=[{"zid": 1, "pid": 0, "tid": 0,
                                   "vote": F.ENGINE_DISAGREE,
                                   "created": newer}])

    def collecting(fn):
        def run():
            try:
                fn()
            except BaseException as exc:  # pragma: no cover - handler catches
                errors.append(exc)
        return run

    real_error_handler = svc._on_engine_error

    def recording_error(zid, coalesced, error):
        errors.append(error)
        return real_error_handler(zid, coalesced, error)

    svc._on_engine_error = recording_error

    worker = threading.Thread(
        target=collecting(lambda: svc._handle_zid(1, batch)), daemon=True)
    evictor = threading.Thread(
        target=collecting(lambda: svc._remember(2, object())), daemon=True)

    worker.start()
    assert cache.arrived.wait(timeout=30), "worker A never reached cache-get"
    # Worker A is frozen between get() and move_to_end(). A concurrent
    # _remember for zid 2 now evicts that very key.
    evictor.start()
    assert cache.eviction_reached.wait(timeout=30), (
        "the evicting thread never reached the cache at all"
    )
    cache.release.set()
    worker.join(timeout=60)
    evictor.join(timeout=60)
    assert not worker.is_alive() and not evictor.is_alive()

    assert 1 in cache.evicted, (
        "the in-flight zid was never actually evicted, so no race was staged: "
        f"evicted={cache.evicted}"
    )
    assert errors == [] and 1 not in svc._parked, (
        f"a healthy zid failed purely because of cache bookkeeping: "
        f"errors={errors!r} parked={set(svc._parked)!r}"
    )


# --------------------------------------------------------------------------- #
# Negative control for the cache/LRU failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_a_cache_that_never_evicts_is_detected(self, engine, pg_url,
                                                   make_service):
        """Intentionally broken variant: disable eviction and check that the
        bound assertion goes red — proving it is not vacuous."""
        for zid in (1, 2, 3):
            seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                           conv_cache_cap=1)

        def never_evicts(zid, conv):
            svc._convs[zid] = conv

        svc._remember = never_evicts
        svc.poll_once()
        with pytest.raises(AssertionError):
            assert len(svc._convs) <= 1, "cache grew past its cap"

    def test_eviction_is_lossless_control(self, engine, pg_url, make_service):
        """Positive counterpart: with eviction ENABLED the same workload still
        publishes every zid correctly, so the bound above is not being met by
        dropping work."""
        zids = (1, 2, 3)
        for zid in zids:
            seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                           conv_cache_cap=1)
        svc.poll_once()
        assert len(svc._convs) <= 1
        _assert_all_published(engine, zids)
