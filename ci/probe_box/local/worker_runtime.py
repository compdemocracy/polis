"""Linux-only runner. Real worker.run/load_image/sandbox/relay and operator status.

Adapters replace EC2 identity, shutdown, Secrets Manager, S3 KMS headers and
local capacity limits. They never replace stage, receipt or failure logic.
"""
from __future__ import annotations
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
from unittest.mock import patch

SOURCE = Path('/source/ci/probe_box')
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, '/relay-source')
import boto3
from botocore.config import Config
import worker
import replica
import run as operator
from fixture_image import archive

P = Path('/probe-work')
RESULTS = Path('/results')
checks = []


def passed(name):
    checks.append(name)
    print('PASS: '+name, flush=True)


class LocalS3:
    """MinIO has no AWS KMS: strip exactly its two encryption fields.

    Image bytes are public, mounted archives; control/heartbeats/receipts really
    go over S3. This avoids duplicating large images into the MinIO tmpfs.
    """
    def __init__(self, client):
        self.client, self.images = client, {}

    def get_object(self, **kw):
        if kw['Bucket'] == 'fixture-assets':
            path = self.images[kw['Key']]
            return {'ContentLength':path.stat().st_size, 'Body':path.open('rb')}
        return self.client.get_object(**kw)

    def put_object(self, **kw):
        kw.pop('ServerSideEncryption', None)
        kw.pop('SSEKMSKeyId', None)
        return self.client.put_object(**kw)


class LocalSecret:
    def get_secret_value(self, **kw):
        return {'SecretString':json.dumps({'username':'polis_probe_reader','password':'public-fixture-reader'})}


def offered_mechanisms():
    """Observe the actual first PG17 backend frame after verified TLS/startup."""
    def receive(sock, size):
        data = bytearray()
        while len(data) < size:
            part = sock.recv(size - len(data))
            if not part:
                raise AssertionError('SASL_OFFER_EOF')
            data.extend(part)
        return bytes(data)
    with socket.create_connection(('postgres', 5432), timeout=5) as raw:
        raw.sendall(struct.pack('!II', 8, 80877103))
        assert receive(raw, 1) == b'S'
        context = ssl.create_default_context(cafile='/fixture-tls/ca.crt')
        with context.wrap_socket(raw, server_hostname='postgres') as secure:
            startup = struct.pack('!I', 196608) + b'user\0polis_probe_reader\0database\0probe_test\0\0'
            secure.sendall(struct.pack('!I', 4 + len(startup)) + startup)
            header = receive(secure, 5)
            length = struct.unpack('!I', header[1:])[0]
            assert header[:1] == b'R' and 8 <= length <= 65536
            body = receive(secure, length - 4)
            assert body[:4] == struct.pack('!I', 10) and body[4:].endswith(b'\0\0')
            names = body[4:-2].split(b'\0')
            assert b'SCRAM-SHA-256-PLUS' in names and b'SCRAM-SHA-256' in names
            return [name.decode('ascii') for name in names]


