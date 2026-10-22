#!/usr/bin/env python3
"""Block affected parent roots pending the Amazon Linux CA package update."""
import hashlib
from pathlib import Path
import re
import ssl


# Keep these certificate fingerprints aligned with ci/tls/distrust.json roots.
BLOCKED = {
    '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B',
    'D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4',
    '7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D',
    'F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5',
}
PEM = re.compile(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', re.S)


def block_roots(bundle, destination):
    certificates = PEM.findall(Path(bundle).read_text())
    if not certificates:
        raise ValueError('Source CA bundle is empty or malformed')
    matches = {}
    for certificate in certificates:
        digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate)).hexdigest().upper()
        if digest in BLOCKED:
            matches[digest] = certificate
    Path(destination).mkdir(parents=True, exist_ok=True)
    for digest, certificate in sorted(matches.items()):
        (Path(destination) / f'emudhra-{digest}.pem').write_text(certificate + '\n')
        print(f'Blocklisted certificate SHA256 {digest}')
    return set(matches)


def install_blocklist(source, destination):
    # A parent can remain trusted for email/object signing after leaving TLS.
    for purpose in ('tls', 'email', 'objsign'):
        block_roots(Path(source) / f'{purpose}-ca-bundle.pem', destination)


if __name__ == '__main__':
    install_blocklist('/etc/pki/ca-trust/extracted/pem',
                      '/etc/pki/ca-trust/source/blocklist')
