#!/usr/bin/env python3
"""Fresh HOME acceptance. Only anonymous real-issuer discovery; no token exchange.

The exact, flag-free login command must reach its configured loopback listener.
We own that port during this test so the command stops before opening a browser.
A second run prints the authorization URL without opening a browser; we send a
state-bound denial callback locally. This tests registration fields, not a real
account sign-in or provider client policy.
"""
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

BINARY = str(Path(sys.argv.pop(1)).resolve())
DEFAULTS = json.loads((Path(__file__).resolve().parents[1] / 'defaults.json').read_text())


class CleanMachine(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='polis-clean-')
        self.home = Path(self.tmp.name)
        # No POLIS_* variable, config override, proxy or inherited auth environment.
        self.env = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'LANG': 'C'}
        self.config = self.home / '.config' / 'polis'
        self.assertFalse(self.config.exists())
        self.auth = DEFAULTS['auth'][DEFAULTS['default']]

    def tearDown(self):
        self.assertFalse(self.config.exists(), 'No profile or credentials should be created')
        self.tmp.cleanup()

    def test_fresh_binary_targets_shipped_origin(self):
        result = subprocess.run([BINARY, 'conversation', 'share', 'FIXTURE'], env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['participation_url'].startswith('https://pol.is/'))

    def test_exact_flag_free_login_reaches_configured_callback(self):
        # Port collision is intentional and owned. No browser or provider write.
        with socket.socket() as listener:
            # Reuse a completed callback's TIME_WAIT socket, never a live listener.
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', self.auth['callback_port']))
            listener.listen()
            result = subprocess.run([BINARY, 'auth', 'login'], env=self.env,
                                    capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('[oauth_listener]', result.stderr)
        self.assertNotIn('oauth_unconfigured', result.stderr)
        self.assertNotIn('--site', result.stdout + result.stderr)
        print('Flag-free login: shipped issuer discovery succeeded; registered callback reached; browser prevented by owned port.', flush=True)

    def test_shipped_authorization_fields_and_denial(self):
        proc = subprocess.Popen([BINARY, 'auth', 'login', '--no-browser'], env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # Read bytes with select so unexpected failures cannot hang a build.
            data = b''
            deadline = time.monotonic() + 40
            while data.count(b'\n') < 2:
                self.assertLess(time.monotonic(), deadline, 'No authorization URL before deadline')
                ready, _, _ = select.select([proc.stderr], [], [], 1)
                if ready:
                    chunk = os.read(proc.stderr.fileno(), 4096)
                    self.assertTrue(chunk, data.decode())
                    data += chunk
            lines = data.decode().splitlines()
            self.assertIn('Open this URL', lines[0])
            parsed = urllib.parse.urlparse(lines[1])
            params = urllib.parse.parse_qs(parsed.query)
            self.assertEqual(parsed.scheme, 'https')
            self.assertEqual(parsed.netloc, urllib.parse.urlparse(self.auth['issuer']).netloc)
            self.assertEqual(params['client_id'], [self.auth['client_id']])
            self.assertEqual(params['audience'], [self.auth['audience']])
            self.assertEqual(params['redirect_uri'], ['http://127.0.0.1:53147/oauth/callback'])
            self.assertEqual(params['scope'], ['openid profile email offline_access'])
            self.assertEqual(params['code_challenge_method'], ['S256'])
            target = params['redirect_uri'][0] + '?' + urllib.parse.urlencode(
                {'state': params['state'][0], 'error': 'access_denied'})
            try:
                urllib.request.urlopen(target, timeout=5).close()
            except urllib.error.HTTPError as error:
                self.assertEqual(error.code, 400)
            out, err = proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 3, err.decode())
            self.assertIn(b'[oauth_denied]', err)
            self.assertEqual(out, b'')
            print('Fresh authorization: shipped issuer/client/audience/callback, S256 and offline_access verified; local denial; no token exchange.', flush=True)
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=5)
            proc.stdout.close()
            proc.stderr.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
