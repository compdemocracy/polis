"""Actual poller bridge: disjoint credentials, stale children, final COMMIT seam."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.parse import urlsplit,urlunsplit

import pytest
from coordinator.conftest import ROOT,ARTIFACTS,connect,seed,rows,lease,wait,assert_coherent


def publisher_url(url):
    parsed=urlsplit(url)
    return urlunsplit(parsed._replace(netloc="p027_bridge_publisher@"+parsed.netloc.split("@")[-1]))


def test_schema_consumers_are_byte_pinned():
    from polismath.poller.coordinator_bridge import COORDINATOR_SQL_SHA256
    sql=ROOT/"server/postgres/migrations/000021_create_polis_coordinator.sql"
    assert hashlib.sha256(sql.read_bytes()).hexdigest()==COORDINATOR_SQL_SHA256
    assert COORDINATOR_SQL_SHA256 in (ROOT/"coordinator-rs/src/bridge.rs").read_text()
    assert COORDINATOR_SQL_SHA256 in (ROOT/"coordinator-rs/tools/bundle_reader.cjs").read_text()
    assert COORDINATOR_SQL_SHA256 in (ROOT/"server/postgres/migrations/down/000021-files.sha256").read_text()


@pytest.mark.parametrize("authority",["control_dml","control_rpc","publisher_dml","publisher_superuser","control_set_role","publisher_set_role"])
def test_second_publication_authority_is_refused(db,launch,authority):
    seed(db)
    c=connect(db)
    indirect=False
    try:
        with c.cursor() as cur:
            if authority.endswith("_set_role"):
                cur.execute("CREATE ROLE p027_indirect")
                indirect=True
                cur.execute("GRANT UPDATE(data) ON math_main TO p027_indirect")
                target="p027_bridge_control" if authority.startswith("control") else "p027_bridge_publisher"
                cur.execute(f"GRANT p027_indirect TO {target} WITH INHERIT FALSE, SET TRUE")
            elif authority=="control_dml":
                cur.execute("GRANT UPDATE(data) ON math_main TO p027_bridge_control")
            elif authority=="control_rpc":
                cur.execute("GRANT EXECUTE ON FUNCTION pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea) TO p027_bridge_control")
            elif authority=="publisher_dml":
                cur.execute("GRANT UPDATE(data) ON math_main TO p027_bridge_publisher")
        extra={"COORDINATOR_PUBLISHER_DATABASE_URL":db} if authority=="publisher_superuser" else None
        launch(db,extra=extra).done(code=1)
        assert all(v is None for v in rows(db).values())
        with c.cursor() as cur:
            cur.execute("SELECT count(*) FROM polis_coordinator_generations")
            assert cur.fetchone()[0]==0
    finally:
        if indirect:
            with c.cursor() as cur:
                cur.execute("REVOKE UPDATE(data) ON math_main FROM p027_indirect")
                cur.execute("DROP ROLE p027_indirect")
        c.close()


@pytest.mark.parametrize("iteration",range(20))
def test_stale_python_child_after_parent_death_is_fenced(db,launch,tmp_path,iteration):
    seed(db)
    old=launch(db,stage="after_worker_compute",directory=tmp_path/"old",extra={"P026_LEASE_SECONDS":"2"})
    ack=old.ack();worker=ack["context"]["worker_pid"]
    assert worker!=old.proc.pid
    os.kill(worker,signal.SIGSTOP)
    try:
        # Stop the actual Python child while the parent places its continuation
        # on the pipe. Its next instruction after SIGCONT is real publication.
        old.release()
        wait(lambda:(old.directory/"bridge-resumed.json").exists(),why="worker continuation queued")
        old.proc.kill();old.proc.communicate(timeout=10)
        assert old.proc.returncode==-signal.SIGKILL
        wait(lambda:not lease(db)["unexpired"],why="dead owner's real DB-time expiry")
        launch(db).done()
        current=assert_coherent(db)
        assert lease(db)["owner_epoch"]>ack["context"]["epoch"]
        os.kill(worker,signal.SIGCONT)
        def exited():
            try: os.kill(worker,0)
            except ProcessLookupError: return True
            return False
        wait(exited,timeout=20,why="stale child terminates")
        assert rows(db)==current
        c=connect(db)
        with c.cursor() as cur:
            cur.execute("SELECT publisher_epoch,count(*) FROM polis_coordinator_generations GROUP BY publisher_epoch")
            assert cur.fetchall()==[(current["math_ticks"]["publisher_epoch"],1)]
        c.close()
        (ARTIFACTS/f"bridge-stale-child-{iteration:02}.json").write_text(json.dumps({"iteration":iteration,
            "old_epoch":ack["context"]["epoch"],"new_epoch":current["math_ticks"]["publisher_epoch"],
            "parent_signal":"SIGKILL","child_survived":True,"manual_expiry":False,"unchanged_after_resume":True}))
    finally:
        try: os.kill(worker,signal.SIGKILL)
        except ProcessLookupError: pass


@pytest.mark.parametrize("iteration",range(20))
def test_final_python_margin_after_rpc_rolls_back(db,launch,tmp_path,iteration):
    seed(db)
    old=launch(db,stage="before_commit",directory=tmp_path/"commit",extra={"P026_LEASE_SECONDS":"2"})
    ack=old.ack()
    assert ack["context"]["backend_pid"] is not None
    # Lease renewal is blocked by this worker's actual transaction lock.
    wait(lambda:not lease(db)["unexpired"],why="DB time passes the held publication lease")
    old.release();old.done(code=5)
    assert all(v is None for v in rows(db).values())
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("SELECT count(*) FROM polis_coordinator_generations")
        assert cur.fetchone()[0]==0
    c.close()
    (ARTIFACTS/f"bridge-final-margin-{iteration:02}.json").write_text(json.dumps({"iteration":iteration,
        "actual_rpc_returned":True,"backend_pid":ack["context"]["backend_pid"],"manual_expiry":False,
        "outcome":"LEASE-EXPIRED","math_rows":0,"receipts":0}))


def test_source_capability_tampering_cannot_publish(db,launch,tmp_path):
    seed(db)
    old=launch(db,stage="after_worker_compute",directory=tmp_path/"capability")
    old.ack()
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("UPDATE polis_coordinator_leases SET dispatch_capability_sha256=repeat('0',64)")
    c.close()
    old.release();old.done(code=1)
    assert all(v is None for v in rows(db).values())


def test_removing_final_python_check_is_detected(db,launch,tmp_path):
    """A private scratch mutant commits after the last in-RPC check expires."""
    seed(db)
    source=(ROOT/"delphi/polismath/poller/coordinator_bridge.py").read_text()
    assert source.count('if not final[2]:')==1
    mutant=tmp_path/"mutant.py"
    mutant.write_text(source.replace('if not final[2]:','if False: # scratch negative control'))
    executable=tmp_path/"python-mutant"
    executable.write_text(f"#!{sys.executable}\nimport runpy\nrunpy.run_path({str(mutant)!r},run_name='__main__')\n")
    executable.chmod(0o700)
    old=launch(db,stage="before_commit",directory=tmp_path/"mutant-commit",
               extra={"P026_LEASE_SECONDS":"2","P026_PYTHON":str(executable)})
    old.ack()
    wait(lambda:not lease(db)["unexpired"],why="mutant's actual DB-time expiry")
    old.release();old.done()
    # This is precisely the zero-published-rows oracle used by the intact test.
    with pytest.raises(AssertionError):
        assert all(v is None for v in rows(db).values())
    assert_coherent(db)
    (ARTIFACTS/"bridge-final-check-mutant.json").write_text(json.dumps({
        "removed":"last Python DB-time check before COMMIT","production_source_edited":False,
        "manual_expiry":False,"mutant_committed_after_expiry":True,"intact_zero_row_oracle":"FAIL"}))


@pytest.mark.parametrize("corrupt",["manifest","source"])
def test_engine_source_admission_refuses_drift(tmp_path,corrupt):
    from polismath.poller.coordinator_bridge import admit_engine,BridgeError,COORDINATOR_ENGINE_SHA256
    text=(ROOT/"coordinator-rs/schemas/poller-engine-v1.json").read_text()
    assert hashlib.sha256(text.encode()).hexdigest()==COORDINATOR_ENGINE_SHA256
    admit_engine(text)
    if corrupt=="manifest":
        with pytest.raises(BridgeError,match="ENGINE_MANIFEST_MISMATCH"):
            admit_engine(text+"\n")
    else:
        for relative in json.loads(text)["sha256"]:
            destination=tmp_path/relative;destination.parent.mkdir(parents=True,exist_ok=True)
            destination.write_bytes((ROOT/"delphi"/relative).read_bytes())
        path=tmp_path/"polismath/conversation/conversation.py"
        path.write_bytes(path.read_bytes()+b"\n# scratch source drift\n")
        with pytest.raises(BridgeError,match="ENGINE_SOURCE_MISMATCH"):
            admit_engine(text,root=tmp_path)


@pytest.mark.parametrize("sqlstate",["40001","40P01"])
def test_retryable_publication_rolls_back_and_retries_same_operation(db,launch,tmp_path,sqlstate):
    seed(db)
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("CREATE SEQUENCE p027_retry_attempt")
        cur.execute("""CREATE FUNCTION p027_retry_witness() RETURNS trigger LANGUAGE plpgsql
          SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
          BEGIN
           IF nextval('public.p027_retry_attempt')<=2 THEN
            RAISE EXCEPTION USING ERRCODE=TG_ARGV[0],MESSAGE='public-fixture retry';
           END IF;
           RETURN NEW;
          END $$""")
        cur.execute("CREATE TRIGGER p027_retry BEFORE INSERT ON math_main FOR EACH ROW EXECUTE FUNCTION p027_retry_witness(%s)",(sqlstate,))
    metrics=tmp_path/"retry.jsonl"
    launch(db,extra={"P026_METRICS":str(metrics)}).done()
    current=assert_coherent(db)
    assert current["math_ticks"]["math_tick"]==0
    from coordinator.test_incremental import emf
    assert sum(r.get("PublishRetried",0) for r in emf(metrics))==2
    with c.cursor() as cur:
        cur.execute("SELECT last_value FROM p027_retry_attempt")
        assert cur.fetchone()[0]==3
        cur.execute("SELECT count(*) FROM polis_coordinator_generations")
        assert cur.fetchone()[0]==1
        cur.execute("SELECT count(*) FROM polis_coordinator_payloads")
        assert cur.fetchone()[0]==3
    c.close()


@pytest.mark.parametrize("damage",["deleted","regressed"])
def test_retained_history_repairs_lost_or_regressed_current_rows(db,launch,damage):
    seed(db);launch(db).done()
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,2000)")
    launch(db).done()
    before=assert_coherent(db)
    assert before["math_ticks"]["math_tick"]==1
    with c.cursor() as cur:
        cur.execute("SELECT math_tick,payload_kind,original_sha256 FROM polis_coordinator_payloads ORDER BY math_tick,payload_kind")
        retained=cur.fetchall()
        if damage=="deleted":
            for table in ("math_main","math_bidtopid","math_ptptstats","math_ticks"):
                cur.execute(f"DELETE FROM {table} WHERE math_env='rustproto'")
        else:
            cur.execute("UPDATE math_ticks SET math_tick=0 WHERE math_env='rustproto'")
    launch(db).done()
    after=assert_coherent(db)
    assert after["math_ticks"]["math_tick"]==2
    assert after["math_main"]["caching_tick"]>before["math_main"]["caching_tick"]
    with c.cursor() as cur:
        cur.execute("SELECT math_tick,payload_kind,original_sha256 FROM polis_coordinator_payloads WHERE math_tick<2 ORDER BY math_tick,payload_kind")
        assert cur.fetchall()==retained
        cur.execute("SELECT math_tick FROM polis_coordinator_generations ORDER BY math_tick")
        assert cur.fetchall()==[(0,),(1,),(2,)]
    c.close()
