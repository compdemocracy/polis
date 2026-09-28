"""Producer lookup and fresh artifact comparison; no campaign/daemon started."""
import copy
import hashlib
import json
from pathlib import Path
import re
import sys

import pytest

CI = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CI))
import reproduce_pin as rp

REGISTRY = json.loads((CI / 'replay-pins.json').read_text())
LINUX = next(p for p in REGISTRY['pins'] if p['system'] == 'Linux')
KEY = {k: LINUX[k] for k in ('system', 'machine', 'forced_kernel')}


def fixture(tmp_path):
    digest = LINUX['checkpoints'][0]['rust']
    report = rp.locate(digest)
    targets = rp.select_targets(report, KEY)
    receipt = {'candidate_gate': 'PASS', 'replay_runtime': LINUX['attribution']['runtime'],
               'replay_pin': {'pin': {'id': LINUX['id']}}, 'artifact_sha256': {}}
    for target in targets:
        file = tmp_path / target['file']; file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps({'checkpoints': LINUX['checkpoints']}))
        receipt['artifact_sha256'][target['file']] = hashlib.sha256(file.read_bytes()).hexdigest()
    (tmp_path / 'receipt.json').write_text(json.dumps(receipt))
    return digest, report, receipt


def test_all_recorded_digest_literals_are_locatable():
    files = [CI / 'replay-pins.json', *sorted((CI.parent / 'evidence').glob('*.json'))]
    values = {m for f in files for m in re.findall(r'(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])', f.read_text())}
    for value in values:
        assert rp.locate(value)['locations'], value


def test_hosted_checkpoint_has_exact_producer_platform_and_input_contract(tmp_path):
    report = rp.locate(LINUX['checkpoints'][0]['rust'])
    target = rp.select_targets(report, KEY)[0]
    assert target['file'] == 'artifacts/vw-equivalence.json'
    assert target['path'] == ['checkpoints', 0, 'rust']
    assert report['job'] == 'coordinator-required'
    assert report['command'][:2] == ['python', 'coordinator-rs/ci/run.py']
    assert report['origins'][0]['attribution']['source_head']
    ci = tmp_path / 'coordinator-rs/ci'; ci.mkdir(parents=True)
    (ci / 'replay-pins.json').write_text(json.dumps(REGISTRY))
    evidence = ci.parent / 'evidence'; evidence.mkdir()
    digest = LINUX['checkpoints'][0]['rust']
    (evidence / 'polarity-vw.json').write_text(json.dumps({'a': digest}))
    (evidence / 'vw-equivalence.json').write_text(json.dumps({'checkpoints': [{'python': digest}]}))
    scoped = rp.locate(digest, root=tmp_path)
    unrelated = next(x for x in scoped['locations'] if x['file'].endswith('polarity-vw.json'))
    paired = next(x for x in scoped['locations'] if x['file'].endswith('vw-equivalence.json'))
    assert unrelated['classification'] == 'BLOCKED'
    assert paired['classification'] == 'REGISTRY_TARGET'


def test_retired_key_is_never_automatically_selected():
    pin = REGISTRY['retired_pins'][0]
    report = rp.locate(pin['checkpoints'][0]['rust'])
    key = {k: pin[k] for k in ('system', 'machine', 'forced_kernel')}
    assert rp.select_targets(report, key) == []


def test_empty_clock_hash_is_observation_not_deterministic_replay():
    """The committed empty contract is reproduced exactly, like every other D4 witness."""
    witness = LINUX['witnesses']['d4-node-reader-empty.json']
    digest = witness['served']['python']['asJSON_sha256']
    assert witness['served']['rustproto']['asJSON_sha256'] == digest
    assert witness['served']['python']['last_vote_timestamp'] == 0
    report = rp.locate(digest)
    targets = rp.select_targets(report, KEY)
    assert targets and all(t['file'] == 'fresh-evidence/d4-node-reader-empty.json' for t in targets)
    assert ['served', 'python', 'asJSON_sha256'] in [t.get('path') for t in targets]
    assert all(x['classification'] == 'REGISTRY_TARGET' for x in report['locations']
               if x['file'].endswith('evidence/d4-node-reader-empty.json'))
    whole = rp.locate(LINUX['witness_sha256']['d4-node-reader-empty.json'])
    assert {'file': 'fresh-evidence/d4-node-reader-empty.json', 'hash_file': True} in [
        {'file': t['file'], 'hash_file': t.get('hash_file')} for t in rp.select_targets(whole, KEY)]


