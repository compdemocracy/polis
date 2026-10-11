#!/usr/bin/env python3
"""Docker regression: a read-only source without data/ beside queue-state volume."""
import argparse
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location('launcher', root/'scripts/run-import-dry-run.py')
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    source = root/'delphi'
    assert not (source/'data').exists(), 'regression requires source without data/'
    name = 'polis-import-mount-test-' + uuid.uuid4().hex
    volume = name + '-queue-state'
    try:
        subprocess.run(['docker', 'volume', 'create', volume], check=True)
        subprocess.run(['docker', 'run', '-d', '--name', name,
            '--label', 'com.docker.compose.service=delphi',
            '--mount', 'type=volume,src=' + volume + ',dst=/app/data',
            '--entrypoint', 'sleep', args.image, 'infinity'], check=True)
        with tempfile.TemporaryDirectory(prefix=name, dir=root) as scratch:
            command = launcher.command(name, args.image, Path(scratch), source,
                                       'us-east-1', {}, [])
            # Real report entrypoint and imports; no AWS/database/provider access.
            subprocess.run(command + ['--help'], check=True)
            checks = '''
from pathlib import Path
import polismath.delphi_storage.import_report as report
source = Path.cwd()
assert source == Path('/opt/polis-import-source')
assert Path(report.__file__).is_relative_to(source)
assert Path('/app/data').is_dir()
assert not (source/'data').exists()
for directory in (source, Path('/app/data')):
    try:
        (directory/'must-not-write').write_text('refuse')
    except OSError as exc:
        assert exc.errno == 30, exc
    else:
        raise AssertionError('read-only mount allowed write: ' + str(directory))
print('PASS reviewed source imports; source and inherited queue volume read-only')
'''
            subprocess.run(command[:command.index(args.image) + 1] + ['-c', checks], check=True)
        assert not (source/'data').exists()
        print('PASS launcher with running Delphi /app/data named volume and no source data/')
    finally:
        subprocess.run(['docker', 'rm', '-f', '-v', name], check=False)
        subprocess.run(['docker', 'volume', 'rm', volume], check=False)


if __name__ == '__main__':
    main()
