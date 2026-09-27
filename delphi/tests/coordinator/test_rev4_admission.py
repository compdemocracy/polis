"""Real rev4 runtime admission, crash reconciliation and retained-floor controls."""
import pytest

from coordinator.conftest import assert_coherent, connect, lease, rows, seed, wait
from coordinator.test_s1_identity import CommitProxy

RESERVATION = 67108864


def query(db, sql, params=()):
    c = connect(db)
    try:
        with c.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else []
    finally:
        c.close()


def operations(db, zid=1):
    return query(db, "SELECT operation_id,state,reserved_bytes,resolved_tick FROM polis_coordinator_operations WHERE zid=%s ORDER BY admitted_at", (zid,))


def empty(db, zid=1):
    assert all(v is None for v in rows(db, zid).values())


def test_reservation_is_committed_before_worker_computes(db, launch, tmp_path):
    seed(db)
    child = launch(db, stage="after_worker_compute", directory=tmp_path / "child")
    child.ack()
    op = operations(db)
    assert len(op) == 1 and op[0][1:] == ("pending", RESERVATION, None)
    assert query(db, """SELECT o.owner_id=l.owner_id AND o.owner_epoch=l.owner_epoch
        AND o.capability_sha256=l.dispatch_capability_sha256
        AND o.checkpoint_sha256=l.dispatch_checkpoint_sha256
        AND o.expected_tick IS NOT DISTINCT FROM l.dispatch_expected_tick
        AND length(o.source_sha256)=64 FROM polis_coordinator_operations o
        JOIN polis_coordinator_leases l USING(math_env,zid)""") == [(True,)]
    empty(db)
    child.release(); child.done()
    assert operations(db) == [(op[0][0], "resolved", RESERVATION, 0)]
    assert_coherent(db)
    assert query(db, "SELECT o.source_sha256=g.input_checkpoint->>'input_sha256' FROM polis_coordinator_operations o JOIN polis_coordinator_generations g USING(math_env,zid,operation_id)") == [(True,)]


@pytest.mark.parametrize("missing", ["profile", "reservation"])
def test_missing_explicit_admission_refuses_before_worker(db, launch, missing):
    seed(db)
    extra = {}
    if missing == "profile":
        query(db, "DELETE FROM polis_coordinator_budgets WHERE math_env='rustproto'")
    else:
        extra["P026_RESERVATION_BYTES"] = "0"
    launch(db, extra=extra).done(code=1)
    empty(db)
    assert operations(db) == []


@pytest.mark.parametrize("bound", ["count", "bytes"])
def test_concurrent_admission_and_resolved_retention_are_bounded(db, launch, tmp_path, bound):
    seed(db); seed(db, zid=2)
    query(db, "UPDATE polis_coordinator_budgets SET max_operations=%s,max_bytes=%s WHERE math_env='rustproto'",
          (1 if bound == "count" else 128, 8589934592 if bound == "count" else RESERVATION))
    first = launch(db, stage="after_worker_compute", directory=tmp_path / "first", extra={"POLL_ALLOWLIST": "1"})
    first.ack()
    launch(db, extra={"POLL_ALLOWLIST": "2"}).done(code=1)
    empty(db, 2); assert operations(db, 2) == []
    first.release(); first.done()
    assert operations(db)[0][1] == "resolved"
    launch(db, extra={"POLL_ALLOWLIST": "2"}).done(code=1)
    empty(db, 2); assert operations(db, 2) == []


def test_payload_larger_than_reservation_stays_unresolved(db, launch):
    seed(db)
    launch(db, extra={"P026_RESERVATION_BYTES": "1048576"}).done(code=1)
    empty(db)
    assert operations(db)[0][1:] == ("unresolved", 1048576, None)


def test_lost_admission_commit_reply_never_launches_worker(db, launch, tmp_path):
    seed(db); seed(db, zid=2)
    proxy = CommitProxy(db, query=b"SELECT public.pc_admit(")
    try:
        child = launch(proxy.url, stage="after_worker_compute", directory=tmp_path / "child",
                       extra={"POLL_ALLOWLIST": "1", "P026_LEASE_SECONDS": "2"})
        assert proxy.committed.wait(30)
        assert operations(db)[0][1] == "pending"
        assert not (child.directory / "ack.json").exists()
        empty(db)
        proxy.release.set(); child.done(code=1)
        wait(lambda: not lease(db)["unexpired"], why="admission owner expiry")
        launch(db, extra={"POLL_ALLOWLIST": "2"}).done()
        assert operations(db)[0][1:] == ("unresolved", RESERVATION, None)
        empty(db)
    finally:
        proxy.close()


@pytest.mark.parametrize("stage", ["after_worker_compute", "after_commit"])
def test_replacement_reconciles_durable_operation_without_replaying_zid(db, launch, tmp_path, stage):
    seed(db); seed(db, zid=2)
    old = launch(db, stage=stage, directory=tmp_path / "old",
                 extra={"POLL_ALLOWLIST": "1", "P026_LEASE_SECONDS": "2"})
    old.ack()
    op = operations(db)[0]
    assert op[1] == "pending"
    old.kill()
    wait(lambda: not lease(db)["unexpired"], why="dead owner real expiry")
    launch(db, extra={"POLL_ALLOWLIST": "2"}).done()
    expected = ("resolved", RESERVATION, 0) if stage == "after_commit" else ("unresolved", RESERVATION, None)
    assert operations(db) == [(op[0], *expected)]
    if stage == "after_commit":
        assert assert_coherent(db)["math_ticks"]["math_tick"] == 0
    else:
        empty(db)


