"""R12 — the concurrent publication cursor (REAL Postgres, two real connections).

P-022 §C required matrix:

    Two different zids publish concurrently; hold one transaction while the
    other commits and the Node prefetcher advances.  Require both conversations
    to become visible without a later update.  Exercise equal caching ticks and
    out-of-order commits; do not assume ``MAX(caching_tick)+1`` is a safe global
    change cursor.

Two halves, both real:

* the WRITER's cursor allocation — ``polismath/database/postgres.py:878``'s
  ``COALESCE((select max(caching_tick) + 1 from math_main where math_env = ?), 1)``.
  It is now evaluated inside the ONE publication transaction that also mints the
  math_tick and writes all three tables (``math_writer.py:227``), not inside a
  per-table transaction — the R05/R09 fix.  That makes the snapshot atomic but
  changes nothing here: the allocation is still a non-serializable read at READ
  COMMITTED with no uniqueness constraint on ``caching_tick``, so two zids
  publishing concurrently can still allocate the same value and still commit out
  of cursor order.  ``write_math_main`` is deliberately the last statement
  before the COMMIT so the allocate -> commit window stays as short as it was
  when each write autocommitted;

* the READER's cursor consumption — ``server/src/utils/pca.ts:98``'s
  ``select * from math_main where caching_tick > ($1) order by caching_tick
  limit 10``, with ``lastPrefetchedMathTick`` advanced to the largest
  ``caching_tick`` seen (``pca.ts:130-132``).

The writer SQL is reproduced verbatim in :func:`allocate_and_write` so a
transaction can be HELD open across the allocation; a companion test proves the
production client produces the same allocation, so the transcription is not
drifting from the code under test.
"""

import json
import threading

import pytest
import sqlalchemy as sa

from .conftest import (
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"

# Verbatim from polismath/database/postgres.py:834-847 (write_math_main).
_WRITE_MAIN_SQL = sa.text("""
    insert into math_main
        (zid, math_env, last_vote_timestamp, math_tick, data, caching_tick)
    values
        (:zid, :math_env, :last_vote_timestamp, :math_tick,
         cast(:data as jsonb),
         COALESCE((select max(caching_tick) + 1 from math_main
                   where math_env = :math_env), 1))
    on conflict (zid, math_env)
    do update set modified = now_as_millis(),
                  data = excluded.data,
                  last_vote_timestamp = excluded.last_vote_timestamp,
                  math_tick = excluded.math_tick,
                  caching_tick = excluded.caching_tick
    returning caching_tick;
""")


def allocate_and_write(conn, zid: int, math_env: str = MATH_ENV) -> int:
    """Run the production upsert on an OPEN transaction and return the
    caching_tick it allocated (without committing)."""
    return conn.execute(_WRITE_MAIN_SQL, {
        "zid": zid, "math_env": math_env, "last_vote_timestamp": 0,
        "math_tick": 1, "data": json.dumps({"zid": zid}),
    }).scalar()


class Prefetcher:
    """The server's prefetch cursor (``pca.ts:98``, ``:130-132``)."""

    def __init__(self, engine):
        self.engine = engine
        self.last = -1
        self.seen = []

    def poll(self):
        with self.engine.connect() as conn:
            rows = [dict(r) for r in conn.execute(
                sa.text("select * from math_main where caching_tick > :last "
                        "order by caching_tick limit 10"),
                {"last": self.last},
            ).mappings()]
        for row in rows:
            self.seen.append(row["zid"])
            if row["caching_tick"] > self.last:
                self.last = row["caching_tick"]
        return rows


# --------------------------------------------------------------------------- #
# The transcription matches the production client
# --------------------------------------------------------------------------- #
def test_transcribed_sql_allocates_the_same_cursor_as_the_client(engine, pg_url,
                                                                 make_service):
    """Guard against the reproduction drifting from ``write_math_main``."""
    for zid in (1, 2, 3):
        seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3)

    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                       allowlist=[1, 2])
    svc.poll_once()
    ticks = {zid: read_math_tables(engine, zid, MATH_ENV)["main"]["caching_tick"]
             for zid in (1, 2)}
    assert sorted(ticks.values()) == [1, 2], (
        f"the production client allocates a strictly increasing cursor: {ticks}"
    )

    with engine.connect() as conn:
        with conn.begin():
            allocated = allocate_and_write(conn, 3)
    assert allocated == max(ticks.values()) + 1, (
        "the transcribed SQL must allocate exactly what the client would"
    )


