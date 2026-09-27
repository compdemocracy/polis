"""R08 — strict ``>`` watermark boundary (REAL Postgres, two real connections).

P-022 §C required matrix:

    Commit vote A at t; poll/advance; commit B with created=t and then one with
    created<t on another connection.  Repeat for moderation, timestamp ties and
    clock skew.  Without a later vote, all committed input must eventually be
    represented.  Strict ``>`` plus max timestamp is insufficient.  Test
    overlap/dedup or durable scan/reconciliation repair; a lookback needs a
    proven bound or a repair path for older commits.

The poll queries are ``WHERE created > :since`` / ``WHERE modified > :since``
(``polismath/database/postgres.py:572``, ``:606``) and the watermark advances to
``max(created)`` (``polismath/poller/service.py:40``).  Two real connections are
used so the "committed later, timestamped earlier" case is a genuine commit-order
event and not a Python-side reordering: ``votes.created`` defaults to
``now_as_millis()`` but is explicitly supplied here, which is exactly what a
client-supplied or clock-skewed timestamp looks like.
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


@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (predicted by P-022 §C): a vote committed with created EXACTLY "
        "equal to the current watermark is never delivered. "
        "polismath/database/postgres.py:572 polls `WHERE created > :since` and "
        "polismath/poller/service.py:40 advances the watermark to max(created) "
        "of the rows it just saw, so the boundary row is skipped by the very "
        "poll that moved onto it. Nothing repairs it: the parked-zid "
        "reconciler (polismath/poller/service.py:393) only visits zids that "
        "FAILED, and a never-polled late commit creates no parked marker. "
        "Without a later vote on the same conversation the input is silently "
        "absent from math_main indefinitely. P-022 §C: 'Without a later vote, "
        "all committed input must eventually be represented. Strict > plus max "
        "timestamp is insufficient.' The fix is an overlap/dedup window or a "
        "durable scan; that is a separate decision."
    ),
)
def test_equal_timestamp_commit_is_eventually_represented(engine, pg_url,
                                                          make_service):
    """Commit A at t, poll (watermark -> t), then commit B with created == t on
    ANOTHER connection.  With no later vote, B must still be represented."""
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


@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (same root cause, clock-skew / late-commit variant): a vote "
        "COMMITTED after the poll but TIMESTAMPED before the watermark is never "
        "delivered either. votes.created is a client/server-supplied bigint "
        "(server/postgres/migrations/000000_initial.sql: `created bigint "
        "default now_as_millis()`), so commit order and timestamp order are "
        "independent; polismath/database/postgres.py:572's `created > :since` "
        "keys on the timestamp alone. There is no repair path for a "
        "never-polled commit — see the equal-timestamp case above."
    ),
)
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
    """The bound on the damage: ANY later vote on the same conversation wakes
    it, and the per-zid worker's full-history rebuild subsumes the skipped row.
    So the defect is 'no repair without further traffic', not 'lost forever
    under traffic' — asserted so the xfails above are correctly scoped."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                       conv_cache_cap=0)
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
    """Scope the repair claim honestly: with a WARM cache the later vote is
    applied incrementally, so the skipped boundary row stays missing even under
    traffic.  Only a full-history rebuild (eviction, restart, reconcile)
    recovers it."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                       conv_cache_cap=0)
    svc.poll_once()
    t = svc._vote_wm

    with sa.create_engine(pg_url, poolclass=sa.pool.NullPool).connect() as conn:
        with conn.begin():
            commit_vote(conn, 1, 0, 0, F.RAW_DISAGREE, t)
    commit_vote(engine, 1, 2, 2, F.RAW_AGREE, t + 1000)
    svc.poll_once()             # warm cache: incremental update only

    problems, _tables, _fold = _published_fold_problems(engine, 1)
    assert problems != [], (
        "a warm incremental update cannot recover a row the poll never "
        "delivered; if this passes, the scoping of the R08 xfails is wrong"
    )


# --------------------------------------------------------------------------- #
# Negative control for the timestamp-boundary failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_an_inclusive_boundary_would_deliver_the_row(self, engine, pg_url,
                                                         make_service):
        """Intentionally 'fixed' variant: poll with an OVERLAP window
        (``created > watermark - overlap``).  The same scenario then passes,
        proving the xfails above are caused by the strict boundary and not by
        the fixture."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                           conv_cache_cap=0)
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
        """Guard against a vacuous xfail: the boundary row must actually be in
        the votes table."""
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
            "the boundary vote was never committed; the R08 xfails would be "
            "vacuous"
        )
