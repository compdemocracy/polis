"""Black-box ports of R05/R07/R08/R09/R11/R12; no candidate monkeypatches."""
import json
import signal
import threading
import time
import pytest
from coordinator.conftest import (ARTIFACTS, FOLD, MAPPING, seed, rows, connect, assert_coherent, expire,
    lease, wait, repair_after_unclean_death)

PUBLISH_STAGES=["after_lease","after_source_selection","after_input_checkpoint","before_worker_apply",
    "after_worker_compute","before_ticks","after_ticks","before_bidtopid","after_bidtopid",
    "before_ptptstats","after_ptptstats","before_main","after_main","before_commit","after_commit","after_ack"]


def test_smoke(db,launch):
    seed(db)
    launch(db).done()
    assert_coherent(db)


@pytest.mark.parametrize("stage",PUBLISH_STAGES)
def test_r05_unclean_death_restart_repairs(db,launch,tmp_path,stage):
    """R05 with no expire() anywhere: the dead owner's lease is left exactly as
    an unclean death leaves it, and the restart has to repair through it."""
    seed(db)
    child=launch(db,stage=stage,directory=tmp_path/"latch",extra={"P026_LEASE_SECONDS":"2"})
    ack=child.ack()
    child.kill()
    held=lease(db)
    assert held is not None and held["owner_epoch"]==1 # killed owners never release
    interim=rows(db)
    if stage not in ("after_commit","after_ack"):
        assert all(v is None for v in interim.values())
    else:
        assert_coherent(db)
    _,err=repair_after_unclean_death(launch,db,
        lambda: rows(db)["math_main"] is not None and lease(db)["owner_epoch"]>1,
        why=f"repair after unclean death at {stage}")
    assert "FENCED" not in err # a dead owner is not a superseding one
    tables=assert_coherent(db)
    (ARTIFACTS/f"stage-{stage}.json").write_text(json.dumps({"stage":stage,"ack":ack,
        "signal":"SIGKILL","exit":-signal.SIGKILL,"restart":"passed","manual_lease_expiry":False,
        "repaired_epoch":lease(db)["owner_epoch"],"math_tick":tables["math_main"]["math_tick"],
        "postcondition":"coherent; independent fold exact; dead owner's lease never expired by the harness"},indent=2))


def test_r05_restart_inside_a_live_lease_defers_then_repairs(db,launch,tmp_path):
    """The liveness defect itself: a restart inside the dead owner's lease
    window must defer the zid and stay alive, not refuse and exit."""
    seed(db)
    child=launch(db,stage="after_worker_compute",directory=tmp_path/"live",extra={"P026_LEASE_SECONDS":"8"})
    child.ack();child.kill()
    held=lease(db)
    assert held["unexpired"] and held["owner_epoch"]==1
    restart=launch(db,"run",extra={"P026_LEASE_SECONDS":"8","P026_POLL_MS":"50"})
    for _ in range(20): # inside the window: alive, and publishing nothing
        assert restart.proc.poll() is None
        assert rows(db)["math_main"] is None
        time.sleep(.05)
    wait(lambda: rows(db)["math_main"] is not None,timeout=90,alive=restart,why="repair after genuine expiry")
    assert_coherent(db)
    _,err=restart.kill()
    assert "LEASE-UNAVAILABLE" in err and "FENCED" not in err
    # The takeover is a strictly greater epoch, never a reused one; the daemon
    # keeps cycling after the repair, so only monotonicity is asserted.
    assert lease(db)["owner_epoch"]>=2


@pytest.mark.parametrize("stage",["after_worker_compute","before_main"])
def test_r05_expired_lease_restart_repairs(db,launch,tmp_path,stage):
    """Explicit DB-time lease-loss control, kept alongside the unclean-death
    matrix: with the lease already gone the restart takes over immediately."""
    seed(db)
    child=launch(db,stage=stage,directory=tmp_path/"expired")
    child.ack();child.kill()
    expire(db)
    assert lease(db)["unexpired"] is False
    launch(db).done()
    assert_coherent(db)


