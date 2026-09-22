"""Zero-vote moderation publishes through the real poller and migrated DB."""
import json
from pathlib import Path
import time
from unittest.mock import patch

import pytest
import sqlalchemy as sa

from .conftest import seed_conversation, read_math_tables, tables_are_coherent, commit_vote

pytestmark = pytest.mark.recovery
SCHEDULE = Path(__file__).resolve().parents[3] / "scripts/schedules/pc-zerovote-01-empty.json"


def assert_empty(tables):
    assert tables_are_coherent(tables) == []
    main = tables["main"]
    assert main["last_vote_timestamp"] == 0
    for path, expected in json.loads(SCHEDULE.read_text())["empty_output"].items():
        value = main["data"]
        for key in path.split("."):
            value = value[key]
        assert type(value) is type(expected) and value == expected, path
    for kind in ("main", "bidtopid", "ptptstats"):
        assert tables[kind]["data"]["lastVoteTimestamp"] == 0
    assert tables["bidtopid"]["data"]["bidToPid"] == []
    assert tables["ptptstats"]["data"]["ptptstats"] == {}


def trigger(engine, mod):
    with engine.begin() as conn:
        conn.execute(sa.text("UPDATE comments SET mod=:m,modified=:t WHERE zid=1"),
                     {"m": mod, "t": int(time.time()*1000)})


def test_moderation_empty_publish_restart_and_first_vote(engine, pg_url, make_service):
    # Comments exist; there are no participants/votes. An untouched old
    # conversation has no trigger and must not acquire an invented row.
    seed_conversation(engine, zid=1, n_ptpts=0, n_cmts=2)
    svc = make_service(pg_url)
    svc.poll_once()
    assert read_math_tables(engine, 1, "recovery")["main"] is None
    trigger(engine, -1)
    svc.poll_once()
    first = read_math_tables(engine, 1, "recovery")
    assert_empty(first)
    assert first["main"]["math_tick"] == 0
    assert read_math_tables(engine, 1, "prod")["main"] is None
    # Fresh process state must restore and republish the same declared shape.
    fresh = make_service(pg_url)
    fresh.poll_once()
    after = read_math_tables(engine, 1, "recovery")
    assert_empty(after)
    assert after["main"]["math_tick"] > first["main"]["math_tick"]
    # Warm unmoderation is also a valid empty-compute trigger.
    trigger(engine, 0)
    fresh.poll_once()
    assert_empty(read_math_tables(engine, 1, "recovery"))
    created = int(time.time()*1000)
    commit_vote(engine, 1, 0, 0, -1, created)
    fresh.poll_once()
    voted = read_math_tables(engine, 1, "recovery")
    assert tables_are_coherent(voted) == []
    assert voted["main"]["data"]["n"] == 1
    assert voted["main"]["data"]["tids"] == [0]
    assert voted["main"]["last_vote_timestamp"] == created


@pytest.mark.parametrize("stage", ["write_math_bidtopid", "write_participant_stats", "write_math_main"])
def test_empty_publication_rollback_and_retry(engine, pg_url, make_service, stage):
    seed_conversation(engine, zid=1, n_ptpts=0, n_cmts=1)
    svc = make_service(pg_url)
    conv = svc._load_or_init(1)
    with patch.object(svc._pg, stage, side_effect=RuntimeError("injected empty write")):
        with pytest.raises(RuntimeError):
            svc._writer.write_conv_updates(1, conv)
    assert all(v is None for v in read_math_tables(engine, 1, "recovery").values())
    svc._writer.write_conv_updates(1, conv)
    assert_empty(read_math_tables(engine, 1, "recovery"))
