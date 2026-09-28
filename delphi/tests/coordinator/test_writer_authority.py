"""Rev7 runtime adoption: restarted and in-flight writers, scoped withdrawal."""
import contextlib
import hashlib
import json
from urllib.parse import urlsplit, urlunsplit

import psycopg2
import pytest

from coordinator.conftest import ARTIFACTS, ROOT, assert_coherent, connect, lease, rows, seed, wait


def role_url(url, kind="control", env="rustproto"):
    from coordinator.conftest import runtime_role
    parsed = urlsplit(url)
    return urlunsplit(parsed._replace(netloc=runtime_role(kind, env)+"@"+parsed.netloc.split("@")[-1]))


def query(url, sql, args=()):
    with contextlib.closing(connect(url)) as c, c.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall() if cur.description else []


def rollback_to_legacy(db):
    # The already published destination is the fallback. This is a namespace
    # authority control; no claim that a Clojure process produced its science.
    query(db, "UPDATE polis_coordinator_namespaces SET writer_kind='legacy' WHERE math_env='python'")
    query(db, "UPDATE polis_coordinator_principals SET can_transition=true WHERE principal_name='p027_bridge_control_python'")
    return query(role_url(db, env="python"),
                 "SELECT * FROM pc_transition('rustproto','python',1,'public-rollback',NULL,%s)",
                 (hashlib.sha256(b"local public process control").hexdigest(),))[0]


def authority(db, env="rustproto", zid=1):
    return query(role_url(db, env=env), "SELECT pc_namespace_allowed(%s),pc_writer_allowed(%s,%s)", (env,env,zid))[0]


def test_restart_refuses_withdrawn_zid_and_daemon_serves_unaffected_zid(db, launch, tmp_path):
    seed(db); seed(db, zid=2)
    first = launch(db); first.done()
    launch(db, env="python").done()
    old = lease(db)
    rollback_to_legacy(db)
    frozen = rows(db)
    assert authority(db) == (True, False)
    # An actual new Rust process authenticates, then refuses before acquisition.
    restarted = launch(db); restarted.done(code=4)
    assert restarted.proc.pid != first.proc.pid
    assert lease(db)["owner_epoch"] == old["owner_epoch"]
    assert rows(db) == frozen
    query(db, "INSERT INTO votes(zid,pid,tid,vote,created) VALUES(2,0,0,1,9000)")
    live = launch(db, mode="run", extra={"P026_POLL_MS":"20"})
    wait(lambda: rows(db,2)["math_ticks"]["math_tick"] == 1,
         alive=live, why="unaffected conversation publication")
    current = assert_coherent(db,2)
    assert authority(db,zid=2) == (True,True)
    assert rows(db) == frozen and lease(db)["owner_epoch"] == old["owner_epoch"]
    assert live.proc.poll() is None
    live.kill()
    # Reader bytes come from the same actual coherent second publication.
    out,_ = launch(db,mode="read",args=(2,)).done()
    assert json.loads(out)["math_tick"] == current["math_ticks"]["math_tick"]
    (ARTIFACTS/"rev7-restart.json").write_text(json.dumps({
        "restart_exit":4,"new_process":True,"withdrawn_epoch_unchanged":True,
        "unaffected_tick":1,"unaffected_bundle_read":True,"daemon_survived":True}))


def test_legacy_namespace_still_acquires_after_transition(db, launch):
    seed(db); launch(db).done(); launch(db,env="python").done()
    old = lease(db,env="python")
    transition = rollback_to_legacy(db)
    assert authority(db,env="python") == (True,True)
    launch(db,env="python").done()
    assert lease(db,env="python")["owner_epoch"] > old["owner_epoch"]
    assert assert_coherent(db,env="python")["math_ticks"]["math_tick"] > transition[2]


@pytest.mark.parametrize("stage", ["after_lease", "after_worker_compute"])
def test_inflight_withdrawal_refuses_and_keeps_pending_outcome(db, launch, tmp_path, stage):
    seed(db); launch(db,env="python").done()
    child = launch(db,stage=stage,directory=tmp_path/stage)
    child.ack()
    rollback_to_legacy(db)
    child.release(); child.done(code=4)
    assert all(v is None for v in rows(db).values())
    assert query(db,"SELECT count(*) FROM polis_coordinator_generations WHERE math_env='rustproto'") == [(0,)]
    states = query(db,"SELECT state FROM polis_coordinator_operations WHERE math_env='rustproto'")
    assert states == ([] if stage == "after_lease" else [("unresolved",)])
    assert not lease(db)["unexpired"]


@pytest.mark.parametrize("isolation", ["repeatable read", "serializable"])
def test_writer_snapshot_isolation_refuses_before_lease(db, launch, isolation):
    seed(db)
    # Role defaults exercise the actual Rust transaction setup, not a parallel
    # statement that merely resembles acquire.
    query(db,"ALTER ROLE p027_bridge_control SET default_transaction_isolation=%s",(isolation,))
    try:
        _,err = launch(db).done(code=1)
        assert 'P2033' in err
        assert lease(db) is None
    finally:
        query(db,"ALTER ROLE p027_bridge_control RESET default_transaction_isolation")


