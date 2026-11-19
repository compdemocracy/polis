#!/usr/bin/env python3
"""Scheduler restart/list clearing under its deployed 256 MiB, quarter-CPU limits."""
import json
import os
from pathlib import Path
import subprocess as sp
import time
import uuid

from graph_recovery import OUT, PG, DB, IMAGE, run, sql, lit, until

names = []
prefix = 'graph-scheduler-' + uuid.uuid4().hex[:12]
state = OUT/'scheduler'
state.mkdir(parents=True)

def start(label, codes):
    name = prefix+'-'+label
    names.append(name)
    env = dict(DELPHI_SHADOW_ENABLED='1', DELPHI_SHADOW_ENV='shadow-delphi-1',
        QUEUE_ENV='shadow-delphi-1', POLIS_JOBS_TRANSPORT='loopback',
        QUEUE_DATABASE_URL=f'postgresql://graph_recovery@127.0.0.1:5432/{DB}',
        DELPHI_SHADOW_READ_DATABASE_URL=f'postgresql://postgres@127.0.0.1:5432/{DB}',
        DELPHI_SHADOW_CODE_VERSION='a'*40, DELPHI_SHADOW_STATE_PATH='/state/state.json',
        DELPHI_SHADOW_PAUSE_FILE='/state/pause', DELPHI_SHADOW_DISK_FREE_MIN_MB='0',
        DELPHI_SHADOW_DISK_USED_MAX_PCT='100', DELPHI_SHADOW_PROBE_MAX_MS='5000',
        DELPHI_SHADOW_GRAPH_CONVERSATIONS=codes, DELPHI_SHADOW_GRAPH_ENV='shadow-graph-1',
        DELPHI_SHADOW_BENCHMARK='c2,c3', DELPHI_SHADOW_POLL_SECONDS='1',
        DELPHI_SHADOW_JOB_POLL_SECONDS='1', DELPHI_SHADOW_JOB_DEADLINE_SECONDS='60',
        DELPHI_SHADOW_DUTY_CYCLE='1',
        DELPHI_EMBED_MODEL_PATH='/opt/polis/embedding/granite-embedding-311m-multilingual-r2',
        DELPHI_EMBED_MODEL_LOCK='/opt/polis/embedding/granite-embedding-311m-multilingual-r2.lock.json')
    args = ['docker','run','-d','--name',name,'--network','container:'+PG,
        '--memory','256m','--cpus','0.25','-v',str(state)+':/state']
    for key, value in env.items(): args += ['-e',key+'='+value]
    run(*args,'--entrypoint','polis-delphi-shadow',IMAGE)
    return name


def read_state():
    try: return json.loads((state/'state.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError): return {}


try:
    sql("INSERT INTO users(uid,hname) VALUES(1,'generated owner');")
    # The common restricted login may already exist on this owned server.
    sql("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='graph_recovery') THEN CREATE ROLE graph_recovery LOGIN; END IF; END $$; GRANT polis_queue_executor TO graph_recovery;")
    for zid in [2,3]:
        sql(f"INSERT INTO conversations(zid,owner,topic,is_active) VALUES({zid},1,'public generated',true); INSERT INTO zinvites(zid,zinvite) VALUES({zid},'c{zid}'); INSERT INTO participants(zid,pid,uid) VALUES({zid},0,1); INSERT INTO comments(zid,pid,uid,tid,txt,mod,active) SELECT {zid},0,1,i,'Public generated comment '||i,0,true FROM generate_series(0,24) i;")
    first = start('before','c2')
    flight = until(lambda: read_state().get('graph_flight'))
    # A real queue attempt loses its local journal. This test spawns no child;
    # the absent receipt must nevertheless remain unproven by the scheduler.
    owner, attempt = str(uuid.uuid4()), str(uuid.uuid4())
    claimed = json.loads(sql("SELECT pd_graph_claim('shadow-graph-1',1::smallint,"+lit(owner)+"::uuid,"+lit(attempt)+"::uuid,15,'delphi','graph_embed')"))
    assert claimed['outcome'] == 'owned'
    run('docker','stop','-t','5',first)
    saved = read_state()
    saved['graph_flight']['admitted_at_ms'] -= 120000
    (state/'state.json').write_text(json.dumps(saved))
    second = start('after','')
    finished = until(lambda: read_state() if read_state().get('in_flight') else None)
    assert finished['in_flight']['zid'] == 3
    assert len(finished['graph_deferred']) == 1
    assert finished['graph_deferred'][0]['graph_id'] == flight['graph_id']
    assert sql("SELECT count(*) FROM polis_queue_attempts WHERE attempt_id="+lit(attempt)+"::uuid AND process_exit_confirmed_at IS NULL") == '1'
    inspect = json.loads(run('docker','inspect',second))[0]
    assert inspect['HostConfig']['Memory'] == 256*1024**2
    assert inspect['HostConfig']['NanoCpus'] == 250000000
    (OUT/'limits-results.json').write_text(json.dumps(dict(checks=4, memory_bytes=256*1024**2, nano_cpus=250000000,
        restart=True,list_cleared=True,other_conversation_admitted=True,orphan_scope_retained=True),indent=2)+'\n')
    print('PASS 4 scheduler restart/list-clear/exclusion/resource-limit assertions')
finally:
    for name in names:
        p = sp.run(['docker','logs',name],text=True,capture_output=True)
        (OUT/(name+'.log')).write_text(p.stdout+p.stderr)
        sp.run(['docker','rm','-f',name],check=False,capture_output=True)
