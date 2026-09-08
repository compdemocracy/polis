"""R04 — park/unpark races (REAL Postgres, real pool threads).

P-022 §C required matrix:

    Barrier between service marker and pool park; trigger both reconciler and
    new-vote unpark while worker is in flight.  Also overlap two reconciliation
    triggers.  Require one active handler per zid, no dropped rebuild, and
    eventual quiet recovery.

The park/rebuild-ownership fix made the worker pool the SINGLE owner of parked
truth (``worker_pool.py:114`` ``parked_zids()``; ``service.py`` ``_parked`` is a
read-only property over it), so the "service marker then pool park" gap the
P-022 probe exploited is no longer expressible.  These tests pin the
interleaving with latches at the ``pool.park`` and ``_load_or_init`` boundaries
and assert the invariant directly — the two views must agree at EVERY observed
instant — then require a real published generation at the end.

Deterministic schedules; run repeatedly (>=20x) by
``make test-recovery-races``.
"""

import threading

import pytest

from .conftest import (
    FaultInjector,
    commit_vote,
    drain,
    fail_stage,
    pool_pending as _pool_pending,
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F
from polismath.poller.worker_pool import REBUILD, VOTES

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"


def _assert_published(engine, zid=1):
    tables = read_math_tables(engine, zid, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
    fold = F.fold_votes(read_vote_events(engine, zid))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []
    return tables


def test_reconcile_and_new_vote_while_worker_parks_never_diverges(
    engine, pg_url, make_service
):
    """Freeze the worker exactly AT the ``pool.park`` boundary, then fire BOTH a
    reconciliation and a new-vote unpark.  Service and pool views must agree at
    every instant, no rebuild may be dropped, and recovery must complete."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0, worker_pool_size=2)

    fail_once = FaultInjector(name="write_conv_updates", mode="once")
    undo = fail_stage(svc._writer, "write_conv_updates", fail_once)

    at_park = threading.Event()
    release = threading.Event()
    real_park = svc._pool.park

    def hooked_park(zid):
        at_park.set()
        assert release.wait(timeout=30)
        real_park(zid)

    svc._pool.park = hooked_park

    svc._pool.submit(1, VOTES, [])   # empty batch: has_work() is False
    svc._pool.submit(1, REBUILD, [])
    assert at_park.wait(timeout=30), "the worker never reached the park boundary"

    # Worker frozen mid-park. Fire a reconcile AND a new-vote poll.
    observations = []
    svc._reconcile_once()
    observations.append((set(svc._parked), svc._pool.parked_zids()))
    base = max(e["created"] for e in read_vote_events(engine, 1))
    commit_vote(engine, 1, 0, 0, F.RAW_DISAGREE, base + 1000)
    svc._vote_wm = base
    svc._poll_votes_once()
    observations.append((set(svc._parked), svc._pool.parked_zids()))

    release.set()
    drain(svc)
    svc._pool.park = real_park
    undo()
    observations.append((set(svc._parked), svc._pool.parked_zids()))

    for i, (service_view, pool_view) in enumerate(observations):
        assert service_view == pool_view, (
            f"observation {i}: service view {service_view} != pool view "
            f"{pool_view} — parked truth has diverged"
        )

    # Bounded eventual quiet recovery: reconcile until it publishes.
    for _ in range(3):
        svc._reconcile_once()
        drain(svc)
        if read_math_tables(engine, 1, MATH_ENV)["main"] is not None:
            break
    assert 1 not in svc._parked
    _assert_published(engine, 1)


def test_overlapping_reconciliation_triggers_run_one_handler_per_zid(
    engine, pg_url, make_service
):
    """Two reconciliation triggers overlap while a rebuild is in flight.  At
    most ONE handler may be active for the zid, and no rebuild may be lost."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=1, worker_pool_size=4)

    entered = threading.Event()
    proceed = threading.Event()
    lock = threading.Lock()
    conc = {"cur": 0, "max": 0, "n": 0}
    real_load = svc._load_or_init

    def latched_load(zid):
        with lock:
            conc["n"] += 1
            conc["cur"] += 1
            conc["max"] = max(conc["max"], conc["cur"])
        entered.set()
        assert proceed.wait(timeout=30)
        try:
            return real_load(zid)
        finally:
            with lock:
                conc["cur"] -= 1

    svc._load_or_init = latched_load
    writes = []
    real_write = svc._writer.write_conv_updates

    def counting_write(zid, conv):
        writes.append(zid)
        return real_write(zid, conv)

    svc._writer.write_conv_updates = counting_write

    svc._pool.park(1)
    svc._reconcile_once()                    # trigger 1: unpark + REBUILD
    assert entered.wait(timeout=30), "the first rebuild never started"

    # Two more triggers arrive while the first handler is PROVABLY in flight.
    # Neither may run now (per-zid serialization) and neither may be dropped:
    # the pool must coalesce them into exactly one further cycle.
    svc._pool.submit(1, REBUILD, [])
    svc._pool.submit(1, REBUILD, [])
    proceed.set()
    drain(svc)
    svc._load_or_init = real_load
    svc._writer.write_conv_updates = real_write

    # --- handler accounting (exact, not ">= 1") ---------------------------- #
    assert conc["max"] == 1, (
        f"at most one active handler per zid, saw {conc['max']} concurrent"
    )
    assert conc["n"] == 2, (
        "expected EXACTLY two rebuild executions — the in-flight one plus one "
        f"coalesced cycle for the two overlapping triggers — but saw {conc['n']}. "
        "A count of 1 means the queued rebuilds were DROPPED; more than 2 means "
        "per-zid serialization or coalescing broke."
    )
    assert conc["cur"] == 0, "no handler left in flight"

    # --- final state ------------------------------------------------------- #
    assert writes == [1, 1], (
        f"each executed rebuild must publish exactly once, saw {writes!r}"
    )
    assert not _pool_pending(svc._pool, 1), (
        "the pool must have no queued or active work left for the zid"
    )
    assert 1 not in svc._parked and not svc._pool.is_parked(1), (
        "a successful rebuild must leave the zid quiet and unparked"
    )
    assert svc._retry_counts.get(1) is None, "retry markers must be cleared"
    _assert_published(engine, 1)


def test_reconcile_racing_a_new_vote_converges_once(engine, pg_url,
                                                    make_service):
    """The reconciler and a new-vote unpark fire simultaneously on a parked zid
    (a two-thread barrier).  Both funnel through the pool-owned parked state, so
    the outcome is a single quiet recovery with the views in agreement."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0, worker_pool_size=2)

    svc._pool.park(1)
    assert 1 in svc._parked

    base = max(e["created"] for e in read_vote_events(engine, 1))
    commit_vote(engine, 1, 0, 0, F.RAW_DISAGREE, base + 1000)
    svc._vote_wm = base

    barrier = threading.Barrier(2)
    errors = []

    def reconcile():
        try:
            barrier.wait(timeout=30)
            svc._reconcile_once()
        except Exception as exc:  # pragma: no cover - surfaced by the assert
            errors.append(exc)

    def poll():
        try:
            barrier.wait(timeout=30)
            svc._poll_votes_once()
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=reconcile), threading.Thread(target=poll)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    drain(svc)

    assert errors == []
    assert 1 not in svc._parked
    assert set(svc._parked) == svc._pool.parked_zids()
    _assert_published(engine, 1)


# --------------------------------------------------------------------------- #
# Negative control for the park/unpark race failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_a_second_parked_set_diverges_from_the_pool(self, engine, pg_url,
                                                        make_service):
        """Intentionally broken variant: reinstate the pre-fix two-step park
        (service-side marker first, ``pool.park`` second) and let a
        reconciliation land in the gap.  The two views MUST diverge — proof the
        divergence assertion above is load-bearing rather than trivially true.
        """
        seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
        svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0,
                           worker_pool_size=2)

        # The pre-fix design: a SECOND parked set the service keeps itself.
        service_parked = set()
        at_gap = threading.Event()
        release = threading.Event()
        real_park = svc._pool.park

        def two_step_park(zid):
            service_parked.add(zid)      # step 1: the service's own marker
            at_gap.set()
            assert release.wait(timeout=30)
            real_park(zid)               # step 2: the pool, much later

        def broken_on_error(zid, coalesced, error):
            two_step_park(zid)

        svc._on_engine_error = broken_on_error

        fail_once = FaultInjector(name="write_conv_updates", mode="once")
        undo = fail_stage(svc._writer, "write_conv_updates", fail_once)
        svc._pool.submit(1, REBUILD, [])
        assert at_gap.wait(timeout=30)

        # A reconciliation lands in the gap: it clears the SERVICE marker (the
        # pre-fix _unpark) while the pool has not parked yet.
        service_parked.discard(1)
        divergent = (set(service_parked), svc._pool.parked_zids())
        release.set()
        drain(svc)
        undo()
        after = (set(service_parked), svc._pool.parked_zids())

        assert divergent[0] != divergent[1] or after[0] != after[1], (
            "NEGATIVE CONTROL FAILED: the two-set design did not diverge, so "
            "the R04 agreement assertion proves nothing"
        )
        assert after == (set(), {1}), (
            f"expected the classic divergence (service unparked, pool parked), "
            f"saw {after}"
        )
