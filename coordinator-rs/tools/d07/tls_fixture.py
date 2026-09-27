"""Ephemeral public-fixture CA and server; never used for a deployment.

The same transport setup is used by CI and D07. No scientific expectation or
case inventory changes. Private test keys stay outside campaign artifacts.
"""
from pathlib import Path
import subprocess
import tempfile


class TlsFixture:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='polis-coordinator-test-tls-')
        self.path = Path(self.tmp.name)
        for prefix in ('ca', 'other'):
            self.openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
                         '-subj', '/CN=Polis public fixture CA', '-keyout', prefix+'.key',
                         '-out', prefix+'.crt', '-addext', 'basicConstraints=critical,CA:TRUE')
        self.openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
                     '-keyout', 'server.key', '-out', 'server.csr')
        (self.path/'ext.cnf').write_text('subjectAltName=DNS:localhost,DNS:postgres,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n')
        self.openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
                     '-CAcreateserial', '-days', '2', '-out', 'server.crt', '-extfile', 'ext.cnf')
        # The container's postgres user must traverse the directory and read the
        # certificates; the private keys stay owner-only (the entrypoint copies
        # server.key as root before dropping privileges). TemporaryDirectory is
        # 0700, which fails on Linux hosts where the mount keeps host ownership.
        self.path.chmod(0o755)
        for p in self.path.glob('*.crt'): p.chmod(0o644)
        for p in self.path.glob('*.key'): p.chmod(0o600)

    def openssl(self, *args):
        subprocess.run(['openssl', *args], cwd=self.path, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def environment(self):
        return {'COORDINATOR_TEST_TLS_DIR': str(self.path),
                'COORDINATOR_DB_CA_BUNDLE': str(self.path/'ca.crt'),
                'COORDINATOR_DB_HOST_ALLOWLIST': '127.0.0.1,localhost'}

    def service(self, service):
        service.setdefault('volumes', []).append({'type':'bind', 'source':str(self.path),
            'target':'/fixture-tls', 'read_only':True})
        service['entrypoint'] = ['sh', '-ec',
            'cp /fixture-tls/server.key /tmp/fixture-server.key; '
            'chown postgres:postgres /tmp/fixture-server.key; chmod 600 /tmp/fixture-server.key; '
            'exec docker-entrypoint.sh postgres -c ssl=on '
            '-c ssl_cert_file=/fixture-tls/server.crt -c ssl_key_file=/tmp/fixture-server.key']
        service.pop('command', None)

    def close(self):
        self.tmp.cleanup()
