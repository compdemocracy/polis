"""Build-time Polis identity, shared by the server, browsers and CLI."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SEMVER = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
SHA = r'[0-9a-f]{40}'


def git(root, *args):
    try:
        return subprocess.check_output(['git', '-C', str(root), *args],
                                       stderr=subprocess.DEVNULL, text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def identity(root=ROOT, env=None):
    env = os.environ if env is None else env
    raw_version = (root / 'VERSION').read_text()
    version = raw_version.removesuffix('\n')
    if not re.fullmatch(SEMVER + r'\n', raw_version):
        raise ValueError('VERSION must contain MAJOR.MINOR.PATCH')
    # Do not accidentally identify an archive by an enclosing checkout.
    top = git(root, 'rev-parse', '--show-toplevel')
    head = git(root, 'rev-parse', 'HEAD') if top and Path(top).resolve() == root.resolve() else None
    declared = env.get('POLIS_BUILD_COMMIT') or env.get('GIT_HASH')
    commit = declared or head or 'unknown'
    # Existing CI images deliberately use these labels instead of source hashes.
    # Keep them explicit and never let them claim stable provenance or distance.
    test_label = commit in ('test', 'characterization')
    if test_label:
        if env.get('POLIS_BUILD_TAG') or env.get('POLIS_BUILD_SOURCE') == 'clean-checkout':
            raise ValueError('Test commit labels cannot assert stable provenance')
        head = None
    if commit != 'unknown' and not test_label and not re.fullmatch(SHA, commit):
        raise ValueError('Build commit must be a full lowercase Git hash or unknown')
    if head and declared and head != declared:
        raise ValueError('Build commit does not match checkout HEAD')
    source = env.get('POLIS_BUILD_SOURCE') or ('development' if head else 'unverified-archive')
    if source not in ('development', 'clean-checkout', 'unverified-archive'):
        raise ValueError('Invalid build source')
    if source == 'clean-checkout' and commit == 'unknown':
        raise ValueError('clean-checkout requires a commit')
    if test_label:
        source = 'test-label'
    distance = None if test_label else env.get('POLIS_BUILD_DISTANCE')
    tag = env.get('POLIS_BUILD_TAG') or ''
    stable = False
    if head:
        exact_tag = git(root, 'for-each-ref', '--points-at', head, '--format=%(refname:short)', 'refs/tags') or ''
        stable_chain = (git(root, 'rev-list', '--first-parent', 'origin/stable') or '').splitlines()
        on_stable = head in stable_chain
        clean = git(root, 'status', '--porcelain', '--untracked-files=normal') == ''
        stable = bool(on_stable and clean and source != 'unverified-archive'
                      and f'v{version}' in exact_tag.splitlines())
        if tag and (tag != f'v{version}' or not stable):
            raise ValueError('Declared stable tag does not match a clean stable checkout')
        # First-parent set difference counts edge commits even when a stable
        # promotion merge itself is absent from edge's first-parent chain.
        baseline = (root / 'VERSION_STABLE_COMMIT').read_text().strip()
        if not re.fullmatch(SHA, baseline):
            raise ValueError('Invalid stable baseline commit')
        tagged_base = git(root, 'rev-parse', '--verify', f'refs/tags/v{version}^{{commit}}')
        if tagged_base and tagged_base in stable_chain:
            baseline = tagged_base
        calculated = None
        if git(root, 'rev-parse', '--is-shallow-repository') == 'false':
            calculated = git(root, 'rev-list', '--first-parent', '--count', f'{baseline}..{head}')
        if distance not in (None, '', 'unknown') and calculated is not None and distance != calculated:
            raise ValueError('Build distance does not match checkout history')
        distance = calculated if calculated is not None else distance
    elif tag:
        # Archive callers must provide all metadata from a verified stable tag.
        if tag != f'v{version}' or commit == 'unknown' or distance != '0' or source != 'clean-checkout':
            raise ValueError('Stable archive requires matching tag, commit, zero distance and verified source')
        stable = True
    if stable:
        distance = '0'
        if not env.get('POLIS_BUILD_SOURCE'):
            source = 'clean-checkout'
    if distance in (None, '', 'unknown'):
        distance = None
    elif not re.fullmatch(r'0|[1-9][0-9]*', str(distance)):
        raise ValueError('Build distance must be a nonnegative integer or unknown')
    else:
        distance = int(distance)
    display = version if stable else f'{version}+dev.{distance if distance is not None else "unknown"}.{commit[:12]}'
    return dict(version_base=version, version_display=display, commit=commit,
                distance=distance, channel='stable' if stable else 'development', source=source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--format', choices=['json', 'env', 'typescript'], default='json')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    info = identity(args.root)
    if args.format == 'env':
        text = '\n'.join(f'{key}={value if value is not None else "unknown"}' for key, value in info.items()) + '\n'
    elif args.format == 'typescript':
        text = 'export const buildInfo = Object.freeze(' + json.dumps(info, indent=2) + ');\n'
    else:
        text = json.dumps(info, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    else:
        print(text, end='')


if __name__ == '__main__':
    main()
