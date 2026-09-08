"""Astra's step-1 review controls (board [256]), re-pinned against the fixes.

`cost-reduction/scripts/p2727-step1-astra-review.py` characterised two defects
at 910ba8a15 and two ownership positives. The two defect assertions are inverted
here — they now assert the required behaviour — and the two positive controls
are kept as the review wrote them, so the same four seams stay covered.

F1: a bundle resident in the warm cache must not be trusted for the existence or
    generation of the durable companions (CO02/CO06, contract Rev6 "independent
    resident-cache integrity reconciliation").
F2: `publish-fixture` must report a typed ownership refusal through the same
    exit mapper as `once`, not print it and exit 0.
"""
import json
import os
import sys

import pytest
from conftest import assert_coherent, connect, lease, rows, seed, wait


def query(db, sql, args=()):
    c = connect(db)
    try:
        with c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall() if cur.description else None
    finally:
        c.close()


def test_resident_cache_does_not_hide_a_deleted_companion(db, launch):
    """F1, re-pinned. The review deleted math_bidtopid under a warm cache and
    watched six further passes leave it missing. The resident bundle is now
    reconciled against the store's generation and companion existence on every
    hit, so the daemon repairs with no new input and no restart."""
    seed(db)
    child = launch(db, "run", extra={"P026_POLL_MS": "50", "P026_CACHE_CAP": "2"})
    wait(lambda: lease(db) and lease(db)["owner_epoch"] >= 4, alive=child,
         why="cache warmed across passes")
    before = rows(db)["math_main"]["math_tick"]
    query(db, "DELETE FROM math_bidtopid WHERE math_env='rustproto' AND zid=1")
    wait(lambda: rows(db)["math_bidtopid"] is not None, alive=child,
         why="resident-cache integrity reconciliation repairs the deleted companion")
    child.kill()
    tables = assert_coherent(db)
    # Repaired by republication from the full authoritative prefix, with no
    # source change: the generation advances, it is not silently reinstated.
    assert tables["math_main"]["math_tick"] > before

    # Control from the review, retained: a cache-disabled run of the same
    # corruption also repairs, so the fix did not merely move the problem.
    query(db, "DELETE FROM math_ptptstats WHERE math_env='rustproto' AND zid=1")
    launch(db, extra={"P026_CACHE_CAP": "0"}).done()
    assert_coherent(db)


def test_resident_cache_still_skips_the_store_when_the_generation_is_intact(db, launch):
    """The other half of F1: integrity reconciliation must not disable the
    cache. An untouched conversation stays cached and republishes nothing."""
    seed(db)
    launch(db).done()
    published = rows(db)["math_main"]["math_tick"]
    child = launch(db, "run", extra={"P026_POLL_MS": "50", "P026_CACHE_CAP": "2"})
    wait(lambda: lease(db) and lease(db)["owner_epoch"] >= 5, alive=child,
         why="several quiet passes over a cached conversation")
    child.kill()
    assert rows(db)["math_main"]["math_tick"] == published


def fixture_file(tmp_path, db):
    r = rows(db)
    payloads = {name: r["math_" + name]["data"] for name in ("main", "bidtopid", "ptptstats")}
    p = tmp_path / "publish.json"
    p.write_text(json.dumps({"zid": 1, "expected_tick": r["math_ticks"]["math_tick"],
                             "checkpoint": r["math_ticks"]["input_checkpoint"],
                             "payloads": payloads}))
    return p


