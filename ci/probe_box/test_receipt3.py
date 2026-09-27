"""Receipt /3 is an independent closed, bounded export boundary."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from contracts import validate_job, decode_job
from receipt import canonical, decode_receipt, sha, validate_receipt
from test_boundaries import job, receipt, sampled_receipt
import worker


def v3(fail=False):
    r=receipt();r['schema']='polis-probe-receipt/3'
    r['entries'][0].update(recipe='sample-uniform6',diagnostics=[],diagnostics_truncated=False)
    if fail:
        r['verdict']='FAIL';r['entries'][0]['verdict']='FAIL'
        r['entries'][0]['diagnostics']=[dict(checkpoint=0,family='meta',kind='exact-value',magnitude='not-applicable')]
    return r


class Receipt3Tests(unittest.TestCase):
    def test_legacy_bytes_still_decode_unchanged(self):
        for r in (receipt(),sampled_receipt()):
            raw=canonical(r);self.assertEqual(canonical(decode_receipt(raw,job())),raw)

    def test_pass_and_zero_outlier_fail_roundtrip(self):
        for fail in (False,True):
            r=v3(fail);self.assertEqual(decode_receipt(canonical(r),job()),r)
            self.assertEqual(r['entries'][0]['outliers'],0)

    def test_unknown_tokens_and_private_fields_are_refused(self):
        for field in ('checkpoint','family','kind','magnitude','path','value','pid','tid'):
            r=v3(True);r['entries'][0]['diagnostics'][0][field]='PRIVATE'
            with self.subTest(field=field),self.assertRaises(ValueError) as exc:decode_receipt(canonical(r),job())
            self.assertNotIn('PRIVATE',str(exc.exception))
        for target in ('root','entry'):
            r=v3();(r if target=='root' else r['entries'][0])['arbitrary']='PRIVATE'
            with self.assertRaises(ValueError):decode_receipt(canonical(r),job())
        r=v3();r['entries'][0]['recipe']='PRIVATE'
        with self.assertRaisesRegex(ValueError,'RECIPE'):decode_receipt(canonical(r),job())

    def test_checkpoint_requires_bounded_true_integer(self):
        for ordinal in (True,False,-1,3,0.0,None,'0'):
            r=v3(True);r['entries'][0]['diagnostics'][0]['checkpoint']=ordinal
            with self.subTest(ordinal=ordinal),self.assertRaises(ValueError):decode_receipt(canonical(r),job())

    def test_kind_magnitude_pairs_are_closed(self):
        for kind in ('numeric-tolerance','strict-tolerance','exact-value','shape','nonfinite'):
            for magnitude in ('over1-to2','over2-to10','over10','not-applicable'):
                r=v3(True);r['entries'][0]['diagnostics'][0].update(kind=kind,magnitude=magnitude)
                if (kind=='numeric-tolerance')==(magnitude!='not-applicable'):
                    decode_receipt(canonical(r),job())
                else:
                    with self.assertRaises(ValueError):decode_receipt(canonical(r),job())

    def test_duplicate_unsorted_and_excess_tuples_are_refused(self):
        r=v3(True);d=r['entries'][0]['diagnostics'][0]
        for rows in ([d,d],[dict(d,checkpoint=1),d],[dict(d,checkpoint=i) for i in range(9)]):
            bad=copy.deepcopy(r);bad['entries'][0].update(checks=10,diagnostics=rows)
            with self.assertRaises(ValueError):decode_receipt(canonical(bad),job())

    def test_fail_requires_diagnostic_and_pass_forbids_it(self):
        for fail,rows in ((False,v3(True)['entries'][0]['diagnostics']),(True,[])):
            r=v3(fail);r['entries'][0]['diagnostics']=rows
            with self.assertRaises(ValueError):decode_receipt(canonical(r),job())
        for changes in ({'verdict':'INCOMPLETE'},{'checks':0},{'diagnostics_truncated':1},{'diagnostics_truncated':True}):
            r=v3();r['entries'][0].update(changes)
            with self.assertRaises(ValueError):decode_receipt(canonical(r),job())

    def test_verdict_and_controls_cannot_be_forged(self):
        for edit in ('root-pass','root-fail','controls','outliers','nonfinite'):
            r=v3(edit=='root-pass')
            if edit=='root-pass':r['verdict']='PASS'
            elif edit=='root-fail':r['verdict']='FAIL'
            elif edit=='controls':r['controls']={'passed':20,'expected':21}
            else:r['entries'][0][edit]=1
            with self.assertRaises(ValueError):decode_receipt(canonical(r),job())

    def test_control_failure_decodes_with_passing_or_failing_entries(self):
        for fail in (False,True):
            for completed in (0,16,17,20):
                r=v3(fail);r['verdict']='FAIL';r['controls']['passed']=completed
                with self.subTest(fail=fail,completed=completed):
                    self.assertEqual(decode_receipt(canonical(r),job()),r)
                    for verdict in ('PASS','INCOMPLETE'):
                        r['verdict']=verdict
                        with self.assertRaisesRegex(ValueError,'FALSE_PASS'):decode_receipt(canonical(r),job())
        r=v3();r['controls']={'passed':20,'expected':20}
        self.assertEqual(decode_receipt(canonical(r),job()),r)

    def test_maximum_entry_count_and_global_tuple_budget(self):
        r=v3(True);r['entries']=[copy.deepcopy(r['entries'][0]) for _ in range(256)]
        for row in r['entries']:row['diagnostics_truncated']=True
        self.assertEqual(len(decode_receipt(canonical(r),job())['entries']),256)
        r['entries'][0]['diagnostics'].append(dict(r['entries'][0]['diagnostics'][0],checkpoint=1))
        with self.assertRaisesRegex(ValueError,'DIAGNOSTICS_LIMIT'):decode_receipt(canonical(r),job())

    def test_truncation_requires_exhausted_entry_or_global_budget(self):
        r=v3(True);r['entries'][0]['diagnostics_truncated']=True
        with self.assertRaisesRegex(ValueError,'TRUNCATION'):decode_receipt(canonical(r),job())
        d=r['entries'][0]['diagnostics'][0]
        r['entries'][0].update(checks=8,diagnostics=[dict(d,checkpoint=i) for i in range(8)])
        decode_receipt(canonical(r),job())

    def test_byte_limit_applies_after_projection_and_to_wire_bytes(self):
        r=v3(True);row=r['entries'][0];row.update(checks=2**53-1,worst_absolute=1.2345678901234567e308,worst_relative=1.2345678901234567e308,outliers=2**53-1,nonfinite=2**53-1,recipe='public-biodiversity-uniform8')
        row['legacy_defects']=[{'name':'legacy-defect-empty-omits-keys','keys':sorted(__import__('receipt').LEGACY_EMPTY_KEYS)}]
        r['entries']=[copy.deepcopy(row) for _ in range(256)]
        self.assertGreater(len(canonical(r)),131072)
        with self.assertRaisesRegex(ValueError,'RECEIPT_LIMIT'):validate_receipt(r,job())
        with self.assertRaisesRegex(ValueError,'RECEIPT_LIMIT'):decode_receipt(canonical(r),job())
        good=canonical(v3())
        with self.assertRaisesRegex(ValueError,'RECEIPT_LIMIT'):decode_receipt(good+b' '*(131073-len(good)),job())

    def test_duplicate_keys_and_nonfinite_numbers_fail(self):
        raw=canonical(v3())
        with self.assertRaisesRegex(ValueError,'DUPLICATE_KEY'):decode_receipt(raw.replace(b'"checks":3',b'"checks":3,"checks":3'),job())
        for token in (b'NaN',b'Infinity',b'-Infinity'):
            with self.assertRaises(ValueError):decode_receipt(raw.replace(b'"worst_absolute":0.0',b'"worst_absolute":'+token),job())

    def test_seed_source_token_and_run_binding(self):
        r=v3();r['selection']=dict(sampled_receipt()['selection'],seed_source='run-id',seed=hashlib.sha256(job()['run_id'].encode('ascii')).hexdigest())
        decode_receipt(canonical(r),job())
        for key,value in [('seed_source','unknown'),('seed','0'*64)]:
            bad=copy.deepcopy(r);bad['selection'][key]=value
            with self.assertRaises(ValueError):decode_receipt(canonical(bad),job())
        for seed in (r['selection']['seed'], '0'*64):
            r['selection'].update(seed_source='config',seed=seed)
            with self.assertRaisesRegex(ValueError,'SEED_BINDING'):decode_receipt(canonical(r),job())

    def test_job_pinned_seed_and_receipt_must_agree(self):
        j=job();j['representative_selection']={'seed_source':'config','seed':'1'*64}
        self.assertEqual(validate_job(j),j);self.assertEqual(decode_job(canonical(j)),j)
        r=v3();r['job_sha256']=sha(j);r['selection']=dict(sampled_receipt()['selection'],seed_source='config',seed='1'*64)
        decode_receipt(canonical(r),j)
        bad=copy.deepcopy(r);bad['selection'].update(seed_source='run-id',seed=hashlib.sha256(j['run_id'].encode('ascii')).hexdigest())
        with self.assertRaisesRegex(ValueError,'SEED_BINDING'):decode_receipt(canonical(bad),j)
        r['selection']['seed']='2'*64
        with self.assertRaisesRegex(ValueError,'SEED_BINDING'):decode_receipt(canonical(r),j)
        for block in ({},{'seed_source':'unknown','seed':'1'*64},{'seed_source':'run-id','seed':'1'*64},{'seed_source':'config','seed':True},{'seed_source':'config','seed':'1'*64,'private':1}):
            with self.assertRaises(ValueError):validate_job(dict(j,representative_selection=block))

    def test_worker_loads_v3_and_rejects_forgery(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'receipt.json';r=v3(True);p.write_bytes(canonical(r))
            self.assertEqual(worker.load_receipt(p,job()),r)
            r['entries'][0]['diagnostics'][0]['value']='PRIVATE';p.write_bytes(canonical(r))
            with self.assertRaises(ValueError):worker.load_receipt(p,job())

    def test_worker_selection_mount_is_read_only_and_separate_from_control(self):
        import ast
        tree=ast.parse(Path(worker.__file__).read_text())
        calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='sandbox']
        reader=next(n for n in calls if isinstance(n.args[1],ast.Constant) and n.args[1].value=='reader')
        mounts=[tuple(ast.unparse(v) for v in n.elts) for n in reader.args[2].elts]
        self.assertIn(('selection_context',"'/selection'","'ro'"),mounts)
        self.assertFalse(any("'/job'" in row for row in mounts))
        assignment=next(n for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='producer_mounts' for t in n.targets))
        mounts=[tuple(ast.unparse(v) for v in n.elts) for n in assignment.value.elts]
        self.assertIn(('selection_context',"'/selection'","'ro'"),mounts)
        self.assertFalse(any("'/job'" in row for row in mounts))
