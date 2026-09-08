"""R05/R09: transaction rollback, legacy repair and concurrent zid isolation."""

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import time

import pytest
import sqlalchemy as sa

from polismath.conversation.conversation import Conversation
from .conftest import (
    FaultInjector, Latch, fail_stage, read_math_tables, read_vote_events,
    seed_conversation, tables_are_coherent,
)
from . import fold as F

pytestmark = pytest.mark.recovery
MATH_ENV = "recovery"


@pytest.mark.parametrize("published_before", [False, True])
@pytest.mark.parametrize("stage", [
    "increment_math_tick", "write_math_main", "write_math_bidtopid",
    "write_participant_stats",
])
@pytest.mark.parametrize("after", [False, True])
def test_failure_rolls_back_whole_snapshot(
    engine, pg_url, make_service, stage, after, published_before
):
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV)
    conv = svc._load_or_init(1)
    if published_before:
        svc._writer.write_conv_updates(1, conv)
    before = read_math_tables(engine, 1, MATH_ENV)
    fault = FaultInjector(name=stage, mode="once")
    undo = fail_stage(svc._pg, stage, fault, after=after)
    try:
        with pytest.raises(RuntimeError):
            svc._writer.write_conv_updates(1, conv)
    finally:
        undo()
    assert fault.fired == 1
    # This includes the allocation row, not only the three published blobs.
    assert read_math_tables(engine, 1, MATH_ENV) == before
    svc._writer.write_conv_updates(1, conv)
    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables_are_coherent(tables) == []
    expected = before["main"]["math_tick"] + 1 if published_before else 0
    assert tables["main"]["math_tick"] == expected
    assert tables["main"]["caching_tick"] == (2 if published_before else 1)


@pytest.mark.parametrize("table", ["math_main", "math_bidtopid", "math_ptptstats"])
@pytest.mark.parametrize("damage", ["missing", "different_tick"])
def test_dormant_partial_snapshot_rebuilds_without_restoring_mixed_state(
    engine, pg_url, make_service, caplog, table, damage
):
    old = int(time.time() * 1000) - 10 * 24 * 60 * 60 * 1000
    seed_conversation(engine, zid=2, n_ptpts=6, n_cmts=4, base_created=old)
    svc = make_service(pg_url, math_env=MATH_ENV, poll_from_days_ago=30)
    svc.poll_once()
    with engine.begin() as conn:
        if damage == "missing":
            conn.execute(sa.text(f"DELETE FROM {table} WHERE zid=2 AND math_env=:e"),
                         {"e": MATH_ENV})
        else:
            conn.execute(sa.text(f"UPDATE {table} SET math_tick=math_tick + 7 "
                                 "WHERE zid=2 AND math_env=:e"), {"e": MATH_ENV})
        # A mixed main must not seed an incorrect watermark into the rebuild.
        conn.execute(sa.text("UPDATE math_main SET last_vote_timestamp=:t "
                             "WHERE zid=2 AND math_env=:e"),
                     {"t": old + 99999999, "e": MATH_ENV})
    assert svc._pg.find_incomplete_math_snapshots() == [2]
    fresh = make_service(pg_url, math_env=MATH_ENV, poll_from_days_ago=1)
    with patch.object(Conversation, "from_dict", wraps=Conversation.from_dict) as restore:
        fresh.poll_once()
        restore.assert_not_called()
    tables = read_math_tables(engine, 2, MATH_ENV)
    assert tables_are_coherent(tables) == []
    fold = F.fold_votes(read_vote_events(engine, 2))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []
    assert fresh._pg.find_incomplete_math_snapshots() == []
    assert "Startup repair: incomplete math snapshot for zid=2" in caplog.text
    if table != "math_main" or damage != "missing":
        assert "discarding persisted state and rebuilding full history" in caplog.text


@pytest.mark.parametrize("config,expected", [
    ({"allowlist": [1, 2], "shard_index": 0, "shard_count": 2}, [2]),
    ({"blocklist": [2, 3]}, [1]),
    ({"allowlist": [3], "blocklist": [3]}, [3]),
])
def test_startup_repair_obeys_namespace_and_routing(
    engine, pg_url, make_service, config, expected
):
    old = int(time.time() * 1000) - 10 * 24 * 60 * 60 * 1000
    for zid in (1, 2, 3, 4):
        seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3, base_created=old)
        with engine.begin() as conn:
            conn.execute(sa.text("INSERT INTO math_main "
                                 "(zid, math_env, data, math_tick, last_vote_timestamp) "
                                 "VALUES (:z, :e, '{}'::jsonb, 7, 0)"),
                         {"z": zid, "e": "other" if zid == 4 else MATH_ENV})
    other_before = read_math_tables(engine, 4, "other")
    svc = make_service(pg_url, math_env=MATH_ENV, **config)
    assert svc._pg.find_incomplete_math_snapshots() == [1, 2, 3]
    svc.poll_once()
    for zid in (1, 2, 3):
        tables = read_math_tables(engine, zid, MATH_ENV)
        assert (tables_are_coherent(tables) == []) == (zid in expected)
    assert read_math_tables(engine, 4, "other") == other_before
    assert read_math_tables(engine, 4, MATH_ENV)["main"] is None


