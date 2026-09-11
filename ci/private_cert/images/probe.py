"""Certification jobs for ProbeBox; raw input and recordings are box-local."""
from __future__ import annotations

import datetime
import json
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "probe_box"))
import gate
from receipt import sha, validate_receipt


def resolve_private_spec(entry, dataset):
    """Freeze full-stream cuts against this snapshot, preserving recipe shape.

    Presets already use the actual event count. Historical explicit vote-count
    schedules retain relative positions, step count and all other semantics.
    Too few events or an incompatible empty role fails admission downstream.
    """
    spec = gate.certify.build_effective_spec(entry, dataset)
    value = spec.to_dict()
    cuts = value['cuts']
    if entry.schedule_path and spec.coverage == 'full-stream' and cuts['mode'] == 'vote-count':
        slots = cuts['at']
        if slots and all(type(n) is int and n >= 0 for n in slots) and slots[-1] > 0:
            count = len(dataset.votes)
            value['cuts'] = {**cuts, 'at': [round(count * n / slots[-1]) for n in slots]}
    return gate.schedule.ScheduleSpec.from_dict(value)


def validate_reader_session(conn) -> None:
    """The live primary and replicas must both use the read-only reader login."""
    with conn.cursor() as cur:
        cur.execute("SELECT pg_is_in_recovery(), current_setting('transaction_read_only')")
        row = cur.fetchone()
        if not row or len(row) != 2 or type(row[0]) is not bool or row[1] != 'on':
            raise ValueError('READ_ONLY_SOURCE_REQUIRED')


