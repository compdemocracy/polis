"""Round-2 regression controls at ef0679de0, retained across schema changes.

R2-F1: persisted payload corruption in any of the three published tables must be
       repaired by the full-source ceiling, not survive behind a resident bundle.
R2-F2: the recorded source age must run from before the source read, so a long
       compute cannot reset it and buy another fast-path interval.
R2-F3: the pca2 route serves a committed generation of zero; only the cold
       `getPca(zid, undefined)` helper call misses it.
R2-F4: the failure gauges must be scoped to this shard and allowlist, like the
       source-age gauges.
"""
import json
import os
import subprocess

import pytest
from coordinator.conftest import ROOT, assert_coherent, connect, lease, rows, seed, wait
from coordinator.test_incremental import emf, query
from coordinator._node_gate import require_node

ROUTE_PROBE = ROOT / "coordinator-rs/tools/node_route_probe.cjs"
EVIDENCE = ROOT / "coordinator-rs/evidence"


@pytest.mark.parametrize("table", ["math_main", "math_bidtopid", "math_ptptstats"])
def test_resident_payload_corruption_is_repaired_by_the_full_source_ceiling(db, launch, table):
    """R2-F1 re-pinned. The metadata check cannot see a mutated payload, so the
    authoritative path re-reads and re-hashes the persisted generation from the
    store instead of trusting the resident bundle."""
    seed(db)
    child = launch(db, "run", extra={"P026_POLL_MS": "100", "P026_CACHE_CAP": "2",
                                     "P026_RECONCILE_SECONDS": "1"})
    wait(lambda: lease(db) and lease(db)["owner_epoch"] >= 3, alive=child,
         why="resident Bundle warmed")
    before = rows(db)["math_main"]["math_tick"]
    query(db, f"UPDATE {table} SET data=data || '{{\"p026_corrupt\":true}}'::jsonb "
              "WHERE zid=1 AND math_env='rustproto'")
    wait(lambda: rows(db)["math_main"]["math_tick"] > before, alive=child,
         why="the ceiling validates persisted payloads and republishes")
    child.kill()
    repaired = assert_coherent(db)
    assert "p026_corrupt" not in repaired[table]["data"]
    assert repaired["math_main"]["math_tick"] > before
    # Control from the review, retained: a cold read of a corrupted generation
    # is still rejected rather than served.
    query(db, f"UPDATE {table} SET data=data || '{{\"p026_corrupt\":true}}'::jsonb "
              "WHERE zid=1 AND math_env='rustproto'")
    _, err = launch(db, "read", args=(1,)).done(code=1)
    assert "absent/inconsistent bundle" in err


def test_recorded_source_age_starts_before_the_source_read(db, launch, tmp_path):
    """R2-F2 re-pinned. The stored reconciled_at is the probe's database time,
    which precedes the snapshot, so a compute that outlasts the ceiling cannot
    advertise a fresh source age or earn another fast-path interval."""
    seed(db)
    child = launch(db, stage="after_source_selection", directory=tmp_path / "snapshot",
                   extra={"P026_RECONCILE_SECONDS": "1"})
    child.ack()
    taken = query(db, "SELECT clock_timestamp()")[0][0]
    # Invisible to every aggregate in the probe, and committed after the
    # snapshot this process already selected.
    query(db, "UPDATE votes SET vote=1 WHERE zid=1 AND pid=0 AND tid=0")
    query(db, "UPDATE votes SET vote=-1 WHERE zid=1 AND pid=0 AND tid=1")
    wait(lambda: query(db, "SELECT clock_timestamp() > %s + interval '3 seconds'", (taken,))[0][0],
         alive=child, why="selected snapshot older than the reconciliation ceiling")
    child.release()
    child.done()
    # The record is stamped at or before the snapshot, never at completion.
    assert query(db, "SELECT reconciled_at <= %s FROM polis_coordinator_reconciliation "
                     "WHERE zid=1 AND math_env='rustproto'", (taken,))[0][0]
    before = rows(db)["math_main"]["math_tick"]
    out = tmp_path / "age.jsonl"
    launch(db, extra={"P026_RECONCILE_SECONDS": "2", "P026_METRICS": str(out)}).done()
    record = emf(out, "source_pass")[-1]
    assert record["SourcePassSkipped"] == 0, "a stale snapshot must not be credited as fresh"
    assert record["SourcePassReconciled"] == 1
    assert record["SourcePassPublished"] == 1
    assert rows(db)["math_main"]["math_tick"] > before
    assert_coherent(db)


