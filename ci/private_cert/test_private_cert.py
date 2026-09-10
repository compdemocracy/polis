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

from control import Control, Unknown, encoded, sha
from worker import safe_extract, validate_receipt, upload_chunks, sandbox, CHUNK
from dns import question
from verify import verify


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
            'stagingExpiresAt': '2030-01-01T09:00:00Z', 'expiresAt': '2030-01-01T12:00:00Z', 'inventorySha256': 'a'*64,
            'scheduleSha256': 'b'*64, 'policySha256': 'c'*64, 'expectedChecks': 3,
            'candidateSha': 'd'*40, 'verifierImage': 'localhost/polis-verifier@sha256:'+'e'*64}


def setup(now=1893492000):  # 2030-01-01 10:00 UTC
    a = admission()
    cfg = {'ADMISSION': encoded(a).decode(), 'ADMISSION_SHA256': sha(a), 'CONTROL_BUCKET': 'control',
           'FIXTURE_BUCKET': 'fixtures', 'EVIDENCE_BUCKET': 'evidence', 'CONTROL_KEY': 'key', 'TEMPLATE': 'lt-test',
           'TEMPLATE_VERSION': '1', 'PROFILE': 'profile', 'SUBNET': 'subnet', 'SECURITY_GROUP': 'sg', 'ENDPOINT': 'vpce'}
    e, s = EC2(), S3()
    c = Control(e, s, cfg, now)
    i = {'InstanceId': 'i-test', 'ClientToken': c.token, 'LaunchTemplate': {'LaunchTemplateId': 'lt-test', 'LaunchTemplateName': 'test', 'Version': '1'},
         'IamInstanceProfile': {'Arn': 'profile'}, 'ImageId': a['ami'], 'SubnetId': 'subnet', 'InstanceType': 'r8g.4xlarge',
         'Tags': [{'Key': 'polis:private-cert', 'Value': a['id']}], 'SecurityGroups': [{'GroupId': 'sg'}],
         'State': {'Name': 'running'}, 'BlockDeviceMappings': [{'Ebs': {'VolumeId': v}} for v in ('vol-a', 'vol-b')]}
    e.instances = [i]
    return c, e, s, i


class ControlTests(unittest.TestCase):
    def test_launch_fixed_template_and_token_only(self):
        c, e, s, i = setup()
        self.assertEqual(c.launch()['status'], 'RUNNING')
        self.assertEqual(set(e.runs[0]), {'LaunchTemplate', 'MinCount', 'MaxCount', 'ClientToken'})
        self.assertEqual(e.runs[0]['LaunchTemplate'], {'LaunchTemplateId': 'lt-test', 'Version': '1'})
        self.assertIsNotNone(c.read('boot/' + c.a['id'] + '.json'))
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
                       {'PublicIpAddress': '1.2.3.4'}, {'SecurityGroups': [{'GroupId': 'prod'}]}, {'LaunchTemplate': {'LaunchTemplateId': 'prod', 'Version': '1'}}):
            c, e, s, i = setup(); c.launch(); i.update(change)
            with self.subTest(change=change), self.assertRaisesRegex(Unknown, 'OWNERSHIP'): c.reconcile(cancel=True)
            self.assertEqual(e.terminated, [])
    def test_terminate_ack_is_not_clean(self):
        c, e, s, i = setup(); c.launch()
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile(cancel=True)
        self.assertEqual(e.terminated, ['i-test']); self.assertIsNone(c.read(c.prefix + 'clean.json'))
    def test_terminated_disks_and_all_versions_must_be_gone(self):
        c, e, s, i = setup(); c.launch(); i['State']['Name'] = 'terminated'
        s.versions = [{'Key': 'staging/a/bundle.tar', 'VersionId': v} for v in ('v1', 'v2')]
        s.uploads = [{'Key': 'staging/a/bundle.tar', 'UploadId': 'u1'}]
        self.assertEqual(c.reconcile()['status'], 'CLEAN'); self.assertEqual(len(s.deleted), 2); self.assertEqual(len(s.aborted), 1)
        with self.assertRaisesRegex(Unknown, 'RUN_CLOSED'): c.launch()
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
    def test_versions_remaining_blocks_clean(self):
        c, e, s, i = setup(); c.launch(); i['State']['Name'] = 'terminated'
        s.versions = [{'Key': 'staging/a/bundle.tar', 'VersionId': 'v'}]; s.leave_versions = True
        with self.assertRaisesRegex(Unknown, 'FIXTURE_REMAINS'): c.reconcile()
    def test_missing_heartbeat_terminates_after_grace(self):
        c, e, s, i = setup(); c.launch(); c.now += 601
        with self.assertRaisesRegex(Unknown, 'TERMINATION_PENDING'): c.reconcile()
        self.assertEqual(e.terminated, ['i-test'])
    def test_expiry_removes_staging_even_if_no_instance_observed(self):
        c, e, s, i = setup(); c.launch(); c.now += 9000; e.instances = []
        s.versions = [{'Key': 'staging/a/bundle.tar', 'VersionId': 'v'}]
        with self.assertRaisesRegex(Unknown, 'LAUNCH_ACK_UNKNOWN'): c.reconcile()
        self.assertFalse(s.versions)
    def test_no_launch_ever_clean_on_expiry(self):
        c, e, s, i = setup(); c.now += 9000
        self.assertEqual(c.reconcile()['status'], 'CLEAN'); self.assertFalse(e.runs)
    def test_open_ingestion_launch_denied(self):
        c, e, s, i = setup(now=1893400000)
        with self.assertRaisesRegex(Unknown, 'INGESTION_STILL_OPEN'): c.launch()
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


