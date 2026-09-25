"""Watch recovery contract: fake SDKs, a fake monotonic clock and scripted faults.

No boto3 construction, credentials or network. Each family below maps to one
acceptance family of the watch recovery contract; every schedule asserts the
mutations it performed as well as the exit, and that RunInstances never ran again.
"""
import contextlib
import datetime as dt
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import run
from run import Session, Unknown, WATCH_CEILING_SECONDS, WATCH_POLL_SECONDS, encoded, sha
from test_run import ApiError, Pages, QuietMonitoring, session_setup
from test_boundaries import job, receipt

RUN_ID = job()['run_id']
ARN = 'arn:aws:ec2:us-east-1:111111111111:instance/i-test'
RECEIPT_KEY = ('evidence', 'results/' + ARN + '/receipt.json')
UNRESOLVED = 'PROBE_UNRESOLVED: use status/cancel with the same run ID; never relaunch\n'
LINE = re.compile(r'PROBE_DIAGNOSTIC time=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ reason=[A-Z_]+'
                  r'( last=[A-Z_]+)? operation=[A-Z_]+ disposition=(refuse|retry|pending) attempt=[0-3]')
PRIVATE = 'private-zid-42 arn:aws:iam::111111111111:role/secret req-7f'
ALARMS = ('test-box-worker-' + RUN_ID + '-StatusCheckFailed',
          'test-box-worker-' + RUN_ID + '-StatusCheckFailed_System')


def sdk_type(name, base=Exception):
    """A fake SDK exception class, typed like the SDK's own module."""
    return type(name, (base,), {'__module__': 'botocore.exceptions'})


class ServiceError(Exception):
    """A fake service error: structured code and HTTP status plus hostile free text."""
    def __init__(self, code, status=400):
        super().__init__(PRIVATE)
        self.response = {'Error': {'Code': code, 'Message': PRIVATE},
                         'ResponseMetadata': {'HTTPStatusCode': status, 'RequestId': PRIVATE}}


class BrokenBody:
    def __init__(self, error): self.error = error
    def read(self, *a): raise self.error


TRANSIENT_CODES = sorted(run.TRANSIENT_CODES)
TRANSIENT_CAUSES = ([(code, lambda code=code: ServiceError(code, 400)) for code in TRANSIENT_CODES]
                    + [('http-%d' % s, lambda s=s: ServiceError('OddServerCondition', s)) for s in (429, 500, 502, 503, 504)]
                    + [(name, lambda name=name: sdk_type(name)(PRIVATE)) for name in sorted(run.TRANSIENT_SDK_TYPES)])
PERMANENT_CAUSES = [
    ('access-denied', lambda: ServiceError('AccessDenied', 403)),
    ('denied-with-503', lambda: ServiceError('AccessDenied', 503)),
    ('unauthorized-operation', lambda: ServiceError('UnauthorizedOperation', 403)),
    ('unexpected-code', lambda: ServiceError('OddClientCondition', 400)),
    ('no-response', lambda: ApiError(None)),
    ('ssl', lambda: sdk_type('SSLError')(PRIVATE)),
    ('proxy', lambda: sdk_type('ProxyConnectionError')(PRIVATE)),
    ('parse', lambda: sdk_type('ResponseParserError')(PRIVATE)),
    ('builtin-timeout', lambda: TimeoutError(PRIVATE)),
    ('builtin-connection', lambda: ConnectionError(PRIVATE)),
    ('key-error', lambda: KeyError(PRIVATE)),
    ('runtime', lambda: RuntimeError(PRIVATE)),
]
AUTH_CAUSES = ([(name, lambda name=name: sdk_type(name)(PRIVATE)) for name in sorted(run.AUTH_SDK_TYPES)]
               + [('provider-subclass', lambda: sdk_type('SomeProviderError', sdk_type('CredentialRetrievalError'))(PRIVATE))]
               + [(code, lambda code=code: ServiceError(code, 403)) for code in ('InvalidClientTokenId', 'SignatureDoesNotMatch', 'UnrecognizedClientException')])


class Alarms(QuietMonitoring):
    """Fake CloudWatch that logs calls into a shared event log."""
    def __init__(self, clock, events):
        super().__init__(clock); self.events = events
    def put_metric_alarm(self, **kw): self.events.append(('put', kw['AlarmName']))
    def delete_alarms(self, **kw): self.events.append(('delete', tuple(kw['AlarmNames'])))


class Box:
    """One launched worker run on fake SDKs, driven through run.main()."""

    def __init__(self, verdict='PASS', launch=True, state='terminated'):
        self.x, self.c, self.e, self.s, self.i = session_setup()
        self.events = []
        self.x.monitoring = Alarms(lambda: self.c.now, self.events)
        self.t = 1000.0
        self.sleeps, self.poll_times, self.hooks = [], [], {}
        # A fresh worker heartbeat unless a schedule says otherwise.
        self.s.head_object = lambda **kw: {'LastModified': dt.datetime.fromtimestamp(self.c.now - 5, dt.timezone.utc)}
        put = self.s.put_object
        def logged(**kw):
            result = put(**kw)
            if kw['Key'] == 'active.json':
                self.events.append(('cas', json.loads(kw['Body'])['phase']))
            return result
        self.s.put_object = logged
        if launch:
            self.x.start(job())
            self.runs = len(self.e.runs)
            assert self.runs == 1
        if verdict:
            value = receipt(); value['verdict'] = verdict
            if verdict == 'FAIL':
                value['entries'][0]['verdict'] = 'FAIL'
            self.s.objects[RECEIPT_KEY] = encoded(value)
        if state:
            self.i['State']['Name'] = state
        original = self.x.status
        def status(*a, **kw):
            n = len(self.poll_times)
            self.poll_times.append(self.t)
            for hook in self.hooks.get(n, ()):
                hook()
            return original(*a, **kw)
        self.x.status = status
        self.deletes_remove = True
        delete = self.e.delete_volume
        def delete_volume(**kw):
            delete(**kw)
            if self.deletes_remove:
                self.e.disks = [d for d in self.e.disks if d['VolumeId'] != kw['VolumeId']]
        self.e.delete_volume = delete_volume

    # scripted world
    def at(self, poll, hook):
        self.hooks.setdefault(poll, []).append(hook)

    def monotonic(self): return self.t

    def sleep(self, seconds):
        assert 0 < seconds <= WATCH_POLL_SECONDS
        self.sleeps.append(seconds); self.t += seconds; self.c.now += seconds

    def cli(self, action='watch', *extra, run_id=RUN_ID, allow_sleep=True):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps(self.x.cfg))
            argv = ['run.py', action, '--config', str(config), '--profile', 'fake']
            argv += ['--run-id', run_id] if run_id else []
            argv += list(extra)
            out, err = io.StringIO(), io.StringIO()
            clock = types.SimpleNamespace(monotonic=self.monotonic, time=lambda: self.c.now,
                                          sleep=self.sleep if allow_sleep else self.no_sleep)
            with patch.object(sys, 'argv', argv), \
                    patch.object(run, 'clients', return_value=(self.e, self.s, self.x.monitoring)), \
                    patch.object(run, 'Session', return_value=self.x), \
                    patch.object(run, 'time', clock), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = run.main()
        if hasattr(self, 'runs'):
            assert len(self.e.runs) == self.runs, 'RunInstances ran again'
        return rc, out.getvalue(), err.getvalue()

    @staticmethod
    def no_sleep(seconds):
        raise AssertionError('single-observation command slept')

    # observations
    def register(self): return self.x.active()[0]
    def control(self): return self.x.control(self.register())
    def record(self, name): return self.control().read(self.control().prefix + name)

    def observe(self):
        """One status observation as the CLI reports it: pending is incomplete."""
        try:
            return self.x.status(RUN_ID)
        except Unknown as error:
            if error.disposition != run.PENDING:
                raise
            return dict(run_id=RUN_ID, complete=False, passed=False)
    def keys(self): return [p['Key'] for p in self.s.puts]


def fail_when(target, method, errors, when=lambda kw: True):
    """Raise scripted errors from a fake SDK method for matching calls, then delegate."""
    original = getattr(target, method)
    queue = list(errors)
    hits = []
    def call(*a, **kw):
        if queue and when(kw):
            error = queue.pop(0)
            if error is not None:
                hits.append(kw.get('Key') or method)
                raise error() if callable(error) and not isinstance(error, BaseException) else error
        return original(*a, **kw)
    setattr(target, method, call)
    return hits


def fail_pages(ec2, name, errors):
    original = ec2.get_paginator
    queue = list(errors)
    def pages(requested):
        found = original(requested)
        if requested != name:
            return found
        def call(**kw):
            if queue:
                error = queue.pop(0)
                raise error() if callable(error) and not isinstance(error, BaseException) else error
            return found.call(**kw)
        return Pages(call)
    ec2.get_paginator = pages


def key_is(suffix):
    return lambda kw: kw.get('Key', '').endswith(suffix)


def terminal_cas(kw):
    return kw.get('Key') == 'active.json' and json.loads(kw['Body'])['phase'] == 'CLEAN'


def compete(box, change, error, phase='CLEAN'):
    """A scripted concurrent writer replaces the register once, during the terminal CAS."""
    fired = []
    def put(**kw):
        if terminal_cas(kw) and not fired:
            fired.append(True)
            current = json.loads(box.s.objects['control', 'active.json'])
            value = dict(current, phase=phase, nonce='b' * 32, **change)
            box.s.objects['control', 'active.json'] = encoded(value)
            raise error
        return original(**kw)
    original = box.s.put_object
    box.s.put_object = lambda **kw: put(**kw)