# --------------------------------------------------------------------------- #
# The concurrent cursor
# --------------------------------------------------------------------------- #
def test_two_concurrent_publications_allocate_the_SAME_cursor(engine, pg_url):
    """The root observation: with A's transaction still open, B's
    ``max(caching_tick)+1`` cannot see A's row, so both allocate the same
    value."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    seed_conversation(engine, zid=2, n_ptpts=4, n_cmts=3)

    conn_a = engine.connect()
    conn_b = engine.connect()
    try:
        tx_a = conn_a.begin()
        tick_a = allocate_and_write(conn_a, 1)      # NOT committed
        tx_b = conn_b.begin()
        tick_b = allocate_and_write(conn_b, 2)
        tx_b.commit()
        tx_a.commit()
    finally:
        conn_a.close()
        conn_b.close()

    assert tick_a == tick_b == 1, (
        f"two concurrent publications allocated {tick_a} and {tick_b}; "
        "MAX+1 is not a globally unique change cursor"
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (predicted by P-022 §C): MAX(caching_tick)+1 is not a safe "
        "global change cursor. polismath/database/postgres.py:878 allocates "
        "`COALESCE((select max(caching_tick)+1 from math_main where math_env = "
        "?), 1)` inside the single publication transaction that mints the "
        "math_tick and writes all three tables (math_writer.py:227). That "
        "transaction made the SNAPSHOT atomic (R05/R09) but does not serialize "
        "the allocation: it is still a plain read at READ COMMITTED with no "
        "predicate lock and no uniqueness constraint on caching_tick, so two "
        "conversations publishing concurrently allocate the SAME value; the "
        "consumer "
        "(server/src/utils/pca.ts:98, :130-132) polls `caching_tick > "
        "lastPrefetchedMathTick` and advances the cursor to the largest value "
        "it saw. If the reader advances past a value between the two commits, "
        "the later-committing row is NEVER prefetched: its conversation stays "
        "invisible to the server's PCA cache until some unrelated later update "
        "allocates a higher tick. P-022 §C: 'Require both conversations to "
        "become visible without a later update... an earlier allocated value "
        "can commit after a reader has advanced past it.' A replacement "
        "sequence alone does not fix this — it also needs a commit-order or "
        "reader-recovery argument. Separate decision."
    ),
)
def test_both_zids_become_visible_to_the_prefetcher(engine, pg_url):
    """Hold A's transaction, let B commit, let the prefetcher advance, THEN
    commit A.  Both conversations must still become visible with no later
    update."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    seed_conversation(engine, zid=2, n_ptpts=4, n_cmts=3)
    prefetcher = Prefetcher(engine)

    conn_a = engine.connect()
    conn_b = engine.connect()
    try:
        tx_a = conn_a.begin()
        allocate_and_write(conn_a, 1)          # allocated, uncommitted
        tx_b = conn_b.begin()
        allocate_and_write(conn_b, 2)
        tx_b.commit()                          # zid 2 lands first
        prefetcher.poll()                      # the reader advances past it
        tx_a.commit()                          # zid 1 lands, out of order
    finally:
        conn_a.close()
        conn_b.close()

    for _ in range(5):                         # bounded eventual visibility
        prefetcher.poll()

    assert set(prefetcher.seen) == {1, 2}, (
        f"the prefetcher only ever saw {sorted(set(prefetcher.seen))}; "
        f"cursor is at {prefetcher.last}"
    )


def test_the_invisible_row_is_present_and_correct_in_the_table(engine, pg_url):
    """Scope the defect: the row IS committed and correct — the loss is purely
    in the change cursor, so a point read still serves it while the prefetch
    cache never learns about it."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    seed_conversation(engine, zid=2, n_ptpts=4, n_cmts=3)
    prefetcher = Prefetcher(engine)

    conn_a = engine.connect()
    conn_b = engine.connect()
    try:
        tx_a = conn_a.begin()
        allocate_and_write(conn_a, 1)
        tx_b = conn_b.begin()
        allocate_and_write(conn_b, 2)
        tx_b.commit()
        prefetcher.poll()
        tx_a.commit()
    finally:
        conn_a.close()
        conn_b.close()

    assert set(prefetcher.seen) == {2}, "precondition: zid 1 was skipped"
    with engine.connect() as conn:
        row = conn.execute(
            sa.text("select zid, caching_tick from math_main where zid = 1 and "
                    "math_env = :e"), {"e": MATH_ENV},
        ).mappings().first()
    assert row is not None and row["caching_tick"] == prefetcher.last, (
        "the skipped row is committed with a caching_tick the cursor has "
        f"already passed: {dict(row) if row else None}, cursor={prefetcher.last}"
    )


def test_a_later_update_makes_the_skipped_row_visible_again(engine, pg_url,
                                                            make_service):
    """The bound on the damage: any LATER publication for that zid allocates a
    higher tick and the prefetcher picks it up.  So the defect is 'invisible
    until further traffic', which is exactly what P-022 forbids for a quiet
    conversation."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    seed_conversation(engine, zid=2, n_ptpts=4, n_cmts=3)
    prefetcher = Prefetcher(engine)

    conn_a = engine.connect()
    conn_b = engine.connect()
    try:
        tx_a = conn_a.begin()
        allocate_and_write(conn_a, 1)
        tx_b = conn_b.begin()
        allocate_and_write(conn_b, 2)
        tx_b.commit()
        prefetcher.poll()
        tx_a.commit()
    finally:
        conn_a.close()
        conn_b.close()
    assert set(prefetcher.seen) == {2}

    with engine.connect() as conn:              # a later publication for zid 1
        with conn.begin():
            allocate_and_write(conn, 1)
    prefetcher.poll()
    assert set(prefetcher.seen) == {1, 2}


