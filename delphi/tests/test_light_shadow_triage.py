"""Light-shadow triage mode of the paired battery, end to end on public constructed rows.

The battery box recomputes the triage set with the compare job's own queries and
classification, extracts the flagged conversations as triage-NNN roles, and the
manifest, admission, box plan and independent gate replay exactly those.
"""
import copy
import json
import os
from pathlib import Path
import sys

import pytest

from polismath.replay import fixture_bundle as fb, fixture_extract as fx, fixture_samples as samples
from polismath.replay import fixture_selection as selection, fixture_survey as fs
from tests.test_certify_bundle import _manifest
from tests.test_representative_payloads import TIE, metrics, raw_rows

ROOT = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(ROOT / 'ci/private_cert/images'))
import gate
import probe
import selection_context
import light_shadow_compare as compare
import light_shadow_triage as triage
import light_shadow as ls
from light_shadow_queries import QUERIES

ZID = 900000000


def conversations():
    """zid -> (prod, shadow): flagged, passing and unpaired rows."""
    variants = compare.fixture_variants()
    structural = compare.structural_variants()
    rows = {}
    for i, name in enumerate(('near-tie', 'history', 'pass', 'timestamps', 'no-shadow-row'), 1):
        rows[ZID + i] = variants[name]
    rows[ZID + 6] = structural['truncated-base-x']
    return rows


def flagged_set(rows):
    out = []
    for zid, (prod, shadow) in rows.items():
        if compare.classify(zid, prod, shadow, compare.empty_output())['outcome'] in ls.TRIAGE_SELECTED:
            out.append(ls.triage_member(zid, shadow))
    return out


def spec(digest):
    return ls.validate_triage_spec({
        'schema': ls.TRIAGE_SPEC_SCHEMA, 'source_run_id': 'c' * 32, 'source_job_sha256': 'd' * 64,
        'source_receipt_sha256': 'f' * 64, 'triage_sha256': digest, 'conversations': 2,
        'window': {'start_ms': 1_900_000_000_000 - 86_400_000, 'end_ms': 1_900_000_000_000},
        'shadow_env': 'python', 'certification_policy': ls.CERTIFICATION_POLICY})


class Cursor:
    def __init__(self, rows, log):
        self.rows, self.log, self.result = rows, log, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params):
        name = next(k for k, v in QUERIES.items() if v == sql)
        self.log.append((name, params))
        if name == 'active':
            self.result = [(z,) for z in sorted(self.rows)]
        elif name == 'rows':
            self.result = [(z, env, blob) for z in sorted(self.rows)
                           for env, blob in zip(('prod', params['shadow']), self.rows[z]) if blob is not None]

    def fetchmany(self, n):
        return self.result[:n]


class Conn:
    def __init__(self, rows):
        self.rows, self.log = rows, []

    def cursor(self):
        return Cursor(self.rows, self.log)


def sources():
    return {z: raw_rows(3 + i) for i, z in enumerate(sorted(conversations()))}


def patched(monkeypatch, order):
    raw = sources()
    monkeypatch.setattr(fs, 'open_readonly_repeatable_read',
                        lambda conn, **kw: order.append('open') or dict(
                            isolation_level='repeatable read', access_mode='read only', single_transaction=True))
    monkeypatch.setattr(fs, 'fetch_metrics', lambda conn: [dict(zid=z, **metrics(r)) for z, r in raw.items()])
    monkeypatch.setattr(fx, 'detect_tie_key', lambda conn: TIE)
    monkeypatch.setattr(fx, 'fetch_conversation', lambda conn, zid, tie: raw[zid])
    # The served-math capture is extract_conversation's own, unchanged path.
    from polismath.replay import fixture_config as fcfg
    monkeypatch.setattr(fcfg, 'served_math_options', lambda config: fcfg.ServedMathOptions(False, None))
    return raw


def triage_config():
    config, source = selection_context.resolve(
        json.loads(selection_context.PROBE_CONFIG_PATH.read_bytes()),
        {'run_id': 'a' * 32, 'triage_selection': spec('e' * 64)})
    assert source == selection_context.TRIAGE and 'representative_selection' not in config
    return config


