"""D06 real observer credential, continuous current-table checks and bounded delivery."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit,urlunsplit

import psycopg2
import pytest

from coordinator.conftest import ARTIFACTS,ROOT,connect,seed,rows,wait
from coordinator.test_writer_authority import query,rollback_to_legacy

spec=importlib.util.spec_from_file_location('d06_observer',ROOT/'coordinator-rs/tools/d06/observer.py')
observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)
PROFILE={'environment':'public-fixture','math_env':'rustproto','shards':1,'allowlist':[]}


def observer_url(db):
    p=urlsplit(db)
    return urlunsplit(p._replace(netloc='p027_observer@'+p.netloc.split('@')[-1]))


def observed(db,profile=PROFILE):
    with contextlib.closing(psycopg2.connect(observer_url(db))) as conn:
        return observer.sample(conn,profile)


def crosscheck(db):
    return query(db,"""SELECT count(*) FILTER (WHERE m.math_tick IS NULL OR t.math_tick>m.math_tick),
        count(*) FILTER (WHERE m.math_tick>t.math_tick) FROM math_ticks t LEFT JOIN math_main m
        ON m.zid=t.zid AND m.math_env=%s WHERE t.math_env=%s""",('rustproto','rustproto'))[0]


@pytest.mark.parametrize('statement',[
 "SELECT pc_namespace_allowed('rustproto')",
 "SELECT pc_writer_allowed('rustproto',1)",
 'UPDATE polis_coordinator_operations SET protected=true WHERE false',
 'UPDATE math_ticks SET math_tick=0 WHERE false',
 'UPDATE math_main SET math_tick=0 WHERE false',
 'DELETE FROM math_bidtopid WHERE false',
],ids=['namespace','writer','write','ticks','main','bid'])
def test_observer_six_actual_authority_refusals(db,statement):
    with contextlib.closing(connect(observer_url(db))) as c,c.cursor() as cur:
        with pytest.raises(psycopg2.errors.InsufficientPrivilege) as error:cur.execute(statement)
        assert error.value.pgcode=='42501'


def test_observer_no_function_execution_or_write_and_wrong_credential_refuses(db):
    with contextlib.closing(psycopg2.connect(observer_url(db))) as c,c.cursor() as cur:observer.admit(cur)
    with contextlib.closing(psycopg2.connect(db)) as c:
        value=observer.sample(c,PROFILE)
    assert value['code']=='OBSERVER_AUTHORITY' and value['ObserverHealthy']==0
    assert 'PublishLagSeconds' not in value


def test_observer_idle_needs_real_completed_poll_and_stale_fails(db,launch):
    before=observed(db)
    assert before['PollHealthy']==0 and before['code']=='POLL_MISSING'
    assert before['ObserverHealthy']==1 and before['PublishLagSeconds']==0
    launch(db).done()
    value=observed(db)
    assert value['PollHealthy']==value['ObserverHealthy']==1
    assert value['PendingOperations']==value['PublishLagSeconds']==0
    query(db,"UPDATE polis_coordinator_cursors SET position=jsonb_set(position,'{started}',to_jsonb(extract(epoch FROM clock_timestamp())::float8-121)) WHERE consumer='poll-health-0-1'")
    stale=observed(db)
    assert stale['PollHealthy']==0 and stale['code']=='POLL_STALE'


def test_observer_committed_receipts_pending_transition_and_crosscheck_limits(db,launch,tmp_path):
    seed(db)
    worker=launch(db,stage='after_worker_compute',directory=tmp_path/'pending')
    worker.ack()
    query(db,"UPDATE polis_coordinator_operations SET admitted_at=admitted_at-interval '901 seconds' WHERE math_env='rustproto'")
    pending=observed(db)
    assert pending['PendingOperations']==1 and pending['PublishLagSeconds']>=901
    assert crosscheck(db)==(0,0)
    # Actual committed publication is seen before control reconciliation.
    worker.release();worker.done()
    committed=observed(db)
    assert committed['PendingOperations']==0 and committed['PublishLagSeconds']==0
    query(db,"UPDATE polis_coordinator_operations SET state='pending',resolved_tick=NULL WHERE math_env='rustproto'")
    unreconciled=observed(db)
    assert unreconciled['PendingOperations']==0 and unreconciled['PublishLagSeconds']==0
    assert crosscheck(db)==(0,0)
    query(db,"UPDATE math_ticks SET math_tick=math_tick+1,modified=now_as_millis()-900000 WHERE math_env='rustproto'")
    tick_fault=observed(db)
    assert tick_fault['PendingOperations']==0 and crosscheck(db)==(1,0)
    assert tick_fault['CurrentBehind']==1 and tick_fault['CurrentLagSeconds']>=900
    assert tick_fault['PublishLagSeconds']==tick_fault['CurrentLagSeconds']
    assert tick_fault['CurrentPointerHealthy']==0 and tick_fault['ObserverHealthy']==1
    query(db,"UPDATE math_ticks SET math_tick=math_tick-1 WHERE math_env='rustproto'")
    query(db,"UPDATE math_main SET math_tick=math_tick+1 WHERE math_env='rustproto'")
    ahead=observed(db)
    assert ahead['ObserverHealthy']==0 and ahead['code']=='OBSERVER_CURRENT'
    assert ahead['CurrentAhead']==1 and 'PublishLagSeconds' not in ahead
    assert crosscheck(db)==(0,1)
    query(db,"UPDATE math_main SET math_tick=math_tick-1 WHERE math_env='rustproto'")
    launch(db,env='python').done()
    rollback_to_legacy(db)
    transition=observed(db)
    assert transition['Transitions']==1
    packet={'schema':'polis-d06-receipt/2','runtime_scope':'metadata_and_current_tables',
      'crosscheck_scope':'continuous_observer_login','alarm_delivery':'OPERATOR_NOT_EVALUATED',
      'catches':{'observer':['ADMITTED_UNPUBLISHED','POLL_MISSING','POLL_STALE','OBSERVER_QUERY',
                            'TICK_ONLY_INVALIDATION','MAIN_AHEAD','MISSING_TICKS','BUNDLE_POINTER_MISMATCH']},
      'cannot_catch':{'observer':['MISSED_SOURCE_INPUT','PAYLOAD_CONTENT','ALARM_DESTINATION_DELIVERY']},
      'pending':pending,'published_unreconciled':unreconciled,'transition':transition,
      'tick_fault':tick_fault,'main_ahead':ahead}
    (ARTIFACTS/'d06-observer.json').write_text(json.dumps(packet,sort_keys=True)+'\n')


def test_observer_real_unreconciled_commit_is_not_publication_lag(db,launch,tmp_path):
    seed(db)
    worker=launch(db,stage='after_commit',directory=tmp_path/'commit')
    worker.ack()
    try:
        assert query(db,"SELECT state FROM polis_coordinator_operations WHERE math_env='rustproto'")==[('pending',)]
        assert observed(db)['PendingOperations']==0
    finally:worker.release();worker.done()


@pytest.mark.parametrize('kind',['query','future','missing-profile','wrong-scope'])
def test_incomplete_observer_never_emits_zero_lag(db,kind):
    if kind=='query':query(db,'ALTER TABLE polis_coordinator_operations RENAME TO hidden_operations')
    if kind=='missing-profile':query(db,"DELETE FROM polis_coordinator_budgets WHERE math_env='rustproto'")
    if kind in ('future','wrong-scope'):
        position={'schema':'polis-poll-health/1','healthy':True,'scope':observer.scope_digest(PROFILE),
                  'started':time.time()+86400 if kind=='future' else time.time()}
        if kind=='wrong-scope':position['scope']='0'*64
        query(db,"INSERT INTO polis_coordinator_cursors VALUES('rustproto','poll-health-0-1',%s)",(json.dumps(position),))
    value=observed(db)
    assert value['ObserverHealthy']==0 and 'PublishLagSeconds' not in value
    assert 'hidden_operations' not in json.dumps(value)


def test_observer_scope_requires_every_shard(db,launch):
    launch(db,extra={'POLL_SHARD_COUNT':'2','POLL_SHARD_INDEX':'0'}).done()
    p={**PROFILE,'shards':2}
    assert observed(db,p)['PollHealthy']==0
    launch(db,extra={'POLL_SHARD_COUNT':'2','POLL_SHARD_INDEX':'1'}).done()
    assert observed(db,p)['PollHealthy']==1
    assert observed(db)['ObserverHealthy']==1 and observed(db)['PollHealthy']==0


def test_stalled_producer_does_not_refresh_health(db,launch,tmp_path):
    seed(db)
    child=launch(db,stage='after_source_selection',directory=tmp_path/'source')
    child.ack()
    try:
        assert observed(db)['PollHealthy']==0
    finally:child.kill()
    assert observed(db)['PollHealthy']==0


def test_failed_source_poll_does_not_claim_success(db,launch):
    seed(db)
    query(db,'ALTER TABLE votes RENAME TO hidden_votes')
    launch(db).done(code=1)
    value=observed(db)
    assert value['PollHealthy']==0


def test_metrics_fifo_stall_cannot_block_real_computation(db,launch,tmp_path):
    seed(db);seed(db,zid=2)
    fifo=tmp_path/'blocked.fifo';os.mkfifo(fifo)
    child=launch(db,extra={'P026_METRICS':str(fifo)})
    child.proc.communicate(timeout=10)
    assert child.proc.returncode==0 and rows(db,zid=2)['math_main'] is not None


@pytest.mark.parametrize('failure',['blocked','disconnected','disk-full'])
def test_delivery_is_bounded_and_errors_cannot_leak(failure):
    entered=threading.Event();release=threading.Event()
    def sink(raw):
        entered.set()
        if failure=='blocked':release.wait(10)
        else:raise OSError(28 if failure=='disk-full' else 32,'private fixture text')
    d=observer.Delivery(sink,2)
    try:
        d.emit({'code':'OK'});assert entered.wait(2)
        started=time.monotonic()
        for _ in range(1000):d.emit({'code':'OK'})
        d.close()
        assert time.monotonic()-started<2 and d.dropped>0
        assert d.queue.qsize()<=2
    finally:release.set()


@pytest.mark.parametrize('key',['PollHealthy','ObserverHealthy','PublishLagSeconds'])
def test_alarm_missing_data_and_recovery(key):
    assert observer.alarm([None]*5,key)==(key!='PublishLagSeconds')
    breach=601 if key=='PublishLagSeconds' else 0
    good=0 if key=='PublishLagSeconds' else 1
    assert observer.alarm([breach]*3+[good]*2,key)
    assert not observer.alarm([good]*5,key)


def test_locked_observation_times_out_without_lag_zero(db):
    with contextlib.closing(psycopg2.connect(db)) as locked:
        with locked.cursor() as cur:cur.execute('LOCK polis_coordinator_operations IN ACCESS EXCLUSIVE MODE')
        start=time.monotonic();value=observed(db)
        assert time.monotonic()-start<3
        assert value['ObserverHealthy']==0 and 'PublishLagSeconds' not in value


def test_unresolved_work_survives_unrelated_resolution(db,launch,tmp_path):
    seed(db);seed(db,zid=2)
    child=launch(db,stage='after_worker_compute',directory=tmp_path/'lost',extra={'POLL_ALLOWLIST':'1'})
    child.ack();child.kill()
    query(db,"UPDATE polis_coordinator_operations SET state='unresolved' WHERE math_env='rustproto' AND zid=1")
    before=observed(db)
    assert before['UnresolvedOperations']==1
    running=launch(db,mode='run',extra={'P026_POLL_MS':'20'})
    try:
        wait(lambda: rows(db,zid=2)['math_main'] is not None and observed(db).get('code')=='POLL_FAILED',alive=running,why='unrelated publication and completed failed sweep')
        assert observed(db)['UnresolvedOperations']==1
    finally:running.kill()


@pytest.mark.parametrize('change',['delivery','scope','limits','payload','published','missing','tick','ahead','lag','nan','boolean'])
def test_receipt_refuses_overclaim_or_missing_evidence(change):
    spec=importlib.util.spec_from_file_location('d06_verify',ROOT/'coordinator-rs/tools/d06/verify.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    sample={'schema':'polis-observer/1','Environment':'public-fixture','MathEnv':'rustproto',
            'ObserverHealthy':1,'PollHealthy':0,'PublishLagSeconds':901,'AdmittedLagSeconds':901,
            'CurrentLagSeconds':0,'PendingOperations':1,'CurrentBehind':0,'CurrentAhead':0,
            'CurrentMissingTicks':0,'CurrentBundleMismatch':0,'CurrentPointerHealthy':1,
            'WithdrawnPendingOperations':0,'UnresolvedOperations':0,'Transitions':0,'code':'POLL_MISSING'}
    r={'schema':'polis-d06-receipt/2','runtime_scope':'metadata_and_current_tables',
      'crosscheck_scope':'continuous_observer_login','alarm_delivery':'OPERATOR_NOT_EVALUATED',
      'catches':{'observer':['ADMITTED_UNPUBLISHED','POLL_MISSING','POLL_STALE','OBSERVER_QUERY',
                            'TICK_ONLY_INVALIDATION','MAIN_AHEAD','MISSING_TICKS','BUNDLE_POINTER_MISMATCH']},
      'cannot_catch':{'observer':['MISSED_SOURCE_INPUT','PAYLOAD_CONTENT','ALARM_DESTINATION_DELIVERY']},
      'pending':sample,'published_unreconciled':dict(sample,PublishLagSeconds=0,AdmittedLagSeconds=0,PendingOperations=0),
      'transition':dict(sample,Transitions=1),
      'tick_fault':dict(sample,PublishLagSeconds=900,AdmittedLagSeconds=0,CurrentLagSeconds=900,
                        PendingOperations=0,CurrentBehind=1,CurrentPointerHealthy=0),
      'main_ahead':{k:v for k,v in dict(sample,ObserverHealthy=0,CurrentAhead=1,
                   CurrentPointerHealthy=0,code='OBSERVER_CURRENT').items() if k in module.BASE|module.POINTER}}
    assert module.verify(r)['local_observer']=='PASS'
    if change=='delivery':r['alarm_delivery']='PASS'
    if change=='scope':r['runtime_scope']='current_tables'
    if change=='limits':r['cannot_catch']['observer']=[]
    if change=='payload':r['pending']['payload']='private fixture'
    if change=='published':r['published_unreconciled']['PublishLagSeconds']=1
    if change=='missing':del r['transition']
    if change=='tick':r['tick_fault']['CurrentBehind']=0
    if change=='ahead':r['main_ahead']['ObserverHealthy']=1
    if change=='lag':r['tick_fault']['PublishLagSeconds']=0
    if change=='nan':r['pending']['PublishLagSeconds']=float('nan')
    if change=='boolean':r['pending']['ObserverHealthy']=True
    with pytest.raises(ValueError):module.verify(r)


@pytest.mark.parametrize('table',['math_main','math_ticks','math_bidtopid','math_ptptstats'])
def test_observer_reads_four_tables_and_refuses_their_writes(db,launch,table):
    seed(db);launch(db).done()
    with contextlib.closing(connect(observer_url(db))) as c,c.cursor() as cur:
        cur.execute(f'SELECT zid,math_tick FROM {table} WHERE math_env=%s',('rustproto',))
        assert cur.fetchall()==[(1,0)]
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
            cur.execute(f'DELETE FROM {table} WHERE false')


@pytest.mark.parametrize('kind',['future','null','zero','missing-ticks','missing-main','missing-bid','missing-stats','stats-ahead'])
def test_current_table_faults_are_observed_continuously(db,launch,kind):
    seed(db);launch(db).done()
    if kind in ('future','null','zero'):
        modified={'future':'now_as_millis()+86400000','null':'NULL','zero':'0'}[kind]
        if kind=='null':query(db,'ALTER TABLE math_ticks ALTER COLUMN modified DROP NOT NULL')
        query(db,f"UPDATE math_ticks SET math_tick=math_tick+1,modified={modified} WHERE math_env='rustproto'")
    elif kind=='stats-ahead':query(db,"UPDATE math_ptptstats SET math_tick=math_tick+1 WHERE math_env='rustproto'")
    else:
        table={'missing-ticks':'math_ticks','missing-main':'math_main','missing-bid':'math_bidtopid','missing-stats':'math_ptptstats'}[kind]
        query(db,f"DELETE FROM {table} WHERE math_env='rustproto'")
    value=observed(db)
    assert value['ObserverHealthy']==0 and 'PublishLagSeconds' not in value
    assert value['code']==('OBSERVER_CLOCK' if kind in ('future','null','zero') else 'OBSERVER_CURRENT')


def test_current_observer_namespace_and_allowlist_are_applied_to_every_table(db,launch):
    seed(db);seed(db,zid=2);launch(db).done();launch(db,env='python').done()
    query(db,"UPDATE math_ticks SET math_tick=math_tick+1,modified=now_as_millis()-900000 WHERE math_env='python'")
    assert observed(db)['CurrentBehind']==0
    query(db,"UPDATE math_ticks SET math_tick=math_tick+1,modified=now_as_millis()-900000 WHERE math_env='rustproto' AND zid=2")
    value=observed(db)
    assert value['CurrentBehind']==1 and value['CurrentLagSeconds']>=900
    launch(db,extra={'POLL_ALLOWLIST':'1'}).done()
    assert observed(db,{**PROFILE,'allowlist':[1]})['CurrentBehind']==0


def test_ticks_without_first_main_are_visible_and_repair_clears_lag(db,launch):
    seed(db);launch(db).done()
    query(db,"DELETE FROM math_main WHERE math_env='rustproto'; DELETE FROM math_bidtopid WHERE math_env='rustproto'; DELETE FROM math_ptptstats WHERE math_env='rustproto'")
    query(db,"UPDATE math_ticks SET modified=now_as_millis()-900000 WHERE math_env='rustproto'")
    value=observed(db)
    assert value['ObserverHealthy']==1 and value['CurrentBehind']==1 and value['CurrentLagSeconds']>=900
    launch(db).done()
    repaired=observed(db)
    assert repaired['ObserverHealthy']==repaired['CurrentPointerHealthy']==1
    assert repaired['PublishLagSeconds']==0


def test_observer_four_table_grant_is_required(db):
    query(db,'REVOKE SELECT ON math_ptptstats FROM polis_coordinator_observer')
    value=observed(db)
    assert value['code']=='OBSERVER_AUTHORITY' and value['ObserverHealthy']==0
    assert 'PublishLagSeconds' not in value


def test_daemon_reconnect_keeps_one_blocked_delivery_worker(db,launch,tmp_path):
    fifo=tmp_path/'reconnect.fifo';os.mkfifo(fifo)
    child=launch(db,mode='run',extra={'P026_METRICS':str(fifo),'P026_POLL_MS':'20'})
    def backend():
        return query(db,"SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='p026-coordinator' AND usename='p027_bridge_control'")
    try:
        wait(lambda:observed(db).get('PollHealthy')==1,alive=child,why='initial empty sweep')
        # A nonblocking writer can open a FIFO only when a reader exists. There
        # is no reader, so the first metrics worker is blocked opening this inode.
        # Let complete sweeps fill its bounded queue before changing the path.
        time.sleep(.5)
        fifo.rename(tmp_path/'held.fifo');fifo.write_bytes(b'')
        pids=[]
        for _ in range(5):
            wait(lambda:bool(backend()),alive=child,why='reconnected daemon backend')
            pid=backend()[0][0];pids.append(pid)
            query(db,'SELECT pg_terminate_backend(%s)',(pid,))
            wait(lambda:bool(backend()) and backend()[0][0]!=pid and observed(db).get('PollHealthy')==1,
                 alive=child,why='new admitted backend and healthy complete sweep')
            time.sleep(.1)
            # A replacement transport would immediately write the now-regular
            # path. The retained worker remains blocked on the old FIFO inode.
            assert fifo.read_bytes()==b''
        assert len(set(pids))==5
    finally:child.kill()