def test_out_of_order_commits_of_equal_ticks_across_many_zids(engine, pg_url):
    """Three concurrent publications allocating equal ticks, committed in
    reverse order: count how many the strict cursor can ever deliver."""
    for zid in (1, 2, 3):
        seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3)
    prefetcher = Prefetcher(engine)

    conns = [engine.connect() for _ in range(3)]
    txs = []
    try:
        for conn, zid in zip(conns, (1, 2, 3)):
            txs.append(conn.begin())
            allocate_and_write(conn, zid)
        for tx in reversed(txs):                # commit in reverse order
            tx.commit()
            prefetcher.poll()
    finally:
        for conn in conns:
            conn.close()

    with engine.connect() as conn:
        ticks = {r["zid"]: r["caching_tick"] for r in conn.execute(
            sa.text("select zid, caching_tick from math_main where math_env=:e"),
            {"e": MATH_ENV}).mappings()}
    assert len(set(ticks.values())) == 1, (
        f"all three publications allocated the same cursor value: {ticks}"
    )
    assert set(prefetcher.seen) == {3}, (
        "only the FIRST committer of an equal-tick group is ever prefetched; "
        f"saw {sorted(set(prefetcher.seen))}"
    )


# --------------------------------------------------------------------------- #
# Negative control for the publication-cursor failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_a_sequence_allocated_cursor_is_unique(self, engine, pg_url):
        """Intentionally 'fixed' variant: allocate from a real Postgres
        SEQUENCE instead of MAX+1.  Concurrent transactions then get DISTINCT
        values, proving the collision above is caused by the MAX+1 allocation.

        (It does NOT make the scenario safe: the out-of-order-commit half of
        the defect survives, which is why P-022 says a replacement sequence
        alone still needs a commit-order/reader-recovery argument — asserted
        below.)"""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        seed_conversation(engine, zid=2, n_ptpts=4, n_cmts=3)
        with engine.begin() as conn:
            conn.execute(sa.text("create sequence caching_tick_seq"))

        sql = sa.text(
            "insert into math_main (zid, math_env, last_vote_timestamp, "
            "math_tick, data, caching_tick) values (:zid, :e, 0, 1, "
            "cast(:d as jsonb), nextval('caching_tick_seq')) returning "
            "caching_tick"
        )
        prefetcher = Prefetcher(engine)
        conn_a, conn_b = engine.connect(), engine.connect()
        try:
            tx_a = conn_a.begin()
            tick_a = conn_a.execute(
                sql, {"zid": 1, "e": MATH_ENV, "d": json.dumps({})}).scalar()
            tx_b = conn_b.begin()
            tick_b = conn_b.execute(
                sql, {"zid": 2, "e": MATH_ENV, "d": json.dumps({})}).scalar()
            tx_b.commit()
            prefetcher.poll()
            tx_a.commit()
        finally:
            conn_a.close()
            conn_b.close()

        assert tick_a != tick_b, (
            "NEGATIVE CONTROL FAILED: even a sequence produced colliding "
            "cursor values, so the MAX+1 finding would be misattributed"
        )
        for _ in range(3):
            prefetcher.poll()
        assert set(prefetcher.seen) == {2}, (
            "a sequence alone does NOT fix visibility: zid 1's smaller value "
            "committed after the reader advanced past it, so it is still "
            f"never delivered (saw {sorted(set(prefetcher.seen))})"
        )

    def test_the_prefetcher_model_can_see_a_normal_publication(self, engine,
                                                               pg_url,
                                                               make_service):
        """Guard against a vacuous xfail: in the ordinary (serial) case the
        prefetcher model does deliver every zid."""
        for zid in (1, 2, 3):
            seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
        svc.poll_once()
        prefetcher = Prefetcher(engine)
        for _ in range(3):
            prefetcher.poll()
        assert set(prefetcher.seen) == {1, 2, 3}