def bundle(tmp_path, monkeypatch, digest=None):
    rows = conversations()
    s = spec(digest or ls.triage_digest(flagged_set(rows)))
    order = []
    patched(monkeypatch, order)
    config = triage_config()
    payload = tmp_path / '.local/fixture/payload'
    payload.mkdir(parents=True)
    result = triage.extract(Conn(rows), config=config, spec=s, payload_root=payload, guard_root=tmp_path)
    cfg = json.dumps(config).encode()
    manifest = _manifest(config, payload, selections=result['roles'], config_bytes=cfg,
                         triage_report=result['report'])
    fixture = payload.parent
    (fixture / 'config.json').write_bytes(cfg)
    gate.dump(fixture / 'manifest.json', manifest)
    return fixture, config, manifest, result, s, order


def test_recomputed_set_matches_and_selects_flagged_only(tmp_path, monkeypatch):
    fixture, config, manifest, result, s, order = bundle(tmp_path, monkeypatch)
    report = result['report']
    assert order == ['open']
    assert (report['match'], report['battery_count'], report['selected'], report['truncated']) \
        == ('MATCH', 3, 3, 0)
    # FAIL first, then the largest delta; provenance stays box-local.
    assert [r['zid'] for r in result['provenance_rows']][0] == ZID + 6
    assert {r['slug'] for r in result['roles']} == {'triage-001', 'triage-002', 'triage-003'}
    assert str(ZID)[:6] not in json.dumps(manifest)
    assert manifest['schema_version'] == samples.TRIAGE_MANIFEST_VERSION
    fb.verify(fixture / 'payload', manifest)
    fb.admit_manifest(manifest, config=config, config_bytes=(fixture / 'config.json').read_bytes(),
                      payload_root=fixture / 'payload')
    assert set(samples.admitted_rules(manifest, config, fixture / 'payload')) == {'triage-001', 'triage-002',
                                                                                'triage-003'}


def test_changed_set_is_reported_not_refused(tmp_path, monkeypatch):
    _, _, _, result, _, _ = bundle(tmp_path, monkeypatch, digest='a' * 64)
    assert (result['report']['match'], result['report']['compare_count'], result['report']['battery_count']) \
        == ('CHANGED', 2, 3)


def test_cap_takes_fail_first_then_largest_deltas_and_records_truncation():
    base = compare.fixture_blob()
    evidence, shadows, sizes = [], {}, {}
    for i in range(25):
        shadow = copy.deepcopy(base)
        shadow['pca']['center'] = [0.1 + 0.01 * (i + 1), 0.2]
        e = compare.classify(i + 1, base, shadow, compare.empty_output())
        evidence.append(e)
        shadows[i + 1] = shadow
        sizes[i + 1] = dict(zid=i + 1, **metrics(raw_rows(3)))
    s = spec(ls.triage_digest([[z, 1_700_000_000_000, None] for z in range(1, 26)]))
    chosen, report = triage.select(evidence, shadows, s, sizes)
    assert (report['battery_count'], report['selected'], report['truncated'], report['match']) == (25, 20, 5, 'MATCH')
    assert chosen == list(range(25, 5, -1))


def test_nothing_flagged_ends_the_run():
    base = compare.fixture_blob()
    e = compare.classify(1, base, copy.deepcopy(base), compare.empty_output())
    with pytest.raises(ValueError, match='TRIAGE_EMPTY'):
        triage.select([e], {1: base}, spec('e' * 64), {1: dict(zid=1, **metrics(raw_rows(3)))})


def test_selection_reads_both_labels_since_the_compare_window_began(monkeypatch):
    conn = Conn(conversations())
    triage.classify_active(conn, spec('e' * 64))
    params = {name: p for name, p in conn.log}
    assert params['active'] == dict(prod='prod', shadow='python', start=1_900_000_000_000 - 86_400_000,
                                    end=ls.MS_CEILING)


@pytest.mark.parametrize('mutation', ['missing', 'extra-coverage-role', 'wrong-size', 'representative-block',
                                      'old-version', 'seeded-config', 'group', 'report-count'])
