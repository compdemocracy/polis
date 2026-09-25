"""Public P-058 vectors and independent host/operator export refusals."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

HERE=Path(__file__).parent
sys.path.insert(0,str(HERE))
sys.path.insert(0,str(HERE.parent/'private_cert/images'))
sys.path.insert(0,str(HERE.parent/'private_cert'))
from contracts import validate_job, decode_job
from receipt import decode_receipt, decode_json, sha
from roles_census import (FAMILIES, FLAGS, POLICY_SHA, encoded, normalize, validate_census,
                          validate_receipt, principal)
from roles_producer import produce
from roles_verifier import receipt, reconstruct, controls
from roles_rehearsal import test_job as job_fixture
from roles_recipe import recipe
from image_admission import validate_recipe


class CensusTests(unittest.TestCase):
    def setUp(self):
        self.job=job_fixture()
        self.p=json.loads((HERE/'fixtures/roles_projection.json').read_bytes())
        self.r=receipt(self.p,produce(self.p),self.job,self.p['source_commit'])
        self.r['controls']=controls(self.job)

    def refused(self,r):
        if 'census' in r:r['bindings']['census']=hashlib.sha256(encoded(r['census'])).hexdigest()
        with self.assertRaises(ValueError):decode_receipt(encoded(r),self.job)

    def test_complete_public_fixture_all_families(self):
        self.assertEqual(set(self.p['counts']),set(FAMILIES))
        self.assertTrue(all(self.p['counts'].values()))
        self.assertEqual(decode_receipt(encoded(self.r),self.job),self.r)
        self.assertEqual(self.r['verdict'],'PASS')
        self.assertEqual(len(self.r['controls']),10)
        self.assertTrue(all(self.r['controls'].values()))

    def test_every_family_rejects_extra_row_keys(self):
        for family in FAMILIES:
            with self.subTest(family=family):
                r=copy.deepcopy(self.r);r['census'][family][0]['extra']='fixture-forbidden';self.refused(r)

    def test_every_row_field_rejects_wrong_type(self):
        for family in FAMILIES:
            for field in self.r['census'][family][0]:
                with self.subTest(family=family,field=field):
                    r=copy.deepcopy(self.r);r['census'][family][0][field]={'unexpected':True};self.refused(r)

    def test_empty_policy_and_default_families_but_not_empty_census(self):
        r=copy.deepcopy(self.r)
        r['census']['policies']=[];r['census']['default_acls']=[]
        r['bindings']['census']=hashlib.sha256(encoded(r['census'])).hexdigest()
        decode_receipt(encoded(r),self.job)
        r['census']={f:[] for f in FAMILIES};self.refused(r)

    def test_every_family_rejects_duplicate_identity(self):
        for family in FAMILIES:
            with self.subTest(family=family):
                r=copy.deepcopy(self.r);r['census'][family].append(copy.deepcopy(r['census'][family][0]));self.refused(r)

    def test_every_family_count_and_omission(self):
        for f in FAMILIES:
            with self.subTest(family=f):
                p=copy.deepcopy(self.p);p['counts'][f]+=1
                with self.assertRaises(ValueError):reconstruct(p)
                p=copy.deepcopy(self.p);del p['census'][f]
                with self.assertRaises(ValueError):reconstruct(p)

    def test_order_and_producer_mutation(self):
        p=copy.deepcopy(self.p);p['census']['roles'].reverse()
        with self.assertRaises(ValueError):reconstruct(p)
        produced=produce(self.p);produced['roles'][0]['login']=not produced['roles'][0]['login']
        with self.assertRaises(ValueError):receipt(self.p,produced,self.job,self.p['source_commit'])

    def test_privilege_enums_and_references(self):
        for field,value in [('privilege','EXECUTE'),('grantor','absent'),('grantee',{'kind':'ROLE','name':'absent'}),('grantable',1)]:
            r=copy.deepcopy(self.r);row=next(x for x in r['census']['acls'] if x['kind']=='DATABASE');row[field]=value;self.refused(r)

    def test_public_and_named_public_are_distinct(self):
        # PG17 reserves lowercase public as a role name. This schema vector still
        # establishes tagged-principal semantics; real rehearsal uses "Public".
        principal({'kind':'PUBLIC','name':None},{'public'})
        principal({'kind':'ROLE','name':'public'},{'public'})
        with self.assertRaises(ValueError):principal({'kind':'PUBLIC','name':'public'},{'public'})

    def test_limits_identifiers_arrays_and_bytes(self):
        r=copy.deepcopy(self.r);r['census']['roles'][0]['name']='é'*32;self.refused(r)
        r=copy.deepcopy(self.r);r['census']['roles']*=4097;self.refused(r)
        with self.assertRaises(ValueError):decode_receipt(b' '*131073,self.job)
        with self.assertRaises(ValueError):decode_json(b'['*20+b'0'+b']'*20)

    def test_duplicate_json_keys_and_nonfinite(self):
        for raw in (b'{"a":1,"a":2}',b'{"nested":{"a":1,"a":2}}',b'[NaN]',b'[Infinity]'):
            with self.assertRaises(ValueError):decode_json(raw)

    def test_kind_run_image_and_policy_bindings(self):
        for field,value in [('kind','battery'),('schema','polis-probe-receipt/2'),('run_id','0'*32),('job_sha256','0'*64)]:
            r=copy.deepcopy(self.r);r[field]=value;self.refused(r)
        for field in ('reader','producer','verifier','query_policy'):
            r=copy.deepcopy(self.r);r['bindings'][field]='0'*64;self.refused(r)

    def test_false_pass_and_unknown_policy(self):
        r=copy.deepcopy(self.r);r['coverage']['roles']='NOT_VISIBLE';self.refused(r)
        r=copy.deepcopy(self.r);r['controls']['false-pass']=False;self.refused(r)
        r=copy.deepcopy(self.r);r['bindings']['server_version_num']=160000;self.refused(r)
        r=copy.deepcopy(self.r);r['census']['policies'][0]['using']='UNSUPPORTED_EXPRESSION';self.refused(r)

    def test_no_settings_values_or_policy_text(self):
        self.assertNotIn(b'fixture-withheld-marker',encoded(self.p))
        for family,field in [('roles','rolpassword'),('role_settings','values'),('routines','body'),('policies','sql')]:
            r=copy.deepcopy(self.r);r['census'][family][0][field]='fixture-withheld-marker';self.refused(r)

    def test_closed_job_two_commands_and_separate_images(self):
        self.assertEqual(decode_job(encoded(self.job)),self.job)
        for key,value in [('kind','battery'),('sql','SELECT 1'),('reader',{'image':self.job['reader']['image'],'args':['read','override']})]:
            j=copy.deepcopy(self.job);j[key]=value
            with self.assertRaises(ValueError):validate_job(j)
        j=copy.deepcopy(self.job);j['reader']['image']=j['producer']['image']
        with self.assertRaises(ValueError):validate_job(j)

    def test_version_one_cannot_select_census_export(self):
        j=copy.deepcopy(self.job);j['schema']='polis-probe-job/1';del j['kind']
        with self.assertRaises(ValueError):decode_receipt(encoded(self.r),j)
        j['kind']='roles-census'
        with self.assertRaises(ValueError):validate_job(j)

    def test_three_recipes_have_closed_action_source_and_policy(self):
        root=HERE.parents[1]
        for role in ('reader','producer','verifier'):
            r=recipe(root,role,'localhost/runtime@sha256:'+'1'*64)
            self.assertEqual(validate_recipe(r),r)
            bad=copy.deepcopy(r);bad['entrypoint']='ci/probe_box/receipt.py'
            with self.assertRaises(ValueError):validate_recipe(bad)
            bad=copy.deepcopy(r);bad['policySha256']='0'*64
            with self.assertRaises(ValueError):validate_recipe(bad)
        r['schema']='polis-private-image-recipe/1'
        with self.assertRaises(ValueError):validate_recipe(r)

    def test_membership_option_combinations_and_acl_states(self):
        import itertools
        for options in itertools.product((False,True),repeat=3):
            c=copy.deepcopy(self.p['census'])
            c['memberships'][0].update(zip(('admin','inherit','set'),options))
            validate_census(c)
        self.assertEqual({r['acl_state'] for r in self.p['census']['relations']},{'DEFAULT','EMPTY','EXPLICIT'})
        self.assertEqual({r['scope'] for r in self.p['census']['default_acls']},{'GLOBAL','PUBLIC'})
        self.assertEqual(len(self.p['census']['routines']),2)

    def test_unsupported_version_and_limits_never_become_empty_pass(self):
        from roles_reader import projection
        class Cursor:
            def __init__(self,version,large=False):self.version=version;self.large=large
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def execute(self,sql):pass
            def fetchone(self):return self.version,'on','repeatable read','polis_probe_reader','polis_probe_reader',63
            def fetchmany(self,n):return [(None,)]*n
        class Connection:
            def __init__(self,version):self.version=version
            def set_session(self,**kwargs):pass
            def cursor(self):return Cursor(self.version)
            def rollback(self):pass
        for version,status in ((160000,'UNSUPPORTED_VERSION'),(170000,'LIMIT_EXCEEDED')):
            p=projection(Connection(version),'1'*40)
            self.assertEqual(set(p['coverage'].values()),{status})
            self.assertFalse(any(p['census'].values()))
            r=receipt(p,produce(p),self.job,'1'*40);r['controls']=controls(self.job)
            self.assertEqual(r['verdict'],'INCOMPLETE');decode_receipt(encoded(r),self.job)

    def test_supervisor_file_boundary_and_kind_dispatch(self):
        from worker import load_receipt
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'receipt.json';path.write_bytes(encoded(self.r))
            self.assertEqual(load_receipt(path,self.job),self.r)
            path.write_bytes(b'{"kind":"roles-census","kind":"battery"}')
            with self.assertRaises(ValueError):load_receipt(path,self.job)
            path.unlink();path.symlink_to(Path(tmp)/'missing')
            with self.assertRaises(ValueError):load_receipt(path,self.job)

    def test_operator_revalidates_after_observed_cleanup(self):
        from test_run import session_setup
        x,c,e,s,i=session_setup()
        job=copy.deepcopy(self.job);job['run_id']='a'*32
        r=copy.deepcopy(self.r);r.update(run_id=job['run_id'],job_sha256=sha(job))
        x.start(job)
        key='results/arn:aws:ec2:us-east-1:111111111111:instance/i-test/receipt.json'
        s.objects['evidence',key]=encoded(r)
        self.assertFalse(x.status(job['run_id'])['passed'])
        i['State']['Name']='terminated'
        self.assertTrue(x.status(job['run_id'])['passed'])
        r['kind']='battery';s.objects['evidence',key]=encoded(r)
        with self.assertRaises(ValueError):x.status(job['run_id'])


if __name__=='__main__':unittest.main()
