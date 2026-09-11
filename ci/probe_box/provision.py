"""Provisioner instance entrypoint. Operator lifecycle uses run.py with ProvisionConfig."""
import json
import subprocess
import time
from pathlib import Path
from receipt import canonical, sha
from worker import metadata, absolute_deadline
from provision_login import execute


def run():
    import boto3
    from botocore.config import Config
    config = json.loads(Path('/opt/polis-probe/bootstrap.json').read_bytes())
    identity = json.loads(metadata('dynamic/instance-identity/document'))
    if config['mode'] != 'provision' or (identity['accountId'],identity['region']) != (config['account'],config['region']):
        raise ValueError('PROVISION_IDENTITY')
    arn = f'arn:aws:ec2:{identity["region"]}:{identity["accountId"]}:instance/{identity["instanceId"]}'
    s3 = boto3.client('s3',region_name=identity['region'],config=Config(
        s3={'us_east_1_regional_endpoint':'regional','addressing_style':'virtual'},
        retries={'total_max_attempts':1},connect_timeout=10,read_timeout=30))
    boot = None
    for _ in range(48):
        try:
            raw = s3.get_object(Bucket=config['controlBucket'],Key=f'boot/provision/{arn}.json')['Body'].read(65537)
            if len(raw)>65536: raise ValueError('BOOT_LIMIT')
            boot=json.loads(raw)
            break
        except Exception:
            time.sleep(5)
    if (not boot or boot['instanceId'] != identity['instanceId'] or boot['admissionSha256'] != sha(boot['admission'])
            or boot['admission']['ami'] != identity['imageId'] or boot['provision'] != boot['admission']['provision']
            or time.time() >= boot['terminateBy']):
        raise ValueError('PROVISION_BINDING')
    deadline=absolute_deadline(boot,900)
    # Independent OS timer; success/failure cannot extend the absolute deadline.
    subprocess.run(['shutdown','-h','+'+str(max(1,int((deadline-time.time())//60)))],check=True,
                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    success=False
    try:
        secret_client=boto3.client('secretsmanager',region_name=identity['region'],endpoint_url=boot['secretsUrl'])
        execute(boot,secret_client)
        success=True
    finally:
        result={'schema':'polis-probe-provision/1','admissionSha256':boot['admissionSha256'],'success':success}
        s3.put_object(Bucket=config['controlBucket'],Key=f'provision-results/{arn}.json',Body=canonical(result),
            IfNoneMatch='*',ServerSideEncryption='aws:kms',SSEKMSKeyId=boot['evidenceKey'])


if __name__ == '__main__':
    try: run()
    except Exception: pass
    finally: subprocess.run(['systemctl','poweroff'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