def test_r06_cache_eviction_contends_with_same_zid_update(db,launch,tmp_path):
    """CO07 R06: an LRU eviction and an update to the very zid being evicted.
    No lost input, no dropped conversation, and the warm path must publish what
    a cold rebuild of the same source publishes."""
    seed(db,1);seed(db,2)
    launch(db).done()
    launch(db,env="recovery",extra={"P026_CACHE_CAP":"0"}).done() # cold reference namespace
    # P026_RECONCILE_SECONDS=1 so the authoritative path runs every second and
    # actually loads bundles into the cache: the incremental fast path skips
    # both the source read and the store read, so a cache with nothing resident
    # would never fill and never evict.
    child=launch(db,"run",stage="cache_eviction_contends_with_same_zid_update",
        directory=tmp_path/"cache",extra={"P026_CACHE_CAP":"1","P026_POLL_MS":"20",
        "P026_RECONCILE_SECONDS":"1"})
    ack=child.ack()
    context=ack["context"]
    # the race is staged, not assumed: this zid really is being evicted now
    assert context["evicted_zid"]==1 and context["inserted_zid"]==2
    assert context["capacity"]==1 and context["cache_len"]==1
    c=connect(db)
    with c.cursor() as cur:cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,2000)")
    c.close()
    child.release()
    wait(lambda: rows(db)["math_ticks"]["input_checkpoint"]["event_count"]==25,
        timeout=90,alive=child,why="the update to the evicted zid is published")
    child.kill()
    warm=assert_coherent(db,1);assert_coherent(db,2)
    launch(db,env="recovery",extra={"P026_CACHE_CAP":"0"}).done()
    cold=rows(db,1,env="recovery")["math_main"]["data"]
    drop=lambda blob:{k:v for k,v in blob.items() if k!="math_tick"}
    assert drop(warm["math_main"]["data"])==drop(cold) # evicted-vs-cold reference
    (ARTIFACTS/"stage-cache_eviction_contends_with_same_zid_update.json").write_text(json.dumps(
        {"stage":"cache_eviction_contends_with_same_zid_update","ack":ack,
         "action":"same-zid vote committed while the LRU eviction of that zid is blocked",
         "postcondition":"no lost input; evicted zid republished coherently; warm output equals the cold-rebuild reference"},indent=2))


def test_r07_duplicate_refused_healthy_winner(db,launch,tmp_path):
    seed(db)
    winner=launch(db,stage="after_lease",directory=tmp_path/"owned")
    winner.ack()
    loser=launch(db)
    # A live owner is LEASE-UNAVAILABLE (recoverable), never FENCED.
    _,err=loser.done(code=4)
    assert "LEASE-UNAVAILABLE" in err and "FENCED" not in err
    assert winner.proc.poll() is None
    winner.release();winner.done()
    assert_coherent(db)


def test_r07_stale_owner_cannot_publish_after_transfer(db,launch,tmp_path):
    seed(db)
    old=launch(db,stage="after_worker_compute",directory=tmp_path/"old")
    old.ack()
    expire(db)
    launch(db).done()
    before=rows(db)
    old.release()
    _,err=old.done(code=3)
    assert "FENCED" in err # superseded owner/epoch, not a merely unavailable lease
    assert rows(db)==before
    assert_coherent(db)


@pytest.mark.parametrize("created",[1023,1010])
def test_r08_late_and_equal_commit(db,launch,created):
    seed(db)
    launch(db).done()
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,%s)",(created,))
        cur.execute("SELECT count(*) FROM votes WHERE zid=1 AND pid=0 AND tid=0 AND vote=1 AND created=%s",(created,))
        assert cur.fetchone()[0]==1 # preserved committed-row control
    c.close()
    launch(db).done()
    assert_coherent(db)


