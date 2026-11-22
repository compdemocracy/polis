#!/usr/bin/env python3
"""Owned Docker process-recovery checks against a migrated throwaway database.

GRAPH_RECOVERY_IMAGE, GRAPH_RECOVERY_PG_CONTAINER, GRAPH_RECOVERY_DATABASE and
GRAPH_RECOVERY_OUT name caller-owned resources. No votes or external services.
The image must be a test build (delphi/Dockerfile target test): the node it
admits uses a test-only model, which a production daemon refuses to run.
"""
import json
import os
from pathlib import Path
import subprocess as sp
import time
import uuid

OUT = Path(os.environ['GRAPH_RECOVERY_OUT']).resolve()
OUT.mkdir(parents=True, exist_ok=True)
PG = os.environ['GRAPH_RECOVERY_PG_CONTAINER']
DB = os.environ['GRAPH_RECOVERY_DATABASE']
IMAGE = os.environ['GRAPH_RECOVERY_IMAGE']
PREFIX = 'graph-recovery-' + uuid.uuid4().hex[:12]
owned = []
results = []


def run(*args, **kwargs):
    return sp.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def sql(query):
    return run('docker', 'exec', '-i', PG, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
               '-U', 'postgres', '-d', DB, input=query)


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


def until(check):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.2)
    raise AssertionError('condition did not become true')


def launch(name, journal):
    owned.append(name)
    env = dict(POLIS_JOBS_ENABLED='1', QUEUE_ENV='shadow-graph-1',
               DELPHI_RESULT_ENV='shadow-graph-1', DELPHI_SHADOW_GRAPH_DAEMON='1',
               QUEUE_DATABASE_URL=f'postgresql://graph_recovery@127.0.0.1:5432/{DB}',
               POLIS_JOBS_TRANSPORT='loopback', POLIS_JOBS_WORKER_CLASS='delphi',
               POLIS_JOBS_STAGES='graph_embed,graph_cluster,graph_topics,graph_narrative',
               POLIS_JOBS_CONCURRENCY='1', POLIS_JOBS_JOURNAL_DIR='/journal',
               POLIS_JOBS_JOURNAL_HOST_FILE='/proof/host-id', POLIS_JOBS_WORK_DIR='/tmp/work',
               DELPHI_APP_PATH='/proof/app', POLIS_JOBS_PYTHON='python3',
               POLIS_JOBS_POLL_SECONDS='1', POLIS_JOBS_REAP_SECONDS='1',
               POLIS_JOBS_LEASE_SECONDS='15', POLIS_JOBS_HEARTBEAT_SECONDS='3')
    args = ['docker', 'run', '-d', '--name', name, '--network', 'container:'+PG,
            '--memory', '6g', '--cpus', '2', '--cap-drop', 'ALL',
            '-v', str(OUT)+':/proof', '-v', str(journal)+':/journal']
    for key, value in env.items():
        args += ['-e', key+'='+value]
    run(*args, '--entrypoint', 'polis-delphi-shadow', IMAGE, 'daemon')


def admit(case):
    data = {'texts': ['public generated text '+str(i) for i in range(5)]}
    sha = sql('SELECT pd_graph_hash('+lit(json.dumps(data))+'::jsonb)')
    spec = dict(schema='polis-job-graph/1', nodes=[dict(key='e', stage='graph_embed',
        **{'class': 'delphi'}, declared=dict(snapshot=dict(data=data, sha256=sha),
        code='a'*64, model='local-token-count/1', runtime='python-test', seed=0,
        config={}, mode='full', memory_bytes=1048576, work_units=100), inputs=[], max_attempts=1)])
    reply = json.loads(sql("SELECT pd_graph_admit('shadow-graph-1',1,"+lit(case)+",'first',"+lit(json.dumps(spec))+"::jsonb)"))
    return reply['graph_id']


def view(graph):
    return json.loads(sql("SELECT pd_graph_view('shadow-graph-1',"+lit(graph)+"::uuid)"))


def record(name):
    results.append(name)
    print('PASS', name, flush=True)
    (OUT/'results.json').write_text(json.dumps(results, indent=2)+'\n')


def main():
    sql("INSERT INTO users(uid,hname) VALUES(1,'public generated owner'); INSERT INTO conversations(zid,owner,topic) VALUES(1,1,'public generated'); DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='graph_recovery') THEN CREATE ROLE graph_recovery LOGIN; END IF; END $$; GRANT polis_queue_executor TO graph_recovery;")
    (OUT/'host-id').write_text('public-test-host')
    scripts = OUT/'app/scripts'
    scripts.mkdir(parents=True)
    (scripts/'job_graph_stage.py').write_text("import time\nwhile True: time.sleep(.1)\n")
    for case in ['container-replaced', 'same-container-restarted', 'journal-lost']:
        journal = OUT/case
        journal.mkdir()
        graph = admit(case)
        first = PREFIX+'-'+case
        launch(first, journal)
        until(lambda: any(journal.glob('*.json')) and view(graph)['nodes'][0]['readiness']['state'] == 'running')
        # Wait for the post-spawn entry, not merely the durable pre-spawn entry.
        until(lambda: any(json.loads(p.read_text()).get('pgid') for p in journal.glob('*.json')))
        second = PREFIX+'-second-'+case
        launch(second, journal)
        until(lambda: run('docker', 'inspect', '-f', '{{.State.Running}}', second) == 'false')
        assert run('docker', 'inspect', '-f', '{{.State.ExitCode}}', second) == '2'
        assert view(graph)['nodes'][0]['attempts'] == 1
        record(case+': second daemon refused')
        run('docker', 'kill', '--signal', 'KILL', first)
        until(lambda: run('docker', 'inspect', '-f', '{{.State.Running}}', first) == 'false')
        if case == 'same-container-restarted':
            run('docker', 'start', first)
        else:
            next_journal = journal
            if case == 'journal-lost':
                next_journal = OUT/'empty-journal'
                next_journal.mkdir()
            launch(PREFIX+'-replacement-'+case, next_journal)
        if case == 'journal-lost':
            until(lambda: view(graph)['nodes'][0]['readiness']['state'] == 'parked')
            assert view(graph)['guard_held']
            assert sql("SELECT count(*) FROM polis_queue_attempts a JOIN delphi_graph_nodes n USING(env,job_id) WHERE n.graph_id="+lit(graph)+"::uuid AND a.process_exit_confirmed_at IS NULL") == '1'
            record('lost journal: expiry did not invent exit proof or release scope')
        else:
            until(lambda: not view(graph)['guard_held'])
            assert sql("SELECT count(*) FROM polis_queue_attempts a JOIN delphi_graph_nodes n USING(env,job_id) WHERE n.graph_id="+lit(graph)+"::uuid AND a.process_exit_confirmed_at IS NULL") == '0'
            record(case+': retained exact attempt recovered')
        for name in owned:
            if run('docker', 'inspect', '-f', '{{.State.Running}}', name) == 'true':
                run('docker', 'stop', '-t', '3', name)
    assert sql('SELECT count(*) FROM votes') == '0'
    record('no votes or production data')


if __name__ == "__main__":
    try:
        main()
    finally:
        for name in owned:
            p = sp.run(['docker', 'logs', name], text=True, capture_output=True)
            (OUT/(name+'.log')).write_text(p.stdout+p.stderr)
            sp.run(['docker', 'rm', '-f', name], check=False, capture_output=True)
