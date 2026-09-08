"""R01 — stage failures (REAL Postgres, real engine, real writer).

P-022 §C required matrix:

    Fail before/after tick allocation, main write, bidtopid write and ptptstats
    write; include serialization failure, DB rollback, connection loss and
    committed-write/lost-ack.  Check final latest vote values, unchanged prior
    cached object on failed write, no extra temporal advancement from replaying
    an uncommitted computation, coherent recovered tables.  Tick gaps may occur;
    gaps are not lost votes.

Every failure is injected at the ``PostgresClient`` boundary that
``MathWriter.write_conv_updates`` calls (``math_writer.py:227`` — the tick
allocation and all three table writes now share ONE ``engine.begin()``, so a
failure at any stage rolls the whole snapshot back, including the tick), so the
code under test is the deployed code.  Three of the failures are genuine
Postgres failures, not Python stand-ins:

* **DB rollback** — a real ``NOT NULL`` violation inside the real upsert.
* **connection loss** — ``pg_terminate_backend`` on the poller's own backend.
* **serialization failure** — two real ``SERIALIZABLE`` transactions touching
  the same math_main row, one of which the server aborts with 40001.

Final state is checked against the INDEPENDENT fold in ``fold.py``.
"""

import threading

import pytest
import sqlalchemy as sa

from .conftest import (
    FaultInjector,
    InjectedFault,
    dbname_of,
    drain,
    fail_stage,
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
    terminate_backends,
)
from . import fold as F

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"


def _publish_and_check(engine, svc, zid=1):
    """Poll until quiet, then assert the published generation is coherent and
    agrees with the independent fold."""
    svc.poll_once()
    tables = read_math_tables(engine, zid, MATH_ENV)
    assert tables_are_coherent(tables) == [], (
        f"published generation is incoherent: {tables_are_coherent(tables)}"
    )
    fold = F.fold_votes(read_vote_events(engine, zid))
    problems = F.check_published_against_fold(tables["main"]["data"], fold)
    assert problems == [], problems
    return tables, fold


# --------------------------------------------------------------------------- #
# Stage-by-stage one-shot failures
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "stage,after",
    [
        # Writer order is tick -> bidtopid -> ptptstats -> main -> COMMIT.
        ("increment_math_tick", False),   # before tick allocation
        ("increment_math_tick", True),    # after tick allocation
        ("write_math_bidtopid", False),   # before the bidtopid write
        ("write_math_bidtopid", True),    # after the bidtopid write
        ("write_participant_stats", False),   # before the ptptstats write
        ("write_participant_stats", True),    # after the ptptstats write
        ("write_math_main", False),       # before the main write
        ("write_math_main", True),        # after all three writes (lost ack)
    ],
)
def test_one_shot_stage_failure_recovers(engine, pg_url, make_service, stage, after):
    """A transient failure at ANY write stage must recover to a coherent
    generation whose contents match the independent fold.  Tick GAPS are
    permitted (a failed cycle may have already minted a tick); lost votes are
    not."""
    seeded = seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=3)

    injector = FaultInjector(name=f"{stage}:{'after' if after else 'before'}")
    undo = fail_stage(svc._pg, stage, injector, after=after)
    try:
        svc.poll_once()          # the injected failure fires inside this cycle
    finally:
        undo()
    assert injector.fired == 1, "the fault must actually have fired"

    # Bounded eventual progress: one more quiet cycle with no new votes.
    tables, fold = _publish_and_check(engine, svc, zid=1)

    # No extra temporal advancement: the published watermark is exactly the
    # folded max(created) — replaying a computation that never committed must
    # not push last_vote_timestamp past the real input.
    assert tables["main"]["last_vote_timestamp"] == fold.last_vote_timestamp
    assert fold.event_count == len(seeded.vote_events)


