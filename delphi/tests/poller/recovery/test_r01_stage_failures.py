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

from contextlib import contextmanager
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
    terminate_backend_pid,
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
    """Terminate the backend of an ACTIVE write transaction (a REAL connection
    loss on the tested path), then require bounded eventual recovery with no
    lost votes.

    The earlier version of this test terminated every backend on the database
    just BEFORE the next write and asserted only that its hook had run — which
    proves nothing: a fresh connection, or SQLAlchemy's pre-ping, can repair an
    idle killed connection without any failure ever reaching the retry path
    (review finding 5).  So instead:

    1. use the writer's supplied publication transaction and latch its
       ``pg_backend_pid()``;
    2. run the real ``math_bidtopid`` upsert inside it (uncommitted);
    3. from a SECOND connection, ``pg_terminate_backend`` exactly that pid, and
       assert Postgres says it killed it;
    4. assert a later statement or COMMIT fails with a real connection-loss
       error that propagates to the service (which retries the stage);
    5. then require quiet recovery against the independent fold.
    """
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=3)

    original = svc._pg._write_returning
    original_transaction = svc._pg.transaction
    state = {"bidtopid_calls": 0, "killed_pid": None, "terminated": None,
             "error": None, "pgcode": None, "retry_pid": None}

    @contextmanager
    def observe_transaction():
        # Observe the real writer's statement/COMMIT failure and re-raise it
        # unchanged, so the service must handle it through its normal retry.
        try:
            with original_transaction() as connection:
                yield connection
        except sa.exc.DBAPIError as exc:
            state["error"] = exc
            state["pgcode"] = getattr(exc.orig, "pgcode", None)
            raise

    def kill_the_active_backend(sql, params=None, *, connection=None):
        if "math_bidtopid" not in sql:
            return original(sql, params, connection=connection)
        state["bidtopid_calls"] += 1
        assert connection is not None and connection.in_transaction(), (
            "the kill witness must use the writer's active publication transaction"
        )
        pid = connection.execute(sa.text("select pg_backend_pid()")).scalar_one()
        assert isinstance(pid, int) and pid > 0
        result = original(sql, params, connection=connection)
        if state["bidtopid_calls"] == 1:
            # The real bidtopid upsert has run but is still uncommitted. Kill
            # this exact transaction; never create/commit a side transaction.
            state["killed_pid"] = pid
            state["terminated"] = terminate_backend_pid(recovery_postgres_url, pid)
        else:
            state["retry_pid"] = pid
        return result

    svc._pg.transaction = observe_transaction
    svc._pg._write_returning = kill_the_active_backend
    try:
        svc.poll_once()
    finally:
        svc._pg._write_returning = original
        svc._pg.transaction = original_transaction

    assert state["bidtopid_calls"] > 0, "the active-write hook was never reached"
    assert state["terminated"] is True, (
        f"pg_terminate_backend({state['killed_pid']}) did not report a kill; "
        "no connection was actually lost"
    )
    assert isinstance(state["error"], sa.exc.DBAPIError), (
        f"expected a real DBAPI failure from the killed backend, got "
        f"{state['error']!r}"
    )
    text = str(state["error"]).lower()
    assert state["pgcode"] in ("57P01", "08006", "08003", "08000") or any(
        marker in text for marker in (
            "terminating connection", "server closed the connection",
            "connection already closed", "consuming input failed",
        )
    ), (
        f"the failure must be a connection loss, not something else: pgcode="
        f"{state['pgcode']!r} error={state['error']!r}"
    )
    assert state["bidtopid_calls"] >= 2, (
        "the connection failure never reached the service's retry path: the "
        f"bidtopid stage was attempted {state['bidtopid_calls']} time(s)"
    )
    assert state["retry_pid"] != state["killed_pid"], (
        "the retry must publish through a new backend after the connection loss"
    )

    _publish_and_check(engine, svc, zid=1)