def test_startup_scan_failure_is_retried(pg_url, make_service):
    svc = make_service(pg_url, math_env=MATH_ENV)
    scan = svc._pg.find_incomplete_math_snapshots
    with patch.object(svc._pg, "find_incomplete_math_snapshots",
                      side_effect=RuntimeError("scan failed")):
        with pytest.raises(RuntimeError, match="scan failed"):
            svc.poll_once()
    assert not svc._startup_repair_done
    with patch.object(svc._pg, "find_incomplete_math_snapshots", wraps=scan) as called:
        svc.poll_once()
        svc.poll_once()
        called.assert_called_once_with()
    assert svc._startup_repair_done


def test_start_survives_a_boot_time_scan_failure(pg_url, make_service, caplog):
    """A database blip at boot must not abort startup. Before the startup scan
    existed, start() touched no database at all; a scan failure now has to be
    logged and swallowed there (poll_once still propagates, above), leaving the
    scan pending so the first poll cycle retries it."""
    svc = make_service(pg_url, math_env=MATH_ENV)
    scan = svc._pg.find_incomplete_math_snapshots
    with patch.object(svc._pg, "find_incomplete_math_snapshots",
                      side_effect=RuntimeError("boot scan failed")):
        svc.start()
    try:
        assert not svc._startup_repair_done
        assert "Startup repair scan failed" in caplog.text
        assert svc._threads and all(t.is_alive() for t in svc._threads)
    finally:
        svc.stop()
    with patch.object(svc._pg, "find_incomplete_math_snapshots", wraps=scan) as called:
        svc.poll_once()
        called.assert_called_once_with()
    assert svc._startup_repair_done


def test_blocked_zid_does_not_block_other_zid_transactions(
    engine, pg_url, make_service, monkeypatch
):
    for zid in (1, 2, 3, 4):
        seed_conversation(engine, zid=zid, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=4)
    svc.poll_once()
    before = read_math_tables(engine, 1, MATH_ENV)
    latch = Latch("zid 1 before bidtopid")
    real = svc._pg.write_math_bidtopid

    def blocked(zid, *args, **kwargs):
        if zid == 1:
            latch.block()
        return real(zid, *args, **kwargs)

    monkeypatch.setattr(svc._pg, "write_math_bidtopid", blocked)
    # Same client, four explicit connections. Holding zid 1's transaction open
    # must neither commit its main/tick nor stop the other three transactions.
    with ThreadPoolExecutor(max_workers=4) as pool:
        first = pool.submit(svc._writer.write_conv_updates, 1, svc._convs[1])
        try:
            latch.wait_arrival()
            others = [pool.submit(svc._writer.write_conv_updates, z, svc._convs[z])
                      for z in (2, 3, 4)]
            for future in others:
                future.result(timeout=20)
            assert not first.done()
            assert read_math_tables(engine, 1, MATH_ENV) == before
            for zid in (2, 3, 4):
                tables = read_math_tables(engine, zid, MATH_ENV)
                assert tables_are_coherent(tables) == []
                assert tables["main"]["math_tick"] == 1
        finally:
            latch.let_go()
        first.result(timeout=20)
    assert tables_are_coherent(read_math_tables(engine, 1, MATH_ENV)) == []


def test_lost_ack_after_snapshot_commit_recovers(engine, pg_url, make_service):
    """The commit succeeded, but the worker sees failure before caching. Retry
    must preserve all inputs and coherence even though a generation committed."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=1, worker_pool_size=1)
    committed = []
    real = svc._writer.write_conv_updates

    def lose_first_ack(zid, conv):
        tick = real(zid, conv)
        if not committed:
            tables = read_math_tables(engine, zid, MATH_ENV)
            assert tables_are_coherent(tables) == []
            assert tables["main"]["math_tick"] == tick
            committed.append(tables)
            raise RuntimeError("lost acknowledgement after commit")
        return tick

    with patch.object(svc._writer, "write_conv_updates", side_effect=lose_first_ack):
        svc.poll_once()
    assert len(committed) == 1
    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables_are_coherent(tables) == []
    assert tables["main"]["math_tick"] == committed[0]["main"]["math_tick"] + 1
    fold = F.fold_votes(read_vote_events(engine, 1))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []
    assert 1 not in svc._parked
