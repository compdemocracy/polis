"""``math_recompute_log`` and ``math_priorities_history`` against a real Postgres.

Same database resolution as the other poller integration tests
(``require_polis_postgres``: the CI service, else a throwaway postgres:17 on an
ephemeral port). The writer runs for real (``MathWriter`` over
``PostgresClient``) on a real engine generation; every test uses its own
``math_env`` label and zid, and removes its rows afterwards.

What is pinned: one log row per published tick, carrying the generation's own
``last_vote_timestamp`` and comment count; the history row only when the flag is
on, equal to the served ``comment-priorities``; a failure later in the
publication leaving no tick, no log row and no history row behind; and a
republication after the tick row was removed (a reset restarts the tick
sequence) succeeding rather than colliding with the old log row.

Promotion (``PostgresClient.promote_bundle``, MATH_CAPACITY_PROMOTE=1) mints a
tick on the target label too, so it copies the staged generation's log row
(and its history row, when there is one) to that tick in the same
transaction; a staged generation published before the log existed still gets
a target log row, derived from the copied math_main. A refused promotion
leaves no target row. Every test runs against both payload column types (json,
as production has it, and jsonb, as the migrations declare it).
"""

import time
import uuid
from unittest.mock import patch

import psycopg2
import pytest

from polismath.conversation.conversation import Conversation
from polismath.database.postgres import PostgresClient, PostgresConfig, PromotionRefused
from polismath.poller.math_writer import MathWriter
from tests.conftest import require_polis_postgres
from tests.poller.test_backfill_postgres import set_payload_type
from tests.vote_fixtures import AGREE, DISAGREE

pytestmark = [pytest.mark.integration]

CLOCK_MS = 1700000000000


@pytest.fixture(scope="module", params=["json", "jsonb"])
def pg_url(request):
    with require_polis_postgres() as url:
        set_payload_type(url, request.param)
        try:
            yield url
        finally:
            set_payload_type(url, "jsonb")  # the migrations' type, as found


@pytest.fixture
def db(pg_url):
    conn = psycopg2.connect(pg_url)
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture
def label():
    return f"rlog_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def staged_label(db):
    """A second label: the large class's staging label in a promotion."""
    staged = f"rlogstg_{uuid.uuid4().hex[:8]}"
    yield staged
    for table in ("math_priorities_history", "math_recompute_log", "math_main",
                  "math_bidtopid", "math_ptptstats", "math_ticks"):
        q(db, f"DELETE FROM {table} WHERE math_env = %s", (staged,))


@pytest.fixture
def zid(db, label):
    zid = 900000 + uuid.uuid4().int % 90000
    q(db, "SET session_replication_role = replica")
    q(db, "DELETE FROM conversations WHERE zid = %s", (zid,))
    q(db, "INSERT INTO conversations (zid) VALUES (%s)", (zid,))
    q(db, "SET session_replication_role = DEFAULT")
    yield zid
    for table in ("math_priorities_history", "math_recompute_log", "math_main",
                  "math_bidtopid", "math_ptptstats", "math_ticks"):
        q(db, f"DELETE FROM {table} WHERE math_env = %s", (label,))
    q(db, "SET session_replication_role = replica")
    q(db, "DELETE FROM conversations WHERE zid = %s", (zid,))
    q(db, "SET session_replication_role = DEFAULT")


def q(conn, sql, params=None) -> list:
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchall() if cur.description else []


def _client(url, label):
    return PostgresClient(PostgresConfig(url=url, math_env=label, ssl_mode="disable"))


def _conversation(zid, participants=12, statements=4):
    """A small computed generation with a non-empty comment-priorities map."""
    votes = []
    for pid in range(participants):
        for tid in range(statements):
            vote = DISAGREE if tid == 2 and pid >= participants // 2 else AGREE
            votes.append({"pid": pid, "tid": tid, "vote": vote,
                          "created": CLOCK_MS + len(votes)})
    with patch("time.time", return_value=CLOCK_MS / 1000):
        return Conversation(zid).update_votes({"votes": votes})


def _log_rows(db, zid, label):
    return q(db, "SELECT math_tick, last_vote_timestamp, n_votes, n_comments, created "
                 "FROM math_recompute_log WHERE zid = %s AND math_env = %s "
                 "ORDER BY math_tick", (zid, label))


