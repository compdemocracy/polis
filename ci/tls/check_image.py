#!/usr/bin/env python3
"""Inspect built images without starting the application or using credentials."""
import argparse
import json
import subprocess
from check_trust import BLOCKED, audit_bundle, audit_chains, audit_objects

from native_checks import node, run_native

def run(image, executable, *args):
    return subprocess.check_output(['docker', 'run', '--rm', '--network=none',
                                   '--entrypoint', executable, image, *args], text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image')
    parser.add_argument('--node', action='store_true')
    parser.add_argument('--python', action='store_true')
    parser.add_argument('--python-bin', default='python')
    parser.add_argument('--boto-only', action='store_true')
    parser.add_argument('--rpm', action='store_true')
    parser.add_argument('--jobs', action='store_true')
    parser.add_argument('--rds', action='store_true')
    parser.add_argument('--rds-only', action='store_true')
    parser.add_argument('--java', action='store_true')
    parser.add_argument('--manual-distrust', action='store_true')
    args = parser.parse_args()
    image = args.image
    bundles = {}
    if not args.rds_only:
        versions = run(image, 'sh', '-c', 'if command -v apk >/dev/null; then apk list --installed ca-certificates; elif command -v rpm >/dev/null; then rpm -q ca-certificates; else dpkg-query -W ca-certificates; fi')
        print(image, versions.strip())
        if not args.manual_distrust and not args.rpm:
            run(image, 'sh', '-ec', """if command -v apk >/dev/null; then
      apk info -e 'ca-certificates>=20261020-r0'
    else
      . /etc/os-release
      case "$VERSION_CODENAME" in
        bookworm) floor='20250419~deb12u2';;
        trixie) floor='20250419+deb13u1';;
        *) echo 'Unsupported distribution: declare and test its advisory version'; exit 1;;
      esac
      installed=$(dpkg-query -W -f='${Version}' ca-certificates)
      dpkg --compare-versions "$installed" ge "$floor"
    fi""")
            print('PASS distribution ca-certificates advisory version')
        bundles['system'] = run(image, 'cat', '/etc/pki/tls/certs/ca-bundle.crt' if args.rpm else '/etc/ssl/certs/ca-certificates.crt')
    if args.rpm:
        for purpose in ('tls', 'email', 'objsign'):
            path = f'/etc/pki/ca-trust/extracted/pem/{purpose}-ca-bundle.pem'
            bundles[path] = run(image, 'cat', path)
    if args.rds or args.rds_only:
        bundles['rds'] = run(image, 'cat', '/etc/polis/rds-ca.pem')
    if args.java:
        bundles['java-cacerts'] = run(image, 'keytool', '-list', '-rfc', '-cacerts', '-storepass', 'changeit')
    if args.node:
        version = run(image, 'node', '-p', 'process.versions.node').strip()
        parts = tuple(map(int, version.split('.')))
        floors = {22: (22, 23, 4), 24: (24, 22, 1), 26: (26, 12, 1)}
        if parts[0] not in floors or parts < floors[parts[0]]:
            raise ValueError(f'Unpatched Node: {version}')
        print('PASS Node', version)
        # Emit compact fingerprints instead of a large PEM dump; validate each
        # certificate with Node's own parser before checking the effective store.
        roots = json.loads(run(image, 'node', '-e', "const X=require('crypto').X509Certificate; console.log(JSON.stringify(require('tls').getCACertificates('default').map(p => new X(p).fingerprint256.replaceAll(':',''))))"))
        if len(roots) < 100:
            raise ValueError('Unexpectedly small Node default trust store')
        for digest in roots:
            if digest in BLOCKED:
                raise ValueError(f'Node default store trusts {BLOCKED[digest]}')
        print(f'PASS Node default store: {len(roots)} parsed certificates, no affected anchors')
        names = run(image, 'node', '-e', "const X=require('crypto').X509Certificate; console.log(JSON.stringify(require('tls').getCACertificates('default').map(p => new X(p).subject).filter(s => /emsign|emudhra/i.test(s))))")
        print('INFO Node other eMudhra anchors:', names.strip())
        bundles['node-default'] = run(image, 'node', '-e', "process.stdout.write(require('tls').getCACertificates('default').join('\\n'))")
        node(image)
    if args.python:
        metadata = json.loads(run(image, args.python_bin, '-c', """import json, certifi, botocore.httpsession
paths = {certifi.where(), botocore.httpsession.get_cert_path(True)}
try:
    import requests.certs
except ImportError:
    pass
else:
    paths.add(requests.certs.where())
print(json.dumps({'version': certifi.__version__, 'paths': sorted(paths)}))"""))
        if metadata['version'] != '2026.10.19':
            raise ValueError(f"Unexpected certifi: {metadata['version']}")
        for path in metadata['paths']:
            bundles[path] = run(image, 'cat', path)
        run_native(image, args.python_bin, '/audit/check-python.py', *(['--boto-only'] if args.boto_only else []))
    if args.java:
        run_native(image, 'java', '/audit/CheckJava.java')
    if args.jobs:
        print(run(image, '/usr/local/bin/polis-jobs', '--version').strip())
        # The final daemon must be present and dynamically loadable. Its CA
        # file is audited above; neither check starts jobs or opens a database.
    for label, text in bundles.items():
        audit_bundle(text, image + ':' + label)
        audit_chains(text, image + ':' + label)
        audit_objects(text, image + ':' + label)


if __name__ == '__main__':
    main()
