"""Offline diagnostics/transport checks; every SSM operation is a local stub."""
import base64
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bootstrap_log', ROOT / 'p022_bootstrap_log.py')
log = importlib.util.module_from_spec(spec)
spec.loader.exec_module(log)


class Diagnostics(unittest.TestCase):
    def test_credential_lines_and_private_key_are_removed(self):
        text = ('dnf: No match for argument: rlwrap\n'
                'Authorization: Bearer test-value\npassword=example-value\n'
                'https://example:example@host.invalid/file\n'
                '-----BEGIN PRIVATE KEY-----\nexample-key-body\n-----END PRIVATE KEY-----\n'
                'X-Amz-Security-Token=example-session\n')
        result = log.clean(text)
        self.assertIn('No match for argument: rlwrap', result)
        for value in ('test-value', 'example-value', 'example@', 'example-key-body', 'example-session'):
            self.assertNotIn(value, result)

    def test_tail_is_bounded_but_saved_log_is_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            source = 'first package\n' + ''.join(f'package {i}\n' for i in range(3000))
            (d/'input').write_text(source)
            data = log.capture(d/'input', d/'bootstrap.log')
            self.assertEqual(data, source.encode())
            tail = log.tail(data)
            self.assertLess(len(tail.encode()), 10000)
            self.assertLessEqual(len(tail.splitlines()), 80)
            self.assertNotIn('first package', tail)
            self.assertIn('package 2999', tail)

    def test_missing_log_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            self.assertEqual(log.capture(d/'missing', d/'log'), b'[bootstrap log unavailable]\n')

    def test_transport_roundtrip_and_invalid_chunk(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            (d/'input').write_text('No match for argument: rlwrap\n')
            metadata = log.prepare(d/'input', d/'log', d/'transport')
            encoded = b''.join(log.chunk(i, d/'transport') for i in range(1, metadata['chunks']+1))
            data = base64.b64decode(encoded, validate=True)
            self.assertEqual(log.hashlib.sha256(data).hexdigest(), metadata['sha256'])
            self.assertEqual(gzip.decompress(data), (d/'log').read_bytes())
            for index in (0, metadata['chunks']+1):
                with self.assertRaises(ValueError):
                    log.chunk(index, d/'transport')

    def test_oversized_log_fails_without_partial_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            (d/'input').write_bytes(b'x' * 64)
            original = log.MAX_LOG_BYTES
            try:
                log.MAX_LOG_BYTES = 32
                with self.assertRaises(ValueError):
                    log.capture(d/'input', d/'artifact')
                self.assertFalse((d/'artifact').exists())
            finally:
                log.MAX_LOG_BYTES = original

    def test_ssm_mode_has_its_own_allowlist_and_no_workflow_commands(self):
        result = log.filter_ssm('arbitrary output\np022 bootstrap result=failed\n'
                               'p022 bootstrap-log ::error::package absent\n'
                               'p022 bootstrap-log password=example-value\n')
        self.assertIn('p022 bootstrap result=failed', result)
        self.assertIn('bootstrap | ::error::package absent', result)
        self.assertNotIn('\n::error::', result)
        self.assertNotIn('arbitrary output', result)
        self.assertNotIn('example-value', result)


class LocalTransport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.d = Path(self.temp.name)
        self.lib = self.d/'lib'
        self.logs = self.d/'log'
        self.lib.mkdir()
        self.logs.mkdir()
        for name in ('p022_wait_bootstrap.sh', 'p022_collect_bootstrap.sh', 'p022_bootstrap_log.py'):
            value = (ROOT/name).read_text().replace('/var/lib', str(self.lib)).replace('/var/log', str(self.logs))
            value = value.replace('sleep 15', ':')
            (self.d/name).write_text(value)
        (self.d/'p022_ssm.sh').write_text('exec python3 "$(dirname "$0")/ssm_stub.py" "$@"\n')
        (self.d/'ssm_stub.py').write_text('''import subprocess, sys, os
from pathlib import Path
r = subprocess.run(['bash', '-c', sys.argv[2]], capture_output=True)
Path(__file__).with_name('last-stdout').write_bytes(r.stdout)
if os.environ.get('CORRUPT_CHUNK') == '1' and 'bootstrap-chunk' in sys.argv[1]:
    r.stdout = r.stdout[:-1]
sys.stdout.buffer.write(r.stdout)
sys.stderr.buffer.write(r.stderr)
sys.exit(r.returncode)
''')
        (self.logs/'polis-ci-userdata.log').write_text('No match for argument: rlwrap\npassword=example-value\n')

    def run_script(self, name, *args, **overrides):
        return subprocess.run(['bash', str(self.d/name), *args], capture_output=True,
                              env=os.environ | overrides)

    def test_failed_boot_reports_tail_before_checkout_and_full_log_is_collected(self):
        (self.lib/'polis-ci-failed').touch()
        r = self.run_script('p022_wait_bootstrap.sh')
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn(b'No match for argument: rlwrap', r.stdout)
        self.assertNotIn(b'example-value', r.stdout)
        destination = self.d/'artifacts'
        r = self.run_script('p022_collect_bootstrap.sh', str(destination))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('No match for argument: rlwrap', (destination/'bootstrap.log').read_text())
        self.assertEqual((destination/'bootstrap.log').read_bytes(),
                         (self.logs/'polis-ci/artifacts/bootstrap.log').read_bytes())
        self.assertFalse((self.d/'opt/polis').exists())

    def test_timeout_returns_tail_and_remains_failure(self):
        r = self.run_script('p022_wait_bootstrap.sh')
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn(b'result=timeout', r.stdout)
        self.assertIn(b'No match for argument', r.stdout)

    def test_ready_still_passes(self):
        (self.lib/'polis-ci-ready').touch()
        r = self.run_script('p022_wait_bootstrap.sh')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, b'p022 bootstrap result=ready\n')

    def test_corrupt_transfer_cannot_create_artifact(self):
        destination = self.d/'corrupt-artifacts'
        r = self.run_script('p022_collect_bootstrap.sh', str(destination), CORRUPT_CHUNK='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b'length mismatch', r.stderr)
        self.assertFalse((destination/'bootstrap.log').exists())


if __name__ == '__main__':
    unittest.main()