def _history(db, zid, label):
    return q(db, "SELECT math_tick, priorities FROM math_priorities_history "
                 "WHERE zid = %s AND math_env = %s ORDER BY math_tick", (zid, label))


def _served(db, zid, label):
    """(math_tick, last_vote_timestamp, comment-priorities) as the server reads it."""
    return q(db, "SELECT math_tick, last_vote_timestamp, data->'comment-priorities' "
                 "FROM math_main WHERE zid = %s AND math_env = %s", (zid, label))[0]


def test_every_tick_gets_a_log_row_and_no_history_by_default(pg_url, db, zid, label):
    pg = _client(pg_url, label)
    conv = _conversation(zid)
    before = int(time.time() * 1000)
    first = MathWriter(pg).write_conv_updates(zid, conv)
    second = MathWriter(pg).write_conv_updates(zid, conv, n_votes=48)

    tick, lvt, priorities = _served(db, zid, label)
    assert tick == second and second == first + 1
    assert len(priorities) > 0
    rows = _log_rows(db, zid, label)
    assert [r[0] for r in rows] == [first, second]
    assert rows[0][1:4] == (lvt, None, len(priorities))
    assert rows[1][1:4] == (lvt, 48, len(priorities))
    assert all(r[4] >= before - 1000 for r in rows)  # created defaults to now
    assert _history(db, zid, label) == []


def test_history_flag_stores_the_served_priorities(pg_url, db, zid, label):
    pg = _client(pg_url, label)
    tick = MathWriter(pg, priorities_history=True).write_conv_updates(
        zid, _conversation(zid), n_votes=7)
    served_tick, _, priorities = _served(db, zid, label)
    assert served_tick == tick
    assert _history(db, zid, label) == [(tick, priorities)]
    assert _log_rows(db, zid, label)[0][2:4] == (7, len(priorities))


def test_a_failed_publication_leaves_no_tick_and_no_log(pg_url, db, zid, label):
    pg = _client(pg_url, label)
    writer = MathWriter(pg, priorities_history=True)
    first = writer.write_conv_updates(zid, _conversation(zid))
    with (patch.object(pg, "write_math_main", side_effect=RuntimeError("boom")),
          pytest.raises(RuntimeError, match="boom")):
        writer.write_conv_updates(zid, _conversation(zid))
    assert q(db, "SELECT math_tick FROM math_ticks WHERE zid = %s AND math_env = %s",
             (zid, label)) == [(first,)]
    assert [r[0] for r in _log_rows(db, zid, label)] == [first]
    assert [r[0] for r in _history(db, zid, label)] == [first]


def test_republishing_after_a_tick_reset_overwrites_the_old_row(pg_url, db, zid, label):
    pg = _client(pg_url, label)
    writer = MathWriter(pg, priorities_history=True)
    first = writer.write_conv_updates(zid, _conversation(zid), n_votes=1)
    q(db, "DELETE FROM math_ticks WHERE zid = %s AND math_env = %s", (zid, label))
    again = writer.write_conv_updates(zid, _conversation(zid, participants=14), n_votes=2)
    assert again == first
    rows = _log_rows(db, zid, label)
    assert [(r[0], r[2]) for r in rows] == [(first, 2)]
    _, _, priorities = _served(db, zid, label)
    assert _history(db, zid, label) == [(first, priorities)]


# --------------------------------------------------------------------------- #
# promote_bundle: the promoted tick gets the staged generation's log row.
# --------------------------------------------------------------------------- #
def _stage(pg_url, staged_label, zid, *, history, n_votes=5, participants=12):
    spg = _client(pg_url, staged_label)
    MathWriter(spg, priorities_history=history).write_conv_updates(
        zid, _conversation(zid, participants=participants), n_votes=n_votes)
    return spg


def _promote(pg_url, label, staged_label, zid):
    tpg = _client(pg_url, label)
    staged = tpg.math_fingerprints([zid], [staged_label])[(zid, staged_label)]
    target = tpg.math_fingerprints([zid], [label]).get((zid, label))
    return tpg, staged, tpg.promote_bundle(zid, from_env=staged_label, to_env=label,
                                           expected_target=target, expected_staged=staged)


