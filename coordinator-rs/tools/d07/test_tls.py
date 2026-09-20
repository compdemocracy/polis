"""Real PG transport controls, separate from the fixed science inventories."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).parent))
from tls_fixture import TlsFixture

ROOT = Path(__file__).resolve().parents[3]


def main():
    project = os.environ['COMPOSE_PROJECT_NAME']
    port = int(os.environ['POLIS_RECOVERY_PG_PORT'])
    assert os.environ['RECOVERY_PG_PORT'] == str(port)
    assert project.startswith('p027') or project.startswith('coordinator-tls-')
    assert 55432 <= port <= 65000
    fixture = TlsFixture()
    env = dict(os.environ, **fixture.environment())
    env['DATABASE_URL'] = f'postgresql://postgres@127.0.0.1:{port}/p026'
    env.pop('COORDINATOR_DB_PASSWORD_FILE', None)
    binary = ROOT/'coordinator-rs/target/debug/examples/tls_probe'
    subprocess.run(['cargo', 'build', '--locked', '--example', 'tls_probe'], cwd=ROOT/'coordinator-rs', check=True)
    checks = []
    with tempfile.TemporaryDirectory(prefix='polis-tls-compose-') as tmp:
        config = Path(tmp)/'compose.json'
        service = {'image':'postgres:17-alpine', 'environment':{'POSTGRES_USER':'postgres',
            'POSTGRES_DB':'p026', 'POSTGRES_HOST_AUTH_METHOD':'trust'},
            'ports':[f'127.0.0.1:{port}:5432'], 'tmpfs':['/var/lib/postgresql/data'],
            'healthcheck':{'test':['CMD-SHELL','pg_isready -U postgres -d p026'],
                'interval':'1s', 'timeout':'3s', 'retries':40}}
        fixture.service(service)
        config.write_text(json.dumps({'services':{'postgres':service}}))
        dc = ['docker','compose','-f',str(config)]
        def command(*args):
            return subprocess.run([*dc,*args], env=env, check=True, capture_output=True, text=True)
        for kind, args in [('container',['ps','-aq']),('network',['network','ls','-q']),('volume',['volume','ls','-q'])]:
            assert not subprocess.check_output(['docker',*args,'--filter',f'label=com.docker.compose.project={project}']).strip(), kind
        def probe(label, expected, **updates):
            result = subprocess.run([str(binary)], env=dict(env, **updates), capture_output=True, text=True, timeout=20)
            assert result.returncode == (0 if expected == 'TLS-VERIFIED' else 1), label
            assert (result.stdout+result.stderr).strip() == expected, (label, result.stdout, result.stderr)
            checks.append(label)
        try:
            command('up','-d','--wait')
            probe('verified-server', 'TLS-VERIFIED')
            probe('explicit-verify-full', 'TLS-VERIFIED', DATABASE_URL=env['DATABASE_URL']+'?sslmode=verify-full')
            probe('wrong-ca', 'DB-CONNECTION-REFUSED', COORDINATOR_DB_CA_BUNDLE=str(fixture.path/'other.crt'))
            # 127.0.0.2 routes to the same local published listener only on some
            # platforms. Instead regenerate server certificate with a wrong SAN.
            (fixture.path/'ext.cnf').write_text('subjectAltName=DNS:wrong.invalid\nextendedKeyUsage=serverAuth\n')
            fixture.openssl('x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key',
                '-CAcreateserial','-days','2','-out','server.crt','-extfile','ext.cnf')
            command('exec','-T','postgres','sh','-c','kill -HUP 1')
            # A restart removes asynchronous reload timing from the assertion.
            command('up','-d','--wait','--force-recreate')
            probe('wrong-hostname', 'DB-CONNECTION-REFUSED')
            probe('host-outside-allowlist', 'DB-HOST-REFUSED', COORDINATOR_DB_HOST_ALLOWLIST='wrong.invalid')
            probe('sslmode-disable', 'DB-SSLMODE-REFUSED', DATABASE_URL=env['DATABASE_URL']+'?sslmode=disable')
            probe('password-conflict', 'DB-PASSWORD-CONFLICT', DATABASE_URL=env['DATABASE_URL'].replace('postgres@','postgres:fixture-canary@'), COORDINATOR_DB_PASSWORD_FILE='/missing')
            probe('missing-ca', 'DB-CA-BUNDLE', COORDINATOR_DB_CA_BUNDLE='/missing')
            command('exec','-T','postgres','psql','-U','postgres','-d','p026','-c',"ALTER SYSTEM SET ssl=off")
            command('up','-d','--wait','--force-recreate')
            # The command-line ssl=on wins ALTER SYSTEM; recreate with ssl=off.
            service['entrypoint'] = ['docker-entrypoint.sh','postgres','-c','ssl=off']
            config.write_text(json.dumps({'services':{'postgres':service}}))
            command('up','-d','--wait','--force-recreate')
            probe('plaintext-server', 'DB-CONNECTION-REFUSED')
        finally:
            command('down','-v')
            fixture.close()
    print(json.dumps({'transport':'PASS','checks':checks,'count':len(checks)}))


if __name__ == '__main__': main()
