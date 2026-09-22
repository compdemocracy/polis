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
    def describe_instances(self, **kw):
        found = [i for i in self.instances if i['InstanceId'] in kw.get('InstanceIds', [])]
        if kw.get('InstanceIds') and not found: raise ApiError('InvalidInstanceID.NotFound')
        return {'Reservations': [{'Instances': found}]}
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


class QuietMonitoring:
    def __init__(self, clock): self.clock = clock
    def get_metric_statistics(self, **kw):
        return {'Datapoints': [{'Timestamp': kw['EndTime']-dt.timedelta(seconds=60), 'Average': 0}]}
    def put_metric_alarm(self, **kw): pass
    def delete_alarms(self, **kw): pass


def setup(now=1893492000):  # 2030-01-01 10:00 UTC
    a = admission()
    cfg = {'ADMISSION': encoded(a).decode(), 'ADMISSION_SHA256': sha(a), 'CONTROL_BUCKET': 'control',
           'MODE':'worker','INSTANCE_TYPE':'r8g.4xlarge','AMI':a['ami'],'ACCOUNT':a['account'],'REGION':a['region'],'BOX_ID':'test-box','ASSET_BUCKET':'assets','SECRET_ARN':'secret','REPLICA_HOST':'replica.invalid','DATABASE':'test','SECRETS_URL':'https://secrets.invalid', 'EVIDENCE_BUCKET': 'evidence', 'CONTROL_KEY': 'key', 'TEMPLATE': 'lt-test',
           'TEMPLATE_VERSION': '1', 'PROFILE': 'profile', 'SUBNET': 'subnet', 'SECURITY_GROUP': 'sg', 'ENDPOINT': 'vpce'}
    e, s = EC2(), S3()
    c = Control(e, s, cfg, now)
    c.monitoring = QuietMonitoring(lambda: c.now)
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
    def test_partial_disk_inventory_is_never_recorded(self):
        c, e, s, i = setup(); i['BlockDeviceMappings'] = [{'Ebs': {'VolumeId': 'vol-a'}}]
        self.assertEqual(c.launch_once()['status'], 'ATTACHING')
        self.assertIsNone(c.read(c.prefix + 'instance.json'))
        self.assertFalse([k for (b, k) in s.objects if k.startswith('boot/')])
        i['BlockDeviceMappings'] = [{'Ebs': {'VolumeId': v}} for v in ('vol-a', 'vol-b')]
        self.assertEqual(c.reconcile()['status'], 'RUNNING')
        self.assertEqual(c.read(c.prefix + 'instance.json')['volumes'], ['vol-a', 'vol-b'])
        self.assertTrue([k for (b, k) in s.objects if k.startswith('boot/')])
    def test_terminated_instance_without_subnet_field_is_still_owned(self):
        c, e, s, i = setup(); c.launch_once(); i['State']['Name'] = 'terminated'; i['SubnetId'] = None; i['SecurityGroups'] = []; i['IamInstanceProfile'] = None; i['BlockDeviceMappings'] = []
        self.assertEqual(c.reconcile()['status'], 'CLEAN')
    def test_running_instance_without_subnet_is_not_owned(self):
        c, e, s, i = setup(); c.launch_once(); del i['SubnetId']
        with self.assertRaisesRegex(Unknown, 'INSTANCE_OWNERSHIP_UNKNOWN'): c.reconcile()
    def test_running_instance_without_profile_is_not_owned(self):
        c, e, s, i = setup(); c.launch_once(); i['IamInstanceProfile'] = None
        with self.assertRaisesRegex(Unknown, 'INSTANCE_OWNERSHIP_UNKNOWN'): c.reconcile()
    def test_recorded_instance_aged_out_of_describe_is_clean_when_disks_absent(self):
        c, e, s, i = setup(); c.launch_once(); e.instances = []
        self.assertEqual(c.reconcile()['status'], 'CLEAN')
        self.assertFalse(e.terminated); self.assertFalse(e.deleted)
    def test_unrecorded_launch_with_empty_describe_stays_unknown(self):
        c, e, s, i = setup(); e.instances = []
        with self.assertRaisesRegex(Unknown, 'LAUNCH_ACK_UNKNOWN'): c.reconcile()
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
    session=Session(e,s,cfg,clock=lambda:c.now,monitoring=c.monitoring)
    original=e.run_instances
    def launch(**kw):
        i['ClientToken']=kw['ClientToken']
        i['Tags']=kw['TagSpecifications'][0]['Tags']
        return original(**kw)
    e.run_instances=launch
    return session,c,e,s,i


