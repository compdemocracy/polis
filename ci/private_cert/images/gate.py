#!/usr/bin/env python3
"""P-053 step-2 paired-recording producer/verifier, per BOARD [677].

Complete scope: admitted bundle/entries/checkpoints, certify raw schema and
comparison, symmetric G12 abs1e-6+rel1e-4 with zero outliers. Recovery and serving
schedule inference belong to shadow diagnostics. No private certificate or
writer transfer follows from this scoped receipt.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys
import tempfile

# Under python -I the trusted source closure explicitly selects its own imports;
# mounted data never enter sys.path. Producer/verifier closures are built apart.
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / 'delphi'))
sys.path.insert(0, str(HERE.parent))
from control import encoded, sha
from image_admission import file_digest, json_bytes, regular_path
import g12
from polismath.replay import certify, fixture_bundle, real_data, schedule, store
from polismath.replay.event_ingress import input_hashes

POLICY = {'schema': 'polis-private-paired-policy/1', 'absolute': 1e-6,
          'relative': 1e-4, 'outlier_fraction': 0, 'strict_raw_schema': True,
          'stages': 'diagnostic-only', 'recovery_consumption': 'shadow-diagnostic-only'}
INPUT_KEYS = {'candidateSha', 'oracleSha', 'policySha256', 'scheduleSha256',
              'inventorySha256', 'expectedChecks'}


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as f:
        f.write(encoded(value))


def read(path):
    return json_bytes(path.read_bytes())


def regular_tree(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or (not path.is_file() and not path.is_dir()):
            raise ValueError('UNSAFE_EVIDENCE')
        if path.is_file():
            result[str(path.relative_to(root))] = file_digest(path)
    return result


def prepare(fixture, inputs, scratch, *, bind=True):
    """Re-derive every input/checkpoint from the bound fixture, independently."""
    if set(inputs) != INPUT_KEYS or inputs['policySha256'] != sha(POLICY):
        raise ValueError('PAIRED_POLICY_BINDING')
    plan = read(fixture / 'plan.json')
    if (set(plan) != {'schema', 'scope', 'manifestSha256', 'configSha256', 'entries'}
            or plan['schema'] != 'polis-private-paired-plan/1'
            or plan['scope'] not in ('public', 'private', 'all')):
        raise ValueError('PLAN_SCHEMA')
    manifest_path, config_path = fixture / 'manifest.json', fixture / 'config.json'
    if file_digest(manifest_path) != plan['manifestSha256'] or file_digest(config_path) != plan['configSha256']:
        raise ValueError('BUNDLE_METADATA_BINDING')
    manifest, config = read(manifest_path), read(config_path)
    payload = fixture / 'payload'
    fixture_bundle.verify(payload, manifest)
    fixture_bundle.admit_manifest(manifest, config=config, config_bytes=config_path.read_bytes(), payload_root=payload)
    if regular_tree(fixture).keys() != {'plan.json', 'manifest.json', 'config.json'} | {
        'payload/' + f['path'] for f in manifest['files']}:
        raise ValueError('FIXTURE_EXTRA_FILES')
    public = {r['slug'] for r in config['public_fixtures']}
    battery = certify.load_battery(REPO / 'delphi/scripts/certify_battery.json')
    required = {(e.dataset, e.schedule_id) for e in battery
                if plan['scope'] == 'all' or (e.dataset in public) == (plan['scope'] == 'public')}
    if not required or not isinstance(plan['entries'], list):
        raise ValueError('EMPTY_BATTERY')
    roles = {}
    for row in manifest['roles']:
        if row['role'] in roles:
            raise ValueError('AMBIGUOUS_ROLE')
        roles[row['role']] = row
    mapping, prepared, seen = {}, [], set()
    for item in plan['entries']:
        if set(item) != {'dataset', 'schedule_id', 'role', 'directory', 'schedule'}:
            raise ValueError('PLAN_ENTRY_SCHEMA')
        key = item['dataset'], item['schedule_id']
        if key in seen or key not in required:
            raise ValueError('ENTRY_INVENTORY')
        seen.add(key)
        store.recording_dir(*key)
        alias = item['dataset']
        expected_role = next((r['role'] for r in config['public_fixtures'] if r['slug'] == alias),
                             config['coverage_role_map'].get(alias))
        role = roles.get(expected_role)
        if item['role'] != expected_role or (alias not in public and (
            role is None or item['directory'] != role['dir'])):
            raise ValueError('OPAQUE_ROLE_BINDING')
        regular_path(item['directory'])
        directory = payload / item['directory']
        if not directory.is_dir() or directory.is_symlink() or payload.resolve() not in directory.resolve().parents:
            raise ValueError('INPUT_DIRECTORY')
        if alias in public:
            # Public fixtures are not owned-extraction roles. Bind their CSV
            # bytes to the independently built verifier's committed public pin.
            candidates = sorted(real_data.REAL_DATA_ROOT.glob('*-' + alias))
            if len(candidates) != 1 or (directory / 'events.jsonl').exists():
                raise ValueError('PUBLIC_FIXTURE_BINDING')
            for pattern in ('*-votes.csv', '*-comments.csv'):
                wanted, supplied = sorted(candidates[0].glob(pattern)), sorted(directory.glob(pattern))
                if len(wanted) != 1 or len(supplied) != 1 or file_digest(wanted[0]) != file_digest(supplied[0]):
                    raise ValueError('PUBLIC_FIXTURE_BINDING')
        if alias not in public and not (directory / 'events.jsonl').is_file():
            raise ValueError('PRIVATE_LOSSLESS_INGRESS_REQUIRED')
        if alias in mapping and mapping[alias] != str(directory.resolve()):
            raise ValueError('ALIAS_REBOUND')
        mapping[alias] = str(directory.resolve())
    if seen != required:
        raise ValueError('INCOMPLETE_ENTRY_INVENTORY')
    map_path = scratch / 'input-map.json'
    dump(map_path, mapping)
    os.environ['POLIS_REPLAY_INPUT_MAP'] = str(map_path)
    for item in plan['entries']:
        # New explicit cuts are already frozen in this plan; do not reuse a
        # historical CSV schedule to silently truncate/reorder fresh events.
        spec = schedule.ScheduleSpec.from_dict(item['schedule'])
        if spec.dataset != item['dataset'] or spec.schedule_id != item['schedule_id']:
            raise ValueError('SCHEDULE_IDENTITY')
        spec_path = scratch / 'schedules' / item['dataset'] / (item['schedule_id'] + '.json')
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec.write_json(spec_path)
        entry = certify.BatteryEntry(item['dataset'], item['schedule_id'], schedule_path=spec_path,
                                     role=item['role'])
        expected = certify.prepare_entry(entry)
        original = next(e for e in battery if (e.dataset, e.schedule_id) == (entry.dataset, entry.schedule_id))
        recipe = certify.build_effective_spec(original, real_data.load_export_votes(entry.dataset))
        if (spec.moderation != recipe.moderation or spec.restart_after != recipe.restart_after
                or spec.clojure != recipe.clojure or spec.coverage != recipe.coverage):
            raise ValueError('SCHEDULE_RECIPE_CHANGED')
        declared_cuts = recipe.cuts.get('at', [])
        if len(expected.checkpoints) != len(declared_cuts):
            raise ValueError('SCHEDULE_CHECKPOINT_COUNT_CHANGED')
        if expected.spec.coverage != 'full-stream' and plan['scope'] != 'public':
            raise ValueError('PRIVATE_FULL_STREAM_REQUIRED')
        prepared.append(expected)
    full = {p.entry.dataset for p in prepared if p.spec.coverage == 'full-stream'}
    if any(p.entry.dataset not in full for p in prepared):
        raise ValueError('PREFIX_WITHOUT_FULL_COMPANION')
    schedules = [p.spec.to_dict() for p in prepared]
    inventory = [{'dataset': p.entry.dataset, 'schedule_id': p.entry.schedule_id,
                  'role': p.entry.role, 'votesSha256': p.votes_sha,
                  'eventsMetaSha256': p.events_meta_sha, 'commentsSha256': p.comments_sha,
                  'manifestSha256': plan['manifestSha256'], 'configSha256': plan['configSha256'],
                  'checkpoints': p.checkpoints, 'stream_end': p.stream_end} for p in prepared]
    checks = sum(len(p.checkpoints) for p in prepared)  # one paired checkpoint = one check
    if bind and (sha(schedules) != inputs['scheduleSha256'] or sha(inventory) != inputs['inventorySha256']
            or type(inputs['expectedChecks']) is not int or checks != inputs['expectedChecks'] or checks == 0):
        raise ValueError('ADMITTED_INVENTORY_BINDING')
    return prepared, inventory


def run_engine(cmd, cwd, log):
    env = {'PATH': os.environ['PATH'], 'HOME': '/tmp', 'UV_OFFLINE': '1', 'PIP_NO_INDEX': '1',
           'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1',
           'PYTHONHASHSEED': '0', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
           'POLIS_REPLAY_INPUT_MAP': os.environ['POLIS_REPLAY_INPUT_MAP'],
           'PYTHONPATH': str(REPO / 'delphi')}
    with log.open('wb') as fh:
        result = subprocess.run(cmd, cwd=cwd, env=env, stdout=fh, stderr=subprocess.STDOUT,
                                timeout=certify.DRIVER_TIMEOUT_SEC)
    return result.returncode


def produce(fixture=Path('/fixture'), output=Path('/output'), inputs_path=Path('/run-spec/inputs.json')):
    if Path('/admission').exists():
        raise ValueError('PRODUCER_CONTROL_MOUNT')
    inputs = read(inputs_path)
    if list(output.iterdir()):
        raise ValueError('FRESH_OUTPUT_REQUIRED')
    with tempfile.TemporaryDirectory(prefix='paired-producer-') as tmp:
        scratch = Path(tmp)
        prepared, inventory = prepare(fixture, inputs, scratch)
        # Original fixtures stay in a separate read-only box-local mount. They
        # never become part of the producer's evidence/output directory.
        runs = []
        for expected in prepared:
            entry = expected.entry
            rec = store.recording_dir(entry.dataset, entry.schedule_id, root=output / 'recordings')
            rec.mkdir(parents=True)
            spec_path = scratch / 'resolved' / entry.dataset / (entry.schedule_id + '.json')
            spec_path.parent.mkdir(parents=True, exist_ok=True)
            expected.spec.write_json(spec_path)
            event = expected.votes_csv.name == 'events.jsonl'
            commands = [
                ('clj', ['clojure', '-M:replay', '--schedule', str(spec_path),
                         '--events' if event else '--votes', str(expected.votes_csv), '--out', str(rec)]
                 + (['--comments', str(expected.comments_csv)] if expected.comments_csv else []), REPO / 'math'),
                ('py', [sys.executable, 'scripts/replay_driver.py', 'run', '--schedule', str(spec_path),
                        '--out', str(output / 'recordings')]
                 + (['--events', str(expected.votes_csv)] if event else []), REPO / 'delphi')]
            for engine, cmd, cwd in commands:
                exit_code = run_engine(cmd, cwd, rec / (engine + '.log'))
                runs.append({'dataset': entry.dataset, 'schedule_id': entry.schedule_id,
                             'engine': engine, 'exit': exit_code})
                if exit_code:
                    break
            if runs[-1]['exit']:
                break
        result = {'schema': 'polis-private-paired-output/1', 'inputs': inputs,
                  'inventory': inventory, 'runs': runs,
                  'resources': {'ru_maxrss': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
                                'ru_maxrss_unit': 'KiB on Linux; bytes on macOS',
                                'output_bytes': sum(p.stat().st_size for p in output.rglob('*') if p.is_file())},
                  'files': regular_tree(output)}
        dump(output / 'producer.json', result)
    # A nonzero engine exit is retained as INCOMPLETE evidence for the verifier;
    # this trusted collector can finish normally without fabricating success.


def verify_recordings(evidence, inputs, scratch, fixture=Path('/fixture')):
    prepared, inventory = prepare(fixture, inputs, scratch)
    result = read(evidence / 'producer.json')
    if set(result) != {'schema', 'inputs', 'inventory', 'runs', 'resources', 'files'} or result['schema'] != 'polis-private-paired-output/1':
        raise ValueError('PRODUCER_SCHEMA')
    if result['inputs'] != inputs or result['inventory'] != inventory:
        raise ValueError('PRODUCER_BINDING')
    actual = regular_tree(evidence)
    actual.pop('producer.json')
    actual.pop('supervisor-producer.log', None)  # independently packaged by supervisor
    if actual != result['files']:
        raise ValueError('EVIDENCE_FILE_INVENTORY')
    runs = [{'dataset': p.entry.dataset, 'schedule_id': p.entry.schedule_id, 'engine': engine, 'exit': 0}
            for p in prepared for engine in ('clj', 'py')]
    if result['runs'] != runs:
        raise ValueError('INCOMPLETE_ENGINE_EXECUTION')
    return verify_pairs(prepared, evidence / 'recordings', scratch)


def verify_pairs(prepared, recordings, scratch):
    if not prepared:
        raise ValueError('EMPTY_RECORDINGS')
    reports = []
    with contextlib.redirect_stdout(io.StringIO()):
        controls_pass = g12.self_test() == 0
    if not controls_pass:
        raise ValueError('G12_CONTROLS_FAILED')
    passed = True
    for p in prepared:
        rec = store.recording_dir(p.entry.dataset, p.entry.schedule_id, root=recordings)
        if read(rec / 'schedule.json') != p.spec.to_dict():
            raise ValueError('RECORDING_SCHEDULE_BINDING')
        for engine in ('clj', 'py'):
            certify.validate_recording_inventory(rec / engine, engine, p)
        strict = certify.compare_recording_pair(rec / 'clj', rec / 'py', cache_root=scratch)
        metric = g12.measure_main_blob(rec, REPO / 'delphi')
        ok = bool(all(s['match'] for s in strict['per_step']) and metric.get('authoritative_g12') is True)
        passed = passed and ok
        stage_diagnostic = {'status': 'NOT_CAPTURED', 'gate': False}
        if (rec / 'clj-stages').is_dir() and (rec / 'py-stages').is_dir():
            try:
                stage_diagnostic = {'gate': False, 'comparison': g12.measure_stages(rec / 'clj-stages', rec / 'py-stages')}
            except Exception as exc:
                stage_diagnostic = {'gate': False, 'status': 'UNAVAILABLE', 'error_type': type(exc).__name__}
        reports.append({'dataset': p.entry.dataset, 'schedule_id': p.entry.schedule_id,
                        'strict': strict, 'g12': metric, 'pass': ok, 'stages': stage_diagnostic})
    controls = checkpoint_controls(prepared[0], recordings, scratch)
    return {'verdict': 'PASS' if passed else 'FAIL', 'checks': sum(len(p.checkpoints) for p in prepared),
            'entries': reports, 'negative_controls': {'schema': 'polis-private-controls/1',
                                  'g12': {'rejected': 17, 'expected': 17}, 'checkpoint': controls},
            'scope': 'paired-recordings; stages/recovery/consumption are separate diagnostics'}


def checkpoint_controls(expected, recordings, scratch):
    """Exercise the shipped schema/inventory validator on real, valid output."""
    from dataclasses import replace
    base = store.recording_dir(expected.entry.dataset, expected.entry.schedule_id, root=recordings)
    checkpoint = expected.checkpoints[0]
    one = replace(expected, checkpoints=[checkpoint])
    source = base / 'py' / f"step-{checkpoint['index']:03d}.json"
    control_dir = scratch / 'controls'
    control_dir.mkdir()
    target = control_dir / source.name
    original = source.read_bytes()
    target.write_bytes(original)
    certify.validate_recording_inventory(control_dir, 'py', one)
    result = {}
    for name in ('missing-evidence', 'forged-evidence', 'truncated-evidence', 'short-inventory'):
        target.write_bytes(original)
        check = one
        if name == 'missing-evidence':
            target.unlink()
        elif name == 'forged-evidence':
            malformed = json_bytes(original)
            malformed['blob']['n'] = True  # same bytes/hash could not legitimize this
            target.write_bytes(encoded(malformed))
        elif name == 'truncated-evidence':
            target.write_bytes(original[:len(original)//2])
        else:
            check = replace(one, checkpoints=[checkpoint, {**checkpoint, 'index': checkpoint['index'] + 1}])
        try:
            certify.validate_recording_inventory(control_dir, 'py', check)
        except (ValueError, certify.CertifyError):
            result[name] = 'REJECTED'
        else:
            raise ValueError('CHECKPOINT_CONTROL_FALSE_ACCEPTANCE')
    return result


def verify(evidence=Path('/evidence'), admission_dir=Path('/admission'), verdict_dir=Path('/verdict'), fixture=Path('/fixture')):
    a = read(admission_dir / 'admission.json')
    inputs = {k: a[k] for k in INPUT_KEYS}
    report = {'verdict': 'INCOMPLETE', 'checks': 0}
    try:
        with tempfile.TemporaryDirectory(prefix='paired-verifier-') as tmp:
            report = verify_recordings(evidence, inputs, Path(tmp), fixture)
    except Exception as exc:
        report['private_error_type'] = type(exc).__name__
    controls = report.get('negative_controls', {'schema': 'polis-private-controls/1', 'status': 'NOT_COMPLETED'})
    dump(verdict_dir / 'negative-controls.json', controls)
    dump(verdict_dir / 'details.json', report)
    verdict = report['verdict']
    receipt = {'schema': 'polis-private-gate/2', 'negativeControlsSha256': sha(controls), 'admissionSha256': sha(a),
               'evidenceSha256': (admission_dir / 'evidence-sha256').read_text().strip(),
               'inventorySha256': a['inventorySha256'], 'scheduleSha256': a['scheduleSha256'],
               'policySha256': a['policySha256'], 'checks': report['checks'], 'verdict': verdict,
               'reason': {'PASS': 'COMPLETE', 'FAIL': 'COMPARISON', 'INCOMPLETE': 'MISSING_EVIDENCE'}[verdict]}
    dump(verdict_dir / 'receipt.json', receipt)


if __name__ == '__main__':
    if sys.argv[1:] == ['produce']:
        produce()
    elif sys.argv[1:] == ['verify']:
        verify()
    else:
        raise SystemExit('Expected produce or verify')
