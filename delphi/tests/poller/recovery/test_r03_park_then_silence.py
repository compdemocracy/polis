"""R03 — park, then silence (REAL Postgres).

P-022 §C required matrix:

    Exhaust retries, no new traffic, reconcile, and fail the first rebuild once.
    Require eventual successful publication and all park/retry markers cleared.
    Repeat with persistent failure: visible unhealthy/parked state and bounded
    retries, not silent loss or a hot loop.

``tests/poller/test_park_rebuild_recovery.py`` already covers this control flow
with an in-process pool and a fake loader (the R03/R04 fix's regression suite).
This module re-runs the same scenarios end-to-end against a real migrated
Postgres with the real ``Conversation``, real ``MathWriter`` and real rows, so
the recovery is proved to actually re-derive and re-publish authoritative state
rather than merely to call the right methods.
"""

import pytest

from .conftest import (
    FaultInjector,
    commit_vote,
    drain,
    fail_stage,
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"


def test_transient_rebuild_failure_eventually_publishes(engine, pg_url,
                                                        make_service):
    """Retries exhausted -> parked; NO new traffic; the reconciler's first
    rebuild fails once and its retry succeeds.  Require eventual publication
    matching the fold and all park/retry markers cleared."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=1, worker_pool_size=1)

    # 2 failures park the zid (attempt + 1 retry); the 3rd is the reconciler's
    # first rebuild, which also fails; the 4th (its retry) wins.
    injector = FaultInjector(name="write_conv_updates", mode="nth", nth=1)
    injector.mode = "always"

    undo = fail_stage(svc._writer, "write_conv_updates", injector)
    svc.poll_once()
    assert 1 in svc._parked, "exhausting retries must park the zid"
    assert injector.calls == 2, f"bounded retries, saw {injector.calls} attempts"
    assert read_math_tables(engine, 1, MATH_ENV)["main"] is None

    # One more transient failure on the reconciler's rebuild, then health.
    undo()
    once = FaultInjector(name="write_conv_updates", mode="once")
    undo2 = fail_stage(svc._writer, "write_conv_updates", once)
    svc._reconcile_once()
    drain(svc)
    undo2()
    assert once.fired == 1, "the reconciler's first rebuild must have failed once"

    # The retry of a REBUILD must preserve the rebuild kind (service.py:672),
    # so this already published without any further reconcile pass.
    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
    fold = F.fold_votes(read_vote_events(engine, 1))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []
    assert 1 not in svc._parked
    assert svc._retry_counts.get(1) is None, "retry markers must be cleared"


def test_parked_zid_recovers_the_interval_the_watermark_skipped(engine, pg_url,
                                                                make_service):
    """The point of the reconciler: the global watermark advanced PAST the votes
    that failed, so only a full-history rebuild can recover them.  Assert the
    published state contains the skipped interval, with no new votes at all."""
    seeded = seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0, worker_pool_size=1)

    injector = FaultInjector(name="write_conv_updates", mode="always")
    undo = fail_stage(svc._writer, "write_conv_updates", injector)
    svc.poll_once()
    undo()
    assert 1 in svc._parked
    # The watermark has moved past every seeded vote even though none published.
    assert svc._vote_wm >= max(e["created"] for e in seeded.vote_events)

    svc._reconcile_once()
    drain(svc)

    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables_are_coherent(tables) == []
    fold = F.fold_votes(read_vote_events(engine, 1))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == [], (
        "the reconciler must recover the interval the watermark skipped"
    )
    assert fold.event_count == len(seeded.vote_events)


def test_persistent_failure_stays_parked_with_bounded_retries(engine, pg_url,
                                                              make_service):
    """A persistent failure must leave a VISIBLE parked state, retry a bounded
    number of times per cycle (no hot loop), and never publish."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=1, worker_pool_size=1)

    injector = FaultInjector(name="write_conv_updates", mode="always")
    undo = fail_stage(svc._writer, "write_conv_updates", injector)
    svc.poll_once()
    assert 1 in svc._parked
    assert injector.calls == 2

    for cycle in range(3):
        svc._reconcile_once()
        drain(svc)
        assert 1 in svc._parked, f"still visibly parked after cycle {cycle}"
    assert injector.calls == 2 + 3 * 2, (
        f"each reconcile must retry a BOUNDED 2 times, saw {injector.calls} total"
    )
    assert read_math_tables(engine, 1, MATH_ENV)["main"] is None, (
        "a persistently failing rebuild must never publish"
    )

    # And once the fault clears, the very next reconcile recovers it.
    undo()
    svc._reconcile_once()
    drain(svc)
    assert 1 not in svc._parked
    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables_are_coherent(tables) == []


def test_a_healthy_conversation_is_never_parked_by_a_neighbours_failure(
    engine, pg_url, make_service
):
    """Parking is per-zid: a persistently failing zid must not park a healthy
    one that shares the pool."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    seed_conversation(engine, zid=2, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0, worker_pool_size=2)

    real_write = svc._writer.write_conv_updates

    def poison_zid_1(zid, conv):
        if zid == 1:
            raise RuntimeError("poison zid")
        return real_write(zid, conv)

    svc._writer.write_conv_updates = poison_zid_1
    svc.poll_once()
    svc._writer.write_conv_updates = real_write

    assert svc._parked == {1}
    healthy = read_math_tables(engine, 2, MATH_ENV)
    assert tables_are_coherent(healthy) == []
    fold2 = F.fold_votes(read_vote_events(engine, 2))
    assert F.check_published_against_fold(healthy["main"]["data"], fold2) == []


# --------------------------------------------------------------------------- #
# Negative control for the park/rebuild failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_dropping_the_rebuild_on_retry_loses_the_zid(self, engine, pg_url,
                                                         make_service):
        """Intentionally broken variant: restore the pre-fix ``_requeue`` that
        drops the REBUILD kind.  The reconciler has ALREADY cleared the parked
        marker, so a single transient rebuild failure leaves the zid neither
        parked nor queued — silently lost.  This is the R03 defect, and it must
        reproduce on the broken variant."""
        seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
        svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=1,
                           worker_pool_size=1)

        always = FaultInjector(name="write_conv_updates", mode="always")
        undo = fail_stage(svc._writer, "write_conv_updates", always)
        svc.poll_once()
        undo()
        assert 1 in svc._parked

        # The PRE-FIX _requeue: votes/moderation only, rebuild dropped.
        from polismath.poller.worker_pool import VOTES, MODERATION

        def broken_requeue(zid, coalesced):
            if coalesced.votes:
                svc._pool.submit(zid, VOTES, list(coalesced.votes))
            if coalesced.moderation:
                svc._pool.submit(zid, MODERATION, list(coalesced.moderation))

        svc._requeue = broken_requeue
        once = FaultInjector(name="write_conv_updates", mode="once")
        undo2 = fail_stage(svc._writer, "write_conv_updates", once)
        svc._reconcile_once()
        drain(svc)
        undo2()

        assert once.fired == 1
        assert 1 not in svc._parked, "the reconciler already cleared the marker"
        assert read_math_tables(engine, 1, MATH_ENV)["main"] is None, (
            "NEGATIVE CONTROL FAILED: the broken _requeue still published, so "
            "the R03 test would pass even with the defect present"
        )
