"""Deterministic layer assembly and native checks inside the pinned Lambda image."""
from __future__ import annotations
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import platform
import ssl
import stat
import struct
import subprocess
import sys
import zipfile

HERE = Path(__file__).resolve().parent
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
MAX_BYTES = 64 * 1024 * 1024


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_bytes(path, pin):
    require(path.is_file() and not path.is_symlink(), 'NONREGULAR_INPUT')
    require(path.stat().st_size == pin['bytes'], 'INPUT_SIZE')
    data = path.read_bytes()
    require(digest(data) == pin['sha256'], 'INPUT_SHA256')
    return data


def elf_arm64(data):
    require(len(data) >= 20 and data[:6] == b'\x7fELF\x02\x01', 'ELF64_LITTLE_ENDIAN_REQUIRED')
    require(struct.unpack_from('<H', data, 18)[0] == 183, 'ARM64_ELF_REQUIRED')


def ca_count(data, expected):
    require(data.count(b'-----BEGIN CERTIFICATE-----') == expected, 'CA_INVENTORY')
    require(b'PRIVATE KEY' not in data, 'PUBLIC_CERTIFICATES_ONLY')
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cadata=data.decode('ascii'))
    require(context.cert_store_stats()['x509_ca'] == expected, 'CA_PARSE')
    return expected


def safe_name(name):
    path = PurePosixPath(name)
    require(name and not path.is_absolute() and '\\' not in name and '\x00' not in name
            and all(part not in ('', '.', '..') for part in name.rstrip('/').split('/')), 'ARCHIVE_PATH')


def pack(root, target):
    files = {}
    for p in root.rglob('*'):
        require(not p.is_symlink(), 'LAYER_SYMLINK')
        require(p.is_file() or p.is_dir(), 'NONREGULAR_LAYER_MEMBER')
        if p.is_file():
            require(p.suffix != '.pyc' and '__pycache__' not in p.parts, 'BYTECODE_IN_LAYER')
            files[p.relative_to(root).as_posix()] = p.read_bytes()
    require(sum(map(len, files.values())) <= MAX_BYTES, 'LAYER_SIZE')
    directories = {parent.as_posix()+'/' for name in files for parent in PurePosixPath(name).parents if str(parent) != '.'}
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(set(files) | directories):
            safe_name(name)
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.create_system = 3
            mode = stat.S_IFDIR | 0o755 if name.endswith('/') else stat.S_IFREG | (0o755 if '.so' in name else 0o644)
            info.external_attr = mode << 16
            archive.writestr(info, files.get(name, b''))
    require(target.stat().st_size < 50 * 1024 * 1024, 'DIRECT_UPLOAD_SIZE')
    return {name:digest(data) for name,data in sorted(files.items())}


def assemble(lock, inputs, output):
    checked_bytes(inputs/lock['wheel']['filename'], lock['wheel'])
    ca = checked_bytes(inputs/'rds-ca.pem', lock['ca'])
    ca_count(ca, lock['ca']['certificates'])
    root = Path('/tmp/layer')
    require(not root.exists(), 'ASSEMBLY_DIRECTORY_EXISTS')
    root.mkdir()
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-index', '--no-deps', '--no-compile',
                    '--no-cache-dir', '--disable-pip-version-check', '--only-binary=:all:', '--require-hashes',
                    '--find-links', str(inputs), '-r', str(HERE/'requirements.lock'),
                    '--target', str(root/'python')], check=True)
    native = list((root/'python').rglob('*.so*'))
    require(native, 'NATIVE_LIBRARIES_MISSING')
    for p in native:
        elf_arm64(p.read_bytes())
    (root/'rds-ca.pem').write_bytes(ca)
    members = pack(root, output/lock['archive'])
    raw = (output/lock['archive']).read_bytes()
    (output/(lock['archive']+'.sha256')).write_text(digest(raw)+'  '+lock['archive']+'\n')
    (output/'members.json').write_text(json.dumps(members, sort_keys=True, indent=2)+'\n')


def verify(lock, archive_path):
    root = Path('/opt')
    with zipfile.ZipFile(archive_path) as archive:
        seen = set()
        require(sum(i.file_size for i in archive.infolist()) <= MAX_BYTES, 'LAYER_SIZE')
        for info in archive.infolist():
            safe_name(info.filename)
            require(info.filename not in seen, 'DUPLICATE_MEMBER')
            seen.add(info.filename)
            require(not stat.S_ISLNK(info.external_attr >> 16), 'LAYER_SYMLINK')
            require(info.date_time == ZIP_TIME, 'NONDETERMINISTIC_TIMESTAMP')
        archive.extractall(root)
    ca = checked_bytes(root/'rds-ca.pem', lock['ca'])
    count = ca_count(ca, lock['ca']['certificates'])
    sys.path.insert(0, str(root/'python'))
    import psycopg2
    import psycopg2._psycopg
    import psycopg2.extensions
    require(importlib.metadata.version('psycopg2-binary') == lock['wheel']['version'], 'PACKAGE_VERSION')
    require(Path(psycopg2.__file__).is_relative_to(root/'python'), 'FOREIGN_PACKAGE')
    elf_arm64(Path(psycopg2._psycopg.__file__).read_bytes())
    native = list((root/'python').rglob('*.so*'))
    for p in native:
        elf_arm64(p.read_bytes())
    # Import the actual stack handler with its runtime SDK and SQL adapter.
    sys.path.insert(0, '/task')
    import boto3
    import provision_login
    require(callable(boto3.client), 'RUNTIME_SDK_IMPORT')
    ca_count(ca, lock['ca']['certificates'])
    require(callable(provision_login.handler), 'HANDLER_IMPORT')
    return dict(python=platform.python_version(), architecture=platform.machine(),
                psycopg2=importlib.metadata.version('psycopg2-binary'),
                libpq=psycopg2.extensions.libpq_version(), ca_certificates=count,
                native_libraries=len(native), handler_import=True,
                zip_sha256=digest(archive_path.read_bytes()))


def main():
    lock = json.loads((HERE/'lock.json').read_text())
    require(platform.machine() == 'aarch64' and sys.version_info[:2] == (3,12), 'LAMBDA_RUNTIME_REQUIRED')
    os.umask(0o022)
    if sys.argv[1] == 'assemble':
        assemble(lock, Path('/inputs'), Path('/out'))
    elif sys.argv[1] == 'verify':
        print(json.dumps(verify(lock, Path('/out')/lock['archive']), sort_keys=True))
    else:
        raise ValueError('UNKNOWN_OPERATION')


if __name__ == '__main__':
    main()