def test_terminating_an_idle_backend_is_not_evidence_of_a_failed_write(
    engine, pg_url, recovery_postgres_url, make_service
):
    """The control for the test above (review finding 5), asserted rather
    than assumed: terminating the database's backends between cycles does NOT
    surface any failure to the poller — the next cycle simply reconnects.

    That is why "a hook ran and then everything recovered" cannot be read as
    proof that a connection loss was handled."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=3)
    svc.poll_once()

    seen = {"errors": 0, "attempts": 0}
    original = svc._pg._write_returning

    def counting(sql, params=None, *, connection=None):
        seen["attempts"] += 1
        try:
            return original(sql, params, connection=connection)
        except Exception:
            seen["errors"] += 1
            raise

    svc._pg._write_returning = counting
    try:
        killed = terminate_backends(recovery_postgres_url, dbname_of(pg_url))
        assert killed >= 1, "the control needs at least one backend to kill"

        from .conftest import commit_vote
        events = read_vote_events(engine, 1)
        commit_vote(engine, 1, 0, 0, 1, max(e["created"] for e in events) + 1000)
        svc._vote_wm = 0
        svc.poll_once()
    finally:
        svc._pg._write_returning = original

    assert seen["attempts"] > 0
    assert seen["errors"] == 0, (
        "killing IDLE backends surfaced an error to the writer on this run; if "
        "that ever becomes reliable, the connection-loss test above can be "
        "simplified — but it must not be ASSUMED"
    )
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
# Object identity and `last_updated` are NOT enough: an in-place smoother or
# PCA mutation would leave both unchanged (review finding 6).  These
# helpers take a DEEP, comparable snapshot of every piece of cached state that
# can advance with a computation, so "no extra temporal advancement" is checked
# against the actual numerical state and not only against a timestamp.
_TEMPORAL_ATTRS = (
    "last_updated",          # the input watermark
    "last_mod_timestamp",
    "tid_arrival_order",     # column lineage
    "comment_count",
    "moderation_applied",
    "mod_in_tids", "mod_out_tids", "meta_tids",
    "raw_rating_mat", "rating_mat",   # the full vote cells, not aggregates
    "pca",                   # centre/comps — the geometry a recompute advances
    "proj",                  # per-participant projected positions
    "base_clusters", "group_clusters", "in_conv",
    "repness",
)


def _digest(value):
    """A stable, ``==``-comparable representation of a conversation attribute.

    NaN (an unvoted cell) is mapped to ``None`` so two identical matrices
    compare equal; floats are rounded so an exactly-repeated computation is not
    reported as a change by float noise alone.
    """
    import numpy as np
    import pandas as pd

    if isinstance(value, pd.DataFrame):
        return ("dataframe",
                [str(i) for i in value.index],
                [str(c) for c in value.columns],
                _digest(value.to_numpy(dtype=float)))
    if isinstance(value, pd.Series):
        return ("series", [str(i) for i in value.index],
                _digest(value.to_numpy()))
    if isinstance(value, np.ndarray):
        flat = np.asarray(value, dtype=float).ravel()
        return ("ndarray", list(value.shape),
                [None if v != v else round(float(v), 10) for v in flat])
    if isinstance(value, np.generic):
        return _digest(value.item())
    if isinstance(value, dict):
        return {str(k): _digest(v)
                for k, v in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, (list, tuple)):
        return [_digest(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return sorted(str(v) for v in value)
    if isinstance(value, float):
        return None if value != value else round(value, 10)
    return value


def _temporal_snapshot(conv):
    """Deep snapshot of the cached conversation's temporal + geometric state."""
    return {name: _digest(getattr(conv, name, None))
            for name in _TEMPORAL_ATTRS}


def _snapshot_diff(before, after):
    return sorted(k for k in before if before[k] != after.get(k))


