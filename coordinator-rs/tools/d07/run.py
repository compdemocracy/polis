#!/usr/bin/env python3
"""Owned public D07 rehearsal; measurements never imply capacity admission."""
from __future__ import annotations
import argparse
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import time
import types

import psycopg2
from psycopg2.extras import Json, execute_values

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'coordinator-rs/tools/d05'))
from run import Campaign as Readers, TABLES, digest
from cases import pca
from tunnel import Tunnel
sys.path.insert(0,str(ROOT/'coordinator-rs/tools/d06'))
from observer import sample
sys.path.insert(0,str(ROOT/'coordinator-rs/ci'))
from replay_pins import kernel_environment, runtime_identity, select_pin
from reference_assets import load_asset
FOLD=types.ModuleType("d07_reference_fold")
sys.modules[FOLD.__name__]=FOLD
exec(compile(load_asset(ROOT,"aaaf7ca5c93f9a758b28e7a361c3b9544e24305a","delphi/tests/poller/recovery/fold.py"),"pinned-d07-fold.py","exec"),FOLD.__dict__)
sys.path.insert(0,str(Path(__file__).parent))
from boundary import SQL, SQL_SHA256, public_census, IMAGES
from readiness import drained,bucket_counts_match
from rehearsal_verify import inventory

PROFILES = ((1,*os.environ.get('D07_PROFILE','vw-warm').rsplit('-',1)),)
if PROFILES[0][1:] not in ((s,m) for s in ('vw','biodiversity') for m in ('warm','snapshot')):
    raise ValueError('invalid D07_PROFILE')