class Checks(unittest.TestCase):
    def closed_output(self, out, err, rc):
        for line in err.splitlines():
            self.assertRegex(line, LINE)
            self.assertEqual(LINE.fullmatch(line) is not None, True, line)
        for text in (out, err):
            for word in ('private', 'zid', 'arn:', 'req-', 'secret', 'Traceback'):
                self.assertNotIn(word, text)
        if rc == 2:
            self.assertEqual(out, UNRESOLVED)

    def last_diagnostic(self, err):
        return dict(field.split('=', 1) for field in err.strip().splitlines()[-1].split()[1:])

    def passed(self, box, rc, out, err, polls=None):
        self.closed_output(out, err, rc)
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out), dict(run_id=RUN_ID, complete=True, passed=True))
        self.assertEqual(box.register()['phase'], 'CLEAN')
        if polls is not None:
            self.assertEqual(len(box.poll_times), polls)

    def refused(self, box, rc, out, err, reason=None, polls=1):
        self.closed_output(out, err, rc)
        self.assertEqual(rc, 2)
        self.assertEqual(len(box.poll_times), polls)
        if reason:
            self.assertEqual(self.last_diagnostic(err)['reason'], reason)


# Where each allowed transient read/alarm/lifecycle-write operation fails in a
# terminal (instance terminated, PASS receipt stored) observation.
def arm(box, operation, cause):
    s, e = box.s, box.e
    if operation == 'ACTIVE_GET':
        fail_when(s, 'get_object', [cause], key_is('active.json'))
    elif operation == 'CONTROL_GET':
        fail_when(s, 'get_object', [cause], key_is('claim.json'))
    elif operation == 'CONTROL_GET_BODY':
        original = s.get_object
        queue = [cause]
        def get(**kw):
            found = original(**kw)
            if queue and kw['Key'].endswith('claim.json'):
                found['Body'] = BrokenBody(queue.pop(0)())
            return found
        s.get_object = get
    elif operation == 'RECEIPT_GET':
        fail_when(s, 'get_object', [cause], lambda kw: kw['Bucket'] == 'evidence')
    elif operation == 'RECEIPT_GET_BODY':
        original = s.get_object
        queue = [cause]
        def get(**kw):
            found = original(**kw)
            if queue and kw['Bucket'] == 'evidence':
                found['Body'] = BrokenBody(queue.pop(0)())
            return found
        s.get_object = get
    elif operation == 'INSTANCE_DESCRIBE':
        fail_pages(e, 'describe_instances', [cause])
    elif operation == 'INSTANCE_DESCRIBE_BY_ID':
        e.instances = []
        fail_when(e, 'describe_instances', [cause])
    elif operation == 'VOLUME_DESCRIBE':
        fail_pages(e, 'describe_volumes', [cause])
    elif operation == 'VOLUME_DESCRIBE_BY_ID':
        fail_when(e, 'describe_volumes', [cause])
    elif operation == 'ALARM_DELETE':
        fail_when(box.x.monitoring, 'delete_alarms', [cause])
    elif operation == 'RECORD_PUT':
        fail_when(s, 'put_object', [cause], key_is('clean.json'))
    elif operation == 'TERMINAL_CAS':
        fail_when(s, 'put_object', [cause], terminal_cas)
    elif operation == 'VOLUME_DELETE':
        e.disks = [{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []}]
        fail_when(e, 'delete_volume', [cause])
    else:
        raise AssertionError(operation)


TERMINAL_OPERATIONS = ('ACTIVE_GET', 'CONTROL_GET', 'CONTROL_GET_BODY', 'RECEIPT_GET', 'RECEIPT_GET_BODY',
                       'INSTANCE_DESCRIBE', 'INSTANCE_DESCRIBE_BY_ID', 'VOLUME_DESCRIBE',
                       'VOLUME_DESCRIBE_BY_ID', 'ALARM_DELETE', 'RECORD_PUT', 'TERMINAL_CAS', 'VOLUME_DELETE')


class TransientRecoveryTests(Checks):
    """Family 1: transient causes recover on the first and a later poll; three
    consecutive failures stop; permanent/unknown causes stop at once."""

    def schedule(self, operation, cause, later):
        box = Box(state='running' if later else 'terminated')
        if later:
            # A normal running poll first; the instance ends before the next one.
            def finish():
                box.i['State']['Name'] = 'terminated'
                arm(box, operation, cause)
            box.at(1, finish)
        else:
            arm(box, operation, cause)
        return box

    def test_every_transient_cause_recovers_on_first_and_later_poll(self):
        expected = {'ACTIVE_GET': 'CONTROL_READ_UNKNOWN', 'VOLUME_DESCRIBE_BY_ID': 'DISK_DESCRIBE_UNKNOWN',
                    'ALARM_DELETE': 'ALARM_UNKNOWN'}
        for later in (False, True):
            for operation, reason in expected.items():
                for name, cause in TRANSIENT_CAUSES:
                    with self.subTest(later=later, operation=operation, cause=name):
                        box = self.schedule(operation, cause, later)
                        rc, out, err = box.cli()
                        self.passed(box, rc, out, err, polls=3 if later else 2)
                        retry = self.last_diagnostic(err)
                        self.assertEqual((retry['reason'], retry['operation'], retry['disposition'], retry['attempt']),
                                         (reason, operation, 'retry', '1'))

    def test_every_permitted_operation_recovers_on_first_and_later_poll(self):
        for later in (False, True):
            for operation in TERMINAL_OPERATIONS:
                for name, cause in (('Throttling', lambda: ServiceError('Throttling')),
                                    ('ReadTimeoutError', lambda: sdk_type('ReadTimeoutError')(PRIVATE))):
                    with self.subTest(later=later, operation=operation, cause=name):
                        box = self.schedule(operation, cause, later)
                        rc, out, err = box.cli()
                        self.passed(box, rc, out, err, polls=3 if later else 2)
                        self.assertEqual(self.last_diagnostic(err)['disposition'], 'retry')
                        # Deletion may repeat idempotently; it always precedes the close.
                        self.assertEqual({n for k, n in box.events if k == 'delete'}, {ALARMS})
                        closing = box.events.index(('cas', 'CLEAN'))
                        self.assertEqual(box.events[closing - 1], ('delete', ALARMS))
                        self.assertEqual([k for k in box.keys() if k.endswith('clean.json')], ['control/%s/clean.json' % RUN_ID])

    def test_running_poll_reads_and_alarm_creation_recover(self):
        for operation in ('HEARTBEAT_HEAD', 'ALARM_PUT'):
            for name, cause in (('ServiceUnavailable', lambda: ServiceError('ServiceUnavailable', 503)),
                                ('EndpointConnectionError', lambda: sdk_type('EndpointConnectionError')(PRIVATE))):
                with self.subTest(operation=operation, cause=name):
                    box = Box(state='running')
                    if operation == 'HEARTBEAT_HEAD':
                        box.c.now += 601  # past boot grace: the heartbeat object is read
                        fail_when(box.s, 'head_object', [cause])
                    else:
                        fail_when(box.x.monitoring, 'put_metric_alarm', [cause])
                    box.at(2, lambda: box.i['State'].update(Name='terminated'))
                    rc, out, err = box.cli()
                    self.passed(box, rc, out, err, polls=3)
                    self.assertFalse(box.e.terminated)

    def test_three_consecutive_failures_stop_even_across_operations(self):
        schedules = {
            'same-operation': lambda box: fail_when(box.s, 'get_object', [ServiceError('SlowDown', 503)] * 3, key_is('active.json')),
            'alternating': lambda box: (
                fail_when(box.s, 'get_object', [ServiceError('SlowDown', 503), None, None], key_is('active.json')),
                fail_pages(box.e, 'describe_instances', [None, sdk_type('ConnectionClosedError')(PRIVATE)]),
                fail_when(box.x.monitoring, 'delete_alarms', [None, ServiceError('Throttling')])),
        }
        for name, script in schedules.items():
            with self.subTest(schedule=name):
                box = Box()
                if name == 'alternating':
                    # Poll 1 fails on the register, poll 2 on DescribeInstances,
                    # poll 3 on alarm deletion: three categories, one counter.
                    fail_when(box.s, 'get_object', [ServiceError('SlowDown', 503)], key_is('active.json'))
                    box.at(1, lambda: fail_pages(box.e, 'describe_instances', [sdk_type('ConnectionClosedError')(PRIVATE)]))
                    box.at(2, lambda: fail_when(box.x.monitoring, 'delete_alarms', [ServiceError('Throttling')]))
                else:
                    script(box)
                rc, out, err = box.cli()
                self.refused(box, rc, out, err, 'RETRY_EXHAUSTED', polls=3)
                self.assertEqual(self.last_diagnostic(err)['attempt'], '3')
                self.assertEqual(len(box.sleeps), 2)
                self.assertEqual(box.register()['phase'], 'INTENT')
                self.assertNotIn(('cas', 'CLEAN'), box.events)

    def test_two_failures_then_success_passes(self):
        box = Box()
        fail_when(box.s, 'get_object', [ServiceError('InternalError', 500)] * 2, key_is('active.json'))
        rc, out, err = box.cli()
        self.passed(box, rc, out, err, polls=3)

    def test_permanent_and_unknown_causes_stop_at_once(self):
        for operation in ('ACTIVE_GET', 'INSTANCE_DESCRIBE', 'VOLUME_DESCRIBE_BY_ID', 'ALARM_DELETE',
                          'RECEIPT_GET', 'TERMINAL_CAS', 'RECORD_PUT', 'VOLUME_DELETE'):
            for name, cause in PERMANENT_CAUSES:
                with self.subTest(operation=operation, cause=name):
                    box = Box()
                    arm(box, operation, cause)
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err)
                    self.assertEqual(self.last_diagnostic(err)['disposition'], 'refuse')
                    # Only the receipt read happens after the close.
                    self.assertEqual(box.register()['phase'], 'CLEAN' if operation == 'RECEIPT_GET' else 'INTENT')

    def test_exhaustion_prints_no_free_text(self):
        box = Box()
        fail_when(box.s, 'get_object', [ServiceError('Throttling', 400)] * 3, key_is('active.json'))
        rc, out, err = box.cli()
        self.assertEqual(out, UNRESOLVED)
        lines = err.strip().splitlines()
        self.assertEqual(len(lines), 4)
        self.assertEqual([self.last_diagnostic(l)['reason'] for l in lines],
                         ['CONTROL_READ_UNKNOWN'] * 3 + ['RETRY_EXHAUSTED'])
        self.assertEqual(self.last_diagnostic(err)['last'], 'CONTROL_READ_UNKNOWN')
        self.closed_output(out, err, rc)

    def test_lifecycle_write_retry_is_a_fresh_observation(self):
        # The clean.json create is not replayed blindly: the second poll
        # re-reads the register and re-observes the instance and disks first.
        box = Box()
        describes = []
        original = box.e.get_paginator
        box.e.get_paginator = lambda name: (describes.append(name), original(name))[1]
        fail_when(box.s, 'put_object', [ServiceError('RequestTimeout', 408)], key_is('clean.json'))
        rc, out, err = box.cli()
        self.passed(box, rc, out, err, polls=2)
        self.assertEqual(describes.count('describe_instances'), 2)
        self.assertEqual(len([k for k in box.keys() if k.endswith('clean.json')]), 1)


