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

from run import Control, Session, Unknown, encoded, sha


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
        return {'Body': io.BytesIO(self.objects[Bucket, Key]), 'ETag': hashlib.sha256(self.objects[Bucket,Key]).hexdigest(), 'VersionId': VersionId or 'v1'}
    def put_object(self, **kw):
        k = kw['Bucket'], kw['Key']
        if kw.get('IfNoneMatch') == '*' and k in self.objects: raise ApiError('PreconditionFailed')
        if 'IfMatch' in kw and (k not in self.objects or hashlib.sha256(self.objects[k]).hexdigest() != kw['IfMatch']): raise ApiError('PreconditionFailed')
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
    return {'started':1893492000, 'id': 'a'*32, 'account': '111111111111', 'region': 'us-east-1', 'ami': 'ami-'+'1'*17,
            'launch': {'TEMPLATE':'lt-test','TEMPLATE_VERSION':'1','PROFILE':'profile','SUBNET':'subnet','SECURITY_GROUP':'sg'},
            'stagingExpiresAt': '2030-01-01T09:00:00Z', 'expiresAt': '2030-01-01T12:00:00Z', 'inventorySha256': 'a'*64,
            'scheduleSha256': 'b'*64, 'policySha256': 'c'*64, 'expectedChecks': 3,
            'candidateSha': 'd'*40, 'verifierImage': 'localhost/polis-verifier@sha256:'+'e'*64}


def setup(now=1893492000):  # 2030-01-01 10:00 UTC
    a = admission()
    cfg = {'ADMISSION': encoded(a).decode(), 'ADMISSION_SHA256': sha(a), 'CONTROL_BUCKET': 'control',
           'MODE':'worker','INSTANCE_TYPE':'r8g.4xlarge','AMI':a['ami'],'ACCOUNT':a['account'],'REGION':a['region'],'BOX_ID':'test-box','ASSET_BUCKET':'assets','SECRET_ARN':'secret','REPLICA_HOST':'replica.invalid','DATABASE':'test','SECRETS_URL':'https://secrets.invalid', 'EVIDENCE_BUCKET': 'evidence', 'CONTROL_KEY': 'key', 'TEMPLATE': 'lt-test',
           'TEMPLATE_VERSION': '1', 'PROFILE': 'profile', 'SUBNET': 'subnet', 'SECURITY_GROUP': 'sg', 'ENDPOINT': 'vpce'}
    e, s = EC2(), S3()
    c = Control(e, s, cfg, now)
    i = {'InstanceId': 'i-test', 'ClientToken': c.token,
         'IamInstanceProfile': {'Arn': 'profile'}, 'ImageId': a['ami'], 'SubnetId': 'subnet', 'InstanceType': 'r8g.4xlarge',
         'Tags': [{'Key': 'polis:probe-run', 'Value': a['id']},{'Key':'polis:probe-box','Value':'test-box'}], 'SecurityGroups': [{'GroupId': 'sg'}],
         'State': {'Name': 'running'}, 'BlockDeviceMappings': [{'Ebs': {'VolumeId': v}} for v in ('vol-a', 'vol-b')]}
    e.instances = [i]
    return c, e, s, i


