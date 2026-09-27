#!/usr/bin/env python3
"""Three source-only light-shadow recipes; staging still requires reviewed commits."""
import argparse
from pathlib import Path
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'probe_box'))
from control import encoded
from image_admission import file_digest, validate_recipe
from light_shadow import POLICY_SHA

COMMON = ['ci/probe_box/' + n + '.py' for n in ('light_shadow', 'light_shadow_queries', 'receipt', 'contracts')]
# Producer and verifier apply the certified comparison unchanged.
COMPARISON = ['ci/private_cert/images/light_shadow_compare.py', 'ci/private_cert/images/g12.py',
              'delphi/scripts/schedules/pc-zerovote-01-empty.json']


def source_files(source, role):
    names = list(COMMON)
    if role != 'reader':
        names += COMPARISON
        names += sorted(str(p.relative_to(source)) for p in (source / 'delphi/polismath').glob('**/*.py') if p.is_file())
    names.append('ci/private_cert/images/light_shadow_' + role + '.py')
    return names


def recipe(source, role, runtime):
    names = source_files(source, role)
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    r = dict(schema='polis-private-image-recipe/2', kind='light-shadow-compare', role=role, sourceCommit=head,
             candidateSha=head, oracleSha=head, policySha256=POLICY_SHA, runtimeImage=runtime,
             files={n: file_digest(source / n) for n in names}, entrypoint=names[-1],
             gates=['light-shadow-compare'])
    return validate_recipe(r)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--role', choices=['reader', 'producer', 'verifier'], required=True)
    p.add_argument('--runtime-image', required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    with a.out.open('xb') as f:
        f.write(encoded(recipe(a.source, a.role, a.runtime_image)))


if __name__ == '__main__':
    main()