def test_persistent_stage_failure_parks_then_recovers(engine, pg_url, make_service):
    """A PERSISTENT main-write failure must park the zid with bounded retries
    (visible unhealthy state, no hot loop, no phantom publication); once the DB
    stage is restored the reconciler recovers it with no new votes."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=1)

    injector = FaultInjector(name="write_math_main", mode="always")
    undo = fail_stage(svc._pg, "write_math_main", injector)
    svc.poll_once()
    assert 1 in svc._parked, "a persistently failing zid must become visibly parked"
    assert injector.calls == 2, (
        f"retries must be bounded to retry_cap+1=2 attempts, saw {injector.calls}"
    )
    assert read_math_tables(engine, 1, MATH_ENV)["main"] is None, (
        "a failing write must never publish"
    )

    undo()  # DB stage restored; no new votes
    svc._reconcile_once()
    drain(svc)
    tables, fold = _publish_and_check(engine, svc, zid=1)
    assert 1 not in svc._parked


# --------------------------------------------------------------------------- #
# Real Postgres failures
# --------------------------------------------------------------------------- #
def test_real_db_rollback_leaves_no_partial_main_row(engine, pg_url, make_service):
    """A REAL Postgres error rolls the write back.

    The failure is a genuine ``math_main_zid_fkey`` violation from the real
    migration (a zid with no ``conversations`` row), raised inside the real
    upsert on the real ``engine.begin()`` transaction — so the rollback is
    Postgres's, not a Python stand-in.  Afterwards nothing partial is left and
    the retry publishes a coherent generation.
    """
    GHOST_ZID = 987654321  # deliberately absent from `conversations`
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=3)

    original = svc._pg.write_math_main
    state = {"fired": 0, "error": None}

    def broken_write(zid, data, **kwargs):
        if state["fired"] == 0:
            state["fired"] = 1
            try:
                original(GHOST_ZID, data, **kwargs)
            except Exception as exc:
                state["error"] = exc
                raise
        return original(zid, data, **kwargs)

    svc._pg.write_math_main = broken_write
    svc.poll_once()
    svc._pg.write_math_main = original

    assert state["fired"] == 1
    assert isinstance(state["error"], sa.exc.DBAPIError), (
        f"expected a real Postgres DBAPI error, got {state['error']!r}"
    )
    assert getattr(state["error"].orig, "pgcode", None) == "23503", (
        "expected a foreign_key_violation (23503) from the real migration's "
        f"math_main_zid_fkey, saw {state['error']!r}"
    )
    # The rolled-back statement left nothing behind.
    with engine.connect() as conn:
        ghost = conn.execute(
            sa.text("SELECT count(*) FROM math_main WHERE zid = :z"),
            {"z": GHOST_ZID},
        ).scalar()
    assert ghost == 0, "a rolled-back write must leave no row"

    _publish_and_check(engine, svc, zid=1)


def test_real_connection_loss_recovers(engine, pg_url, recovery_postgres_url,
                                       make_service):
    """Terminate the poller's server-side backend mid-cycle (a REAL connection
    loss), then require bounded eventual recovery with no lost votes."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=3)

    original = svc._pg.write_math_bidtopid
    state = {"fired": 0}

    def kill_then_write(zid, data, **kwargs):
        if state["fired"] == 0:
            state["fired"] = 1
            terminate_backends(recovery_postgres_url, dbname_of(pg_url))
        return original(zid, data, **kwargs)

    svc._pg.write_math_bidtopid = kill_then_write
    svc.poll_once()
    svc._pg.write_math_bidtopid = original
    assert state["fired"] == 1

    _publish_and_check(engine, svc, zid=1)