def test_triage_manifest_refuses_substitutions(tmp_path, monkeypatch, mutation):
    fixture, config, m, _, _, _ = bundle(tmp_path, monkeypatch)
    row = next(r for r in m['roles'] if r['slug'] == 'triage-001')
    if mutation == 'missing':
        m['roles'].remove(row)
    elif mutation == 'extra-coverage-role':
        m['roles'].append(dict(row, slug=config['roles'][0]['slug'], role=config['roles'][0]['role']))
    elif mutation == 'wrong-size':
        row['measured_metrics']['V'] += 1
    elif mutation == 'representative-block':
        m['representative'] = {'schema': samples.BLOCK_VERSION, 'report': {}}
    elif mutation == 'old-version':
        m['schema_version'] = samples.MANIFEST_VERSION
    elif mutation == 'seeded-config':
        config = dict(config, representative_selection=dict(algorithm=selection.VERSION, target=20, seed='01' * 32))
    elif mutation == 'group':
        row['group'] = 'representative'
    elif mutation == 'report-count':
        m['triage']['report']['selected'] = 2
    with pytest.raises((fb.AdmissionError, ValueError)):
        fb.admit_manifest(m, config=config, config_bytes=json.dumps(config).encode(),
                          payload_root=fixture / 'payload')


def test_box_only_and_not_derivable(tmp_path, monkeypatch):
    fixture, config, manifest, _, _, _ = bundle(tmp_path, monkeypatch)
    with pytest.raises(fb.BundleError, match='BOX_ONLY'):
        fb.public_pin(manifest)
    with pytest.raises((fb.BundleError, ValueError)):
        _manifest(config, fixture / 'payload', selections=[], config_bytes=b'{}',
                  triage_report=manifest['triage']['report'],
                  representative_report={'seed': '01' * 32})


def plan(tmp_path, monkeypatch):
    monkeypatch.setenv('POLIS_REPLAY_INPUT_MAP', '')
    fixture, config, manifest, result, s, _ = bundle(tmp_path, monkeypatch)
    inputs = dict(candidateSha='c' * 40, oracleSha='d' * 40, policySha256=gate.sha(gate.POLICY))
    prepared, inventory = probe.prepare_fixture_plan(fixture, config, manifest, tmp_path / 'private', inputs)
    return fixture, inputs, prepared, inventory, manifest, s


def test_box_plans_and_gate_rederives_exactly_the_triage_entries(tmp_path, monkeypatch):
    fixture, inputs, prepared, inventory, _, _ = plan(tmp_path, monkeypatch)
    assert sorted(p.entry.dataset for p in prepared) == ['triage-001', 'triage-002', 'triage-003']
    assert gate.sha(gate.POLICY) == ls.CERTIFICATION_POLICY
    scratch = tmp_path / 'verify'
    scratch.mkdir()
    checked, inv = gate.prepare(fixture, inputs, scratch)
    assert inv == inventory and len(checked) == 3


@pytest.mark.parametrize('mutation', ['all-scope', 'missing-entry', 'coverage-entry'])
def test_gate_refuses_a_widened_or_short_triage_plan(tmp_path, monkeypatch, mutation):
    fixture, inputs, _, _, _, _ = plan(tmp_path, monkeypatch)
    p = gate.read(fixture / 'plan.json')
    if mutation == 'all-scope':
        p['scope'] = 'all'
    elif mutation == 'missing-entry':
        p['entries'].pop()
    elif mutation == 'coverage-entry':
        p['entries'].append(dict(p['entries'][0], dataset='pc-smallmix-01', schedule_id='x'))
    (fixture / 'plan.json').write_bytes(gate.encoded(p))
    scratch = tmp_path / 'verify'
    scratch.mkdir()
    with pytest.raises(ValueError):
        gate.prepare(fixture, inputs, scratch, bind=False)


def test_images_bind_triage_mode_to_the_job(tmp_path, monkeypatch):
    _, _, manifest, _, s, _ = bundle(tmp_path, monkeypatch)
    probe.admit_triage(manifest, {'run_id': 'a' * 32, 'triage_selection': s})
    with pytest.raises(ValueError, match='TRIAGE_MODE_BINDING'):
        probe.admit_triage(manifest, {'run_id': 'a' * 32})
    with pytest.raises(ValueError):
        probe.admit_triage(manifest, {'run_id': 'a' * 32, 'triage_selection': dict(s, triage_sha256='a' * 64)})
    ordinary = {k: v for k, v in manifest.items() if k != 'triage'}
    with pytest.raises(ValueError, match='TRIAGE_MODE_BINDING'):
        probe.admit_triage(dict(ordinary, schema_version=fb.MANIFEST_SCHEMA_VERSION),
                           {'run_id': 'a' * 32, 'triage_selection': s})