def test_r08_moderation_and_unmoderation_without_votes(db,launch):
    seed(db);launch(db).done()
    c=connect(db)
    for value in (-1,0):
        with c.cursor() as cur:
            cur.execute("SET session_replication_role=replica")
            cur.execute("UPDATE comments SET mod=%s,modified=1000 WHERE zid=1 AND tid=1",(value,))
        launch(db).done()
        data=rows(db)["math_main"]["data"]
        assert set(data["moderation"]["mod_out_tids"])==({1} if value==-1 else set())
    c.close()


def test_r09_snapshot_reader_during_actual_writer(db,launch,tmp_path):
    seed(db);launch(db).done()
    c=connect(db)
    with c.cursor() as cur:cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,2000)")
    c.close()
    writer=launch(db,stage="after_bidtopid",directory=tmp_path/"writer")
    writer.ack()
    old=rows(db)
    for _ in range(20):
        snapshot=rows(db)
        assert snapshot==old
        a,b,p=[snapshot[t]["data"] for t in ("math_main","math_bidtopid","math_ptptstats")]
        assert MAPPING(a,b,p)==[]
    writer.release();writer.done()
    assert_coherent(db)
    assert rows(db)["math_main"]["math_tick"]==old["math_main"]["math_tick"]+1


def test_r09_quiet_incomplete_repair(db,launch):
    seed(db);launch(db).done()
    c=connect(db)
    with c.cursor() as cur:cur.execute("DELETE FROM math_bidtopid WHERE zid=1 AND math_env='rustproto'")
    c.close()
    launch(db).done()
    assert_coherent(db)


def test_r11_namespace_restore_and_repair_isolation(db,launch):
    seed(db);launch(db,env="python").done()
    before=rows(db,env="python")
    launch(db).done()
    assert rows(db,env="python")==before
    c=connect(db)
    with c.cursor() as cur:cur.execute("DELETE FROM math_ptptstats WHERE math_env='rustproto'")
    c.close();launch(db).done()
    assert_coherent(db)
    assert rows(db,env="python")==before


def test_r12_out_of_order_outside_window_metadata_sweep(db,launch,tmp_path):
    seed(db,1);seed(db,2);seed(db,3);seed(db,4)
    a=launch(db,stage="after_main",directory=tmp_path/"a",extra={"POLL_ALLOWLIST":"1"})
    a.ack()
    launch(db,extra={"POLL_ALLOWLIST":"2,3,4"}).done()
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("SELECT max(caching_tick) FROM math_main WHERE math_env='rustproto'")
        high=cur.fetchone()[0]
        cur.execute("SELECT zid FROM math_main WHERE caching_tick>0 AND math_env='rustproto'")
        seen={r[0] for r in cur}
    a.release();a.done()
    with c.cursor() as cur:
        cur.execute("SELECT zid FROM math_main WHERE caching_tick>%s AND math_env='rustproto'",(high,))
        seen.update(r[0] for r in cur)
    assert seen=={2,3,4} # naive cursor MUST still miss the late committer
    out,_=launch(db,"poll",args=(high,)).done()
    assert 1 not in {r["zid"] for r in json.loads(out)} # beyond finite W
    swept=set();after=0
    for _ in range(3):
        out,_=launch(db,"scan",args=(after,)).done()
        page=json.loads(out)
        swept.update(r["zid"] for r in page)
        if page:after=page[-1]["zid"]
    assert swept=={1,2,3,4}
    c.close()