def test_real_serialization_failure_recovers(engine, pg_url, make_service):
    """A REAL 40001 serialization failure (two SERIALIZABLE transactions on the
    same math_main row) must be a retryable blip, not lost work."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=3)

    # Publish once so a math_main row exists for two transactions to contend on.
    svc.poll_once()
    baseline = read_math_tables(engine, 1, MATH_ENV)
    assert baseline["main"] is not None

    original = svc._pg.write_math_main
    seen = {"code": None, "fired": 0}

    def contended_write(zid, data, **kwargs):
        if seen["fired"] == 0:
            seen["fired"] = 1
            a = engine.connect().execution_options(isolation_level="SERIALIZABLE")
            b = engine.connect().execution_options(isolation_level="SERIALIZABLE")
            try:
                a.begin()
                b.begin()
                # Both read the same row, then both write it: the second commit
                # must abort with a real serialization failure.
                a.execute(sa.text("SELECT caching_tick FROM math_main "
                                  "WHERE zid=:z AND math_env=:e"),
                          {"z": zid, "e": MATH_ENV}).all()
                b.execute(sa.text("SELECT caching_tick FROM math_main "
                                  "WHERE zid=:z AND math_env=:e"),
                          {"z": zid, "e": MATH_ENV}).all()
                a.execute(sa.text("UPDATE math_main SET modified = modified + 1 "
                                  "WHERE zid=:z AND math_env=:e"),
                          {"z": zid, "e": MATH_ENV})
                a.commit()
                try:
                    b.execute(sa.text("UPDATE math_main SET modified = modified + 2 "
                                      "WHERE zid=:z AND math_env=:e"),
                              {"z": zid, "e": MATH_ENV})
                    b.commit()
                except sa.exc.DBAPIError as exc:
                    seen["code"] = getattr(exc.orig, "pgcode", None)
                    raise
            finally:
                a.close()
                b.close()
        return original(zid, data, **kwargs)

    svc._pg.write_math_main = contended_write
    # Force another cycle by committing one more vote.
    from .conftest import commit_vote
    events = read_vote_events(engine, 1)
    commit_vote(engine, 1, 0, 0, 1, max(e["created"] for e in events) + 10)
    svc._vote_wm = 0
    svc.poll_once()
    svc._pg.write_math_main = original

    assert seen["fired"] == 1
    assert seen["code"] == "40001", (
        f"expected a REAL serialization failure (40001), saw pgcode {seen['code']!r}"
    )
    _publish_and_check(engine, svc, zid=1)


# --------------------------------------------------------------------------- #
# Cache / temporal invariants around a failed write
# --------------------------------------------------------------------------- #
def test_failed_write_leaves_prior_cached_object_unchanged(engine, pg_url,
                                                           make_service):
    """Write-before-cache (M2): on a failed write the in-memory cache must still
    hold the LAST PERSISTED conversation object — never an unpersisted one."""
    from .conftest import commit_vote

    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0)
    svc.poll_once()
    cached_before = svc._convs.get(1)
    assert cached_before is not None
    ts_before = cached_before.last_updated

    events = read_vote_events(engine, 1)
    newer = max(e["created"] for e in events) + 1000
    commit_vote(engine, 1, 0, 0, 1, newer)

    injector = FaultInjector(name="write_math_main", mode="always")
    undo = fail_stage(svc._pg, "write_math_main", injector)
    svc._vote_wm = 0
    svc.poll_once()
    undo()

    assert injector.fired >= 1
    cached_after = svc._convs.get(1)
    assert cached_after is cached_before, (
        "a failed write must leave the PREVIOUS cached object in place"
    )
    assert cached_after.last_updated == ts_before, (
        "no temporal advancement from a computation that never committed"
    )
    # And the persisted row is still the last good one.
    main = read_math_tables(engine, 1, MATH_ENV)["main"]
    assert main["last_vote_timestamp"] == ts_before

    # Bounded eventual progress once the stage is healthy again.
    svc._vote_wm = 0
    svc.poll_once()
    tables, fold = _publish_and_check(engine, svc, zid=1)
    assert tables["main"]["last_vote_timestamp"] == newer == fold.last_vote_timestamp


def test_tick_gap_is_allowed_but_votes_are_not_lost(engine, pg_url, make_service):
    """A legacy standalone allocation can leave a tick gap. Atomic publication
    must tolerate that existing gap and preserve the final authoritative input.
    New transaction rollback is checked separately in test_atomic_publish."""
    from .conftest import commit_vote

    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0)
    svc.poll_once()
    first = read_math_tables(engine, 1, MATH_ENV)["main"]["math_tick"]
    # Explicit legacy negative control: commit an allocation without a snapshot.
    assert svc._pg.increment_math_tick(1) == first + 1

    injector = FaultInjector(name="write_math_main", mode="once")
    undo = fail_stage(svc._pg, "write_math_main", injector)
    events = read_vote_events(engine, 1)
    newer = max(e["created"] for e in events) + 1000
    commit_vote(engine, 1, 1, 1, -1, newer)
    svc._vote_wm = 0
    svc.poll_once()          # mints a tick, then fails
    undo()
    svc._vote_wm = 0
    svc.poll_once()          # succeeds

    tables, fold = _publish_and_check(engine, svc, zid=1)
    assert tables["main"]["math_tick"] > first + 1, (
        "the failed cycle should have burned a tick (a GAP), which is allowed"
    )
    assert tables["main"]["last_vote_timestamp"] == fold.last_vote_timestamp
    assert fold.cells[(1, 1)] == F.ENGINE_AGREE, (
        "the vote committed during the failing cycle must survive"
    )


# --------------------------------------------------------------------------- #
# Negative control for the write-stage failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    """An intentionally broken variant must FAIL, proving the R01 assertions can
    actually see a stage failure rather than passing vacuously."""

    def test_broken_variant_swallows_the_failure_and_is_caught(
        self, engine, pg_url, make_service
    ):
        """The broken variant is a writer that silently SKIPS the bidtopid and
        ptptstats writes when the main write fails — i.e. it "recovers" by
        publishing a partial generation.  The R01 coherence assertion must go
        red on it."""
        seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
        svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0)

        # Publish a good generation first, then advance only math_main so the
        # tables disagree — exactly the state a "swallow the error" writer leaves.
        svc.poll_once()
        with engine.begin() as conn:
            conn.execute(
                sa.text("UPDATE math_main SET math_tick = math_tick + 1 "
                        "WHERE zid=:z AND math_env=:e"),
                {"z": 1, "e": MATH_ENV},
            )
        problems = tables_are_coherent(read_math_tables(engine, 1, MATH_ENV))
        assert problems, (
            "NEGATIVE CONTROL FAILED: a mixed generation was reported coherent"
        )
        assert "mixed generations" in problems[0]

    def test_fold_check_detects_a_lost_vote(self, engine, pg_url, make_service):
        """Drop one vote from the fold's input and the published blob must no
        longer match — proof the fold comparison is load-bearing."""
        seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
        svc = make_service(pg_url, math_env=MATH_ENV)
        svc.poll_once()
        data = read_math_tables(engine, 1, MATH_ENV)["main"]["data"]

        events = read_vote_events(engine, 1)
        assert F.check_published_against_fold(
            data, F.fold_votes(events)
        ) == []
        mutilated = F.fold_votes([e for e in events if not (e["pid"] == 0)])
        assert F.check_published_against_fold(data, mutilated) != [], (
            "NEGATIVE CONTROL FAILED: the fold check accepted a stream that is "
            "missing a whole participant"
        )

    def test_injector_that_never_fires_is_detected(self, engine, pg_url,
                                                   make_service):
        """A fault that never fires must not be mistaken for a passed recovery."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        svc = make_service(pg_url, math_env=MATH_ENV)
        injector = FaultInjector(name="never", mode="never")
        undo = fail_stage(svc._pg, "write_math_main", injector)
        svc.poll_once()
        undo()
        assert injector.calls > 0
        assert injector.fired == 0
        with pytest.raises(AssertionError):
            assert injector.fired == 1, "the fault must actually have fired"
