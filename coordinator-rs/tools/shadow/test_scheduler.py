import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import daily
import capture
import scheduler as s


def profile():
    return dict(schema='polis-shadow-schedule/1', run='a'*32, build='b'*64, policy='c'*64,
                start_epoch=100, days=2, bucket='private-evidence', prefix='shadow', kms_key='reviewed-key',
                collector_profile='/private/collector.json', expected_cuts=1,
                expected_routes={name: 1 for name in daily.ROUTES}, observer_expected=1440)


def complete(profile, request):
    value = s.absent_collector(profile, request)
    value['seconds'] = s.DAY
    value['admission'] = {key: True for key in value['admission']}
    value['windows'] = dict(expected=1, bound=1, incomplete=0)
    value['routes'] = {key: dict(expected=1, observed=1, EXACT=1,
                               UNORDERED_QUERY_RESIDUAL=0, ENGINE_DIFFERENCE=0, INCOMPLETE=0)
                       for key in daily.ROUTES}
    value['observer']['observed'] = 1440
    return value


def collected(profile, request_path, output_path):
    return complete(profile, s.read_json(request_path))


def instant_start(profile, request_path, output_path):
    return SimpleNamespace(request=s.read_json(request_path), profile=profile, poll=lambda: 0)


def instant_finish(process, output_path):
    return complete(process.profile, process.request)


class Client:
    def __init__(self):
        self.objects = {}
        self.puts = []
        self.gets = []
        self.lose_ack = False
        self.deny_get = False
        self.crash_after_put = False

    def put_object(self, **args):
        self.puts.append(args)
        key = args['Bucket'], args['Key']
        if key in self.objects:
            raise OSError('already exists')
        self.objects[key] = args['Body']
        if self.crash_after_put:
            raise KeyboardInterrupt()
        if self.lose_ack:
            raise TimeoutError()
        return {}

    def get_object(self, **args):
        self.gets.append(args)
        if self.deny_get:
            raise OSError('unavailable')
        return {'Body': io.BytesIO(self.objects[args['Bucket'], args['Key']])}


