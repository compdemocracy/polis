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
    """An ``OrderedDict`` that can block INSIDE ``get`` for one named zid.

    This is the "barrier between cache get / touch / store" the matrix asks
    for: it freezes a worker at the exact instant between
    ``self._convs.get(zid)`` returning a conversation and the following
    ``self._convs.move_to_end(zid)`` LRU touch.
    """

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.latch_zid = None
        self.arrived = threading.Event()
        self.release = threading.Event()

    def get(self, key, default=None):
        value = super().get(key, default)
        if key == self.latch_zid and value is not None:
            self.arrived.set()
            self.release.wait(timeout=30)
        return value


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
        "`self._convs.move_to_end(zid)`; polismath/poller/service.py:488 "
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

    errors = []
    newer = max(e["created"] for e in seeded.vote_events) + 1000
    batch = CoalescedBatch(votes=[{"zid": 1, "pid": 0, "tid": 0,
                                   "vote": F.ENGINE_DISAGREE,
                                   "created": newer}])

    def worker_a():
        try:
            svc._handle_zid(1, batch)
        except BaseException as exc:  # pragma: no cover - _handle_zid catches
            errors.append(exc)

    real_error_handler = svc._on_engine_error

    def recording_error(zid, coalesced, error):
        errors.append(error)
        return real_error_handler(zid, coalesced, error)

    svc._on_engine_error = recording_error

    thread = threading.Thread(target=worker_a, daemon=True)
    thread.start()
    assert cache.arrived.wait(timeout=30), "worker A never reached cache-get"

    # Worker A is frozen between get() and move_to_end(). Evict zid 1 from
    # another thread, exactly as a concurrent _remember for zid 2 would.
    svc._remember(2, object())
    assert 1 not in cache, "the eviction must have removed zid 1"
    cache.release.set()
    thread.join(timeout=30)
    assert not thread.is_alive()

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