def test_promotion_copies_the_staged_log_and_history_rows(
        pg_url, db, zid, label, staged_label):
    _stage(pg_url, staged_label, zid, history=True, n_votes=5)
    (staged_row,) = _log_rows(db, zid, staged_label)
    (staged_hist,) = _history(db, zid, staged_label)
    _, _, tick = _promote(pg_url, label, staged_label, zid)

    served_tick, lvt, priorities = _served(db, zid, label)
    assert served_tick == tick
    (row,) = _log_rows(db, zid, label)
    assert row[0] == tick
    assert row[1:4] == staged_row[1:4] == (lvt, 5, len(priorities))
    assert _history(db, zid, label) == [(tick, staged_hist[1])]
    assert staged_hist[1] == priorities


def test_promotion_without_staged_history_writes_no_history(
        pg_url, db, zid, label, staged_label):
    _stage(pg_url, staged_label, zid, history=False)
    _, _, tick = _promote(pg_url, label, staged_label, zid)
    assert [r[0] for r in _log_rows(db, zid, label)] == [tick]
    assert _history(db, zid, label) == []


def test_promotion_of_a_generation_published_before_the_log_still_logs_the_tick(
        pg_url, db, zid, label, staged_label):
    """A staged bundle written before this change has no log row; the
    promoted tick still gets one, from the copied math_main (n_votes
    unknown)."""
    _stage(pg_url, staged_label, zid, history=False)
    q(db, "DELETE FROM math_recompute_log WHERE zid = %s AND math_env = %s",
      (zid, staged_label))
    _, _, tick = _promote(pg_url, label, staged_label, zid)
    _, lvt, priorities = _served(db, zid, label)
    assert len(priorities) > 0
    assert [r[:4] for r in _log_rows(db, zid, label)] == [(tick, lvt, None, len(priorities))]


def test_a_refused_promotion_leaves_no_target_log_row(pg_url, db, zid, label, staged_label):
    _stage(pg_url, staged_label, zid, history=True)
    tpg = _client(pg_url, label)
    staged = tpg.math_fingerprints([zid], [staged_label])[(zid, staged_label)]
    with pytest.raises(PromotionRefused):
        tpg.promote_bundle(zid, from_env=staged_label, to_env=label,
                           expected_target=staged,  # wrong: the target is empty
                           expected_staged=staged)
    assert _log_rows(db, zid, label) == []
    assert _history(db, zid, label) == []
    assert q(db, "SELECT 1 FROM math_ticks WHERE zid = %s AND math_env = %s",
             (zid, label)) == []


def test_promotion_onto_a_reset_tick_overwrites_the_old_target_row(
        pg_url, db, zid, label, staged_label):
    """The target's own publication logged tick T; its math_ticks row is then
    removed, so the promotion mints T again and must replace that row."""
    first = MathWriter(_client(pg_url, label), priorities_history=True).write_conv_updates(
        zid, _conversation(zid), n_votes=1)
    q(db, "DELETE FROM math_ticks WHERE zid = %s AND math_env = %s", (zid, label))
    _stage(pg_url, staged_label, zid, history=True, n_votes=9, participants=14)
    _, _, tick = _promote(pg_url, label, staged_label, zid)
    assert tick == first
    _, lvt, priorities = _served(db, zid, label)
    assert [r[:4] for r in _log_rows(db, zid, label)] == [(tick, lvt, 9, len(priorities))]
    assert _history(db, zid, label) == [(tick, priorities)]


# --------------------------------------------------------------------------- #
# Startup schema check: the poller refuses a database without migration 000044.
# --------------------------------------------------------------------------- #
def test_schema_check_passes_on_a_migrated_database(pg_url, label):
    from polismath.poller.service import require_recompute_log_schema

    require_recompute_log_schema(_client(pg_url, label))


def test_schema_check_refuses_a_database_without_000044(pg_url, db, label):
    from polismath.poller.service import SchemaNotReady, require_recompute_log_schema

    bare = f"rlog_bare_{uuid.uuid4().hex[:8]}"
    q(db, f'CREATE DATABASE "{bare}"')
    try:
        url = pg_url.rsplit("/", 1)[0] + "/" + bare
        pg = _client(url, label)
        try:
            with pytest.raises(SchemaNotReady, match="000044_routing_propensities"):
                require_recompute_log_schema(pg)
        finally:
            pg.shutdown()
    finally:
        q(db, f'DROP DATABASE IF EXISTS "{bare}" WITH (FORCE)')