class ControlTests(unittest.TestCase):
    def test_launch_fixed_template_and_token_only(self):
        c, e, s, i = setup()
        self.assertEqual(c.launch_once()['status'], 'RUNNING')
        self.assertEqual(set(e.runs[0]), {'LaunchTemplate', 'MinCount', 'MaxCount', 'ClientToken','TagSpecifications'})
        self.assertEqual(e.runs[0]['LaunchTemplate'], {'LaunchTemplateId': 'lt-test', 'Version': '1'})
        self.assertIsNotNone(c.read('boot/worker/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json'))
    def test_tag_alone_never_authorizes_mutation(self):
        for change in ({'ClientToken': 'forged'}, {'IamInstanceProfile': {'Arn': 'prod'}}, {'ImageId': 'prod'}, {'SubnetId': 'prod'},
                       {'PublicIpAddress': '1.2.3.4'}, {'SecurityGroups': [{'GroupId': 'prod'}]}):
            c, e, s, i = setup(); c.launch_once(); i.update(change)
            with self.subTest(change=change), self.assertRaisesRegex(Unknown, 'OWNERSHIP'): c.reconcile(cancel=True)
            self.assertEqual(e.terminated, [])
    def test_terminate_ack_is_not_clean(self):
        c, e, s, i = setup(); c.launch_once()
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile(cancel=True)
        self.assertEqual(e.terminated, ['i-test']); self.assertIsNone(c.read(c.prefix + 'clean.json'))
    def test_terminated_disks_observed_absent_are_clean(self):
        c, e, s, i = setup(); c.launch_once(); i['State']['Name']='terminated'
        self.assertEqual(c.reconcile()['status'],'CLEAN')
        self.assertFalse(s.deleted); self.assertFalse(s.aborted)
        with self.assertRaisesRegex(Unknown,'RUN_CLOSED'): c.launch_once()
    def test_disk_delete_ack_is_not_clean(self):
        c, e, s, i = setup(); c.launch_once(); i['State']['Name'] = 'terminated'
        e.disks = [{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []}]
        with self.assertRaisesRegex(Unknown, 'DISK_REMAINS'): c.reconcile()
        self.assertEqual(e.deleted, ['vol-a']); self.assertIsNone(c.read(c.prefix + 'clean.json'))
    def test_unknown_tagged_disk_never_deleted(self):
        c, e, s, i = setup(); c.launch_once(); i['State']['Name'] = 'terminated'
        e.disks = [{'VolumeId': 'vol-prod', 'State': 'available', 'Attachments': []}]
        with self.assertRaisesRegex(Unknown, 'UNKNOWN_DISK'): c.reconcile()
        self.assertFalse(e.deleted)
    def test_failed_disk_describe_is_unknown(self):
        c, e, s, i = setup(); c.launch_once(); i['State']['Name'] = 'terminated'
        e.describe_volumes = lambda **kw: (_ for _ in ()).throw(ApiError('UnauthorizedOperation'))
        with self.assertRaisesRegex(Unknown, 'DISK_DESCRIBE_UNKNOWN'): c.reconcile()
    def test_empty_disk_describe_is_unknown(self):
        c, e, s, i = setup(); c.launch_once(); i['State']['Name'] = 'terminated'
        e.describe_volumes = lambda **kw: {'Volumes': []}
        with self.assertRaisesRegex(Unknown, 'DISK_DESCRIBE_EMPTY'): c.reconcile()
    def test_missing_heartbeat_terminates_after_grace(self):
        c, e, s, i = setup(); c.launch_once(); c.now += 601
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile()
        self.assertEqual(e.terminated, ['i-test'])
    def test_intent_without_claim_cannot_be_declared_clean(self):
        c,e,s,i=setup();c.now+=9000
        with self.assertRaisesRegex(Unknown,'LAUNCH_ACK_UNKNOWN'):c.reconcile(cancel=True)
        self.assertFalse(e.runs)
    def test_campaign_over_twelve_hours_denied(self):
        c, e, s, i = setup()
        c.expiry = c.now + 12 * 3600 + 1
        with self.assertRaisesRegex(Unknown, 'OVER_BUDGET'): c.launch_once()
        self.assertFalse(e.runs)
    def test_expired_launch_denied(self):
        c, e, s, i = setup(); c.now = c.expiry
        with self.assertRaisesRegex(Unknown, 'EXPIRED'): c.launch_once()
        self.assertFalse(e.runs)
    def test_control_record_cannot_be_replaced(self):
        c, e, s, i = setup(); c.record('test', {'a': 1}); c.record('test', {'a': 1})
        with self.assertRaisesRegex(Unknown, 'RECORD_CONFLICT'): c.record('test', {'a': 2})
    def test_failed_control_read_is_not_absence(self):
        c, e, s, i = setup()
        s.get_object = lambda **kw: (_ for _ in ()).throw(ApiError('AccessDenied'))
        with self.assertRaisesRegex(Unknown, 'CONTROL_READ_UNKNOWN'): c.launch_once()
        self.assertFalse(e.runs)
    def test_duplicate_instance_blocks(self):
        c, e, s, i = setup(); c.launch_once(); e.instances.append(copy.deepcopy(i))
        with self.assertRaisesRegex(Unknown, 'OWNERSHIP'): c.reconcile(cancel=True)
        self.assertFalse(e.terminated)

    def test_template_configuration_cannot_change_under_active_admission(self):
        c,e,s,i=setup()
        for key in ('TEMPLATE','TEMPLATE_VERSION','PROFILE','SUBNET','SECURITY_GROUP'):
            with self.subTest(key=key),self.assertRaisesRegex(Unknown,'CONFIGURATION_CHANGED'):
                Control(e,s,{**c.c,key:'changed'},c.now)
        self.assertFalse(e.runs)



def session_setup():
    c,e,s,i=setup()
    cfg={k:v for k,v in c.c.items() if not k.startswith('ADMISSION')}
    cfg['NOTIFICATION_TOPIC']='arn:aws:sns:us-east-1:111111111111:test'
    session=Session(e,s,cfg,clock=lambda:c.now)
    original=e.run_instances
    def launch(**kw):
        i['ClientToken']=kw['ClientToken']
        i['Tags']=kw['TagSpecifications'][0]['Tags']
        return original(**kw)
    e.run_instances=launch
    return session,c,e,s,i