class ShutdownMetadataTests(Checks):
    """Family 2: absent network/profile fields only in the two final states."""
    missing = [('SubnetId', None), ('SecurityGroups', []), ('IamInstanceProfile', None)]

    def test_every_missing_field_combination_accepted_in_final_states(self):
        for state in ('shutting-down', 'terminated'):
            for mask in range(8):
                for delete in (False, True):
                    with self.subTest(state=state, mask=mask, delete=delete):
                        box = Box(state=state)
                        for bit, (field, value) in enumerate(self.missing):
                            if mask >> bit & 1:
                                if delete:
                                    del box.i[field]
                                else:
                                    box.i[field] = value
                        puts, events = len(box.s.puts), len(box.events)
                        result = box.x.status(RUN_ID)
                        self.assertEqual(result['complete'], state == 'terminated')
                        self.assertFalse(box.e.terminated); self.assertFalse(box.e.deleted)
                        self.assertNotIn(('put', ALARMS[0]), box.events[events:])
                        if state == 'shutting-down':
                            self.assertEqual(box.s.puts[puts:], [])
                            self.assertIsNone(box.record('clean.json'))
                        else:
                            self.assertTrue(result['passed'])

    def test_wrong_nonempty_identity_refuses_in_final_states(self):
        wrong = [('ClientToken', 'wrong'), ('ImageId', 'wrong'), ('InstanceType', 'wrong'), ('Tags', []),
                 ('Tags', [{'Key': 'polis:probe-run', 'Value': 'b' * 32}, {'Key': 'polis:probe-box', 'Value': 'test-box'}]),
                 ('Tags', [{'Key': 'polis:probe-run', 'Value': RUN_ID}, {'Key': 'polis:probe-box', 'Value': 'other'}]),
                 ('PublicIpAddress', '192.0.2.1'), ('SubnetId', 'wrong'),
                 ('SecurityGroups', [{'GroupId': 'wrong'}]), ('IamInstanceProfile', {'Arn': 'wrong'})]
        for state in ('shutting-down', 'terminated'):
            for field, value in wrong:
                with self.subTest(state=state, field=field, value=value):
                    box = Box(state=state); box.i[field] = value
                    puts = len(box.s.puts)
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err, 'INSTANCE_OWNERSHIP_UNKNOWN')
                    self.assertEqual(box.s.puts[puts:], [])
                    self.assertFalse(box.e.terminated); self.assertFalse(box.e.deleted)

    def test_absence_refuses_in_active_states_and_unknown_states_refuse(self):
        for state in ('pending', 'running', 'stopping', 'stopped'):
            for field, value in self.missing:
                with self.subTest(state=state, field=field):
                    box = Box(state=state); box.i[field] = value
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err, 'INSTANCE_OWNERSHIP_UNKNOWN')
                    self.assertFalse(box.e.terminated)
        for state in ('rebooting', 'unknown', '', None):
            with self.subTest(state=state):
                box = Box(state='running'); box.c.now = box.c.expiry  # expiry would otherwise terminate
                box.i['State']['Name'] = state
                puts = len(box.s.puts)
                rc, out, err = box.cli(allow_sleep=False)
                self.refused(box, rc, out, err, 'INSTANCE_OWNERSHIP_UNKNOWN')
                self.assertEqual(box.s.puts[puts:], [])
                self.assertFalse(box.e.terminated); self.assertFalse(box.e.deleted)
        box = Box(state='running'); del box.i['State']
        rc, out, err = box.cli(allow_sleep=False)
        self.refused(box, rc, out, err)
        self.assertFalse(box.e.terminated)


def maps(*ids):
    return [{'Ebs': {'VolumeId': v}} for v in ids]


