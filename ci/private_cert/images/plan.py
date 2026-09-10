#!/usr/bin/env python3
"""Bind a reviewed complete plan to actual fixture bytes BEFORE engine output.

plan.json must already contain the reviewed role/directory mapping and freshly
resolved schedules. This command validates them and emits only data commitments
for the runtime operator's signed admission; it does not sign, upload or run.
"""
import argparse
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--fixture', type=Path, required=True)
    p.add_argument('--candidate', required=True)
    p.add_argument('--oracle', required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    from image_admission import COMMIT
    if not COMMIT.fullmatch(a.candidate) or not COMMIT.fullmatch(a.oracle):
        raise ValueError('IMMUTABLE_SOURCE_PINS_REQUIRED')
    inputs = dict(candidateSha=a.candidate, oracleSha=a.oracle,
                  policySha256=gate.sha(gate.POLICY), scheduleSha256='', inventorySha256='', expectedChecks=0)
    with tempfile.TemporaryDirectory(prefix='paired-plan-') as tmp:
        prepared, inventory = gate.prepare(a.fixture.resolve(), inputs, Path(tmp), bind=False)
    inputs.update(scheduleSha256=gate.sha([p.spec.to_dict() for p in prepared]),
                  inventorySha256=gate.sha(inventory),
                  expectedChecks=sum(len(p.checkpoints) for p in prepared))
    gate.dump(a.out, inputs)


if __name__ == '__main__':
    main()
