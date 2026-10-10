#!/usr/bin/env python3
"""Real PG, restricted RPCs, real daemon/children; offline graph contract proof."""
import copy
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess as sp
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
OUT=Path(os.environ['GRAPH_PROOF_ROOT']); OUT.mkdir(parents=True,exist_ok=True)
PORT=os.environ['POLIS_RECOVERY_PG_PORT']; assert PORT==os.environ['RECOVERY_PG_PORT']
PROJECT=os.environ['COMPOSE_PROJECT_NAME']; assert PROJECT.startswith('polis-graph-test-')
DB=os.environ.get('GRAPH_PROOF_DB','graphs')
C=['docker','compose','-f',str(ROOT/'delphi/tests/job_graph/compose.yml')]
checks=[]; workers=[]

def sql(query,restricted=False,ok=True):
    prefix='SET ROLE polis_queue_executor; ' if restricted else ''
    p=sp.run(C+['exec','-T','postgres','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',DB],input=prefix+query,text=True,capture_output=True)
    if (p.returncode==0)!=ok: raise AssertionError((query[:300],p.stdout,p.stderr))
    return p.stdout.strip() if ok else p.stderr

def lit(v): return "'"+str(v).replace("'","''")+"'"
def js(v): return lit(json.dumps(v))+'::jsonb'
def rpc(name,*args): return json.loads(sql('SELECT public.'+name+'('+','.join(args)+')',True))
def record(name,**data):
    checks.append(dict(name=name,**data));print('PASS',name,flush=True)
    (OUT/'results.json').write_text(json.dumps(checks,indent=2)+'\n')
def graph(scope,spec,key='first',sup=None,ok=True):
    query=f"SELECT public.pd_graph_admit('proof',1,{lit(scope)},{lit(key)},{js(spec)},{lit(sup)+'::uuid' if sup else 'NULL'})"
    value=sql(query,True,ok)
    return json.loads(value) if ok else value

def view(g):return rpc('pd_graph_view',"'proof'",lit(g['graph_id']))
def nodes(g):return {n['key']:n for n in view(g)['nodes']}
def wait(g,condition,timeout=90):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        ns=nodes(g)
        if condition(ns):return ns
        time.sleep(.25)
    raise AssertionError(('timeout',ns,[p.poll() for p in workers]))
def state(n):return n['readiness']['state']
def start(label,stages='graph_embed,graph_cluster,graph_narrative',cls='delphi'):
    work=OUT/label;work.mkdir(exist_ok=True)
    app=OUT/'app';(app/'scripts').mkdir(parents=True,exist_ok=True)
    (app/'scripts/job_graph_stage.py').write_text((HERE/'child_fixture.py').read_text())
    env=dict(os.environ,POLIS_JOBS_ENABLED='1',QUEUE_ENV='proof',POLIS_JOBS_TRANSPORT='loopback',
        QUEUE_DATABASE_URL=f'postgresql://graph_worker@127.0.0.1:{PORT}/{DB}?sslmode=disable',
        POLIS_JOBS_STAGES=stages,POLIS_JOBS_WORKER_CLASS=cls,POLIS_JOBS_JOURNAL_DIR=str(work/'journal'),POLIS_JOBS_WORK_DIR=str(work/'work'),
        POLIS_JOBS_POLL_SECONDS='1',POLIS_JOBS_REAP_SECONDS='1',POLIS_JOBS_READINESS_SECONDS='1',POLIS_JOBS_LEASE_SECONDS='15',POLIS_JOBS_HEARTBEAT_SECONDS='3',
        POLIS_JOBS_KILL_GRACE_SECONDS='1',POLIS_JOBS_SHUTDOWN_GRACE_SECONDS='1',POLIS_JOBS_PYTHON=sys.executable,DELPHI_APP_PATH=str(app),GRAPH_STAGE_SOURCE=str(ROOT/'delphi/scripts/job_graph_stage.py'))
    f=(OUT/(label+'.log')).open('w'); p=sp.Popen([str(ROOT/'queue-rs/target/debug/polis-jobs')],env=env,stdout=f,stderr=sp.STDOUT);f.close();workers.append(p);return p

def stop(p):
    if p.poll() is None:p.send_signal(signal.SIGTERM);p.wait(timeout=40)

def control(fails): (OUT/'control.json').write_text(json.dumps(dict(fail_clusters=fails)))
def count(n):return int((OUT/'starts'/n['job_id']).read_text())
def spec():
    data={'texts':['trees green leaves','green leaves grow','water flows river','river water blue']}
    sha=sql(f'SELECT encode(sha256(convert_to(({js(data)})::text,\'UTF8\')),\'hex\')')
    models=['local-token-count/1','local-nearest-centroid/1','local-cluster-summary/1']
    return {'schema':'polis-job-graph/1','nodes':[dict(key=k,stage='graph_'+stage,**{'class':'delphi'},declared=dict(snapshot=dict(data=data,sha256=sha),code=hashlib.sha256((ROOT/'delphi/scripts/job_graph_stage.py').read_bytes()).hexdigest(),model=model,runtime='python-'+sys.version.split()[0],seed=0,config={},mode='full',memory_bytes=1048576,work_units=100),inputs=inputs,max_attempts=3) for k,stage,model,inputs in zip(['e','c','n'],['embed','cluster','narrative'],models,[[],[dict(node='e',role='embeddings')],[dict(node='c',role='clusters')]])]}

