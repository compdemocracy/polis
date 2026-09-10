#!/usr/bin/env python3
"""Baked P-053 supervisor. No downloads of executable code at boot.

The admitted runner/verifier OCI images are preloaded and run without host
network, credentials or sockets. Their ABI is documented in docs/private-cert.md.
Only the independently pinned verifier may produce a private gate receipt.
"""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.request

from control import encoded, sha

CHUNK = 16 * 1024 * 1024
ROOT = Path('/opt/polis-private')
SCRATCH = Path('/private-cert')


def file_sha(p):
    h = hashlib.sha256()
    with Path(p).open('rb') as f:
        for b in iter(lambda: f.read(CHUNK), b''):
            h.update(b)
    return h.hexdigest()


def safe_extract(archive, destination, max_bytes, max_members):
    """Uncompressed tar only; complete census before extraction, no link types."""
    seen, total = set(), 0
    with tarfile.open(archive, mode='r:') as t:
        members = []
        for m in t:
            p = PurePosixPath(m.name)
            if (not m.isfile() or p.is_absolute() or '..' in p.parts or not p.parts
                    or str(p) != m.name or m.name in seen or '\\' in m.name
                    or any(ord(c) < 32 for c in m.name)):
                raise ValueError('UNSAFE_ARCHIVE')
            seen.add(m.name)
            total += m.size
            if total > max_bytes or len(seen) > max_members or m.size < 0:
                raise ValueError('ARCHIVE_LIMIT')
            members.append(m)
        if not members:
            raise ValueError('EMPTY_ARCHIVE')
        destination = Path(destination)
        destination.mkdir(mode=0o755, parents=True, exist_ok=False)
        for m in members:
            output = destination / m.name
            output.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            with output.open('xb') as f:
                shutil.copyfileobj(t.extractfile(m), f, CHUNK)
            output.chmod(0o444)
    # systemd uses UMask=0077; explicit chmod keeps the read-only bind view
    # readable by the unprivileged container without opening the private parent.
    for p in destination.rglob('*'):
        if p.is_dir():
            p.chmod(0o555)
    destination.chmod(0o555)
    return len(seen), total


