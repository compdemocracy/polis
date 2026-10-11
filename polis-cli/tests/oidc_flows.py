#!/usr/bin/env python3
"""Local-only OIDC/API simulator. No real tenant, identity, Keychain or votes."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BINARY = str(Path(sys.argv.pop(1)).resolve())


class Simulator:
    def __init__(self):
        self.calls = []
        self.mode = 'normal'
        self.polls = []
        self.refreshes = []
        self.pkce = None
        self.refresh_value = 'fixture-refresh-1'
        self.api_status = 200
        self.lifetime = 3600
        self.device_lifetime = 60
        self.device_interval = 1
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), self.handler())
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)
        self.issuer = self.origin + '/'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def handler(self):
        sim = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, data):
                blob = json.dumps(data).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)

            def do_GET(self):
                sim.calls.append(('GET', self.path, self.headers.get('Authorization')))
                if self.path == '/.well-known/openid-configuration':
                    if sim.mode == 'redirect_metadata':
                        self.send_response(302)
                        self.send_header('Location', sim.origin + '/trap')
                        self.end_headers()
                        return
                    data = dict(issuer=sim.issuer, authorization_endpoint=sim.origin + '/authorize',
                                token_endpoint=sim.origin + '/token',
                                device_authorization_endpoint=sim.origin + '/device',
                                code_challenge_methods_supported=['S256'])
                    if sim.mode == 'wrong_issuer':
                        data['issuer'] = 'https://wrong.invalid/'
                    if sim.mode == 'no_device':
                        del data['device_authorization_endpoint']
                    self.reply(200, data)
                elif self.path.startswith('/api/v3/users'):
                    self.reply(sim.api_status, {'uid': 1} if sim.api_status == 200 else {'error': 'unauthorized'})
                else:
                    self.reply(404, {})

            def do_POST(self):
                fields = urllib.parse.parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode())
                fields = {k: v[0] for k, v in fields.items()}
                sim.calls.append(('POST', self.path, fields))
                if self.path == '/device':
                    self.reply(200, dict(device_code='fixture-device', user_code='TEST-CODE',
                                         verification_uri=sim.origin + '/verify', expires_in=sim.device_lifetime,
                                         interval=sim.device_interval))
                    return
                if self.path != '/token':
                    self.reply(404, {})
                    return
                grant = fields.get('grant_type')
                if grant == 'authorization_code':
                    actual = base64.urlsafe_b64encode(hashlib.sha256(fields['code_verifier'].encode()).digest()).decode().rstrip('=')
                    if actual != sim.pkce or fields.get('code') != 'fixture-code':
                        self.reply(400, {'error': 'invalid_grant'})
                        return
                elif grant == 'urn:ietf:params:oauth:grant-type:device_code':
                    sim.polls.append(time.monotonic())
                    if sim.mode in ('denied', 'expired'):
                        self.reply(400, {'error': 'access_denied' if sim.mode == 'denied' else 'expired_token'})
                        return
                    if len(sim.polls) == 1 and sim.mode in ('pending', 'slow'):
                        self.reply(400, {'error': 'authorization_pending' if sim.mode == 'pending' else 'slow_down'})
                        return
                elif grant == 'refresh_token':
                    sim.refreshes.append(fields)
                    if sim.mode == 'revoked':
                        self.reply(400, {'error': 'invalid_grant', 'error_description': 'fixture-secret-do-not-print'})
                        return
                    if sim.mode == 'transient':
                        self.reply(503, {'error': 'temporarily_unavailable'})
                        return
                    if sim.mode == 'delay_refresh':
                        time.sleep(2)
                    if fields.get('refresh_token') != sim.refresh_value:
                        self.reply(400, {'error': 'invalid_grant'})
                        return
                else:
                    self.reply(400, {'error': 'unsupported_grant_type'})
                    return
                data = {'access_token': 'fixture-access', 'token_type': 'Bearer', 'expires_in': sim.lifetime}
                if sim.mode != 'no_refresh':
                    if grant != 'refresh_token' or sim.mode != 'no_rotation':
                        if grant == 'refresh_token':
                            sim.refresh_value = 'fixture-refresh-rotated'
                        data['refresh_token'] = sim.refresh_value
                if sim.mode == 'bad_token_type':
                    data['token_type'] = 'Basic'
                if sim.mode == 'bad_expiry':
                    data['expires_in'] = 0
                self.reply(200, data)

        return Handler

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class Flows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='polis-auth0-')
        self.directory = Path(self.tmp.name)
        self.sim = Simulator()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('POLIS_')}
        self.env['POLIS_CONFIG_DIR'] = str(self.directory)
        self.config = {'default': 'local', 'sites': {'local': self.sim.origin}, 'auth': {'local': {
            'issuer': self.sim.issuer, 'client_id': 'fixture-public-client', 'audience': 'fixture-users', 'callback_port': 0}}}
        self.save_config()

    def tearDown(self):
        self.sim.close()
        self.tmp.cleanup()

    def save_config(self):
        (self.directory / 'profiles.json').write_text(json.dumps(self.config))

    def run_cli(self, *args, code=0, json_mode=True, **kwargs):
        cmd = [BINARY, '--no-interactive', '--timeout', '5', *args]
        if json_mode:
            cmd += ['--json']
        result = subprocess.run(cmd, env=self.env, capture_output=True, text=True, timeout=30, **kwargs)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        if args[:2] != ('auth', 'token'):
            for secret in ['fixture-access', 'fixture-refresh', 'fixture-device', 'fixture-secret-do-not-print']:
                self.assertNotIn(secret, result.stdout + result.stderr)
        return json.loads(result.stdout) if json_mode else result

    def credential(self):
        files = list((self.directory / 'credentials').glob('*.json'))
        self.assertEqual(len(files), 1)
        return files[0]

    def expire(self):
        path = self.credential()
        value = json.loads(path.read_text())
        value['session']['expires_at'] = 1
        path.write_text(json.dumps(value))

    def device(self):
        return self.run_cli('auth', 'login', '--device')

    def browser(self, callback_error=None):
        proc = subprocess.Popen([BINARY, '--no-interactive', '--json', 'auth', 'login', '--no-browser'],
                                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            line = proc.stderr.readline()
            self.assertIn('Open this URL', line)
            url = proc.stderr.readline().strip()
            params = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            self.assertEqual(params['code_challenge_method'], ['S256'])
            self.assertEqual(params['scope'], ['openid profile email offline_access'])
            self.assertEqual(params['audience'], ['fixture-users'])
            self.sim.pkce = params['code_challenge'][0]
            target = params['redirect_uri'][0]
            query = {'state': params['state'][0], 'code': 'fixture-code'}
            # An unrelated callback cannot consume the valid transaction.
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(target + '?state=wrong&code=wrong', timeout=3)
            if callback_error == 'issuer':
                query['iss'] = 'https://wrong.invalid/'
            elif callback_error == 'denied':
                query = {'state': params['state'][0], 'error': 'access_denied'}
            try:
                urllib.request.urlopen(target + '?' + urllib.parse.urlencode(query), timeout=3).close()
            except urllib.error.HTTPError:
                pass
            out, err = proc.communicate(timeout=15)
            self.assertNotIn('fixture-refresh', out + err)
            self.assertNotIn('fixture-access', out + err)
            return proc.returncode, json.loads(out)
        finally:
            if proc.poll() is None:
                proc.terminate()  # Only the exact child we created.
                proc.wait(timeout=5)

    def test_browser_pkce_status_token_logout(self):
        code, result = self.browser()
        self.assertEqual(code, 0, result)
        self.assertEqual(result['data']['flow'], 'authorization_code_pkce_s256')
        self.assertTrue(result['data']['refresh_available'])
        self.run_cli('auth', 'status')
        self.assertEqual(self.run_cli('auth', 'token', json_mode=False).stdout, 'fixture-access\n')
        self.assertEqual(self.run_cli('auth', 'token')['data']['access_token'], 'fixture-access')
        self.run_cli('auth', 'logout')
        saved = self.credential().read_text()
        self.assertNotIn('fixture-', saved)
        self.run_cli('auth', 'status', code=3)

    def test_browser_callback_issuer_binding(self):
        code, result = self.browser('issuer')
        self.assertEqual(code, 3)
        self.assertEqual(result['error']['code'], 'oauth_issuer_mismatch')
        self.assertFalse(any(c[0] == 'POST' for c in self.sim.calls))

    def test_browser_denied(self):
        code, result = self.browser('denied')
        self.assertEqual(code, 3)
        self.assertEqual(result['error']['code'], 'oauth_denied')

    def test_device_pending_permissions_and_no_metadata_bearer(self):
        self.sim.mode = 'pending'
        result = self.device()
        self.assertEqual(result['data']['flow'], 'device_code')
        self.assertEqual(len(self.sim.polls), 2)
        self.assertGreaterEqual(self.sim.polls[1] - self.sim.polls[0], 0.95)
        self.assertEqual(stat.S_IMODE(self.credential().stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.credential().parent.stat().st_mode), 0o700)
        for method, path, data in self.sim.calls:
            if path == '/.well-known/openid-configuration':
                self.assertIsNone(data)
            if path == '/device':
                self.assertEqual(data['scope'], 'openid profile email offline_access')
                self.assertEqual(data['client_id'], 'fixture-public-client')
                self.assertEqual(data['audience'], 'fixture-users')

    def test_device_slow_down(self):
        self.sim.mode = 'slow'
        self.device()
        self.assertEqual(len(self.sim.polls), 2)
        self.assertGreaterEqual(self.sim.polls[1] - self.sim.polls[0], 5.95)

    def test_device_denied(self):
        self.sim.mode = 'denied'
        result = self.run_cli('auth', 'login', '--device', code=3)
        self.assertEqual(result['error']['code'], 'oauth_denied')

    def test_device_expired(self):
        self.sim.mode = 'expired'
        result = self.run_cli('auth', 'login', '--device', code=3)
        self.assertEqual(result['error']['code'], 'oauth_device_expired')

    def test_device_local_deadline(self):
        self.sim.device_lifetime = 1
        self.sim.device_interval = 2
        result = self.run_cli('auth', 'login', '--device', code=3)
        self.assertEqual(result['error']['code'], 'oauth_device_expired')
        self.assertEqual(self.sim.polls, [])

    def test_device_not_advertised(self):
        self.sim.mode = 'no_device'
        result = self.run_cli('auth', 'login', '--device', code=3)
        self.assertEqual(result['error']['code'], 'oauth_device_unsupported')

    def test_discovery_exact_issuer(self):
        self.sim.mode = 'wrong_issuer'
        result = self.run_cli('auth', 'login', '--device', code=3)
        self.assertEqual(result['error']['code'], 'oauth_issuer_mismatch')
        self.assertFalse(any(c[0] == 'POST' for c in self.sim.calls))

    def test_discovery_no_redirect(self):
        self.sim.mode = 'redirect_metadata'
        self.run_cli('auth', 'login', '--device', code=3)
        self.assertEqual(len(self.sim.calls), 1)

    def test_refresh_rotates_and_is_silent(self):
        self.device()
        self.expire()
        result = self.run_cli('auth', 'status')
        self.assertTrue(result['ok'])
        self.assertEqual(len(self.sim.refreshes), 1)
        self.assertEqual(json.loads(self.credential().read_text())['session']['refresh_token'], 'fixture-refresh-rotated')
        self.run_cli('auth', 'status')
        self.assertEqual(len(self.sim.refreshes), 1)

    def test_refresh_keeps_nonrotating_token(self):
        self.device()
        self.sim.mode = 'no_rotation'
        self.expire()
        self.run_cli('auth', 'token')
        self.assertEqual(json.loads(self.credential().read_text())['session']['refresh_token'], 'fixture-refresh-1')

    def test_revocation_clears_credentials(self):
        self.device()
        self.expire()
        self.sim.mode = 'revoked'
        self.sim.calls.clear()
        result = self.run_cli('auth', 'status', code=3)
        self.assertEqual(result['error']['code'], 'oauth_login_required')
        self.assertNotIn('fixture-', self.credential().read_text())
        self.assertFalse(any('/api/' in c[1] for c in self.sim.calls))
        self.run_cli('auth', 'status', code=3)
        self.assertEqual(len(self.sim.refreshes), 1)

    def test_transient_refresh_retains_credentials_without_api(self):
        self.device()
        self.expire()
        before = self.credential().read_bytes()
        self.sim.mode = 'transient'
        self.sim.calls.clear()
        self.run_cli('auth', 'status', code=3)
        self.assertEqual(self.credential().read_bytes(), before)
        self.assertFalse(any('/api/' in c[1] for c in self.sim.calls))
        self.assertEqual(len(self.sim.refreshes), 1)

    def test_refresh_saved_before_api_failure(self):
        self.device()
        self.expire()
        self.sim.api_status = 401
        self.run_cli('auth', 'status', code=3)
        self.assertEqual(json.loads(self.credential().read_text())['session']['refresh_token'], 'fixture-refresh-rotated')

    def test_no_refresh_requires_relogin(self):
        self.sim.mode = 'no_refresh'
        self.assertFalse(self.device()['data']['refresh_available'])
        self.expire()
        self.assertEqual(self.run_cli('auth', 'token', code=3)['error']['code'], 'oauth_login_required')
        self.assertEqual(self.sim.refreshes, [])

    def test_changed_binding_never_uses_saved_token(self):
        self.device()
        self.sim.calls.clear()
        for field in ['issuer', 'client_id', 'audience']:
            original = self.config['auth']['local'][field]
            self.config['auth']['local'][field] = 'changed'
            self.save_config()
            result = self.run_cli('auth', 'status', code=3)
            self.assertEqual(result['error']['code'], 'oauth_session_mismatch')
            self.config['auth']['local'][field] = original
        self.assertEqual(self.sim.calls, [])

    def test_environment_override_skips_refresh(self):
        self.device()
        self.expire()
        self.env['POLIS_TOKEN_LOCAL'] = 'fixture-override'
        self.assertEqual(self.run_cli('auth', 'token')['data']['access_token'], 'fixture-override')
        self.assertEqual(self.sim.refreshes, [])
        self.run_cli('auth', 'logout')
        self.assertEqual(self.run_cli('auth', 'token')['data']['access_token'], 'fixture-override')

    def test_bad_responses_not_saved(self):
        for mode in ['bad_token_type', 'bad_expiry']:
            self.sim.mode = mode
            self.assertEqual(self.run_cli('auth', 'login', '--device', code=3)['error']['code'], 'oauth_response')
        self.assertFalse(list((self.directory / 'credentials').glob('*.json')))

    def test_api_rejection_does_not_save_login(self):
        self.sim.api_status = 401
        self.run_cli('auth', 'login', '--device', code=3)
        self.assertFalse(list((self.directory / 'credentials').glob('*.json')))

    def test_unsafe_credential_rejected(self):
        self.device()
        self.credential().chmod(0o644)
        self.assertEqual(self.run_cli('auth', 'token', code=3)['error']['code'], 'credential_file_unsafe')

    def test_concurrent_refresh_is_serialized(self):
        self.device()
        self.expire()
        self.sim.mode = 'delay_refresh'
        first = subprocess.Popen([BINARY, '--no-interactive', '--json', 'auth', 'status'],
                                 env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not self.sim.refreshes and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(self.sim.refreshes)
            self.assertEqual(self.run_cli('auth', 'logout', code=3)['error']['code'], 'credential_busy')
            self.assertEqual(self.run_cli('auth', 'status', code=3)['error']['code'], 'credential_busy')
            out, err = first.communicate(timeout=10)
            self.assertEqual(first.returncode, 0, out + err)
            self.assertEqual(len(self.sim.refreshes), 1)
        finally:
            if first.poll() is None:
                first.terminate()
                first.wait(timeout=5)

    def test_device_conflicting_flags(self):
        for flag in ['--browser', '--no-browser', '--token-stdin', '--with-token']:
            self.run_cli('auth', 'login', '--device', flag, code=2)
        self.assertEqual(self.sim.calls, [])

    def test_failed_login_preserves_existing_session(self):
        self.device()
        before = self.credential().read_bytes()
        self.sim.mode = 'denied'
        self.run_cli('auth', 'login', '--device', code=3)
        self.assertEqual(self.credential().read_bytes(), before)

    def test_new_origin_does_not_reuse_session(self):
        self.device()
        self.config['sites']['local'] = 'http://127.0.0.1:1'
        self.save_config()
        self.sim.calls.clear()
        self.run_cli('auth', 'token', code=3)
        self.assertEqual(self.sim.calls, [])

    def test_lock_symlink_is_refused(self):
        self.device()
        lock = self.credential().with_suffix('.lock')
        lock.unlink()
        target = self.directory / 'do-not-touch'
        target.write_text('unchanged')
        lock.symlink_to(target)
        self.assertEqual(self.run_cli('auth', 'token', code=3)['error']['code'], 'credential_file_unsafe')
        self.assertEqual(target.read_text(), 'unchanged')

    def test_manual_access_token_replaces_refresh_session(self):
        self.device()
        self.run_cli('auth', 'login', '--with-token', input='fixture-access\n')
        saved = json.loads(self.credential().read_text())
        self.assertNotIn('session', saved)
        self.run_cli('auth', 'status')
        self.assertEqual(self.sim.refreshes, [])

    def test_fresh_defaults_and_environment(self):
        (self.directory / 'profiles.json').unlink()
        result = self.run_cli('conversation', 'share', 'FIXTURE')
        self.assertEqual(result['site'], 'prod')
        self.assertTrue(result['data']['participation_url'].startswith('https://pol.is/'))
        self.env['POLIS_URL_PROD'] = self.sim.origin
        self.env['POLIS_AUTH_ISSUER_PROD'] = self.sim.issuer
        self.env['POLIS_AUTH_CLIENT_ID_PROD'] = 'fixture-public-client'
        self.env['POLIS_AUTH_AUDIENCE_PROD'] = 'fixture-users'
        self.device()
        self.assertTrue(self.run_cli('conversation', 'share', 'FIXTURE')['data']['participation_url'].startswith(self.sim.origin + '/'))

    def test_environment_selects_profile_without_rewriting_config(self):
        self.config['sites']['preprod'] = self.sim.origin
        self.config['auth']['preprod'] = self.config['auth']['local'].copy()
        self.save_config()
        original = (self.directory / 'profiles.json').read_bytes()
        self.env['POLIS_SITE'] = 'preprod'
        result = self.device()
        self.assertEqual(result['site'], 'preprod')
        self.assertEqual((self.directory / 'profiles.json').read_bytes(), original)
        self.assertEqual(json.loads(self.credential().read_text())['site'], 'preprod')
        del self.env['POLIS_SITE']
        self.run_cli('auth', 'status', code=3)

    def test_unknown_environment_profile_never_falls_back(self):
        for name, error in [('unknown', 'site_unconfigured'), ('../prod', 'invalid_input'), ('', 'invalid_input')]:
            self.env['POLIS_SITE'] = name
            result = self.run_cli('auth', 'login', code=2)
            self.assertEqual(result['error']['code'], error)
        self.assertEqual(self.sim.calls, [])

    def test_fresh_environment_browser_configuration(self):
        (self.directory / 'profiles.json').unlink()
        self.env.update(POLIS_SITE='local', POLIS_URL_LOCAL=self.sim.origin,
                        POLIS_AUTH_ISSUER_LOCAL=self.sim.issuer,
                        POLIS_AUTH_CLIENT_ID_LOCAL='fixture-public-client',
                        POLIS_AUTH_AUDIENCE_LOCAL='fixture-users',
                        POLIS_AUTH_CALLBACK_PORT_LOCAL='0')
        code, result = self.browser()
        self.assertEqual(code, 0, result)
        self.assertFalse((self.directory / 'profiles.json').exists())
        self.assertEqual(result['site'], 'local')

    def test_legacy_profile_uses_shipped_callback_port(self):
        del self.config['auth']['local']['callback_port']
        self.save_config()
        code, result = self.browser()
        self.assertEqual(code, 0, result)
        defaults = json.loads((Path(__file__).resolve().parents[1] / 'defaults.json').read_text())
        exchange = next(fields for method, path, fields in self.sim.calls if method == 'POST' and path == '/token')
        self.assertEqual(urllib.parse.urlparse(exchange['redirect_uri']).port,
                         defaults['auth'][defaults['default']]['callback_port'])

    def test_bad_callback_port_fails_before_network(self):
        for port in ['bad', '-1', '65536']:
            self.env['POLIS_AUTH_CALLBACK_PORT_LOCAL'] = port
            self.assertEqual(self.run_cli('auth', 'login', code=2)['error']['code'], 'invalid_input')
        self.assertEqual(self.sim.calls, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
