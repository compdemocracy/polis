"""Baked supervisor. Only a validated verifier receipt may leave this machine."""
from __future__ import annotations
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import urllib.request

from contracts import validate_job
from receipt import canonical, sha, validate_receipt
from replica import ReplicaSocket

ROOT = Path('/opt/polis-probe')
SCRATCH = Path('/probe-work')


def podman() -> list[str]:
    # Images, writable layers and runtime state all use the disposable disk.
    return ['podman','--root',str(SCRATCH/'container-store'),
            '--runroot',str(SCRATCH/'container-run')]


def metadata(path: str) -> bytes:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = 'http://169.254.169.254/latest/'
    request = urllib.request.Request(base+'api/token', method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds':'300'})
    with opener.open(request, timeout=5) as response:
        token = response.read(1024).decode()
    request = urllib.request.Request(base+path, headers={'X-aws-ec2-metadata-token':token})
    with opener.open(request, timeout=5) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('METADATA_LIMIT')
    return raw


def sandbox(command: dict, label: str, mounts: list[tuple[Path,str,str]], deadline: float) -> None:
    argv = podman()+['run','--name','polis-probe-'+label,'--pull=never','--network=none',
            '--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65534:65534',
            '--pids-limit=4096','--memory=112g','--memory-swap=112g','--cpus=14','--ulimit=core=0:0',
            '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=4g',
            '--env=OPENBLAS_NUM_THREADS=1','--env=OMP_NUM_THREADS=1','--env=MKL_NUM_THREADS=1',
            '--env=PGSERVICEFILE=/replica/service.conf']
    for source,target,mode in mounts:
        argv += ['--volume', f'{source}:{target}:{mode},nosuid,nodev']
    argv += [command['image'], *command['args']]
    try:
        with (SCRATCH/(label+'.log')).open('wb') as log:
            result = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT,
                                    timeout=max(1,deadline-time.time()), check=False)
        inspected = subprocess.check_output(podman()+['inspect','polis-probe-'+label],stderr=subprocess.DEVNULL)
        state = json.loads(inspected)[0]['State']
        if result.returncode or state.get('OOMKilled') or state.get('ExitCode') != 0:
            raise ValueError('PROBE_EXECUTION_FAILED')
    finally:
        subprocess.run(podman()+['rm','--force','polis-probe-'+label],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)


def owned_dir(path: Path) -> Path:
    path.mkdir(mode=0o755)
    os.chown(path,65534,65534)
    return path