def main():
    sql("INSERT INTO users(uid,hname) VALUES(1,'generated graph owner') ON CONFLICT DO NOTHING; INSERT INTO conversations(zid,owner,topic) VALUES(1,1,'generated graph proof') ON CONFLICT DO NOTHING; DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='graph_worker') THEN CREATE ROLE graph_worker LOGIN; END IF; END $$; GRANT polis_queue_executor TO graph_worker;")
    s=spec();g=graph('retry',s);duplicate=graph('retry',s);assert duplicate['graph_id']==g['graph_id']
    ns=nodes(g);assert len({n['run_id'] for n in ns.values()})==3
    assert ns['c']['readiness']['blockers'][0]['producer']==ns['e']['job_id']
    assert ns['n']['attempts']==0
    record('P02_atomic_graph_duplicate_and_waiting',graph=g,nodes=ns)
    depth=rpc('pd_graph_depth',"'proof'","'delphi'")
    legacy_depth=rpc('pq_class_depth',"'proof'","'delphi'")
    assert depth['runnable']==1 and depth['dependency_blocked']==2 and legacy_depth['queued']==1
    record('P11_graph_and_existing_class_depth_exclude_dependency_blocked',graph=depth,legacy=legacy_depth)
    control(1);worker=start('before-restart')
    ns=wait(g,lambda x:state(x['c'])=='retry_wait');stop(worker)
    assert state(ns['e'])=='succeeded' and ns['n']['attempts']==0 and count(ns['e'])==1
    upstream=copy.deepcopy(ns['e']['artifact']);first_input=ns['c']['input_sha256']
    record('P03_P04_upstream_preserved_and_cluster_failed',nodes=ns)
    # Independent graph still runs with the failed cluster graph waiting.
    u=spec();u['nodes']=u['nodes'][:1];other=graph('unrelated',u)
    control(0);worker=start('after-restart')
    ns=wait(g,lambda x:all(state(n)=='succeeded' for n in x.values()));wait(other,lambda x:state(x['e'])=='succeeded')
    assert [count(ns[k]) for k in ['e','c','n']]==[1,2,1]
    assert ns['e']['artifact']==upstream and ns['c']['input_sha256']==first_input
    published=rpc('pd_graph_publish',"'proof'",lit(g['graph_id']),lit(ns['n']['job_id']),"0")
    assert len(published['bundle']['artifacts'])==3 and published['outcome']=='published'
    served=rpc('pd_graph_served',"'proof'","1","'retry'")
    stop(worker);record('P05_retry_uses_exact_embeddings_coherent_bundle',nodes=ns,served=served)
    assert 'not supported' in graph('deferred-redrive',spec(),sup=g['graph_id'],ok=False)
    assert sql("SELECT to_regclass('public.delphi_graph_breakers') IS NULL AND to_regclass('public.delphi_graph_provider_resolutions') IS NULL AND to_regprocedure('public.pd_graph_resolve_provider(text,uuid,text,text,jsonb)') IS NULL")=='t'
    record('deferred_features_absent_and_redrive_refused')
    # No direct table authority, no late graph mutations, wrong hashes/modes refused.
    assert 'permission denied' in sql("DELETE FROM delphi_artifacts",True,False)
    assert 'immutable' in sql("UPDATE delphi_artifacts SET payload='changed'",False,False)
    for name,mut in [('incremental',lambda s:s['nodes'][0]['declared'].update(mode='incremental')),('snapshot',lambda s:s['nodes'][0]['declared']['snapshot'].update(sha256='0'*64)),('class',lambda s:s['nodes'][0].update(**{'class':'large'})),('budget',lambda s:s['nodes'][0]['declared'].update(memory_bytes=9999999999)),('missing',lambda s:s['nodes'][1]['inputs'][0].update(node='absent')),('cycle',lambda s:s['nodes'][1]['inputs'][0].update(node='c'))]:
        bad=spec();mut(bad);graph('negative-'+name,bad,ok=False)
    assert rpc('pd_graph_served',"'proof'","1","'retry'")==served
    record('P07_P08_P11_refuse_bad_graphs_and_preserve_served')
    # Placement: only large may claim a large cluster, even with Delphi stages.
    placement=spec();placement['nodes'][1]['class']='large';place=graph('placement',placement)
    worker=start('placement-delphi');pn=wait(place,lambda x:state(x['e'])=='succeeded');time.sleep(2);assert nodes(place)['c']['attempts']==0
    large=start('placement-large','graph_cluster','large');pn=wait(place,lambda x:all(state(n)=='succeeded' for n in x.values()));stop(large);stop(worker)
    record('P11_class_placement',nodes=pn)
    assert sql('SELECT count(*) FROM votes')=='0'
    record('no_vote_rows_or_production_data')

if __name__ == '__main__':
    try:main()
    finally:
        for p in workers:stop(p)
