"""Owned public PG17 fixture-builder and unchanged 000021 reversal exercise."""
import json
import copy
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import psycopg2

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ci/private_cert/images'))
from roles_rehearsal import SEED,test_job
from roles_reader import projection
from roles_producer import produce
from roles_verifier import receipt,controls
from reversal_fixture import restore,snapshot,residue
from roles_census import encoded

SHAPE="""
CREATE TABLE public.empty_acl(id integer);
CREATE TABLE public.default_acl(id integer);
CREATE TABLE public.hidden(id integer,note text);
CREATE TABLE public.partitioned(id integer) PARTITION BY RANGE(id);
CREATE TABLE public.part0 PARTITION OF public.partitioned FOR VALUES FROM (0) TO (10);
CREATE SEQUENCE public.fixture_seq;
CREATE VIEW public.unreadable_view AS SELECT * FROM public.hidden;
CREATE FUNCTION public.overloaded(integer) RETURNS integer LANGUAGE SQL AS 'SELECT $1';
CREATE FUNCTION public.overloaded(text DEFAULT 'fixture-withheld-marker') RETURNS text LANGUAGE SQL SECURITY DEFINER AS 'SELECT $1';
"""


def run():
    project=os.environ['COMPOSE_PROJECT_NAME'];port=int(os.environ['POLIS_RECOVERY_PG_PORT'])
    if not project.startswith('p027-reversal-') or not 55432<=port<65000 or os.environ['RECOVERY_PG_PORT']!=str(port):raise ValueError('OWNED_PROJECT_REQUIRED')
    work=Path(os.environ['REVERSAL_EVIDENCE_DIR']);work.mkdir(parents=True,exist_ok=True)
    commands=[];owned=[];connections=[];outcomes=[]
    def command(args,content=None):
        p=subprocess.run(args,input=content,text=True,capture_output=True)
        commands.append({'argv':args,'exit':p.returncode})
        if p.returncode:raise RuntimeError(p.stderr)
        return p.stdout
    try:
        for i in range(2):
            name=project+('-source' if i==0 else '-target')
            for kind,args in [('container',['ps','-aq']),('network',['network','ls','-q']),('volume',['volume','ls','-q'])]:
                if command(['docker',*args,'--filter','label=com.docker.compose.project='+name]).strip():raise ValueError('EXISTING_PROJECT_REFUSED')
            env=os.environ|{'COMPOSE_PROJECT_NAME':name,'POLIS_RECOVERY_PG_PORT':str(port+i),'RECOVERY_PG_PORT':str(port+i)}
            dc=['docker','compose','-f',str(ROOT/'ci/probe_box/test.compose.yml')]
            owned.append((dc,env))
            p=subprocess.run(dc+['up','-d','--wait','--pull','never'],env=env,capture_output=True,text=True)
            commands.append({'argv':dc+['up','-d','--wait','--pull','never'],'project':name,'port':port+i,'exit':p.returncode})
            if p.returncode:raise RuntimeError('OWNED_START_FAILED')
            container=subprocess.check_output(dc+['ps','-q','postgres'],env=env,text=True).strip()
            def sql_file(path):return command(['docker','exec','-i',container,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','probe_test'],path.read_text())
            migrations=ROOT/'server/postgres/migrations'
            conn=psycopg2.connect(host='127.0.0.1',port=port+i,user='postgres',dbname='probe_test');connections.append(conn)
            if i==0:
                with conn:
                    with conn.cursor() as c:c.execute(SEED)
                reader=psycopg2.connect(host='127.0.0.1',port=port,user='polis_probe_reader',dbname='probe_test');connections.append(reader)
                p=projection(reader,'1'*40);job=test_job();r=receipt(p,produce(p),job,'1'*40);r['controls']=controls(job)
                if r['verdict']!='PASS':raise ValueError('SOURCE_CENSUS_INCOMPLETE')
                source_before=snapshot(conn)
                with reader.cursor() as c:
                    c.execute("SHOW transaction_read_only");assert c.fetchone()[0]=='on'
                    try:c.execute('CREATE TABLE public.refused_source_write(id integer)')
                    except psycopg2.Error as error:assert error.pgcode in ('25006','42501')
                    else:raise AssertionError('SOURCE_WRITE_ALLOWED')
                reader.rollback()
                assert snapshot(conn)==source_before;outcomes.append('source-reader-read-only')
                (work/'public-receipt.json').write_text(json.dumps(r));(work/'public-job.json').write_text(json.dumps(job))
            else:
                with conn:
                    with conn.cursor() as c:c.execute(SHAPE)
                clean=snapshot(conn)
                def refused(label,action,code):
                    before_control=snapshot(conn)
                    try:action()
                    except ValueError as error:
                        assert str(error)==code,(label,str(error))
                    else:raise AssertionError(label)
                    assert snapshot(conn)==before_control,label
                    outcomes.append(label)
                bad=copy.deepcopy(r);bad['unexpected']=True
                refused('invalid-receipt-atomic-refusal',lambda:restore(conn,bad,job,settings_presence=True),'CENSUS_SCHEMA')
                refused('settings-values-withheld-refusal',lambda:restore(conn,r,job),'REVERSAL_SETTINGS_UNMODELED')
                with conn:
                    with conn.cursor() as c:c.execute('CREATE TABLE public.unreviewed_shape(id integer)')
                refused('unknown-shape-atomic-refusal',lambda:restore(conn,r,job,settings_presence=True),'REVERSAL_BASELINE_MISMATCH')
                with conn:
                    with conn.cursor() as c:c.execute('DROP TABLE public.unreviewed_shape')
                assert snapshot(conn)==clean
                mismatch=copy.deepcopy(r)
                mismatch['census']['role_dependencies'][0]['count']+=1
                mismatch['bindings']['census']=hashlib.sha256(encoded(mismatch['census'])).hexdigest()
                refused('post-write-mismatch-rolls-back',lambda:restore(conn,mismatch,job,settings_presence=True),'REVERSAL_PROJECTION_MISMATCH')
                restore(conn,r,job,settings_presence=True);outcomes.append('builder-equality')
                restore(conn,r,job,settings_presence=True);outcomes.append('builder-idempotence')
                with conn:
                    with conn.cursor() as c:
                        c.execute('SELECT NOT EXISTS(SELECT FROM pg_authid WHERE rolpassword IS NOT NULL)');assert c.fetchone()[0]
                outcomes.append('no-passwords-recreated')
                with conn:
                    with conn.cursor() as c:
                        c.execute('ALTER DATABASE probe_test OWNER TO census_owner')
                        c.execute('ALTER DATABASE probe_test CONNECTION LIMIT 23')
                        c.execute('GRANT census_owner TO census_member WITH ADMIN FALSE, INHERIT TRUE, SET FALSE')
                restore(conn,r,job,settings_presence=True)
                assert snapshot(conn)==r['census'];outcomes.append('database-attributes-and-membership-options-restored')
                with conn:
                    with conn.cursor() as c:c.execute('ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT SELECT ON TABLES TO census_member')
                refused('extra-default-acl-atomic-refusal',lambda:restore(conn,r,job,settings_presence=True),'REVERSAL_EXTRA_DEFAULT_ACL')
                with conn:
                    with conn.cursor() as c:c.execute('ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE SELECT ON TABLES FROM census_member')
                assert snapshot(conn)==r['census']

                target_reader=psycopg2.connect(host='127.0.0.1',port=port+1,user='polis_probe_reader',dbname='probe_test');connections.append(target_reader)
                assert projection(target_reader,'1'*40)['census']==r['census'];outcomes.append('restricted-projection-equality')
                # Equality is proved against the original standalone census.
                # The application baseline is a separate, declared prerequisite
                # for migration 21, not an invented reconstruction of source DDL.
                for path in sorted(migrations.glob('0*.sql')):
                    if path.name<'000021':sql_file(path)
                outcomes.append('reviewed-application-baseline-installed')
                before=snapshot(conn)
                up=migrations/'000021_create_polis_coordinator.sql';down=migrations/'down/000021_drop_polis_coordinator.sql'
                # Original SQL is passed byte-for-byte to psql; no migration edits.
                sql_file(up);first=snapshot(conn);sql_file(up);assert snapshot(conn)==first;outcomes.append('up-idempotent')
                sql_file(down);after=snapshot(conn);report=residue(before,after)
                (work/'residue.json').write_text(json.dumps(report,sort_keys=True,indent=2)+'\n')
                assert report['classification']=='ACL_REPRESENTATION_ONLY';outcomes.append('down-residue-classified')
                assert {tuple(x['identity']) for x in report['changes']['relations']}=={('public',t) for t in ('math_main','math_ticks','math_bidtopid','math_ptptstats')};outcomes.append('only-four-math-acl-states-change')
                sql_file(down);assert snapshot(conn)==after;outcomes.append('down-idempotent')
                sql_file(up);sql_file(down);assert snapshot(conn)==after;outcomes.append('reapply-down-stable-residue')
        assert snapshot(connections[0])==source_before;outcomes.append('source-catalog-unchanged')
        (work/'result.json').write_text(json.dumps({'schema':'polis-reversal-rehearsal/1','checks':outcomes,'settings':'PRESENCE_ONLY','passwords':'NOT_RECREATED','production_reversal':'NOT_EVALUATED','reversal':report['verdict'],'classification':report['classification']},indent=2)+'\n')
        print(json.dumps({'checks':outcomes,'count':len(outcomes)}))
    finally:
        for conn in connections:conn.close()
        cleanup_failed=False
        for dc,env in reversed(owned):
            p=subprocess.run(dc+['down','--volumes'],env=env,capture_output=True,text=True)
            commands.append({'argv':dc+['down','--volumes'],'project':env['COMPOSE_PROJECT_NAME'],'exit':p.returncode})
            cleanup_failed=cleanup_failed or p.returncode!=0
        (work/'commands.json').write_text(json.dumps(commands,indent=2)+'\n')
        if cleanup_failed:raise RuntimeError('OWNED_CLEANUP_FAILED')

if __name__=='__main__':run()
