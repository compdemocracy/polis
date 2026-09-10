"""Public runner: dispatch approved code; emit only an opaque run and PASS/FAIL."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import time
import urllib.request

from contracts import audit_public_output, public_result, validate_job


def invoke(payload: dict) -> dict:
    import boto3
    url=os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']
    url += ('&' if '?' in url else '?')+'audience=sts.amazonaws.com'
    request=urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    with urllib.request.urlopen(request,timeout=15) as response:
        token=json.load(response)['value']
    credentials=boto3.client('sts',region_name=os.environ['AWS_REGION']).assume_role_with_web_identity(
        RoleArn=os.environ['PROBE_DISPATCH_ROLE'],RoleSessionName='probe-dispatch',WebIdentityToken=token,DurationSeconds=900)['Credentials']
    client=boto3.client('lambda',region_name=os.environ['AWS_REGION'],aws_access_key_id=credentials['AccessKeyId'],
        aws_secret_access_key=credentials['SecretAccessKey'],aws_session_token=credentials['SessionToken'])
    result=client.invoke(FunctionName=os.environ['PROBE_CONTROL_FUNCTION'],InvocationType='RequestResponse',Payload=json.dumps(payload).encode())
    raw=result['Payload'].read(1025)
    if result.get('FunctionError') or len(raw)>1024: raise ValueError('CONTROL_FAILED')
    reply=json.loads(raw)
    if set(reply)!={'run_id','complete','passed'} or any(type(reply[k]) is not bool for k in ('complete','passed')):
        raise ValueError('CONTROL_SCHEMA')
    if reply['passed'] and not reply['complete']: raise ValueError('PREMATURE_PASS')
    return reply


def perform(run_id: str) -> bool:
    registry=json.loads(Path(__file__).with_name('jobs.json').read_bytes())
    if set(registry)!={'schema','jobs'} or registry['schema']!='polis-probe-registry/1': raise ValueError('REGISTRY_SCHEMA')
    selected=registry['jobs'][os.environ['PROBE_JOB']]
    job=validate_job({**selected,'run_id':run_id})
    reply=invoke({'action':'launch','job':job})
    ceiling=time.monotonic()+job['max_seconds']+900
    while True:
        if reply['run_id']!=run_id: raise ValueError('RUN_BINDING')
        if reply['complete']: return reply['passed']
        if time.monotonic()>=ceiling:
            invoke({'action':'cancel','run_id':run_id})
            return False
        time.sleep(30)
        reply=invoke({'action':'status','run_id':run_id})


def main() -> int:
    identity=os.environ.get('GITHUB_RUN_ID','local')+':'+os.environ.get('GITHUB_RUN_ATTEMPT','0')
    run_id=hashlib.sha256(identity.encode()).hexdigest()[:32]
    passed=False
    try:
        # Capture OS descriptors too: native extensions and os.write bypass
        # Python's redirect_stdout. Child details never reach the public log.
        result=subprocess.run([sys.executable,__file__,'--private-dispatch',run_id],
                              capture_output=True,timeout=20700)
        passed=result.returncode==0 and result.stdout==b'PASS\n' and result.stderr==b''
    except Exception:
        passed=False
    public=public_result(run_id,passed)
    audit_public_output(public,run_id,[])
    sys.stdout.buffer.write(public)
    return 0 if passed else 1


if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--private-dispatch':
        try: ok=perform(sys.argv[2])
        except Exception: ok=False
        sys.stdout.write('PASS\n' if ok else 'FAIL\n')
        raise SystemExit(0 if ok else 1)
    raise SystemExit(main())
