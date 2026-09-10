#!/usr/bin/env python3
"""List the complete source-only image closure from one reviewed checkout.

The subsequent stage command validates committedness and every byte. Verifier
recipes come from an independently reviewed checkout, not a producer artifact.
"""
import argparse
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from control import encoded
from image_admission import GATES, file_digest, validate_recipe


def source_files(root):
    names = {
        'ci/private_cert/control.py', 'ci/private_cert/image_admission.py',
        'ci/private_cert/images/gate.py', 'ci/private_cert/images/g12.py',
        'ci/private_cert/images/probe.py', 'ci/probe_box/contracts.py', 'ci/probe_box/receipt.py',
        'delphi/scripts/replay_driver.py', 'delphi/scripts/certify_battery.json',
        'delphi/scripts/certify_datasets.json', 'delphi/scripts/certify_datasets.schema.json',
        'math/dev/replay.clj', 'math/deps.edn',
    }
    for base, pattern in [('delphi/polismath', '**/*.py'), ('math/src', '**/*'),
                          ('delphi/scripts/schedules', '*.json'), ('delphi/scripts/schemas', '*.json'),
                          ('delphi/real_data', '*/*-votes.csv'), ('delphi/real_data', '*/*-comments.csv')]:
        names.update(str(p.relative_to(root)) for p in (root / base).glob(pattern) if p.is_file())
    return {name: file_digest(root / name) for name in sorted(names)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--role', choices=['producer', 'verifier'], required=True)
    p.add_argument('--candidate', required=True)
    p.add_argument('--oracle', required=True)
    p.add_argument('--policy-sha256', required=True)
    p.add_argument('--runtime-image', required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=a.source, text=True).strip()
    recipe = {'schema': 'polis-private-image-recipe/1', 'role': a.role, 'sourceCommit': head,
              'candidateSha': a.candidate, 'oracleSha': a.oracle, 'policySha256': a.policy_sha256,
              'runtimeImage': a.runtime_image, 'files': source_files(a.source),
              'entrypoint': 'ci/private_cert/images/probe.py', 'gates': sorted(GATES)}
    validate_recipe(recipe)
    with a.out.open('xb') as f:
        f.write(encoded(recipe))


if __name__ == '__main__':
    main()
