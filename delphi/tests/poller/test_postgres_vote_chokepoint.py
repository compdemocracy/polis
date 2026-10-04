"""PostgresClient's vote reads go through the one vote convention (P-078 PR-C).

No live Postgres: ``PostgresClient.query`` is replaced by a recorder that
answers the convention probe and returns canned ``votes`` rows, so the real
SQL construction and row conversion in postgres.py run. Vote values are
derived from the convention's named values.
"""

from __future__ import annotations

import pytest

from polismath.database.postgres import PostgresClient, PostgresConfig
from polismath.utils.vote_convention import (
    CONVENTION_PRESENT_SQL,
    CONVENTION_ROW_SQL,
    ROW_AGREE_KEY,
    ROW_VERSION_KEY,
    SEMANTIC_AGREE,
    SEMANTIC_DISAGREE,
    SEMANTIC_PASS,
    STORAGE_AGREE_VALUE,
    ConstantConventionSource,
    flipped,
    storage_vote,
)

TODAY = STORAGE_AGREE_VALUE
OTHER = flipped(STORAGE_AGREE_VALUE)


class Recorder:
    def __init__(self, vote_rows, row=None):
        self.vote_rows, self.row, self.sql = vote_rows, row, []

    def __call__(self, sql, params=None):
        self.sql.append(sql)
        if sql == CONVENTION_PRESENT_SQL:
            return [{"present": self.row is not None}]
        if sql == CONVENTION_ROW_SQL:
            return [{"version": self.row[0], "agree_value": self.row[1]}]
        joined = "vote_convention_current()" in sql
        return [dict(r, **({ROW_VERSION_KEY: self.row[0], ROW_AGREE_KEY: self.row[1]} if joined else {}))
                for r in self.vote_rows]

    def vote_sql(self):
        return [s for s in self.sql if "FROM votes" in s]

    def probes(self):
        return self.sql.count(CONVENTION_PRESENT_SQL)


def stored(agree_value):
    return [
        {"zid": 1, "tid": 10, "pid": 1, "vote": storage_vote(SEMANTIC_AGREE, agree_value), "created": 1000},
        {"zid": 1, "tid": 10, "pid": 2, "vote": storage_vote(SEMANTIC_DISAGREE, agree_value), "created": 1001},
        {"zid": 1, "tid": 10, "pid": 3, "vote": storage_vote(SEMANTIC_PASS, agree_value), "created": 1002},
    ]


def client(recorder, **kwargs):
    c = PostgresClient(PostgresConfig(url="postgresql://ignored/db", math_env="t3"), **kwargs)
    c.query = recorder
    return c


EXPECTED = [SEMANTIC_AGREE, SEMANTIC_DISAGREE, SEMANTIC_PASS]


def test_without_the_row_reads_at_the_constant():
    rec = Recorder(stored(TODAY))
    c = client(rec)
    assert [v["vote"] for v in c.poll_votes(1)] == EXPECTED
    assert [v["vote"] for v in c.poll_votes_since(0)] == EXPECTED
    assert rec.probes() == 1  # once per cycle
    for sql in rec.vote_sql():
        assert "IS NOT NULL" not in sql  # NULL rows are not filtered (as before)
        assert "vote_convention_current" not in sql
        assert sql.rstrip().endswith("ORDER BY v.zid, v.tid, v.pid, v.created")
    c.begin_convention_cycle()
    c.poll_votes(1)
    assert rec.probes() == 2


@pytest.mark.parametrize("agree_value", [TODAY, OTHER])
def test_with_the_row_the_sign_is_read_in_the_same_statement(agree_value):
    rec = Recorder(stored(agree_value), row=(1, agree_value))
    c = client(rec)
    votes = c.poll_votes(1)
    assert [v["vote"] for v in votes] == EXPECTED
    assert set(votes[0]) == {"pid", "tid", "vote", "created"}
    since = c.poll_votes_since(0)
    assert [v["vote"] for v in since] == EXPECTED
    assert set(since[0]) == {"zid", "pid", "tid", "vote", "created"}
    assert c.storage_agree_value == agree_value
    for sql in rec.vote_sql():
        assert "LEFT JOIN public.vote_convention_current() AS vc ON true" in sql


def test_the_statement_wins_over_a_stale_cached_row():
    """The row flips between the cycle's probe and the vote read: each vote is
    converted by the convention of the snapshot it was read in."""
    rec = Recorder(stored(OTHER), row=(0, TODAY))
    c = client(rec)
    assert c.storage_agree_value == TODAY  # cached for this cycle
    rec.row = (1, OTHER)  # the flip commits
    assert [v["vote"] for v in c.poll_votes(1)] == EXPECTED


@pytest.mark.parametrize("poll", ["poll_votes", "poll_votes_since"])
def test_a_null_vote_fails_the_poll_as_before(poll):
    """Unchanged behaviour: the readers call int() on each vote, so a NULL row
    raises TypeError and the poll fails rather than skipping it. Whether NULL
    should be skipped is an open question, not decided here."""
    rows = stored(TODAY) + [{"zid": 1, "tid": 11, "pid": 4, "vote": None, "created": 1003}]
    c = client(Recorder(rows))
    with pytest.raises(TypeError):
        getattr(c, poll)(1) if poll == "poll_votes" else c.poll_votes_since(0)


def test_a_declared_sign_does_not_ask_the_database():
    rec = Recorder(stored(OTHER))
    c = client(rec, storage_agree_value=OTHER)
    assert [v["vote"] for v in c.poll_votes(1)] == EXPECTED
    assert rec.probes() == 0


def test_an_injected_source():
    rec = Recorder(stored(OTHER))
    c = client(rec, convention_source=ConstantConventionSource(OTHER))
    assert [v["vote"] for v in c.poll_votes_since(0)] == EXPECTED
    with pytest.raises(ValueError):
        client(rec, storage_agree_value=OTHER, convention_source=ConstantConventionSource(OTHER))
