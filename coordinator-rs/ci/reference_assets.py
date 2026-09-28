"""Committed historical oracles; Git history is an optional independent check.

Never regenerate pins from the working tree. A missing or modified vendored
asset always fails, even when Git could supply replacement bytes.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess


def load_asset(root: Path, reference: str, source: str) -> bytes:
    identity = reference + ':' + source
    missing = f'collection: missing={[identity]}; pinned reference unavailable'
    try:
        inventory = json.loads((root / 'coordinator-rs/ci/inventory-v2.json').read_bytes())
        pin = inventory['reference_assets'][identity]
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError(missing) from None
    if (type(pin) is not dict or set(pin) != {'path', 'sha256', 'upstream_sha256', 'commit'} or
            type(pin['path']) is not str or type(pin['sha256']) is not str or
            re.fullmatch(r'[a-f0-9]{64}', pin['sha256']) is None or
            type(pin['upstream_sha256']) is not str or re.fullmatch(r'[a-f0-9]{64}', pin['upstream_sha256']) is None or
            type(pin['commit']) is not str or re.fullmatch(r'[a-f0-9]{40}', pin['commit']) is None):
        raise ValueError(f'collection: invalid reference pin: {identity}')
    rel = PurePosixPath(pin['path'])
    path = root / str(rel)
    if (rel.is_absolute() or '..' in rel.parts or str(rel) != pin['path'] or
            not str(rel).startswith('coordinator-rs/ci/pinned/') or
            any(p.is_symlink() for p in (path, *path.parents) if p != root and root in p.parents)):
        raise ValueError(f'collection: unsafe pinned reference: {identity}')
    try:
        raw = path.read_bytes()
    except OSError:
        raise ValueError(missing) from None
    if hashlib.sha256(raw).hexdigest() != pin['sha256']:
        raise ValueError(f'collection: changed pinned reference: {identity}')
    if shutil.which('git') and (root / '.git').exists():
        historical = subprocess.run(['git', 'show', pin['commit'] + ':' + source],
                                    cwd=root, capture_output=True, check=False)
        if historical.returncode == 0 and hashlib.sha256(historical.stdout).hexdigest() != pin['upstream_sha256']:
            raise ValueError(f'collection: Git differs from pinned reference: {identity}')
    return raw
