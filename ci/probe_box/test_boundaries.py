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
from receipt import canonical, decode_receipt, sha, validate_receipt
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
    def test_closed_legacy_omission_receipt_and_existing_bytes(self):
        for make in (receipt, sampled_receipt):
            r = make()
            original = canonical(r)
            self.assertEqual(canonical(decode_receipt(original, job())), original)
            self.assertNotIn('legacy_defects', r['entries'][0])
            r['entries'][0]['legacy_defects'] = [
                {'name': 'legacy-defect-empty-omits-keys', 'keys': ['in-conv', 'n', 'n-cmts', 'tids']}]
            self.assertEqual(decode_receipt(canonical(r), job()), r)

    def test_legacy_omission_export_refuses_unapproved_shapes(self):
        good = {'name': 'legacy-defect-empty-omits-keys', 'keys': ['n']}
        invalid = [None, {}, [], [good, good],
                   [{'name': 'arbitrary', 'keys': ['n']}],
                   [{'name': good['name'], 'keys': ['zid']}],
                   [{'name': good['name'], 'keys': ['n', 'n']}],
                   [{'name': good['name'], 'keys': ['tids', 'n']}],
                   [{'name': good['name'], 'keys': []}],
                   [{'name': good['name'], 'keys': 'n'}],
                   [{'name': good['name'], 'keys': [False]}],
                   [{'name': good['name'], 'keys': [{}]}],
                   [{**good, 'value': 0}], [{**good, 'checkpoints': [0]}]]
        for value in invalid:
            with self.subTest(value=value):
                r = receipt()
                r['entries'][0]['legacy_defects'] = value
                with self.assertRaises(ValueError):
                    decode_receipt(canonical(r), job())

    def test_complete_legacy_key_set_matches_committed_schedule_and_exports_the_defect(self):
        from pathlib import Path
        from receipt import LEGACY_EMPTY_KEYS
        raw = json.loads((Path(__file__).resolve().parents[2] /
                          'delphi/scripts/schedules/pc-zerovote-01-empty.json').read_text())
        self.assertEqual(LEGACY_EMPTY_KEYS, set(raw['legacy_absent_keys'] + raw['legacy_absent_moderation']))
        self.assertEqual(len(LEGACY_EMPTY_KEYS), 15)
        for make in (receipt, sampled_receipt):
            r = make()
            r['entries'][0]['legacy_defects'] = [
                {'name': 'legacy-defect-empty-omits-keys', 'keys': sorted(LEGACY_EMPTY_KEYS)}]
            self.assertEqual(decode_receipt(canonical(r), job()), r)

    def test_moderation_omission_receipt_exports_keys_without_values(self):
        for make in (receipt, sampled_receipt):
            for keys in (['mod-in'], ['mod-out'], ['mod-in', 'mod-out']):
                r = make()
                r['entries'][0]['legacy_defects'] = [
                    {'name': 'legacy-defect-empty-omits-keys', 'keys': keys}]
                self.assertEqual(decode_receipt(canonical(r), job()), r)
                r['entries'][0]['legacy_defects'][0]['values'] = [2, 7]
                with self.assertRaises(ValueError):
                    decode_receipt(canonical(r), job())

    def test_only_the_omission_defect_name_is_accepted(self):
        """An empty conversation reports lastVoteTimestamp 0 from both engines
        (the replay driver floors it like the production poller), so the
        omission list is the only observation the receipt may carry."""
        good = {'name': 'legacy-defect-empty-omits-keys', 'keys': ['n']}
        retired = {'name': 'legacy-defect-empty-clock', 'legacy': 0, 'python': 1}
        invalid = [[good, good], [retired], [good, retired],
                   [{'name': 'legacy-defect-empty-clock', 'keys': ['n']}],
                   [{**good, 'legacy': 0, 'python': 1}],
                   [{**good, 'raw': 'private'}], [{**good, 'checkpoints': [0]}],
                   [{'name': good['name']}], [None],
                   [{'name': 'legacy-defect-empty-omits-keys', 'keys': ['pca.comps']}]]
        r = receipt()
        r['entries'][0]['legacy_defects'] = [good]
        self.assertEqual(decode_receipt(canonical(r), job()), r)
        for value in invalid:
            with self.subTest(value=value):
                r['entries'][0]['legacy_defects'] = value
                with self.assertRaises(ValueError):
                    decode_receipt(canonical(r), job())

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

    def test_container_runtime_state_is_on_disposable_disk(self):
        p=worker.docker()
        self.assertEqual(p,['docker','--host','unix:///probe-work/docker.sock'])

    def test_dns_refuses_unknown_shapes_and_encoded_payload(self):
        header=b'\x00\x01\x01\x00\x00\x01'+b'\x00'*6
        q=header+b'\x07example\x03com\x00\x00\x01\x00\x01'
        self.assertEqual(question(q),'example.com')
        for raw in [b'',q+b'payload',header+b'\xc0\x0c\x00\x01\x00\x01']:
            with self.assertRaises((ValueError,IndexError)):question(raw)