class Rehearsal(Readers):
    def __init__(self,*args):
        super().__init__(*args)
        self.receipt.update(schema='polis-d07-public/1',scope='actual Clojure and Rust/Python; public prefixes',
                            capacity='UNADMITTED',alarm_delivery='OPERATOR_NOT_EVALUATED',
                            measurements=[],legacy_processes=[],exclusions=[],observations=[],cuts=[],
                            runtime_controls=os.environ.get('D07_CONTROLS')=='1',
                            profile=os.environ.get('D07_PROFILE','vw-warm'),initialization='live-empty then retained Clojure rows')
        self.inputs = {}
        self.loaded = {}
        self.observer = None
        self.stage = 'prepare'
        self.receipt['http_observations']=[]
        for p in (ROOT/'coordinator-rs/tools/d07').glob('*'):
            if p.is_file(): self.receipt['source_sha256'][str(p.relative_to(ROOT))]=digest(p.read_bytes())
        for p in (ROOT/'math/src').rglob('*.clj'):
            self.receipt['source_sha256'][str(p.relative_to(ROOT))]=digest(p.read_bytes())
        self.receipt['source_sha256']['math/deps.edn']=digest((ROOT/'math/deps.edn').read_bytes())
        if digest((ROOT/SQL).read_bytes()) != SQL_SHA256: raise ValueError('unreviewed SQL')

    def http(self,*args,**kwargs):
        started=time.monotonic()
        try:
            result=super().http(*args,**kwargs)
            self.receipt['http_observations'].append({'reader':args[0],'path':args[1].split('?')[0],
                'status':result[0],'bytes':len(result[2]),'wall_seconds':time.monotonic()-started})
            return result
        except Exception as error:
            self.receipt['http_observations'].append({'reader':args[0],'path':args[1].split('?')[0],
                'error':type(error).__name__,'wall_seconds':time.monotonic()-started})
            raise

    def controls(self):
        directory=self.output/'runtime-controls';directory.mkdir()
        env=dict(self.env,POLIS_TEST_POSTGRES_URL=f'postgresql://postgres@127.0.0.1:{self.port}/p027',
            P027_BRIDGE_ARTIFACTS=str(directory),PYTHONDONTWRITEBYTECODE='1',PYTHONPATH=str(ROOT/'delphi'),
            OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1')
        with (directory/'pytest.log').open('w') as log:
            result=subprocess.run([sys.executable,'-B','-m','pytest','-q','-o','addopts=',
                'tests/coordinator/test_writer_authority.py','tests/coordinator/test_observer.py',
                '--junitxml='+str(directory/'junit.xml')],cwd=ROOT/'delphi',env=env,
                stdout=log,stderr=subprocess.STDOUT,timeout=600)
        import xml.etree.ElementTree as ET
        suites=ET.parse(directory/'junit.xml').getroot()
        cases=list(suites.iter('testcase'))
        self.check('controls/runtime-authority-observer',result.returncode==0 and bool(cases)
            and not any(list(c) for c in cases),tests=len(cases),exit_code=result.returncode)

    def prepare(self):
        if any(self.command(['docker',k,'ls','-q','--filter',f'label=com.docker.compose.project={self.project}']).split()
               for k in ('container','network','volume')): raise ValueError('project already in use')
        super().prepare()
        self.receipt['public_inputs']=public_census()
        # Relay EOF must terminate docker exec even when local stdin remains
        # open (libpq reads until EOF after a terminated backend's error).
        relay="const s=require('net').connect(5432,'postgres');process.stdin.pipe(s);s.pipe(process.stdout);s.on('end',()=>process.exit(0));s.on('error',()=>process.exit(1));"
        relay_argv=['docker','exec','-i',self.dc('ps','-q','file-server').strip(),'node','-e',relay]
        self.connection.close()
        for tunnel in self.tunnels.pop('postgres'):tunnel.close()
        self.tunnels['postgres']=[Tunnel(self.port,relay_argv)]
        self.connection=psycopg2.connect(host='127.0.0.1',port=self.port,dbname='p027',user='postgres',sslmode='disable',connect_timeout=5)
        self.connection.autocommit=True
        self.tunnels['exclusion']=[Tunnel(self.port+13,relay_argv)]
        self.receipt['runtime']=select_pin(runtime_identity(),ROOT/'coordinator-rs/ci/replay-pins.json')
        self.receipt['postgres_settings']=self.query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('server_version','shared_buffers','work_mem','max_connections','fsync','synchronous_commit') ORDER BY name")
        self.receipt['host_runtime']={'python':sys.version,'executable_sha256':digest(Path(sys.executable).read_bytes()),
            'platform':platform.platform(),'cpu_limit':'not constrained for host Rust/Python',
            'memory_limit':'not constrained for host Rust/Python','worker_profile':'single coordinator; serial fresh Python child',
            'clojure_cpu_limit':2,'clojure_memory_limit_bytes':3*1024**3,'clojure_heap_limit_bytes':2*1024**3}
        self.receipt['public_inputs_execution']='selected profile only; other census remains NOT_RUN'
        self.query('CREATE ROLE d07_legacy LOGIN; CREATE ROLE d07_observer LOGIN')
        self.query('GRANT polis_coordinator_observer TO d07_observer')
        self.query('GRANT USAGE ON SCHEMA public TO d07_legacy,d07_observer')
        self.query('GRANT SELECT ON conversations,comments,votes,participants TO d07_legacy')
        self.query('GRANT SELECT,INSERT,UPDATE ON math_ticks,math_main,math_bidtopid,math_ptptstats,math_profile TO d07_legacy')
        self.observer=psycopg2.connect(host='127.0.0.1',port=self.port,dbname='p027',user='d07_observer',sslmode='disable',connect_timeout=5)
        for zid,slug,_ in PROFILES:
            for table in ('votes','votes_latest_unique','comments','participants'):
                self.query(f'DELETE FROM {table} WHERE zid=%s',(zid,))
            path=next((ROOT/'delphi/real_data').glob('*-'+slug+'/*-votes.csv'))
            raw=list(csv.DictReader(path.read_text().splitlines()))
            pids={v:i for i,v in enumerate(sorted({int(r['voter-id']) for r in raw}))}
            tids={v:i for i,v in enumerate(sorted({int(r['comment-id']) for r in raw}))}
            rows=[(pids[int(r['voter-id'])],tids[int(r['comment-id'])],-int(r['vote']),int(float(r['timestamp'])*1000)) for r in raw]
            self.inputs[zid]=rows;self.loaded[zid]=0
            for pid in pids.values():
                uid=10000+zid*1000+pid
                self.query('INSERT INTO users(uid,hname,email,site_id) VALUES(%s,%s,%s,%s)',
                           (uid,f'Public participant {pid}',f'd07-{uid}@example.invalid',f'd07-{uid}'))
                self.query('INSERT INTO participants(zid,pid,uid) VALUES(%s,%s,%s)',(zid,pid,uid))
            for tid in tids.values():
                self.query('INSERT INTO comments(zid,tid,pid,uid,txt,mod,is_meta,created,modified) VALUES(%s,%s,0,%s,%s,0,false,1000,1000)',
                           (zid,tid,10000+zid*1000,f'Public statement {tid}'))
        config=json.loads(self.config.read_text())
        self.receipt['cached_images']={tag:self.command(['docker','image','inspect',tag,'--format','{{.Id}}']).strip() for tag in IMAGES}
        # Offline classpath is discovered from the cached image, but all math
        # source/deps and this launcher are mounted from the attributed snapshot.
        config['services']['legacy']={
            'image':self.receipt['cached_images']['p024s-8fq2-math:latest'],
            'entrypoint':['sh','-c'],
            'command':['exec java -Xmx2g -cp "/app/src:$(find /root/.m2/repository -name \"*.jar\" -type f | sort | paste -sd: -)" clojure.main /d07/legacy.clj'],
            'working_dir':'/app','restart':'no','cpus':2,'mem_limit':'3g',
            'environment':{'D07_ZID':'1','D07_RECOMPUTE':'true'},
            'volumes':[{'type':'bind','source':str(ROOT/'math/src'),'target':'/app/src','read_only':True},
                       {'type':'bind','source':str(ROOT/'coordinator-rs/tools/d07'),'target':'/d07','read_only':True}],
            'networks':['sealed'],'pull_policy':'never'}
        config['services']['legacy']['volumes'].append({'type':'bind','source':str(self.output),'target':'/state','read_only':False})
        self.config.write_text(json.dumps(config,indent=2)+'\n')
        self.check('prepare/source-and-runtime',True)

    def census(self,zid,cut):
        expected=sorted(self.inputs[zid][:cut])
        actual=self.query('SELECT pid,tid,vote,created FROM votes WHERE zid=%s ORDER BY pid,tid,vote,created',(zid,))
        return actual==expected

    def ingest(self,zid,cut,label):
        before=self.loaded[zid]
        rows=self.inputs[zid][before:cut]
        # CSV prefixes are declared snapshots, not chronological arrivals.
        # Publish the whole cut atomically so a live poller cannot advance its
        # watermark through a partially inserted, timestamp-unordered cut.
        self.connection.autocommit=False
        try:
            with self.connection.cursor() as cur:
                # The production votes rule upserts votes_latest_unique. Preserve
                # every source row and order, but never put a repeated cell in one
                # INSERT statement (Postgres rejects double ON CONFLICT updates).
                batch=[];seen=set()
                for row in rows:
                    if row[:2] in seen or len(batch)==100:
                        execute_values(cur,'INSERT INTO votes(zid,pid,tid,vote,created) VALUES %s',batch)
                        batch=[];seen=set()
                    batch.append((zid,*row));seen.add(row[:2])
                if batch: execute_values(cur,'INSERT INTO votes(zid,pid,tid,vote,created) VALUES %s',batch)
            self.connection.commit()
        except BaseException:
            self.connection.rollback();raise
        finally:
            self.connection.autocommit=True
        self.loaded[zid]=cut
        self.check(label+'/source',self.census(zid,cut),cut=cut,appended=len(rows))
        self.receipt['cuts'].append({'zid':zid,'label':label,'cut':cut,
            'input_sha256':digest(json.dumps(self.inputs[zid][:cut],separators=(',',':')).encode()),
            'events':cut,'distinct_cells':len({r[:2] for r in self.inputs[zid][:cut]})})

    def bundle(self,zid,ns):
        return {t:self.query(f'SELECT row_to_json(x) FROM math_{t} x WHERE zid=%s AND math_env=%s',(zid,ns))[0][0]
                for t in TABLES}

    def coherent(self,zid,ns):
        rows=[self.query(f'SELECT math_tick FROM math_{t} WHERE zid=%s AND math_env=%s',(zid,ns)) for t in TABLES]
        return all(len(r)==1 for r in rows) and len({r[0][0] for r in rows})==1

    def exclude(self,label):
        # NOLOGIN alone leaves established backends usable; demonstrate that
        # before terminating the actual credential's sessions. No math policy.
        old=psycopg2.connect(host='127.0.0.1',port=self.port+13,dbname='p027',user='d07_legacy',sslmode='disable',connect_timeout=5)
        old.autocommit=True
        pid=old.get_backend_pid()
        self.query('ALTER ROLE d07_legacy NOLOGIN')
        with old.cursor() as cur:
            cur.execute('SELECT 1'); usable=cur.fetchone()==(1,)
        self.check(label+'/negative-nologin-retains-session',usable,backend_pid=pid)
        killed=self.query("SELECT pid,pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='d07_legacy'")
        denied=False
        try:
            with old.cursor() as cur: cur.execute('SELECT 1')
        except psycopg2.Error: denied=True
        old.close()
        reconnect=False
        try:
            c=psycopg2.connect(host='127.0.0.1',port=self.port+13,dbname='p027',user='d07_legacy',sslmode='disable',connect_timeout=5);c.close()
        except psycopg2.Error: reconnect=True
        self.dc('stop','legacy');self.dc('rm','-f','legacy')
        self.check(label+'/excluded',denied and reconnect and not self.query("SELECT pid FROM pg_stat_activity WHERE usename='d07_legacy'"),
                   old_denied=denied,reconnect_denied=reconnect,backends=killed)
        evidence={'label':label,'terminated_backends':killed,'old_denied':denied,'reconnect_denied':reconnect,
                  'restart':'no','container_removed':not self.dc('ps','-a','-q','legacy').strip()}
        self.receipt['exclusions'].append(evidence)
        return digest(json.dumps(evidence,sort_keys=True).encode())

    def legacy(self,zid,recompute,label,bootstrap_cut=None):
        self.stage=label
        (self.output/label).parent.mkdir(parents=True,exist_ok=True)
        self.query('ALTER ROLE d07_legacy LOGIN')
        config=json.loads(self.config.read_text())
        config['services']['legacy']['environment'].update(D07_ZID=str(zid),D07_RECOMPUTE=str(recompute).lower())
        self.config.write_text(json.dumps(config,indent=2)+'\n')
        state_path=self.output/'legacy-state.json'
        state_path.unlink(missing_ok=True)
        start=time.monotonic()
        self.dc('up','-d','--pull','never','legacy')
        cid=self.dc('ps','-q','legacy').strip()
        jars=self.command(['docker','exec',cid,'sh','-c',
            'find /root/.m2/repository -name "*.jar" -type f -print0 | sort -z | xargs -0 sha256sum'])
        (self.output/(label+'-jars.sha256')).write_text(jars)
        if bootstrap_cut is not None:
            # A new live conversation has no votes yet. The ordinary moderation
            # poller creates the actor, then public votes arrive. No engine hook.
            self.check(label+'/bootstrap-no-history',self.loaded[zid]==0 and not self.query(
                "SELECT 1 FROM math_main WHERE zid=%s AND math_env='legacy'",(zid,)))
            deadline=time.monotonic()+120
            initial=None
            while time.monotonic()<deadline:
                if state_path.exists():
                    initial=json.loads(state_path.read_text())
                    if initial.get('zid')==zid:break
                time.sleep(.1)
            self.check(label+'/bootstrap-live-empty-actor',initial is not None and initial.get('cells')==[])
            self.ingest(zid,bootstrap_cut,label+'/quarter')
        target=max(r[3] for r in self.inputs[zid][:self.loaded[zid]])
        observed=[]
        expected_cells={}
        # Match the actual declared Clojure query ordering (tid,pid,created),
        # retaining file order for equal keys; no cross-engine equality claim.
        for pid,tid,vote,created in sorted(self.inputs[zid][:self.loaded[zid]],key=lambda r:(r[1],r[0],r[3])):
            expected_cells[pid,tid]=vote
        expected_cells=sorted([pid,tid,v] for (pid,tid),v in expected_cells.items())
        state={}
        while time.monotonic()-start<240:
            coherent=self.coherent(zid,'legacy')
            row=self.query("SELECT last_vote_timestamp FROM math_main WHERE zid=%s AND math_env='legacy'",(zid,))
            observed.append({'elapsed_seconds':time.monotonic()-start,'coherent':coherent,'last_vote_timestamp':row[0][0] if row else None})
            if state_path.exists():state=json.loads(state_path.read_text())
            if coherent and row and row[0][0]==target and state.get('cells')==expected_cells:
                break
            process_state=json.loads(self.command(['docker','inspect',cid,'--format','{{json .State}}']))
            if not process_state['Running']: break
            time.sleep(.25)
        (self.output/(label+'-poll.json')).write_text(json.dumps(observed,indent=2)+'\n')
        logs=self.dc('logs','--no-color','legacy',check=False)
        (self.output/(label+'-legacy.log')).write_text(logs)
        self.receipt['legacy_processes'].append({'label':label,'container':cid,'recompute':recompute,'zid':zid,
                                                'image':config['services']['legacy']['image']})
        (self.output/(label+'-state.json')).write_text(json.dumps(state,indent=2)+'\n')
        self.check(label+'/real-clojure',self.coherent(zid,'legacy') and bool(row) and row[0][0]==target and state.get('cells')==expected_cells,
                   target_timestamp=target,elapsed_seconds=time.monotonic()-start)
        self.measure(zid,label,start,cid)
        exclusion=self.exclude(label)
        self.check(label+'/coherent-after-exclusion',self.coherent(zid,'legacy'))
        return exclusion

    def measure(self,zid,label,start,cid=None):
        stats=None
        if cid:
            stats=json.loads(self.command(['docker','stats','--no-stream','--format','{{json .}}',cid]).strip())
            stats['memory_peak_bytes']=int(self.command(['docker','exec',cid,'cat','/sys/fs/cgroup/memory.peak']).strip())
        sizes=self.query("SELECT pg_database_size(current_database()),pg_total_relation_size('votes')")[0]
        publication={ns:{t:self.query(f'SELECT coalesce(sum(pg_column_size(x)),0) FROM math_{t} x WHERE zid=%s AND math_env=%s',(zid,ns))[0][0] for t in TABLES}
                     for ns in ('legacy','rustproto')}
        self.receipt['measurements'].append({'label':label,'zid':zid,'cut':self.loaded[zid],
            'wall_seconds':time.monotonic()-start,'database_bytes':sizes[0],'votes_relation_bytes':sizes[1],
            'publication_row_bytes':publication,'container_stats':stats,
            'memory_method':'docker stats plus cgroup memory.peak' if stats else 'wait4 process usage in python_processes',
            'scope':'owned DB total; per-zid namespace row storage; wall clock includes startup',
            'capacity':'UNADMITTED'})

    def publish(self,name,zids):
        start=time.monotonic()
        (self.output/name).parent.mkdir(parents=True,exist_ok=True)
        env=dict(self.env,DATABASE_URL=f'postgresql://d05_control@127.0.0.1:{self.port}/p027',
                 COORDINATOR_PUBLISHER_DATABASE_URL=f'postgresql://d05_publisher@127.0.0.1:{self.port}/p027',
                 MATH_ENV='rustproto',P026_PYTHON=sys.executable,PYTHONPATH=str(ROOT/'delphi'),
                 PYTHONDONTWRITEBYTECODE='1',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',
                 P026_RESERVATION_BYTES='67108864',POLL_ALLOWLIST=','.join(map(str,zids)),
                 P026_ENVIRONMENT='generated',P026_LEASE_SECONDS='120')
        with (self.output/(name+'.log')).open('w') as log:
            proc=subprocess.Popen([str(ROOT/'coordinator-rs/target/fault/debug/polis-coordinator'),'once'],
                                  cwd=ROOT/'delphi',env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                while True:
                    waited,status,usage=os.wait4(proc.pid,os.WNOHANG)
                    if waited:break
                    if time.monotonic()-start>300:raise TimeoutError('public child timeout')
                    time.sleep(.05)
            except BaseException:
                os.killpg(proc.pid,signal.SIGKILL)
                _,status,usage=os.wait4(proc.pid,0)
                proc.returncode=os.waitstatus_to_exitcode(status)
                raise
            proc.returncode=os.waitstatus_to_exitcode(status)
        self.check(name,proc.returncode==0,exit_code=proc.returncode,pid=proc.pid)
        self.receipt.setdefault('python_processes',[]).append({'label':name,'coordinator_pid':proc.pid,
            'peak_rss_bytes':usage.ru_maxrss*(1 if platform.system()=='Darwin' else 1024),
            'user_seconds':usage.ru_utime,'system_seconds':usage.ru_stime,
            'method':'wait4 resource usage for coordinator and waited children',
            'wall_seconds':time.monotonic()-start})
        zid=zids[0]
        self.check(name+'/coherent',self.coherent(zid,'rustproto'))
        bundle=self.bundle(zid,'rustproto')
        events=[dict(zip(('pid','tid','vote','created'),r)) for r in self.query(
            'SELECT pid,tid,vote,created FROM votes WHERE zid=%s ORDER BY created,tid,pid,vote',(zid,))]
        fold=FOLD.fold_votes(events)
        problems=FOLD.check_published_against_fold(bundle['main']['data'],fold,require_all_clustered=False)
        if not bucket_counts_match(bundle['main']['data'],fold):problems.append('clustered vote buckets differ from independent raw fold')
        generation=self.query("SELECT input_checkpoint FROM polis_coordinator_generations WHERE math_env='rustproto' AND zid=%s AND math_tick=%s",(zid,bundle['ticks']['math_tick']))
        event_count=generation[0][0].get('event_count') if len(generation)==1 else None
        self.check(name+'/independent-input-fold',not problems and event_count==self.loaded[zid],
            problems=problems,event_count=event_count)
        p={'environment':'generated','math_env':'rustproto','shards':1,'allowlist':list(zids)}
        obs=sample(self.observer,p)
        self.receipt['observations'].append({'label':name,'profile':p,'sample':obs})
        self.check(name+'/observer',obs['ObserverHealthy']==1 and obs.get('PollHealthy')==1
                   and obs.get('PendingOperations')==0 and obs.get('UnresolvedOperations')==0,**obs)
        exact=self.query("SELECT count(*) FROM polis_coordinator_operations o LEFT JOIN polis_coordinator_generations g USING(math_env,zid,operation_id) WHERE o.math_env='rustproto' AND o.zid=%s AND (g.operation_id IS NULL OR o.owner_epoch<>g.publisher_epoch OR o.owner_id<>g.owner_id OR o.capability_sha256<>g.capability_sha256)",(zid,))[0][0]
        self.check(name+'/exact-operation-receipts',exact==0)
        self.measure(zid,name,start)

    def drain_evidence(self,zid,label):
        profile={'environment':'generated','math_env':'rustproto','shards':1,'allowlist':[zid]}
        observation=sample(self.observer,profile)
        rows=self.query("""SELECT o.operation_id,o.state,
            (g.operation_id IS NOT NULL AND o.owner_epoch=g.publisher_epoch AND o.owner_id=g.owner_id
             AND o.capability_sha256=g.capability_sha256 AND o.expected_tick IS NOT DISTINCT FROM g.expected_tick)
            FROM polis_coordinator_operations o LEFT JOIN polis_coordinator_generations g
            USING(math_env,zid,operation_id) WHERE o.math_env='rustproto' AND o.zid=%s ORDER BY o.operation_id""",(zid,))
        operations=[dict(zip(('operation_id','state','exact'),r)) for r in rows]
        evidence={'sample':observation,'operations':operations}
        (self.output/(label+'-drain.json')).write_text(json.dumps(evidence,indent=2)+'\n')
        self.check(label+'/drain',drained(observation,operations),**evidence)
        return digest(json.dumps(evidence,sort_keys=True).encode())

    def transition(self,source,destination,zid,last,label,exclusion):
        role='d05_operator_p' if destination=='rustproto' else 'd05_operator_l'
        with psycopg2.connect(host='127.0.0.1',port=self.port,dbname='p027',user=role) as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT * FROM pc_transition(%s,%s,%s,%s,%s,%s)',(source,destination,zid,label,last,exclusion));row=cur.fetchone()
        self.check(label+'/floor',row[1]>=last,outcome=row[0],floor=row[1],tick=row[2])
        return row

    def close(self):
        if self.observer: self.observer.close()
        super().close()


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    env=kernel_environment(os.environ,platform.system(),platform.machine())
    for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):env[key]='1'
    os.environ.clear();os.environ.update(env)
    c=Rehearsal(args.output.resolve(),os.environ['COMPOSE_PROJECT_NAME'],int(os.environ['POLIS_RECOVERY_PG_PORT']))
    try:
        c.prepare()
        if os.environ.get('D07_CONTROLS')=='1':c.controls()
        from rehearsal_cases import exercise
        exercise(c)
        if [x['name'] for x in c.receipt['cases']]!=inventory(c.receipt['profile'],c.receipt['runtime_controls']):
            raise AssertionError('D07 case inventory mismatch')
        for name,expected in c.receipt['source_sha256'].items():
            if digest((ROOT/name).read_bytes())!=expected:raise AssertionError('source drift: '+name)
        c.receipt['status']='PASS'
        c.receipt['rehearsal']='PASS'
    except BaseException as e:
        c.receipt['error']=f'{type(e).__name__}: {e}';c.receipt['failed_stage']=c.stage
        raise
    finally: c.close()


if __name__=='__main__':main()
