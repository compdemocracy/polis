#!/usr/bin/env python3
"""Public CI command transport: SSM starts work; instance-owned S3 holds results.

This helper is shipped in the command itself so failed checkout is observable.
No production data or credentials may be supplied to this public-fixture box.
"""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid

MAX_OUTPUT = 32 * 1024 * 1024
MAX_RECEIPT = 4096
SCHEMA = 'polis-public-command/1'


def aws(*args):
    return subprocess.run(['aws', '--cli-connect-timeout', '10', '--cli-read-timeout', '30', *args],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)


def admit(bucket, arn, token, label, timeout):
    if (not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket)
            or not re.fullmatch(r'arn:aws:ec2:[a-z0-9-]+:\d{12}:instance/i-[a-f0-9]{8,17}', arn)
            or not re.fullmatch(r'[a-f0-9]{32}', token)
            or not re.fullmatch(r'[a-z0-9-]{1,80}', label)
            or type(timeout) is not int or not 1 <= timeout <= 21600):
        raise ValueError('TRANSPORT_INPUT')
    return f'campaigns/{arn}/{token}/'


def put(bucket, key, path):
    if aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', str(path),
           '--server-side-encryption', 'AES256', '--if-none-match', '*').returncode:
        raise ValueError('RESULT_DELIVERY_FAILED')


def worker(request):
    bucket, arn, token, label, timeout, command = request
    prefix = admit(bucket, arn, token, label, timeout)
    with tempfile.TemporaryDirectory(prefix='polis-result-') as d:
        out = Path(d)/'stdout'
        # RLIMIT_FSIZE bounds the on-disk pipe destination even for a noisy child.
        # A truncated/oversized result is a failure, never a successful receipt.
        import resource
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT + 1, MAX_OUTPUT + 1))
        with out.open('wb') as stream:
            proc = subprocess.Popen(['bash', '-c', command], stdout=stream,
                                    stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=limits)
            try:
                code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                import signal
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                code = 124
        raw = out.read_bytes()
        if len(raw) > MAX_OUTPUT:
            raise ValueError('RESULT_LIMIT')
        code = code if 0 <= code <= 255 else 1
        put(bucket, prefix+'stdout', out)
        receipt = {'schema': SCHEMA, 'instance': arn, 'token': token, 'label': label,
                   'exit_code': code, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        path = Path(d)/'receipt.json'
        path.write_text(json.dumps(receipt, sort_keys=True))
        put(bucket, prefix+'receipt.json', path)


def get(bucket, key, path, maximum):
    head = aws('s3api', 'head-object', '--bucket', bucket, '--key', key, '--output', 'json')
    if head.returncode:
        return False
    info = json.loads(head.stdout)
    if type(info.get('ContentLength')) is not int or not 0 <= info['ContentLength'] <= maximum:
        raise ValueError('RESULT_LIMIT')
    response = aws('s3api', 'get-object', '--bucket', bucket, '--key', key, str(path))
    if response.returncode:
        return False
    if path.stat().st_size != info['ContentLength']:
        raise ValueError('RESULT_LENGTH')
    return True


def validate(receipt, raw, arn, token, label):
    if (not isinstance(receipt, dict) or set(receipt) != {'schema','instance','token','label','exit_code','bytes','sha256'}
            or receipt['schema'] != SCHEMA or receipt['instance'] != arn
            or receipt['token'] != token or receipt['label'] != label
            or type(receipt['exit_code']) is not int or not 0 <= receipt['exit_code'] <= 255
            or type(receipt['bytes']) is not int or receipt['bytes'] != len(raw)
            or len(raw) > MAX_OUTPUT or receipt['sha256'] != hashlib.sha256(raw).hexdigest()):
        raise ValueError('RESULT_RECEIPT')
    return receipt['exit_code']


def collect(label, command, output):
    bucket, arn = os.environ['CERTIFY_RESULTS_BUCKET'], os.environ['INSTANCE_ARN']
    token, timeout = uuid.uuid4().hex, int(os.environ.get('POLIS_SSM_TIMEOUT', '21600'))
    prefix = admit(bucket, arn, token, label, timeout)
    request = [bucket, arn, token, label, timeout, command]
    source = base64.b64encode(Path(__file__).read_bytes()).decode()
    payload = base64.b64encode(json.dumps(request).encode()).decode()
    launcher = "import base64; exec(compile(base64.b64decode("+repr(source)+"), '<transport>', 'exec'))"
    remote = 'python3 -c '+shlex.quote(launcher)+' --worker '+shlex.quote(payload)
    params = json.dumps({'commands':[remote], 'executionTimeout':[str(timeout+60)]})
    sent = aws('ssm','send-command','--instance-ids',arn.rsplit('/',1)[1],
               '--document-name','AWS-RunShellScript','--comment',label,'--timeout-seconds','600',
               '--parameters',params,'--output','json')
    if sent.returncode:
        raise ValueError('COMMAND_SEND_FAILED')
    deadline = time.monotonic()+timeout+300
    with tempfile.TemporaryDirectory(prefix='polis-receipt-') as d:
        receipt_path, out = Path(d)/'receipt.json', Path(d)/'stdout'
        while time.monotonic() < deadline:
            if get(bucket,prefix+'receipt.json',receipt_path,MAX_RECEIPT):
                receipt = json.loads(receipt_path.read_bytes())
                if not get(bucket,prefix+'stdout',out,MAX_OUTPUT):
                    raise ValueError('RESULT_MISSING')
                raw = out.read_bytes()
                code = validate(receipt,raw,arn,token,label)
                Path(output).write_bytes(raw)
                return code
            time.sleep(2)
    raise ValueError('RESULT_DEADLINE')


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--worker':
            worker(json.loads(base64.b64decode(sys.argv[2],validate=True)))
        else:
            sys.exit(collect(*sys.argv[1:]))
    except Exception:
        # Neither cloud errors nor command contents belong in public logs.
        print('p022 transport result=failed',file=sys.stderr)
        sys.exit(1)