class DiskMapTests(Checks):
    """Family 3: partial mappings in final states against a complete bound P."""
    views = [(), ('vol-a',), ('vol-b',), ('vol-a', 'vol-b'), ('vol-b', 'vol-a')]

    def test_shutting_down_subsets_are_pending_without_mutation(self):
        for view in self.views:
            with self.subTest(view=view):
                box = Box(state='shutting-down'); box.i['BlockDeviceMappings'] = maps(*view)
                box.c.now = box.c.expiry  # an expired run is not terminated a second time
                box.e.disks = [{'VolumeId': v, 'State': 'in-use', 'Attachments': [{'InstanceId': 'i-test'}]} for v in view]
                puts, events = len(box.s.puts), len(box.events)
                self.assertEqual(box.x.status(RUN_ID), dict(run_id=RUN_ID, complete=False, passed=False))
                self.assertEqual(box.s.puts[puts:], []); self.assertEqual(box.events[events:], [])
                self.assertFalse(box.e.terminated); self.assertFalse(box.e.deleted)
                self.assertEqual(box.register()['phase'], 'INTENT')

    def test_terminated_subsets_clean_only_after_both_ids_absent(self):
        for view in self.views:
            with self.subTest(view=view):
                box = Box(); box.i['BlockDeviceMappings'] = maps(*view)
                box.deletes_remove = False
                box.e.disks = [{'VolumeId': v, 'State': 'available', 'Attachments': []} for v in ('vol-a', 'vol-b')]
                self.assertFalse(box.observe()['complete'])
                self.assertEqual(sorted(box.e.deleted), ['vol-a', 'vol-b'])
                self.assertIsNone(box.record('clean.json'))
                box.e.disks = [box.e.disks[0]]
                self.assertFalse(box.observe()['complete'])
                self.assertIsNone(box.record('clean.json'))
                lookups = []
                original = box.e.describe_volumes
                box.e.describe_volumes = lambda VolumeIds: (lookups.append(VolumeIds[0]), original(VolumeIds=VolumeIds))[1]
                box.e.disks = []
                self.assertEqual(box.x.status(RUN_ID), dict(run_id=RUN_ID, complete=True, passed=True))
                self.assertEqual(sorted(lookups), ['vol-a', 'vol-b'])
                self.assertEqual(box.record('clean.json')['volumes'], ['vol-a', 'vol-b'])
                self.assertFalse(box.e.terminated)

    def test_bad_recorded_inventory_refuses(self):
        prefix = 'control/%s/' % RUN_ID
        bad = {'missing': None,
               'partial': {'id': 'i-test', 'volumes': ['vol-a'], 'admissionSha256': None},
               'duplicate': {'id': 'i-test', 'volumes': ['vol-a', 'vol-a'], 'admissionSha256': None},
               'oversize': {'id': 'i-test', 'volumes': ['vol-a', 'vol-b', 'vol-c'], 'admissionSha256': None},
               'malformed': {'id': 'i-test', 'volumes': ['vol-a', 7], 'admissionSha256': None},
               'extra-field': {'id': 'i-test', 'volumes': ['vol-a', 'vol-b'], 'admissionSha256': None, 'x': 1},
               'wrong-admission': {'id': 'i-test', 'volumes': ['vol-a', 'vol-b'], 'admissionSha256': '0' * 64},
               'wrong-instance': {'id': 'i-other', 'volumes': ['vol-a', 'vol-b'], 'admissionSha256': None}}
        for state in ('shutting-down', 'terminated'):
            for name, value in bad.items():
                with self.subTest(state=state, inventory=name):
                    box = Box(state=state); box.i['BlockDeviceMappings'] = maps('vol-a')
                    token = box.control().token
                    if value is None:
                        del box.s.objects['control', prefix + 'instance.json']
                    else:
                        value = dict(value, admissionSha256=value['admissionSha256'] or token)
                        box.s.objects['control', prefix + 'instance.json'] = encoded(value)
                    puts = len(box.s.puts)
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err)
                    self.assertIn(self.last_diagnostic(err)['reason'], ('DISK_INVENTORY_UNKNOWN', 'INSTANCE_CHANGED'))
                    self.assertEqual(box.s.puts[puts:], [])
                    self.assertFalse(box.e.deleted); self.assertFalse(box.e.terminated)

    def test_bad_current_mappings_refuse(self):
        bad = {'duplicate': maps('vol-a', 'vol-a'), 'new': maps('vol-a', 'vol-c'), 'foreign-only': maps('vol-c'),
               'oversize': maps('vol-a', 'vol-b', 'vol-c'), 'empty-ebs': [{'Ebs': {}}],
               'numeric-id': [{'Ebs': {'VolumeId': 7}}], 'ebs-text': [{'Ebs': 'vol-a'}],
               'mapping-text': ['vol-a'], 'not-a-list': 'vol-a', 'bad-id': maps('vol-A!')}
        for state in ('pending', 'running', 'shutting-down', 'terminated'):
            for name, value in bad.items():
                with self.subTest(state=state, mappings=name):
                    box = Box(state=state); box.i['BlockDeviceMappings'] = value
                    puts = len(box.s.puts)
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err)
                    self.assertIn(self.last_diagnostic(err)['reason'], ('DISK_INVENTORY_UNKNOWN', 'INSTANCE_CHANGED'))
                    self.assertEqual(box.s.puts[puts:], [])
                    self.assertFalse(box.e.deleted); self.assertFalse(box.e.terminated)

    def test_foreign_disks_and_attachments_refuse_without_partial_mutation(self):
        cases = {
            'tagged-foreign': ([{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []},
                                {'VolumeId': 'vol-c', 'State': 'available', 'Attachments': []}], 'UNKNOWN_DISK'),
            'foreign-attachment': ([{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []},
                                    {'VolumeId': 'vol-b', 'State': 'in-use', 'Attachments': [{'InstanceId': 'i-other'}]}],
                                   'DISK_ATTACHMENT_FOREIGN'),
            'malformed-attachment': ([{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []},
                                      {'VolumeId': 'vol-b', 'State': 'in-use', 'Attachments': 'i-test'}],
                                     'DISK_ATTACHMENT_FOREIGN'),
            'attachment-without-instance': ([{'VolumeId': 'vol-b', 'State': 'in-use', 'Attachments': [{}]}],
                                            'DISK_ATTACHMENT_FOREIGN'),
            'duplicate-tagged': ([{'VolumeId': 'vol-a', 'State': 'available'}] * 2, 'DISK_INVENTORY_UNKNOWN'),
            'malformed-tagged': ([{'VolumeId': None}], 'DISK_INVENTORY_UNKNOWN'),
        }
        for name, (disks, reason) in cases.items():
            with self.subTest(case=name):
                box = Box(); box.e.disks = disks
                puts = len(box.s.puts)
                rc, out, err = box.cli(allow_sleep=False)
                self.refused(box, rc, out, err, reason)
                self.assertFalse(box.e.deleted)
                self.assertEqual(box.s.puts[puts:], [])
                self.assertIsNone(box.record('clean.json'))

    def test_by_id_answer_for_another_volume_refuses(self):
        box = Box()
        box.e.describe_volumes = lambda VolumeIds: {'Volumes': [{'VolumeId': 'vol-z', 'State': 'available'}]}
        rc, out, err = box.cli(allow_sleep=False)
        self.refused(box, rc, out, err, 'DISK_DESCRIBE_UNKNOWN')
        self.assertFalse(box.e.deleted)

    def test_attaching_regressions_preserved(self):
        for state in ('pending', 'running'):
            for view in ((), ('vol-a',), ('vol-b',)):
                with self.subTest(state=state, view=view):
                    box = Box(state=state); box.i['BlockDeviceMappings'] = maps(*view)
                    puts = len(box.s.puts)
                    self.assertEqual(box.x.status(RUN_ID), dict(run_id=RUN_ID, complete=False, passed=False))
                    self.assertEqual(box.control().read(box.control().prefix + 'instance.json')['volumes'], ['vol-a', 'vol-b'])
                    self.assertFalse([k for k in box.keys()[puts:] if k.startswith('boot/') or k.endswith('clean.json')])
                    self.assertFalse(box.e.terminated)

    def test_stopping_and_stopped_require_full_mappings(self):
        for state in ('stopping', 'stopped'):
            for view in ((), ('vol-a',)):
                with self.subTest(state=state, view=view):
                    box = Box(state=state); box.i['BlockDeviceMappings'] = maps(*view)
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err, 'INSTANCE_CHANGED')
                    self.assertFalse(box.e.terminated)
            with self.subTest(state=state, view='full'):
                box = Box(state=state); mark = len(box.events)
                self.assertFalse(box.x.status(RUN_ID)['complete'])
                self.assertFalse(box.e.terminated)
                self.assertNotIn('put', [kind for kind, _ in box.events[mark:]])


class DisposalScheduleTests(Checks):
    """Family 4: detaching/deleting/still-present schedules, empty describes,
    tag-independent lookups, and delete acknowledgement is never CLEAN."""

    def test_detaching_then_available_then_absent_passes(self):
        box = Box()
        box.e.disks = [{'VolumeId': v, 'State': 'in-use', 'Attachments': [{'InstanceId': 'i-test', 'State': 'detaching'}]}
                       for v in ('vol-a', 'vol-b')]
        box.at(2, lambda: box.e.disks.__setitem__(slice(None), [{'VolumeId': v, 'State': 'available', 'Attachments': []} for v in ('vol-a', 'vol-b')]))
        rc, out, err = box.cli()
        self.passed(box, rc, out, err, polls=3)
        self.assertEqual(sorted(box.e.deleted), ['vol-a', 'vol-b'])
        self.assertEqual(err, '')  # pending states are not failures

    def test_deleting_and_still_present_owned_volumes_eventually_pass(self):
        for state in ('deleting', 'available'):
            with self.subTest(state=state):
                box = Box(); box.deletes_remove = False
                box.e.disks = [{'VolumeId': 'vol-a', 'State': state, 'Attachments': []}]
                box.at(4, lambda: box.e.disks.clear())
                rc, out, err = box.cli()
                self.passed(box, rc, out, err, polls=5)
                self.assertEqual(err, '')

    def test_volume_in_use_on_delete_is_pending_only_for_the_bound_instance(self):
        for owner, expected in (('i-test', 0), ('i-other', 2)):
            with self.subTest(owner=owner):
                box = Box()
                box.e.disks = [{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []}]
                def attach():
                    box.e.disks = [{'VolumeId': 'vol-a', 'State': 'in-use', 'Attachments': [{'InstanceId': owner}]}]
                    raise ServiceError('VolumeInUse')
                queue = [attach]
                original = box.e.delete_volume
                box.e.delete_volume = lambda **kw: queue.pop(0)() if queue else original(**kw)
                box.at(1, lambda: box.e.disks.__setitem__(slice(None), [{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []}]))
                rc, out, err = box.cli()
                self.assertEqual(rc, expected, err)
                self.closed_output(out, err, rc)
                if expected:
                    self.assertEqual(self.last_diagnostic(err)['reason'], 'DISK_ATTACHMENT_FOREIGN')
                    self.assertIsNone(box.record('clean.json'))

    def test_empty_describe_success_stays_refused(self):
        box = Box()
        box.e.describe_volumes = lambda VolumeIds: {'Volumes': []}
        box.at(1, lambda: self.fail('a refusal is not observed again'))
        rc, out, err = box.cli(allow_sleep=False)
        self.refused(box, rc, out, err, 'DISK_DESCRIBE_EMPTY')
        self.assertIsNone(box.record('clean.json'))

    def test_missing_tags_cannot_hide_a_disk_found_by_id(self):
        box = Box(); box.deletes_remove = False
        by_id = [{'VolumeId': 'vol-b', 'State': 'available', 'Attachments': []}]
        box.e.get_paginator = lambda name: Pages(lambda **kw: [{'Volumes': []}]) if name == 'describe_volumes' \
            else Pages(lambda **kw: [{'Reservations': [{'Instances': box.e.instances}]}])
        box.e.describe_volumes = lambda VolumeIds: ({'Volumes': [v for v in by_id if v['VolumeId'] in VolumeIds]}
                                                    if any(v['VolumeId'] in VolumeIds for v in by_id)
                                                    else (_ for _ in ()).throw(ApiError('InvalidVolume.NotFound')))
        for _ in range(3):
            self.assertEqual(box.observe()['complete'], False)
        self.assertEqual(box.e.deleted, ['vol-b'] * 3)
        self.assertIsNone(box.record('clean.json'))
        self.assertEqual(box.register()['phase'], 'INTENT')

    def test_delete_acknowledgement_with_pass_receipt_never_closes(self):
        box = Box(); box.deletes_remove = False
        box.e.disks = [{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []}]
        with patch.object(run, 'WATCH_CEILING_SECONDS', 300):
            rc, out, err = box.cli()
        self.refused(box, rc, out, err, 'WATCH_CEILING', polls=10)
        self.assertEqual(self.last_diagnostic(err)['last'], 'DISK_REMAINS')
        self.assertEqual(box.e.deleted, ['vol-a'] * 10)
        self.assertIsNone(box.record('clean.json'))
        self.assertEqual(box.register()['phase'], 'INTENT')
        self.assertNotIn('delete', [kind for kind, _ in box.events])