def test_battery_closure_carries_the_light_shadow_modules():
    # Source text: the CI layout ships only the modules, not the whole closure.
    text = (ROOT / 'ci/private_cert/images/recipe.py').read_text()
    for name in ('ci/probe_box/light_shadow.py', 'ci/probe_box/light_shadow_queries.py',
                 'ci/private_cert/images/light_shadow_compare.py',
                 'ci/private_cert/images/light_shadow_triage.py'):
        assert "'" + name + "'" in text


def test_triage_extraction_turns_autocommit_off_in_its_own_path():
    text = (ROOT / 'ci/private_cert/images/probe.py').read_text()
    start = text.index('if triage is not None:')
    branch = text[start:text.index('else:', start)]
    assert 'conn.autocommit = False' in branch
    assert branch.index('conn.autocommit = False') < branch.index('light_shadow_triage.extract')


def battery_job(s):
    from contracts import validate_job
    return validate_job(dict(schema='polis-probe-job/1', run_id='a' * 32, max_seconds=3600,
                             reader={'image': 'localhost/producer@sha256:' + '1' * 64, 'args': ['extract']},
                             producer={'image': 'localhost/producer@sha256:' + '1' * 64, 'args': ['produce']},
                             verifier={'image': 'localhost/verifier@sha256:' + '2' * 64, 'args': ['verify']},
                             triage_selection=s))


def test_producer_launches_both_engines_for_every_triage_entry(tmp_path, monkeypatch):
    fixture, inputs, prepared, _, _, _ = plan(tmp_path, monkeypatch)
    calls = []
    monkeypatch.setattr(gate, 'run_engine', lambda cmd, cwd, log, **kw: calls.append(kw) or 0)
    out = tmp_path / 'output'
    out.mkdir()
    gate.dump(tmp_path / 'inputs.json', inputs)
    gate.produce(fixture, out, tmp_path / 'inputs.json')
    assert [(c['engine'], c['recipe']) for c in calls] == [('legacy', 'triage-uniform6'),
                                                           ('python', 'triage-uniform6')] * len(prepared)


