#!/usr/bin/env python3
"""Run the box worker locally on public fixtures, including regression controls."""
from __future__ import annotations
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
LOCAL = Path(__file__).resolve().parent


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--results', type=Path, required=True, help='new durable private directory')
    p.add_argument('--archives', type=Path, help='public-fixture OCI archives only; reader/producer/verifier.oci.tar')
    p.add_argument('--job', choices=['roles-census-v1', 'sampled-paired-battery-v1'], default='roles-census-v1')
    p.add_argument('--runtime-image', help='prebuilt worker.Dockerfile image; otherwise build locally')
    p.add_argument('--relay-source', type=Path, default=ROOT/'ci/probe_box/replica.py',
                   help='relay module to test; defaults to this checkout (for a separate pending relay change)')
    args = p.parse_args()
    project = os.environ.get('COMPOSE_PROJECT_NAME', '')
    port = os.environ.get('POLIS_RECOVERY_PG_PORT', '')
    if (not re.fullmatch(r'p027worker-[a-z0-9-]+', project) or not port.isdigit()
            or not 55432 <= int(port) <= 65000 or os.environ.get('RECOVERY_PG_PORT') != port):
        p.error('set a unique COMPOSE_PROJECT_NAME=p027worker-<slug> and equal PG ports (55432..65000)')
    if args.archives:
        args.archives = args.archives.resolve(strict=True)
        for role in ('reader', 'producer', 'verifier'):
            name = 'producer' if args.job == 'sampled-paired-battery-v1' and role == 'reader' else role
            if not (args.archives / (name+'.oci.tar')).is_file():
                p.error('missing '+name+'.oci.tar')
    results = args.results.resolve()
    results.mkdir(mode=0o700, parents=True, exist_ok=False)
    env = dict(os.environ, PROBE_WORKER_SOURCE=str(ROOT), PROBE_WORKER_RESULTS=str(results), BUILDX_CONFIG=str(results/'buildx'))
    relay_source = args.relay_source.resolve(strict=True)
    relay_bytes = relay_source.read_bytes()
    (results/'relay-source.py').write_bytes(relay_bytes)
    (results/'relay-source.json').write_text(json.dumps({
        'path': str(relay_source), 'sha256': hashlib.sha256(relay_bytes).hexdigest()}))
    env['PROBE_WORKER_RELAY'] = str(results/'relay-source.py')
    commands = []
    def call(argv, name, **kw):
        commands.append(argv)
        (results/'commands.json').write_text(json.dumps(commands, indent=2)+'\n')
        with (results/(name+'.log')).open('wb') as log:
            subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, env=env, check=True, **kw)
    # Fail before touching a project that belongs to another invocation.
    for kind in ('container', 'network', 'volume'):
        owned = subprocess.check_output(['docker', kind, 'ls', '-aq' if kind == 'container' else '-q', '--filter', 'label=com.docker.compose.project='+project])
        if owned.strip():
            raise RuntimeError('COMPOSE_PROJECT_ALREADY_EXISTS')
    sys.path.insert(0, str(ROOT/'coordinator-rs/tools/d07'))
    from tls_fixture import TlsFixture
    tls = TlsFixture()
    with tempfile.TemporaryDirectory(prefix='polis-worker-build-') as temp:
        temp = Path(temp)
        try:
            runtime = args.runtime_image or project+'-runtime'
            if not args.runtime_image:
                call(['docker', 'build', '--platform=linux/arm64', '-t', project+'-base', '-f', str(LOCAL/'Dockerfile'), str(LOCAL)], 'build-base')
                shutil.copyfile(LOCAL/'worker.Dockerfile', temp/'Dockerfile')
                shutil.copyfile(ROOT/'ci/probe_box/ami/requirements.lock', temp/'requirements.lock')
                call(['docker', 'build', '--platform=linux/arm64', '--build-arg', 'RUNTIME_IMAGE='+project+'-base', '-t', runtime, str(temp)], 'build-runtime')
            env['PROBE_WORKER_RUNTIME'] = runtime
            env['PROBE_WORKER_ARCHIVES'] = str(args.archives or temp)
            # JSON is accepted by Compose; only this generated override contains
            # the ephemeral key path. Private test keys never enter results.
            pg = {}
            tls.service(pg)
            override = temp/'tls.compose.json'
            override.write_text(json.dumps({'services': {'postgres': pg, 'runtime': {
                'volumes': [str(tls.path)+':/fixture-tls:ro']}}}))
            dc = ['docker', 'compose', '-f', str(LOCAL/'worker.compose.yml'), '-f', str(override)]
            (results/'options.json').write_text(json.dumps({'archives': bool(args.archives), 'job': args.job}))
            paths = list((ROOT/'ci/probe_box').glob('*.py')) + [ROOT/'ci/probe_box/bake.sh', ROOT/'ci/probe_box/jobs.json', ROOT/'ci/probe_box/ami/requirements.lock', ROOT/'ci/private_cert/images/roles_rehearsal.py', ROOT/'coordinator-rs/tools/d07/tls_fixture.py'] + [p for p in LOCAL.iterdir() if p.is_file()]
            source_hashes = {str(x.relative_to(ROOT)): hashlib.sha256(x.read_bytes()).hexdigest() for x in paths}
            (results/'source-sha256.json').write_text(json.dumps(source_hashes, indent=2))
            try:
                call(dc+['up', '-d', '--wait', 'postgres', 'minio'], 'compose-up')
                # Reuse the approved census's public role/grant layout without
                # importing its database-side modules into this host process.
                tree = ast.parse((ROOT/'ci/private_cert/images/roles_rehearsal.py').read_text())
                seed = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'SEED' for t in n.targets))
                seed += "\nSET password_encryption = 'scram-sha-256';\nALTER ROLE polis_probe_reader PASSWORD 'public-fixture-reader';\n"
                call(dc+['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'probe_test', '-v', 'ON_ERROR_STOP=1'], 'seed', input=seed.encode())
                call(dc+['run', '--rm', '--no-deps', 'runtime'], 'rehearsal')
                if any(hashlib.sha256((ROOT/p).read_bytes()).hexdigest() != digest for p,digest in source_hashes.items()):
                    raise RuntimeError('REHEARSAL_SOURCE_CHANGED')
                if relay_source.read_bytes() != relay_bytes or (results/'relay-source.py').read_bytes() != relay_bytes:
                    raise RuntimeError('REHEARSAL_RELAY_CHANGED')
                report = json.loads((results/'report.json').read_bytes())
                if report['status'] != 'PASS':
                    raise RuntimeError('REHEARSAL_FAILED')
                print(json.dumps(report, indent=2))
            finally:
                call(dc+['down', '-v', '--remove-orphans'], 'compose-down')
                cleanup = {kind: subprocess.check_output(['docker', kind, 'ls', '-aq' if kind == 'container' else '-q', '--filter', 'label=com.docker.compose.project='+project]).decode().split() for kind in ('container', 'network', 'volume')}
                (results/'cleanup.json').write_text(json.dumps(cleanup))
                if any(cleanup.values()):
                    raise RuntimeError('OWNED_RESOURCES_REMAIN')
        finally:
            tls.close()


if __name__ == '__main__':
    main()
