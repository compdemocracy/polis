"""Offline fault injection: no boto3 construction, credentials or network."""
import copy
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from controller import Control, Unknown, encoded, sha


class ApiError(Exception):
    def __init__(self, code):
        self.response = {'Error': {'Code': code}}


class Pages:
    def __init__(self, call): self.call = call
    def paginate(self, **kwargs): return iter(self.call(**kwargs))


class S3:
    def __init__(self):
        self.objects, self.versions, self.uploads = {}, [], []
        self.deleted, self.aborted, self.puts = [], [], []
        self.leave_versions = False
    def get_object(self, Bucket, Key, VersionId=None):
        if (Bucket, Key) not in self.objects: raise ApiError('NoSuchKey')
        return {'Body': io.BytesIO(self.objects[Bucket, Key]), 'VersionId': VersionId or 'v1'}
    def put_object(self, **kw):
        k = kw['Bucket'], kw['Key']
        if kw.get('IfNoneMatch') == '*' and k in self.objects: raise ApiError('PreconditionFailed')
        self.objects[k] = kw['Body']
        self.puts.append(kw)
        return {'VersionId': 'v1'}
    def head_object(self, **kw): raise ApiError('404')
    def get_paginator(self, name):
        if name == 'list_object_versions': return Pages(lambda **kw: [{'Versions': list(self.versions)}])
        if name == 'list_multipart_uploads': return Pages(lambda **kw: [{'Uploads': list(self.uploads)}])
        raise AssertionError(name)
    def delete_object(self, **kw):
        self.deleted.append(kw)
        if not self.leave_versions: self.versions = [v for v in self.versions if v['VersionId'] != kw['VersionId']]
    def abort_multipart_upload(self, **kw):
        self.aborted.append(kw)
        self.uploads = [u for u in self.uploads if u['UploadId'] != kw['UploadId']]


class EC2:
    def __init__(self):
        self.instances, self.disks, self.runs, self.terminated, self.deleted = [], [], [], [], []
        self.run_fails = False
    def get_paginator(self, name):
        if name == 'describe_instances': return Pages(lambda **kw: [{'Reservations': [{'Instances': self.instances}]}])
        if name == 'describe_volumes': return Pages(lambda **kw: [{'Volumes': self.disks}])
        raise AssertionError(name)
    def describe_images(self, **kw):
        return {'Images': [{'Architecture': 'arm64', 'State': 'available', 'OwnerId': '111111111111'}]}
    def run_instances(self, **kw):
        self.runs.append(kw)
        if self.run_fails: raise ApiError('RequestTimeout')
        return {'Instances': self.instances}
    def terminate_instances(self, **kw): self.terminated += kw['InstanceIds']
    def delete_volume(self, **kw): self.deleted.append(kw['VolumeId'])
    def describe_volumes(self, VolumeIds):
        found = [d for d in self.disks if d['VolumeId'] in VolumeIds]
        if not found: raise ApiError('InvalidVolume.NotFound')
        return {'Volumes': found}


def admission():
    return {'id': 'a'*32, 'account': '111111111111', 'region': 'us-east-1', 'ami': 'ami-'+'1'*17,
            'launch': {'TEMPLATE':'lt-test','TEMPLATE_VERSION':'1','PROFILE':'profile','SUBNET':'subnet','SECURITY_GROUP':'sg'},
            'stagingExpiresAt': '2030-01-01T09:00:00Z', 'expiresAt': '2030-01-01T12:00:00Z', 'inventorySha256': 'a'*64,
            'scheduleSha256': 'b'*64, 'policySha256': 'c'*64, 'expectedChecks': 3,
            'candidateSha': 'd'*40, 'verifierImage': 'localhost/polis-verifier@sha256:'+'e'*64}