def test_publisher_authorize_refuses_revoked_writer_before_compute(db, launch):
    from polismath.poller.coordinator_bridge import Dispatch, Publisher
    seed(db); launch(db).done(); launch(db,env="python").done()
    rollback_to_legacy(db)
    d = Dispatch("rustproto",1,"withdrawn",1,"public-retry",bytes(32),0,{})
    with pytest.raises(psycopg2.Error) as error:
        Publisher(role_url(db,"publisher"),d).authorize()
    assert error.value.pgcode == "P2033"
    assert error.value.diag.message_primary == "WRITER_AUTHORITY_REQUIRED"


def test_exact_historical_publication_remains_readable_after_withdrawal(db, launch):
    from polismath.poller.coordinator_bridge import Dispatch, Publisher
    seed(db); launch(db,env="python").done()
    cap = bytes(range(32)); operation = "public-history"
    control = role_url(db)
    query(control,"""INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at,
      dispatch_operation_id,dispatch_capability_sha256,dispatch_checkpoint_sha256,dispatch_margin_ms)
      VALUES('rustproto',1,'public-history',1,clock_timestamp()+interval '120 seconds',%s,%s,
      encode(sha256(convert_to('{}'::jsonb::text,'UTF8')),'hex'),500)""",
      (operation,hashlib.sha256(cap).hexdigest()))
    query(control,"SELECT pc_admit('rustproto',1,'public-history',1,%s,%s,67108864)",
          (operation,hashlib.sha256(b"public-input").hexdigest()))
    d = Dispatch("rustproto",1,"public-history",1,operation,cap,None,{})
    p = Publisher(role_url(db,"publisher"),d)
    by_kind = dict(query(db,"SELECT payload_kind,original_bytes FROM polis_coordinator_payloads WHERE math_env='python'"))
    payloads = [bytes(by_kind[k]).decode() for k in ("main","bidtopid","ptptstats")]
    p.authorize(); p.publish(1,*payloads)
    result = dict(p.result)
    rollback_to_legacy(db)
    frozen = rows(db)
    assert p.publish(1,*payloads) == result["math_tick"]
    assert p.result["outcome"] == "already_committed"
    assert rows(db) == frozen
    assert query(control,"SELECT pc_reconcile('rustproto',1,%s)",(operation,)) == [("resolved",)]
    with pytest.raises(psycopg2.Error) as error:
        p.publish(1,payloads[0]+" ",*payloads[1:])
    assert error.value.pgcode == "P2011"


def test_runtime_schema_fingerprint_matches_live_catalog(db):
    from polismath.poller.coordinator_bridge import CATALOG_FINGERPRINT
    assert query(db,"SELECT catalog_fingerprint FROM polis_coordinator_install WHERE singleton") == [(CATALOG_FINGERPRINT,)]
    for path in ("coordinator-rs/src/bridge.rs","coordinator-rs/tools/bundle_reader.cjs"):
        assert CATALOG_FINGERPRINT in (ROOT/path).read_text()


@pytest.mark.parametrize("existing_lease", [False, True])
@pytest.mark.parametrize("commit", [False, True])
def test_waiting_restart_observes_transition_outcome(db, launch, existing_lease, commit):
    seed(db)
    launch(db,env="python").done()
    if existing_lease:
        launch(db).done()
    query(db,"UPDATE polis_coordinator_namespaces SET writer_kind='legacy' WHERE math_env='python'")
    query(db,"UPDATE polis_coordinator_principals SET can_transition=true WHERE principal_name='p027_bridge_control_python'")
    with contextlib.closing(connect(role_url(db,env="python"))) as transition:
        transition.autocommit = False
        with transition.cursor() as cur:
            cur.execute("SELECT * FROM pc_transition('rustproto','python',1,'public-waiting',NULL,%s)",
                        (hashlib.sha256(b"local waiting acquisition").hexdigest(),))
        waiting = launch(db)
        wait(lambda: query(db,"""SELECT count(*) FROM pg_stat_activity
             WHERE datname=current_database() AND application_name='p026-coordinator'
             AND wait_event_type='Lock' AND query LIKE %s""",
             ('SELECT public.pc_writer_allowed%',))[0][0] == 1,
             alive=waiting,why="real runtime acquisition waits for transition")
        if commit:
            transition.commit()
        else:
            transition.rollback()
        waiting.done(code=4 if commit else 0)
    if commit:
        assert authority(db) == (True,False)
        if existing_lease:
            assert lease(db)["owner_epoch"] == 1
        else:
            assert lease(db) is None
    else:
        assert authority(db) == (True,True)
        assert lease(db)["owner_epoch"] == (2 if existing_lease else 1)
        assert_coherent(db)
