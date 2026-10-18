"""R08 — strict ``>`` watermark boundary (REAL Postgres, two real connections).

P-022 §C required matrix:

    Commit vote A at t; poll/advance; commit B with created=t and then one with
    created<t on another connection.  Repeat for moderation, timestamp ties and
    clock skew.  Without a later vote, all committed input must eventually be
    represented.  Strict ``>`` plus max timestamp is insufficient.  Test
    overlap/dedup or durable scan/reconciliation repair; a lookback needs a
    proven bound or a repair path for older commits.

The poll queries are ``WHERE created > :since`` / ``WHERE modified > :since``
(``PostgresClient.poll_votes_since`` / ``poll_moderation_since``) and each
watermark advances to the max timestamp polled (``advance_watermark``).  The
vote poll reads ``POLL_VOTE_OVERLAP_MS`` below its watermark and drops the rows
it already handled (``VoteWindow``); ``vote_overlap_ms=0`` is the strict
cursor, kept here as the control.  The moderation poll is still strict.

Two real connections are used so the "committed later, timestamped earlier"
case is a genuine commit-order event and not a Python-side reordering.
``votes.created`` defaults to ``now_as_millis()``, the inserting transaction's
start time; most tests here supply it explicitly, which is what a
client-supplied or clock-skewed timestamp looks like, and
``test_vote_committed_after_a_later_started_vote_is_represented`` leaves it to
the default, as the server's vote route does.
"""

import time

import pytest
import sqlalchemy as sa