def test_fail_only_selection_exports_a_bound_triage_receipt(tmp_path, monkeypatch):
    """A FAIL-only triage set, one empty conversation: extraction, plan, the
    verifier's export and both receipt consumers, with constructed recordings."""
    from unittest.mock import patch
    # worker.decode_receipt and run.decode_receipt are this same boundary
    # (ci/probe_box/test_light_shadow_triage.py exercises both consumers).
    from receipt import decode_receipt, receipt_passed
    monkeypatch.setenv('POLIS_REPLAY_INPUT_MAP', '')
    rows = {ZID + 1: compare.structural_variants()['truncated-base-x']}
    s = spec(ls.triage_digest(flagged_set(rows)))
    raw = {ZID + 1: raw_rows(0)}
    monkeypatch.setattr(fs, 'open_readonly_repeatable_read', lambda conn, **kw: dict(
        isolation_level='repeatable read', access_mode='read only', single_transaction=True))
    monkeypatch.setattr(fs, 'fetch_metrics', lambda conn: [dict(zid=z, **metrics(r)) for z, r in raw.items()])
    monkeypatch.setattr(fx, 'detect_tie_key', lambda conn: TIE)
    monkeypatch.setattr(fx, 'fetch_conversation', lambda conn, zid, tie: raw[zid])
    from polismath.replay import fixture_config as fcfg
    monkeypatch.setattr(fcfg, 'served_math_options', lambda config: fcfg.ServedMathOptions(False, None))
    config = triage_config()
    payload = tmp_path / '.local/fixture/payload'
    payload.mkdir(parents=True)
    result = triage.extract(Conn(rows), config=config, spec=s, payload_root=payload, guard_root=tmp_path)
    assert (result['report']['match'], result['report']['selected']) == ('MATCH', 1)
    cfg = json.dumps(config).encode()
    manifest = _manifest(config, payload, selections=result['roles'], config_bytes=cfg,
                         triage_report=result['report'])
    fixture = payload.parent
    (fixture / 'config.json').write_bytes(cfg)
    gate.dump(fixture / 'manifest.json', manifest)
    inputs = dict(candidateSha='c' * 40, oracleSha='d' * 40, policySha256=gate.sha(gate.POLICY))
    prepared, _ = probe.prepare_fixture_plan(fixture, config, manifest, tmp_path / 'private', inputs)
    expected, = prepared
    assert expected.entry.role == 'triage-001' and len(expected.checkpoints) == 1
    # Constructed recordings of the empty conversation: both engines agree.
    recordings = tmp_path / 'recordings'
    checkpoint = dict(expected.checkpoints[0].__dict__) if hasattr(expected.checkpoints[0], '__dict__') \
        else dict(expected.checkpoints[0])
    rec = gate.store.recording_dir(expected.entry.dataset, expected.entry.schedule_id, root=recordings)
    (rec / 'clj').mkdir(parents=True)
    (rec / 'py').mkdir()
    gate.dump(rec / 'schedule.json', expected.spec.to_dict())
    blob = {'pca': {'comps': [[1.0], [1.0]]}, 'mod-in': [], 'mod-out': []}
    for key, value in expected.spec.empty_output.items():
        if key.startswith('pca.'):
            blob['pca'][key.split('.')[1]] = value
        else:
            blob[key] = value
    gate.dump(rec / 'clj/step-000.meta.json', checkpoint)
    gate.dump(rec / 'py/step-000.json', {**checkpoint, 'blob': blob})
    (rec / 'clj/step-000.blob.json').write_bytes(gate.encoded(blob))
    for engine in ('clj', 'py'):
        gate.dump(rec / (engine + '-attribution') / 'step-000.json',
                  dict(schema='polis-replay-attribution/1', checkpoint=0, pids=[], tids=[], fold='a' * 64,
                       rating_fold='a' * 64, starts=['not-computed'] * 2, center=None, comps=None,
                       comments=None, person=[], partitions=[]))
    job = battery_job(s)
    read, dump, tree = gate.read, gate.dump, gate.regular_tree
    admitted = {'/job/job.json': job, '/run-spec/inputs.json': inputs}

    def read_input(path):
        if str(path) in admitted:
            return admitted[str(path)]
        if str(path).startswith('/fixture/'):
            return read(fixture / str(path)[len('/fixture/'):])
        return read(path)
    out = tmp_path / 'verdict'
    out.mkdir()
    with patch.object(gate, 'read', side_effect=read_input), \
            patch.object(gate, 'verify_recordings',
                         side_effect=lambda *a: gate.verify_pairs([expected], recordings, tmp_path, attribution=True)), \
            patch.object(gate, 'regular_tree', side_effect=lambda _: tree(recordings)), \
            patch.object(gate, 'dump', side_effect=lambda path, value: dump(out / path.name, value)):
        probe.verify()
    raw_receipt = (out / 'receipt.json').read_bytes()
    receipt = decode_receipt(raw_receipt, job)
    assert receipt['verdict'] == 'PASS' and receipt_passed(receipt, job)
    assert [e['recipe'] for e in receipt['entries']] == ['triage-uniform6']
    assert receipt['selection'] == result['report'] and receipt['digests']['policy'] == ls.CERTIFICATION_POLICY
    assert str(ZID)[:6] not in raw_receipt.decode()


def test_replacing_a_fail_member_is_changed():
    bad = compare.structural_variants()['truncated-base-x']
    near = compare.fixture_variants()['near-tie']
    declared = compare.empty_output()
    sizes = {z: dict(zid=z, **metrics(raw_rows(4))) for z in (1, 2, 3)}
    before = {1: near, 2: bad}
    evidence = [compare.classify(z, *pair, declared) for z, pair in before.items()]
    s = spec(ls.triage_digest([ls.triage_member(z, p[1]) for z, p in before.items()]))
    _, same = triage.select(evidence, {z: p[1] for z, p in before.items()}, s, sizes)
    assert same['match'] == 'MATCH'
    after = {1: near, 3: bad}
    evidence = [compare.classify(z, *pair, declared) for z, pair in after.items()]
    _, replaced = triage.select(evidence, {z: p[1] for z, p in after.items()}, s, sizes)
    assert replaced['match'] == 'CHANGED' and replaced['battery_count'] == 2


def test_malformed_members_have_an_explicit_representation():
    assert ls.triage_member(5, {}) == [5, 'ABSENT', 'ABSENT']
    assert ls.triage_member(5, 'x') == [5, 'MALFORMED', 'MALFORMED']
    assert ls.triage_member(5, {'lastVoteTimestamp': -1, 'lastModTimestamp': None}) == [5, 'MALFORMED', None]
    assert ls.triage_digest([[5, 'ABSENT', None], [2, 7, 8]]) == ls.triage_digest([[2, 7, 8], [5, 'ABSENT', None]])
