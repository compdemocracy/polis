#!/usr/bin/env python3
"""Audit effective PEM trust stores, including both compromised CA paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
POLICY = json.loads((HERE / 'distrust.json').read_text())
BLOCKED = {c['sha256']: c['name'] for c in POLICY['roots'] + POLICY['intermediates']}
PEM = re.compile(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', re.S)


def audit_bundle(text, label):
    certs = PEM.findall(text)
    if not certs:
        raise ValueError(f'{label}: empty certificate bundle')
    if text.count('-----BEGIN CERTIFICATE-----') != len(certs):
        raise ValueError(f'{label}: truncated certificate bundle')
    context = ssl.create_default_context(cadata=text)
    for cert in certs:
        digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert)).hexdigest().upper()
        if digest in BLOCKED:
            raise ValueError(f'{label}: trusts {BLOCKED[digest]} ({digest})')
    remaining = []
    for ca in context.get_ca_certs():
        subject = ', '.join(value for rdn in ca['subject'] for key, value in rdn)
        if re.search('emsign|emudhra', subject, re.I):
            remaining.append(subject)
    print(f'PASS {label}: {len(certs)} certificates, no affected trust anchors')
    if remaining:
        print(f'INFO {label}: other eMudhra anchors: {json.dumps(remaining)}')
    return len(certs)


def verify_chain(bundle, chain):
    command = [os.environ.get('OPENSSL', 'openssl'), 'verify', '-no_check_time',
               '-no-CApath', '-no-CAstore', '-CAfile', str(bundle),
               '-purpose', 'sslserver', '-untrusted', str(chain), str(chain)]
    return subprocess.run(command, capture_output=True, text=True)


def audit_chains(text, label):
    """Ignore time so expiry cannot masquerade as distrust; use no system roots."""
    with tempfile.TemporaryDirectory(prefix='polis-tls-') as tmp:
        bundle = Path(tmp) / 'roots.pem'
        bundle.write_text(text)
        chains = sorted((HERE / 'fixtures').glob('*we-have-a-problem.com.pem'))
        if len(chains) != 12:
            raise ValueError('Expected all twelve direct and cross-signed TLS chains')
        for chain in chains:
            result = verify_chain(bundle, chain)
            output = result.stdout + result.stderr
            if result.returncode == 0 or not re.search(r'error (2|18|19|20|21|28) at', output):
                raise ValueError(f'{label}: chain did not fail for distrust: {chain.name}: {output}')
        print(f'PASS {label}: 12/12 compromised chains rejected for distrust')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundles', nargs='+', type=Path)
    args = parser.parse_args()
    for path in args.bundles:
        text = path.read_text()
        audit_bundle(text, str(path))
        audit_chains(text, str(path))


if __name__ == '__main__':
    main()