class ReleaseTests(unittest.TestCase):
    def stuck(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup(); run=job()['run_id']
        i['BlockDeviceMappings']=[{'Ebs': {'VolumeId': 'vol-a'}}]
        self.assertFalse(x.start(job())['complete'])
        state,_=x.active(); c2=x.control(state)
        self.assertIsNone(c2.read(c2.prefix+'instance.json'))
        # A record made by an older tool from a partial observation.
        s.objects['control', c2.prefix+'instance.json']=encoded({'id':'i-test','volumes':['vol-a'],'admissionSha256':c2.token})
        return x,c2,e,s,i,run
    def test_release_refuses_a_running_instance(self):
        x,c,e,s,i,run=self.stuck()
        with self.assertRaisesRegex(Unknown,'RELEASE_REFUSED_RUNNING'): x.release(run,['vol-a','vol-b'])
    def test_release_after_the_instance_aged_out_of_describe(self):
        x,c,e,s,i,run=self.stuck(); e.instances=[]
        with self.assertRaisesRegex(Unknown,'DISK_INVENTORY_UNKNOWN'): x.status(run)
        r=x.release(run,['vol-a','vol-b'])
        self.assertEqual((r['complete'],r['passed']),(True,False)); self.assertEqual(x.active()[0]['phase'],'CLEAN')
    def test_release_requires_full_attestation_and_absent_disks(self):
        x,c,e,s,i,run=self.stuck()
        i['State']['Name']='terminated'; i['SubnetId']=None; i['SecurityGroups']=[]; i['IamInstanceProfile']=None; i['BlockDeviceMappings']=[]
        with self.assertRaisesRegex(Unknown,'DISK_INVENTORY_UNKNOWN'): x.status(run)
        with self.assertRaisesRegex(Unknown,'RELEASE_ATTESTATION'): x.release(run,['vol-a'])
        with self.assertRaisesRegex(Unknown,'RELEASE_ATTESTATION'): x.release(run,['vol-b','vol-c'])
        e.disks=[{'VolumeId':'vol-b','State':'available'}]
        with self.assertRaisesRegex(Unknown,'DISK_REMAINS'): x.release(run,['vol-a','vol-b'])
        e.disks=[]
        r=x.release(run,['vol-a','vol-b'])
        self.assertEqual((r['complete'],r['passed']),(True,False))
        self.assertTrue(c.read(c.prefix+'clean.json')['attested'])
        self.assertEqual(x.active()[0]['phase'],'CLEAN')
        self.assertFalse(e.deleted)


class SessionTests(unittest.TestCase):
    def test_first_status_can_observe_fewer_disks_than_launch(self):
        from test_boundaries import job
        for state in ('pending', 'running'):
            for count in (0, 1):
                with self.subTest(state=state, count=count):
                    x,c,e,s,i=session_setup()
                    i['State']['Name']=state
                    original=e.get_paginator
                    observations=[]
                    def pages(name):
                        if name != 'describe_instances':return original(name)
                        def observe(**kw):
                            observations.append(True)
                            if len(observations)==2:i['BlockDeviceMappings']=i['BlockDeviceMappings'][:count]
                            return [{'Reservations':[{'Instances':[i]}]}]
                        return Pages(observe)
                    e.get_paginator=pages
                    self.assertEqual(x.start(job()),dict(run_id=job()['run_id'],complete=False,passed=False))
                    owned=x.control(x.active()[0])
                    self.assertEqual(owned.read(owned.prefix+'instance.json')['volumes'],['vol-a','vol-b'])
                    self.assertEqual(owned.reconcile()['status'],'ATTACHING')
                    i['BlockDeviceMappings']=[{'Ebs':{'VolumeId':v}} for v in ('vol-a','vol-b')]
                    self.assertFalse(x.status(job()['run_id'])['complete'])
                    self.assertEqual(len(e.runs),1)
                    self.assertFalse(e.terminated)

    def test_initial_partial_status_does_not_publish_disposal_or_boot(self):
        from test_boundaries import job
        for state in ('pending','running'):
            for count in (0,1):
                with self.subTest(state=state,count=count):
                    x,c,e,s,i=session_setup()
                    i['State']['Name']=state;i['BlockDeviceMappings']=i['BlockDeviceMappings'][:count]
                    self.assertFalse(x.start(job())['complete'])
                    owned=x.control(x.active()[0])
                    self.assertIsNone(owned.read(owned.prefix+'instance.json'))
                    self.assertFalse([k for _,k in s.objects if k.startswith('boot/')])
                    self.assertEqual(len(e.runs),1)

    def test_partial_view_keeps_disk_and_identity_refusals(self):
        from test_boundaries import job
        changes=[('duplicate',['vol-a','vol-a'],'DISK_INVENTORY_UNKNOWN'),
                 ('oversize',['vol-a','vol-b','vol-c'],'DISK_INVENTORY_UNKNOWN'),
                 ('foreign-subset',['vol-c'],'INSTANCE_CHANGED'),
                 ('changed-pair',['vol-a','vol-c'],'INSTANCE_CHANGED')]
        for name,disks,code in changes:
            with self.subTest(name=name):
                x,c,e,s,i=session_setup();x.start(job())
                i['BlockDeviceMappings']=[{'Ebs':{'VolumeId':v}} for v in disks]
                with self.assertRaisesRegex(Unknown,code):x.status(job()['run_id'])
                self.assertFalse(e.terminated);self.assertFalse(e.deleted)
        for key,value,code in [('ClientToken','wrong','OWNERSHIP'),
                               ('InstanceId','i-other','INSTANCE_CHANGED')]:
            with self.subTest(key=key):
                x,c,e,s,i=session_setup();x.start(job())
                i['BlockDeviceMappings']=i['BlockDeviceMappings'][:1];i[key]=value
                with self.assertRaisesRegex(Unknown,code):x.status(job()['run_id'])
                self.assertFalse(e.terminated)

    def test_partial_attachment_never_bypasses_stop_conditions(self):
        from test_boundaries import job
        for recorded in (False,True):
            for stop in ('expiry','cancel','heartbeat'):
                with self.subTest(recorded=recorded,stop=stop):
                    x,c,e,s,i=session_setup()
                    if not recorded:i['BlockDeviceMappings']=i['BlockDeviceMappings'][:1]
                    x.start(job());i['BlockDeviceMappings']=i['BlockDeviceMappings'][:1]
                    if stop=='expiry':c.now+=job()['max_seconds']
                    elif stop=='heartbeat':c.now+=601
                    with self.assertRaisesRegex(Unknown,'TERMINATION_PENDING'):
                        x.status(job()['run_id'],cancel=stop=='cancel')
                    self.assertEqual(e.terminated,['i-test']);self.assertEqual(len(e.runs),1)
                    self.assertEqual(x.active()[0]['phase'],'INTENT')

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

    def test_worker_failure_record_is_reported_in_fixed_vocabulary_only(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();x.start(job());i['State']['Name']='terminated'
        key='heartbeats/'+job()['run_id']+'/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json'
        s.objects['control',key]=encoded({'schema':'polis-probe-failure/1','stage':'reader','type':'SandboxFailure','code':'PROBE_EXECUTION_FAILED',
            'container':{'label':'reader','exit':1,'oom':False,'class':'psycopg2.OperationalError','reason':'PG_SERVICE_FILE','role':'pc-v1-large-r16','rank':16,'candidates':9,'note':'zid 42 secret','exit2':'1'},
            'relay':{'connect':3,'relayed':'no','x y':1},'message':'must not pass through','aws':'not a token'})
        self.assertEqual(x.status(job()['run_id'])['failure'],{'stage':'reader','type':'SandboxFailure','code':'PROBE_EXECUTION_FAILED',
            'container':{'label':'reader','class':'psycopg2.OperationalError','reason':'PG_SERVICE_FILE','role':'pc-v1-large-r16','exit':1,'oom':False,'rank':16,'candidates':9},'relay':{'connect':3}})
        for body in (b'{}',b'[]',encoded({'schema':'other','stage':'reader'})):
            s.objects['control',key]=body
            self.assertNotIn('failure',x.status(job()['run_id']))

    def test_failure_tokens_outside_the_reviewed_vocabulary_are_dropped(self):
        from test_boundaries import job
        from vocabulary import Vocabulary
        v=Vocabulary()
        self.assertTrue(v.classes and v.codes and v.slugs and v.stems)
        self.assertIn('RoleUnsatisfied',v.classes); self.assertIn('PROBE_EXECUTION_FAILED',v.codes); self.assertIn('pc-v1-dense',v.slugs)
        x,c,e,s,i=session_setup();x.start(job());i['State']['Name']='terminated'
        key='heartbeats/'+job()['run_id']+'/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json'
        s.objects['control',key]=encoded({'schema':'polis-probe-failure/1','stage':'reader','type':'evil.Exfil.SecretError','code':'LEAK_L9999',
            'container':{'label':'reader','exit':1,'oom':False,'class':'a.b.c.PayloadError','code':'FIXTURE_EXTRACT_L678','reason':'PG_SSL','role':'pc-v1-attacker','rank':1,'candidates':0},
            'relay':{'relayed':1,'covert':7}})
        self.assertEqual(x.status(job()['run_id'])['failure'],{'stage':'reader',
            'container':{'label':'reader','code':'FIXTURE_EXTRACT_L678','reason':'PG_SSL','exit':1,'oom':False,'rank':1,'candidates':0},'relay':{'relayed':1}})
        s.objects['control',key]=encoded({'schema':'polis-probe-failure/1','stage':'reader','type':'SandboxFailure','code':'PROBE_EXECUTION_FAILED',
            'container':{'label':'reader','exit':1,'oom':False,'class':'polismath.replay.fixture_survey.RoleUnsatisfied','role':'pc-v1-dense','rank':1,'candidates':0},'relay':{'plain_scram':1,'relayed':1}})
        self.assertEqual(x.status(job()['run_id'])['failure'],{'stage':'reader','type':'SandboxFailure','code':'PROBE_EXECUTION_FAILED',
            'container':{'label':'reader','class':'polismath.replay.fixture_survey.RoleUnsatisfied','role':'pc-v1-dense','exit':1,'oom':False,'rank':1,'candidates':0},'relay':{'plain_scram':1,'relayed':1}})
        boot='heartbeats/boot/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json'
        s.objects['control',key]=b'{}'; s.objects['control',boot]=encoded({'schema':'polis-probe-boot-failure/1','phase':'not-a-phase'})
        self.assertNotIn('failure',x.status(job()['run_id']))

    def test_boot_failure_marker_is_reported_when_the_worker_never_started(self):
        from test_boundaries import job
        x,c,e,s,i=session_setup();x.start(job());i['State']['Name']='terminated'
        boot='heartbeats/boot/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json'
        s.objects['control',boot]=encoded({'schema':'polis-probe-boot-failure/1','phase':'private-disk','note':'zid 42'})
        self.assertEqual(x.status(job()['run_id'])['failure'],{'stage':'boot','phase':'private-disk'})
        s.objects['control',boot]=encoded({'schema':'polis-probe-boot-failure/1','phase':'not a token'})
        self.assertNotIn('failure',x.status(job()['run_id']))

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


    def test_provision_public_defaults_closed_and_returned(self):
        x,c,e,s,i=session_setup()
        x.cfg.update(MODE='provision',INSTANCE_TYPE='t4g.small',ADMIN_SECRET_ARN='admin',PROVISION_OWNER='polis-probe-login:test')
        i['InstanceType']='t4g.small'
        request=dict(run_id='a'*32,adminVersion='b'*32,readerVersion='c'*32)
        x.start_provision(request)
        a=x.active()[0]['admission']
        key=('control','provision-results/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json')
        i['State']['Name']='terminated'
        base=dict(schema='polis-probe-provision/2',admissionSha256=sha(a),success=True,
                  public_defaults=['database-temp','routine-execute'])
        s.objects[key]=encoded(base)
        self.assertEqual(x.status(request['run_id'])['public_defaults'],base['public_defaults'])
        for bad in (None,{},['private'],['database-temp']*2,['routine-execute','database-temp'],[{}]):
            with self.subTest(bad=bad):
                s.objects[key]=encoded(dict(base,public_defaults=bad))
                with self.assertRaisesRegex(Unknown,'PROVISION_RECEIPT'):x.status(request['run_id'])
        for change in ({'schema':'polis-probe-provision/1'},{'private':True},{'success':False}):
            with self.subTest(change=change):
                s.objects[key]=encoded(dict(base,**change))
                with self.assertRaisesRegex(Unknown,'PROVISION_RECEIPT'):x.status(request['run_id'])
        del base['public_defaults']
        s.objects[key]=encoded(base)
        with self.assertRaisesRegex(Unknown,'PROVISION_RECEIPT'):x.status(request['run_id'])



class WorkerHardeningTests(unittest.TestCase):
    key = 'heartbeats/'+'a'*32+'/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json'

    def test_old_and_new_pulses_and_terminal_tokens(self):
        x, c, e, s, i = session_setup()
        for body, expected in [({}, None),
                ({'stage': 'producer', 'pulse': 7, 'phase': 'execute'},
                 {'stage': 'producer', 'pulse': 7, 'phase': 'execute'}),
                ({'schema': 'polis-probe-failure/1', 'stage': 'reader', 'type': 'record-failed', 'reason': 'FAILURE_RECORD_FAILED'},
                 {'stage': 'reader', 'type': 'record-failed', 'reason': 'FAILURE_RECORD_FAILED'}),
                ({'schema': 'polis-probe-failure/1', 'stage': 'verifier', 'type': 'terminated'},
                 {'stage': 'verifier', 'type': 'terminated'})]:
            with self.subTest(body=body):
                s.objects['control', self.key] = encoded(body)
                self.assertEqual(x.failure(c, self.key.split('/', 2)[2][:-5]), expected)

    def test_pulse_rejects_nonclosed_values_and_malformed_json(self):
        x, c, e, s, i = session_setup()
        for body in [b'{', encoded({'stage': [], 'pulse': 1, 'phase': 'execute'}),
                encoded({'stage': 'reader', 'pulse': True, 'phase': 'execute'}),
                encoded({'stage': 'reader', 'pulse': -1, 'phase': 'execute'}),
                encoded({'stage': 'reader', 'pulse': 1, 'phase': 'private'}),
                encoded({'stage': 'reader', 'pulse': 1, 'phase': 'execute', 'private': 'payload'})]:
            with self.subTest(body=body):
                s.objects['control', self.key] = body
                self.assertIsNone(x.failure(c, self.key.split('/', 2)[2][:-5]))

    def test_stale_pulse_persisted_before_kill_and_carried_to_clean(self):
        c, e, s, i = setup(); c.launch_once(); c.now += 601
        pulse = {'stage': 'producer', 'pulse': 31, 'phase': 'execute'}
        s.objects['control', self.key] = encoded(pulse)
        s.head_object = lambda **kw: {'LastModified': dt.datetime.fromtimestamp(c.now-301, dt.timezone.utc)}
        def terminate(**kw):
            self.assertEqual(c.read(c.prefix+'termination.json')['heartbeat'], pulse)
            self.assertIsNone(c.read(c.prefix+'clean.json'))
            e.terminated.extend(kw['InstanceIds'])
        e.terminate_instances = terminate
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile()
        s.objects['control', self.key] = b'{}'  # worker cleanup cannot erase snapshot
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile()
        i['State']['Name'] = 'terminated'
        self.assertEqual(c.reconcile()['status'], 'CLEAN')
        self.assertEqual(c.read(c.prefix+'clean.json')['heartbeat'], pulse)
        self.assertEqual(len(e.terminated), 2)

    def test_terminal_snapshot_survives_mailbox_loss_and_stays_closed(self):
        from test_boundaries import job
        x, c, e, s, i = session_setup(); x.start(job())
        c = x.control(x.active()[0]); c.now += 601
        raw = {'schema': 'polis-probe-failure/1', 'stage': 'reader',
               'type': 'record-failed', 'reason': 'FAILURE_RECORD_FAILED', 'private': 'do not retain'}
        s.objects['control', self.key] = encoded(raw)
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile()
        del s.objects['control', self.key]
        i['State']['Name'] = 'terminated'
        result = x.status(job()['run_id'])
        self.assertEqual(result['failure'], {'stage': 'reader', 'type': 'record-failed', 'reason': 'FAILURE_RECORD_FAILED'})
        self.assertNotIn('private', json.dumps(c.read(c.prefix+'clean.json')))

    def test_unreadable_or_missing_pulse_does_not_prevent_owned_termination(self):
        for body in (None, b'{', b'[]', b'x'*65537, encoded({'stage': ['private'], 'phase': {}, 'pulse': 1})):
            with self.subTest(body=body if body is None else body[:30]):
                c, e, s, i = setup(); c.launch_once(); c.now += 601
                if body is not None: s.objects['control', self.key] = body
                with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile()
                self.assertEqual(e.terminated, ['i-test'])
                self.assertIsNone(c.read(c.prefix+'termination.json')['heartbeat'])

    def test_pre_admission_worker_failure_in_boot_mailbox(self):
        x, c, e, s, i = session_setup()
        arn = self.key.split('/', 2)[2][:-5]
        s.objects['control', 'heartbeats/boot/'+arn+'.json'] = encoded(
            {'schema': 'polis-probe-failure/1', 'stage': 'boot', 'type': 'SystemExit'})
        self.assertEqual(x.failure(c, arn), {'stage': 'boot', 'type': 'SystemExit'})


class LivenessTests(unittest.TestCase):
    def begin(self, cpu=0, tag=None):
        from unittest.mock import Mock
        c, e, s, i = setup(); c.launch_once(); c.now += 601
        c.monitoring = Mock()
        c.monitoring.get_metric_statistics.return_value = {'Datapoints': [
            {'Timestamp': dt.datetime.fromtimestamp(c.now-60, dt.timezone.utc), 'Average': cpu}]}
        if tag is not None: i['Tags'].append({'Key': 'polis-probe-pulse', 'Value': tag})
        return c, e, s, i

    def test_busy_cpu_preserves_instance_and_durable_evidence_until_expiry(self):
        c, e, s, i = self.begin(cpu=17)
        self.assertEqual(c.reconcile()['status'], 'RUNNING')
        saved = c.read(c.prefix+'liveness.json')
        self.assertEqual(saved['cpu'], 'busy'); self.assertEqual(saved['tag'], 'absent')
        self.assertEqual(saved['admissionSha256'], c.token)
        call = c.monitoring.get_metric_statistics.call_args.kwargs
        self.assertEqual(call['Dimensions'], [{'Name':'InstanceId','Value':'i-test'}])
        self.assertEqual(call['Namespace'], 'AWS/EC2'); self.assertEqual(call['MetricName'], 'CPUUtilization')
        self.assertEqual((call['EndTime']-call['StartTime']).total_seconds(), 300)
        c.monitoring.get_metric_statistics.return_value = {'Datapoints': []}
        c.now += 600
        # Resumed operator uses immutable evidence, no in-memory liveness latch.
        resumed = Control(e, s, c.c, c.now, monitoring=c.monitoring)
        self.assertEqual(resumed.reconcile()['status'], 'RUNNING')
        self.assertEqual(c.read(c.prefix+'liveness.json'), saved)
        self.assertFalse(e.terminated)
        resumed.now = resumed.expiry
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): resumed.reconcile()
        self.assertEqual(e.terminated, ['i-test'])

    def test_tag_must_advance_first_observation_is_only_bounded_grace(self):
        c, e, s, i = self.begin(tag='39:producer:execute:ExpiredToken')
        self.assertEqual(c.reconcile()['status'], 'RUNNING')
        self.assertIsNone(c.read(c.prefix+'liveness.json'))
        c.now += 90; i['Tags'][-1]['Value'] = '40:producer:execute:ExpiredToken'
        self.assertEqual(c.reconcile()['status'], 'RUNNING')
        saved = c.read(c.prefix+'liveness.json')
        self.assertEqual(saved['tag'], 'advanced'); self.assertEqual(saved['pulse']['pulse'], 40)
        self.assertFalse(e.terminated)

    def test_unchanged_or_regressing_tag_with_quiet_cpu_terminates(self):
        for next_tag in ('39:producer:execute', '38:producer:execute'):
            c, e, s, i = self.begin(tag='39:producer:execute')
            c.reconcile(); c.now += 120; i['Tags'][-1]['Value'] = next_tag
            with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile()
            self.assertEqual(e.terminated, ['i-test'])

    def test_quiet_cpu_and_absent_or_invalid_tag_terminate(self):
        for cpu in (0, 2):
            for tag in (None, 'private', '1:producer:execute:private', '1:private:execute',
                        '0:producer:execute', '01:producer:execute', str(2**63)+':producer:execute'):
                c, e, s, i = self.begin(cpu, tag)
                with self.subTest(cpu=cpu, tag=tag), self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'):
                    c.reconcile()
                self.assertEqual(e.terminated, ['i-test'])
                self.assertNotIn('private', json.dumps([json.loads(v) for v in s.objects.values()]))

    def test_unknown_cpu_is_not_evidence_of_silence(self):
        for data in ([], [{'Timestamp': dt.datetime(2000,1,1, tzinfo=dt.timezone.utc),'Average': 17}],
                     [{'Timestamp': dt.datetime(2040,1,1, tzinfo=dt.timezone.utc),'Average': 17}],
                     [{'Timestamp': dt.datetime.fromtimestamp(1893492600, dt.timezone.utc),'Average': float('nan')}],
                     [{'Timestamp': dt.datetime.fromtimestamp(1893492600, dt.timezone.utc),'Average': True}]):
            c, e, s, i = self.begin()
            c.monitoring.get_metric_statistics.return_value = {'Datapoints': data}
            with self.assertRaisesRegex(Unknown, 'LIVENESS_UNKNOWN'): c.reconcile()
            self.assertFalse(e.terminated)
        for error in (ApiError('AccessDenied'), TimeoutError('private')):
            c, e, s, i = self.begin(); c.monitoring.get_metric_statistics.side_effect = error
            with self.assertRaisesRegex(Unknown, 'LIVENESS_UNKNOWN'): c.reconcile()
            self.assertFalse(e.terminated)

    def test_cancel_still_terminates_after_positive_liveness(self):
        c, e, s, i = self.begin(17); c.reconcile()
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile(cancel=True)
        self.assertEqual(e.terminated, ['i-test'])

    def test_new_pulse_reader_is_closed_and_legacy_compatible(self):
        from run import clean_heartbeat
        base = {'pulse': 4, 'stage': 'producer', 'phase': 'execute'}
        for extra in ({}, {'credential_expiry': 'le-30m'}, {'last_error': 'ExpiredToken'},
                      {'credential_expiry': 'expired', 'last_error': 'ReadTimeoutError'}):
            self.assertEqual(clean_heartbeat({**base, **extra}), {**base, **extra})
        for extra in ({'credential_expiry': 'private'}, {'last_error': 'private'},
                      {'last_error': []}, {'credential_expiry': None}):
            self.assertIsNone(clean_heartbeat({**base, **extra}))

    def test_unknown_metrics_can_be_overruled_by_observed_tag_progress(self):
        c, e, s, i = self.begin(tag='1:producer:execute')
        c.monitoring.get_metric_statistics.side_effect = ApiError('AccessDenied')
        self.assertEqual(c.reconcile()['status'], 'RUNNING')
        i['Tags'][-1]['Value'] = '2:producer:execute'; c.now += 60
        self.assertEqual(c.reconcile()['status'], 'RUNNING')
        self.assertEqual(c.read(c.prefix+'liveness.json')['cpu'], 'unknown')
        self.assertFalse(e.terminated)

    def test_no_monitor_and_no_tag_remain_unknown_but_expiry_still_wins(self):
        c, e, s, i = self.begin(); c.monitoring = None
        with self.assertRaisesRegex(Unknown, 'LIVENESS_UNKNOWN'): c.reconcile()
        self.assertFalse(e.terminated)
        c.now = c.expiry
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile()
        self.assertEqual(e.terminated, ['i-test'])

    def test_lost_liveness_write_ack_is_reconciled_without_overwrite(self):
        c, e, s, i = self.begin(2.01)
        put = s.put_object
        def lost(**kw):
            result = put(**kw)
            if kw['Key'].endswith('liveness.json'): raise TimeoutError('private')
            return result
        s.put_object = lost
        self.assertEqual(c.reconcile()['status'], 'RUNNING')
        first = c.read(c.prefix+'liveness.json')
        self.assertEqual(c.reconcile()['status'], 'RUNNING')
        self.assertEqual(c.read(c.prefix+'liveness.json'), first)
        writes = [kw for kw in s.puts if kw['Key'].endswith('liveness.json')]
        self.assertEqual(len(writes), 1); self.assertEqual(writes[0]['IfNoneMatch'], '*')
        self.assertFalse(e.terminated)

    def test_liveness_binding_and_shape_do_not_authorize_foreign_or_corrupt_record(self):
        for delta in ({'instanceId': 'i-other'}, {'admissionSha256': '0'*64},
                      {'observedAt': True}, {'observedAt': 0}, {'cpu': 'private'},
                      {'tag': 'private'}, {'pulse': {'private': 'payload'}}, {'cpu': 'quiet'}):
            c, e, s, i = self.begin(17); c.reconcile()
            saved = c.read(c.prefix+'liveness.json')
            s.objects['control', c.prefix+'liveness.json'] = encoded({**saved, **delta})
            with self.subTest(delta=delta), self.assertRaisesRegex(Unknown, 'LIVENESS_BINDING'): c.reconcile()
            self.assertFalse(e.terminated)

    def test_actual_session_passes_monitor_to_reconciler(self):
        from test_boundaries import job
        from unittest.mock import Mock
        x, c, e, s, i = session_setup(); x.start(job()); c.now += 601
        x.monitoring = Mock()
        x.monitoring.get_metric_statistics.return_value = {'Datapoints': [
            {'Timestamp': dt.datetime.fromtimestamp(c.now-60, dt.timezone.utc), 'Average': 17}]}
        self.assertEqual(x.status(job()['run_id']), {'run_id': job()['run_id'], 'complete': False, 'passed': False})
        self.assertFalse(e.terminated)
        control = x.control(x.active()[0])
        self.assertEqual(control.read(control.prefix+'liveness.json')['cpu'], 'busy')
