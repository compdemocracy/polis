#!/usr/bin/env python3
"""Check the copied Python registry and the single graph admission boundary."""
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

# The one product caller of the SQL admission function.
ENTRY = 'queue-rs/src/jobs/admission.rs'
# Files that may name the function without being product callers: this check and
# its tests, database contract tests that call the SQL function directly to prove
# refusal at that boundary, and one documentation comment.
ALLOWED = {
    ENTRY,
    'ci/check_graph_registry.py',
    'ci/test_graph_registry.py',
    'delphi/tests/job_graph/adversarial.py',
    'delphi/tests/job_graph/prove.py',
    'queue-rs/tests/delphi_shadow.rs',
    'queue-rs/tests/jobs_integration.rs',
    'queue-rs/polis-contracts/src/delphi_run.rs',
}
# Migrations define the function; documentation describes it.
NOT_CALLERS = {'.sql', '.md'}
SKIPPED_DIRECTORIES = {'.git', 'node_modules', 'target', '__pycache__'}


def files(root):
    """Every tracked or unignored file under root (all of it outside a Git checkout)."""
    try:
        listed = subprocess.run(['git', '-C', str(root), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                                capture_output=True, check=True).stdout.decode()
        return sorted({name for name in listed.split('\0') if name})
    except (OSError, subprocess.CalledProcessError):
        names = []
        for directory, subdirectories, filenames in os.walk(root):
            subdirectories[:] = [d for d in subdirectories if d not in SKIPPED_DIRECTORIES]
            names += [Path(directory, f).relative_to(root).as_posix() for f in filenames]
        return sorted(names)


def check(root=ROOT):
    root = Path(root)
    errors = []
    for source, copy in [('queue-rs/polis-contracts/job-models.json', 'delphi/polismath/job-models.json'),
                         ('queue-rs/polis-contracts/job-test-models.json', 'delphi/tests/job_graph/job-test-models.json')]:
        if (root/source).read_bytes() != (root/copy).read_bytes():
            errors.append('registry differs: ' + copy)
    for name in files(root):
        path = root/name
        if name in ALLOWED or path.suffix in NOT_CALLERS or not path.is_file() or path.is_symlink():
            continue
        if re.search(rb'\bpd_graph_admit\b', path.read_bytes()):
            errors.append('graph admission outside shared entry: ' + name)
    return errors


if __name__ == '__main__':
    errors = check()
    for message in errors:
        print(message, file=sys.stderr)
    print(f'graph registry checks: {len(errors)} errors')
    raise SystemExit(bool(errors))
