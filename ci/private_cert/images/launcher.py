#!/usr/bin/env python3
"""Fixed exec-form ABI; verify the admitted closure before its gate entrypoint.

The gate is separately reviewed code. This launcher intentionally does not
replace it with certify --strict or turn a build/transport success into PASS.
"""
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path('/opt/polis-private-image')


def main():
    recipe = json.loads((ROOT / 'recipe.json').read_bytes())
    action = {'producer': 'produce', 'verifier': 'verify'}[recipe['role']]
    if sys.argv[1:] != [action]:
        raise ValueError('IMAGE_ACTION')
    # Admission is immutable under the supervisor's fixed mount contract.
    input_path = '/run-spec/inputs.json' if action == 'produce' else '/admission/admission.json'
    if action == 'produce' and Path('/admission').exists():
        raise ValueError('PRODUCER_CONTROL_MOUNT')
    admission = json.loads(Path(input_path).read_bytes())
    for key in ('candidateSha', 'oracleSha', 'policySha256'):
        if recipe[key] != admission[key]:
            raise ValueError('IMAGE_ADMISSION')
    payload = ROOT / 'payload'
    actual = set()
    for path in payload.rglob('*'):
        if path.is_symlink():
            raise ValueError('SOURCE_SYMLINK')
        if path.is_file():
            rel = str(path.relative_to(payload))
            actual.add(rel)
            if hashlib.sha256(path.read_bytes()).hexdigest() != recipe['files'].get(rel):
                raise ValueError('SOURCE_DIGEST')
        elif not path.is_dir():
            raise ValueError('SOURCE_FILE_TYPE')
    if actual != set(recipe['files']):
        raise ValueError('SOURCE_CENSUS')
    # Never import code from the mounted fixture/evidence/admission or an ambient
    # PYTHONPATH. -I disables caller-controlled Python import/config sources.
    env = {key: value for key, value in os.environ.items() if key in {
        'PATH', 'OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS',
        'NUMEXPR_NUM_THREADS', 'LANG', 'LC_ALL'}}
    env.update(HOME='/tmp', PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1',
               UV_OFFLINE='1', PIP_NO_INDEX='1')
    os.chdir(payload)
    os.execve('/opt/venv/bin/python', ['/opt/venv/bin/python', '-I',
              str(payload / recipe['entrypoint']), action], env)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('INCOMPLETE: admitted image closure or action invalid') from None