@pytest.mark.parametrize("damage", ["floor_only", "coherent_regression"])
def test_protected_cleanup_and_floor_survive_pointer_damage(db, launch, damage):
    seed(db); launch(db).done()
    old = operations(db)[0][0]
    query(db, "INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,2000)")
    launch(db).done()
    assert assert_coherent(db)["math_ticks"]["math_tick"] == 1
    query(db, "SET ROLE p027_bridge_control; SELECT pc_protect('rustproto',1,%s,true)", (old,))
    assert query(db, "SET ROLE p027_bridge_control; SELECT pc_cleanup('rustproto',1,%s)", (old,)) == [(False,)]
    query(db, "SET ROLE p027_bridge_control; SELECT pc_protect('rustproto',1,%s,false)", (old,))
    query(db, "SET ROLE p027_bridge_control; SELECT pc_reference('rustproto',1,%s,'public-fixture-reader',true)", (old,))
    assert query(db, "SET ROLE p027_bridge_control; SELECT pc_cleanup('rustproto',1,%s)", (old,)) == [(False,)]
    query(db, "SET ROLE p027_bridge_control; SELECT pc_reference('rustproto',1,%s,'public-fixture-reader',false)", (old,))
    latest = operations(db)[-1][0]
    assert query(db, "SET ROLE p027_bridge_control; SELECT pc_cleanup('rustproto',1,%s)", (latest,)) == [(False,)]
    if damage == "floor_only":
        assert query(db, "SET ROLE p027_bridge_control; SELECT pc_cleanup('rustproto',1,%s)", (old,)) == [(True,)]
        # Deliberate privileged corruption: prove floor alone prevents tick reuse.
        for table in ("math_main", "math_bidtopid", "math_ptptstats", "math_ticks", "polis_coordinator_payloads", "polis_coordinator_generations"):
            query(db, f"DELETE FROM {table} WHERE math_env='rustproto'")
    else:
        for kind in ("main", "bidtopid", "ptptstats"):
            query(db, f"UPDATE math_{kind} SET data=(SELECT convert_from(original_bytes,'UTF8')::jsonb FROM polis_coordinator_payloads WHERE math_env='rustproto' AND zid=1 AND math_tick=0 AND payload_kind=%s), math_tick=0 WHERE math_env='rustproto'", (kind,))
        query(db, "UPDATE math_main SET caching_tick=(SELECT caching_tick FROM polis_coordinator_generations WHERE math_env='rustproto' AND zid=1 AND math_tick=0) WHERE math_env='rustproto'")
        query(db, "UPDATE math_ticks SET math_tick=0 WHERE math_env='rustproto'")
        launch(db, "read", args=(1,)).done(code=1)
    launch(db).done()
    current = assert_coherent(db)
    assert current["math_ticks"]["math_tick"] == 2
    assert query(db, "SELECT math_tick FROM polis_coordinator_floors WHERE math_env='rustproto' AND zid=1") == [(2,)]


@pytest.mark.parametrize("grant", ["publisher_admit", "control_operations", "publisher_floors"])
def test_rev4_extra_authority_is_refused(db, launch, grant):
    seed(db)
    query(db, {"publisher_admit": "GRANT EXECUTE ON FUNCTION pc_admit(text,integer,text,bigint,text,text,bigint) TO p027_bridge_publisher",
               "control_operations": "GRANT INSERT ON polis_coordinator_operations TO p027_bridge_control",
               "publisher_floors": "GRANT INSERT ON polis_coordinator_floors TO p027_bridge_publisher"}[grant])
    launch(db).done(code=1)
    empty(db)


def test_uncertainty_is_emitted_before_blocked_reconciliation(db, launch, tmp_path):
    from coordinator.test_incremental import emf
    from coordinator.test_publication_metrics import assert_outcome
    seed(db)
    proxy = CommitProxy(db)
    lock = connect(db)
    metrics = tmp_path / "blocked-reconcile.jsonl"
    try:
        child = launch(proxy.url, extra={"P026_METRICS": str(metrics)})
        assert proxy.committed.wait(30)
        committed = rows(db)
        with lock.cursor() as cur:
            cur.execute("BEGIN; SELECT math_env FROM polis_coordinator_budgets WHERE math_env='rustproto' FOR UPDATE")
        proxy.release.set()
        wait(lambda: metrics.exists() and any(r.get("PublishUncertain") == 1 for r in emf(metrics)), timeout=4,
             why="uncertainty visible before locked receipt reconciliation")
        assert not any(r.get("PublishResolvedOwn") for r in emf(metrics))
        assert operations(db)[0][1] == "pending"
        with lock.cursor() as cur:
            cur.execute("COMMIT")
        child.done()
        assert_outcome(metrics, committed, own=True)
        assert operations(db)[0][1] == "resolved"
    finally:
        lock.close()
        proxy.close()