class WorkerTests(unittest.TestCase):
    def tar(self, entries):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w') as t:
            for name, kind, value in entries:
                i = tarfile.TarInfo(name); i.type = kind
                if kind == tarfile.REGTYPE: i.size = len(value)
                else: i.linkname = value.decode()
                t.addfile(i, io.BytesIO(value) if kind == tarfile.REGTYPE else None)
        return raw.getvalue()
    def extract(self, entries, size=100, members=10):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp); (p/'a.tar').write_bytes(self.tar(entries))
            return safe_extract(p/'a.tar', p/'output', size, members)
    def test_safe_nested_file(self): self.assertEqual(self.extract([('a/b', tarfile.REGTYPE, b'123')]), (1, 3))
    def test_strict_host_umask_still_gives_container_readable_fixture(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp); (p/'a.tar').write_bytes(self.tar([('a/b', tarfile.REGTYPE, b'123')]))
            prior = os.umask(0o077)
            try: safe_extract(p/'a.tar', p/'fixture', 100, 10)
            finally: os.umask(prior)
            self.assertEqual((p/'fixture').stat().st_mode & 0o777, 0o555)
            self.assertEqual((p/'fixture/a').stat().st_mode & 0o777, 0o555)
            self.assertEqual((p/'fixture/a/b').stat().st_mode & 0o777, 0o444)
            # Restore owner write only for TemporaryDirectory cleanup as nonroot.
            (p/'fixture').chmod(0o755); (p/'fixture/a').chmod(0o755)
    def test_traversal_absolute_duplicate_and_links(self):
        for entries in ([('../x', tarfile.REGTYPE, b'1')], [('/x', tarfile.REGTYPE, b'1')],
                        [('x', tarfile.REGTYPE, b'1')]*2, [('link', tarfile.SYMTYPE, b'/etc/passwd')],
                        [('link', tarfile.LNKTYPE, b'x')], [('dir', tarfile.DIRTYPE, b'')]):
            with self.subTest(entries=entries), self.assertRaises(ValueError): self.extract(entries)
    def test_expansion_and_member_limits(self):
        with self.assertRaises(ValueError): self.extract([('x', tarfile.REGTYPE, b'123')], size=2)
        with self.assertRaises(ValueError): self.extract([('x', tarfile.REGTYPE, b'1')], members=0)
    def receipt(self):
        a = admission()
        return {'schema': 'polis-private-gate/2', 'negativeControlsSha256': 'a'*64, 'admissionSha256': sha(a), 'evidenceSha256': 'f'*64,
                'inventorySha256': a['inventorySha256'], 'scheduleSha256': a['scheduleSha256'], 'policySha256': a['policySha256'],
                'checks': 3, 'verdict': 'PASS', 'reason': 'COMPLETE'}
    def test_complete_bound_receipt(self): self.assertEqual(validate_receipt(self.receipt(), admission(), 'f'*64)['verdict'], 'PASS')
    def test_short_forged_free_text_receipts_rejected(self):
        for changes in ({'checks': 2}, {'checks': True}, {'policySha256': 'x'}, {'admissionSha256': 'x'},
                        {'evidenceSha256': 'x'}, {'reason': 'secret'}, {'extra': 'private-path'}, {'verdict': 'UNKNOWN'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError): validate_receipt({**self.receipt(), **changes}, admission(), 'f'*64)
    def test_chunks_are_bounded_versioned_and_create_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'archive'; p.write_bytes(b'x'*(CHUNK+1)); s = S3()
            prefix, m = upload_chunks(s, p, {'admission': admission(), 'evidenceBucket': 'evidence', 'evidenceKey': 'key'}, 'instance')
            self.assertEqual([c['bytes'] for c in m['chunks']], [CHUNK, 1])
            self.assertTrue(all(c['version'] == 'v1' for c in m['chunks']))
            self.assertTrue(all(p['IfNoneMatch'] == '*' for p in s.puts))
            self.assertFalse(any(p['Key'].endswith('manifest.json') for p in s.puts))
    def test_sandbox_command_has_no_host_network_credentials_or_socket(self):
        with tempfile.TemporaryDirectory() as tmp, patch('worker.subprocess.run') as run:
            run.side_effect = [type('R', (), {'returncode': 0})(), type('R', (), {'stdout': b'[{"State":{"ExitCode":0,"OOMKilled":false}}]'})(), None]
            sandbox('localhost/image@sha256:123', 'produce', [(Path(tmp), '/fixture', 'ro')], Path(tmp)/'log', 10)
            cmd = run.call_args_list[0].args[0]
            for value in ('--network=none', '--read-only', '--cap-drop=ALL', '--pull=never', '--memory-swap=112g', '--user=65534:65534'): self.assertIn(value, cmd)
            self.assertNotIn('docker.sock', ' '.join(cmd)); self.assertNotIn('AWS_', ' '.join(cmd))
    def test_timeout_still_kills_container(self):
        with tempfile.TemporaryDirectory() as tmp, patch('worker.subprocess.run', side_effect=[TimeoutError(), None]) as run:
            with self.assertRaises(TimeoutError): sandbox('image', 'produce', [], Path(tmp)/'log', 1)
            self.assertEqual(run.call_args_list[-1].args[0], ['podman', 'rm', '--force', 'polis-private-produce'])
    def test_dns_only_one_plain_address_question(self):
        packet = b'\x00\x01\x01\x00\x00\x01' + b'\x00'*6 + b'\x03s3a\x03com\x00\x00\x01\x00\x01'
        self.assertEqual(question(packet), 's3a.com')
        for bad in (packet[:-1], packet + b'junk', packet[:12] + b'\xc0\x0c\x00\x01\x00\x01'):
            with self.assertRaises((ValueError, IndexError)): question(bad)


class VerifyTests(unittest.TestCase):
    def fixture(self, tmp):
        a = admission(); s = S3(); arn = 'arn:aws:ec2:us-east-1:111111111111:instance/i-test'
        prefix = f'runs/{a["id"]}/{arn}/'
        bucket = f'ppc-{a["account"]}-{a["id"]}-evidence'
        raw = WorkerTests().tar([('output.json', tarfile.REGTYPE, b'{}')])
        digest = hashlib.sha256(raw).hexdigest()
        receipt = {**WorkerTests().receipt(), 'evidenceSha256': digest, 'negativeControlsSha256': sha({'synthetic': True})}
        m = {'schema': 'polis-private-evidence/1', 'admissionSha256': sha(a), 'archiveSha256': digest,
             'archiveBytes': len(raw), 'instanceArn': arn,
             'chunks': [{'key': prefix+'chunks/00000000', 'version': 'v1', 'bytes': len(raw), 'sha256': digest}], 'gateReceipt': receipt}
        s.objects[bucket, prefix+'chunks/00000000'] = raw
        s.objects[bucket, prefix+'manifest.json'] = encoded(m)
        control = f'ppc-{a["account"]}-{a["id"]}-control'
        s.objects[control, f'control/{a["id"]}/clean.json'] = encoded({'status': 'CLEAN', 'admissionSha256': sha(a),
                    'instanceId': 'i-test', 'fixtureVersions': 0, 'volumes': ['vol-a', 'vol-b']})
        def gate(*args):
            (Path(tmp)/'verdict'/'receipt.json').write_bytes(encoded(receipt))
            (Path(tmp)/'verdict'/'negative-controls.json').write_bytes(encoded({'synthetic': True}))
        return a, s, m, prefix, bucket, control, gate
    def test_private_reverification_and_cleanup_allow_only_closed_public_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, s, m, prefix, bucket, control, gate = self.fixture(tmp)
            with patch('verify.sandbox', side_effect=gate) as called:
                result = verify(s, a, prefix+'manifest.json', 'v1', Path(tmp))
            self.assertEqual(called.call_count, 1)
            self.assertEqual(set(result), {'schema', 'admissionId', 'candidateSha', 'verdict', 'reason', 'checks'})
            self.assertEqual(result['verdict'], 'PASS')
            self.assertNotIn('fixture', encoded(result).decode())
    def test_missing_cleanup_cannot_publish_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, s, m, prefix, bucket, control, gate = self.fixture(tmp)
            del s.objects[control, f'control/{a["id"]}/clean.json']
            with patch('verify.sandbox', side_effect=gate), self.assertRaises(ApiError):
                verify(s, a, prefix+'manifest.json', 'v1', Path(tmp))
    def test_wrong_instance_cleanup_cannot_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, s, m, prefix, bucket, control, gate = self.fixture(tmp)
            key = control, f'control/{a["id"]}/clean.json'
            record = json.loads(s.objects[key]); record['instanceId'] = 'i-other'; s.objects[key] = encoded(record)
            with patch('verify.sandbox', side_effect=gate), self.assertRaisesRegex(ValueError, 'TEARDOWN_UNKNOWN'):
                verify(s, a, prefix+'manifest.json', 'v1', Path(tmp))
    def test_forged_chunk_bytes_rejected_before_semantic_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, s, m, prefix, bucket, control, gate = self.fixture(tmp)
            s.objects[bucket, prefix+'chunks/00000000'] = b'forged'
            with patch('verify.sandbox') as called, self.assertRaisesRegex(ValueError, 'CHUNK_BINDING'):
                verify(s, a, prefix+'manifest.json', 'v1', Path(tmp))
            called.assert_not_called()
    def test_independent_gate_disagreement_rejects_worker_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, s, m, prefix, bucket, control, gate = self.fixture(tmp)
            def changed(*args):
                gate(); p = Path(tmp)/'verdict'/'receipt.json'; r = json.loads(p.read_bytes())
                r.update(verdict='FAIL', reason='COMPARISON'); p.write_bytes(encoded(r))
            with patch('verify.sandbox', side_effect=changed), self.assertRaisesRegex(ValueError, 'DISAGREEMENT'):
                verify(s, a, prefix+'manifest.json', 'v1', Path(tmp))


if __name__ == '__main__': unittest.main()