class TerminalCasTests(Checks):
    """Family 5: same-bound terminal CAS races resolve; anything else refuses."""

    def competitor(self, box, change, error, phase='CLEAN'):
        compete(box, change, error, phase)

    def test_lost_acknowledgement_and_concurrent_winner_succeed(self):
        box = Box(); put = box.s.put_object
        def lost(**kw):
            result = put(**kw)
            if terminal_cas(kw):
                raise sdk_type('ReadTimeoutError')(PRIVATE)
            return result
        box.s.put_object = lost
        rc, out, err = box.cli(allow_sleep=False)
        self.passed(box, rc, out, err, polls=1)
        for error in (ServiceError('PreconditionFailed', 412), ServiceError('SlowDown', 503)):
            with self.subTest(error=error.response['Error']['Code']):
                box = Box(); self.competitor(box, {}, error)
                rc, out, err = box.cli(allow_sleep=False)
                self.passed(box, rc, out, err, polls=1)
                self.assertEqual(box.register()['nonce'], 'b' * 32)

    def test_same_bound_intent_is_closed_again_with_a_fresh_etag(self):
        box = Box(); self.competitor(box, {}, ServiceError('PreconditionFailed', 412), phase='INTENT')
        fresh = []
        box.at(1, lambda: fresh.append(box.x.active()[1]))
        rc, out, err = box.cli()
        self.passed(box, rc, out, err, polls=2)
        closing = [p for p in box.s.puts if terminal_cas(p)]
        self.assertEqual(closing[-1]['IfMatch'], fresh[0])
        self.assertEqual(self.last_diagnostic(err)['reason'], 'ACTIVE_CONFLICT')
        self.assertEqual(box.register()['generation'], json.loads(closing[-1]['Body'])['generation'])

    def test_transient_unwritten_close_is_retried_by_the_next_observation(self):
        box = Box()
        fail_when(box.s, 'put_object', [ServiceError('ServiceUnavailable', 503)], terminal_cas)
        rc, out, err = box.cli()
        self.passed(box, rc, out, err, polls=2)

    def test_foreign_binding_or_phase_refuses(self):
        admission = lambda box: dict(box.register()['admission'], started=box.register()['admission']['started'] + 1)
        config = lambda box: dict(box.register()['admission'], configSha256='0' * 64)
        other_run = lambda box: dict(box.register()['admission'], id='b' * 32)
        cases = {'generation': lambda box: {'generation': 'c' * 32},
                 'admission': lambda box: {'admission': admission(box)},
                 'configuration': lambda box: {'admission': config(box)},
                 'run': lambda box: {'admission': other_run(box)}}
        for phase in ('CLEAN', 'INTENT'):
            for name, change in cases.items():
                with self.subTest(phase=phase, change=name):
                    box = Box()
                    self.competitor(box, change(box), ServiceError('PreconditionFailed', 412), phase=phase)
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err, 'ACTIVE_CONFLICT')
        box = Box(); self.competitor(box, {}, ServiceError('PreconditionFailed', 412), phase='RESERVED')
        rc, out, err = box.cli(allow_sleep=False)
        self.refused(box, rc, out, err, 'ACTIVE_CONFLICT')

    def test_mismatched_cleanup_record_refuses(self):
        prefix = 'control/%s/' % RUN_ID
        for phase in ('CLEAN', 'INTENT'):
            for change in ({'volumes': ['vol-a', 'vol-c']}, {'instanceId': 'i-other'}, {'status': 'DIRTY'},
                           {'admissionSha256': '0' * 64}, {'private': True}):
                with self.subTest(phase=phase, change=change):
                    box = Box(); original = box.s.put_object
                    def put(**kw):
                        if terminal_cas(kw):
                            clean = json.loads(box.s.objects['control', prefix + 'clean.json'])
                            box.s.objects['control', prefix + 'clean.json'] = encoded(dict(clean, **change))
                            current = json.loads(box.s.objects['control', 'active.json'])
                            box.s.objects['control', 'active.json'] = encoded(dict(current, phase=phase, nonce='b' * 32))
                            raise ServiceError('PreconditionFailed', 412)
                        return original(**kw)
                    box.s.put_object = put
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err, 'CLEAN_RECORD_INVALID')

    def test_permanent_close_failure_is_not_masked_by_readback(self):
        box = Box()
        self.competitor(box, {}, ServiceError('AccessDenied', 403))
        rc, out, err = box.cli(allow_sleep=False)
        self.refused(box, rc, out, err, 'ACTIVE_CONFLICT')
        box = Box()
        fail_when(box.s, 'put_object', [ServiceError('AccessDenied', 403)], terminal_cas)
        rc, out, err = box.cli(allow_sleep=False)
        self.refused(box, rc, out, err, 'ACTIVE_CONFLICT')
        self.assertEqual(box.register()['phase'], 'INTENT')

    def test_changed_binding_between_polls_refuses_before_mutation(self):
        for field in ('generation', 'admission'):
            with self.subTest(field=field):
                box = Box(state='running')
                def replace():
                    current = json.loads(box.s.objects['control', 'active.json'])
                    if field == 'generation':
                        current['generation'] = 'c' * 32
                    else:
                        current['admission'] = dict(current['admission'], started=current['admission']['started'] + 1)
                    box.s.objects['control', 'active.json'] = encoded(current)
                    box.i['State']['Name'] = 'terminated'
                box.at(1, replace)
                puts = []
                box.at(1, lambda: puts.append(len(box.s.puts)))
                rc, out, err = box.cli()
                self.refused(box, rc, out, err, 'BINDING_CHANGED', polls=2)
                self.assertEqual(len(box.s.puts), puts[0])
                self.assertFalse(box.e.deleted)

    def test_launch_cas_races_still_refuse(self):
        x, c, e, s, i = session_setup(); put = s.put_object
        def race(**kw):
            if kw['Key'] == 'active.json' and json.loads(kw['Body'])['phase'] == 'INTENT':
                competitor = dict(json.loads(kw['Body']), nonce='b' * 32)
                s.objects['control', 'active.json'] = encoded(competitor)
                raise ServiceError('PreconditionFailed', 412)
            return put(**kw)
        s.put_object = race
        with self.assertRaisesRegex(Unknown, 'ACTIVE_CONFLICT'):
            x.start(job())
        self.assertEqual(e.runs, [])

    def test_missing_or_malformed_register_refuses(self):
        for body in (None, b'{', encoded([]), encoded({'generation': 'a' * 32})):
            with self.subTest(body=body):
                box = Box()
                if body is None:
                    del box.s.objects['control', 'active.json']
                else:
                    box.s.objects['control', 'active.json'] = body
                rc, out, err = box.cli(allow_sleep=False)
                self.refused(box, rc, out, err)
                self.assertIn(self.last_diagnostic(err)['reason'], ('RUN_CONFLICT', 'CONTROL_SCHEMA'))
                self.assertFalse(box.e.deleted)


class AlarmCleanupTests(Checks):
    """Family 6: alarm deletion is lifecycle cleanup before the terminal CAS."""

    def test_put_failure_then_terminal_poll_cleans_without_recreating(self):
        box = Box(state='running')
        fail_when(box.x.monitoring, 'put_metric_alarm', [ServiceError('Throttling')])
        mark = []
        box.at(1, lambda: (box.i['State'].update(Name='terminated'), mark.append(len(box.events))))
        rc, out, err = box.cli()
        self.passed(box, rc, out, err, polls=2)
        after = box.events[mark[0]:]
        self.assertNotIn('put', [kind for kind, _ in after])
        self.assertEqual(after, [('delete', ALARMS), ('cas', 'CLEAN')])

    def test_delete_failure_keeps_intent_and_recovery_deletes_before_cas(self):
        box = Box()
        fail_when(box.x.monitoring, 'delete_alarms', [ServiceError('ThrottlingException')])
        rc, out, err = box.cli('status', allow_sleep=False)
        self.refused(box, rc, out, err, 'ALARM_UNKNOWN')
        self.assertEqual(self.last_diagnostic(err)['operation'], 'ALARM_DELETE')
        self.assertEqual(box.register()['phase'], 'INTENT')
        self.assertIsNotNone(box.record('clean.json'))
        mark = len(box.events)
        rc, out, err = box.cli('status', allow_sleep=False)
        self.assertEqual(rc, 0); self.assertEqual(json.loads(out)['passed'], True)
        self.assertEqual(box.events[mark:], [('delete', ALARMS), ('cas', 'CLEAN')])

    def test_legacy_clean_register_still_requires_deletion(self):
        box = Box()
        self.assertTrue(box.x.status(RUN_ID)['complete'])
        self.assertEqual(box.register()['phase'], 'CLEAN')
        fail_when(box.x.monitoring, 'delete_alarms', [ServiceError('ServiceUnavailable', 503)])
        rc, out, err = box.cli('status', allow_sleep=False)
        self.refused(box, rc, out, err, 'ALARM_UNKNOWN', polls=2)
        mark = len(box.events)
        rc, out, err = box.cli('status', allow_sleep=False)
        self.assertEqual(rc, 0)
        self.assertEqual(box.events[mark:], [('delete', ALARMS)])

    def test_permanent_monitoring_denial_refuses(self):
        for method, state in (('delete_alarms', 'terminated'), ('put_metric_alarm', 'running')):
            with self.subTest(method=method):
                box = Box(state=state)
                fail_when(box.x.monitoring, method, [ServiceError('AccessDenied', 403)])
                rc, out, err = box.cli(allow_sleep=False)
                self.refused(box, rc, out, err, 'ALARM_UNKNOWN')
                self.assertEqual(box.register()['phase'], 'INTENT')

    def test_no_complete_pass_while_alarm_cleanup_unresolved(self):
        box = Box()
        fail_when(box.x.monitoring, 'delete_alarms', [ServiceError('Throttling')] * 3)
        rc, out, err = box.cli()
        self.refused(box, rc, out, err, 'RETRY_EXHAUSTED', polls=3)
        self.assertEqual(box.register()['phase'], 'INTENT')
        self.assertNotIn('"passed": true', out)

    def test_only_the_two_exact_bound_names_are_deleted(self):
        box = Box()
        box.x.status(RUN_ID)
        deletes = [names for kind, names in box.events if kind == 'delete']
        self.assertEqual(deletes, [ALARMS])

    def test_provision_and_no_monitoring_modes_are_exempt(self):
        box = Box(launch=False, verdict=None, state=None)
        box.x.monitoring = None
        box.x.start(job()); box.runs = 1
        box.i['State']['Name'] = 'terminated'
        rc, out, err = box.cli(allow_sleep=False)
        self.assertEqual(rc, 1); self.assertEqual(json.loads(out)['complete'], True)
        x, c, e, s, i = session_setup()
        events = []
        x.monitoring = Alarms(lambda: c.now, events)
        x.cfg.update(MODE='provision', INSTANCE_TYPE='t4g.small', ADMIN_SECRET_ARN='admin', PROVISION_OWNER='polis-probe-login:test')
        i['InstanceType'] = 't4g.small'
        request = dict(run_id='a' * 32, adminVersion='b' * 32, readerVersion='c' * 32)
        x.start_provision(request)
        a = x.active()[0]['admission']
        s.objects['control', 'provision-results/' + ARN + '.json'] = encoded(
            dict(schema='polis-probe-provision/1', admissionSha256=sha(a), success=True))
        i['State']['Name'] = 'terminated'
        self.assertTrue(x.status(request['run_id'])['passed'])
        self.assertEqual(events, [])