def test_failed_write_leaves_prior_cached_object_unchanged(engine, pg_url,
                                                           make_service):
    """Write-before-cache (M2): on a failed write the in-memory cache must still
    hold the LAST PERSISTED conversation object — never an unpersisted one.

    Checked three ways, because the first two are individually weak (review
    finding 6): object identity, ``last_updated``, and a DEEP snapshot
    of every temporal/geometric attribute (rating matrices cell by cell, PCA
    centre and components, per-participant projections, base/group clusters,
    in-conv, repness, moderation lineage).  An in-place smoother or PCA
    mutation that left the identity and the timestamp untouched would still be
    caught by the third."""
    from .conftest import commit_vote

    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0)
    svc.poll_once()
    cached_before = svc._convs.get(1)
    assert cached_before is not None
    ts_before = cached_before.last_updated
    snapshot_before = _temporal_snapshot(cached_before)

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
    changed = _snapshot_diff(snapshot_before, _temporal_snapshot(cached_after))
    assert changed == [], (
        "a computation that never committed advanced the cached conversation's "
        f"temporal/geometric state: {changed} differ.  Timestamp equality is "
        "not enough — this is the in-place-mutation case."
    )
    # And the persisted row is still the last good one.
    main = read_math_tables(engine, 1, MATH_ENV)["main"]
    assert main["last_vote_timestamp"] == ts_before

    # Bounded eventual progress once the stage is healthy again.
    svc._vote_wm = 0
    svc.poll_once()
    tables, fold = _publish_and_check(engine, svc, zid=1)
    assert tables["main"]["last_vote_timestamp"] == newer == fold.last_vote_timestamp


def test_recovered_state_matches_a_clean_reference_computation(engine, pg_url,
                                                               make_service):
    """The successful retry's geometry and lineage must equal what a CLEAN run
    of the same inputs produces (review finding 6).

    The reference is a second service under its own math_env running the SAME
    checkpoint/restore schedule — one cold cycle over the same rows, then one
    warm cycle over the same new vote — with no failure anywhere.  The schedule
    has to match: a cold full rebuild and a warm incremental update produce
    different (both correct) geometry, because the poller does not persist warm
    smoother state (see the poller package docstring's "load-or-init finding"),
    so comparing warm-with-a-failure against cold would say nothing about the
    failure.

    Comparing the two cached conversations' deep temporal snapshots checks the
    recovered state cell by cell, rather than only the aggregate vote/count
    fields the independent fold already covers."""
    from .conftest import commit_vote

    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=3)
    ref = make_service(pg_url, math_env=MATH_ENV + "_reference", retry_cap=0)

    # Checkpoint 1: the cold cycle, identical for both.
    svc.poll_once()
    ref.poll_once()
    assert _snapshot_diff(_temporal_snapshot(ref._convs[1]),
                          _temporal_snapshot(svc._convs[1])) == [], (
        "precondition: the same inputs on the same schedule must give the same "
        "state, or this comparison cannot mean anything"
    )

    events = read_vote_events(engine, 1)
    newer = max(e["created"] for e in events) + 1000
    commit_vote(engine, 1, 0, 0, 1, newer)

    # Checkpoint 2: the warm cycle.  The subject's write fails once and the
    # service retries it within the cycle; the reference's does not fail.
    injector = FaultInjector(name="write_math_main", mode="once")
    undo = fail_stage(svc._pg, "write_math_main", injector)
    svc._vote_wm = 0
    svc.poll_once()
    undo()
    assert injector.fired == 1, "the fault must actually have fired"
    ref._vote_wm = 0
    ref.poll_once()

    recovered, clean = svc._convs.get(1), ref._convs.get(1)
    assert recovered is not None and clean is not None
    changed = _snapshot_diff(_temporal_snapshot(clean),
                             _temporal_snapshot(recovered))
    assert changed == [], (
        "the recovered conversation differs from a clean run of the same "
        f"schedule over the same input in: {changed}"
    )

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

    def test_the_temporal_snapshot_catches_an_in_place_mutation(
        self, engine, pg_url, make_service
    ):
        """The correction itself, controlled (review finding 6): mutate
        the cached conversation's PCA IN PLACE, leaving object identity and
        ``last_updated`` untouched.  The identity/timestamp assertions stay
        green; the deep snapshot must go red."""
        import numpy as np

        seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
        svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0)
        svc.poll_once()
        conv = svc._convs.get(1)
        before = _temporal_snapshot(conv)
        identity_before, ts_before = conv, conv.last_updated

        centre = np.asarray(conv.pca["center"], dtype=float)
        conv.pca["center"] = (centre + 0.5).tolist()   # an in-place advance

        assert svc._convs.get(1) is identity_before, "identity is unchanged"
        assert conv.last_updated == ts_before, "the timestamp is unchanged"
        changed = _snapshot_diff(before, _temporal_snapshot(conv))
        assert changed == ["pca"], (
            "NEGATIVE CONTROL FAILED: an in-place PCA mutation was invisible "
            f"to the temporal snapshot (diff={changed})"
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
