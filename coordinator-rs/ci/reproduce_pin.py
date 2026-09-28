"""Locate reviewed digest producers without learning or replacing any expectation.

Default: execute the existing campaign for an active matching platform when
--output and the campaign's project/port/dependency prerequisites are supplied.
--plan performs no execution. --campaign-dir compares an existing receipt; that
is a retained-artifact check, never a claim of a new replay.
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = '.github/workflows/coordinator-ci.yml'
JOB = 'coordinator-required'
SOURCE_CLOSURES = {'s1-closure.json', 's2-closure.json', 's2-production-reader.json'}
HISTORICAL_REPORTS = {'bridge-repin.json', 's1-revalidation.json', 's1s2-repin.json'}


def leaves(value, path=()):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from leaves(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from leaves(child, (*path, index))
    else:
        yield path, value


def get(value, path):
    for key in path:
        value = value[key]
    return value


def campaign_file(name):
    return ('fresh-evidence/' if name.startswith('d4-') else 'artifacts/') + name


def locate(digest, root=ROOT):
    if not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', digest):
        raise ValueError('DIGEST_INVALID')
    registry = json.loads((root / 'coordinator-rs/ci/replay-pins.json').read_text())
    locations, targets, origins, source_targets = [], [], [], []
    for section in ('pins', 'retired_pins'):
        for pin in registry.get(section, []):
            hits = [path for path, value in leaves(pin) if isinstance(value, str) and
                    re.search(r'(?<![0-9a-f])' + digest + r'(?![0-9a-f])', value)]
            if not hits:
                continue
            key = {k: pin[k] for k in ('system', 'machine', 'forced_kernel')}
            origins.append({'id': pin['id'], 'active': section == 'pins', 'platform_key': key,
                            'attribution': pin.get('attribution', {})})
            for path in hits:
                locations.append({'file': 'coordinator-rs/ci/replay-pins.json',
                                  'section': section, 'pin': pin['id'], 'path': list(path)})
                target = None
                if path[0] == 'checkpoints' and path[-1] == 'rust':
                    target = {'file': 'artifacts/vw-equivalence.json', 'path': list(path)}
                elif path[0] == 'witnesses':
                    target = {'file': campaign_file(path[1]), 'path': list(path[2:])}
                elif path[0] == 'witness_sha256':
                    target = {'file': campaign_file(path[1]), 'hash_file': True}
                if target:
                    targets.append(dict(target, pin=pin['id'], platform_key=key, active=section == 'pins'))
    for file in sorted((root / 'coordinator-rs/evidence').glob('*.json')):
        document = json.loads(file.read_text())
        for path, value in leaves(document):
            if isinstance(value, str) and re.search(r'(?<![0-9a-f])' + digest + r'(?![0-9a-f])', value):
                location = {'file': str(file.relative_to(root)), 'path': list(path)}
                if len(path) == 2 and (path[0] == 'sha256' or
                        (file.name == 'admission.json' and path[0] == 'files')):
                    location.update(classification='SOURCE_BYTES',
                        basis='Exact current-file SHA256; historical drift reports MISMATCH, never repins.',
                        producer=['shasum', '-a', '256', path[1]],
                        enforced_by_campaign=file.name in SOURCE_CLOSURES)
                    target = {'file': path[1], 'hash_file': True}
                    if target not in source_targets:
                        source_targets.append(target)
                elif file.name == 'admission.json' and len(path) == 3 and path[0] == 'input_fixtures' and path[2] == 'sha256' and path[1] in {'vw', 'biodiversity'}:
                    location.update(classification='SOURCE_BYTES', basis=
                        'SHA256 of the exact public export votes CSV, before load_export_votes normalization. '
                        'Resolve only the checked-in public slug directory, never ambient private input maps.',
                        producer=['python', 'coordinator-rs/ci/reproduce_pin.py', digest])
                    source_targets.append({'fixture_slug': path[1], 'hash_file': True})
                elif file.name in {'stage-inventory.json', 'd4-bundle-reader.json', 'd4-generation-zero.json'}:
                    diagnostic = file.name == 'stage-inventory.json'
                    location.update(classification='FRESH_DIAGNOSTIC' if diagnostic else 'FRESH_GATE',
                        basis=('audit_stages.py emits fresh stage contexts; historical digest equality is diagnostic, '
                               'not a stage-admission requirement or proof of cross-platform stability.' if diagnostic else
                               'verify.comparisons requires complete fresh witness equality to baseline.'),
                        producer=['python', 'coordinator-rs/ci/run.py', '--output', '<new-absolute-output-directory>'])
                    for pin in registry['pins']:
                        target = {'file': 'fresh-evidence/' + file.name, 'path': list(path),
                            'pin': pin['id'], 'platform_key': {k: pin[k] for k in ('system', 'machine', 'forced_kernel')},
                            'active': True, 'diagnostic_only': diagnostic}
                        if diagnostic and len(path) > 2 and path[0] == 'stages':
                            target.update(stage=document['stages'][path[1]]['stage'], path=list(path[2:]))
                        targets.append(target)
                elif file.name in HISTORICAL_REPORTS:
                    location.update(classification='EVIDENCE_ONLY', basis=
                        'Retrospective source/reconciliation receipt, not generated by run.py. '
                        'Original recorded source revisions and receipt bytes are the historical preimages; '
                        'current campaign output cannot regenerate the old receipt. Exact location retained.')
                elif file.name in {'vw-equivalence.json', 'd4-node-reader.json', 'd4-node-reader-empty.json',
                                   'polarity-public-fixture.json', 'polarity-vw.json', 'polarity-biodiversity.json',
                                   'polarity-rebuild-schedule.json', 'semantic-tie-key.json'}:
                    output_path = list(path)
                    if file.name == 'vw-equivalence.json' and len(path) == 3 and path[0] == 'checkpoints' and path[-1] == 'python':
                        output_path[-1] = 'rust'  # verify.comparisons requires fresh rust == python
                    mapped = any(t['file'] == campaign_file(file.name) and
                                 t.get('path') == output_path for t in targets)
                    location.update(classification='REGISTRY_TARGET' if mapped else 'BLOCKED',
                        basis='Exact output file/path maps to platform registry target; checkpoint python is normalized to rust only because verify.comparisons requires their equality.' if mapped else
                              'Fresh witness field lacks platform/source attribution; add reviewed producer mapping before claiming reproduction.')
                elif ('run_pins' in path or 'runPins' in path or path[0] == 'binaries'):
                    location.update(classification='EVIDENCE_ONLY', basis=
                        'Informational original build/run/log bytes; audit_stages.IGNORED_PREFIXES explicitly excludes '
                        'these from source gates. Exact original toolchain/build directory or archived logs are needed '
                        'for byte-identical historical reproduction; current builds are new observations.')
                elif len(digest) == 40 or any('archive' in str(k).lower() or 'reconciliation' in str(k).lower()
                                            or 'proof_sha256' == k for k in path):
                    location.update(classification='EVIDENCE_ONLY', basis=
                        'Recorded commit/archive/proof/reconciliation attribution; inspect the named original '
                        'object/receipt. It is not emitted anew by the required campaign; no current-output MATCH claimed.')
                else:
                    location.update(classification='BLOCKED', basis=
                        'No reviewed producer/preimage mapping for this exact evidence path. '
                        'Requires original input normalization or retained producing receipt; not evidence-only by default.')
                locations.append(location)
    if not locations:
        raise ValueError('DIGEST_NOT_FOUND')
    return {'digest': digest, 'workflow': WORKFLOW, 'job': JOB,
            'command': (['python', 'coordinator-rs/ci/reproduce_pin.py', digest] if source_targets else
                        ['python', 'coordinator-rs/ci/run.py', '--output', '<new-absolute-output-directory>']),
            'required_inputs': ['exact reviewed source revision / source-workspace reconciliation',
                'coordinator-rs/ci/inventory-v2.json', 'coordinator-rs/ci/replay-pins.json',
                'coordinator-rs/evidence/python-requirements.txt', 'coordinator-rs/Cargo.lock',
                'server/package-lock.json', 'Node 24', 'Docker Compose public TLS PostgreSQL fixture',
                'unique COMPOSE_PROJECT_NAME; matching POLIS_RECOVERY_PG_PORT and RECOVERY_PG_PORT >=55432'],
            'locations': locations, 'origins': origins, 'targets': targets, 'source_targets': source_targets,
            'historical_limit': 'Explicit historical receipt/archive attribution is evidence-only; '
                'the campaign produces new observations, not identical historical receipt bytes. '
                'Retired platform keys are never automatically selected.'}


def local_key():
    system, machine = platform.system(), platform.machine()
    return dict(system=system, machine=machine,
                forced_kernel='Haswell' if (system, machine) == ('Linux', 'x86_64') else 'not-forced')


def select_targets(report, key):
    return [t for t in report['targets'] if t['active'] and t['platform_key'] == key]


def regular(base, relative):
    base = base.resolve()
    path = base / relative
    components = [path]
    while components[-1] != base and components[-1] != components[-1].parent:
        components.append(components[-1].parent)
    if not path.resolve().is_relative_to(base) or any(p.is_symlink() for p in components):
        raise ValueError('ARTIFACT_PATH_REFUSED')
    if not path.is_file():
        raise ValueError('ARTIFACT_MISSING')
    return path


def compare_sources(report, root=ROOT):
    checks = []
    for target in report['source_targets']:
        label = target.get('file', 'public votes CSV for ' + target.get('fixture_slug', ''))
        try:
            if 'fixture_slug' in target:
                directories = list((root / 'delphi/real_data').glob('*-' + target['fixture_slug']))
                files = [p for d in directories for p in d.glob('*votes.csv')]
                if len(files) != 1:
                    return {'status': 'BLOCKED', 'reason': 'Exactly one public preimage required: ' + label}
                relative = str(files[0].relative_to(root))
            else:
                relative = target['file']
            actual = hashlib.sha256(regular(root, relative).read_bytes()).hexdigest()
        except ValueError as error:
            if str(error) == 'ARTIFACT_MISSING':
                return {'status': 'BLOCKED', 'reason': 'Source preimage is absent: ' + label}
            raise
        checks.append({'kind': 'source', 'target': target, 'actual': actual, 'matches': actual == report['digest']})
    return {'status': 'MATCH' if all(c['matches'] for c in checks) else 'MISMATCH', 'checks': checks,
            'scope': 'current source-byte comparison; historical drift is not repinned'}


def unresolved(report):
    blocked = [x for x in report['locations'] if x.get('classification') == 'BLOCKED']
    return {'status': 'BLOCKED' if blocked else 'EVIDENCE_ONLY',
            'reason': 'Producer/preimage prerequisite missing; see exact blocked locations.' if blocked else report['historical_limit'],
            'blocked_locations': blocked}


def compare(report, directory, key):
    targets = select_targets(report, key)
    if not targets:
        if report['source_targets']:
            return compare_sources(report)
        return {'status': 'NOT_ON_THIS_PLATFORM'} if report['targets'] else unresolved(report)
    receipt = json.loads(regular(directory, 'receipt.json').read_text())
    runtime = receipt.get('replay_runtime', {})
    if any(runtime.get(k) != v for k, v in key.items()):
        raise ValueError('RECEIPT_PLATFORM_MISMATCH')
    # Reuse actual numerical-kernel admission; a key string alone is insufficient.
    from replay_pins import validate_kernel
    validate_kernel(runtime)
    if receipt.get('candidate_gate') != 'PASS':
        raise ValueError('CAMPAIGN_NOT_PASS')
    selected = receipt.get('replay_pin', {}).get('pin', {})
    if selected.get('id') not in {t['pin'] for t in targets}:
        raise ValueError('RECEIPT_PIN_MISMATCH')
    checks = []
    for target in targets:
        file = regular(directory, target['file'])
        raw = file.read_bytes()
        actual_hash = hashlib.sha256(raw).hexdigest()
        if receipt.get('artifact_sha256', {}).get(target['file']) != actual_hash:
            raise ValueError('ARTIFACT_RECEIPT_MISMATCH')
        try:
            value = json.loads(raw) if not target.get('hash_file') else None
            if 'stage' in target:
                rows = [row for row in value['stages'] if row['stage'] == target['stage']]
                if len(rows) != 1:
                    raise KeyError('stage identity absent or duplicated')
                value = rows[0]
            actual = actual_hash if target.get('hash_file') else get(value, target['path'])
            checks.append({'kind': 'campaign', 'target': target, 'actual': actual, 'matches': actual == report['digest']})
        except (KeyError, IndexError, TypeError):
            checks.append({'kind': 'campaign', 'target': target, 'actual': None, 'matches': False, 'reason': 'FRESH_PATH_ABSENT_OR_CHANGED'})
    result = {'status': 'MATCH' if all(c['matches'] for c in checks) else 'MISMATCH', 'checks': checks}
    if any(t.get('diagnostic_only') for t in targets):
        result['scope'] = 'retained historical stage-byte diagnostic; not a campaign gate result; no new replay'
    return result


def execute(report, output, root=ROOT):
    key = local_key()
    if report['source_targets']:
        return compare_sources(report, root)
    if not report['targets']:
        return unresolved(report)
    if not select_targets(report, key):
        return {'status': 'NOT_ON_THIS_PLATFORM', 'local_platform_key': key}
    if output is None:
        return {'status': 'NOT_RUN', 'reason': 'Supply --output plus the explicit campaign project/port and installed dependencies.'}
    output = output.resolve()
    if output.exists() or output.is_relative_to(root.resolve()):
        raise ValueError('OUTPUT_MUST_BE_NEW_AND_OUTSIDE_CHECKOUT')
    # Existing runner enforces exact dependencies, local project isolation, source
    # reconciliation and all historical/fresh-engine gates. No fallback or repin.
    command = [sys.executable, str(root / 'coordinator-rs/ci/run.py'), '--output', str(output)]
    result = subprocess.run(command, cwd=root, stdout=sys.stderr, stderr=sys.stderr)
    if result.returncode:
        return {'status': 'CAMPAIGN_FAILED', 'reason': 'No fresh comparison admitted', 'exit': result.returncode,
                'output': str(output), 'command': command}
    result = compare(report, output, key)
    result['scope'] = ('fresh campaign historical stage-byte diagnostic; not a campaign gate result'
                       if any(t.get('diagnostic_only') for t in select_targets(report, key)) else 'fresh campaign')
    return dict(result, command=command, output=str(output))



def coverage(report, result, key):
    """Make subset comparisons explicit; MATCH applies only to listed checks."""
    checks = result.get('checks', [])
    checked_sources = [c['target'] for c in checks if c.get('kind') == 'source']
    checked_campaign = [c['target'] for c in checks if c.get('kind') == 'campaign']
    pending_sources = [t for t in report['source_targets'] if t not in checked_sources]
    pending_campaign = [t for t in select_targets(report, key) if t not in checked_campaign]
    blocked = [x for x in report['locations'] if x.get('classification') == 'BLOCKED']
    return {'match_applies_to': 'only the explicit checks in this result, not every occurrence of the digest',
            'remaining_source_targets': pending_sources,
            'remaining_selected_platform_campaign_targets': pending_campaign,
            'other_platform_or_retired_targets': [t for t in report['targets'] if t not in select_targets(report, key)],
            'blocked_locations': blocked,
            'complete_for_selected_platform': bool(checks) and not (pending_sources or pending_campaign or blocked)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('digest')
    parser.add_argument('--plan', action='store_true')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--output', type=Path)
    group.add_argument('--campaign-dir', type=Path)
    args = parser.parse_args(argv)
    try:
        report = locate(args.digest)
        if args.plan:
            result = {'status': 'NOT_RUN', 'scope': 'plan only'}
        elif args.campaign_dir:
            result = compare(report, args.campaign_dir, local_key())
            result.setdefault('scope', 'retained artifact comparison; no new replay')
        else:
            result = execute(report, args.output)
        result['coverage'] = coverage(report, result, local_key())
        print(json.dumps(dict(report, result=result), indent=2))
        return 1 if result['status'] in ('MISMATCH', 'CAMPAIGN_FAILED') else 0
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({'status': 'REFUSED', 'reason': str(error)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