class CredentialTests(Checks):
    """Family 7: expired tokens recover through the SDK provider; failed
    refresh and hostile errors stay closed, including client setup."""

    def test_expired_token_then_provider_recovery_passes(self):
        for code in ('ExpiredToken', 'ExpiredTokenException'):
            for operation in ('ACTIVE_GET', 'INSTANCE_DESCRIBE', 'ALARM_DELETE', 'RECEIPT_GET'):
                with self.subTest(code=code, operation=operation):
                    box = Box(); arm(box, operation, lambda: ServiceError(code, 400))
                    rc, out, err = box.cli()
                    self.passed(box, rc, out, err, polls=2)

    def test_repeated_expiry_reaches_the_retry_cap(self):
        box = Box()
        fail_when(box.s, 'get_object', [ServiceError('ExpiredToken', 400)] * 5, key_is('active.json'))
        rc, out, err = box.cli()
        self.refused(box, rc, out, err, 'RETRY_EXHAUSTED', polls=3)

    def test_failed_refresh_is_auth_unavailable_at_once(self):
        for name, cause in AUTH_CAUSES:
            for operation in ('ACTIVE_GET', 'VOLUME_DESCRIBE', 'ALARM_DELETE', 'TERMINAL_CAS'):
                with self.subTest(cause=name, operation=operation):
                    box = Box(); arm(box, operation, cause)
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err, 'AUTH_UNAVAILABLE')
                    self.assertEqual(self.last_diagnostic(err)['disposition'], 'refuse')

    def test_hostile_errors_never_reach_the_terminal(self):
        class Hostile(Exception):
            response = {'Error': {'Code': PRIVATE, 'Message': PRIVATE}}
        for error in (Hostile(PRIVATE), Unknown(PRIVATE), Unknown('RUN_CONFLICT', PRIVATE, PRIVATE),
                      ValueError(PRIVATE), sdk_type('ClientError')(PRIVATE)):
            for action in ('watch', 'status', 'cancel'):
                with self.subTest(error=type(error).__name__, action=action):
                    box = Box()
                    fail_when(box.s, 'get_object', [error], key_is('active.json'))
                    rc, out, err = box.cli(action, allow_sleep=False)
                    self.refused(box, rc, out, err)
                    self.assertIn(self.last_diagnostic(err)['reason'], ('UNCLASSIFIED', 'CONTROL_READ_UNKNOWN', 'RUN_CONFLICT'))
                    self.assertIn(self.last_diagnostic(err)['operation'], run.OPERATIONS)

    def test_client_setup_and_config_failures_are_closed(self):
        box = Box()
        for error in (RuntimeError(PRIVATE), sdk_type('ProfileNotFound')(PRIVATE), sdk_type('NoCredentialsError')(PRIVATE)):
            with self.subTest(error=type(error).__name__):
                out, err = io.StringIO(), io.StringIO()
                with tempfile.TemporaryDirectory() as directory:
                    config = Path(directory) / 'config.json'
                    config.write_text(json.dumps(box.x.cfg))
                    with patch.object(run, 'clients', side_effect=error), \
                            patch.object(sys, 'argv', ['run.py', 'watch', '--config', str(config), '--profile', 'fake', '--run-id', RUN_ID]), \
                            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        rc = run.main()
                self.assertEqual(rc, 2); self.closed_output(out.getvalue(), err.getvalue(), rc)
                self.assertEqual(self.last_diagnostic(err.getvalue())['operation'], 'CLIENT_SETUP')
        for body in (b'{' + PRIVATE.encode(), b'[]', json.dumps({'MODE': 'worker'}).encode(), None):
            with self.subTest(config=body):
                out, err = io.StringIO(), io.StringIO()
                with tempfile.TemporaryDirectory() as directory:
                    config = Path(directory) / 'config.json'
                    if body is not None:
                        config.write_bytes(body)
                    with patch.object(run, 'clients', side_effect=AssertionError('no clients')), \
                            patch.object(sys, 'argv', ['run.py', 'status', '--config', str(config), '--profile', 'fake', '--run-id', RUN_ID]), \
                            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        rc = run.main()
                self.assertEqual(rc, 2); self.closed_output(out.getvalue(), err.getvalue(), rc)
                self.assertEqual(self.last_diagnostic(err.getvalue())['reason'], 'CONFIG_UNKNOWN')

    def test_client_construction_keeps_one_sdk_attempt(self):
        from types import SimpleNamespace
        calls = []
        def client(name, config): calls.append(config); return name
        sdk = SimpleNamespace(Session=lambda **kw: SimpleNamespace(client=client))
        conf = SimpleNamespace(Config=lambda **kw: kw)
        with patch.dict(sys.modules, {'boto3': sdk, 'botocore': SimpleNamespace(), 'botocore.config': conf}):
            run.clients('us-east-1', 'fake')
        self.assertTrue(all(c['retries']['total_max_attempts'] == 1 for c in calls))


