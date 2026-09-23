"""Digest-bound OCI conversion, private daemon and sandbox failure controls."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import worker


class ResolverBakeTests(unittest.TestCase):
    """Execute the baked shell on local files; systemctl is an explicit double."""

    expected = 'nameserver 127.0.0.1\noptions timeout:2 attempts:2\n'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.etc = self.root/'etc'
        self.etc.mkdir()
        self.resolv = self.etc/'resolv.conf'
        self.nss = self.etc/'nsswitch.conf'
        self.nss.write_text('passwd: files\nhosts: files dns\ngroup: files\n')
        self.log = self.root/'systemctl.log'
        self.evidence = self.root/'evidence'
        self.evidence.mkdir()
        self.source = Path(__file__).with_name('bake.sh').read_text()

    def run_shell(self, script, enabled='masked', active='inactive', fail=''):
        # No real systemctl, boot, DNS, poweroff, or machine configuration calls.
        double = '''
boot_console() { :; }
systemctl() {
  printf '%s\\n' "$*" >> "$PROBE_TEST_LOG"
  if [ "$1" = "$PROBE_TEST_FAIL" ]; then return 1; fi
  case "$1" in
    is-enabled) printf '%s\\n' "$PROBE_TEST_ENABLED"; return 1 ;;
    is-active) printf '%s\\n' "$PROBE_TEST_ACTIVE"; return 3 ;;
  esac
}
'''
        script = script.replace('/etc/', str(self.etc)+'/')
        script = script.replace('/opt/polis-probe/venv/bin/python', shlex.quote(sys.executable))
        env = {**os.environ, 'PROBE_TEST_LOG': str(self.log),
               'PROBE_TEST_ENABLED': enabled, 'PROBE_TEST_ACTIVE': active,
               'PROBE_TEST_FAIL': fail, 'PROBE_BUILD_DIR': str(self.evidence)}
        return subprocess.run(['bash', '-c', 'set -euo pipefail\n'+double+script],
                              env=env, capture_output=True, text=True, timeout=10)

    def bake_resolver(self, **kw):
        block = self.source.split('# Resolver ownership (offline bake).\n', 1)[1]
        return self.run_shell(block.split('# End resolver ownership.\n', 1)[0], **kw)

    def boot_dns(self, **kw):
        start = self.source.split("<<'START'\n", 1)[1].split('\nSTART', 1)[0]
        trap = next(line for line in start.splitlines() if line.startswith("trap 'rc=$?"))
        dns = 'BOOT_PHASE=dns\n'+start.split('BOOT_PHASE=dns\n', 1)[1].split('\nmode=', 1)[0]
        return self.run_shell('boot_failure() { printf "%s\\n" "$BOOT_PHASE" > "'+
                              str(self.root/'failure')+'"; }\n'+trap+'\n'+dns, **kw)

    def test_boot_refuses_link_without_touching_target_and_records_dns_failure(self):
        target = self.root/'uplink'
        target.write_text('nameserver 192.0.2.53\n')
        self.resolv.symlink_to(target)
        result = self.boot_dns()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), 'nameserver 192.0.2.53\n')
        self.assertTrue(self.resolv.is_symlink())
        self.assertEqual((self.root/'failure').read_text(), 'dns\n')
        self.assertEqual(self.log.read_text(), 'poweroff\n')

    def test_boot_refuses_missing_directory_and_dangling_link(self):
        for kind in ('missing', 'directory', 'dangling'):
            with self.subTest(kind=kind):
                if kind == 'directory': self.resolv.mkdir()
                if kind == 'dangling': self.resolv.symlink_to(self.root/'absent')
                self.assertNotEqual(self.boot_dns().returncode, 0)
                self.assertNotIn('start polis-probe-dns.service', self.log.read_text())
                self.assertEqual((self.root/'failure').read_text(), 'dns\n')
                if kind == 'directory': self.resolv.rmdir()

    def test_boot_requires_persistent_mask_and_inactive_service(self):
        for enabled, active in [('enabled', 'inactive'), ('disabled', 'inactive'),
                                ('masked-runtime', 'inactive'), ('', 'inactive'),
                                ('masked', 'active'), ('masked', 'unknown')]:
            with self.subTest(enabled=enabled, active=active):
                self.resolv.write_text('unchanged\n')
                self.assertNotEqual(self.boot_dns(enabled=enabled, active=active).returncode, 0)
                self.assertEqual(self.resolv.read_text(), 'unchanged\n')
                self.assertNotIn('start polis-probe-dns.service', self.log.read_text())

    def test_boot_regular_file_and_masked_inactive_service_start_forwarder(self):
        self.resolv.write_text('old\n')
        result = self.boot_dns()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.resolv.read_text(), self.expected)
        self.assertFalse((self.root/'failure').exists())
        self.assertIn('start polis-probe-dns.service\npoweroff\n', self.log.read_text())

    def test_bake_replaces_link_preserves_target_and_records_ownership(self):
        target = self.root/'uplink'
        target.write_text('upstream\n')
        self.resolv.symlink_to(target)
        self.nss.write_text('# public fixture\npasswd: files\nhosts: files resolve [!UNAVAIL=return] dns myhostname\n')
        result = self.bake_resolver()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.resolv.is_symlink())
        self.assertEqual(self.resolv.read_text(), self.expected)
        self.assertEqual(self.resolv.stat().st_mode & 0o777, 0o644)
        self.assertEqual(target.read_text(), 'upstream\n')
        self.assertEqual(self.nss.read_text(), '# public fixture\npasswd: files\nhosts: files dns\n')
        record = json.loads((self.evidence/'resolver.json').read_text())
        self.assertTrue(record['before']['symlink'])
        self.assertEqual(record['after'], {'symlink': False, 'regular': True, 'mode': '0644'})
        self.assertEqual(record['resolved'], {'enabled': 'masked', 'active': 'inactive'})
        self.assertEqual(record['hosts_after'], ['files', 'dns'])
        self.assertIn('myhostname', record['hosts_before'])
        self.assertEqual(self.log.read_text().splitlines()[:2],
                         ['disable --now systemd-resolved', 'mask systemd-resolved.service'])
        # A later update of the former DHCP-managed target cannot alter our file.
        target.write_text('renewed upstream\n')
        self.assertEqual(self.resolv.read_text(), self.expected)

    def test_bake_normalizes_nss_and_preserves_safe_file(self):
        for hosts in ('hosts: files dns # safe', ' hosts:\tresolve dns myhostname',
                      'hosts: dns files', 'hosts: files dns myhostname'):
            with self.subTest(hosts=hosts):
                self.nss.write_text('passwd: files\n'+hosts+'\ngroup: files\n')
                result = self.bake_resolver()
                self.assertEqual(result.returncode, 0, result.stderr)
                want = hosts if hosts == 'hosts: files dns # safe' else 'hosts: files dns'
                self.assertEqual(self.nss.read_text(), 'passwd: files\n'+want+'\ngroup: files\n')

    def test_bake_refuses_ambiguous_nss_and_failed_unit_changes(self):
        for content in ('passwd: files\n', 'hosts: files dns\nhosts: resolve\n'):
            self.nss.write_text(content)
            self.assertNotEqual(self.bake_resolver().returncode, 0)
            self.assertEqual(self.nss.read_text(), content)
        self.nss.write_text('hosts: files dns\n')
        for fail in ('disable', 'mask'):
            self.assertNotEqual(self.bake_resolver(fail=fail).returncode, 0)
        self.assertNotEqual(self.bake_resolver(enabled='enabled').returncode, 0)
        self.assertNotEqual(self.bake_resolver(active='active').returncode, 0)
        self.assertFalse((self.evidence/'resolver.json').exists())

    def test_bake_accepts_dangling_link_and_is_repeatable(self):
        self.resolv.symlink_to(self.root/'absent')
        for _ in range(2):
            result = self.bake_resolver()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(self.resolv.is_symlink())
            self.assertEqual(self.resolv.read_text(), self.expected)

    def test_bake_does_not_reconfigure_networkd(self):
        self.assertNotIn('/etc/systemd/network/', self.source)
        self.assertNotIn('networkctl', self.source)
        self.assertNotIn('restart systemd-networkd', self.source)


class RuntimeTests(unittest.TestCase):
    config = 'sha256:'+'c'*64

    def manifest(self, **changes):
        return dict(schemaVersion=2, mediaType='application/vnd.oci.image.manifest.v1+json',
                    config={'digest': self.config}, layers=[], **changes)

    def load(self, manifest=None, info=None, digest=None):
        raw = json.dumps(manifest or self.manifest()).encode()
        image = 'localhost/probe@sha256:'+(digest or hashlib.sha256(raw).hexdigest())
        info = info or {'Id': self.config, 'Architecture': 'arm64', 'Os': 'linux'}
        with patch.object(worker.subprocess, 'check_output', side_effect=[raw, json.dumps([info]).encode()]) as inspect, \
                patch.object(worker.subprocess, 'run') as copy:
            result = worker.load_image(Path('/probe-work/image.oci.tar'), image)
            return result, inspect.call_args_list, copy.call_args

    def test_oci_manifest_bound_to_loaded_config_without_registry_pull(self):
        result, inspect, copy = self.load()
        self.assertEqual(result, self.config)
        self.assertEqual(inspect[0].args[0], ['skopeo', 'inspect', '--raw', 'oci-archive:/probe-work/image.oci.tar'])
        self.assertEqual(inspect[1].args[0], worker.docker()+['image', 'inspect', self.config])
        argv = copy.args[0]
        self.assertEqual(argv[:6], ['skopeo', '--policy', '/opt/polis-probe/image-policy.json', 'copy',
                                    '--dest-daemon-host', 'unix:///probe-work/docker.sock'])
        self.assertTrue(argv[-1].startswith('docker-daemon:polis-probe-import:'))
        self.assertEqual(copy.kwargs['env']['TMPDIR'], '/probe-work/tmp')
        self.assertTrue(copy.kwargs['check'])

    def test_wrong_manifest_refuses_before_copy(self):
        with patch.object(worker.subprocess, 'check_output', return_value=b'wrong manifest'), \
                patch.object(worker.subprocess, 'run') as copy:
            with self.assertRaisesRegex(ValueError, 'IMAGE_DIGEST'):
                worker.load_image(Path('/probe-work/image.oci.tar'), 'localhost/probe@sha256:'+'0'*64)
            copy.assert_not_called()

    def test_index_and_invalid_config_refuse(self):
        for field, value in [('mediaType', 'application/vnd.oci.image.index.v1+json'),
                             ('schemaVersion', 1), ('config', {'digest': 'sha256:short'})]:
            with self.subTest(field=field):
                m = self.manifest(); m[field] = value
                with self.assertRaisesRegex(ValueError, 'IMAGE_MANIFEST|IMAGE_CONFIG'):
                    self.load(manifest=m)

    def test_loaded_config_id_and_platform_must_match(self):
        for field, value in [('Id', 'sha256:'+'d'*64), ('Architecture', 'amd64'), ('Os', 'windows')]:
            with self.subTest(field=field):
                info = {'Id': self.config, 'Architecture': 'arm64', 'Os': 'linux'}; info[field] = value
                with self.assertRaisesRegex(ValueError, 'IMAGE_CONFIG'):
                    self.load(info=info)

    def test_copy_failure_propagates_without_inspection(self):
        raw = json.dumps(self.manifest()).encode()
        with patch.object(worker.subprocess, 'check_output', return_value=raw) as inspect, \
                patch.object(worker.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'copy')):
            with self.assertRaises(subprocess.CalledProcessError):
                worker.load_image(Path('/probe-work/image.oci.tar'), 'localhost/probe@sha256:'+hashlib.sha256(raw).hexdigest())
            self.assertEqual(inspect.call_count, 1)

    def sandbox(self, state=None, failure=None):
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker, 'SCRATCH', Path(tmp)), \
                patch.object(worker.subprocess, 'run', side_effect=[failure or SimpleNamespace(returncode=0), SimpleNamespace(returncode=0)]) as run, \
                patch.object(worker.subprocess, 'check_output', return_value=json.dumps([{'State': state or {'ExitCode': 0, 'OOMKilled': False}}]).encode()):
            try:
                worker.sandbox({'image': 'unused:mutable', 'args': ['probe']}, 'test',
                               [(Path(tmp)/'input', '/input', 'ro'), (Path(tmp)/'output', '/output', 'rw')],
                               time.time()+30, self.config)
            finally:
                self.assertEqual(run.call_args.args[0][-3:], ['rm', '--force', 'polis-probe-test'])
            return run.call_args_list[0].args[0]

    def test_sandbox_uses_id_and_preserves_limits_and_bind_modes(self):
        argv = self.sandbox()
        for flag in ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
                     '--security-opt=no-new-privileges', '--user=65534:65534', '--pids-limit=4096',
                     '--memory=112g', '--memory-swap=112g', '--cpus=14', '--ulimit=core=0:0',
                     '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=4g']:
            self.assertIn(flag, argv)
        self.assertEqual(argv[-2:], [self.config, 'probe'])
        self.assertNotIn('unused:mutable', argv)
        binds = [argv[i+1] for i, arg in enumerate(argv) if arg == '--mount']
        self.assertTrue(binds[0].endswith(',readonly'))
        self.assertFalse(binds[1].endswith(',readonly'))
        self.assertTrue(all('bind-propagation=rprivate' in bind for bind in binds))

    def test_failed_oom_and_nonzero_containers_are_removed(self):
        for state in [{'ExitCode': 1}, {'ExitCode': 0, 'OOMKilled': True}]:
            with self.subTest(state=state), self.assertRaisesRegex(ValueError, 'PROBE_EXECUTION_FAILED'):
                self.sandbox(state=state)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.sandbox(failure=subprocess.TimeoutExpired('run', 1))

    def test_sandbox_failure_carries_exit_and_exception_token_only(self):
        def run(argv, **kw):
            if hasattr(kw.get('stdout'), 'write'):
                kw['stdout'].write(b'Traceback (most recent call last):\n  File "/x.py", line 1\n'
                                   b'psycopg2.OperationalError: connection on socket "/replica/.s.PGSQL.5432" failed: zid 42\n')
            return SimpleNamespace(returncode=0)
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker, 'SCRATCH', Path(tmp)), \
                patch.object(worker.subprocess, 'run', side_effect=run), \
                patch.object(worker.subprocess, 'check_output', return_value=json.dumps([{'State': {'ExitCode': 1, 'OOMKilled': False}}]).encode()):
            with self.assertRaises(worker.SandboxFailure) as caught:
                worker.sandbox({'args': ['probe']}, 'test', [], time.time()+30, self.config)
        record = worker.failure_record('reader', caught.exception)
        self.assertEqual(record, {'schema': 'polis-probe-failure/1', 'stage': 'reader', 'type': 'SandboxFailure',
                                  'code': 'PROBE_EXECUTION_FAILED',
                                  'container': {'label': 'test', 'exit': 1, 'oom': False, 'class': 'psycopg2.OperationalError'}})
        self.assertNotIn('zid', json.dumps(record))
        aws = type('ClientError', (Exception,), {})('An error occurred (AccessDenied) when calling GetObject on private/key')
        aws.response = {'Error': {'Code': 'AccessDenied', 'Message': 'private/key'}}
        self.assertEqual(worker.failure_record('images', aws),
                         {'schema': 'polis-probe-failure/1', 'stage': 'images', 'type': 'ClientError', 'aws': 'AccessDenied'})
        self.assertEqual(worker.failure_record('boot', ValueError('zid 42 is private')),
                         {'schema': 'polis-probe-failure/1', 'stage': 'boot', 'type': 'ValueError'})

    def test_shared_dir_mode_is_independent_of_the_unit_umask(self):
        import os
        previous = os.umask(0o077)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                masked = Path(tmp)/'masked'
                masked.mkdir(mode=0o755)
                self.assertEqual(masked.stat().st_mode & 0o777, 0o700)
                shared = worker.shared_dir(Path(tmp)/'replica')
                self.assertEqual(shared.stat().st_mode & 0o777, 0o755)
        finally:
            os.umask(previous)

    def test_container_reason_is_a_closed_code_never_the_message(self):
        cases = {
            'psycopg2.OperationalError: service file "/replica/service.conf" not found': 'PG_SERVICE_FILE',
            'psycopg2.OperationalError: connection to server on socket "/replica/.s.PGSQL.5432" failed: No such file or directory': 'ENOENT',
            'psycopg2.OperationalError: connection to server on socket "/x" failed: Permission denied': 'EACCES',
            'psycopg2.OperationalError: connection to server on socket "/x" failed: server closed the connection unexpectedly': 'PG_SERVER_CLOSED',
            'psycopg2.OperationalError: connection to server on socket "/x" failed: FATAL:  password authentication failed for user "zid42"': 'PG_AUTH_FAILED',
            'psycopg2.errors.QueryCanceled: canceling statement due to statement timeout': 'PG_STATEMENT_TIMEOUT',
            'psycopg2.OperationalError: something new about zid 42': None,
        }
        with tempfile.TemporaryDirectory() as tmp:
            for line, reason in cases.items():
                with self.subTest(reason=reason):
                    log = Path(tmp)/'c.log'
                    log.write_text(line+'\n')
                    token = worker.last_exception_token(log)
                    self.assertEqual(token.get('reason'), reason)
                    self.assertNotIn('zid', json.dumps(token))
                    self.assertNotIn('/replica', json.dumps(token))

    def test_unsatisfied_selection_role_exports_slug_rank_and_count_only(self):
        line = ("polismath.replay.fixture_survey.RoleUnsatisfied: missing role 'large-shape-rank-16' "
                "(slug pc-v1-large-r16): rule matched 9 conversation(s) but rank 16 was required; the config "
                "offers deterministic public-fixture case 'gen-v1-dense-stress' as a replacement, which requires "
                "an explicit recorded approval (--accept-public-fixture)")
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp)/'c.log'
            log.write_text('survey zid 42 topic secret\n'+line+'\n')
            token = worker.last_exception_token(log)
        self.assertEqual(token, {'class': 'polismath.replay.fixture_survey.RoleUnsatisfied',
                                 'role': 'pc-v1-large-r16', 'candidates': 9, 'rank': 16})
        self.assertNotIn('zid', json.dumps(token)); self.assertNotIn('large-shape', json.dumps(token))
        self.assertEqual(worker.selection_tokens('ValueError', '(slug pc-v1-x): matched 1 conversation(s) but rank 2 was required'), {})
        self.assertEqual(worker.selection_tokens('x.RoleUnsatisfied', 'missing role (slug PC-V1-UPPER): nothing'), {})

    def test_last_exception_token_keeps_only_class_names_and_codes(self):
        cases = {
            'psycopg2.OperationalError: connection to server failed: zid 42': {'class': 'psycopg2.OperationalError'},
            'polismath.replay.fixture_config.SelectionError: REPORT_FIELDS': {'class': 'polismath.replay.fixture_config.SelectionError', 'code': 'REPORT_FIELDS'},
            'INCOMPLETE: admitted image closure or action invalid': {'code': 'INCOMPLETE'},
            'Password: hunter2': {},
            'permission denied for table votes': {},
            'x' * 200 + 'Error: y': {},
        }
        with tempfile.TemporaryDirectory() as tmp:
            for line, expected in cases.items():
                with self.subTest(line=line[:40]):
                    log = Path(tmp)/'c.log'
                    log.write_text('noise: zid 7\n'+line+'\n\n')
                    self.assertEqual(worker.last_exception_token(log), expected)
            self.assertEqual(worker.last_exception_token(Path(tmp)/'missing.log'), {})

    def test_relay_reports_upstream_outcomes_without_payload(self):
        import socket
        import replica

        class Upstream:
            def sendall(self, data): pass
            def recv(self, n): return b'N'
            def __enter__(self): return self
            def __exit__(self, *exc): return False
        cases = [('resolve', socket.gaierror('x')), ('connect', ConnectionRefusedError()),
                 ('connect', TimeoutError()), ('no_tls', Upstream())]
        for outcome, upstream in cases:
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as tmp:
                failing = isinstance(upstream, BaseException)
                with patch.object(replica.socket, 'create_connection',
                                  side_effect=upstream if failing else None, return_value=None if failing else upstream):
                    with replica.ReplicaSocket(Path(tmp), 'db.internal', Path(tmp)/'ca.pem') as relay:
                        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                        client.settimeout(5)
                        client.connect(str(Path(tmp)/'.s.PGSQL.5432'))
                        self.assertEqual(client.recv(1), b'')
                        client.close()
                self.assertEqual(relay.summary(), {outcome: 1})
                self.assertEqual(worker.failure_record('reader', ValueError('PROBE_EXECUTION_FAILED'), relay)['relay'], {outcome: 1})

    def test_sandbox_refuses_mutable_image_before_execution(self):
        with patch.object(worker.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'IMAGE_CONFIG'):
                worker.sandbox({'args': []}, 'test', [], time.time()+1, 'image:latest')
            run.assert_not_called()

    def test_start_script_waits_for_the_private_disk_and_daemon_and_records_boot_phases(self):
        bake = Path(__file__).with_name('bake.sh').read_text()
        start = bake.split("<<'START'\n")[1].split('\nSTART')[0]
        self.assertLess(start.index('for attempt in $(seq 1 60)'), start.index('[ -n "$private_disk" ]'))
        self.assertLess(start.index('systemctl start polis-probe-container.service'), start.index('docker --host unix:///probe-work/docker.sock info'))
        for phase in ('boot-config', 'firewall', 'dns', 'private-disk', 'container-daemon', 'worker'):
            self.assertIn('BOOT_PHASE='+phase, start)
        self.assertIn('timeout 30 /opt/polis-probe/venv/bin/python /opt/polis-probe/boot_report.py', start)
        self.assertNotIn('from worker import', start)
        self.assertLess(start.index("trap 'rc=$?"), start.index('shutdown -h +720'))
        self.assertLess(start.index('boot_failure()'), start.index("trap 'rc=$?"))

    def test_daemon_never_uses_root_disk_system_containerd_or_network(self):
        bake = Path(__file__).with_name('bake.sh').read_text()
        config = json.loads(bake.split("<<'DOCKER'\n")[1].split('\nDOCKER')[0])
        for key in ['data-root', 'exec-root', 'pidfile']:
            self.assertTrue(config[key].startswith('/probe-work/'))
        self.assertEqual(config['hosts'], ['unix:///probe-work/docker.sock'])
        self.assertNotIn('containerd', config)
        self.assertEqual(config['storage-driver'], 'overlay2')
        self.assertEqual(config['bridge'], 'none')
        for key in ['iptables', 'ip6tables', 'ip-forward', 'ip-masq', 'userland-proxy']:
            self.assertIs(config[key], False)
        self.assertEqual(config['log-driver'], 'none')
        self.assertIn('ConditionPathIsMountPoint=/probe-work', bake)
        self.assertLess(bake.index('mount -o nodev,nosuid,noexec'), bake.index('systemctl start polis-probe-container.service'))
        self.assertIn('mask swap.target docker.service docker.socket containerd.service', bake)
        policy = json.loads(bake.split("<<'POLICY'\n")[1].split('\nPOLICY')[0])
        self.assertEqual(policy['default'], [{'type': 'reject'}])
        self.assertEqual(set(policy['transports']), {'oci-archive'})


class PlainScramTests(unittest.TestCase):
    @staticmethod
    def sasl(*names):
        import struct
        body = struct.pack('!I', 10) + b'\0'.join(names) + b'\0\0'
        return b'R' + struct.pack('!I', len(body) + 4) + body

    def test_removes_plus_and_recomputes_length(self):
        import replica
        for names in [(b'SCRAM-SHA-256-PLUS', b'SCRAM-SHA-256'),
                      (b'SCRAM-SHA-256', b'SCRAM-SHA-256-PLUS')]:
            with self.subTest(names=names):
                self.assertEqual(replica.advertise_plain_scram(self.sasl(*names)),
                                 self.sasl(b'SCRAM-SHA-256'))

    def test_other_first_messages_and_plain_offer_unchanged(self):
        import replica
        import struct
        for message in [self.sasl(b'SCRAM-SHA-256'),
                        b'R' + struct.pack('!II', 8, 0),
                        b'R' + struct.pack('!II', 8, 3),
                        b'E' + struct.pack('!I', 9) + b'error']:
            with self.subTest(message=message):
                self.assertEqual(replica.advertise_plain_scram(message), message)

    def test_trailing_bytes_are_unchanged(self):
        import replica
        message = self.sasl(b'SCRAM-SHA-256-PLUS', b'SCRAM-SHA-256')
        trailing = self.sasl(b'SCRAM-SHA-256-PLUS') + b'\xff\0arbitrary'
        self.assertEqual(replica.advertise_plain_scram(message + trailing),
                         self.sasl(b'SCRAM-SHA-256') + trailing)

    def test_partial_at_every_cut(self):
        import replica
        import struct
        for message in [self.sasl(b'SCRAM-SHA-256-PLUS', b'SCRAM-SHA-256'),
                        self.sasl(b'SCRAM-SHA-256'), b'R' + struct.pack('!II', 8, 0)]:
            for cut in range(len(message)):
                with self.subTest(message=message, cut=cut):
                    self.assertIsNone(replica.advertise_plain_scram(message[:cut]))
            self.assertIsNotNone(replica.advertise_plain_scram(message))

    def test_declared_length_refusals(self):
        import replica
        import struct
        for length in (0, 4, 7, 65537, 0xffffffff):
            with self.subTest(length=length), self.assertRaisesRegex(OSError, '^SASL_MESSAGE_SHAPE$'):
                replica.advertise_plain_scram(b'R' + struct.pack('!I', length))

    def test_malformed_mechanism_list_refused(self):
        import replica
        import struct
        for names in (b'', b'SCRAM-SHA-256', b'SCRAM-SHA-256\0',
                      b'\0\0', b'SCRAM-SHA-256\0\0other\0\0'):
            with self.subTest(names=names), self.assertRaisesRegex(OSError, '^SASL_MESSAGE_SHAPE$'):
                replica.advertise_plain_scram(b'R' + struct.pack('!II', 8 + len(names), 10) + names)

    def test_only_plus_refused(self):
        import replica
        with self.assertRaisesRegex(OSError, '^SASL_NO_PLAIN_MECHANISM$'):
            replica.advertise_plain_scram(self.sasl(b'SCRAM-SHA-256-PLUS'))

    def test_maximum_declared_length(self):
        import replica
        import struct
        message = b'R' + struct.pack('!II', 65536, 0) + b'x' * (65536 - 8)
        self.assertIsNone(replica.advertise_plain_scram(message[:-1]))
        self.assertEqual(replica.advertise_plain_scram(message), message)

    def exercise_relay(self, chunks, expected, outcomes):
        import replica
        import socket
        import threading
        # Readiness uses real socketpair bytes; TLS recv returns one prescribed
        # chunk per signal so this exercises buffering across select iterations.
        signal, peer = socket.socketpair()
        self.addCleanup(signal.close)
        self.addCleanup(peer.close)
        sent = bytearray()
        forwarded = threading.Event()
        request = b'client startup\0SCRAM-SHA-256-PLUS\0unchanged'

        class Secure:
            def __init__(self): self.chunks = iter(chunks)
            def fileno(self): return signal.fileno()
            def recv(self, n):
                signal.recv(1)
                return next(self.chunks)
            def sendall(self, data):
                sent.extend(data)
                if len(sent) == len(request): forwarded.set()
            def __enter__(self): return self
            def __exit__(self, *exc): return False

        class Upstream:
            def sendall(self, data): pass
            def recv(self, n): return b'S'
            def __enter__(self): return self
            def __exit__(self, *exc): return False

        secure = Secure()
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(replica.socket, 'create_connection', return_value=Upstream()), \
                patch.object(replica.ssl, 'create_default_context') as context:
            context.return_value.wrap_socket.return_value = secure
            with replica.ReplicaSocket(Path(tmp), 'db.internal', Path(tmp)/'ca.pem') as relay:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(5)
                    client.connect(str(Path(tmp)/'.s.PGSQL.5432'))
                    client.sendall(request)
                    self.assertTrue(forwarded.wait(5))
                    peer.sendall(b'x' * len(chunks))
                    actual = bytearray()
                    while len(actual) < len(expected):
                        data = client.recv(65536)
                        if not data: break
                        actual.extend(data)
                    self.assertEqual(bytes(actual), expected)
                    if outcomes == {'io': 1}:
                        self.assertEqual(client.recv(1), b'')
            self.assertEqual(bytes(sent), request)
            self.assertEqual(relay.summary(), outcomes)
            context.assert_called_once_with(cafile=str(Path(tmp)/'ca.pem'))
            self.assertEqual(context.return_value.wrap_socket.call_args.kwargs,
                             {'server_hostname': 'db.internal'})

    def test_relay_rewrites_fragmented_offer_once_and_preserves_client_bytes(self):
        message = self.sasl(b'SCRAM-SHA-256-PLUS', b'SCRAM-SHA-256')
        # A subsequent PLUS-shaped message must be piped raw, not rewritten.
        trailing = self.sasl(b'SCRAM-SHA-256-PLUS')
        self.exercise_relay([message[:2], message[2:7], message[7:] + b'tail', trailing],
                            self.sasl(b'SCRAM-SHA-256') + b'tail' + trailing,
                            {'plain_scram': 1, 'relayed': 1})

    def test_relay_passes_plain_offer_without_rewrite_count(self):
        message = self.sasl(b'SCRAM-SHA-256')
        self.exercise_relay([message[:3], message[3:]], message, {'relayed': 1})

    def test_relay_shape_and_no_plain_refusals_are_io(self):
        import struct
        for message in (b'R' + struct.pack('!I', 7), self.sasl(b'SCRAM-SHA-256-PLUS')):
            with self.subTest(message=message):
                self.exercise_relay([message], b'', {'io': 1})

    def test_relay_buffer_limit_is_io(self):
        import struct
        message = b'R' + struct.pack('!II', 65536, 0) + b'x' * (65536 - 8)
        self.exercise_relay([message[:65536], message[65536:]], b'', {'io': 1})
