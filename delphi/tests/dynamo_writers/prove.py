"""Real PostgreSQL + daemon proof. Generated results; Dynamo is stopped by CI."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import psycopg2
from psycopg2.extras import Json
from polismath.delphi_storage.codec import item_from_python,decode_family,encode_item
from polismath.delphi_storage.postgres import family_files

admin=psycopg2.connect(os.environ['DATABASE_URL']);admin.autocommit=True
executor=psycopg2.connect(os.environ['QUEUE_DATABASE_URL']);executor.autocommit=True
checks=[]
def sql(query,args=(),connection=admin):
    with connection.cursor() as c:
        c.execute(query,args)
        return c.fetchall() if c.description else []
def call(name,casts,args,connection=executor):
    return sql('SELECT public.'+name+'('+','.join('%s::'+cast for cast in casts.split(','))+')',args,connection)[0][0]
def denied(query,args=(),connection=executor):
    try:sql(query,args,connection)
    except psycopg2.Error as e:return str(e)
    raise AssertionError('unexpected SQL success')
def record(name):checks.append(name);print('PASS '+name,flush=True)
def rows(family):return sql("SELECT item FROM delphi_result_current_rows WHERE env='writer-proof' AND zid=1 AND scope_key='delphi' AND family=%s ORDER BY item_key::text",[family])
def mutate(family,item,operation='put',request=None):
    return call('pd_result_mutate','text,text,text,uuid,text,text,jsonb',
        ['writer-proof','delphi','generated-http-owner',request or str(uuid.uuid4()),family,operation,Json(json.loads(encode_item(family,item_from_python(item))))])
def admit(key=None,config=None,sha=None,stage='delphi_full_pipeline',zid=1):
    config=config or {'include_moderation':True,'model':'fixed-provider-proof'}
    return call('pd_writer_admit','text,integer,text,text,text,text,uuid,uuid,text,text,jsonb,text',
        ['writer-proof',zid,'delphi','generated-api',key or str(uuid.uuid4()),sha or hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest(),
         str(uuid.uuid4()),str(uuid.uuid4()),stage,'rlocalwriter' if stage=='delphi_narrative' else None,Json(config),'d6f9ed6093e46b3c07db98f3c644bbbd9c4e87cd'])
def status(job):return call('pq_job_status','text,uuid',['writer-proof',job])
def wait(job,state):
    until=time.monotonic()+90
    while time.monotonic()<until:
        value=status(job)
        if value['state']==state:return value
        if value['state']=='dead' and state!='dead':raise AssertionError(value)
        time.sleep(.15)
    raise AssertionError(status(job))

sql("INSERT INTO users(uid,hname) VALUES(1,'generated writer owner'); INSERT INTO conversations(zid,owner,topic) VALUES(1,1,'generated writer conversation'),(2,1,'generated isolated conversation'); INSERT INTO reports(zid,report_id) VALUES(1,'rlocalwriter')")
request=str(uuid.uuid4())
first=mutate('Delphi_CollectiveStatement',{'zid_topic_jobid':'1#topic#first','text':'initial'},request=request)
assert first['outcome']=='succeeded'
assert mutate('Delphi_CollectiveStatement',{'zid_topic_jobid':'1#topic#first','text':'initial'},request=request)['job_id']==first['job_id']
assert 'conflict' in denied('SELECT pd_result_mutate(%s,%s,%s,%s,%s,%s,%s)',
    ['writer-proof','delphi','generated-http-owner',request,'Delphi_CollectiveStatement','put',Json(item_from_python({'zid_topic_jobid':'1#topic#first','text':'different'}))])
second=mutate('Delphi_CollectiveStatement',{'zid_topic_jobid':'1#topic#second','text':'second'})
assert len(rows('Delphi_CollectiveStatement'))==2
history=sql('SELECT count(*) FROM delphi_artifacts')[0][0]
mutate('Delphi_CollectiveStatement',{'zid_topic_jobid':'1#topic#first'},'delete')
assert len(rows('Delphi_CollectiveStatement'))==1
assert sql('SELECT count(*) FROM delphi_artifacts')[0][0]==history+1
assert sql("SELECT pd_result_artifact_family('writer-proof',artifact_id,'Delphi_CollectiveStatement') FROM delphi_artifacts WHERE job_id=%s",[first['job_id']])[0][0][0]['text']=={'S':'initial'}
record('synchronous put/delete preserve other keys, exact request idempotence, conflict and immutable history')
for family in ('Delphi_NarrativeReports','report_narrative_store'):
    item={'rid_section_model':'rlocalwriter#section#fixture','timestamp':'2026-01-01T00:00:00Z','report_data':'{"generated":true}'}
    mutate(family,item)
    assert rows(family)[0][0]['report_data']=={'S':'{"generated":true}'}
    mutate(family,{k:item[k] for k in ('rid_section_model','timestamp')},'delete')
    assert not rows(family)
for (wire,) in sql('SELECT codec_wire FROM delphi_result_families'):
    decode_family(wire.encode())
assert 'permission denied' in denied('SELECT * FROM delphi_writer_runs')
assert 'immutable' in denied("DELETE FROM delphi_artifacts",connection=admin)
record('narrative and statement canonical codec, restricted roles, immutable result tables')
# Independent connections contend on the empty/current publication scope.
from concurrent.futures import ThreadPoolExecutor
def concurrent_edit(index):
    connection=psycopg2.connect(os.environ['QUEUE_DATABASE_URL']);connection.autocommit=True
    try:
        return call('pd_result_mutate','text,text,text,uuid,text,text,jsonb',
            ['writer-proof','delphi','generated-concurrent',str(uuid.uuid4()),'Delphi_CollectiveStatement','put',
             Json(item_from_python({'zid_topic_jobid':f'1#concurrent#{index}','text':str(index)}))],connection)
    finally:connection.close()
with ThreadPoolExecutor(max_workers=4) as pool:
    assert all(v['outcome']=='succeeded' for v in pool.map(concurrent_edit,range(4)))
assert len(rows('Delphi_CollectiveStatement'))==5
for index in range(4):mutate('Delphi_CollectiveStatement',{'zid_topic_jobid':f'1#concurrent#{index}'},'delete')
record('four concurrent synchronous writers preserve every distinct key without lost updates')

job=admit('same-key');again=admit('same-key')
assert job['job_id']==again['job_id'] and again['outcome']=='existing'
assert admit('same-key',sha='f'*64)['outcome']=='conflict'
assert 'busy' in denied("SELECT pd_result_mutate('writer-proof','delphi','generated-http-owner',%s,'Delphi_CollectiveStatement','put',%s)",[str(uuid.uuid4()),Json(item_from_python({'zid_topic_jobid':'1#topic#third'}))])
owner,attempt=str(uuid.uuid4()),str(uuid.uuid4())
c=call('pq_claim','text,smallint,uuid,uuid,integer,text',['writer-proof',1,owner,attempt,60,'delphi'])
assert c['job_id']==job['job_id']
token=['writer-proof',c['job_id'],owner,attempt,int(c['lease_epoch'])]
family='Delphi_CommentEmbeddings';wire=family_files({family:[{'conversation_id':'1','comment_id':0,'text':'not published'}]})[family]
call('pd_result_put_family','text,uuid,uuid,uuid,bigint,text,text',token+[family,wire])
assert not rows(family)
bad=[*token];bad[2]=str(uuid.uuid4())
assert 'fenced' in denied('SELECT pd_result_put_family(%s,%s,%s,%s,%s,%s,%s)',bad+[family,wire])
# Fail this attempt: staged rows remain unserved and a fresh successful attempt
# must stage a new sealed batch. No old attempt is allowed to finish afterwards.
call('pq_fail','text,uuid,uuid,uuid,bigint,boolean,text,boolean',token+[True,'generated-proof-failure',True])
assert status(job['job_id'])['state']=='dead' and not rows(family)
record('admission idempotence/conflict, no early visibility, stale owner refusal, failed attempt preserves served result')
# Real daemon and process boundary. The child is a named storage fixture; it
# exercises real writer adapters, spool and provider handshake, not model quality.
env=dict(os.environ,POLIS_JOBS_ENABLED='1',QUEUE_ENV='writer-proof',POLIS_JOBS_TRANSPORT='loopback',
    POLIS_JOBS_POLL_SECONDS='1',POLIS_JOBS_REAP_SECONDS='1',POLIS_JOBS_LEASE_SECONDS='60',POLIS_JOBS_HEARTBEAT_SECONDS='5',
    POLIS_JOBS_WORKER_CLASS='delphi',POLIS_JOBS_STAGES='delphi_full_pipeline,delphi_narrative',
    POLIS_JOBS_JOURNAL_DIR='/proof/writer-journal',POLIS_JOBS_WORK_DIR='/proof/writer-work',
    POLIS_JOBS_PYTHON='/app/tests/dynamo_writers/child.py',DELPHI_APP_PATH='/app')
with open('/proof/daemon.log','w') as log:
    daemon=subprocess.Popen(['polis-jobs'],env=env,stdout=log,stderr=subprocess.STDOUT)
    try:
        job=admit('process-full')
        wait(job['job_id'],'succeeded')
        assert len(rows('Delphi_CommentEmbeddings'))==3
        assert len(rows('Delphi_CollectiveStatement'))==1
        full_artifact=sql('SELECT artifact_id FROM delphi_artifacts WHERE job_id=%s',[job['job_id']])[0][0]
        narrative=admit('process-narrative',stage='delphi_narrative')
        wait(narrative['job_id'],'succeeded')
        assert len(rows('Delphi_NarrativeReports'))==1
        assert len(rows('Delphi_CommentEmbeddings'))==3
        assert sql("SELECT count(*) FROM delphi_provider_requests WHERE job_id=%s AND state='completed'",[narrative['job_id']])[0][0]==1
        assert sql("SELECT count(*) FROM polis_queue_attempts WHERE job_id=%s",[narrative['job_id']])[0][0]>=2
        assert sql("SELECT pd_result_artifact_family('writer-proof',%s,'Delphi_CommentEmbeddings')",[full_artifact])[0][0]==[r[0] for r in rows('Delphi_CommentEmbeddings')]
        record('real daemon full-result spool and narrative submit/park/recheck, run-bound publication and prior artifacts preserved')
    finally:
        daemon.terminate()
        try:daemon.wait(timeout=15)
        except subprocess.TimeoutExpired:daemon.kill();daemon.wait()
assert sql('SELECT count(*) FROM votes')[0][0]==0
assert sql('SELECT count(*) FROM delphi_artifacts a JOIN polis_queue_jobs q USING(env,job_id) WHERE q.state<>\'succeeded\'')[0][0]==0
assert 'permission denied' in denied('UPDATE delphi_graph_served SET generation=99')
Path('/proof/completed.json').write_text(json.dumps({'checks':checks,'votes':0},indent=2)+'\n')
print('PASS all writer boundary scenarios; no Dynamo or paid provider requests',flush=True)
