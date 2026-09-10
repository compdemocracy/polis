"""Build a pinned public dependency layer locally. Never publishes or invokes AWS."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
NAME = 'polis-probe-login-python312-arm64.zip'
CA_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(lock):
    require(set(lock) == {'schema','runtime','wheel','ca','archive','archive_sha256'}, 'LOCK_FIELDS')
    require(lock['schema'] == 'polis-probe-login-layer/1' and lock['archive'] == NAME, 'LOCK_SCHEMA')
    require(re.fullmatch(r'[a-f0-9]{64}', lock['archive_sha256']), 'ARCHIVE_DIGEST_PIN')
    runtime = lock['runtime']
    require(set(runtime) == {'python','architecture','image','config_sha256'}, 'RUNTIME_FIELDS')
    require(runtime['python'] == '3.12' and runtime['architecture'] == 'arm64', 'RUNTIME_ABI')
    require(re.fullmatch(r'public\.ecr\.aws/lambda/python@sha256:[a-f0-9]{64}', runtime['image']), 'IMMUTABLE_RUNTIME')
    require(re.fullmatch(r'[a-f0-9]{64}', runtime['config_sha256']), 'RUNTIME_CONFIG_PIN')
    wheel, ca = lock['wheel'], lock['ca']
    require(set(wheel) == {'name','version','filename','url','sha256','bytes'}, 'WHEEL_FIELDS')
    require(wheel['name'] == 'psycopg2-binary' and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', wheel['version']), 'PACKAGE_PIN')
    require(re.fullmatch(r'psycopg2_binary-'+re.escape(wheel['version'])+r'-cp312-cp312-manylinux_[0-9_]+_aarch64(?:\.manylinux_[0-9_]+_aarch64)?\.whl', wheel['filename']), 'WHEEL_ABI')
    url = urllib.parse.urlsplit(wheel['url'])
    require(url.scheme == 'https' and url.netloc == 'files.pythonhosted.org' and not url.query
            and not url.fragment and url.path.endswith('/'+wheel['filename']), 'WHEEL_ORIGIN')
    require(set(ca) == {'filename','url','sha256','bytes','certificates'} and ca['filename'] == 'rds-ca.pem'
            and ca['url'] == CA_URL, 'CA_ORIGIN')
    require(type(ca['certificates']) is int and 1 <= ca['certificates'] <= 256, 'CA_COUNT')
    for pin in (wheel,ca):
        require(type(pin['bytes']) is int and 1 <= pin['bytes'] <= 16*1024*1024, 'INPUT_SIZE_PIN')
        require(re.fullmatch(r'[a-f0-9]{64}', pin['sha256']), 'INPUT_DIGEST_PIN')


def acquire(cache, pin, offline=False):
    path = cache/pin['filename']
    require(not path.is_symlink(), 'INPUT_SYMLINK')
    if path.exists():
        require(path.is_file() and path.stat().st_size == pin['bytes'] and sha(path) == pin['sha256'], 'CACHED_INPUT_MISMATCH')
        return path
    require(not offline, 'OFFLINE_INPUT_MISSING')
    with urllib.request.urlopen(pin['url'], timeout=60) as response:
        data = response.read(pin['bytes']+1)
    require(len(data) == pin['bytes'] and hashlib.sha256(data).hexdigest() == pin['sha256'], 'DOWNLOADED_INPUT_MISMATCH')
    with path.open('xb') as handle:
        handle.write(data)
    return path


def container(lock, output, inputs, mode):
    name = 'polis-probe-layer-'+uuid.uuid4().hex
    args = ['docker','run','--rm','--name',name,'--label','org.polis.probe-layer=local-build',
            '--pull','never','--platform','linux/arm64','--network','none','--read-only',
            '--cap-drop','ALL','--security-opt','no-new-privileges',
            '--user',f'{os.getuid()}:{os.getgid()}',
            '--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777',
            '--tmpfs','/opt:rw,exec,nosuid,nodev,size=128m,mode=1777',
            '--env','PYTHONDONTWRITEBYTECODE=1','--env','PIP_CONFIG_FILE=/dev/null',
            '--mount',f'type=bind,source={HERE},target=/recipe,readonly',
            '--mount',f'type=bind,source={HERE.parent/"provision_login.py"},target=/task/provision_login.py,readonly',
            '--mount',f'type=bind,source={output},target=/out'+(',readonly' if mode == 'verify' else '')]
    for path in inputs:
        args += ['--mount',f'type=bind,source={path},target=/inputs/{path.name},readonly']
    args += ['--entrypoint','/var/lang/bin/python',lock['runtime']['image'],'-B','/recipe/runtime.py',mode]
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=600)
        require(result.returncode == 0, 'LAYER_CONTAINER_FAILED: '+result.stdout+result.stderr)
        return result.stdout
    finally:
        # Only this invocation's unpredictable container name; no global cleanup.
        subprocess.run(['docker','rm','-f',name],capture_output=True,check=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True,help='new output directory outside the Lambda source tree')
    parser.add_argument('--cache',type=Path,required=True,help='public pinned input cache outside the Lambda source tree')
    parser.add_argument('--offline',action='store_true',help='require cached inputs and the pinned runtime image')
    args = parser.parse_args()
    output, cache = args.output.resolve(), args.cache.resolve()
    require(not output.is_relative_to(HERE.parent) and not cache.is_relative_to(HERE.parent), 'BUILD_OUTSIDE_LAMBDA_ASSET')
    require(not output.exists() and not output.is_relative_to(cache) and not cache.is_relative_to(output), 'NEW_SEPARATE_OUTPUT_REQUIRED')
    lock = json.loads((HERE/'lock.json').read_text())
    validate(lock)
    expected = f"psycopg2-binary=={lock['wheel']['version']} --hash=sha256:{lock['wheel']['sha256']}\n"
    require((HERE/'requirements.lock').read_text() == expected, 'REQUIREMENTS_PIN')
    source_pins = {name:sha(HERE/name) for name in ('build.py','runtime.py','lock.json','requirements.lock')}
    handler_pin = sha(HERE.parent/'provision_login.py')
    cache.mkdir(parents=True,exist_ok=True)
    inputs = [acquire(cache,lock[k],args.offline) for k in ('wheel','ca')]
    image = lock['runtime']['image']
    if not args.offline:
        subprocess.run(['docker','pull','--platform','linux/arm64',image],check=True,stdout=sys.stderr)
    info = json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]
    require(info['Os'] == 'linux' and info['Architecture'] == 'arm64'
            and info['Id'] == 'sha256:'+lock['runtime']['config_sha256'], 'RUNTIME_IMAGE_IDENTITY')
    output.mkdir(parents=True)
    container(lock,output,inputs,'assemble')
    observed = json.loads(container(lock,output,inputs,'verify'))
    archive = output/NAME
    require(observed['zip_sha256'] == sha(archive), 'VERIFIED_ZIP_MISMATCH')
    require(sha(archive) == lock['archive_sha256'], 'ARCHIVE_PIN actual='+sha(archive))
    require(all(sha(HERE/name) == value for name,value in source_pins.items())
            and sha(HERE.parent/'provision_login.py') == handler_pin, 'SOURCE_CHANGED_DURING_BUILD')
    receipt = dict(schema='polis-probe-login-layer-build/1', runtime_image=image, runtime_image_id=info['Id'],
                   lock_sha256=sha(HERE/'lock.json'), zip_sha256=sha(archive), zip_bytes=archive.stat().st_size,
                   source_sha256=source_pins,
                   handler_sha256=handler_pin, wheel_sha256=lock['wheel']['sha256'],
                   ca_sha256=lock['ca']['sha256'], native_check=observed,
                   members_sha256=sha(output/'members.json'), build_network='none', published=False)
    (output/'build-receipt.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
    print(json.dumps(dict(archive=str(archive),sha256=receipt['zip_sha256'],bytes=receipt['zip_bytes'],native_check='PASS')))


if __name__ == '__main__':
    main()