from .conftest import (
    commit_vote,
    drain,
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F
from tests.vote_fixtures import AGREE, DISAGREE, seed_vote

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"


def _published_fold_problems(engine, zid=1):
    tables = read_math_tables(engine, zid, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
    fold = F.fold_votes(read_vote_events(engine, zid))
    return F.check_published_against_fold(tables["main"]["data"], fold), tables, fold


# --------------------------------------------------------------------------- #
# The boundary itself
# --------------------------------------------------------------------------- #
def test_watermark_advances_to_exactly_the_max_created(engine, pg_url,
                                                       make_service):
    """Control: after a poll, the vote watermark is exactly ``max(created)``, so
    the next poll's ``created > watermark`` excludes that row."""
    seeded = seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()
    assert svc._vote_wm == max(e["created"] for e in seeded.vote_events)

    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("SELECT count(*) FROM votes WHERE created > :w"),
            {"w": svc._vote_wm},
        ).scalar()
    assert rows == 0, "the strict > boundary excludes the row it advanced onto"


def test_equal_timestamp_commit_is_eventually_represented(engine, pg_url,
                                                          make_service):
    """Commit A at t, poll (watermark -> t), then commit B with created == t on
    ANOTHER connection.  With no later vote, B must still be represented: the
    strict ``created > t`` never reads it, the overlap does."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()
    t = svc._vote_wm

    # Second, independent connection — a genuinely separate committer.
    with sa.create_engine(pg_url, poolclass=sa.pool.NullPool).connect() as conn:
        with conn.begin():
            commit_vote(conn, 1, 0, 0, F.RAW_DISAGREE, t)

    for _ in range(3):          # bounded eventual progress: repeated cycles
        svc.poll_once()

    problems, _tables, _fold = _published_fold_problems(engine, 1)
    assert problems == [], problems


def test_late_commit_with_earlier_timestamp_is_eventually_represented(
    engine, pg_url, make_service
):
    """Commit-order vs timestamp-order: B commits AFTER the poll but carries
    ``created < watermark``.

    B targets cell (0, 0), whose seeded event is the OLDEST in the stream, and
    carries a timestamp strictly between that event and the watermark — so B is
    unambiguously the cell's new winner and its absence is observable.
    """
    seeded = seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()
    t = svc._vote_wm
    oldest = min(e["created"] for e in seeded.vote_events)
    late = (oldest + t) // 2
    assert oldest < late < t

    with sa.create_engine(pg_url, poolclass=sa.pool.NullPool).connect() as conn:
        with conn.begin():
            commit_vote(conn, 1, 0, 0, F.RAW_DISAGREE, late)

    for _ in range(3):
        svc.poll_once()

    problems, _tables, _fold = _published_fold_problems(engine, 1)
    assert problems == [], problems


def _insert_vote_at_transaction_start(conn, zid, pid, tid, raw_vote):
    """INSERT one vote the way the server's vote route does: ``created`` is
    left to its column default, ``now_as_millis()``, which reads ``now()``,
    the START time of the inserting transaction. ``raw_vote`` is the stored
    value, taken from ``tests.vote_fixtures.seed_vote``. Returns the stored
    ``created``."""
    return conn.execute(
        sa.text("INSERT INTO votes (zid, pid, tid, vote) "
                "VALUES (:zid, :pid, :tid, :vote) RETURNING created"),
        {"zid": zid, "pid": pid, "tid": tid, "vote": raw_vote},
    ).scalar_one()


@pytest.mark.parametrize("strict", [False, True], ids=["overlap", "strict-control"])
def test_vote_committed_after_a_later_started_vote_is_represented(
    engine, pg_url, make_service, strict
):
    """The production interleaving, with no timestamp supplied by the test.

    Session A opens a transaction and inserts a vote; its ``created`` is A's
    start time. Session B starts later, so its vote's ``created`` is larger,
    and B commits first. The poller polls, sees only B, and its global
    watermark moves past A's ``created``. Then A commits. A is a committed vote
    on a conversation the poller holds warm, and the next poll must deliver it.

    ``strict-control`` runs the same schedule on the strict cursor
    (``vote_overlap_ms=0``) and asserts that A is missing, so the overlap is
    what delivers it.
    """
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    seed_conversation(engine, zid=2, n_ptpts=4, n_cmts=3)
    overlap = {"vote_overlap_ms": 0} if strict else {}
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1, **overlap)
    svc.poll_once()
    assert svc.is_cached(1), "precondition: conversation 1 is warm"

    session_a = sa.create_engine(pg_url, poolclass=sa.pool.NullPool)
    session_b = sa.create_engine(pg_url, poolclass=sa.pool.NullPool,
                                 isolation_level="AUTOCOMMIT")
    try:
        with session_a.connect() as a, session_b.connect() as b:
            a.begin()
            a_created = _insert_vote_at_transaction_start(
                a, 1, 0, 0, seed_vote(DISAGREE))

            # B's statements autocommit, so each runs in its own transaction
            # and reads a fresh now(). Wait for the database clock to pass A's
            # start; B's vote is then stamped strictly later than A's.
            deadline = time.monotonic() + 5.0
            while b.execute(sa.text("SELECT now_as_millis()")).scalar_one() <= a_created:
                assert time.monotonic() < deadline, "database clock did not advance"
            b_created = _insert_vote_at_transaction_start(
                b, 2, 1, 1, seed_vote(AGREE))
            assert b_created > a_created

            svc.poll_once()     # sees B only: A is not committed yet
            assert svc._vote_wm >= b_created > a_created, (
                "precondition: the watermark has moved past A's created"
            )
            a.commit()

        svc.poll_once()
    finally:
        session_a.dispose()
        session_b.dispose()

    problems, _tables, fold = _published_fold_problems(engine, 1)
    assert fold.cell_created[(0, 0)] == a_created, "A is the cell's newest vote"
    if strict:
        assert problems != [], (
            "control: the strict cursor delivered A; the schedule did not "
            "reproduce the skip"
        )
        return
    assert problems == [], (
        "a committed vote whose transaction began before a polled vote was "
        f"never delivered to the warm conversation: {problems}"
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (moderation variant of the same boundary): "
        "polismath/database/postgres.py:606 polls comments with `WHERE "
        "modified > :since` and polismath/poller/service.py:465 advances the "
        "moderation watermark to max(modified), so a moderation change whose "
        "`modified` equals the watermark is never delivered. The per-zid worker "
        "re-derives FULL moderation state once it is woken "
        "(polismath/poller/service.py:533), so the damage is bounded to 'the "
        "conversation is never woken' — but with no later vote or later "
        "moderation change, nothing wakes it."
    ),
)
def test_equal_timestamp_moderation_change_is_eventually_represented(
    engine, pg_url, make_service
):
    """The moderation loop has the same strict boundary."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()

    # Move the moderation watermark onto a real modified value.
    now = int(time.time() * 1000)
    with engine.begin() as conn:
        conn.execute(sa.text("SET session_replication_role = replica"))
        conn.execute(
            sa.text("UPDATE comments SET modified = :m WHERE zid=1 AND tid=0"),
            {"m": now},
        )
    svc.poll_once()
    assert svc._mod_wm == now

    # A second moderation action lands with modified EXACTLY on the watermark.
    with engine.begin() as conn:
        conn.execute(sa.text("SET session_replication_role = replica"))
        conn.execute(
            sa.text("UPDATE comments SET mod = -1, modified = :m "
                    "WHERE zid=1 AND tid=1"),
            {"m": now},
        )
    for _ in range(3):
        svc.poll_once()

    data = read_math_tables(engine, 1, MATH_ENV)["main"]["data"]
    with engine.connect() as conn:
        comment_rows = [dict(r) for r in conn.execute(
            sa.text("SELECT tid, mod, is_meta, modified FROM comments "
                    "WHERE zid = 1")).mappings()]
    expected = F.fold_moderation(comment_rows)
    assert set(data["moderation"]["mod_out_tids"]) == expected.mod_out_tids, (
        "the moderated-out comment must eventually be represented"
    )


def test_a_later_vote_repairs_the_skipped_boundary_row(engine, pg_url,
                                                       make_service):
    """On the strict cursor (``vote_overlap_ms=0``), the bound on the damage:
    ANY later vote on the same conversation wakes it, and the per-zid worker's
    full-history rebuild subsumes the skipped row. A vote older than the
    overlap is still skipped by the overlapping cursor, and this is how it is
    recovered."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                       conv_cache_cap=0, vote_overlap_ms=0)
    svc.poll_once()
    t = svc._vote_wm

    with sa.create_engine(pg_url, poolclass=sa.pool.NullPool).connect() as conn:
        with conn.begin():
            commit_vote(conn, 1, 0, 0, F.RAW_DISAGREE, t)      # skipped
    svc.poll_once()
    assert _published_fold_problems(engine, 1)[0] != [], (
        "precondition: the boundary row must indeed be missing at this point"
    )

    # Any later vote wakes the conversation. The cached conv is warm, so the
    # skipped row is only recovered via a full rebuild — force the rebuild path
    # the reconciler would use.
    commit_vote(engine, 1, 2, 2, F.RAW_AGREE, t + 1000)
    svc._convs.pop(1, None)
    svc.poll_once()

    problems, tables, fold = _published_fold_problems(engine, 1)
    assert problems == [], problems
    assert tables["main"]["last_vote_timestamp"] == fold.last_vote_timestamp


def test_a_warm_cached_conversation_does_not_recover_the_skipped_row(
    engine, pg_url, make_service
):
    """Scope the repair claim honestly, on the strict cursor
    (``vote_overlap_ms=0``): with a WARM cache the later vote is applied
    incrementally, so the skipped boundary row stays missing even under
    traffic.  Only a full-history rebuild (eviction, restart, reconcile)
    recovers it.  The overlapping cursor delivers this row
    (``test_equal_timestamp_commit_is_eventually_represented``)."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                       conv_cache_cap=0, vote_overlap_ms=0)
    svc.poll_once()
    t = svc._vote_wm

    with sa.create_engine(pg_url, poolclass=sa.pool.NullPool).connect() as conn:
        with conn.begin():
            commit_vote(conn, 1, 0, 0, F.RAW_DISAGREE, t)
    commit_vote(engine, 1, 2, 2, F.RAW_AGREE, t + 1000)
    svc.poll_once()             # warm cache: incremental update only

    problems, _tables, _fold = _published_fold_problems(engine, 1)
    assert problems != [], (
        "a warm incremental update cannot recover a row the strict poll never "
        "delivered; if this passes, the control is not exercising the strict "
        "cursor"
    )


# --------------------------------------------------------------------------- #
# Negative control for the timestamp-boundary failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_an_inclusive_boundary_would_deliver_the_row(self, engine, pg_url,
                                                         make_service):
        """The strict cursor (``vote_overlap_ms=0``) with its read widened by
        hand to ``created > watermark - 1``: the boundary row is delivered,
        proving the strict-cursor failures here are caused by the strict
        boundary and not by the fixture."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                           conv_cache_cap=0, vote_overlap_ms=0)
        svc.poll_once()
        t = svc._vote_wm

        with sa.create_engine(pg_url, poolclass=sa.pool.NullPool).connect() as c:
            with c.begin():
                commit_vote(c, 1, 0, 0, F.RAW_DISAGREE, t)

        real_poll = svc._pg.poll_votes_since
        svc._pg.poll_votes_since = lambda since: real_poll(since - 1)
        svc._convs.pop(1, None)
        svc.poll_once()
        svc._pg.poll_votes_since = real_poll

        problems, _tables, _fold = _published_fold_problems(engine, 1)
        assert problems == [], (
            "NEGATIVE CONTROL FAILED: even an overlapping poll window did not "
            f"deliver the boundary row ({problems})"
        )

    def test_the_row_really_is_committed(self, engine, pg_url, make_service):
        """Guard against a vacuous control: the boundary row must actually be
        in the votes table."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
        svc.poll_once()
        t = svc._vote_wm
        with sa.create_engine(pg_url, poolclass=sa.pool.NullPool).connect() as c:
            with c.begin():
                commit_vote(c, 1, 0, 0, F.RAW_DISAGREE, t)
        events = read_vote_events(engine, 1)
        assert any(e["created"] == t and e["pid"] == 0 and e["tid"] == 0
                   and e["vote"] == F.RAW_DISAGREE for e in events), (
            "the boundary vote was never committed; the boundary tests would "
            "be vacuous"
        )