def metadata():
    # No proxy: admission identity cannot be supplied by an ambient HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = 'http://169.254.169.254/latest/'
    req = urllib.request.Request(base + 'api/token', method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds': '300'})
    with opener.open(req, timeout=5) as r:
        token = r.read(1024).decode()
    req = urllib.request.Request(base + 'dynamic/instance-identity/document', headers={'X-aws-ec2-metadata-token': token})
    with opener.open(req, timeout=5) as r:
        return json.loads(r.read(8192))


def sandbox(image, action, mounts, log, timeout):
    # podman is used only by the trusted supervisor. There is no daemon socket
    # and no host socket, host PID namespace or credential mount in the child.
    cmd = ['podman', 'run', '--name', 'polis-private-' + action, '--pull=never',
           '--network=none', '--read-only', '--cap-drop=ALL',
           '--security-opt=no-new-privileges', '--user=65534:65534',
           '--pids-limit=4096', '--memory=112g', '--memory-swap=112g', '--cpus=14',
           '--ulimit=core=0:0', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=4g',
           '--env=OPENBLAS_NUM_THREADS=1', '--env=OMP_NUM_THREADS=1',
           '--env=MKL_NUM_THREADS=1', '--env=NUMEXPR_NUM_THREADS=1']
    for source, target, access in mounts:
        cmd += ['--volume', f'{source}:{target}:{access},nosuid,nodev']
    # exec-form ABI: no caller-provided argv, shell expression or mount.
    cmd += [image, action]
    try:
        with Path(log).open('wb') as f:
            result = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, timeout=timeout, check=False)
        inspected = subprocess.run(['podman', 'inspect', 'polis-private-' + action], capture_output=True, check=True)
        state = json.loads(inspected.stdout)[0]['State']
        if result.returncode != 0 or state.get('OOMKilled') or state.get('ExitCode') != 0:
            raise ValueError('PRODUCER_INCOMPLETE')
    finally:
        # Removal kills leftover children even if the producer command timed out.
        subprocess.run(['podman', 'rm', '--force', 'polis-private-' + action], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def validate_receipt(receipt, admission, evidence_sha):
    """Closed, bounded schema. Only trusted verifier output reaches this check.

    The verifier must recompute inventory/checkpoints/polarity/recovery and the
    strict comparison. This transport validator is deliberately not that gate.
    """
    keys = {'schema', 'admissionSha256', 'evidenceSha256', 'inventorySha256',
            'scheduleSha256', 'policySha256', 'checks', 'verdict', 'reason'}
    if type(receipt) is not dict or set(receipt) != keys:
        raise ValueError('RECEIPT_SCHEMA')
    if (receipt['schema'] != 'polis-private-gate/1' or receipt['admissionSha256'] != sha(admission)
            or receipt['evidenceSha256'] != evidence_sha):
        raise ValueError('RECEIPT_BINDING')
    for key in ('inventorySha256', 'scheduleSha256', 'policySha256'):
        if receipt[key] != admission[key]:
            raise ValueError('RECEIPT_BINDING')
    if type(receipt['checks']) is not int or not 0 <= receipt['checks'] <= admission['expectedChecks']:
        raise ValueError('RECEIPT_COUNTS')
    allowed = {'PASS': 'COMPLETE', 'FAIL': 'COMPARISON', 'INCOMPLETE': 'MISSING_EVIDENCE', 'INCONCLUSIVE': 'UNRESOLVED_POLICY'}
    if receipt['verdict'] not in allowed or receipt['reason'] != allowed[receipt['verdict']]:
        raise ValueError('RECEIPT_VERDICT')
    if receipt['verdict'] == 'PASS' and receipt['checks'] != admission['expectedChecks']:
        raise ValueError('SHORT_INVENTORY')
    return receipt


def upload_chunks(s3, path, boot, instance_arn):
    a = boot['admission']
    prefix = f'runs/{a["id"]}/{instance_arn}/'
    chunks = []
    with Path(path).open('rb') as f:
        for index, block in enumerate(iter(lambda: f.read(CHUNK), b'')):
            digest = hashlib.sha256(block).hexdigest()
            key = prefix + f'chunks/{index:08d}'
            result = s3.put_object(Bucket=boot['evidenceBucket'], Key=key, Body=block,
                                   IfNoneMatch='*', ServerSideEncryption='aws:kms', SSEKMSKeyId=boot['evidenceKey'])
            version = result.get('VersionId')
            if not version or version == 'null':
                raise ValueError('MISSING_VERSION')
            chunks.append({'key': key, 'version': version, 'bytes': len(block), 'sha256': digest})
    manifest = {'schema': 'polis-private-evidence/1', 'admissionSha256': sha(a),
                'archiveSha256': file_sha(path), 'archiveBytes': Path(path).stat().st_size,
                'instanceArn': instance_arn, 'chunks': chunks}
    return prefix, manifest


def run():
    import boto3
    # Bootstrap is baked BEFORE an AMI ID exists. The admission (which binds
    # that resulting AMI) is signed afterwards by the admitted curator key.
    # Reading this tiny untrusted control record precedes fixture access.
    bootstrap = json.loads((ROOT / 'bootstrap.json').read_bytes())
    identity = metadata()
    if identity['accountId'] != bootstrap['account'] or identity['region'] != bootstrap['region']:
        raise ValueError('BOOT_ACCOUNT')
    from botocore.config import Config
    s3 = boto3.client('s3', region_name=bootstrap['region'],
                      config=Config(s3={'us_east_1_regional_endpoint': 'regional', 'addressing_style': 'virtual'}))
    control_bucket = f'ppc-{bootstrap["account"]}-{bootstrap["id"]}-control'
    boot = None
    for _ in range(48):
        try:
            obj = s3.get_object(Bucket=control_bucket, Key=f'boot/{bootstrap["id"]}.json')
            raw = obj['Body'].read(65537)
            if len(raw) > 65536:
                raise ValueError('BOOT_OVERSIZE')
            boot = json.loads(raw)
            break
        except Exception:
            time.sleep(5)
    if not boot:
        raise ValueError('NO_BOOT_RECORD')
    a = boot['admission']
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    signature = a['signature']
    signed = {k: v for k, v in a.items() if k != 'signature'}
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(bootstrap['signerPublicKey'])).verify(bytes.fromhex(signature), encoded(signed))
    if (a['signerPublicKey'] != bootstrap['signerPublicKey'] or a['id'] != bootstrap['id']
            or a['account'] != bootstrap['account'] or a['region'] != bootstrap['region']
            or a['ami'] != identity['imageId'] or boot['instanceId'] != identity['instanceId']
            or boot['admissionSha256'] != sha(a)):
        raise ValueError('BOOT_ADMISSION')
    lock = json.loads((ROOT / 'runtime-lock.json').read_bytes())
    if set(lock) != {'bootstrap.json', 'control.py', 'dns.py', 'start.sh', 'firewall.nft'} or sha(lock) != a['runtimeSha256'] or file_sha(ROOT / 'worker.py') != a['supervisorSha256']:
        raise ValueError('RUNTIME_BINDING')
    for rel, digest in lock.items():
        p = ROOT / rel
        if p.resolve().parent != ROOT or file_sha(p) != digest:
            raise ValueError('RUNTIME_FILE')
    expires = __import__('datetime').datetime.fromisoformat(a['expiresAt'].replace('Z', '+00:00')).timestamp()
    if time.time() >= expires or expires - boot['started'] > 12 * 3600:
        raise ValueError('EXPIRED_OR_OVER_BUDGET')
    instance_arn = f'arn:aws:ec2:{a["region"]}:{a["account"]}:instance/{identity["instanceId"]}'
    stop = threading.Event()
    def heartbeat():
        while not stop.is_set():
            try:
                s3.put_object(Bucket=control_bucket, Key=f'heartbeats/{a["id"]}/{instance_arn}.json', Body=b'{}',
                              ServerSideEncryption='aws:kms', SSEKMSKeyId=boot['evidenceKey'])
            except Exception:
                # Sweeper uses S3 LastModified, never this process's claim.
                pass
            stop.wait(60)
    threading.Thread(target=heartbeat, daemon=True).start()
    try:
        if not SCRATCH.is_mount() or shutil.disk_usage(SCRATCH).free < a['fixtureBytes'] + a['expandedBytes'] + 32 * 1024 ** 3:
            raise ValueError('DISK_CAPACITY')
        work = SCRATCH / 'work'
        work.mkdir(mode=0o700)
        bundle = work / 'bundle.tar'
        obj = s3.get_object(Bucket=boot['fixtureBucket'], Key=a['fixtureKey'], VersionId=a['fixtureVersion'])
        if obj.get('VersionId') != a['fixtureVersion'] or obj['ContentLength'] != a['fixtureBytes']:
            raise ValueError('FIXTURE_VERSION_OR_SIZE')
        with bundle.open('xb') as f:
            remaining = a['fixtureBytes']
            while remaining:
                data = obj['Body'].read(min(CHUNK, remaining))
                if not data:
                    raise ValueError('TRUNCATED_FIXTURE')
                f.write(data)
                remaining -= len(data)
            if obj['Body'].read(1):
                raise ValueError('OVERSIZE_FIXTURE')
        if file_sha(bundle) != a['fixtureSha256']:
            raise ValueError('FIXTURE_DIGEST')
        safe_extract(bundle, work / 'fixture', a['expandedBytes'], a['maxMembers'])
        bundle.unlink()
        output, verify, inputs = work / 'output', work / 'verify', work / 'inputs'
        for d in (output, verify, inputs):
            d.mkdir(mode=0o755)
        # Full immutable admission is visible to the TRUSTED driver/verifier.
        # Their candidate subprocess ABI forbids passing these control inputs.
        (inputs / 'admission.json').write_bytes(encoded(a))
        (inputs / 'admission.json').chmod(0o444)
        inputs.chmod(0o555)
        for d in (output, verify):
            os.chown(d, 65534, 65534)
        sandbox(a['runnerImage'], 'produce', [(work / 'fixture', '/fixture', 'ro'), (inputs, '/admission', 'ro'), (output, '/output', 'rw')],
                work / 'producer.log', max(1, int(expires - time.time() - 300)))
        # Trusted root repackages only regular output; candidate-created links,
        # devices and duplicate paths cannot select host files for publication.
        archive = work / 'evidence.tar'
        with tarfile.open(archive, 'w') as t:
            for p in sorted(output.rglob('*')):
                if p.is_symlink() or (not p.is_file() and not p.is_dir()):
                    raise ValueError('UNSAFE_EVIDENCE')
                if p.is_file():
                    t.add(p, arcname=str(p.relative_to(output)), recursive=False)
            t.add(work / 'producer.log', arcname='supervisor-producer.log', recursive=False)
        evidence_sha = file_sha(archive)
        (inputs / 'evidence-sha256').write_text(evidence_sha)
        (inputs / 'evidence-sha256').chmod(0o444)
        sandbox(a['verifierImage'], 'verify', [(output, '/evidence', 'ro'), (inputs, '/admission', 'ro'), (verify, '/verdict', 'rw')],
                work / 'verifier.log', max(1, int(expires - time.time() - 120)))
        receipt_path = verify / 'receipt.json'
        if receipt_path.is_symlink() or receipt_path.stat().st_size > 8192:
            raise ValueError('UNSAFE_RECEIPT')
        receipt = validate_receipt(json.loads(receipt_path.read_bytes()), a, evidence_sha)
        prefix, manifest = upload_chunks(s3, archive, boot, instance_arn)
        manifest['gateReceipt'] = receipt
        # Manifest LAST. Private verifier re-downloads each version and re-runs
        # the semantic gate; this envelope never directly enables public PASS.
        s3.put_object(Bucket=boot['evidenceBucket'], Key=prefix + 'manifest.json', Body=encoded(manifest),
                      IfNoneMatch='*', ServerSideEncryption='aws:kms', SSEKMSKeyId=boot['evidenceKey'])
    except Exception:
        # Missing complete gate evidence remains INCOMPLETE, even if this lands.
        try:
            failure = encoded({'schema': 'polis-private-failure/1', 'admissionSha256': sha(a),
                               'status': 'INCOMPLETE', 'reason': 'EXECUTION_OR_COLLECTION'})
            s3.put_object(Bucket=boot['evidenceBucket'], Key=f'runs/{a["id"]}/{instance_arn}/failure.json',
                          Body=failure, IfNoneMatch='*', ServerSideEncryption='aws:kms', SSEKMSKeyId=boot['evidenceKey'])
            for label in ('producer.log', 'verifier.log'):
                path = SCRATCH / 'work' / label
                if path.is_file() and not path.is_symlink():
                    with path.open('rb') as stream:
                        for index, block in enumerate(iter(lambda: stream.read(CHUNK), b'')):
                            s3.put_object(Bucket=boot['evidenceBucket'], Key=f'runs/{a["id"]}/{instance_arn}/failure/{label}/{index:08d}',
                                          Body=block, IfNoneMatch='*', ServerSideEncryption='aws:kms', SSEKMSKeyId=boot['evidenceKey'])
        except Exception:
            pass
        raise
    finally:
        stop.set()


if __name__ == '__main__':
    try:
        run()
    except Exception:
        # Raw tracebacks/paths never go to serial console or cloud logs.
        pass
    finally:
        subprocess.run(['systemctl', 'poweroff'], check=False)