class SemanticsTests(Checks):
    """Family 8: normal progress continues and terminal receipt semantics hold."""

    def test_running_and_attaching_continue_to_completion(self):
        box = Box(state='running')
        box.at(1, lambda: box.i.update(BlockDeviceMappings=maps('vol-b')))
        box.at(3, lambda: (box.i['State'].update(Name='shutting-down'), box.i.update(SubnetId=None, BlockDeviceMappings=maps('vol-a'))))
        box.at(4, lambda: box.i.update(BlockDeviceMappings=[]))
        box.at(5, lambda: box.i['State'].update(Name='terminated'))
        rc, out, err = box.cli()
        self.passed(box, rc, out, err, polls=6)
        self.assertEqual(err, '')
        self.assertFalse(box.e.terminated)

    def test_terminal_receipt_outcomes(self):
        cases = [('PASS', 0, True), ('FAIL', 1, False), (None, 1, False)]
        for verdict, code, passed in cases:
            with self.subTest(verdict=verdict):
                box = Box(verdict=verdict)
                rc, out, err = box.cli(allow_sleep=False)
                self.assertEqual(rc, code)
                self.assertEqual(json.loads(out), dict(run_id=RUN_ID, complete=True, passed=passed))
                self.assertEqual(box.register()['phase'], 'CLEAN')
        bad = [receipt() | {'unrecognized': 'x'}, receipt() | {'run_id': 'b' * 32},
               receipt() | {'job_sha256': '0' * 64}, b'{', b'x' * 200000]
        for value in bad:
            with self.subTest(receipt=str(value)[:30]):
                box = Box()
                box.s.objects[RECEIPT_KEY] = value if isinstance(value, bytes) else encoded(value)
                rc, out, err = box.cli(allow_sleep=False)
                self.refused(box, rc, out, err)
                self.assertIn(self.last_diagnostic(err)['reason'], ('RECEIPT_INVALID', 'RECEIPT_LIMIT'))

    def test_provision_mode_keeps_its_receipt(self):
        x, c, e, s, i = session_setup()
        x.cfg.update(MODE='provision', INSTANCE_TYPE='t4g.small', ADMIN_SECRET_ARN='admin', PROVISION_OWNER='polis-probe-login:test')
        i['InstanceType'] = 't4g.small'
        request = dict(run_id='a' * 32, adminVersion='b' * 32, readerVersion='c' * 32)
        x.start_provision(request)
        a = x.active()[0]['admission']
        for body, passed in ((dict(schema='polis-probe-provision/1', admissionSha256=sha(a), success=True), True),
                             (dict(schema='polis-probe-provision/1', admissionSha256=sha(a), success=False), False)):
            s.objects['control', 'provision-results/' + ARN + '.json'] = encoded(body)
            i['State']['Name'] = 'terminated'
            self.assertEqual(x.status(request['run_id'])['passed'], passed)

    def test_unknown_liveness_never_kills_but_expiry_still_does(self):
        box = Box(verdict=None, state='running')
        box.c.now += 601
        box.s.head_object = lambda **kw: (_ for _ in ()).throw(ApiError('404'))
        box.x.monitoring.get_metric_statistics = lambda **kw: {'Datapoints': []}
        killed_at = []
        def terminate(**kw):
            killed_at.append(box.c.now)
            box.e.terminated += kw['InstanceIds']
            box.i['State']['Name'] = 'terminated'
        box.e.terminate_instances = terminate
        rc, out, err = box.cli()
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(out), dict(run_id=RUN_ID, complete=True, passed=False))
        self.assertEqual(box.e.terminated, ['i-test'])
        self.assertGreaterEqual(killed_at[0], box.control().expiry)
        self.assertGreater(len(box.poll_times), WATCH_CEILING_SECONDS // 10000)
        self.assertEqual(err, '')


class PortedDiagnosisSchedules(Checks):
    """The nine recovery schedules of the pre-follow-up offline diagnosis, now
    expected to finish inside the first watch (they used to exit 2 there)."""

    def test_disk_not_detached(self):
        box = Box(); box.e.disks = [{'VolumeId': 'vol-a', 'State': 'in-use', 'Attachments': []}]
        box.at(1, box.e.disks.clear)
        self.passed(box, *box.cli(), polls=2)

    def test_disk_remains(self):
        box = Box(); box.deletes_remove = False
        box.e.disks = [{'VolumeId': 'vol-a', 'State': 'available', 'Attachments': []}]
        box.at(1, box.e.disks.clear)
        self.passed(box, *box.cli(), polls=2)
        self.assertEqual(box.e.deleted, ['vol-a'])

    def test_partial_terminated_mapping(self):
        box = Box(); box.i['BlockDeviceMappings'] = maps('vol-a')
        self.passed(box, *box.cli(), polls=1)

    def test_partial_shutting_down_mapping(self):
        box = Box(state='shutting-down'); box.i['BlockDeviceMappings'] = maps('vol-a')
        box.at(1, lambda: (box.i['State'].update(Name='terminated'), box.i.update(BlockDeviceMappings=[])))
        self.passed(box, *box.cli(), polls=2)
        self.assertFalse(box.e.terminated)

    def test_same_run_clean_cas(self):
        box = Box(); compete(box, {}, ServiceError('PreconditionFailed', 412))
        self.passed(box, *box.cli(), polls=1)

    def test_alarm_delete_transient(self):
        box = Box(); fail_when(box.x.monitoring, 'delete_alarms', [ApiError('Throttling')])
        self.passed(box, *box.cli(), polls=2)

    def test_alarm_put_transient(self):
        box = Box(); fail_when(box.x.monitoring, 'put_metric_alarm', [ApiError('Throttling')] * 9)
        mark = len(box.events)
        self.passed(box, *box.cli(), polls=1)
        self.assertEqual(box.events[mark:], [('delete', ALARMS), ('cas', 'CLEAN')])

    def test_expired_control_read(self):
        box = Box(); fail_when(box.s, 'get_object', [ApiError('ExpiredToken')])
        self.passed(box, *box.cli(), polls=2)

    def test_later_watch_poll_during_cleanup(self):
        box = Box(state='running')
        box.at(1, lambda: (box.i['State'].update(Name='terminated'),
                           box.e.disks.append({'VolumeId': 'vol-a', 'State': 'in-use', 'Attachments': []})))
        box.at(2, box.e.disks.clear)
        self.passed(box, *box.cli(), polls=3)

    def test_controls_still_refuse(self):
        box = Box(); value = receipt(); value['unrecognized'] = 'fake'
        box.s.objects[RECEIPT_KEY] = encoded(value)
        self.refused(box, *box.cli(allow_sleep=False), 'RECEIPT_INVALID')
        box = Box(); box.i['ClientToken'] = 'wrong'
        self.refused(box, *box.cli(allow_sleep=False), 'INSTANCE_OWNERSHIP_UNKNOWN')
        self.assertFalse(box.e.deleted); self.assertFalse(box.e.terminated)


class CleanResumeTests(Checks):
    """An already-CLEAN register is complete only with a validated cleanup record."""

    def closed_box(self):
        box = Box()
        self.assertTrue(box.x.status(RUN_ID)['passed'])
        self.assertEqual(box.register()['phase'], 'CLEAN')
        box.poll_times.clear()
        return box, ('control', box.control().prefix + 'clean.json')

    def test_missing_or_mismatched_cleanup_record_refuses(self):
        changes = {'missing': None, 'status': {'status': 'DIRTY'}, 'digest': {'admissionSha256': '0' * 64},
                   'instance': {'instanceId': 'i-other'}, 'volumes': {'volumes': ['vol-a']},
                   'extra': {'unexpected': True}}
        for name, change in changes.items():
            with self.subTest(change=name):
                box, key = self.closed_box()
                if change is None:
                    del box.s.objects[key]
                else:
                    box.s.objects[key] = encoded(dict(json.loads(box.s.objects[key]), **change))
                rc, out, err = box.cli(allow_sleep=False)
                self.refused(box, rc, out, err, 'CLEAN_RECORD_INVALID')
                self.assertNotIn('"passed": true', out)

    def test_valid_clean_resume_passes(self):
        box, key = self.closed_box()
        rc, out, err = box.cli(allow_sleep=False)
        self.passed(box, rc, out, err, polls=1)

    def test_never_launched_cancel_and_attested_release_stay_complete(self):
        x, c, e, s, i = session_setup(); put = s.put_object
        def race(**kw):
            if kw['Key'] == 'active.json' and json.loads(kw['Body'])['phase'] == 'INTENT':
                x.status(RUN_ID, cancel=True)
            return put(**kw)
        s.put_object = race
        with self.assertRaisesRegex(Unknown, 'ACTIVE_CONFLICT'):
            x.start(job())
        self.assertEqual(x.status(RUN_ID), dict(run_id=RUN_ID, complete=True, passed=False))
        from test_run import ReleaseTests
        case = ReleaseTests()
        x, c, e, s, i, run_id = case.stuck()
        e.instances = []
        x.release(run_id, ['vol-a', 'vol-b'])
        self.assertEqual(x.status(run_id), dict(run_id=run_id, complete=True, passed=False))


def cpu_failure_box(cause):
    """Past boot grace, no worker heartbeat, and every CPU read raising `cause`;
    the instance terminates before the fifth observation."""
    box = Box(state='running')
    box.c.now += 601
    box.s.head_object = lambda **kw: (_ for _ in ()).throw(ServiceError('NoSuchKey', 404))
    calls = []
    def metric(**kw):
        calls.append(True)
        raise cause()
    box.x.monitoring.get_metric_statistics = metric
    box.at(4, lambda: box.i['State'].update(Name='terminated'))
    return box, calls


class MetricReadTests(Checks):
    """A failed CPU read is classified like any other SDK read; only a
    successful response with too little fresh evidence is pending."""

    def test_permanent_and_credential_failures_refuse_at_once(self):
        for name, cause, reason in (('access-denied', lambda: ServiceError('AccessDenied', 403), 'LIVENESS_UNKNOWN'),
                                    ('missing-credentials', lambda: sdk_type('NoCredentialsError')(PRIVATE), 'AUTH_UNAVAILABLE'),
                                    ('ssl', lambda: sdk_type('SSLError')(PRIVATE), 'LIVENESS_UNKNOWN')):
            with self.subTest(cause=name):
                box, calls = cpu_failure_box(cause)
                rc, out, err = box.cli(allow_sleep=False)
                self.refused(box, rc, out, err, reason, polls=1)
                self.assertEqual(self.last_diagnostic(err)['operation'], 'CPU_METRIC_READ')
                self.assertFalse(box.e.terminated)

    def test_repeated_transient_failures_exhaust(self):
        for name, cause in (('throttling', lambda: ServiceError('Throttling', 429)),
                            ('expired-token', lambda: ServiceError('ExpiredToken', 403))):
            with self.subTest(cause=name):
                box, calls = cpu_failure_box(cause)
                rc, out, err = box.cli()
                self.refused(box, rc, out, err, 'RETRY_EXHAUSTED', polls=3)
                self.assertEqual(self.last_diagnostic(err)['last'], 'LIVENESS_UNKNOWN')
                self.assertEqual(len(calls), 3)
                self.assertFalse(box.e.terminated)

    def test_transient_failure_then_insufficient_evidence_keeps_observing(self):
        box, calls = cpu_failure_box(lambda: ServiceError('Throttling', 429))
        box.at(1, lambda: setattr(box.x.monitoring, 'get_metric_statistics', lambda **kw: {'Datapoints': []}))
        rc, out, err = box.cli()
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(box.poll_times), 5)
        self.assertEqual([self.last_diagnostic(l)['disposition'] for l in err.splitlines()], ['retry'])
        self.assertFalse(box.e.terminated)

    def test_status_reports_metric_failure_as_exit_2(self):
        box, calls = cpu_failure_box(lambda: ServiceError('Throttling', 429))
        rc, out, err = box.cli('status', allow_sleep=False)
        self.refused(box, rc, out, err, 'LIVENESS_UNKNOWN')
        self.assertEqual(self.last_diagnostic(err)['disposition'], 'retry')


