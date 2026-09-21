"""Public-fixture S3 transport controls. Cloud calls are replaced by local fakes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('results',Path(__file__).resolve().parents[1]/'p022_results.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
ARN='arn:aws:ec2:us-east-1:000000000000:instance/i-0123456789abcdef0'
TOKEN='1'*32

class Results(unittest.TestCase):
    def receipt(self,raw=b'ok',code=0):
        return dict(schema=r.SCHEMA,instance=ARN,token=TOKEN,label='fixture',exit_code=code,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())

    def test_roundtrip_and_failure(self):
        for code in (0,7,124):
            objects={}
            with self.subTest(code=code), patch.object(r,'put',side_effect=lambda b,k,p:objects.update({k:p.read_bytes()})):
                r.worker(['public-results',ARN,TOKEN,'fixture',10,f'printf ok; printf private-error >&2; exit {code}'])
                prefix=f'campaigns/{ARN}/{TOKEN}/'
                self.assertEqual(objects[prefix+'stdout'],b'ok')
                self.assertEqual(r.validate(json.loads(objects[prefix+'receipt.json']),b'ok',ARN,TOKEN,'fixture'),code)

    def test_receipt_controls(self):
        for key,value in [('instance',ARN+'other'),('token','2'*32),('label','other'),('bytes',True),('exit_code',True),('exit_code',-1),('schema','other'),('sha256','0'*64),('extra',1)]:
            with self.subTest(key=key):
                rec=self.receipt();rec[key]=value
                with self.assertRaisesRegex(ValueError,'RESULT_RECEIPT'):r.validate(rec,b'ok',ARN,TOKEN,'fixture')
        with self.assertRaises(ValueError):r.validate(self.receipt(),b'oK',ARN,TOKEN,'fixture')

    def test_timeout_is_failure_receipt(self):
        objects={}
        with patch.object(r,'put',side_effect=lambda b,k,p:objects.update({k:p.read_bytes()})):
            r.worker(['public-results',ARN,TOKEN,'fixture',1,'sleep 10'])
        self.assertEqual(json.loads(objects[f'campaigns/{ARN}/{TOKEN}/receipt.json'])['exit_code'],124)

    def test_output_over_limit_never_receipts(self):
        with patch.object(r,'MAX_OUTPUT',64),patch.object(r,'put') as put:
            with self.assertRaisesRegex(ValueError,'RESULT_LIMIT'):
                r.worker(['public-results',ARN,TOKEN,'fixture',10,"python3 -c 'print(\"x\"*200)' "])
            put.assert_not_called()

    def test_delivery_failure_never_receipts(self):
        with patch.object(r,'put',side_effect=ValueError('RESULT_DELIVERY_FAILED')) as put:
            with self.assertRaisesRegex(ValueError,'DELIVERY'):
                r.worker(['public-results',ARN,TOKEN,'fixture',10,'printf ok'])
            self.assertEqual(put.call_count,1)

    def test_upload_is_create_only_encrypted(self):
        with patch.object(r,'aws',return_value=subprocess.CompletedProcess([],0)) as aws:
            r.put('public-results','campaigns/key',Path('/unused'))
            args=aws.call_args.args
            self.assertEqual(args[args.index('--if-none-match')+1],'*')
            self.assertEqual(args[args.index('--server-side-encryption')+1],'AES256')

    def test_get_checks_size_before_download(self):
        for size in (4097,True,-1):
            with patch.object(r,'aws',return_value=subprocess.CompletedProcess([],0,json.dumps({'ContentLength':size}).encode())) as aws:
                with self.assertRaisesRegex(ValueError,'RESULT_LIMIT'):r.get('public-results','key',Path('/unused'),4096)
                self.assertEqual(aws.call_count,1)

    def test_collect_uses_only_send_and_s3(self):
        with tempfile.TemporaryDirectory() as d:
            def get(bucket,key,path,limit):
                path.write_bytes(json.dumps(self.receipt()).encode() if key.endswith('receipt.json') else b'ok')
                self.assertTrue(key.startswith(f'campaigns/{ARN}/{TOKEN}/'))
                return True
            with patch.dict(os.environ,{'CERTIFY_RESULTS_BUCKET':'public-results','INSTANCE_ARN':ARN}),patch.object(r.uuid,'uuid4') as uid,patch.object(r,'get',side_effect=get),patch.object(r,'aws',return_value=subprocess.CompletedProcess([],0,b'{}')) as aws:
                uid.return_value.hex=TOKEN
                self.assertEqual(r.collect('fixture','printf ok',str(Path(d)/'result')),0)
                self.assertEqual(aws.call_args.args[:2],('ssm','send-command'))
                self.assertEqual(aws.call_count,1)

    def test_missing_receipt_is_not_success(self):
        with patch.dict(os.environ,{'CERTIFY_RESULTS_BUCKET':'public-results','INSTANCE_ARN':ARN}),patch.object(r,'aws',return_value=subprocess.CompletedProcess([],0,b'{}')),patch.object(r.time,'monotonic',side_effect=[0,99999]):
            with self.assertRaisesRegex(ValueError,'RESULT_DEADLINE'):r.collect('fixture','true','unused')

    def test_invalid_input(self):
        for index,bad in [(0,'bad/bucket'),(1,ARN+'/../other'),(2,'../'),(3,'$(unsafe)'),(4,0)]:
            fields=['public-results',ARN,TOKEN,'fixture',10];fields[index]=bad
            with self.assertRaisesRegex(ValueError,'TRANSPORT_INPUT'):r.admit(*fields)
