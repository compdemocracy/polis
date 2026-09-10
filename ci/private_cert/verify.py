#!/usr/bin/env python3
"""Private reviewer CLI: re-read exact S3 versions, run admitted independent gate,
then permit a minimal public summary ONLY after a bound CLEAN control receipt.
Raw artifacts and configuration never belong in the public repository.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile

from control import encoded, sha
from worker import CHUNK, file_sha, safe_extract, sandbox, validate_receipt


def verify(s3, admission, manifest_key, manifest_version, workspace):
    a = admission
    bucket = f'ppc-{a["account"]}-{a["id"]}-evidence'
    obj = s3.get_object(Bucket=bucket, Key=manifest_key, VersionId=manifest_version)
    raw = obj['Body'].read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024 or obj.get('VersionId') != manifest_version:
        raise ValueError('MANIFEST_VERSION_OR_SIZE')
    m = json.loads(raw)
    if set(m) != {'schema', 'admissionSha256', 'archiveSha256', 'archiveBytes', 'instanceArn', 'chunks', 'gateReceipt'} or m['schema'] != 'polis-private-evidence/1' or m['admissionSha256'] != sha(a):
        raise ValueError('MANIFEST_BINDING')
    prefix = f'runs/{a["id"]}/{m["instanceArn"]}/'
    if manifest_key != prefix + 'manifest.json' or not m['instanceArn'].startswith(f'arn:aws:ec2:{a["region"]}:{a["account"]}:instance/i-'):
        raise ValueError('MANIFEST_PATH')
    if type(m['archiveBytes']) is not int or not 0 < m['archiveBytes'] <= 180 * 1024 ** 3:
        raise ValueError('EVIDENCE_SIZE')
    if not isinstance(m['chunks'], list) or not 1 <= len(m['chunks']) <= 11520:
        raise ValueError('CHUNK_COUNT')
    archive = workspace / 'evidence.tar'
    with archive.open('xb') as out:
        total = 0
        for idx, c in enumerate(m['chunks']):
            if (set(c) != {'key', 'version', 'bytes', 'sha256'} or c['key'] != prefix + f'chunks/{idx:08d}'
                    or not c['version'] or c['version'] == 'null' or type(c['bytes']) is not int or not 0 < c['bytes'] <= CHUNK):
                raise ValueError('CHUNK_PATH_OR_SIZE')
            obj = s3.get_object(Bucket=bucket, Key=c['key'], VersionId=c['version'])
            data = obj['Body'].read(CHUNK + 1)
            if obj.get('VersionId') != c['version'] or len(data) != c['bytes'] or hashlib.sha256(data).hexdigest() != c['sha256']:
                raise ValueError('CHUNK_BINDING')
            total += len(data)
            if total > m['archiveBytes']:
                raise ValueError('EXCESS_EVIDENCE')
            out.write(data)
    if total != m['archiveBytes'] or file_sha(archive) != m['archiveSha256']:
        raise ValueError('ARCHIVE_BINDING')
    validate_receipt(m['gateReceipt'], a, m['archiveSha256'])
    safe_extract(archive, workspace / 'evidence', 180 * 1024 ** 3, 1000000)
    inputs, output = workspace / 'inputs', workspace / 'verdict'
    inputs.mkdir(mode=0o755)
    output.mkdir(mode=0o777)
    output.chmod(0o777)
    (inputs / 'admission.json').write_bytes(encoded(a))
    (inputs / 'evidence-sha256').write_text(m['archiveSha256'])
    (inputs / 'admission.json').chmod(0o444)
    (inputs / 'evidence-sha256').chmod(0o444)
    inputs.chmod(0o555)
    sandbox(a['verifierImage'], 'verify', [(workspace / 'evidence', '/evidence', 'ro'), (inputs, '/admission', 'ro'), (output, '/verdict', 'rw')], workspace / 'verifier.log', 12 * 3600)
    receipt_path = output / 'receipt.json'
    if receipt_path.is_symlink() or receipt_path.stat().st_size > 8192:
        raise ValueError('RECEIPT_SIZE')
    receipt = validate_receipt(json.loads(receipt_path.read_bytes()), a, m['archiveSha256'])
    controls_path = output / 'negative-controls.json'
    if controls_path.is_symlink() or controls_path.stat().st_size > 8192 or file_sha(controls_path) != receipt['negativeControlsSha256']:
        raise ValueError('NEGATIVE_CONTROLS_BINDING')
    if receipt != m['gateReceipt']:
        raise ValueError('INDEPENDENT_GATE_DISAGREEMENT')
    control = f'ppc-{a["account"]}-{a["id"]}-control'
    clean = json.loads(s3.get_object(Bucket=control, Key=f'control/{a["id"]}/clean.json')['Body'].read(65536))
    if (clean.get('status') != 'CLEAN' or clean.get('admissionSha256') != sha(a)
            or clean.get('instanceId') != m['instanceArn'].rsplit('/', 1)[1]
            or clean.get('fixtureVersions') != 0 or len(clean.get('volumes', [])) != 2):
        raise ValueError('TEARDOWN_UNKNOWN')
    # No bundle hash, object key/version, private inventory, free text, path,
    # row id or raw exception reaches the public result. Local file only.
    return {'schema': 'polis-private-summary/1', 'admissionId': a['id'], 'candidateSha': a['candidateSha'],
            'verdict': receipt['verdict'], 'reason': receipt['reason'], 'checks': receipt['checks']}


def main():
    import boto3
    p = argparse.ArgumentParser()
    p.add_argument('--admission', type=Path, required=True)
    p.add_argument('--trusted-public-key', type=Path, required=True)
    p.add_argument('--image-lock', type=Path, required=True)
    p.add_argument('--runtime-lock', type=Path, required=True)
    p.add_argument('--manifest-key', required=True)
    p.add_argument('--manifest-version', required=True)
    p.add_argument('--private-workspace', type=Path, required=True)
    p.add_argument('--summary', type=Path, required=True)
    args = p.parse_args()
    a = json.loads(args.admission.read_bytes())
    # Operator must independently admit the public key; a substituted admission
    # file is not made trustworthy merely by carrying a self-supplied signature.
    p2 = a['signature']
    if args.trusted_public_key.read_text().strip() != a['signerPublicKey']:
        raise ValueError('UNTRUSTED_ADMISSION_KEY')
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(a['signerPublicKey'])).verify(bytes.fromhex(p2), encoded({k: v for k, v in a.items() if k != 'signature'}))
    # Independent reviewer checks the admitted verifier BEFORE evidence downloads.
    from image_admission import bind_runtime_lock, check_preloaded, json_bytes
    image_lock = json_bytes(args.image_lock.read_bytes())
    bind_runtime_lock(image_lock, json_bytes(args.runtime_lock.read_bytes()), a)
    check_preloaded(image_lock, a, verifier_only=True)
    args.private_workspace.mkdir(mode=0o700, parents=True, exist_ok=False)
    result = verify(boto3.client('s3', region_name=a['region']), a, args.manifest_key, args.manifest_version, args.private_workspace)
    with args.summary.open('xb') as f:
        f.write(encoded(result) + b'\n')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('INCOMPLETE: private verification or cleanup failed; no public summary written') from None