def test_r12_sequence_negative_control_seen_two(db,launch,tmp_path):
    seed(db,1);seed(db,2)
    a=launch(db,stage="after_main",directory=tmp_path/"a",extra={"POLL_ALLOWLIST":"1"})
    a.ack();launch(db,extra={"POLL_ALLOWLIST":"2"}).done()
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("SELECT zid,caching_tick FROM math_main WHERE math_env='rustproto'")
        observed=cur.fetchall();seen={r[0] for r in observed};high=max(r[1] for r in observed)
    a.release();a.done()
    for _ in range(3):
        with c.cursor() as cur:
            cur.execute("SELECT zid FROM math_main WHERE caching_tick>%s AND math_env='rustproto'",(high,))
            seen.update(r[0] for r in cur)
    assert seen=={2}
    assert rows(db,1)["math_main"]["caching_tick"]!=rows(db,2)["math_main"]["caching_tick"]
    c.close()


def test_unmarked_kill_is_unclean(db,launch):
    seed(db)
    child=launch(db,mode="run")
    child.kill()
    assert child.proc.returncode==-signal.SIGKILL


def test_unrelated_failure_is_not_refusal(db,launch):
    broken=db.rsplit('/',1)[0]+'/p026_nonexistent'
    _,err=launch(broken).done(code=1)
    assert not any(token in err for token in ("FENCED","LEASE-UNAVAILABLE","LEASE-EXPIRED"))


@pytest.mark.parametrize("stage",["before_restore","after_restore"])
def test_restore_stage_recovery(db,launch,tmp_path,stage):
    seed(db);launch(db).done()
    c=connect(db)
    with c.cursor() as cur:cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,2000)")
    c.close()
    child=launch(db,stage=stage,directory=tmp_path/'restore',extra={'P026_LEASE_SECONDS':'2'})
    ack=child.ack();child.kill()
    assert lease(db)['unexpired'] # the dead owner's lease is left live, as R05 requires
    repair_after_unclean_death(launch,db,
        lambda: rows(db)['math_ticks']['input_checkpoint']['event_count']==25,why=f'restore repair at {stage}')
    assert_coherent(db)
    (ARTIFACTS/f'stage-{stage}.json').write_text(json.dumps(dict(stage=stage,ack=ack,signal='SIGKILL',restart='passed',manual_lease_expiry=False,postcondition='coherent independent fold')))


@pytest.mark.parametrize("stage",["before_cursor","after_cursor","before_sweep","after_sweep"])
def test_reader_stages(db,launch,tmp_path,stage):
    seed(db);launch(db).done()
    child=launch(db,'reader',stage=stage,directory=tmp_path/'reader')
    ack=child.ack();child.kill()
    seen=set()
    for _ in range(3):
        out,_=launch(db,'reader').done()
        seen.update(b['payloads']['main']['zid'] for b in json.loads(out))
    assert seen=={1}
    (ARTIFACTS/f'stage-{stage}.json').write_text(json.dumps(dict(stage=stage,ack=ack,signal='SIGKILL',restart='passed',postcondition='reader redelivered complete bundle')))


@pytest.mark.parametrize("stage",["bundle_pinned","before_companion_join"])
def test_pinned_bundle_survives_replacement(db,launch,tmp_path,stage):
    seed(db);launch(db).done()
    old=rows(db)['math_main']['math_tick']
    child=launch(db,'read',stage=stage,directory=tmp_path/'read',args=(1,))
    ack=child.ack()
    c=connect(db)
    with c.cursor() as cur:cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,2000)")
    c.close();launch(db).done()
    child.release();out,_=child.done();bundle=json.loads(out)
    assert bundle['math_tick']==old
    p=bundle['payloads'];assert MAPPING(p['main'],p['bidtopid'],p['ptptstats'])==[]
    (ARTIFACTS/f'stage-{stage}.json').write_text(json.dumps(dict(stage=stage,ack=ack,action='atomic replacement by second process; release',postcondition='old pinned bundle remains coherent')))