def scratch_module(name, text):
    path = P/(name+'.py')
    path.write_text(text)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    os.umask(0o077)
    os.environ.update(HOME='/root',TMPDIR=str(P/'tmp'),DOCKER_CONFIG=str(P/'docker-client'))
    assert os.geteuid() == 0 and os.environ['HOME'] == '/root'
    mount = next(line.split() for line in Path('/proc/mounts').read_text().splitlines() if line.split()[1] == str(P))
    assert {'noexec','nodev','nosuid'} <= set(mount[3].split(','))
    P.chmod(0o700)
    for name in ('tmp','docker-client'):(P/name).mkdir()
    # Delegate only this privileged container's PRIVATE cgroup namespace.
    cg = Path('/sys/fs/cgroup')
    (cg/'init').mkdir(exist_ok=True)
    (cg/'init/cgroup.procs').write_text(str(os.getpid()))
    (cg/'cgroup.subtree_control').write_text(' '.join('+'+x for x in (cg/'cgroup.controllers').read_text().split()))
    bake = (SOURCE/'bake.sh').read_text()
    assert 'UMask=0077' in bake and 'TMPDIR=/probe-work/tmp' in bake
    worker.ROOT.mkdir(parents=True,exist_ok=True)
    for name, marker in [('docker.json','DOCKER'),('image-policy.json','POLICY')]:
        (worker.ROOT/name).write_text(bake.split("<<'"+marker+"'\n")[1].split('\n'+marker)[0])
    default_roots = [Path(x) for x in ('/var/lib/docker','/var/lib/containerd','/run/containerd')]
    def inventory():
        import hashlib
        return sorted((str(f),hashlib.sha256(f.read_bytes()).hexdigest()) for root in default_roots for f in root.rglob('*') if f.is_file())
    baseline = inventory()
    subprocess.run(['dockerd','--validate','--config-file='+str(worker.ROOT/'docker.json')],check=True)
    daemon_log = (P/'daemon.log').open('wb')
    daemon = subprocess.Popen(['dockerd','--config-file='+str(worker.ROOT/'docker.json')],
        stdout=daemon_log,stderr=subprocess.STDOUT,env={**os.environ,'DOCKER_TMPDIR':str(P/'tmp')})
    try:
        for _ in range(120):
            if subprocess.run(worker.docker()+['info'],capture_output=True).returncode == 0:break
            if daemon.poll() is not None:raise RuntimeError('PRIVATE_DAEMON_EXITED')
            time.sleep(.5)
        else:raise RuntimeError('PRIVATE_DAEMON_TIMEOUT')
        info=json.loads(subprocess.check_output(worker.docker()+['info','--format','{{json .}}']))
        assert info['DockerRootDir']=='/probe-work/container-store' and info['Driver']=='overlay2'
        passed('bake-daemon-private-noexec-mount-root-umask077')
        raw_s3 = boto3.client('s3',endpoint_url='http://minio:9000',region_name='us-east-1',
            aws_access_key_id='public-fixture',aws_secret_access_key='public-fixture-only',
            config=Config(s3={'addressing_style':'path'},retries={'max_attempts':0},connect_timeout=2,read_timeout=10))
        for _ in range(60):
            try:raw_s3.list_buckets();break
            except Exception:time.sleep(.5)
        else:raise RuntimeError('MINIO_NOT_READY')
        for bucket in ('fixture-control','fixture-evidence'):raw_s3.create_bucket(Bucket=bucket)
        s3 = LocalS3(raw_s3)
        fixture = P/'fixture-archives';fixture.mkdir()
        fixture_job = dict(schema='polis-probe-job/1',run_id='1'*32,max_seconds=900)
        for role, action in [('reader','read'),('producer','produce'),('verifier','verify')]:
            path, ref = archive(fixture, role)
            s3.images['images/'+ref.split('@sha256:')[1]+'.oci.tar'] = path
            fixture_job[role] = {'image':ref,'args':[action]}
        # Intercept only shutdown and smaller resource ceilings. All other calls
        # (including Skopeo, immutable image inspection and docker run) execute.
        real_run = subprocess.run
        def local_run(argv, **kw):
            if argv[:2] == ['shutdown','-h']:
                return subprocess.CompletedProcess(argv,0)
            replacements = {'--memory=112g':'--memory=8g','--memory-swap=112g':'--memory-swap=8g',
                '--cpus=14':'--cpus=2','--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=4g':'--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m'}
            if argv[0] == 'skopeo':
                kw['stderr'] = None  # Public-only diagnostics stay in private results.
            return real_run([replacements.get(a,a) for a in argv],**kw)
        actual_usage = shutil.disk_usage
        def local_usage(path):
            usage = actual_usage(path)
            # Production reserves 64 GiB beyond the archive. Local tmpfs is
            # smaller; actual writes still fail on ENOSPC, with no silent skip.
            return usage._replace(free=usage.free+64*1024**3)
        def client(service, **kw):
            if service=='s3':return s3
            if service=='secretsmanager':return LocalSecret()
            raise AssertionError('UNEXPECTED_SDK_SERVICE')
        identity=dict(accountId='111111111111',region='us-east-1',instanceId='i-00000000000000001',imageId='ami-00000000000000001')
        arn='arn:aws:ec2:us-east-1:111111111111:instance/'+identity['instanceId']
        cfg=dict(MODE='worker',CONTROL_BUCKET='fixture-control',EVIDENCE_BUCKET='fixture-evidence',CONTROL_KEY='fixture-key',
            **{k:'fixture' for k in operator.LAUNCH_KEYS})
        (worker.ROOT/'bootstrap.json').write_text(json.dumps(dict(account=identity['accountId'],region=identity['region'],controlBucket='fixture-control')))
        def case(name, job, module=worker, host='postgres', bad_ca=False, expected=None, readback=operator):
            for directory in ('reader','output','verdict','job','selection','replica','run-spec'):
                shutil.rmtree(P/directory,ignore_errors=True)
            for log in P.glob('*.log'):
                if log.name != 'daemon.log':log.unlink()
            shutil.copyfile('/fixture-tls/'+('other.crt' if bad_ca else 'ca.crt'),worker.ROOT/'rds-ca.pem')
            started=int(time.time())
            admission=dict(id=job['run_id'],job=job,ami=identity['imageId'],account=identity['accountId'],region=identity['region'],
                launch={k:cfg[k] for k in operator.LAUNCH_KEYS},started=started,configSha256=operator.sha(cfg),
                expiresAt=dt.datetime.fromtimestamp(started+job['max_seconds'],dt.timezone.utc).isoformat())
            boot=dict(admission=admission,admissionSha256=worker.sha(admission),instanceId=identity['instanceId'],
                started=started,terminateBy=started+job['max_seconds'],controlBucket='fixture-control',assetBucket='fixture-assets',
                evidenceBucket='fixture-evidence',evidenceKey='fixture-key',secretsUrl='http://local.invalid',secretArn='fixture',
                database='probe_test',replicaHost=host)
            s3.put_object(Bucket='fixture-control',Key='boot/worker/'+arn+'.json',Body=worker.canonical(boot))
            raw_s3.delete_object(Bucket='fixture-evidence',Key='results/'+arn+'/receipt.json')
            error = None
            # Real metadata network requests are replaced before run() starts.
            with patch.object(module,'metadata',return_value=worker.canonical(identity)), patch.object(boto3,'client',side_effect=client), \
                    patch.object(subprocess,'run',side_effect=local_run), patch.object(shutil,'disk_usage',side_effect=local_usage):
                try:module.run()
                except Exception as exc:
                    error=exc
                    if isinstance(exc, module.SandboxFailure):
                        (RESULTS/(name+'-sandbox-failure.json')).write_text(json.dumps({
                            'stage':exc.label, 'exit':exc.exit_code, 'oom':exc.oom, 'last':exc.last}, indent=2)+'\n')
            for log in P.glob('*.log'):
                if log.name != 'daemon.log':shutil.copyfile(log,RESULTS/(name+'-'+log.name))
            record = json.loads(s3.get_object(Bucket='fixture-control',Key=f'heartbeats/{job["run_id"]}/{arn}.json')['Body'].read())
            (RESULTS/(name+'-heartbeat.json')).write_bytes(worker.canonical(record))
            if name=='admitted-archive-three-stages':
                # Public-only diagnostic copies stay in the durable local
                # results directory. The admitted receipt export is unchanged.
                for relative in ('fixture/manifest.json','fixture/config.json','fixture/plan.json','payload-census.json'):
                    source=P/'reader/.local'/relative
                    if source.is_file():
                        target=RESULTS/'pipeline-reader'/relative
                        target.parent.mkdir(parents=True,exist_ok=True)
                        shutil.copyfile(source,target)
            if expected is None:
                if error:raise error
                raw=raw_s3.get_object(Bucket='fixture-evidence',Key='results/'+arn+'/receipt.json')['Body'].read()
                decoded=worker.decode_receipt(raw,job)
                (RESULTS/(name+'-receipt.json')).write_bytes(raw)
                assert decoded['verdict']=='PASS'
            else:
                assert isinstance(error,module.SandboxFailure), repr(error)
                assert record['schema']==worker.FAILURE_SCHEMA and record['stage']=='reader'
                assert record['type']=='SandboxFailure' and record['code']=='PROBE_EXECUTION_FAILED'
                assert record['container']['exit'] != 0 and record['container']['oom'] is False
                for key, value in expected.items():
                    assert record[key]==value,(name,key,record)
            # Populate the closed operator register after local disposal. No EC2
            # simulation claims: status starts in CLEAN and only reads real S3.
            state=dict(generation='1'*32,admission=admission,phase='CLEAN',nonce='2'*32)
            s3.put_object(Bucket='fixture-control',Key='active.json',Body=operator.encoded(state))
            # A CLEAN register needs its bound cleanup record (resource cleanup
            # was observed by the local disposal above, not by EC2 calls).
            token=operator.sha(admission);volumes=['vol-00000000000000001','vol-00000000000000002']
            s3.put_object(Bucket='fixture-control',Key=f'control/{job["run_id"]}/instance.json',Body=operator.encoded({'id':identity['instanceId'],'volumes':volumes,'admissionSha256':token}))
            s3.put_object(Bucket='fixture-control',Key=f'control/{job["run_id"]}/clean.json',Body=operator.encoded({'admissionSha256':token,'instanceId':identity['instanceId'],'volumes':volumes,'status':'CLEAN'}))
            result = readback.Session(None,s3,cfg).status(job['run_id'])
            assert result['complete'] and result['passed']==(expected is None),result
            if expected is not None:
                assert result['failure']=={k:v for k,v in record.items() if k!='schema'}, result
            (RESULTS/(name+'.json')).write_bytes(worker.canonical(dict(status=result,heartbeat=record)))
            for log in P.glob('*.log'):
                if log.name != 'daemon.log':shutil.copyfile(log,RESULTS/(name+'-'+log.name))
            assert not subprocess.check_output(worker.docker()+['ps','-aq']).strip()
            passed(name)
            return record
        mechanisms = offered_mechanisms()
        (RESULTS/'offered-mechanisms.json').write_text(json.dumps(mechanisms))
        passed('postgres17-offers-scram-plus-over-verified-tls')
        # The fixed relay must be present. A missing fix must fail the positive
        # reader stage, never silently fall back to trust authentication.
        case('fixture-three-stages',fixture_job)
        # Real upstream session reports TLS and read-only login shape.
        import psycopg2
        conn=psycopg2.connect(host='postgres',user='polis_probe_reader',password='public-fixture-reader',dbname='probe_test',sslmode='verify-full',sslrootcert='/fixture-tls/ca.crt')
        with conn.cursor() as cur:
            cur.execute('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');assert cur.fetchone()==(True,)
            cur.execute("SELECT current_schema(), current_setting('search_path'), current_setting('default_transaction_read_only'), current_setting('statement_timeout')")
            settings = cur.fetchone()
            assert settings == ('pg_catalog', 'pg_catalog, public', 'on', '30min'), settings
            (RESULTS/'reader-session.json').write_text(json.dumps(dict(zip(
                ('current_schema', 'search_path', 'default_transaction_read_only', 'statement_timeout'), settings)), indent=2)+'\n')
        conn.close()
        passed('postgres17-verified-tls')
        passed('production-reader-search-path-read-only-timeout')
        try:
            conn=psycopg2.connect(host='postgres',user='polis_probe_reader',password='public-fixture-wrong',
                dbname='probe_test',sslmode='verify-full',sslrootcert='/fixture-tls/ca.crt',connect_timeout=5)
        except psycopg2.OperationalError:
            passed('postgres17-wrong-password-refused')
        else:
            conn.close()
            raise AssertionError('SCRAM_PASSWORD_NOT_ENFORCED')
        # Restore the former raw upstream forwarding only in a scratch module.
        # The actual TLS connection, worker failure path, MinIO heartbeat and
        # operator failure readback all still run.
        source=Path(replica.__file__).read_text()
        start='                                if source is secure and not advertised:\n'
        end='                                (secure if source is client else client).sendall(data)'
        assert source.count(start)==1 and source.count(end)==1
        before, rest=source.split(start)
        _, after=rest.split(end)
        broken_relay=scratch_module('replica_scram_regression',before+end+after)
        with patch.object(worker,'ReplicaSocket',broken_relay.ReplicaSocket):
            record=case('scratch-scram-plus-regression-detected',fixture_job,expected={'relay':{'relayed':1}})
        assert record['container']['class']=='psycopg2.OperationalError' and record['container']['reason']=='PG_SSL',record
        failing=copy.deepcopy(fixture_job);failing['reader']['args']=['fail']
        record=case('reader-forced-failure',failing,expected={'relay':{'plain_scram':1,'relayed':1}})
        assert record['container']['class']=='FileNotFoundError' and record['container']['reason']=='ENOENT'
        passed('failure-record-last-exception-closed-reason')
        case('reader-tls-refusal',fixture_job,bad_ca=True,expected={'relay':{'tls_verify':1}})
        case('reader-connect-refusal',fixture_job,host='127.0.0.1',expected={'relay':{'connect':1}})
        # Revert production fixes only in private scratch modules; the positive
        # assertions above MUST fail against each historical behaviour.
        source=(SOURCE/'worker.py').read_text()
        old="    path.chmod(0o755)\n    if path.stat().st_mode & 0o777 != 0o755:\n        raise ValueError('SHARED_DIR_MODE')\n"
        assert source.count(old)==1
        broken=scratch_module('worker_umask_regression',source.replace(old,''))
        try:case('unexpected-umask-pass',fixture_job,module=broken)
        except broken.SandboxFailure as error:
            assert error.last.get('reason')=='PG_SERVICE_FILE',error.last
            record=json.loads(s3.get_object(Bucket='fixture-control',Key=f'heartbeats/{fixture_job["run_id"]}/{arn}.json')['Body'].read())
            assert record['relay']=={}
            (RESULTS/'umask-regression.json').write_bytes(worker.canonical(record))
            passed('scratch-umask-regression-detected')
        else:raise AssertionError('UMASK_MUTATION_SURVIVED')
        source=(SOURCE/'run.py').read_text()
        old="                if not provision:\n                    failure = self.failure(c, arn)"
        assert source.count(old)==1
        broken=scratch_module('operator_receipt_regression',source.replace(old,"                raise Unknown('RECEIPT_READ_UNKNOWN') from None"))
        try:case('unexpected-receipt-pass',failing,expected={'relay':{'plain_scram':1,'relayed':1}},readback=broken)
        except broken.Unknown as error:
            assert str(error)=='RECEIPT_READ_UNKNOWN'
            passed('scratch-receipt-read-regression-detected')
        else:raise AssertionError('RECEIPT_MUTATION_SURVIVED')
        options=json.loads((RESULTS/'options.json').read_bytes())
        if options['archives']:
            job=json.loads((SOURCE/'jobs.json').read_bytes())['jobs'][options['job']]
            job['run_id']='3'*32
            for role in ('reader','producer','verifier'):
                name='producer' if options['job']=='sampled-paired-battery-v1' and role=='reader' else role
                digest=job[role]['image'].split('@sha256:')[1]
                s3.images['images/'+digest+'.oci.tar']=Path('/archives')/(name+'.oci.tar')
            case('admitted-archive-three-stages',job)
            if options.get('pipeline'):
                passed('real-survey-selection-extraction-and-paired-verifier')
        assert inventory()==baseline
        generated=(P/'container-run/containerd/containerd.toml').read_text()
        assert '/probe-work/container-store/containerd/daemon' in generated and '/probe-work/container-run/containerd/daemon' in generated
        passed('private-daemon-roots-and-zero-candidates')
        report=dict(status='PASS',checks=checks,count=len(checks),archives=options['archives'],
            limits=['local EC2 identity and secret adapters','MinIO without KMS','local archive streams instead of S3 asset downloads',
                'reduced resource and disk reserve ceilings','operator readback starts at CLEAN; no EC2 lifecycle or IAM proof'])
        (RESULTS/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    finally:
        daemon.terminate()
        try:daemon.wait(timeout=20)
        except subprocess.TimeoutExpired:daemon.kill();daemon.wait()
        daemon_log.close()
        shutil.copyfile(P/'daemon.log',RESULTS/'daemon.log')


if __name__=='__main__':
    main()
