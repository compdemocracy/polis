"""Actual public-descriptor capture and closed export regression controls."""
import copy
import io
import json
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from contracts import validate_job, public_result
from receipt import sha, validate_receipt
import dispatch
import worker
from dns import question


def job():
    return validate_job(dict(schema='polis-probe-job/1',run_id='a'*32,max_seconds=3600,
        producer={'image':'localhost/producer@sha256:'+'1'*64,'args':['produce']},
        verifier={'image':'localhost/verifier@sha256:'+'2'*64,'args':['verify']}))


def receipt():
    j=job()
    return dict(schema='polis-probe-receipt/1',run_id=j['run_id'],job_sha256=sha(j),verdict='PASS',
        entries=[dict(verdict='PASS',checks=3,worst_absolute=0.0,worst_relative=0.0,outliers=0,nonfinite=0)],
        controls={'passed':21,'expected':21},selection=None,
        digests=dict(producer='1'*64,verifier='2'*64,inputs='3'*64,recordings='4'*64,policy='5'*64))


def sampled_receipt():
    r=receipt();r['schema']='polis-probe-receipt/2'
    r['selection']={'seed':'01'*32,'bucket_counts':{
        'population':1,'target':20,'selected':1,'shortfall':19,'occupied':1,'covered':1,'uncovered':0,
        'cells':[dict(p_bin=p,v_bin=v,population=int(p==v==1),selected=int(p==v==1))
                 for p in range(2) for v in range(2)]},
        'chosen_entry_sizes':[dict(P=3,V=7,C=2,U=6,matrix_area=6,registered_participants=4,all_comments=2,p_bin=1,v_bin=1)]}
    return r


class BoundaryTests(unittest.TestCase):
    def test_v2_receipt_retains_full_hex_seed_and_numeric_report(self):
        r=sampled_receipt()
        self.assertEqual(validate_receipt(r,job()),r)

    def test_v2_selection_census_tamper_and_private_fields_refuse(self):
        for mutation in ['missing','extra','seed','count','cell','size','order','old-version']:
            with self.subTest(mutation=mutation):
                r=sampled_receipt();s=r['selection']
                if mutation=='missing':r['selection']=None
                elif mutation=='extra':s['chosen_entry_sizes'][0]['path']='public-fixture private value'
                elif mutation=='seed':s['seed']=42
                elif mutation=='count':s['bucket_counts']['population']=True
                elif mutation=='cell':s['bucket_counts']['cells'].pop()
                elif mutation=='size':s['chosen_entry_sizes'][0]['V']=0
                elif mutation=='order':s['bucket_counts']['cells'].reverse()
                elif mutation=='old-version':r['schema']='polis-probe-receipt/1'
                with self.assertRaises(ValueError):validate_receipt(r,job())

    def test_valid_receipt_and_numeric_selection(self):
        r=receipt();r['selection']={'seed':42,'bucket_counts':[[0,1,20]],'selected_sizes':[[3,8]]}
        self.assertEqual(validate_receipt(r,job()),r)

    def test_rows_ids_paths_logs_and_blobs_cannot_be_exported(self):
        for key in ['rows','zid','pid','tid','recording','log','path','blob']:
            for location in ['root','entry','selection','digests']:
                with self.subTest(key=key,location=location):
                    r=receipt();node={'root':r,'entry':r['entries'][0],'digests':r['digests'],'selection':r}[location]
                    node[key]='public-fixture private value'
                    with self.assertRaises(ValueError):validate_receipt(r,job())

    def test_false_pass_nonfinite_boolean_or_negative_rejected(self):
        for key,value in [('checks',0),('checks',True),('outliers',1),('nonfinite',1),('worst_absolute',float('nan')),('worst_relative',-1)]:
            with self.subTest(key=key,value=value):
                r=receipt();r['entries'][0][key]=value
                with self.assertRaises(ValueError):validate_receipt(r,job())
        for field in ['run_id','job_sha256']:
            r=receipt();r[field]='0'*64
            with self.assertRaises(ValueError):validate_receipt(r,job())

    def test_missing_controls_and_image_substitution_rejected(self):
        r=receipt();r['controls']['passed']=20
        with self.assertRaises(ValueError):validate_receipt(r,job())
        r=receipt();r['digests']['producer']='9'*64
        with self.assertRaises(ValueError):validate_receipt(r,job())

    def test_actual_native_stdout_stderr_and_extra_lines_are_captured(self):
        actual_run=subprocess.run
        for stream in [None,1,2]:
            with self.subTest(stream=stream):
                code="import os;os.write(1,b'PASS\\n')"
                if stream:code+=f";os.write({stream},b'public-fixture-private-value\\n')"
                def run(*args,**kw):return actual_run([sys.executable,'-c',code],**kw)
                out=SimpleNamespace(buffer=io.BytesIO())
                with patch.object(dispatch.subprocess,'run',run),patch.object(dispatch.sys,'stdout',out):
                    rc=dispatch.main()
                raw=out.buffer.getvalue()
                self.assertNotIn(b'private',raw)
                self.assertEqual(rc,0 if stream is None else 1)
                self.assertEqual(raw.splitlines()[1],b'PASS' if stream is None else b'FAIL')
                self.assertEqual(len(raw.splitlines()),2)

    def test_container_runtime_state_is_on_disposable_disk(self):
        p=worker.podman()
        self.assertEqual(p,['podman','--root','/probe-work/container-store','--runroot','/probe-work/container-run'])

    def test_dns_refuses_unknown_shapes_and_encoded_payload(self):
        header=b'\x00\x01\x01\x00\x00\x01'+b'\x00'*6
        q=header+b'\x07example\x03com\x00\x00\x01\x00\x01'
        self.assertEqual(question(q),'example.com')
        for raw in [b'',q+b'payload',header+b'\xc0\x0c\x00\x01\x00\x01']:
            with self.assertRaises((ValueError,IndexError)):question(raw)