def setup(now=1893492000):  # 2030-01-01 10:00 UTC
    a = admission()
    cfg = {'ADMISSION': encoded(a).decode(), 'ADMISSION_SHA256': sha(a), 'CONTROL_BUCKET': 'control',
           'BOX_ID':'test-box','ASSET_BUCKET':'assets','SECRET_ARN':'secret','REPLICA_HOST':'replica.invalid','DATABASE':'test','SECRETS_URL':'https://secrets.invalid', 'EVIDENCE_BUCKET': 'evidence', 'CONTROL_KEY': 'key', 'TEMPLATE': 'lt-test',
           'TEMPLATE_VERSION': '1', 'PROFILE': 'profile', 'SUBNET': 'subnet', 'SECURITY_GROUP': 'sg', 'ENDPOINT': 'vpce'}
    e, s = EC2(), S3()
    c = Control(e, s, cfg, now)
    i = {'InstanceId': 'i-test', 'ClientToken': c.token,
         'IamInstanceProfile': {'Arn': 'profile'}, 'ImageId': a['ami'], 'SubnetId': 'subnet', 'InstanceType': 'r8g.4xlarge',
         'Tags': [{'Key': 'polis:probe-run', 'Value': a['id']}], 'SecurityGroups': [{'GroupId': 'sg'}],
         'State': {'Name': 'running'}, 'BlockDeviceMappings': [{'Ebs': {'VolumeId': v}} for v in ('vol-a', 'vol-b')]}
    e.instances = [i]
    return c, e, s, i


class ControlTests(unittest.TestCase):
    def test_launch_fixed_template_and_token_only(self):
        c, e, s, i = setup()
        self.assertEqual(c.launch()['status'], 'RUNNING')
        self.assertEqual(set(e.runs[0]), {'LaunchTemplate', 'MinCount', 'MaxCount', 'ClientToken','TagSpecifications'})
        self.assertEqual(e.runs[0]['LaunchTemplate'], {'LaunchTemplateId': 'lt-test', 'Version': '1'})
        self.assertIsNotNone(c.read('boot/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json'))
    def test_duplicate_launch_does_not_launch_again(self):
        c, e, s, i = setup(); c.launch(); c.launch()
        self.assertEqual(len(e.runs), 1)
    def test_lost_ack_reconciles_by_client_token(self):
        c, e, s, i = setup(); e.run_fails = True
        with self.assertRaises(ApiError): c.launch()
        self.assertEqual(c.launch()['status'], 'RUNNING'); self.assertEqual(len(e.runs), 1)
    def test_lost_ack_blank_describe_is_unknown(self):
        c, e, s, i = setup(); e.instances = []; e.run_fails = True
        with self.assertRaises(ApiError): c.launch()
        with self.assertRaisesRegex(Unknown, 'LAUNCH_ACK_UNKNOWN'): c.launch()
        self.assertEqual(len(e.runs), 1)
    def test_tag_alone_never_authorizes_mutation(self):
        for change in ({'ClientToken': 'forged'}, {'IamInstanceProfile': {'Arn': 'prod'}}, {'ImageId': 'prod'}, {'SubnetId': 'prod'},
                       {'PublicIpAddress': '1.2.3.4'}, {'SecurityGroups': [{'GroupId': 'prod'}]}):
            c, e, s, i = setup(); c.launch(); i.update(change)
            with self.subTest(change=change), self.assertRaisesRegex(Unknown, 'OWNERSHIP'): c.reconcile(cancel=True)
            self.assertEqual(e.terminated, [])
    def test_terminate_ack_is_not_clean(self):
        c, e, s, i = setup(); c.launch()
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile(cancel=True)
        self.assertEqual(e.terminated, ['i-test']); self.assertIsNone(c.read(c.prefix + 'clean.json'))
    def test_terminated_disks_observed_absent_are_clean(self):
        c, e, s, i = setup(); c.launch(); i['State']['Name']='terminated'
        self.assertEqual(c.reconcile()['status'],'CLEAN')
        self.assertFalse(s.deleted); self.assertFalse(s.aborted)
        with self.assertRaisesRegex(Unknown,'RUN_CLOSED'): c.launch()
    def test_disk_delete_ack_is_not_clean(self):
        c, e, s, i = setup(); c.launch(); i['State']['Name'] = 'terminated'
        e.disks = [{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []}]
        with self.assertRaisesRegex(Unknown, 'DISK_REMAINS'): c.reconcile()
        self.assertEqual(e.deleted, ['vol-a']); self.assertIsNone(c.read(c.prefix + 'clean.json'))
    def test_unknown_tagged_disk_never_deleted(self):
        c, e, s, i = setup(); c.launch(); i['State']['Name'] = 'terminated'
        e.disks = [{'VolumeId': 'vol-prod', 'State': 'available', 'Attachments': []}]
        with self.assertRaisesRegex(Unknown, 'UNKNOWN_DISK'): c.reconcile()
        self.assertFalse(e.deleted)
    def test_failed_disk_describe_is_unknown(self):
        c, e, s, i = setup(); c.launch(); i['State']['Name'] = 'terminated'
        e.describe_volumes = lambda **kw: (_ for _ in ()).throw(ApiError('UnauthorizedOperation'))
        with self.assertRaisesRegex(Unknown, 'DISK_DESCRIBE_UNKNOWN'): c.reconcile()
    def test_empty_disk_describe_is_unknown(self):
        c, e, s, i = setup(); c.launch(); i['State']['Name'] = 'terminated'
        e.describe_volumes = lambda **kw: {'Volumes': []}
        with self.assertRaisesRegex(Unknown, 'DISK_DESCRIBE_EMPTY'): c.reconcile()
    def test_missing_heartbeat_terminates_after_grace(self):
        c, e, s, i = setup(); c.launch(); c.now += 601
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile()
        self.assertEqual(e.terminated, ['i-test'])
    def test_no_launch_ever_clean_on_expiry(self):
        c, e, s, i = setup(); c.now += 9000
        self.assertEqual(c.reconcile()['status'], 'CLEAN'); self.assertFalse(e.runs)
    def test_campaign_over_twelve_hours_denied(self):
        c, e, s, i = setup()
        c.expiry = c.now + 12 * 3600 + 1
        with self.assertRaisesRegex(Unknown, 'OVER_BUDGET'): c.launch()
        self.assertFalse(e.runs)
    def test_expired_launch_denied(self):
        c, e, s, i = setup(); c.now = c.expiry
        with self.assertRaisesRegex(Unknown, 'EXPIRED'): c.launch()
        self.assertFalse(e.runs)
    def test_control_record_cannot_be_replaced(self):
        c, e, s, i = setup(); c.record('test', {'a': 1}); c.record('test', {'a': 1})
        with self.assertRaisesRegex(Unknown, 'RECORD_CONFLICT'): c.record('test', {'a': 2})
    def test_failed_control_read_is_not_absence(self):
        c, e, s, i = setup()
        s.get_object = lambda **kw: (_ for _ in ()).throw(ApiError('AccessDenied'))
        with self.assertRaisesRegex(Unknown, 'CONTROL_READ_UNKNOWN'): c.launch()
        self.assertFalse(e.runs)
    def test_duplicate_instance_blocks(self):
        c, e, s, i = setup(); c.launch(); e.instances.append(copy.deepcopy(i))
        with self.assertRaisesRegex(Unknown, 'OWNERSHIP'): c.reconcile(cancel=True)
        self.assertFalse(e.terminated)

    def test_template_configuration_cannot_change_under_active_admission(self):
        c,e,s,i=setup()
        for key in ('TEMPLATE','TEMPLATE_VERSION','PROFILE','SUBNET','SECURITY_GROUP'):
            with self.subTest(key=key),self.assertRaisesRegex(Unknown,'CONFIGURATION_CHANGED'):
                Control(e,s,{**c.c,key:'changed'},c.now)
        self.assertFalse(e.runs)