class SessionTests(unittest.TestCase):
    def test_only_one_launch_on_resumed_same_job(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup()
        self.assertFalse(x.start(job())['complete'])
        self.assertFalse(x.start(job())['complete'])
        self.assertEqual(len(e.runs),1)
        mutations=[v for v in s.puts if v['Key']=='active.json']
        self.assertIn('IfNoneMatch',mutations[0]);self.assertIn('IfMatch',mutations[1])
        self.assertEqual([json.loads(v['Body'])['phase'] for v in mutations],['RESERVED','INTENT'])

    def test_lost_launch_ack_reconciles_without_second_attempt(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();e.run_fails=True
        with self.assertRaises(ApiError):x.start(job())
        self.assertFalse(x.start(job())['complete'])
        self.assertEqual(len(e.runs),1)

    def test_lost_launch_with_empty_discovery_cannot_cancel_or_release(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();e.instances=[];e.run_fails=True
        with self.assertRaises(ApiError):x.start(job())
        for cancel in (False,True):
            with self.assertRaisesRegex(Unknown,'LAUNCH_ACK_UNKNOWN'):x.status(job()['run_id'],cancel=cancel)
        c.now+=100000
        with self.assertRaisesRegex(Unknown,'LAUNCH_ACK_UNKNOWN'):x.start(job())
        other=job();other['run_id']='b'*32
        with self.assertRaisesRegex(Unknown,'PREVIOUS_RUN_NOT_CLEAN'):x.start(other)
        self.assertEqual(len(e.runs),1)

    def test_two_different_runs_contend_for_global_register(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();put=s.put_object;fired=False
        second=job();second['run_id']='b'*32
        def race(**kw):
            nonlocal fired
            if kw['Key']=='active.json' and not fired:
                fired=True;x.start(second)
            return put(**kw)
        s.put_object=race
        with self.assertRaisesRegex(Unknown,'ACTIVE_CONFLICT'):x.start(job())
        self.assertEqual(len(e.runs),1)
        self.assertEqual(x.active()[0]['admission']['id'],second['run_id'])

    def test_lost_s3_ack_resolves_only_exact_nonce(self):
        from test_boundaries import job
        for phase in ('RESERVED','INTENT'):
            with self.subTest(phase=phase):
                x,c,e,s,i=session_setup();put=s.put_object
                def lost(**kw):
                    result=put(**kw)
                    if kw['Key']=='active.json' and json.loads(kw['Body'])['phase']==phase:raise ApiError('Timeout')
                    return result
                s.put_object=lost
                self.assertFalse(x.start(job())['complete']);self.assertEqual(len(e.runs),1)

    def test_cancel_reserved_fences_stale_launcher(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();put=s.put_object
        def race(**kw):
            if kw['Key']=='active.json' and json.loads(kw['Body'])['phase']=='INTENT':
                self.assertTrue(x.status(job()['run_id'],cancel=True)['complete'])
            return put(**kw)
        s.put_object=race
        with self.assertRaisesRegex(Unknown,'ACTIVE_CONFLICT'):x.start(job())
        self.assertFalse(e.runs)
        with self.assertRaisesRegex(Unknown,'RUN_CLOSED'):x.start(job())

    def test_intent_before_claim_crash_remains_unknown(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup()
        with patch.object(Control,'launch_once',side_effect=RuntimeError('process crashed')):
            with self.assertRaises(RuntimeError):x.start(job())
        with self.assertRaisesRegex(Unknown,'LAUNCH_ACK_UNKNOWN'):x.status(job()['run_id'],cancel=True)
        self.assertFalse(e.runs)

    def test_stale_reserved_actor_cannot_launch_after_cancel_then_new_run(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();put=s.put_object;fired=False
        second=job();second['run_id']='b'*32
        def race(**kw):
            nonlocal fired
            if kw['Key']=='active.json' and json.loads(kw['Body'])['phase']=='INTENT' and not fired:
                fired=True;x.status(job()['run_id'],cancel=True);x.start(second)
            return put(**kw)
        s.put_object=race
        with self.assertRaisesRegex(Unknown,'ACTIVE_CONFLICT'):x.start(job())
        self.assertEqual(len(e.runs),1)
        self.assertEqual(x.active()[0]['admission']['id'],'b'*32)

    def test_same_run_different_job_and_changed_config_refuse(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();x.start(job())
        changed=job();changed['producer']['args']=['different']
        with self.assertRaisesRegex(Unknown,'RUN_CONFLICT'):x.start(changed)
        x.cfg={**x.cfg,'SECRET_ARN':'different'}
        with self.assertRaisesRegex(Unknown,'CONFIGURATION_CHANGED'):x.status(job()['run_id'])
        self.assertEqual(len(e.runs),1)

    def test_cleanup_and_stored_receipt_revalidated_locally(self):
        from test_boundaries import job,receipt
        x,c,e,s,i=session_setup();x.start(job())
        key='results/arn:aws:ec2:us-east-1:111111111111:instance/i-test/receipt.json'
        s.objects['evidence',key]=encoded(receipt())
        self.assertFalse(x.status(job()['run_id'])['passed'])
        i['State']['Name']='terminated'
        self.assertTrue(x.status(job()['run_id'])['passed'])
        bad=receipt();bad['private']='must refuse';s.objects['evidence',key]=encoded(bad)
        with self.assertRaises(ValueError):x.status(job()['run_id'])
        with self.assertRaisesRegex(Unknown,'RUN_CLOSED'):x.start(job())

    def test_receipt_absence_finishes_failed_after_observed_cleanup(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();x.start(job());i['State']['Name']='terminated'
        self.assertEqual(x.status(job()['run_id']),dict(run_id=job()['run_id'],complete=True,passed=False))

    def test_duplicate_or_changed_disk_inventory_refused(self):
        from test_boundaries import job
        for change in ('duplicate','changed'):
            with self.subTest(change=change):
                x,c,e,s,i=session_setup()
                if change=='changed':x.start(job())
                i['BlockDeviceMappings'][1]['Ebs']['VolumeId']='vol-a' if change=='duplicate' else 'vol-c'
                with self.assertRaisesRegex(Unknown,'DISK_INVENTORY_UNKNOWN|INSTANCE_CHANGED'):x.start(job())
                self.assertFalse(any(k.startswith('boot/') for b,k in s.objects) if change=='duplicate' else False)

    def test_expiry_is_rechecked_after_image_lookup(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();lookup=e.describe_images
        def delay(**kw):c.now+=4000;return lookup(**kw)
        e.describe_images=delay
        with self.assertRaisesRegex(Unknown,'ADMISSION_EXPIRED'):x.start(job())
        self.assertFalse(e.runs)

    def test_sdk_disables_launch_retries(self):
        import sys
        from types import SimpleNamespace
        from run import clients
        calls=[]
        def client(name,config):calls.append((name,config));return name
        sdk=SimpleNamespace(Session=lambda **kw:SimpleNamespace(client=client))
        conf=SimpleNamespace(Config=lambda **kw:kw)
        with patch.dict(sys.modules,{'boto3':sdk,'botocore':SimpleNamespace(),'botocore.config':conf}):
            clients('us-east-1','operator-profile')
        self.assertEqual([n for n,c in calls],['ec2','s3','cloudwatch'])
        self.assertTrue(all(c['retries']['total_max_attempts']==1 for n,c in calls))

    def test_monitor_is_instance_bound_and_cleanup_removes_only_this_run(self):
        from test_boundaries import job
        from unittest.mock import Mock
        x,c,e,s,i=session_setup();monitor=Mock();x.monitoring=monitor
        x.start(job())
        self.assertEqual(monitor.put_metric_alarm.call_count,2)
        for call in monitor.put_metric_alarm.call_args_list:
            self.assertEqual(call.kwargs['Dimensions'],[{'Name':'InstanceId','Value':'i-test'}])
            self.assertIn(job()['run_id'],call.kwargs['AlarmName'])
            self.assertEqual(call.kwargs['TreatMissingData'],'breaching')
        i['State']['Name']='terminated';x.status(job()['run_id'])
        self.assertTrue(all(job()['run_id'] in n for n in monitor.delete_alarms.call_args.kwargs['AlarmNames']))

    def test_provision_lifecycle_uses_separate_boot_and_closed_receipt(self):
        x,c,e,s,i=session_setup()
        x.cfg.update(MODE='provision',INSTANCE_TYPE='t4g.small',ADMIN_SECRET_ARN='admin',PROVISION_OWNER='polis-probe-login:test')
        i['InstanceType']='t4g.small'
        request=dict(run_id='a'*32,adminVersion='b'*32,readerVersion='c'*32)
        self.assertFalse(x.start_provision(request)['complete'])
        a=x.active()[0]['admission'];arn='arn:aws:ec2:us-east-1:111111111111:instance/i-test'
        boot=json.loads(s.objects['control','boot/provision/'+arn+'.json'])
        self.assertEqual(boot['provision'],request)
        self.assertFalse(any(k.startswith('boot/worker/') for b,k in s.objects))
        s.objects['control','provision-results/'+arn+'.json']=encoded(dict(schema='polis-probe-provision/1',admissionSha256=sha(a),success=True))
        i['State']['Name']='terminated'
        self.assertTrue(x.status(request['run_id'])['passed'])
        bad=dict(schema='polis-probe-provision/1',admissionSha256=sha(a),success=True,password='private')
        s.objects['control','provision-results/'+arn+'.json']=encoded(bad)
        with self.assertRaisesRegex(Unknown,'PROVISION_RECEIPT'):x.status(request['run_id'])
