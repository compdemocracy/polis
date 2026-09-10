#!/usr/bin/env python3
"""Sign a reviewed private admission, after baking and exact-version staging.

No key generation, key logging, private upload or cloud action. Key and JSON
paths belong outside the public checkout. Requires cryptography in the operator
runtime. The corresponding public key is independently admitted in the AMI.
"""
import argparse
import json
from pathlib import Path
from control import encoded


def main():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    p = argparse.ArgumentParser()
    p.add_argument('--unsigned', type=Path, required=True)
    p.add_argument('--private-key', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    key = serialization.load_pem_private_key(args.private_key.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise SystemExit('Ed25519 key required')
    a = json.loads(args.unsigned.read_bytes())
    if 'signature' in a:
        raise SystemExit('Refusing to silently replace an existing signature')
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    if a['signerPublicKey'] != public:
        raise SystemExit('Admission public key does not match signer')
    a['signature'] = key.sign(encoded(a)).hex()
    # Exclusive write and private mode. No stdout contains admission bytes.
    import os
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(encoded(a) + b'\n')


if __name__ == '__main__': main()