def extract() -> None:
    """Use the same owned extractor against one read-only snapshot of the configured read target."""
    import psycopg2
    from polismath.replay import fixture_config as fc, fixture_extract as fx, fixture_bundle as fb
    recipe = json.loads(Path('/opt/polis-private-image/recipe.json').read_bytes())
    out = Path('/output')
    private = out / '.local'
    private.mkdir(mode=0o700)
    fixture = private / 'fixture'
    payload = fixture / 'payload'
    payload.mkdir(parents=True)
    config = fc.load_config()
    config_bytes = fc.DEFAULT_CONFIG_PATH.read_bytes()
    # libpq receives a socket-only service file, never a network hostname.
    conn = psycopg2.connect(service='probe')
    try:
        conn.autocommit = True
        validate_reader_session(conn)
        result = fx.extract_from_config(conn, config=config, payload_root=payload, guard_root=out)
    finally:
        conn.close()
    manifest = fb.build_manifest(bundle_id='probe-capture', payload_root=payload,
        config=config, config_bytes=config_bytes, selections=result['roles'],
        generated_summaries=result['generated'],
        snapshot={'identifier': 'live-readonly-repeatable-read',
                  'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'schema_migration_version': None},
        transaction_guarantee=result['transaction_guarantee'], tie_key=result['tie_key'],
        schedules=fb.collect_schedule_hashes(gate.REPO / 'delphi/scripts/schedules'),
        owner='probe-box', extraction_commit=recipe['sourceCommit'], source_commit=recipe['sourceCommit'],
        coverage_report=result.get('coverage_report'),
        representative_report=result.get('representative_selection'))
    gate.dump(fixture / 'manifest.json', manifest)
    (fixture / 'config.json').write_bytes(config_bytes)
    inputs = {k: recipe[k] for k in ('candidateSha', 'oracleSha', 'policySha256')}
    prepare_fixture_plan(fixture, config, manifest, private, inputs)
    gate.dump(out / 'inputs.json', inputs)
    # Identity mappings and all measured per-entry sizes remain on this box.
    gate.dump(private / 'provenance.json', result.get('provenance_rows', []))
    gate.dump(private / 'representative-provenance.json', result.get('representative_provenance', []))


def prepare_fixture_plan(fixture, config, manifest, private, inputs):
    """Freeze the complete old-plus-sample inventory before either engine runs."""
    from polismath.replay import fixture_samples as samples
    payload = fixture / 'payload'
    sampled = samples.admitted_rules(manifest, config, payload)
    roles = {r['role']: r for r in manifest['roles']}
    public = {r['slug'] for r in config['public_fixtures']}
    battery = [e for e in gate.certify.load_battery() if e.dataset not in public]
    mapping = {e.dataset: str(payload / roles[config['coverage_role_map'][e.dataset]]['dir']) for e in battery}
    mapping.update({alias: str(payload / roles[rule['role']]['dir']) for alias, rule in sampled.items()})
    import os
    mapping_file = private / 'map.json'
    gate.dump(mapping_file, mapping)
    os.environ['POLIS_REPLAY_INPUT_MAP'] = str(mapping_file)
    entries = []
    for entry in battery:
        dataset = gate.real_data.load_export_votes(entry.dataset)
        spec = resolve_private_spec(entry, dataset)
        role = config['coverage_role_map'][entry.dataset]
        entries.append({'dataset': entry.dataset, 'schedule_id': entry.schedule_id,
                        'role': role, 'directory': roles[role]['dir'], 'schedule': spec.to_dict()})
    for alias, rule in sampled.items():
        spec = samples.resolved_spec(alias, gate.real_data.load_export_votes(alias))
        entries.append(dict(dataset=alias, schedule_id=samples.SCHEDULE_ID, role=rule['role'],
                            directory=roles[rule['role']]['dir'], schedule=spec.to_dict()))
    gate.dump(fixture / 'plan.json', {'schema': samples.PLAN_VERSION if sampled else 'polis-private-paired-plan/1', 'scope': 'private',
        'manifestSha256': gate.file_digest(fixture / 'manifest.json'),
        'configSha256': gate.file_digest(fixture / 'config.json'), 'entries': entries})
    inputs.update(scheduleSha256='', inventorySha256='', expectedChecks=0)
    with tempfile.TemporaryDirectory() as tmp:
        prepared, inventory = gate.prepare(fixture, inputs, Path(tmp), bind=False)
    inputs.update(scheduleSha256=gate.sha([p.spec.to_dict() for p in prepared]), inventorySha256=gate.sha(inventory),
                  expectedChecks=sum(len(p.checkpoints) for p in prepared))
    if sampled:
        directories = {r['dir'] for r in manifest['roles'] if r['slug'] in sampled}
        files = manifest['files']
        gate.dump(private / 'payload-census.json', {
            'schema': 'polis-probe-payload-census/1',
            **samples.payload_census(manifest),
            'sample_directories': len(directories), 'required_entries': len(prepared),
            'required_checkpoints': sum(len(p.checkpoints) for p in prepared),
            'samples': [dict(samples.payload_sizes(payload / directory),
                             payload_bytes=sum(f['size'] for f in files if f['path'].startswith(directory + '/')))
                        for directory in sorted(directories)]})
    return prepared, inventory


def verify() -> None:
    job = gate.read(Path('/job/job.json'))
    inputs = gate.read(Path('/run-spec/inputs.json'))
    with tempfile.TemporaryDirectory() as tmp:
        report = gate.verify_recordings(Path('/evidence'), inputs, Path(tmp), Path('/fixture'))
    entries = []
    for entry in report['entries']:
        roll = entry['g12']['rollup']
        entries.append({'verdict': 'PASS' if entry['pass'] else 'FAIL',
                        'checks': len(entry['strict']['per_step']),
                        'worst_absolute': roll['max_abs'], 'worst_relative': roll['max_rel_all'],
                        'outliers': roll['g12_outliers'], 'nonfinite': roll['nonfinite']})
    controls = report['negative_controls']
    completed = controls['g12']['rejected'] + sum(v == 'REJECTED' for v in controls['checkpoint'].values())
    manifest = gate.read(Path('/fixture/manifest.json'))
    selection = manifest.get('representative', {}).get('report')
    receipt = {'schema': 'polis-probe-receipt/2' if selection else 'polis-probe-receipt/1', 'run_id': job['run_id'], 'job_sha256': sha(job),
               'verdict': report['verdict'], 'entries': entries,
               'controls': {'passed': completed, 'expected': 21},
               'selection': selection,
               'digests': {'producer': job['producer']['image'].split('@sha256:')[1],
                           'verifier': job['verifier']['image'].split('@sha256:')[1],
                           'inputs': sha(inputs), 'recordings': sha(gate.regular_tree(Path('/evidence'))),
                           'policy': inputs['policySha256']}}
    # This is an explicit projection. No nested raw report is serialized.
    gate.dump(Path('/verdict/receipt.json'), validate_receipt(receipt, job))


if __name__ == '__main__':
    if sys.argv[1:] == ['extract']:
        extract()
    elif sys.argv[1:] == ['produce']:
        gate.produce()
    elif sys.argv[1:] == ['verify']:
        verify()
    else:
        raise SystemExit(2)
