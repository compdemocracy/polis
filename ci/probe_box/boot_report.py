"""Closed boot evidence, independent of worker imports and private run inputs."""
import json
import re
import sys
import urllib.request

PHASES = frozenset({'start', 'boot-config', 'firewall', 'dns', 'private-disk', 'container-daemon', 'worker'})
EXITS = frozenset({'nonzero', 'signal', 'unknown'})
SCHEMA = 'polis-probe-boot-failure/2'


def metadata(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = 'http://169.254.169.254/latest/'
    request = urllib.request.Request(base+'api/token', method='PUT',
        headers={'X-aws-ec2-metadata-token-ttl-seconds':'300'})
    with opener.open(request, timeout=5) as response:
        token = response.read(1024).decode()
    request = urllib.request.Request(base+path, headers={'X-aws-ec2-metadata-token':token})
    with opener.open(request, timeout=5) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('METADATA_LIMIT')
    return raw


def validate_bootstrap(b):
    expected = {'mode', 'account', 'region', 'controlBucket', 'dnsNames', 'resolver'}
    if type(b) is not dict:
        raise ValueError('BOOT_CONFIG')
    if b.get('mode') == 'worker':
        expected.update({'ec2Url', 'controlKey'})
    if set(b) != expected or b['mode'] not in ('worker', 'provision'):
        raise ValueError('BOOT_CONFIG')
    if b['mode'] == 'worker':
        from urllib.parse import urlsplit
        endpoint = urlsplit(b['ec2Url'])
        if (endpoint.scheme != 'https' or endpoint.netloc != endpoint.hostname or endpoint.path
                or endpoint.query or endpoint.fragment or endpoint.hostname not in b['dnsNames']):
            raise ValueError('BOOT_CONFIG')
        key = f"arn:aws:kms:{b['region']}:{b['account']}:key/"
        if (type(b['controlKey']) is not str or not b['controlKey'].startswith(key)
                or re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', b['controlKey'][len(key):]) is None):
            raise ValueError('BOOT_CONFIG')
    return b


def report(phase, status):
    if phase not in PHASES or status not in EXITS:
        return
    # Explicit fixed tokens only. Do not enable console output for the worker,
    # SDK or containers. The shell also emits a marker if Python cannot start.
    try:
        with open('/dev/console', 'w') as console:
            console.write(f'POLIS_PROBE_BOOT/1 {phase} {status}\n')
    except OSError:
        pass
    try:
        # User-data is trusted launch-template JSON, available before the file,
        # DNS, worker import, operator boot object or disposable disk exists.
        b = validate_bootstrap(json.loads(metadata('user-data')))
        i = json.loads(metadata('dynamic/instance-identity/document'))
        if b['mode'] != 'worker' or (i['accountId'], i['region']) != (b['account'], b['region']):
            return
        import boto3
        from botocore.config import Config
        arn = f"arn:aws:ec2:{i['region']}:{i['accountId']}:instance/{i['instanceId']}"
        body = json.dumps({'schema': SCHEMA, 'phase': phase, 'exit': status}).encode()
        # Each sink is attempted even if the other fails. The outer caller has
        # a wall-clock timeout, including SDK credential discovery/refresh.
        try:
            ec2 = boto3.client('ec2', region_name=i['region'], endpoint_url=b['ec2Url'],
                config=Config(retries={'total_max_attempts':1}, connect_timeout=3, read_timeout=3))
            ec2.create_tags(Resources=[i['instanceId']], Tags=[{
                'Key':'polis-probe-pulse', 'Value':f'boot-failure:{phase}:{status}'}])
        except Exception:
            pass
        try:
            s3 = boto3.client('s3', region_name=i['region'], config=Config(
                retries={'total_max_attempts':1}, connect_timeout=3, read_timeout=3,
                s3={'us_east_1_regional_endpoint':'regional', 'addressing_style':'virtual'}))
            s3.put_object(Bucket=b['controlBucket'], Key=f'heartbeats/boot/{arn}.json', Body=body,
                ServerSideEncryption='aws:kms', SSEKMSKeyId=b['controlKey'], IfNoneMatch='*')
        except Exception:
            pass
    except Exception:
        pass


if __name__ == '__main__' and len(sys.argv) == 3:
    report(sys.argv[1], sys.argv[2])