class Scheduler(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile = profile()
        self.client = Client()
        self.clock = lambda: 100 + s.DAY

    def run_window(self, **kwargs):
        return s.run_window(self.client, self.profile, self.root, 0,
                            collector=kwargs.pop('collector', collected), now=self.clock, **kwargs)

    def test_pending_export_confirmed_local_and_no_repeat_put(self):
        result = self.run_window()
        self.assertEqual((result['delivery'], result['verdict']), ('CONFIRMED', 'PASS'))
        self.assertEqual(len(self.client.puts), 1)
        sent = json.loads(self.client.puts[0]['Body'])
        self.assertEqual((sent['delivery'], sent['verdict']), ('PENDING', 'INCOMPLETE'))
        self.assertEqual(self.client.puts[0]['IfNoneMatch'], '*')
        self.assertEqual(self.client.puts[0]['ServerSideEncryption'], 'aws:kms')
        self.assertEqual(self.client.puts[0]['SSEKMSKeyId'], self.profile['kms_key'])
        self.assertEqual(self.run_window(), result)
        self.assertEqual(len(self.client.puts), 1)
        self.assertEqual(len(self.client.gets), 0)
        self.assertEqual((self.root/'window-00000/receipt.json').stat().st_mode & 0o777, 0o400)
        self.assertEqual((self.root/'window-00000/delivery-0000.json').stat().st_mode & 0o777, 0o400)

    def test_lost_ack_reconciles_identical_bytes(self):
        self.client.lose_ack = True
        result = self.run_window()
        self.assertEqual(result['verdict'], 'PASS')
        self.assertEqual(len(self.client.gets), 1)

    def test_uncertain_restart_get_only_and_hash_chain(self):
        self.client.lose_ack = self.client.deny_get = True
        self.assertEqual(self.run_window()['delivery'], 'UNCERTAIN')
        self.client.deny_get = False
        self.assertEqual(self.run_window(reconcile_only=True)['verdict'], 'PASS')
        self.assertEqual(len(self.client.puts), 1)
        first = s.read_json(self.root/'window-00000/delivery-0000.json')
        second = s.read_json(self.root/'window-00000/delivery-0001.json')
        self.assertEqual(second['previous_sha256'], s.digest(daily.canonical(first)))
        self.assertEqual(second['action'], 'GET')

    def test_process_death_after_put_reconciles_without_second_put(self):
        self.client.crash_after_put = True
        with self.assertRaises(KeyboardInterrupt):
            self.run_window()
        self.assertTrue((self.root/'window-00000/publication-intent.json').exists())
        self.assertFalse((self.root/'window-00000/delivery-0000.json').exists())
        self.client.crash_after_put = False
        self.assertEqual(self.run_window()['verdict'], 'PASS')
        self.assertEqual(len(self.client.puts), 1)
        self.assertEqual(s.read_json(self.root/'window-00000/delivery-0000.json')['action'], 'GET')

    def test_process_death_before_put_never_silently_retries(self):
        with patch.object(daily, 'publish', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.run_window()
        self.assertEqual(self.run_window()['delivery'], 'UNCERTAIN')
        self.assertEqual(len(self.client.puts), 0)
        self.assertEqual(len(self.client.gets), 1)

    def test_different_remote_bytes_are_terminal_failure(self):
        key = (self.profile['bucket'], s.object_key(self.profile, 0))
        self.client.objects[key] = b'other receipt'
        result = self.run_window()
        self.assertEqual((result['delivery'], result['verdict']), ('FAILED', 'INCOMPLETE'))
        self.client.objects[key] = self.client.puts[0]['Body']
        self.assertEqual(self.run_window()['delivery'], 'FAILED')
        self.assertEqual(len(self.client.puts), 1)
        self.assertEqual(len(self.client.gets), 1)

    def test_missing_collector_exports_only_incomplete_zero_observations(self):
        def dead(*_):
            raise OSError('private diagnostic must not escape')
        result = self.run_window(collector=dead)
        self.assertEqual(result['verdict'], 'INCOMPLETE')
        self.assertEqual(result['seconds'], 0)
        self.assertFalse(any(result['admission'].values()))
        self.assertEqual(result['windows'], dict(expected=1, bound=0, incomplete=1))
        self.assertNotIn(b'private diagnostic', self.client.puts[0]['Body'])

    def test_interrupted_collection_not_replayed(self):
        s.immutable(self.root/'schedule.json', self.profile)
        directory = s.private_directory(self.root/'window-00000')
        s.immutable(directory/'request.json', s.request_for(self.profile, 0))
        def forbidden(*_):
            self.fail('collector must not be rerun across an unexplained gap')
        self.assertEqual(self.run_window(collector=forbidden)['verdict'], 'INCOMPLETE')

    def test_scope_identity_and_future_duration_cannot_earn_pass(self):
        mutations = [('run', 'd'*32), ('build', 'e'*64), ('seconds', s.DAY)]
        for field, value in mutations:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                def bad(profile, path, out):
                    result = collected(profile, path, out)
                    result[field] = value
                    return result
                result = s.run_window(Client(), self.profile, directory, 0, collector=bad,
                                      now=lambda: 101 if field == 'seconds' else 100+s.DAY)
                self.assertEqual(result['verdict'], 'INCOMPLETE')
                self.assertFalse(result['admission']['collector'])
        for field in ('cuts', 'routes', 'observer'):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                def bad(profile, path, out):
                    result = collected(profile, path, out)
                    if field == 'cuts':result['windows'].update(expected=0, bound=0)
                    elif field == 'observer':result['observer'].update(expected=0, observed=0)
                    else:result['routes']['REPORT_READ'].update(expected=0, observed=0, EXACT=0)
                    return result
                result = s.run_window(Client(), self.profile, directory, 0, collector=bad, now=self.clock)
                self.assertFalse(result['admission']['collector'])

    def test_unbound_residual_remains_incomplete_after_delivery(self):
        def unbound(profile, path, out):
            value = s.absent_collector(profile, s.read_json(path))
            value['residuals']['cut-unbound-late-row'] = 1
            return value
        result = self.run_window(collector=unbound)
        self.assertEqual((result['delivery'], result['verdict']), ('CONFIRMED', 'INCOMPLETE'))
        self.assertEqual(result['residuals']['cut-unbound-late-row'], 1)

    def test_changed_schedule_and_delivery_chain_refused(self):
        self.client.lose_ack = self.client.deny_get = True
        self.run_window()
        changed = copy.deepcopy(self.profile);changed['prefix'] = 'other'
        with self.assertRaisesRegex(ValueError, 'REBOUND'):
            s.run_window(self.client, changed, self.root, 0, now=self.clock)
        self.client.deny_get = False
        self.run_window()
        path = self.root/'window-00000/delivery-0000.json'
        value = s.read_json(path);value['outcome'] = 'FAILED'
        path.chmod(0o600);path.write_bytes(daily.canonical(value))
        with self.assertRaisesRegex(ValueError, 'CHAIN'):
            self.run_window()

    def test_reconcile_never_creates_new_publication(self):
        with self.assertRaisesRegex(ValueError, 'NO_PUBLICATION_INTENT'):
            self.run_window(reconcile_only=True)
        self.assertFalse(self.client.puts)

    def test_dormant_without_explicit_opt_in(self):
        with patch('builtins.__import__', wraps=__import__) as imports, patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(s.main(['run', '--profile', '/missing', '--state', '/missing']), 2)
            self.assertFalse(any(call.args[0] == 'boto3' for call in imports.call_args_list))

    def test_closed_profile_positive_scope_and_duplicate_fields(self):
        for field, value in [('extra', True), ('run', 11111111111111111111111111111111), ('days', True), ('expected_cuts', 0)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                s.validate_profile(self.profile | {field: value})
        bad = copy.deepcopy(self.profile);bad['expected_routes']['REPORT_READ'] = 0
        with self.assertRaises(ValueError):s.validate_profile(bad)
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_FIELD'):s.decode(b'{"x":1,"x":2}')

    def test_future_window_and_unsafe_state_refused(self):
        with self.assertRaisesRegex(ValueError, 'NOT_DUE'):
            s.run_window(self.client, self.profile, self.root, 0, now=lambda: 39)
        link = self.root/'link';link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'PATH'):
            s.run_window(self.client, self.profile, link, 0, now=self.clock)
        with s.locked(self.root), self.assertRaisesRegex(ValueError, 'BUSY'):
            self.run_window()

    def test_subprocess_is_fixed_scrubbed_and_opted_in(self):
        window = s.private_directory(self.root/'window-00000')
        s.immutable(window/'request.json', s.request_for(self.profile, 0))
        path = window/'output.json';path.write_text('{}')
        source = self.root/'input-profile.json';source.write_text('{}')
        self.profile['collector_profile'] = str(source)
        with patch.dict(os.environ, {'AWS_SECRET_ACCESS_KEY': 'private-test-value', 'NODE_OPTIONS': 'private-test-value', 'PGPASSWORD': 'private-test-value'}), patch.object(subprocess, 'Popen') as runner, patch.object(s, 'stop_process_group') as stop:
            runner.return_value.wait.return_value = 0
            s.run_collector(self.profile, window/'request.json', path)
            stop.assert_called_once_with(runner.return_value)
        args, kwargs = runner.call_args
        self.assertEqual(Path(args[0][2]).name, 'collector.py')
        self.assertNotIn('shell', kwargs)
        self.assertTrue(kwargs['start_new_session'])
        self.assertEqual(args[0][4], str(self.root/'collector-profile.json'))
        self.assertEqual((self.root/'collector-profile.json').read_bytes(), source.read_bytes())
        self.assertEqual(kwargs['env']['SHADOW_COLLECTOR_ENABLE'], '1')
        self.assertFalse({'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'PGPASSWORD'} & kwargs['env'].keys())
        self.assertEqual(kwargs['stdout'], subprocess.DEVNULL)

    def test_collector_profile_change_and_timeout_process_group(self):
        window = s.private_directory(self.root/'window-00000')
        s.immutable(window/'request.json', s.request_for(self.profile, 0))
        source = self.root/'input-profile.json';source.write_text('{}')
        self.profile['collector_profile'] = str(source)
        with patch.object(subprocess, 'Popen') as runner, patch.object(os, 'killpg') as kill:
            process = runner.return_value
            process.pid = 12345
            process.wait.side_effect = [subprocess.TimeoutExpired('collector', 1),
                                        subprocess.TimeoutExpired('collector', 1), -9]
            with self.assertRaises(subprocess.TimeoutExpired):
                s.run_collector(self.profile, window/'request.json', window/'output.json')
            self.assertEqual([call.args for call in kill.call_args_list],
                             [(12345, s.signal.SIGTERM), (12345, s.signal.SIGKILL)])
        source.write_text('{"changed":true}')
        with patch.object(subprocess, 'Popen') as runner, self.assertRaisesRegex(ValueError, 'REBOUND'):
            s.run_collector(self.profile, window/'request.json', window/'output.json')
        runner.assert_not_called()

    def test_daily_stops_on_incomplete_and_uses_fixed_window_schedule(self):
        clock = [39]
        sleeps = []
        def sleep(seconds):sleeps.append(seconds);clock[0] += seconds
        rows = []
        status = s.run_daily(self.client, self.profile, self.root,
                             start=instant_start,
                             finish=lambda process, out: s.absent_collector(process.profile, process.request),
                             now=lambda: clock[0], sleep=sleep, emit=rows.append)
        self.assertEqual(status, 2)
        self.assertEqual(sleeps, [1])
        self.assertEqual(len(rows), 1)
        self.assertFalse((self.root/'window-00001').exists())
        self.assertEqual(s.request_for(self.profile, 1)['start'], self.profile['start_epoch'] + s.DAY)

    def test_enabled_interruption_emits_closed_status_without_traceback(self):
        path = self.root/'schedule-input.json'; path.write_bytes(daily.canonical(self.profile))
        modules = {'boto3': SimpleNamespace(client=lambda *a, **kw: self.client),
                   'botocore.config': SimpleNamespace(Config=lambda **kw: None)}
        before = s.signal.getsignal(s.signal.SIGTERM)
        with patch.dict(sys.modules, modules), patch.object(s, 'run_daily', side_effect=KeyboardInterrupt), patch('sys.stderr', new_callable=io.StringIO) as error:
            self.assertEqual(s.main(['run', '--enable', '--profile', str(path), '--state', str(self.root)]), 2)
            self.assertEqual(error.getvalue(), 'SHADOW_SCHEDULE_INCOMPLETE\n')
        self.assertEqual(s.signal.getsignal(s.signal.SIGTERM), before)

    def test_real_collector_cli_preserves_incomplete_output_without_database(self):
        headers = {'accept': 'application/json'}
        requests = []
        for route in daily.ROUTES:
            path = '/api/v3/public/' + route
            requests.append(dict(route=dict(method='GET', path=path,
                request_sha256=capture.request_digest(path, headers), query_sha256='4'*64,
                unordered=False, **{'class': route}), headers=headers, full_request=None))
        value = dict(schema='polis-shadow-collector/1', expected_cuts=1,
            expected_routes=dict.fromkeys(daily.ROUTES, 1), observer_expected=1440,
            cuts=[dict(offset=0, custody_file=None, zid=1, requests=requests)],
            readers={'common': {}}, database={}, private_directory=str(self.root/'private'),
            observer_file=str(self.root/'missing-observer'), environment='public')
        path = self.root/'input-profile.json'
        path.write_bytes(daily.canonical(value)); path.chmod(0o600)
        self.profile.update(collector_profile=str(path), start_epoch=int(time.time()))
        result = s.run_window(self.client, self.profile, self.root, 0)
        self.assertEqual((result['delivery'], result['verdict']), ('CONFIRMED', 'INCOMPLETE'))
        # Process scheduling may cross the strict start boundary.
        # Either closed late-start or unknown-cut result earns no credit; the
        # exact unknown-cut branch is covered with a controlled collector clock.
        self.assertIn(result['residuals']['cut-unbound-late-row'], (0, 1))
        self.assertEqual(result['windows'], dict(expected=1, bound=0, incomplete=1))
        self.assertEqual(result['seconds'], 0)
        self.assertFalse(any(result['admission'].values()))
        self.assertEqual((self.root/'collector-profile.json').read_bytes(), path.read_bytes())
        output = s.read_json(self.root/'window-00000/collector-output.json')
        self.assertEqual(output['delivery'], 'PENDING')
        self.assertEqual(output['residuals'], result['residuals'])
        self.assertEqual(output['windows'], result['windows'])
        self.assertEqual(output['admission'], result['admission'])
        self.assertFalse((self.root/'private').exists())

    def test_real_process_group_removes_child_after_leader_exits(self):
        child = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(60)"
        leader = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',sys.argv[1]]); time.sleep(60)"
        process = subprocess.Popen([sys.executable, '-c', leader, child],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            self.assertEqual(process.stdout.readline(), b'ready\n')
            s.stop_process_group(process)
            # The child holds this pipe open until it exits; the leader alone
            # exiting cannot satisfy communicate's EOF condition.
            output, _ = process.communicate(timeout=5)
            self.assertEqual(output, b'')
            self.assertIsNotNone(process.returncode)
        finally:
            s.stop_process_group(process)
            process.stdout.close()

    def test_daily_pass_uses_confirmed_view_and_resumes_without_collection(self):
        status = s.run_daily(self.client, self.profile, self.root, start=instant_start, finish=instant_finish,
                             now=lambda: 100 + 2*s.DAY)
        self.assertEqual(status, 0)
        self.assertEqual(len(self.client.puts), 2)
        self.assertEqual(s.run_daily(self.client, self.profile, self.root,
                                     start=lambda *_: self.fail('already collected'),
                                     now=lambda: 100+2*s.DAY), 0)
        self.assertEqual(len(self.client.puts), 2)

    def test_next_collector_is_prewarmed_before_prior_delivery_then_gated(self):
        clock = [39]
        starts, finished = [], []
        def start(profile, request_path, output_path):
            request = s.read_json(request_path)
            starts.append((request['window'], clock[0]))
            if request['window']:
                self.assertFalse((self.root/'window-00000/confirmed-receipt.json').exists())
            return SimpleNamespace(request=request, profile=profile,
                                   poll=lambda: 0 if clock[0] >= request['end'] else None)
        def finish(process, output):
            if process.request['window']:
                gate = s.read_json(self.root/'window-00000/confirmed-receipt.json')
                self.assertEqual((gate['verdict'], gate['delivery']), ('PASS', 'CONFIRMED'))
            finished.append(process.request['window'])
            return complete(process.profile, process.request)
        def sleep(seconds):clock[0] += seconds
        self.assertEqual(s.run_daily(self.client, self.profile, self.root, start=start, finish=finish,
                                    now=lambda: clock[0], monotonic=lambda: clock[0], sleep=sleep), 0)
        self.assertEqual(starts, [(0, 40), (1, 40+s.DAY)])
        self.assertEqual(finished, [0, 1])
        self.assertEqual(len(self.client.puts), 2)

    def test_prior_incomplete_cancels_prewarmed_child_without_gate_or_put(self):
        clock = [40]; processes = []
        def start(profile, path, out):
            request = s.read_json(path)
            process = SimpleNamespace(request=request, profile=profile,
                poll=lambda: 0 if clock[0] >= request['end'] else None)
            processes.append(process); return process
        def sleep(seconds):clock[0] += seconds
        with patch.object(s, 'stop_process_group') as stop:
            status = s.run_daily(self.client, self.profile, self.root, start=start,
                finish=lambda process, out: s.absent_collector(process.profile, process.request),
                now=lambda: clock[0], monotonic=lambda: clock[0], sleep=sleep)
        self.assertEqual(status, 2)
        self.assertEqual(len(processes), 2)
        stop.assert_called_once_with(processes[1])
        self.assertFalse((self.root/'window-00000/confirmed-receipt.json').exists())
        self.assertFalse((self.root/'window-00001/receipt.json').exists())
        self.assertEqual(len(self.client.puts), 1)

    def test_later_collector_has_exact_previous_receipt_argument(self):
        window = s.private_directory(self.root/'window-00001')
        s.immutable(window/'request.json', s.request_for(self.profile, 1))
        source = self.root/'input-profile.json';source.write_text('{}')
        self.profile['collector_profile'] = str(source)
        with patch.object(subprocess, 'Popen') as runner:
            s.start_collector(self.profile, window/'request.json', window/'output.json')
        self.assertEqual(runner.call_args.args[0][-2:],
            ['--previous-receipt', str(self.root/'window-00000/confirmed-receipt.json')])

    def test_uncertain_delivery_never_releases_next_capture_gate(self):
        clock = [40]; processes = []
        self.client.lose_ack = self.client.deny_get = True
        def start(profile, path, out):
            process = instant_start(profile, path, out)
            process.poll = lambda: 0 if clock[0] >= process.request['end'] else None
            processes.append(process); return process
        def sleep(seconds):clock[0] += seconds
        with patch.object(s, 'stop_process_group') as stop:
            status = s.run_daily(self.client, self.profile, self.root, start=start, finish=instant_finish,
                now=lambda: clock[0], monotonic=lambda: clock[0], sleep=sleep)
        self.assertEqual(status, 2)
        stop.assert_called_once_with(processes[1])
        self.assertEqual(len(self.client.puts), 1)
        self.assertFalse((self.root/'window-00000/confirmed-receipt.json').exists())

    def test_interrupted_prewarm_request_is_never_restarted(self):
        window = s.private_directory(self.root/'window-00000')
        s.immutable(window/'request.json', s.request_for(self.profile, 0))
        status = s.run_daily(self.client, self.profile, self.root,
            start=lambda *_: self.fail('interrupted child cannot restart'), now=self.clock)
        self.assertEqual(status, 2)
        self.assertFalse((window/'confirmed-receipt.json').exists())


if __name__ == '__main__':
    unittest.main()