def test_r12_real_reader_recovers_after_advance(db,launch,tmp_path):
    for zid in (1,2,3,4):seed(db,zid)
    a=launch(db,stage='after_main',directory=tmp_path/'late',extra={'POLL_ALLOWLIST':'1'})
    a.ack();launch(db,extra={'POLL_ALLOWLIST':'2,3,4'}).done()
    seen=set()
    for _ in range(4):
        out,_=launch(db,'reader').done();seen.update(b['payloads']['main']['zid'] for b in json.loads(out))
    assert seen=={2,3,4}
    a.release();a.done()
    for _ in range(4):
        out,_=launch(db,'reader').done();seen.update(b['payloads']['main']['zid'] for b in json.loads(out))
    assert seen=={1,2,3,4}


def test_r07_disjoint_shards_cover_every_zid(db,launch):
    for zid in range(1,7):seed(db,zid)
    a=launch(db,extra={'POLL_SHARD_INDEX':'0','POLL_SHARD_COUNT':'2'})
    b=launch(db,extra={'POLL_SHARD_INDEX':'1','POLL_SHARD_COUNT':'2'})
    a.done();b.done()
    for zid in range(1,7):
        tables=assert_coherent(db,zid)
        assert tables['math_main']['math_tick']==0


def test_r07_old_new_shard_overlap_is_fenced(db,launch,tmp_path):
    for zid in (2,4,6):seed(db,zid)
    old=launch(db,stage='after_lease',directory=tmp_path/'old-shard',extra={'POLL_SHARD_INDEX':'0','POLL_SHARD_COUNT':'2','POLL_ALLOWLIST':'2'})
    old.ack()
    new=launch(db,extra={'POLL_SHARD_INDEX':'2','POLL_SHARD_COUNT':'3','POLL_ALLOWLIST':'2'})
    # The old shard owner is still live, so the overlap is refused as unavailable.
    _,err=new.done(code=4);assert 'LEASE-UNAVAILABLE' in err
    old.release();old.done()
    launch(db,extra={'POLL_SHARD_COUNT':'3','POLL_SHARD_INDEX':'0'}).done()
    launch(db,extra={'POLL_SHARD_COUNT':'3','POLL_SHARD_INDEX':'1'}).done()
    for zid in (2,4,6):assert_coherent(db,zid)


def test_r08_exact_duplicate_multiplicity(db,launch):
    seed(db);launch(db).done()
    c=connect(db)
    with c.cursor() as cur:
        cur.execute('SET session_replication_role=replica') # admit a legacy duplicate, bypass latest-unique maintenance
        cur.execute('INSERT INTO votes(zid,pid,tid,vote,created) SELECT zid,pid,tid,vote,created FROM votes WHERE zid=1 AND pid=0 AND tid=0')
    c.close();launch(db).done()
    t=assert_coherent(db)
    assert t['math_ticks']['input_checkpoint']['event_count']==25
    assert t['math_main']['data']['user-vote-counts']['0']==4


def test_failed_zid_does_not_starve_source_sweep(db,launch):
    seed(db,1);seed(db,2)
    c=connect(db)
    with c.cursor() as cur:cur.execute('UPDATE votes SET vote=NULL WHERE zid=1 AND pid=0 AND tid=0')
    child=launch(db,'run',extra={'P026_POLL_MS':'20'})
    deadline=time.monotonic()+30
    while not rows(db,2)['math_main'] and time.monotonic()<deadline:
        assert child.proc.poll() is None
        time.sleep(.05)
    assert_coherent(db,2)
    with c.cursor() as cur:
        cur.execute("SELECT attempts FROM polis_coordinator_failures WHERE zid=1 AND math_env='rustproto'")
        assert cur.fetchone()[0]>=1
        cur.execute('UPDATE votes SET vote=-1 WHERE zid=1 AND pid=0 AND tid=0')
    deadline=time.monotonic()+30
    while not rows(db,1)['math_main'] and time.monotonic()<deadline:time.sleep(.05)
    assert_coherent(db,1)
    child.kill();c.close()