class WorkerRecordingTests(unittest.TestCase):
    def recorder(self, put=None):
        from unittest.mock import Mock
        sink = Mock()
        if put is not None:
            sink.put_object.side_effect = put
        d = worker.Diagnostics()
        d.bind(sink, 'control', 'heartbeat', 'key')
        d.enter('reader', 'execute')
        return d, sink

    def test_record_builder_baseexception_falls_back_and_retries_same_bytes(self):
        d, sink = self.recorder([OSError('private'), None])
        with patch.object(worker, 'failure_record', side_effect=KeyboardInterrupt('private')):
            d.fail(ValueError('private'))
        self.assertEqual(sink.put_object.call_count, 2)
        bodies = [call.kwargs['Body'] for call in sink.put_object.call_args_list]
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(json.loads(bodies[0]), {'schema': 'polis-probe-failure/1',
            'stage': 'reader', 'type': 'record-failed', 'reason': 'FAILURE_RECORD_FAILED'})

    def test_serialization_failure_and_relay_failure_use_minimal_record(self):
        for relay in (SimpleNamespace(summary=lambda: {'bad': object()}),
                      SimpleNamespace(summary=lambda: (_ for _ in ()).throw(SystemExit('private')))):
            d, sink = self.recorder()
            d.relay = relay
            d.fail(ValueError('private'))
            self.assertEqual(json.loads(sink.put_object.call_args.kwargs['Body'])['type'], 'record-failed')

    def test_put_failures_are_bounded_and_do_not_escape(self):
        d, sink = self.recorder(OSError('private'))
        d.fail(SystemExit('private'))
        self.assertEqual(sink.put_object.call_count, 2)

    def test_pulses_are_monotonic_closed_and_stop_after_terminal_record(self):
        d, sink = self.recorder()
        d.pulse()
        d.enter('producer', 'execute')
        d.pulse()
        self.assertEqual([json.loads(c.kwargs['Body']) for c in sink.put_object.call_args_list],
            [{'stage': 'reader', 'pulse': 1, 'phase': 'execute'},
             {'stage': 'producer', 'pulse': 2, 'phase': 'execute'}])
        d.fail(ValueError('PROBE_EXECUTION_FAILED'))
        d.pulse(); d.terminated()
        self.assertEqual(sink.put_object.call_count, 3)
        for stage, phase in [('private', 'execute'), ('reader', 'private')]:
            with self.assertRaises(ValueError): d.enter(stage, phase)

    def test_termination_records_inflight_stage_but_not_completed_work(self):
        d, sink = self.recorder()
        d.terminated(); d.terminated()
        self.assertEqual(json.loads(sink.put_object.call_args.kwargs['Body']),
                         {'schema': 'polis-probe-failure/1', 'stage': 'reader', 'type': 'terminated'})
        self.assertEqual(sink.put_object.call_count, 1)
        d, sink = self.recorder()
        d.complete(); d.terminated()
        sink.put_object.assert_not_called()

    def test_main_catches_baseexceptions_and_records_before_poweroff(self):
        from unittest.mock import Mock
        for error in (SystemExit('private'), KeyboardInterrupt('private'), RuntimeError('private')):
            events = []
            d, sink = self.recorder(lambda **kw: events.append('record'))
            with patch.object(worker, 'Diagnostics', return_value=d), \
                 patch.object(worker, 'run', side_effect=error), \
                 patch.object(worker.subprocess, 'run', side_effect=lambda *a, **k: events.append('poweroff')):
                worker.main()
            self.assertEqual(events, ['record', 'poweroff'])

    def test_sandbox_records_before_container_cleanup(self):
        from pathlib import Path
        import tempfile
        events = []
        d, sink = self.recorder(lambda **kw: events.append('record'))
        def command(argv, **kw):
            if 'rm' in argv:
                events.append('cleanup')
                raise RuntimeError('cleanup failed')
            raise KeyboardInterrupt('private')
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker, 'SCRATCH', Path(tmp)), \
             patch.object(worker.subprocess, 'run', side_effect=command):
            with self.assertRaises(RuntimeError):
                worker.sandbox({'args': []}, 'reader', [], 1, 'sha256:'+'a'*64, diagnostics=d)
        self.assertEqual(events, ['record', 'cleanup'])

    def test_inflight_pulse_finishes_before_terminal_write(self):
        import threading
        started, release = threading.Event(), threading.Event()
        bodies = []
        def put(**kw):
            body = json.loads(kw['Body'])
            if 'pulse' in body:
                started.set()
                if not release.wait(5): raise AssertionError('pulse not released')
            bodies.append(body)
        d, sink = self.recorder(put)
        pulse = threading.Thread(target=d.pulse)
        pulse.start()
        self.assertTrue(started.wait(5))
        failure = threading.Thread(target=lambda: d.fail(ValueError('PROBE_EXECUTION_FAILED')))
        failure.start()
        self.assertTrue(d.stop.wait(5))
        release.set()
        pulse.join(5); failure.join(5)
        self.assertFalse(pulse.is_alive() or failure.is_alive())
        d.pulse()
        self.assertEqual([b.get('type', 'pulse') for b in bodies], ['pulse', 'ValueError'])

    def test_real_process_signals_and_atexit_record_before_shutdown(self):
        from pathlib import Path
        import tempfile
        # Only the sink and machine poweroff are doubles; Python dispatches the
        # real signals and exit hooks in a disposable child process.
        code = '''
import atexit, json, os, signal, sys
from pathlib import Path
import worker
out = Path(sys.argv[1])
class Sink:
    def put_object(self, **kw):
        with out.open('a') as f: f.write(kw['Body'].decode()+'\\n')
def run(d):
    d.bind(Sink(), 'control', 'heartbeat', 'key')
    d.enter('producer', 'execute')
    os.kill(os.getpid(), getattr(signal, sys.argv[2]))
def poweroff(*a, **kw):
    with out.open('a') as f: f.write('poweroff\\n')
worker.subprocess.run = poweroff
worker.run = run
if sys.argv[2] == 'atexit':
    d = worker.Diagnostics()
    d.bind(Sink(), 'control', 'heartbeat', 'key')
    d.enter('verifier', 'execute')
    atexit.register(d.terminated)
else:
    worker.main()
'''
        for mode in ('SIGTERM', 'SIGINT', 'SIGHUP', 'atexit'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)/'events'
                result = subprocess.run([sys.executable, '-c', code, str(out), mode],
                    cwd=Path(worker.__file__).parent, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                events = out.read_text().splitlines()
                self.assertEqual(json.loads(events[0]), {'schema': 'polis-probe-failure/1',
                    'stage': 'verifier' if mode == 'atexit' else 'producer', 'type': 'terminated'})
                self.assertEqual(events[1:], [] if mode == 'atexit' else ['poweroff'])

    def exercise_worker(self, failing_stage=None):
        import datetime as dt
        import tempfile
        from contextlib import ExitStack
        from pathlib import Path
        from unittest.mock import Mock
        j = job()
        j['reader'] = {'image': 'localhost/reader@sha256:'+'3'*64, 'args': ['read']}
        r = receipt(); r['job_sha256'] = sha(j)
        identity = dict(accountId='111111111111', region='us-east-1', instanceId='i-test', imageId='ami-test')
        admission = dict(job=j, ami='ami-test', started=1000,
                         expiresAt=dt.datetime.fromtimestamp(4600, dt.timezone.utc).isoformat())
        boot = dict(instanceId='i-test', admission=admission, admissionSha256=sha(admission),
            started=1000, terminateBy=4600, controlBucket='control', evidenceKey='key',
            assetBucket='assets', evidenceBucket='evidence', secretsUrl='fixture',
            secretArn='fixture', database='fixture', replicaHost='fixture.invalid')
        events = []
        sink = Mock()
        d = worker.Diagnostics()
        def get(**kw):
            if kw['Key'].startswith('boot/'):
                if failing_stage == 'boot':
                    return {'Body': io.BytesIO(canonical({**boot, 'admissionSha256': 'wrong'}))}
                return {'Body': io.BytesIO(canonical(boot))}
            if failing_stage == 'images': raise ValueError('IMAGE_CAPACITY')
            return {'Body': io.BytesIO(b'image'), 'ContentLength': 5}
        def put(**kw):
            self.assertEqual(kw['SSEKMSKeyId'], 'key')
            self.assertEqual(kw['ServerSideEncryption'], 'aws:kms')
            if kw['Key'].startswith('results/'):
                if failing_stage == 'receipt': raise ValueError('RECEIPT_FILE')
                events.append(('receipt', kw['Body']))
            else:
                body = json.loads(kw['Body'])
                events.append(('record' if 'schema' in body else 'pulse', body))
        sink.get_object.side_effect = get
        sink.put_object.side_effect = put
        secret = Mock()
        secret.get_secret_value.return_value = {'SecretString': json.dumps(
            {'username': 'polis_probe_reader', 'password': 'public-fixture-only'})}
        if failing_stage == 'secret': secret.get_secret_value.side_effect = ValueError('READER_SECRET')
        sdk = SimpleNamespace(client=lambda name, **kw: sink if name == 's3' else secret)
        relay = Mock()
        relay.__enter__ = Mock(return_value=relay)
        relay.__exit__ = Mock(side_effect=lambda *a: events.append(('relay-cleanup', None)) or False)
        relay.summary.return_value = {'relayed': 1}
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            root = Path(tmp)
            (root/'bootstrap.json').write_bytes(canonical(dict(account='111111111111', region='us-east-1', controlBucket='control')))
            def command(argv, **kw):
                if argv[0] == 'systemctl': events.append(('poweroff', None))
                elif 'rm' in argv: events.append(('container-cleanup', None))
                elif 'run' in argv and d.state[0] == 'verifier':
                    (root/'verdict/receipt.json').write_bytes(canonical(r))
                return SimpleNamespace(returncode=int('run' in argv and d.state[0] == failing_stage))
            stack.enter_context(patch.dict(sys.modules, {'boto3': sdk, 'botocore': SimpleNamespace(),
                'botocore.config': SimpleNamespace(Config=lambda **kw: kw)}))
            for name, value in [('ROOT', root), ('SCRATCH', root), ('Diagnostics', lambda: d),
                    ('metadata', lambda path: canonical(identity)), ('load_image', lambda *a: 'sha256:'+'a'*64),
                    ('ReplicaSocket', lambda *a: relay)]:
                stack.enter_context(patch.object(worker, name, value))
            stack.enter_context(patch.object(Path, 'is_mount', return_value=True))
            stack.enter_context(patch.object(worker.os, 'chown'))
            stack.enter_context(patch.object(worker.time, 'time', return_value=1000))
            stack.enter_context(patch.object(worker.shutil, 'disk_usage', return_value=SimpleNamespace(free=128*1024**3)))
            stack.enter_context(patch.object(worker.threading, 'Thread'))
            stack.enter_context(patch.object(worker.subprocess, 'run', side_effect=command))
            stack.enter_context(patch.object(worker.subprocess, 'check_output', side_effect=lambda *a, **k:
                canonical([{'State': {'ExitCode': int(d.state[0] == failing_stage), 'OOMKilled': False}}])))
            worker.main()
        return events, canonical(r)

    def test_actual_worker_pipeline_records_every_stage_before_cleanup(self):
        for stage in ('boot', 'images', 'secret', 'reader', 'producer', 'verifier', 'receipt'):
            with self.subTest(stage=stage):
                events, _ = self.exercise_worker(stage)
                records = [(i, value) for i, (kind, value) in enumerate(events) if kind == 'record']
                self.assertEqual(len(records), 1)
                index, record = records[0]
                self.assertEqual(record['stage'], stage)
                self.assertFalse(any(kind == 'receipt' for kind, _ in events))
                self.assertEqual(events[-1][0], 'poweroff')
                self.assertFalse(any(kind == 'pulse' for kind, _ in events[index+1:]))
                if stage == 'reader':
                    self.assertEqual([kind for kind, _ in events[index+1:]],
                                     ['container-cleanup', 'relay-cleanup', 'poweroff'])

    def test_actual_worker_success_keeps_receipt_bytes_and_has_no_failure(self):
        events, expected = self.exercise_worker()
        self.assertEqual([value for kind, value in events if kind == 'receipt'], [expected])
        self.assertFalse(any(kind == 'record' for kind, _ in events))
        pulses = [value for kind, value in events if kind == 'pulse']
        self.assertEqual([p['pulse'] for p in pulses], list(range(1, len(pulses)+1)))
        self.assertEqual(pulses[-1]['stage'], 'receipt')
        self.assertEqual(pulses[-1]['phase'], 'publish')
