"""Local PG17 TLS admission controls. No migration or cloud API is called."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'coordinator-rs/tools/d07'))
from tls_fixture import TlsFixture


def main():
    project = os.environ['COMPOSE_PROJECT_NAME']
    port = int(os.environ['POLIS_RECOVERY_PG_PORT'])
    assert project.startswith('p027-idle-') and os.environ['RECOVERY_PG_PORT'] == str(port)
    assert 55432 <= port <= 65000
    for args in (['ps', '-aq'], ['network', 'ls', '-q'], ['volume', 'ls', '-q']):
        assert not subprocess.check_output(['docker', *args, '--filter', 'label=com.docker.compose.project='+project]).strip()
    checks = []
    tls = TlsFixture()
    with tempfile.TemporaryDirectory(prefix='polis-idle-test-') as directory:
        p = Path(directory)
        password = p/'password'; password.write_text('public-fixture-reader'); password.chmod(0o600)
        service = {'image': 'postgres:17.11', 'environment': {'POSTGRES_PASSWORD': 'public-fixture-admin',
            'POSTGRES_DB': 'p026', 'POSTGRES_INITDB_ARGS': '--auth-host=scram-sha-256'},
            'ports': [f'127.0.0.1:{port}:5432'], 'tmpfs': ['/var/lib/postgresql/data'],
            'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U postgres -d p026'], 'interval': '1s', 'timeout': '3s', 'retries': 40}}
        tls.service(service)
        services = {'postgres': service}
        if os.environ.get('COORDINATOR_TEST_IMAGE'):
            services['idle'] = {'image': os.environ['COORDINATOR_TEST_IMAGE'], 'read_only': True,
                'environment': {'DATABASE_URL': 'postgresql://polis_coordinator_observer_login@postgres:5432/p026?sslmode=verify-full',
                    'COORDINATOR_DB_HOST_ALLOWLIST': 'postgres', 'COORDINATOR_DB_CA_BUNDLE': '/etc/polis/local-ca.pem',
                    'COORDINATOR_BOOTSTRAP_USERNAME': 'polis_coordinator_observer_login',
                    'COORDINATOR_BOOTSTRAP_PASSWORD': 'public-fixture-reader'},
                'volumes': [str(tls.path/'ca.crt')+':/etc/polis/local-ca.pem:ro'],
                'command': ['--check']}
        compose = p/'compose.json'; compose.write_text(json.dumps({'services': services}))
        dc = ['docker', 'compose', '-f', str(compose)]
        env = dict(os.environ, **tls.environment(),
            DATABASE_URL=f'postgresql://polis_coordinator_observer_login@127.0.0.1:{port}/p026?sslmode=verify-full',
            COORDINATOR_DB_PASSWORD_FILE=str(password), COORDINATOR_MODE='inactive',
            COORDINATOR_WRITER_ENABLED='false', P026_RESERVATION_BYTES='0')
        binary = ROOT/'coordinator-rs/target/debug/coordinator-idle'
        def command(args, **kw): return subprocess.run([*dc, *args], check=True, capture_output=True, text=True, **kw)
        def sql(text): return command(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'p026', '-v', 'ON_ERROR_STOP=1', '-At'], input=text).stdout
        def probe(label, expected, args=('--check',), **updates):
            result = subprocess.run([str(binary), *args], env=env|updates, capture_output=True, text=True, timeout=20)
            assert result.returncode == (0 if expected == 'COORDINATOR_IDLE_VERIFIED' else 1), (label, result.stderr)
            assert (result.stdout+result.stderr).strip() == expected, (label, result.stdout, result.stderr)
            checks.append(label)
        try:
            command(['up', '-d', '--wait', '--pull', 'never', 'postgres'])
            sql("CREATE ROLE polis_coordinator_observer NOLOGIN; CREATE ROLE polis_coordinator_observer_login LOGIN PASSWORD 'public-fixture-reader'; GRANT polis_coordinator_observer TO polis_coordinator_observer_login; CREATE TABLE public.idle_canary(value text); INSERT INTO public.idle_canary VALUES ('public-fixture'); CREATE FUNCTION public.pc_idle_canary() RETURNS integer LANGUAGE sql AS 'SELECT 1'; REVOKE ALL ON FUNCTION public.pc_idle_canary() FROM PUBLIC;")
            before = sql("SELECT value FROM idle_canary; SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace;")
            probe('verified-readonly-idle', 'COORDINATOR_IDLE_VERIFIED')
            if 'idle' in services:
                packaged = command(['run', '--rm', '--no-deps', '--pull', 'never', 'idle'])
                assert packaged.stdout.strip() == 'COORDINATOR_IDLE_VERIFIED', packaged.stdout
                checks.append('packaged-arm64-readonly-idle')
            probe('writer-refused', 'IDLE_MODE_REFUSED', COORDINATOR_WRITER_ENABLED='true')
            probe('reservation-refused', 'IDLE_MODE_REFUSED', P026_RESERVATION_BYTES='1048576')
            probe('active-mode-refused', 'IDLE_MODE_REFUSED', COORDINATOR_MODE='run')
            probe('migration-command-refused', 'IDLE_COMMAND_REFUSED', args=('migrate',))
            probe('embedded-password-refused', 'DB-PASSWORD-CONFLICT', DATABASE_URL=env['DATABASE_URL'].replace('_login@', '_login:public-fixture-reader@'))
            probe('administrator-login-refused', 'IDLE_LOGIN_REFUSED', DATABASE_URL=env['DATABASE_URL'].replace('polis_coordinator_observer_login@', 'postgres@'))
            probe('wrong-ca-refused', 'DB-CONNECTION-REFUSED', COORDINATOR_DB_CA_BUNDLE=str(tls.path/'other.crt'))
            probe('wrong-host-refused', 'DB-HOST-REFUSED', COORDINATOR_DB_HOST_ALLOWLIST='invalid.example')
            probe('plaintext-mode-refused', 'DB-SSLMODE-REFUSED', DATABASE_URL=env['DATABASE_URL'].replace('verify-full', 'disable'))
            probe('missing-password-file-refused', 'DB-PASSWORD-FILE', COORDINATOR_DB_PASSWORD_FILE=str(p/'missing'))
            sql('GRANT INSERT ON idle_canary TO PUBLIC;')
            probe('public-write-refused', 'IDLE_AUTHORITY_REFUSED')
            sql('REVOKE INSERT ON idle_canary FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.pc_idle_canary() TO PUBLIC;')
            probe('public-control-execute-refused', 'IDLE_AUTHORITY_REFUSED')
            sql('REVOKE EXECUTE ON FUNCTION public.pc_idle_canary() FROM PUBLIC; CREATE ROLE unexpected NOLOGIN; GRANT unexpected TO polis_coordinator_observer_login;')
            probe('extra-membership-refused', 'IDLE_AUTHORITY_REFUSED')
            sql('REVOKE unexpected FROM polis_coordinator_observer_login; DROP ROLE unexpected; ALTER ROLE polis_coordinator_observer LOGIN;')
            probe('group-login-drift-refused', 'IDLE_AUTHORITY_REFUSED')
            sql('ALTER ROLE polis_coordinator_observer NOLOGIN;')
            child = subprocess.Popen([str(binary)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                import selectors
                selector = selectors.DefaultSelector(); selector.register(child.stdout, selectors.EVENT_READ)
                assert selector.select(20), 'idle startup missing'
                assert child.stdout.readline().strip() == 'COORDINATOR_IDLE_VERIFIED'
                assert sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='polis-coordinator-idle' AND state='idle';").strip() == '1'
                checks.append('daemon-connected-idle')
            finally:
                child.terminate(); child.communicate(timeout=10)
            assert sql("SELECT value FROM idle_canary; SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace;") == before
            checks.append('canary-and-catalog-preserved')
        finally:
            command(['down', '-v'])
            tls.close()
    print(json.dumps({'status': 'PASS', 'count': len(checks), 'checks': checks}))


if __name__ == '__main__': main()