def run() -> None:
    import boto3
    from botocore.config import Config
    boot_config = json.loads((ROOT/'bootstrap.json').read_bytes())
    identity = json.loads(metadata('dynamic/instance-identity/document'))
    if (identity['accountId'],identity['region']) != (boot_config['account'],boot_config['region']):
        raise ValueError('BOOT_IDENTITY')
    arn = f'arn:aws:ec2:{identity["region"]}:{identity["accountId"]}:instance/{identity["instanceId"]}'
    s3 = boto3.client('s3',region_name=identity['region'],config=Config(s3={'us_east_1_regional_endpoint':'regional','addressing_style':'virtual'}))
    boot = None
    for _ in range(48):
        try:
            raw=s3.get_object(Bucket=boot_config['controlBucket'],Key=f'boot/{arn}.json')['Body'].read(65537)
            if len(raw)>65536: raise ValueError('BOOT_LIMIT')
            boot=json.loads(raw); break
        except Exception:
            time.sleep(5)
    if not boot or boot['instanceId']!=identity['instanceId'] or boot['admissionSha256']!=sha(boot['admission']) or boot['admission']['ami']!=identity['imageId']:
        raise ValueError('BOOT_BINDING')
    job=validate_job(boot['admission']['job'])
    deadline=boot['started']+job['max_seconds']
    if time.time()>=deadline or not SCRATCH.is_mount(): raise ValueError('EXPIRED_OR_NO_PRIVATE_DISK')
    stop=threading.Event()
    def heartbeat() -> None:
        while not stop.is_set():
            try:
                s3.put_object(Bucket=boot['controlBucket'],Key=f'heartbeats/{job["run_id"]}/{arn}.json',Body=b'{}',
                              ServerSideEncryption='aws:kms',SSEKMSKeyId=boot['evidenceKey'])
            except Exception: pass
            stop.wait(60)
    threading.Thread(target=heartbeat,daemon=True).start()
    try:
        commands=[job[k] for k in ('reader','producer','verifier') if k in job]
        for image in sorted({c['image'] for c in commands}):
            digest=image.split('@sha256:')[1]
            archive=SCRATCH/(digest+'.oci.tar')
            response=s3.get_object(Bucket=boot['assetBucket'],Key=f'images/{digest}.oci.tar')
            if response['ContentLength']>32*1024**3 or shutil.disk_usage(SCRATCH).free<response['ContentLength']+64*1024**3:
                raise ValueError('IMAGE_CAPACITY')
            with archive.open('xb') as out:
                remaining=response['ContentLength']
                while remaining:
                    block=response['Body'].read(min(remaining,1024*1024))
                    if not block: raise ValueError('IMAGE_TRUNCATED')
                    out.write(block); remaining-=len(block)
                if response['Body'].read(1): raise ValueError('IMAGE_SIZE')
            subprocess.run(podman()+['load','--input',str(archive)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
            archive.unlink()
            image_info=json.loads(subprocess.check_output(podman()+['image','inspect',image],stderr=subprocess.DEVNULL))[0]
            if image_info.get('Digest')!='sha256:'+digest or image_info.get('Architecture')!='arm64' or image_info.get('Os')!='linux':
                raise ValueError('IMAGE_DIGEST')
        data=owned_dir(SCRATCH/'reader'); output=owned_dir(SCRATCH/'output'); verdict=owned_dir(SCRATCH/'verdict')
        specification=SCRATCH/'job'; specification.mkdir(mode=0o755)
        specification.chmod(0o755)
        (specification/'job.json').write_bytes(canonical(job)); (specification/'job.json').chmod(0o444)
        if 'reader' in job:
            secret_client=boto3.client('secretsmanager',region_name=identity['region'],endpoint_url=boot['secretsUrl'])
            secret=json.loads(secret_client.get_secret_value(SecretId=boot['secretArn'])['SecretString'])
            if set(secret)!={'username','password'} or secret['username']!='polis_probe_reader': raise ValueError('READER_SECRET')
            sock=SCRATCH/'replica';sock.mkdir(mode=0o755)
            def escape(value: str) -> str:
                if any(c in value for c in '\r\n\0'): raise ValueError('CREDENTIAL_FORMAT')
                return value.replace('\\','\\\\').replace(':','\\:')
            service='[probe]\nhost=/replica\nport=5432\nsslmode=disable\nuser=polis_probe_reader\npassfile=/replica/pgpass\ndbname='+boot['database']+'\n'
            (sock/'service.conf').write_text(service);(sock/'service.conf').chmod(0o444)
            (sock/'pgpass').write_text(':'.join(escape(v) for v in ['/replica','5432',boot['database'],secret['username'],secret['password']])+'\n')
            (sock/'pgpass').chmod(0o600);os.chown(sock/'pgpass',65534,65534)
            with ReplicaSocket(sock,boot['replicaHost'],ROOT/'rds-ca.pem'):
                sandbox(job['reader'],'reader',[(sock,'/replica','ro'),(data,'/output','rw')],deadline-180)
            (sock/'service.conf').unlink();(sock/'pgpass').unlink()
            del secret,service
        fixture=data/'.local/fixture'
        run_spec=SCRATCH/'run-spec';run_spec.mkdir(mode=0o755)
        run_spec.chmod(0o755)
        if (data/'inputs.json').is_file():
            shutil.copyfile(data/'inputs.json',run_spec/'inputs.json');(run_spec/'inputs.json').chmod(0o444)
        producer_mounts=[(data,'/input','ro'),(output,'/output','rw'),(run_spec,'/run-spec','ro')]
        verifier_mounts=[(data,'/input','ro'),(output,'/evidence','ro'),(run_spec,'/run-spec','ro'),(specification,'/job','ro'),(verdict,'/verdict','rw')]
        if fixture.is_dir():
            producer_mounts.append((fixture,'/fixture','ro'));verifier_mounts.append((fixture,'/fixture','ro'))
        sandbox(job['producer'],'producer',producer_mounts,deadline-120)
        sandbox(job['verifier'],'verifier',verifier_mounts,deadline-30)
        result=verdict/'receipt.json'
        if result.is_symlink() or not result.is_file() or result.stat().st_size>131072: raise ValueError('RECEIPT_FILE')
        receipt=validate_receipt(json.loads(result.read_bytes()),job)
        s3.put_object(Bucket=boot['evidenceBucket'],Key=f'results/{arn}/receipt.json',Body=canonical(receipt),IfNoneMatch='*',
                      ServerSideEncryption='aws:kms',SSEKMSKeyId=boot['evidenceKey'])
    finally:
        stop.set()


if __name__=='__main__':
    try: run()
    except Exception: pass
    finally: subprocess.run(['systemctl','poweroff'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