def readback_masking_box(operation, cause):
    """The first matching write fails with `cause` and writes nothing; only its
    immediate readback then fails transiently."""
    box = Box()
    put, get = box.s.put_object, box.s.get_object
    state = {'failed': False, 'readback': False, 'attempts': 0}
    def matches(kw):
        return terminal_cas(kw) if operation == 'terminal-cas' else kw['Key'].endswith('clean.json')
    def write(**kw):
        if matches(kw):
            state['attempts'] += 1
            if not state['failed']:
                state.update(failed=True, readback=True)
                raise cause()
        return put(**kw)
    def read(**kw):
        target = kw['Key'] == 'active.json' if operation == 'terminal-cas' else kw['Key'].endswith('clean.json')
        if state['readback'] and target:
            state['readback'] = False
            raise ServiceError('SlowDown', 503)
        return get(**kw)
    box.s.put_object, box.s.get_object = write, read
    return box, state


class WriteReadbackTests(Checks):
    """A transient readback never replaces a permanent write cause."""

    def test_permanent_write_cause_survives_transient_readback(self):
        for operation, reason in (('record', 'RECORD_WRITE_UNKNOWN'), ('terminal-cas', 'ACTIVE_CONFLICT')):
            for name, cause, expected in (('access-denied', lambda: ServiceError('AccessDenied', 403), reason),
                                          ('missing-credentials', lambda: sdk_type('NoCredentialsError')(PRIVATE), 'AUTH_UNAVAILABLE')):
                with self.subTest(operation=operation, cause=name):
                    box, state = readback_masking_box(operation, cause)
                    rc, out, err = box.cli(allow_sleep=False)
                    self.refused(box, rc, out, err, expected, polls=1)
                    self.assertEqual(state['attempts'], 1)
                    self.assertEqual(box.register()['phase'], 'INTENT')

    def test_transient_write_with_transient_readback_still_retries(self):
        for operation in ('record', 'terminal-cas'):
            with self.subTest(operation=operation):
                box, state = readback_masking_box(operation, lambda: ServiceError('ServiceUnavailable', 503))
                rc, out, err = box.cli()
                self.passed(box, rc, out, err, polls=2)
                self.assertEqual(state['attempts'], 2)

    def test_exact_readback_still_resolves_a_permanent_write_error(self):
        for operation in ('record', 'terminal-cas'):
            with self.subTest(operation=operation):
                box = Box(); put = box.s.put_object
                match = terminal_cas if operation == 'terminal-cas' else key_is('clean.json')
                def lost(**kw):
                    result = put(**kw)
                    if match(kw):
                        raise ServiceError('AccessDenied', 403)
                    return result
                box.s.put_object = lost
                rc, out, err = box.cli(allow_sleep=False)
                self.passed(box, rc, out, err, polls=1)


class ReviewControls(Checks):
    """Controls kept from the review: strict refusal and shutdown convergence."""

    def test_ownership_refusal(self):
        box = Box(); box.i['ClientToken'] = 'wrong'
        self.refused(box, *box.cli(allow_sleep=False), 'INSTANCE_OWNERSHIP_UNKNOWN')

    def test_shutdown_convergence(self):
        box = Box(state='shutting-down')
        box.at(1, lambda: box.i['State'].update(Name='terminated'))
        self.passed(box, *box.cli(), polls=2)


class StubSession:
    """A scripted status() for loop mechanics: each step is a result, an
    exception, or a callable that may advance the fake clock."""
    def __init__(self, box, steps, default=None):
        self.box, self.steps, self.default = box, list(steps), default
        self.calls = []
        self.cfg = box.x.cfg
    def status(self, run_id, cancel=False, bound=None):
        self.calls.append(self.box.t)
        step = self.steps.pop(0) if self.steps else self.default
        if callable(step) and not isinstance(step, BaseException):
            step = step()
        if isinstance(step, BaseException):
            raise step
        return step


INCOMPLETE = dict(run_id=RUN_ID, complete=False, passed=False)
PASSED = dict(run_id=RUN_ID, complete=True, passed=True)


def transient():
    return Unknown('CONTROL_READ_UNKNOWN', 'ACTIVE_GET', run.RETRY)


class DeadlineTests(Checks):
    """Family 9: one fixed deadline over the first poll and every retry."""

    def test_deadline_covers_first_poll_and_clips_sleep(self):
        box = Box()
        def slow_first():
            # The first observation itself runs until ten seconds before the end.
            box.t += WATCH_CEILING_SECONDS - 10
            return INCOMPLETE
        stub = StubSession(box, [slow_first], default=AssertionError('polled after the deadline'))
        rc, out, err = self.run_stub(box, stub)
        self.assertEqual(rc, 2); self.closed_output(out, err, rc)
        self.assertEqual(stub.calls, [1000.0])
        self.assertEqual(box.sleeps, [10])
        self.assertEqual(self.last_diagnostic(err)['reason'], 'WATCH_CEILING')

    def run_stub(self, box, stub, action='watch'):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps(stub.cfg))
            out, err = io.StringIO(), io.StringIO()
            clock = types.SimpleNamespace(monotonic=box.monotonic, time=lambda: box.c.now,
                                          sleep=box.sleep if action == 'watch' else Box.no_sleep)
            with patch.object(sys, 'argv', ['run.py', action, '--config', str(config), '--profile', 'fake', '--run-id', RUN_ID]), \
                    patch.object(run, 'clients', return_value=(None, None, None)), \
                    patch.object(run, 'Session', return_value=stub), patch.object(run, 'time', clock), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = run.main()
        return rc, out.getvalue(), err.getvalue()

    def test_deadline_never_resets_and_no_poll_starts_at_or_after_it(self):
        box = Box()
        pattern = [transient, transient, INCOMPLETE]
        stub = StubSession(box, pattern * 100000)
        rc, out, err = self.run_stub(box, stub)
        end = 1000.0 + WATCH_CEILING_SECONDS
        self.assertEqual(rc, 2)
        self.assertTrue(all(t < end for t in stub.calls))
        self.assertEqual(len(stub.calls), WATCH_CEILING_SECONDS // WATCH_POLL_SECONDS)
        self.assertEqual(box.t, end)
        self.assertTrue(all(0 < s <= WATCH_POLL_SECONDS for s in box.sleeps))
        self.assertEqual(self.last_diagnostic(err)['reason'], 'WATCH_CEILING')

    def test_retries_near_the_deadline_do_not_extend_it(self):
        box = Box()
        def late():
            box.t = 1000.0 + WATCH_CEILING_SECONDS - 45
            return transient()
        stub = StubSession(box, [late], default=transient)
        rc, out, err = self.run_stub(box, stub)
        self.assertEqual(rc, 2)
        self.assertEqual(box.sleeps, [30, 15])
        self.assertEqual(len(stub.calls), 2)
        self.assertEqual(self.last_diagnostic(err)['reason'], 'WATCH_CEILING')
        self.assertEqual(self.last_diagnostic(err)['last'], 'CONTROL_READ_UNKNOWN')

    def test_long_running_work_is_not_cut_off_by_the_transient_limit(self):
        box = Box()
        stub = StubSession(box, [transient, transient, INCOMPLETE] * 200 + [PASSED])
        rc, out, err = self.run_stub(box, stub)
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), PASSED)
        self.assertEqual(len(stub.calls), 601)

    def test_pending_outcomes_reset_the_counter(self):
        box = Box()
        pending = lambda: Unknown('DISK_NOT_DETACHED', 'VOLUME_DESCRIBE', run.PENDING)
        stub = StubSession(box, [transient, transient, pending, transient, transient, PASSED])
        rc, out, err = self.run_stub(box, stub)
        self.assertEqual(rc, 0)

    def test_single_observation_commands_have_no_hidden_loop(self):
        for action in ('status', 'cancel'):
            for step, code in ((transient(), 2), (Unknown('TERMINATION_PENDING', 'INSTANCE_TERMINATE', run.PENDING), 1),
                               (INCOMPLETE, 1), (Unknown('INSTANCE_CHANGED'), 2)):
                with self.subTest(action=action, step=step):
                    box = Box(); stub = StubSession(box, [step], default=AssertionError('second observation'))
                    rc, out, err = self.run_stub(box, stub, action)
                    self.assertEqual((rc, len(stub.calls), box.sleeps), (code, 1, []))
                    self.closed_output(out, err, rc)
                    if code == 1:
                        self.assertEqual(json.loads(out), INCOMPLETE)
        # launch: exactly one SDK attempt, even for a transient cause.
        box = Box(launch=False, verdict=None, state=None)
        box.e.run_fails = True
        box.runs = 0
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'job.json'
            path.write_text(json.dumps(job()))
            box.runs = 1
            rc, out, err = box.cli('launch', '--job', str(path), run_id=None, allow_sleep=False)
        self.assertEqual(rc, 2); self.assertEqual(len(box.e.runs), 1)
        self.closed_output(out, err, rc)
        # release: one observation, no sleep, even for a transient cause.
        box = Box()
        fail_when(box.s, 'get_object', [ServiceError('Throttling')], key_is('active.json'))
        rc, out, err = box.cli('release', '--attest-volume', 'vol-a', '--attest-volume', 'vol-b', allow_sleep=False)
        self.assertEqual(rc, 2); self.assertEqual(box.poll_times, [])
        self.closed_output(out, err, rc)


if __name__ == '__main__':
    unittest.main()