class HandlerTests(unittest.TestCase):
    def test_public_reply_only_after_actual_cleanup_and_receipt(self):
        import sys
        from types import SimpleNamespace
        import controller
        from test_boundaries import job,receipt
        c,e,s,i=setup()
        cfg={**c.c,'AMI':c.a['ami'],'ACCOUNT':c.a['account'],'REGION':c.a['region']}
        original=e.run_instances
        def launch(**kw):
            i['ClientToken']=kw['ClientToken']
            return original(**kw)
        e.run_instances=launch
        sdk=SimpleNamespace(client=lambda name:s if name=='s3' else e)
        with patch.dict(sys.modules,{'boto3':sdk}),patch.dict(controller.os.environ,cfg,clear=True),patch.object(controller.time,'time',return_value=c.now):
            self.assertEqual(controller.handler({'action':'launch','job':job()},None),{'run_id':'a'*32,'complete':False,'passed':False})
            i['State']['Name']='terminated'
            # A clean failed run terminates the public polling loop honestly.
            self.assertEqual(controller.handler({'action':'status','run_id':'a'*32},None),{'run_id':'a'*32,'complete':True,'passed':False})
            key='results/arn:aws:ec2:us-east-1:111111111111:instance/i-test/receipt.json'
            s.objects['evidence',key]=encoded(receipt())
            self.assertEqual(controller.handler({'action':'status','run_id':'a'*32},None),{'run_id':'a'*32,'complete':True,'passed':True})
            bad=receipt();bad['rows']=[{'synthetic':1}];s.objects['evidence',key]=encoded(bad)
            self.assertFalse(controller.handler({'action':'status','run_id':'a'*32},None)['passed'])