def test_attribution_receipt_hash_is_not_claimed_as_replay_output():
    report = rp.locate(LINUX['attribution']['receipt_sha256'])
    assert not report['targets']
    assert rp.execute(report, None)['status'] == 'EVIDENCE_ONLY'


def test_actual_artifact_match_and_changed_value_mismatch(tmp_path):
    digest, report, receipt = fixture(tmp_path)
    assert rp.compare(report, tmp_path, KEY)['status'] == 'MATCH'
    target = rp.select_targets(report, KEY)[0]
    file = tmp_path / target['file']; data = json.loads(file.read_text())
    data['checkpoints'][0]['rust'] = '0' * 64; file.write_text(json.dumps(data))
    receipt['artifact_sha256'][target['file']] = hashlib.sha256(file.read_bytes()).hexdigest()
    (tmp_path / 'receipt.json').write_text(json.dumps(receipt))
    assert rp.compare(report, tmp_path, KEY)['status'] == 'MISMATCH'


def test_tampered_artifact_does_not_pass_receipt_binding(tmp_path):
    _, report, _ = fixture(tmp_path)
    file = tmp_path / rp.select_targets(report, KEY)[0]['file']
    file.write_text(file.read_text() + ' ')
    with pytest.raises(ValueError, match='ARTIFACT_RECEIPT_MISMATCH'):
        rp.compare(report, tmp_path, KEY)


def test_failed_campaign_is_not_a_match(tmp_path):
    _, report, receipt = fixture(tmp_path)
    receipt['candidate_gate'] = 'FAIL'
    (tmp_path / 'receipt.json').write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match='CAMPAIGN_NOT_PASS'):
        rp.compare(report, tmp_path, KEY)


def test_wrong_runtime_and_forged_kernel_refuse(tmp_path):
    _, report, receipt = fixture(tmp_path)
    receipt = copy.deepcopy(receipt)
    receipt['replay_runtime']['forced_kernel'] = 'not-forced'
    (tmp_path / 'receipt.json').write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match='RECEIPT_PLATFORM_MISMATCH'):
        rp.compare(report, tmp_path, KEY)
    receipt['replay_runtime']['forced_kernel'] = 'Haswell'
    receipt['replay_runtime']['blas'][0]['architecture'] = 'Cooperlake'
    (tmp_path / 'receipt.json').write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match='REPLAY_KERNEL_NOT_HONOURED'):
        rp.compare(report, tmp_path, KEY)


def test_other_platform_does_not_start_campaign(monkeypatch, tmp_path):
    report = rp.locate(LINUX['checkpoints'][0]['rust'])
    monkeypatch.setattr(rp, 'local_key', lambda: dict(system='Other', machine='Other', forced_kernel='not-forced'))
    monkeypatch.setattr(rp.subprocess, 'run', lambda *a, **k: pytest.fail('must not execute'))
    assert rp.execute(report, None)['status'] == 'NOT_ON_THIS_PLATFORM'
    monkeypatch.setattr(rp, 'local_key', lambda: KEY)
    assert rp.execute(report, None)['status'] == 'NOT_RUN'
    from types import SimpleNamespace
    monkeypatch.setattr(rp.subprocess, 'run', lambda *a, **k: SimpleNamespace(returncode=1))
    assert rp.execute(report, tmp_path / 'new')['status'] == 'CAMPAIGN_FAILED'


def test_symlinked_artifact_refused(tmp_path):
    _, report, _ = fixture(tmp_path)
    file = tmp_path / rp.select_targets(report, KEY)[0]['file']
    other = file.with_suffix('.other'); file.rename(other); file.symlink_to(other)
    with pytest.raises(ValueError, match='ARTIFACT_PATH_REFUSED'):
        rp.compare(report, tmp_path, KEY)