def test_failure_gauges_respect_candidate_scope(db, launch, tmp_path):
    """R2-F4 re-pinned. A conversation this process would never attempt is not
    this process's backlog."""
    seed(db, 1)
    seed(db, 2)
    query(db, "INSERT INTO polis_coordinator_failures(math_env,zid,attempts,first_failed_at,next_attempt) "
              "VALUES('rustproto',2,1,clock_timestamp()-interval '1 hour',clock_timestamp())")
    output = tmp_path / "scoped.jsonl"
    launch(db, extra={"POLL_ALLOWLIST": "1", "P026_METRICS": str(output)}).done()
    r = emf(output, "source_pass")[-1]
    assert r["SourcePassConversations"] == 1
    assert r["ReconciliationBacklogConversations"] == 0
    assert r["FailureBacklogConversations"] == 0, "zid 2 is not a candidate of this pass"
    assert r["OldestUnrepairedAgeSeconds"] == 0
    # ... and it is counted by a process whose allowlist does include it.
    both = tmp_path / "both.jsonl"
    launch(db, extra={"POLL_ALLOWLIST": "1,2", "P026_METRICS": str(both)}).done()
    r = emf(both, "source_pass")[-1]
    assert r["FailureBacklogConversations"] == 1
    assert r["OldestUnrepairedAgeSeconds"] >= 3600


def test_actual_pca2_route_serves_generation_zero(db, launch, tmp_path):
    """R2-F3, updated for the merged #2732. The route supplies math_tick = -1 and
    serves a committed generation of zero with 200 and ETag "0"; a matching
    conditional gets 304. The cold `getPca(zid, undefined)` miss this control once
    pinned was the server-owner reader defect #2732 named; #2732 is now merged to
    edge (`pca.ts` guards the column override with `row.math_tick != null`, not a
    falsy check), so this rebased tree serves generation zero on the cold call as
    well — `coldUndefinedPresent` is now True. The PostgreSQL bigint reaches this
    driver as the string "0", which is truthy, so the column override is not
    skipped."""
    require_node()
    seed(db)
    launch(db).done()
    assert rows(db)["math_main"]["math_tick"] == 0
    result = subprocess.run(
        ["node", str(ROUTE_PROBE), str(ROOT)], capture_output=True, text=True, timeout=300,
        env=dict(os.environ, DATABASE_URL=db, MATH_ENV="rustproto",
                 CACHE_MATH_RESULTS="true", NODE_ENV="production"))
    assert result.returncode == 0, (result.stdout, result.stderr)
    evidence = json.loads(result.stdout)
    (EVIDENCE / "d4-generation-zero.json").write_text(json.dumps({
        "profile": "real handle_GET_math_pca2 on a real Express app over loopback HTTP, "
                   "real reader/cache/PostgreSQL; only the parameter middleware is synthetic",
        "committed_math_tick": 0,
        "route": evidence,
        "note": "the route requests latest with math_tick=-1 and serves generation zero; "
                "the cold getPca(zid, undefined) miss this control once recorded was the "
                "server-owner reader defect #2732 named, and #2732 is now merged to edge, so "
                "on this rebased tree the cold call also finds generation zero "
                "(coldUndefinedPresent is True). The helper is fixed upstream, not here.",
    }, indent=2, sort_keys=True))
    assert evidence["pgTickType"] == "string"
    assert evidence["whole"]["status"] == 200
    assert evidence["whole"]["etag"] == '"0"'
    assert evidence["whole"]["bodyTick"] == 0
    assert evidence["whole"]["contentEncoding"] == "gzip"
    assert evidence["subset"]["status"] == 200
    assert evidence["subset"]["bodyTick"] == 0
    assert evidence["conditional"]["status"] == 304
    # #2732 (merged) fixed the cold getPca(zid, undefined) generation-zero miss:
    # the cold call now finds it, so this rebased tree reports True, not the
    # pre-#2732 False this control once pinned. warm has always found it.
    assert evidence["coldUndefinedPresent"] is True
    assert evidence["warmUndefinedPresent"] is True
