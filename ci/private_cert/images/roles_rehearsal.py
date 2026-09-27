#!/usr/bin/env python3
"""Owned public PG17 catalog rehearsal. No remote/database URL input accepted."""
from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import subprocess
import sys

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
sys.path.insert(0,str(ROOT/'ci/probe_box'))
from roles_census import FAMILIES, FLAGS, POLICY_SHA, encoded, normalize, validate_census
from roles_queries import QUERIES
from roles_reader import projection
from roles_producer import produce
from roles_verifier import receipt, reconstruct, controls
from receipt import decode_receipt

SEED = """
CREATE ROLE polis_probe_reader LOGIN;
ALTER ROLE polis_probe_reader SET default_transaction_read_only=on;
GRANT CONNECT ON DATABASE probe_test TO polis_probe_reader;
GRANT USAGE ON SCHEMA public TO polis_probe_reader;
CREATE ROLE census_owner;
CREATE ROLE census_member VALID UNTIL '2030-01-02 03:04:05+00';
CREATE ROLE "Public";
CREATE ROLE polis_queue_owner;
GRANT census_owner TO census_member WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
ALTER ROLE census_owner SET application_name='fixture-withheld-marker';
ALTER ROLE census_member IN DATABASE probe_test SET application_name='fixture-withheld-marker';
CREATE TABLE public.empty_acl(id integer);
REVOKE ALL ON public.empty_acl FROM postgres;
CREATE TABLE public.default_acl(id integer);
CREATE TABLE public.hidden(id integer, note text);
INSERT INTO public.hidden VALUES (1,'fixture-withheld-marker');
ALTER TABLE public.hidden OWNER TO census_owner;
GRANT SELECT(id) ON public.hidden TO census_member WITH GRANT OPTION;
GRANT UPDATE ON public.hidden TO "Public";
CREATE TABLE public.partitioned (id integer) PARTITION BY RANGE(id);
CREATE TABLE public.part0 PARTITION OF public.partitioned FOR VALUES FROM (0) TO (10);
CREATE SEQUENCE public.fixture_seq;
GRANT USAGE ON SEQUENCE public.fixture_seq TO census_member;
CREATE VIEW public.unreadable_view AS SELECT * FROM public.hidden;
CREATE FUNCTION public.overloaded(integer) RETURNS integer LANGUAGE SQL AS 'SELECT $1';
CREATE FUNCTION public.overloaded(text DEFAULT 'fixture-withheld-marker') RETURNS text LANGUAGE SQL SECURITY DEFINER AS 'SELECT $1';
REVOKE ALL ON FUNCTION public.overloaded(integer) FROM PUBLIC;
CREATE POLICY permitted ON public.hidden FOR SELECT TO census_member USING (true);
CREATE POLICY denied ON public.hidden AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (false) WITH CHECK (false);
ALTER TABLE public.hidden ENABLE ROW LEVEL SECURITY;
ALTER DEFAULT PRIVILEGES FOR ROLE census_owner GRANT SELECT ON TABLES TO census_member;
ALTER DEFAULT PRIVILEGES FOR ROLE census_owner IN SCHEMA public GRANT UPDATE ON TABLES TO census_member;
GRANT SELECT ON public.hidden TO polis_queue_owner;
COMMENT ON TABLE public.hidden IS 'fixture-withheld-marker';
"""


def test_job():
    return dict(schema='polis-probe-job/2',kind='roles-census',run_id='1'*32,max_seconds=900,
        **{k:{'image':'localhost/census-'+k+'@sha256:'+str(i)*64,'args':[a]}
           for i,(k,a) in enumerate((('reader','read'),('producer','produce'),('verifier','verify')),1)})


def main():
    import psycopg2
    project=os.environ['COMPOSE_PROJECT_NAME'];port=int(os.environ['POLIS_RECOVERY_PG_PORT'])
    assert project.startswith('p027census-') and os.environ['RECOVERY_PG_PORT']==str(port) and 55432<=port<=65000
    dc=['docker','compose','-f',str(ROOT/'ci/probe_box/test.compose.yml')]
    def command(*args):return subprocess.run([*dc,*args],check=True,capture_output=True,text=True)
    assert not subprocess.check_output(['docker','ps','-aq','--filter',f'label=com.docker.compose.project={project}']).strip()
    outcomes=[]
    admin=reader=None
    try:
        command('up','-d','--wait')
        admin=psycopg2.connect(host='127.0.0.1',port=port,user='postgres',dbname='probe_test');admin.autocommit=True
        with admin.cursor() as cur:cur.execute(SEED)
        reader=psycopg2.connect(host='127.0.0.1',port=port,user='polis_probe_reader',dbname='probe_test')
        p=projection(reader,'1'*40)
        assert set(p['coverage'].values())=={'COMPLETE'},p['coverage']
        validate_census(p['census'])
        oracle={}
        with admin.cursor() as cur:
            for f in FAMILIES:cur.execute(QUERIES[f]);oracle[f]=[r[0] for r in cur.fetchall()]
        for r in oracle['default_acls']:r['entries'].sort(key=encoded)
        for r in oracle['policies']:r['roles'].sort(key=encoded)
        assert p['census']==normalize(oracle);outcomes.append('restricted-equals-privileged-oracle')
        assert b'fixture-withheld-marker' not in encoded(p);outcomes.append('no-withheld-values-or-hashes')
        job=test_job();r=receipt(p,produce(p),job,'1'*40);r['controls']=controls(job)
        assert r['verdict']=='PASS' and all(r['controls'].values());decode_receipt(encoded(r),job)
        outcomes.append('reader-producer-independent-verifier')
        with reader.cursor() as cur:
            cur.execute("SELECT count(*) FROM information_schema.table_privileges WHERE table_name='hidden'")
            assert cur.fetchone()[0]==0
        reader.rollback();outcomes.append('information-schema-omits-unreadable-object')
        for family in FAMILIES:
            bad=copy.deepcopy(p);bad['counts'][family]+=1
            try:reconstruct(bad)
            except ValueError:pass
            else:raise AssertionError(family)
        outcomes.append('all-family-inventory-refusals')
        with admin.cursor() as cur:cur.execute("CREATE POLICY unsupported ON public.hidden USING (note='fixture-withheld-marker')")
        unknown=projection(reader,'1'*40)
        assert unknown['coverage']['policies']=='UNSUPPORTED_EXPRESSION' and b'fixture-withheld-marker' not in encoded(unknown)
        r2=receipt(unknown,produce(unknown),job,'1'*40);r2['controls']=controls(job)
        assert r2['verdict']=='INCOMPLETE';decode_receipt(encoded(r2),job);outcomes.append('unknown-policy-incomplete')
        with admin.cursor() as cur:cur.execute('REVOKE SELECT ON pg_catalog.pg_policy FROM PUBLIC')
        denied=projection(reader,'1'*40)
        assert set(denied['coverage'].values())=={'NOT_VISIBLE'} and not any(denied['census'].values());outcomes.append('catalog-denial-incomplete')
        if '--write-fixture' in sys.argv:
            path=ROOT/'ci/probe_box/fixtures/roles_projection.json';path.parent.mkdir(exist_ok=True)
            path.write_bytes(encoded(p)+b'\n')
        print(json.dumps({'status':'PASS','checks':outcomes,'count':len(outcomes),'negative_controls':len(r['controls']),
            'family_counts':p['counts']}))
    finally:
        if reader:reader.close()
        if admin:admin.close()
        command('down','-v')


if __name__=='__main__':main()