def test_publish_fixture_reports_expiry_with_the_typed_exit_code(db, launch, tmp_path):
    """F2, re-pinned: `Refused(Expired)` is exit 5, exactly as `once` reports
    the same seam, and every row is still unchanged."""
    seed(db)
    launch(db).done()
    before = rows(db)
    p = fixture_file(tmp_path, db)
    child = launch(db, "publish-fixture", args=(p,), stage="before_commit",
                   directory=tmp_path / "expiry", extra={"P026_LEASE_SECONDS": "2"})
    child.ack()
    wait(lambda: not lease(db)["unexpired"], alive=child,
         why="genuine DB expiry during publication")
    child.release()
    out, err = child.done(code=5)
    assert "Refused(Expired)" in out
    assert "LEASE-EXPIRED" in err
    assert rows(db) == before

    # Control from the review, retained: the same seam through `once`.
    query(db, "INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,2000)")
    control = launch(db, stage="before_commit", directory=tmp_path / "normal",
                     extra={"P026_LEASE_SECONDS": "2"})
    control.ack()
    wait(lambda: not lease(db)["unexpired"], alive=control,
         why="normal once publication expires")
    control.release()
    _, err = control.done(code=5)
    assert "LEASE-EXPIRED" in err and rows(db) == before


def test_publication_refuses_when_the_remaining_lease_is_below_the_commit_margin(db, launch, tmp_path):
    """Rev6 CO04: the final in-transaction authorization checks the *remaining*
    lease under the row lock. A lease that is still technically unexpired but
    below the margin is refused and rolled back, not gambled on."""
    seed(db)
    launch(db).done()
    before = rows(db)
    p = fixture_file(tmp_path, db)
    child = launch(db, "publish-fixture", args=(p,), stage="before_commit",
                   directory=tmp_path / "margin", extra={"P026_LEASE_SECONDS": "10",
                                                         "P026_COMMIT_MARGIN_SECONDS": "9.99"})
    child.ack()
    child.release()
    out, err = child.done(code=5)
    assert "Refused(Expired)" in out
    # Refused while the lease was still unexpired: this is the margin, not expiry.
    assert "remaining lease below the commit margin" in err
    assert rows(db) == before


def slow_worker(tmp_path):
    script = tmp_path / "slow-worker"
    script.write_text(f'''#!{sys.executable}
import os,sys,time
from pathlib import Path
from polismath import engine_adapter as a
original=a.Adapter.handle
def handle(self,req):
    if req.get('op')=='compute':
        Path(os.environ['P026_WORKER_READY']).write_text(str(os.getpid()))
        while not Path(os.environ['P026_WORKER_GO']).exists():time.sleep(.02)
    return original(self,req)
a.Adapter.handle=handle
sys.argv=[sys.argv[0]]+sys.argv[3:]
raise SystemExit(a.main())
''')
    script.chmod(0o700)
    return script


@pytest.mark.parametrize("transfer", [False, True])
def test_renewal_during_pending_worker_call(db, launch, tmp_path, transfer):
    """Both positive controls from the review, unchanged in substance: an
    actual Python worker held inside a compute request, with Rust unmodified."""
    seed(db)
    ready = tmp_path / "ready"
    go = tmp_path / "go"
    child = launch(db, extra={"P026_PYTHON": str(slow_worker(tmp_path)),
                              "P026_WORKER_READY": str(ready), "P026_WORKER_GO": str(go),
                              "P026_LEASE_SECONDS": "2"})
    wait(ready.exists, alive=child, why="actual worker waiting inside compute call")
    pid = int(ready.read_text())
    if transfer:
        query(db, "UPDATE coordinator_leases SET owner_id='synthetic-successor',"
                  "owner_epoch=owner_epoch+1,expires_at=clock_timestamp()+interval '20 seconds' "
                  "WHERE zid=1 AND math_env='rustproto'")
        _, err = child.done(code=3)
        assert "FENCED" in err and all(v is None for v in rows(db).values())
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    else:
        initial = query(db, "SELECT expires_at FROM coordinator_leases "
                            "WHERE zid=1 AND math_env='rustproto'")[0][0]
        wait(lambda: query(db, "SELECT expires_at > %s + interval '3 seconds' FROM "
                               "coordinator_leases WHERE zid=1 AND math_env='rustproto'",
                           (initial,))[0][0],
             alive=child, why="renewal extends beyond original lease window")
        assert lease(db)["unexpired"] and all(v is None for v in rows(db).values())
        go.write_text("go")
        child.done()
        assert_coherent(db)
