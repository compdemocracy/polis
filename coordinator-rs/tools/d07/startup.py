#!/usr/bin/env python3
"""Actual Clojure startup/continued-input diagnostic, never D07 admission.

No compute function, actor factory, or poller is replaced. The mounted launcher
only observes completed actor state and registrations. A public prefix is
followed by one clearly marked generated vote. All resources are project-owned.
"""
from __future__ import annotations
import argparse
import csv
import json
import os
from pathlib import Path
import re
import socket
import sys
import time

import psycopg2
from psycopg2.extras import execute_values
from boundary import Boundary, ROOT, SQL, SQL_SHA256, sha, public_census
sys.path.insert(0,str(ROOT/'coordinator-rs/tools/d05'))
from tunnel import Tunnel


class Startup(Boundary):
    def __init__(self,*args):
        super().__init__(*args)
        self.tunnel=None
        self.receipt.update(schema='polis-d07-startup/1',status='FAIL',
            scope='real Clojure startup plus one generated continued-input vote',
            blocker='UNDETERMINED',rehearsal='NOT_RUN',capacity='UNADMITTED',
            alarm_delivery='OPERATOR_NOT_EVALUATED',checks=[])

    def check(self,name,passed,**evidence):
        if name in [c['name'] for c in self.receipt['checks']]:raise AssertionError('duplicate case')
        self.receipt['checks'].append(dict(name=name,passed=bool(passed),**evidence));self.save()
        if not passed:raise AssertionError(name)

    def run(self):
        if any(self.resources().values()):raise ValueError('refusing project reuse')
        with socket.socket() as s:s.bind(('127.0.0.1',self.port))
        attribution=ROOT.parent/'source-reconciliation.json'
        if not attribution.is_file():raise ValueError('attributed snapshot required')
        (self.output/'source-reconciliation.json').write_bytes(attribution.read_bytes())
        self.receipt['source_head']=json.loads(attribution.read_text())['source_head']
        files=[p for d in ('math/src','coordinator-rs/tools/d07','server/postgres/migrations')
               for p in (ROOT/d).rglob('*') if p.is_file() and p.suffix in ('.clj','.py','.sql','.md')]
        files += [ROOT/'math/deps.edn',ROOT/'coordinator-rs/tools/d05/tunnel.py']
        self.receipt['source_sha256']={str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in sorted(files)}
        if self.receipt['source_sha256'][SQL]!=SQL_SHA256:raise ValueError('SQL pin')
        self.receipt['public_inputs']=public_census()
        images={tag:self.command(['docker','image','inspect',tag,'--format','{{.Id}}']).strip()
                for tag in ('postgres:17-alpine','p024s-8fq2-math:latest')}
        self.receipt['images']=images
        config={'name':self.project,'networks':{'sealed':{'internal':True}},'services':{
            'postgres':{'image':images['postgres:17-alpine'],'pull_policy':'never','networks':['sealed'],
                'environment':{'POSTGRES_USER':'postgres','POSTGRES_DB':'p027','POSTGRES_HOST_AUTH_METHOD':'trust'},
                'tmpfs':['/var/lib/postgresql/data'],
                'healthcheck':{'test':['CMD-SHELL','pg_isready -U postgres -d p027'],'interval':'1s','timeout':'3s','retries':40}},
            'legacy':{'image':images['p024s-8fq2-math:latest'],'pull_policy':'never','networks':['sealed'],
                'entrypoint':['sh','-c'],'restart':'no','cpus':2,'mem_limit':'3g','working_dir':'/app',
                'command':['exec java -Xmx2g -cp "/app/src:$(find /root/.m2/repository -name \"*.jar\" -type f | sort | paste -sd: -)" clojure.main /d07/legacy.clj'],
                'environment':{'D07_ZID':'1','D07_RECOMPUTE':'true'},
                'volumes':[{'type':'bind','source':str(ROOT/'math/src'),'target':'/app/src','read_only':True},
                           {'type':'bind','source':str(ROOT/'coordinator-rs/tools/d07'),'target':'/d07','read_only':True},
                           {'type':'bind','source':str(self.output),'target':'/state','read_only':False}]}}}
        self.config.write_text(json.dumps(config,indent=2)+'\n');self.started=True
        dc=['docker','compose','-f',str(self.config)]
        self.command(dc+['up','-d','--wait','--pull','never','postgres'])
        pgid=self.command(dc+['ps','-q','postgres']).strip()
        self.tunnel=Tunnel(self.port,['docker','exec','-i',pgid,'nc','127.0.0.1','5432'])
        conn=psycopg2.connect(host='127.0.0.1',port=self.port,dbname='p027',user='postgres',sslmode='disable',connect_timeout=5)
        conn.autocommit=True;self.connections.append(conn)
        q=lambda sql,args=None:self.query(conn,sql,args)
        migrations=sorted((ROOT/'server/postgres/migrations').glob('*.sql'))
        self.receipt['migrations']={p.name:sha(p.read_bytes()) for p in migrations}
        for path in migrations:q(path.read_text())
        q('SELECT pg_temp.pc_assert_provenance()')
        self.check('schema',len(migrations)==21)
        q('CREATE ROLE d07_legacy LOGIN; GRANT USAGE ON SCHEMA public TO d07_legacy')
        q('GRANT SELECT ON conversations,comments,votes,participants TO d07_legacy')
        q('GRANT SELECT,INSERT,UPDATE ON math_ticks,math_main,math_bidtopid,math_ptptstats,math_profile TO d07_legacy')
        q("INSERT INTO users(uid,email) VALUES(1,'owner@example.invalid'); INSERT INTO conversations(zid,owner,topic) VALUES(1,1,'Public startup diagnostic')")
        path=next((ROOT/'delphi/real_data').glob('*-vw/*-votes.csv'))
        raw=list(csv.DictReader(path.read_text().splitlines()))
        pids={v:i for i,v in enumerate(sorted({int(r['voter-id']) for r in raw}))}
        tids={v:i for i,v in enumerate(sorted({int(r['comment-id']) for r in raw}))}
        rows=[(pids[int(r['voter-id'])],tids[int(r['comment-id'])],-int(r['vote']),int(r['timestamp'])*1000) for r in raw[:1170]]
        for pid in pids.values():
            q('INSERT INTO users(uid,email) VALUES(%s,%s)',(200+pid,f'public-{pid}@example.invalid'))
            q('INSERT INTO participants(zid,pid,uid) VALUES(1,%s,%s)',(pid,200+pid))
        # Single statements preserve repeated-cell rows through the existing
        # votes_latest_unique rule. No deduplication or trigger bypass.
        with conn.cursor() as cur:
            batch=[];seen=set()
            for row in rows:
                if row[:2] in seen or len(batch)==100:
                    execute_values(cur,'INSERT INTO votes(zid,pid,tid,vote,created) VALUES %s',batch);batch=[];seen=set()
                batch.append((1,*row));seen.add(row[:2])
            if batch:execute_values(cur,'INSERT INTO votes(zid,pid,tid,vote,created) VALUES %s',batch)
        for tid in tids.values():
            q('INSERT INTO comments(zid,tid,pid,uid,txt,mod,is_meta,created,modified) VALUES(1,%s,0,1,%s,0,false,1000,1000)',(tid,f'Public statement {tid}'))
        actual=q('SELECT pid,tid,vote,created FROM votes WHERE zid=1 ORDER BY pid,tid,vote,created')
        self.check('public-prefix',actual==sorted(rows),events=len(actual),cells=len({r[:2] for r in rows}),
                   storage_sign='negative of export',timestamp_resolution='seconds expanded to milliseconds')
        started=time.monotonic();self.command(dc+['up','-d','--pull','never','legacy'])
        cid=self.command(dc+['ps','-q','legacy']).strip()
        self.receipt['legacy_container']=cid
        state_path=self.output/'legacy-state.json'
        def publication():
            result=q("SELECT math_tick,last_vote_timestamp,data->'n',data->'n-cmts' FROM math_main WHERE zid=1 AND math_env='legacy'")
            return dict(zip(('tick','timestamp','participants','comments'),result[0])) if result else None
        deadline=time.monotonic()+120
        samples=[]
        while time.monotonic()<deadline:
            pub=publication();state=json.loads(state_path.read_text()) if state_path.exists() else None
            samples.append({'publication':pub,'actor_cells':len(state.get('cells') or []) if state else None})
            if pub and pub['timestamp']==max(r[3] for r in rows) and state:
                # Observe quiescence before the diagnostic vote, without taking
                # a timestamp-only publication as proof of actor completeness.
                if len(samples)>=10 and samples[-10:]==[samples[-1]]*10:break
            status=json.loads(self.command(['docker','inspect',cid,'--format','{{json .State}}']))
            if not status['Running']:raise AssertionError('legacy exited before baseline')
            time.sleep(.2)
        self.receipt['baseline_samples']=samples
        self.check('baseline-publication',bool(pub) and pub['participants']==69 and pub['comments']==28)
        self.receipt['before_publication']=pub;self.receipt['before_actor']=state
        vote=(1,0,0,1,max(r[3] for r in rows)+1000)
        q('INSERT INTO votes(zid,pid,tid,vote,created) VALUES(%s,%s,%s,%s,%s)',vote)
        self.receipt['generated_vote']=dict(zip(('zid','pid','tid','vote','created'),vote))
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            after=publication()
            if after and after['timestamp']==vote[-1]:break
            time.sleep(.1)
        self.check('continued-publication',bool(after) and after['timestamp']==vote[-1])
        self.check('durable-source-preserved',q('SELECT count(*) FROM votes WHERE zid=1')==[(1171,)])
        self.receipt['after_publication']=after
        self.receipt['after_actor']=json.loads(state_path.read_text())
        reg=self.output/'actor-registration.jsonl'
        self.receipt['registrations']=[json.loads(line) for line in reg.read_text().splitlines()] if reg.exists() else []
        self.receipt['measured']={'wall_seconds':time.monotonic()-started,
            'memory_peak_bytes':int(self.command(['docker','exec',cid,'cat','/sys/fs/cgroup/memory.peak']).strip()),
            'database_bytes':q('SELECT pg_database_size(current_database())')[0][0],
            'publication_row_bytes':{t:q(f"SELECT pg_column_size(x) FROM math_{t} x WHERE zid=1 AND math_env='legacy'")[0][0] for t in ('ticks','main','bidtopid','ptptstats')},
            'scope':'single public quarter + generated diagnostic vote; not all cuts',
            'method':'monotonic wall; cgroup memory.peak; pg_database_size; pg_column_size'}
        lost=after['participants']==1 and after['comments']==1 and not state['cells']
        self.receipt['regression_reproduced']=lost
        self.receipt['status']='BLOCKED' if lost else 'NOT_REPRODUCED'
        self.receipt['blocker']='CLOJURE_REGISTERED_ACTOR_LOST_PREFIX' if lost else 'RACE_NOT_REPRODUCED'
        self.receipt['four_row_ticks']=q("SELECT 'ticks',math_tick FROM math_ticks WHERE zid=1 AND math_env='legacy' UNION ALL SELECT 'main',math_tick FROM math_main WHERE zid=1 AND math_env='legacy' UNION ALL SELECT 'bidtopid',math_tick FROM math_bidtopid WHERE zid=1 AND math_env='legacy' UNION ALL SELECT 'ptptstats',math_tick FROM math_ptptstats WHERE zid=1 AND math_env='legacy'")
        for name,expected in self.receipt['source_sha256'].items():
            if sha((ROOT/name).read_bytes())!=expected:raise ValueError('source changed: '+name)

    def close(self):
        if self.started:
            self.command(['docker','compose','-f',str(self.config),'logs','--no-color'],check=False)
        if self.tunnel:self.tunnel.close()
        super().close()


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    if os.environ['POLIS_RECOVERY_PG_PORT']!=os.environ['RECOVERY_PG_PORT']:p.error('ports must agree')
    c=Startup(args.output.resolve(),os.environ['COMPOSE_PROJECT_NAME'],int(os.environ['POLIS_RECOVERY_PG_PORT']))
    try:c.run()
    except BaseException as e:c.receipt.update(status='FAIL',error=f'{type(e).__name__}: {e}');raise
    finally:c.close()
    print(json.dumps({k:c.receipt[k] for k in ('status','blocker','regression_reproduced')}))
    return 2 if c.receipt['status']=='BLOCKED' else 3


if __name__=='__main__':sys.exit(main())
