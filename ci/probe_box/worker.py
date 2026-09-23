"""Baked supervisor. Exports only validated receipts and closed diagnostics."""
from __future__ import annotations
import atexit
import signal
import hashlib
import datetime as dt
import math
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import threading
import time
import urllib.request

from contracts import validate_job
from receipt import canonical, sha, validate_receipt, decode_receipt, receipt_limit
from replica import ReplicaSocket

ROOT = Path('/opt/polis-probe')
SCRATCH = Path('/probe-work')


def docker() -> list[str]:
    # Never use the system daemon or an environment-selected remote endpoint.
    return ['docker', '--host', 'unix://'+str(SCRATCH/'docker.sock')]


def load_image(archive: Path, image: str) -> str:
    """Bind the admitted OCI manifest to the immutable Docker config/image ID.

    Docker's archive transport does not retain registry manifest digests. Verify
    the source bytes before conversion, then require its config digest as the
    loaded image ID. Skopeo verifies layer digests during copy; Docker verifies
    uncompressed layers against config.rootfs.diff_ids during import.
    """
    digest = image.split('@sha256:')[1]
    source = 'oci-archive:'+str(archive)
    env = {**os.environ, 'TMPDIR': str(SCRATCH/'tmp')}
    raw = subprocess.check_output(['skopeo','inspect','--raw',source],
                                  stderr=subprocess.DEVNULL, env=env)
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('IMAGE_DIGEST')
    manifest = json.loads(raw)
    if (manifest.get('schemaVersion') != 2 or manifest.get('mediaType') not in (
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.v2+json')):
        raise ValueError('IMAGE_MANIFEST')
    config = manifest.get('config', {}).get('digest', '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', config):
        raise ValueError('IMAGE_CONFIG')
    # The temporary destination tag is never executable authority. The admitted
    # job remains unchanged; only this supervisor holds the digest -> ID mapping.
    subprocess.run(['skopeo','--policy',str(ROOT/'image-policy.json'),'copy',
                    '--dest-daemon-host',docker()[2],source,
                    'docker-daemon:polis-probe-import:'+digest],
                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                   env=env,check=True)
    info = json.loads(subprocess.check_output(
        docker()+['image','inspect',config],stderr=subprocess.DEVNULL))[0]
    if (info.get('Id') != config or info.get('Architecture') != 'arm64'
            or info.get('Os') != 'linux'):
        raise ValueError('IMAGE_CONFIG')
    return config


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


def sandbox(command: dict, label: str, mounts: list[tuple[Path,str,str]], deadline: float, image_id: str, diagnostics=None) -> None:
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise ValueError('IMAGE_CONFIG')
    argv = docker()+['run','--name','polis-probe-'+label,'--pull=never','--network=none',
            '--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65534:65534',
            '--pids-limit=4096','--memory=112g','--memory-swap=112g','--cpus=14','--ulimit=core=0:0',
            '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=4g',
            '--env=OPENBLAS_NUM_THREADS=1','--env=OMP_NUM_THREADS=1','--env=MKL_NUM_THREADS=1',
            '--env=PGSERVICEFILE=/replica/service.conf']
    for source,target,mode in mounts:
        # The source filesystem is mounted nodev,nosuid,noexec by start.sh.
        # Docker bind options do not accept Podman's nosuid/nodev suffixes.
        argv += ['--mount', f'type=bind,src={source},dst={target},bind-propagation=rprivate'+
                 (',readonly' if mode == 'ro' else '')]
    argv += [image_id, *command['args']]
    try:
        with (SCRATCH/(label+'.log')).open('wb') as log:
            result = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT,
                                    timeout=max(1,deadline-time.time()), check=False)
        inspected = subprocess.check_output(docker()+['inspect','polis-probe-'+label],stderr=subprocess.DEVNULL)
        state = json.loads(inspected)[0]['State']
        if result.returncode or state.get('OOMKilled') or state.get('ExitCode') != 0:
            raise SandboxFailure(label, state.get('ExitCode'), bool(state.get('OOMKilled')),
                                 last_exception_token(SCRATCH/(label+'.log')))
    except BaseException as error:
        if diagnostics is not None:
            diagnostics.fail(error)
        raise
    finally:
        subprocess.run(docker()+['rm','--force','polis-probe-'+label],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)


FAILURE_SCHEMA = 'polis-probe-failure/1'
CODE = re.compile(r'[A-Z][A-Z0-9_]{1,39}')
CLASS = re.compile(r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*')
CLASS_SUFFIXES = ('Error', 'Exception', 'Exit', 'Failure', 'Warning', 'Interrupt', 'Timeout', 'Expired')


class SandboxFailure(ValueError):
    """A candidate container ended without success. Carries fixed-shape facts only."""
    def __init__(self, label: str, exit_code: object, oom: bool, last: dict):
        super().__init__('PROBE_EXECUTION_FAILED')
        self.label, self.exit_code, self.oom, self.last = label, exit_code, oom, last


def last_exception_token(log: Path) -> dict:
    """The exception class name and bare all-caps code on the container's final line.

    Never the message. A dotted exception path (psycopg2.errors.QueryCanceled) or a bare
    name with a standard exception suffix is a code identifier; an all-caps token is a
    fixed failure code; a fixed libpq/OS phrase after it becomes a closed reason code. Any other text (paths,
    identifiers, values) is dropped, so the record cannot carry private data.
    """
    try:
        lines = log.read_bytes()[-4096:].decode('utf-8', 'replace').splitlines()
    except OSError:
        return {}
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        head, _, rest = line.partition(':')
        head, rest = head.strip(), rest.strip()
        token = {}
        if CODE.fullmatch(head):
            token['code'] = head
        elif len(head) <= 96 and CLASS.fullmatch(head) and ('.' in head or head.endswith(CLASS_SUFFIXES)):
            token['class'] = head
            if CODE.fullmatch(rest):
                token['code'] = rest
            else:
                reason = classify_reason(rest)
                if reason:
                    token['reason'] = reason
                token.update(selection_tokens(head, rest))
        return token


# A frozen selection rule that production could not satisfy. The rule slug is a
# public identifier from the committed capture config; rank and candidate count
# are two small integers. Nothing else from the message leaves the box.
SLUG = re.compile(r'\(slug (pc-v1-[a-z0-9-]{1,40})\)')
RANK = re.compile(r'matched (\d{1,9}) conversation\(s\) but rank (\d{1,4}) was required')


def selection_tokens(head: str, rest: str) -> dict:
    if not head.endswith('RoleUnsatisfied'):
        return {}
    out = {}
    slug = SLUG.search(rest)
    if slug:
        out['role'] = slug.group(1)
    counts = RANK.search(rest)
    if counts:
        out['candidates'], out['rank'] = int(counts.group(1)), int(counts.group(2))
    return out


# Fixed libpq / OS phrases -> closed reason codes. Only the code leaves the box.
REASONS = (
    ('service file', 'PG_SERVICE_FILE'),
    ('No such file or directory', 'ENOENT'),
    ('Permission denied', 'EACCES'),
    ('Connection refused', 'ECONNREFUSED'),
    ('server closed the connection unexpectedly', 'PG_SERVER_CLOSED'),
    ('password authentication failed', 'PG_AUTH_FAILED'),
    ('no pg_hba.conf entry', 'PG_NO_HBA'),
    ('SSL', 'PG_SSL'),
    ('timeout expired', 'PG_CONNECT_TIMEOUT'),
    ('statement timeout', 'PG_STATEMENT_TIMEOUT'),
    ('terminating connection', 'PG_TERMINATED'),
    ('does not exist', 'PG_MISSING_OBJECT'),
    ('too many connections', 'PG_TOO_MANY_CONNECTIONS'),
    ('out of memory', 'PG_OUT_OF_MEMORY'),
)


def classify_reason(message: str) -> str:
    for phrase, code in REASONS:
        if phrase in message:
            return code
    return ''


def failure_record(stage: str, error: BaseException, relay: object = None) -> dict:
    """What may leave the box when no receipt does: stage, exception class, fixed codes."""
    record = {'schema': FAILURE_SCHEMA, 'stage': stage, 'type': type(error).__name__}
    if isinstance(error, ValueError) and CODE.fullmatch(str(error)):
        record['code'] = str(error)
    aws = getattr(error, 'response', None)
    aws = aws.get('Error', {}).get('Code') if isinstance(aws, dict) else None
    if isinstance(aws, str) and re.fullmatch(r'[A-Za-z0-9_.]{1,64}', aws):
        record['aws'] = aws
    if isinstance(error, SandboxFailure):
        record['container'] = {'label': error.label, 'exit': error.exit_code if type(error.exit_code) is int else None,
                               'oom': error.oom, **error.last}
    if relay is not None:
        record['relay'] = relay.summary()
    return record


# These values describe supervisor operations, never candidate-supplied strings.
STAGES = frozenset({'images', 'secret', 'reader', 'producer', 'verifier', 'receipt', 'boot'})
WORKER_PHASES = frozenset({'start', 'prepare', 'download', 'load', 'execute', 'validate', 'publish'})
PULSE_ERRORS = frozenset({'AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation',
    'ExpiredToken', 'ExpiredTokenException', 'InvalidClientTokenId', 'InvalidToken',
    'RequestExpired', 'RequestTimeTooSkewed', 'SignatureDoesNotMatch', 'RequestTimeout',
    'RequestTimeoutException', 'SlowDown', 'Throttling', 'ThrottlingException',
    'RequestLimitExceeded', 'ServiceUnavailable', 'InternalError', 'KMSAccessDeniedException',
    'EndpointConnectionError', 'ConnectTimeoutError', 'ReadTimeoutError', 'ConnectionClosedError',
    'HTTPClientError', 'SSLError', 'ProxyConnectionError', 'NoCredentialsError',
    'PartialCredentialsError', 'CredentialRetrievalError', 'MetadataRetrievalError',
    'ClientError', 'TimeoutError', 'ConnectionError', 'OSError', 'RuntimeError',
    'ValueError', 'UnknownError'})
EXPIRY_BUCKETS = frozenset({'unknown', 'expired', 'le-5m', 'le-15m', 'le-30m', 'le-60m', 'gt-60m'})
PULSE_TAG = 'polis-probe-pulse'


def pulse_error(error):
    """Only reviewed codes/classes; never SDK messages, URLs or credential values."""
    response = getattr(error, 'response', None)
    detail = response.get('Error') if isinstance(response, dict) else None
    code = detail.get('Code') if isinstance(detail, dict) else None
    if isinstance(code, str) and code in PULSE_ERRORS:
        return code
    name = type(error).__name__
    return name if name in PULSE_ERRORS else 'UnknownError'


def credential_expiry(client, now=None):
    """Inspect the signing client's cached expiry, without initiating a refresh.

    Botocore has no public expiry accessor. Fail closed to unknown if the pinned
    SDK's internal shape changes. Never access the key, token or metadata body.
    """
    try:
        expiry = client._request_signer._credentials._expiry_time
        if not isinstance(expiry, dt.datetime) or expiry.tzinfo is None:
            return 'unknown'
        remaining = expiry.timestamp() - (time.time() if now is None else now)
        for ceiling, token in ((0, 'expired'), (300, 'le-5m'), (900, 'le-15m'),
                               (1800, 'le-30m'), (3600, 'le-60m')):
            if remaining <= ceiling:
                return token
        return 'gt-60m'
    except Exception:
        return 'unknown'


class WorkerTerminated(BaseException):
    """Signal-triggered unwind; record before finally blocks remove evidence."""


class Diagnostics:
    """One serialized mailbox: a pulse can never overwrite a terminal record.

    Network calls use the worker client's bounded timeouts. No join or cleanup is
    needed before recording; the terminal write retries once with identical bytes.
    SIGKILL, power loss and a permanently unavailable sink remain unrecordable.
    """
    def __init__(self):
        self.state = ('boot', 'start')
        self.counter = 0
        self.tag_counter = 0
        self.last_error = None
        self.ec2 = None
        self.tag_lock = threading.Lock()
        self.relay = None
        self.sink = None
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.finished = False

    def bind(self, sink, bucket, key, encryption_key):
        self.target = dict(Bucket=bucket, Key=key, ServerSideEncryption='aws:kms',
                           SSEKMSKeyId=encryption_key)
        self.sink = sink

    def bind_liveness(self, ec2, instance_id):
        self.ec2, self.instance_id = ec2, instance_id

    def enter(self, stage, phase):
        if stage not in STAGES or phase not in WORKER_PHASES:
            raise ValueError('DIAGNOSTIC_STATE')
        self.state = (stage, phase)

    def pulse(self):
        # A stage change must not wait behind a stuck heartbeat request.
        if not self.lock.acquire(blocking=False):
            return
        try:
            if self.stop.is_set() or self.sink is None:
                return
            stage, phase = self.state
            self.counter += 1
            body = {'stage': stage, 'pulse': self.counter, 'phase': phase,
                    'credential_expiry': credential_expiry(self.sink)}
            if self.last_error:
                body['last_error'] = self.last_error
            try:
                self.sink.put_object(**self.target, Body=canonical(body))
            except Exception as error:
                self.last_error = pulse_error(error)
        finally:
            self.lock.release()

    def tag_pulse(self):
        # Independent lock, counter, SDK session and loop: even a blocked S3
        # request/credential refresh cannot prevent another tag pulse.
        if not self.tag_lock.acquire(blocking=False):
            return
        try:
            if self.stop.is_set() or self.ec2 is None:
                return
            stage, phase = self.state
            self.tag_counter += 1
            value = f'{self.tag_counter}:{stage}:{phase}'
            if self.last_error:
                value += ':' + self.last_error
            try:
                self.ec2.create_tags(Resources=[self.instance_id], Tags=[{'Key': PULSE_TAG, 'Value': value}])
            except Exception as error:
                self.last_error = pulse_error(error)
        finally:
            self.tag_lock.release()

    def tag_heartbeat(self):
        while not self.stop.is_set():
            self.tag_pulse()
            self.stop.wait(60)

    def heartbeat(self):
        while not self.stop.is_set():
            self.pulse()
            self.stop.wait(60)

    def fail(self, error):
        self.stop.set()
        with self.lock:
            if self.finished or self.sink is None:
                return
            stage = self.state[0]
            try:
                record = ({'schema': FAILURE_SCHEMA, 'stage': stage, 'type': 'terminated'}
                          if isinstance(error, WorkerTerminated)
                          else failure_record(stage, error, self.relay))
                body = canonical(record)
            except BaseException:
                # No exception formatting, relay access or fallible record builder.
                body = json.dumps({'schema': FAILURE_SCHEMA, 'stage': stage,
                    'type': 'record-failed', 'reason': 'FAILURE_RECORD_FAILED'}).encode('ascii')
            self.finished = True
            for _ in range(2):
                try:
                    self.sink.put_object(**self.target, Body=body)
                    break
                except BaseException:
                    pass

    def terminated(self):
        self.fail(WorkerTerminated())

    def complete(self):
        self.stop.set()
        self.finished = True


def termination_signal(signum, frame):
    # Unwind out of any interrupted SDK call/lock before trying to record.
    raise WorkerTerminated()


def shared_dir(path: Path) -> Path:
    """A root-owned directory the sandbox user must traverse. mkdir(mode=) is
    masked by the unit's UMask=0077, so the mode is set explicitly; a 0700
    relay directory made the reader report its service file as missing."""
    path.mkdir(mode=0o755)
    path.chmod(0o755)
    if path.stat().st_mode & 0o777 != 0o755:
        raise ValueError('SHARED_DIR_MODE')
    return path


def owned_dir(path: Path) -> Path:
    path.mkdir(mode=0o755)
    os.chown(path,65534,65534)
    return path


def absolute_deadline(boot: dict, seconds: int) -> float:
    started=boot['started']
    if type(started) not in (int,float) or not math.isfinite(started) or started != boot['admission']['started']:
        raise ValueError('DEADLINE_BINDING')
    deadline=started+seconds
    expiry=dt.datetime.fromisoformat(boot['admission']['expiresAt'].replace('Z','+00:00'))
    if expiry.tzinfo is None or boot.get('terminateBy') != deadline or expiry.timestamp() != deadline:
        raise ValueError('DEADLINE_BINDING')
    return deadline


def shutdown_minutes(remaining: float) -> int:
    """Whole minutes for the host's `shutdown -h` fallback, rounded UP.

    The fallback is a backstop behind the admitted deadline, never a competitor
    to it. Flooring let the host power off up to 59 s early and cut a run short
    before its own expiry; rounding up keeps the power-off at or after the
    deadline. The floor of one keeps `shutdown -h +0` (power off immediately)
    off the table when the deadline is already close.
    """
    return max(1, math.ceil(remaining/60))


def load_receipt(path: Path, job: dict) -> dict:
    if path.is_symlink() or not path.is_file() or path.stat().st_size>receipt_limit(job):
        raise ValueError("RECEIPT_FILE")
    return decode_receipt(path.read_bytes(),job)


def run(diagnostics=None) -> None:
    diagnostics = diagnostics or Diagnostics()
    import boto3
    from botocore.config import Config
    boot_config = json.loads((ROOT/'bootstrap.json').read_bytes())
    identity = json.loads(metadata('dynamic/instance-identity/document'))
    if (identity['accountId'],identity['region']) != (boot_config['account'],boot_config['region']):
        raise ValueError('BOOT_IDENTITY')
    arn = f'arn:aws:ec2:{identity["region"]}:{identity["accountId"]}:instance/{identity["instanceId"]}'
    if 'ec2Url' in boot_config:
        # Separate Session gives EC2 its own refreshable credentials and lock.
        # The endpoint is fixed by the reviewed launch template, never the job.
        ec2 = boto3.Session().client('ec2', region_name=identity['region'],
            endpoint_url=boot_config['ec2Url'], config=Config(
                connect_timeout=5, read_timeout=10, retries={'total_max_attempts': 1}))
        diagnostics.bind_liveness(ec2, identity['instanceId'])
        threading.Thread(target=diagnostics.tag_heartbeat, daemon=True).start()
    s3 = boto3.client('s3',region_name=identity['region'],config=Config(s3={'us_east_1_regional_endpoint':'regional','addressing_style':'virtual'}))
    diagnostic_s3 = boto3.client('s3',region_name=identity['region'],config=Config(
        connect_timeout=5, read_timeout=10, retries={'total_max_attempts': 1},
        s3={'us_east_1_regional_endpoint':'regional','addressing_style':'virtual'}))
    boot = None
    for _ in range(48):
        try:
            raw=s3.get_object(Bucket=boot_config['controlBucket'],Key=f'boot/worker/{arn}.json')['Body'].read(65537)
            if len(raw)>65536: raise ValueError('BOOT_LIMIT')
            boot=json.loads(raw); break
        except Exception:
            time.sleep(5)
    # The role requires an explicit KMS key. Bootstrap has none; only the
    # operator-owned boot object can bind a writable diagnostic mailbox.
    if isinstance(boot, dict) and isinstance(boot.get('evidenceKey'), str):
        diagnostics.bind(diagnostic_s3, boot_config['controlBucket'], f'heartbeats/boot/{arn}.json', boot['evidenceKey'])
    if not boot or boot['instanceId']!=identity['instanceId'] or boot['admissionSha256']!=sha(boot['admission']) or boot['admission']['ami']!=identity['imageId']:
        raise ValueError('BOOT_BINDING')
    job=validate_job(boot['admission']['job'])
    diagnostics.bind(diagnostic_s3, boot['controlBucket'], f'heartbeats/{job["run_id"]}/{arn}.json', boot['evidenceKey'])
    deadline=absolute_deadline(boot,job['max_seconds'])
    if time.time()>=deadline or not SCRATCH.is_mount(): raise ValueError('EXPIRED_OR_NO_PRIVATE_DISK')
    subprocess.run(['shutdown','-h','+'+str(shutdown_minutes(deadline-time.time()))],check=True,
                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    def stage(name, phase):
        diagnostics.enter(name, phase)
        diagnostics.pulse()
    stage('images', 'prepare')
    pulse=threading.Thread(target=diagnostics.heartbeat,daemon=True); pulse.start()
    relay=None
    try:
        commands=[job[k] for k in ('reader','producer','verifier') if k in job]
        loaded_images = {}
        for image in sorted({c['image'] for c in commands}):
            digest=image.split('@sha256:')[1]
            archive=SCRATCH/(digest+'.oci.tar')
            stage('images', 'download')
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
            stage('images', 'load')
            loaded_images[image] = load_image(archive, image)
            archive.unlink()
        stage('images', 'prepare')
        data=owned_dir(SCRATCH/'reader'); output=owned_dir(SCRATCH/'output'); verdict=owned_dir(SCRATCH/'verdict')
        specification=SCRATCH/'job'; specification.mkdir(mode=0o755)
        specification.chmod(0o755)
        (specification/'job.json').write_bytes(canonical(job)); (specification/'job.json').chmod(0o444)
        if 'reader' in job:
            stage('secret', 'prepare')
            secret_client=boto3.client('secretsmanager',region_name=identity['region'],endpoint_url=boot['secretsUrl'])
            secret=json.loads(secret_client.get_secret_value(SecretId=boot['secretArn'])['SecretString'])
            if set(secret)!={'username','password'} or secret['username']!='polis_probe_reader': raise ValueError('READER_SECRET')
            sock=shared_dir(SCRATCH/'replica')
            def escape(value: str) -> str:
                if any(c in value for c in '\r\n\0'): raise ValueError('CREDENTIAL_FORMAT')
                return value.replace('\\','\\\\').replace(':','\\:')
            service='[probe]\nhost=/replica\nport=5432\nsslmode=disable\nuser=polis_probe_reader\npassfile=/replica/pgpass\ndbname='+boot['database']+'\n'
            (sock/'service.conf').write_text(service);(sock/'service.conf').chmod(0o444)
            (sock/'pgpass').write_text(':'.join(escape(v) for v in ['/replica','5432',boot['database'],secret['username'],secret['password']])+'\n')
            (sock/'pgpass').chmod(0o600);os.chown(sock/'pgpass',65534,65534)
            stage('reader', 'execute')
            with ReplicaSocket(sock,boot['replicaHost'],ROOT/'rds-ca.pem') as relay:
                diagnostics.relay = relay
                try:
                    sandbox(job['reader'],'reader',[(sock,'/replica','ro'),(data,'/output','rw')],deadline-180,loaded_images[job['reader']['image']], diagnostics)
                except BaseException as error:
                    diagnostics.fail(error)
                    raise
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
        stage('producer', 'execute')
        sandbox(job['producer'],'producer',producer_mounts,deadline-120,loaded_images[job['producer']['image']], diagnostics)
        stage('verifier', 'execute')
        sandbox(job['verifier'],'verifier',verifier_mounts,deadline-30,loaded_images[job['verifier']['image']], diagnostics)
        stage('receipt', 'validate')
        result=verdict/'receipt.json'
        receipt=load_receipt(result,job)
        stage('receipt', 'publish')
        s3.put_object(Bucket=boot['evidenceBucket'],Key=f'results/{arn}/receipt.json',Body=canonical(receipt),IfNoneMatch='*',
                      ServerSideEncryption='aws:kms',SSEKMSKeyId=boot['evidenceKey'])
        diagnostics.complete()
    except BaseException as error:
        diagnostics.fail(error)
        raise
    finally:
        diagnostics.stop.set()


def main():
    diagnostics = Diagnostics()
    atexit.register(diagnostics.terminated)
    previous = {}
    try:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            previous[sig] = signal.signal(sig, termination_signal)
        run(diagnostics)
    except BaseException as error:
        diagnostics.fail(error)
    finally:
        # Final fallback precedes all shutdown, including a failure in run's setup.
        diagnostics.terminated()
        try:
            subprocess.run(['systemctl','poweroff'],stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL,check=False)
        finally:
            atexit.unregister(diagnostics.terminated)
            for sig, handler in previous.items():
                signal.signal(sig, handler)


if __name__=='__main__':
    main()
