"""Delphi turns a DB vote into a semantic vote in exactly one place.

``votes.vote`` holds the raw storage sign; the engine and the narrative
pipeline count +1 as agree. The math stage's ``run_math_pipeline.main`` fed the
raw column straight to the engine (the missing flip), and the narrative loader
and the poller each carried a private ``pg_vote * -1``. All three now go
through ``vote_convention.load_semantic_votes``.

Every vote value in this file is derived from the convention's named values
(``storage_vote(SEMANTIC_AGREE)`` and so on), never written as a bare sign.
"""

import inspect

import pytest

import polismath.utils.vote_convention as vc
from polismath.utils.vote_convention import (
    SEMANTIC_AGREE,
    SEMANTIC_DISAGREE,
    SEMANTIC_PASS,
    STORAGE_AGREE_VALUE,
    VoteConventionError,
    load_semantic_votes,
    semantic_vote,
    storage_vote,
)
from tests.test_run_math_pipeline_main import run_main  # noqa: F401  (fixture)

RAW_AGREE = storage_vote(SEMANTIC_AGREE)
RAW_DISAGREE = storage_vote(SEMANTIC_DISAGREE)
RAW_PASS = storage_vote(SEMANTIC_PASS)


# --- the loader itself -------------------------------------------------------


def test_load_semantic_votes_applies_the_one_formula_and_copies_rows():
    rows = [
        {"pid": 1, "tid": 10, "vote": RAW_AGREE},
        {"pid": 2, "tid": 10, "vote": RAW_DISAGREE},
        {"pid": 3, "tid": 10, "vote": RAW_PASS},
    ]
    out = load_semantic_votes(rows)
    assert [r["vote"] for r in out] == [SEMANTIC_AGREE, SEMANTIC_DISAGREE, SEMANTIC_PASS]
    assert [r["vote"] for r in out] == [semantic_vote(r["vote"]) for r in rows]
    assert [r["pid"] for r in out] == [1, 2, 3]
    # The input rows are untouched.
    assert [r["vote"] for r in rows] == [RAW_AGREE, RAW_DISAGREE, RAW_PASS]


def test_load_semantic_votes_follows_a_declared_convention():
    other = vc.flipped(STORAGE_AGREE_VALUE)
    rows = [{"vote": storage_vote(SEMANTIC_AGREE, other)}]
    assert load_semantic_votes(rows, storage_agree_value=other)[0]["vote"] == SEMANTIC_AGREE


def test_load_semantic_votes_null_policy():
    rows = [{"vote": None}]
    with pytest.raises(VoteConventionError):
        load_semantic_votes(rows)
    assert load_semantic_votes(rows, null_policy="keep") == [{"vote": None}]
    with pytest.raises(VoteConventionError):
        load_semantic_votes(rows, null_policy="zero")


# --- the math stage: run_math_pipeline.main ----------------------------------


def test_math_stage_feeds_the_engine_semantic_votes(run_main):
    # A generated fixture conversation: one agree and one disagree, as stored.
    rows = [
        (1000, 7, 1, RAW_AGREE),
        (2000, 7, 2, RAW_DISAGREE),
    ]
    exit_code, fed = run_main(rows)
    assert exit_code == 0
    by_pid = {v["pid"]: v["vote"] for v in fed}
    assert by_pid == {"1": SEMANTIC_AGREE, "2": SEMANTIC_DISAGREE}
    assert [v["tid"] for v in fed] == ["7", "7"]


def test_math_stage_keeps_pass_as_pass(run_main):
    _, fed = run_main([(1000, 7, 1, RAW_PASS)])
    assert [v["vote"] for v in fed] == [SEMANTIC_PASS]


def test_math_stage_reads_the_database_convention(run_main):
    """With the vote_convention row (P-078 PR-A) at the other sign, the stage
    converts each page by the row read in the same statement."""
    other = vc.flipped(STORAGE_AGREE_VALUE)
    rows = [
        (1000, 7, 1, storage_vote(SEMANTIC_AGREE, other)),
        (2000, 7, 2, storage_vote(SEMANTIC_DISAGREE, other)),
    ]
    exit_code, fed = run_main(rows, convention_row=(1, other))
    assert exit_code == 0
    assert {v["pid"]: v["vote"] for v in fed} == {"1": SEMANTIC_AGREE, "2": SEMANTIC_DISAGREE}


def test_math_stage_skips_a_null_vote(run_main):
    """float(None) used to raise here. NULL is not a vote."""
    exit_code, fed = run_main([(1000, 7, 1, RAW_AGREE), (2000, 7, 2, None)])
    assert exit_code == 0
    assert [(v["pid"], v["vote"]) for v in fed] == [("1", SEMANTIC_AGREE)]


def test_math_stage_matches_the_other_math_loader(run_main, monkeypatch):
    """main() and fetch_votes (already on the convention) now agree."""
    import polismath.run_math_pipeline as rmp

    rows = [(1000, 7, 1, RAW_AGREE), (2000, 8, 2, RAW_DISAGREE), (3000, 9, 3, RAW_PASS)]
    _, fed = run_main(rows)

    class DictCursor:
        def execute(self, sql, params):
            pass

        def fetchall(self):
            return [
                {"timestamp": c, "comment_id": tid, "voter_id": pid, "vote": vote}
                for c, tid, pid, vote in rows
            ]

        def close(self):
            pass

    class Conn:
        def cursor(self, cursor_factory=None):
            return DictCursor()

    fetched = rmp.fetch_votes(Conn(), 1)["votes"]
    assert [(v["pid"], v["tid"], v["vote"]) for v in fed] == [
        (v["pid"], v["tid"], v["vote"]) for v in fetched
    ]


# --- the two former private `* -1` copies ------------------------------------


GENERATED_ROWS = [
    {"zid": 1, "pid": 1, "tid": 10, "vote": RAW_AGREE},
    {"zid": 1, "pid": 2, "tid": 10, "vote": RAW_DISAGREE},
    {"zid": 1, "pid": 3, "tid": 10, "vote": RAW_PASS},
    {"zid": 1, "pid": 4, "tid": 10, "vote": None},
]


def _expected():
    return [
        {**r, "vote": None if r["vote"] is None else semantic_vote(r["vote"], STORAGE_AGREE_VALUE)}
        for r in GENERATED_ROWS
    ]


def _narrative_client():
    from umap_narrative.polismath_commentgraph.utils import storage

    client = storage.PostgresClient.__new__(storage.PostgresClient)
    client.query = lambda sql, params=None: [dict(r) for r in GENERATED_ROWS]
    return storage, client


def _poller_client():
    import scripts.job_poller as jp

    client = jp.PostgresClient.__new__(jp.PostgresClient)
    client.query = lambda sql, params=None: [dict(r) for r in GENERATED_ROWS]
    return jp, client


@pytest.mark.parametrize("make", [_narrative_client, _poller_client], ids=["storage.py", "job_poller.py"])
def test_former_private_copy_sites_match_the_convention(make):
    module, client = make()
    out = client.get_votes_by_conversation(1)
    assert out == _expected()
    assert [r["vote"] for r in out] == [SEMANTIC_AGREE, SEMANTIC_DISAGREE, SEMANTIC_PASS, None]
    # The private copy is gone and the module routes through the convention.
    assert not hasattr(module, "_postgres_vote_to_delphi")
    assert "* -1" not in inspect.getsource(module)
    assert "load_semantic_votes" in inspect.getsource(module.PostgresClient.get_votes_by_conversation)