def test_empty_with_approved_comments_has_explicit_empty_math(db,launch):
    seed(db,votes=False,n_cmts=2)
    c=connect(db)
    with c.cursor() as cur:cur.execute('UPDATE comments SET mod=1 WHERE zid=1')
    c.close();launch(db).done()
    t=assert_coherent(db)
    main=t['math_main']['data']
    assert main['n']==0 and main['n-cmts']==0 and main['tids']==[]
    assert main['mod-in']==[0,1]
    assert main['pca']=={'center':[],'comps':[[],[]],'comment-projection':[[],[]],'comment-extremity':[]}
    assert t['math_ticks']['input_checkpoint']['event_count']==0


def test_database_error_rolls_back_all_publication_tables(db,launch):
    seed(db)
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("ALTER TABLE math_main ADD CONSTRAINT p026_reject CHECK(math_env <> 'rustproto')")
    _,err=launch(db).done(code=1)
    assert 'coordinator failed' in err
    assert all(v is None for v in rows(db).values())
    with c.cursor() as cur:cur.execute('ALTER TABLE math_main DROP CONSTRAINT p026_reject')
    assert lease(db)['unexpired'] is False
    launch(db).done();assert_coherent(db);c.close()


def test_r08_reference_warm_cache_negative_control(db,launch):
    import os,subprocess,sys
    from coordinator.conftest import ROOT
    seed(db)
    env=dict(os.environ,DATABASE_URL=db,PYTHONPATH=str(ROOT/'delphi'),OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1')
    ref=subprocess.run([sys.executable,str(ROOT/'delphi/tests/coordinator/reference_child.py'),'--warm-boundary'],env=env,capture_output=True,text=True,timeout=120)
    assert ref.returncode==0,(ref.stdout,ref.stderr)
    c=connect(db)
    with c.cursor() as cur:
        cur.execute('SELECT pid,tid,vote,created FROM votes WHERE zid=1 ORDER BY created')
        events=[dict(zip(('pid','tid','vote','created'),r)) for r in cur]
    c.close()
    assert len(events)==26
    problems=FOLD.check_published_against_fold(rows(db,env='python')['math_main']['data'],FOLD.fold_votes(events))
    assert problems, 'warm strict-watermark reference must miss the committed boundary vote'
    launch(db).done();assert_coherent(db)


def test_actual_worker_sigkill_is_not_success(db,launch,tmp_path):
    import os
    seed(db)
    child=launch(db,stage='before_worker_apply',directory=tmp_path/'worker-death')
    ack=child.ack();worker_pid=ack['context']['worker_pid']
    assert worker_pid!=child.proc.pid
    os.kill(worker_pid,signal.SIGKILL)
    child.release();child.done(code=1)
    assert all(v is None for v in rows(db).values())
    assert lease(db)['unexpired'] is False # a clean failure releases its own epoch
    launch(db).done();assert_coherent(db)


def test_terminate_actual_publication_backend_rolls_back(db,launch,tmp_path):
    seed(db)
    child=launch(db,stage='after_bidtopid',directory=tmp_path/'backend-death')
    ack=child.ack();backend=ack['context']['backend_pid']
    c=connect(db)
    with c.cursor() as cur:
        cur.execute('SELECT state,xact_start,query FROM pg_stat_activity WHERE pid=%s',(backend,))
        state,start,query=cur.fetchone()
        assert state=='active' and start is not None and 'public.pc_publish(' in query
        cur.execute("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=%s AND relation='math_bidtopid'::regclass AND granted AND mode='RowExclusiveLock')",(backend,))
        assert cur.fetchone()[0] # actual function backend has performed the write
        cur.execute('SELECT pg_terminate_backend(%s)',(backend,));assert cur.fetchone()[0]
    child.release();child.done(code=1)
    assert all(v is None for v in rows(db).values())
    assert lease(db)['unexpired'] is False # a clean failure releases its own epoch
    launch(db).done();assert_coherent(db);c.close()
