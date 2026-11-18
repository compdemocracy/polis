#!/usr/bin/env python3
"""Check the generated Python registry and the single graph admission boundary."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]

def check(root=ROOT):
    errors = []
    for source, generated in [('queue-rs/polis-contracts/job-models.json', 'delphi/polismath/job-models.json'),
                              ('queue-rs/polis-contracts/job-test-models.json', 'delphi/tests/job_graph/job-test-models.json')]:
        if (root/source).read_bytes() != (root/generated).read_bytes():
            errors.append('registry differs: ' + generated)
    # Database contract tests intentionally call the SQL function directly to
    # prove refusal at that boundary; product callers must use the Rust entry.
    allowed = root/'queue-rs/src/jobs/admission.rs'
    for directory in ('queue-rs/src', 'delphi/scripts', 'delphi/polismath', 'server/src'):
        for path in (root/directory).rglob('*'):
            if path.suffix not in {'.rs', '.py', '.ts'} or path == allowed:
                continue
            if re.search(r'\bpd_graph_admit\b', path.read_text()):
                errors.append('graph admission outside shared entry: ' + str(path.relative_to(root)))
    return errors

if __name__ == '__main__':
    errors = check()
    for message in errors:
        print(message, file=sys.stderr)
    print(f'graph registry checks: {len(errors)} errors')
    raise SystemExit(bool(errors))
