"""Validate a local layer artifact and print its operator-only AWS CLI command."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shlex

HERE = Path(__file__).resolve().parent


def require(value, message):
    if not value:raise ValueError(message)


def command(directory, profile, region, name):
    directory=directory.resolve(strict=True)
    lock=json.loads((HERE/'lock.json').read_text())
    receipt=json.loads((directory/'build-receipt.json').read_text())
    archive=directory/lock['archive']
    require(archive.is_file() and not archive.is_symlink(), 'REGULAR_ARCHIVE_REQUIRED')
    require(receipt['schema']=='polis-probe-login-layer-build/1' and receipt['published'] is False, 'BUILD_RECEIPT_REQUIRED')
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    require(digest==lock['archive_sha256']==receipt['zip_sha256']==receipt['native_check']['zip_sha256'], 'ZIP_SHA256_MISMATCH')
    require(archive.stat().st_size==receipt['zip_bytes'], 'ZIP_SIZE_MISMATCH')
    require(receipt['lock_sha256']==hashlib.sha256((HERE/'lock.json').read_bytes()).hexdigest(), 'REVIEWED_LOCK_MISMATCH')
    require(receipt['runtime_image']==lock['runtime']['image']
            and receipt['runtime_image_id']=='sha256:'+lock['runtime']['config_sha256'], 'RUNTIME_PIN_MISMATCH')
    for path,pin in receipt['source_sha256'].items():
        require(path in ('build.py','runtime.py','lock.json','requirements.lock'), 'BUILD_SOURCE_FIELD')
        require(hashlib.sha256((HERE/path).read_bytes()).hexdigest()==pin, 'BUILD_SOURCE_CHANGED')
    require(set(receipt['source_sha256'])=={'build.py','runtime.py','lock.json','requirements.lock'}, 'BUILD_SOURCE_FIELDS')
    require(receipt['handler_sha256']==hashlib.sha256((HERE.parent/'provision_login.py').read_bytes()).hexdigest(), 'HANDLER_SOURCE_CHANGED')
    check=receipt['native_check']
    require(check['architecture']=='aarch64' and check['python'].startswith('3.12.')
            and check['psycopg2']==lock['wheel']['version'] and check['handler_import'] is True
            and check['ca_certificates']==lock['ca']['certificates'], 'NATIVE_CHECK_REQUIRED')
    args=['aws','lambda','publish-layer-version','--profile',profile,'--region',region,'--layer-name',name,
          '--zip-file','fileb://'+str(archive),'--compatible-runtimes','python3.12',
          '--compatible-architectures','arm64','--description','Python 3.12 ARM64 probe login; sha256:'+digest,
          '--query','{LayerVersionArn:LayerVersionArn,CodeSha256:Content.CodeSha256}',
          '--output','json','--no-cli-pager']
    return shlex.join(args),base64.b64encode(bytes.fromhex(digest)).decode()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-dir',type=Path,required=True)
    parser.add_argument('--profile',required=True,help='operator SSO profile; not read or used here')
    parser.add_argument('--region',required=True)
    parser.add_argument('--layer-name',default='polis-probe-login-python312-arm64')
    args=parser.parse_args()
    text,expected=command(args.artifact_dir,args.profile,args.region,args.layer_name)
    print('# Expected returned CodeSha256: '+expected)
    print(text)


if __name__=='__main__':main()