def test_plan_does_not_execute_and_invalid_digest_refuses(monkeypatch, capsys):
    monkeypatch.setattr(rp.subprocess, 'run', lambda *a, **k: pytest.fail('must not execute'))
    assert rp.main([LINUX['checkpoints'][0]['rust'], '--plan']) == 0
    assert json.loads(capsys.readouterr().out)['result']['scope'] == 'plan only'
    assert rp.main(['not-a-digest']) == 2
    assert json.loads(capsys.readouterr().out)['reason'] == 'DIGEST_INVALID'


def test_every_enforced_closure_digest_has_source_preimage_target():
    for name in rp.SOURCE_CLOSURES:
        closure = json.loads((CI.parent / 'evidence' / name).read_text())
        for relative, digest in closure['sha256'].items():
            report = rp.locate(digest)
            assert {'file': relative, 'hash_file': True} in report['source_targets']
            assert any(x.get('enforced_by_campaign') for x in report['locations'])


def test_current_source_bytes_match_and_drift_is_mismatch(tmp_path):
    file = tmp_path / 'source.txt'; file.write_bytes(b'public fixture')
    report = {'digest': hashlib.sha256(file.read_bytes()).hexdigest(),
              'source_targets': [{'file': 'source.txt', 'hash_file': True}], 'targets': []}
    result = rp.execute(report, None, root=tmp_path)
    assert result['status'] == 'MATCH'
    report['locations'] = []
    pending = {'file': 'artifacts/other.json', 'path': ['value'], 'pin': LINUX['id'],
               'active': True, 'platform_key': KEY}
    report['targets'] = [pending]
    remaining = rp.coverage(report, result, KEY)
    assert remaining['remaining_selected_platform_campaign_targets'] == [pending]
    assert remaining['complete_for_selected_platform'] is False
    file.write_bytes(b'changed fixture')
    assert rp.execute(report, None, root=tmp_path)['status'] == 'MISMATCH'
    file.unlink()
    assert rp.execute(report, None, root=tmp_path)['status'] == 'BLOCKED'


def test_public_export_preimages_match_and_absence_blocks(tmp_path):
    admission = json.loads((CI.parent / 'evidence/admission.json').read_text())
    for slug in ('vw', 'biodiversity'):
        report = rp.locate(admission['input_fixtures'][slug]['sha256'])
        assert report['source_targets'] == [{'fixture_slug': slug, 'hash_file': True}]
        assert rp.execute(report, None)['status'] == 'MATCH'
        assert rp.execute(report, None, root=tmp_path)['status'] == 'BLOCKED'


def test_fresh_stage_digests_have_explicit_diagnostic_producer_targets(tmp_path):
    stage = json.loads((CI.parent / 'evidence/stage-inventory.json').read_text())
    digest = stage['stages'][0]['evidence']['ack']['context']['source_fingerprint']
    report = rp.locate(digest)
    targets = rp.select_targets(report, KEY)
    assert targets and all(t['file'] == 'fresh-evidence/stage-inventory.json' for t in targets)
    assert all(t['diagnostic_only'] is True for t in targets)
    assert any(x.get('classification') == 'FRESH_DIAGNOSTIC' for x in report['locations'])
    _, control, _ = fixture(tmp_path)
    for target in control['targets']:
        target['diagnostic_only'] = True
    result = rp.compare(control, tmp_path, KEY)
    assert result['status'] == 'MATCH' and 'not a campaign gate result' in result['scope']


def test_historical_run_hash_has_specific_non_gate_rationale():
    admission = json.loads((CI.parent / 'evidence/admission.json').read_text())
    report = rp.locate(next(iter(admission['binaries'].values())))
    assert not report['source_targets'] and not report['targets']
    assert rp.execute(report, None)['status'] == 'EVIDENCE_ONLY'
    assert any('IGNORED_PREFIXES' in x.get('basis', '') for x in report['locations'])
