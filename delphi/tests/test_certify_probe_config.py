"""Keep box capture opt-in while binding its exact config through extraction.

All payloads are generated public fixtures; no database or engines are started.
"""
import hashlib
import os
from pathlib import Path
import shutil
import sys
from unittest.mock import MagicMock

import pytest

from polismath.replay import fixture_config as fc, fixture_extract as fx
from polismath.replay.fixture_selection import SelectionError
from tests.test_certify_bundle import _generate, _manifest
from tests import test_representative_payloads as fixtures

ROOT = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(ROOT / 'ci/private_cert/images'))
import probe

PROBE_SHA256 = '396e19f1007d35eaeaa0414b690b1c18c2f03a5c324c9dbe78e06289db1f7efe'


def test_public_default_builds_manifest_without_representative_report(tmp_path):
    config = fc.load_config()
    payload, generated = _generate(config, tmp_path)
    manifest = _manifest(config, payload, generated_summaries=generated)
    assert 'representative' not in manifest
    assert fc.served_math_options(config) == fc.SERVED_MATH_OFF
    assert manifest['commits']['config_sha256'] == hashlib.sha256(
        fc.DEFAULT_CONFIG_PATH.read_bytes()).hexdigest()


def test_probe_config_requires_representative_report(tmp_path):
    config = fc.load_config(probe.PROBE_CONFIG_PATH)
    payload, generated = _generate(config, tmp_path)
    with pytest.raises(SelectionError, match='REPORT_FIELDS'):
        _manifest(config, payload, generated_summaries=generated,
                  config_bytes=probe.PROBE_CONFIG_PATH.read_bytes())


def test_box_extract_binds_probe_bytes_through_plan_and_verifier(tmp_path, monkeypatch):
    import psycopg2

    config = fc.load_config(probe.PROBE_CONFIG_PATH)
    monkeypatch.setattr(fixtures, 'configured', lambda: config)
    monkeypatch.setattr(fixtures, 'SEED', fc.representative_seed(config))
    source, _, manifest = fixtures.bundle(tmp_path / 'source', monkeypatch)
    output = tmp_path / 'output'
    output.mkdir()
    image_recipe = tmp_path / 'recipe.json'
    probe.gate.dump(image_recipe, dict(sourceCommit='a' * 40, candidateSha='c' * 40,
                                     oracleSha='d' * 40, policySha256=probe.gate.sha(probe.gate.POLICY)))
    # Redirect only the two container mounts; all fixture/plan code stays real.
    mounts = {'/output': output, '/opt/polis-private-image/recipe.json': image_recipe}
    monkeypatch.setattr(probe, 'Path', lambda value: mounts.get(str(value), Path(value)))
    monkeypatch.setenv('POLIS_REPLAY_INPUT_MAP', '')
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value.fetchone.return_value = (False, 'on')
    connect = MagicMock(return_value=conn)
    monkeypatch.setattr(psycopg2, 'connect', connect)

    def extract_snapshot(actual_conn, *, config, payload_root, guard_root, accept_public_fixture=()):
        assert actual_conn is conn and guard_root == output
        # the reader forwards exactly the config's recorded approvals (none in v2)
        assert tuple(accept_public_fixture) == tuple(config.get('accepted_public_fixture_replacements', ()))
        assert config['config_version'] == 'v2-probe-capture-sample-1'
        assert fc.served_math_options(config) == fc.ServedMathOptions(True, None)
        assert config == fc.load_config(probe.PROBE_CONFIG_PATH)
        shutil.copytree(source / 'payload', payload_root, dirs_exist_ok=True)
        return dict(roles=manifest['roles'], generated=manifest['generated']['cases'],
                    transaction_guarantee=manifest['transaction_guarantee'], tie_key=fixtures.TIE,
                    representative_selection=manifest['representative']['report'])

    monkeypatch.setattr(fx, 'extract_from_config', extract_snapshot)
    probe.extract()
    connect.assert_called_once_with(service='probe')
    conn.close.assert_called_once_with()
    fixture = output / '.local/fixture'
    assert (fixture / 'config.json').read_bytes() == probe.PROBE_CONFIG_PATH.read_bytes()
    assert probe.gate.read(fixture / 'manifest.json')['commits']['config_sha256'] == PROBE_SHA256
    plan = probe.gate.read(fixture / 'plan.json')
    assert plan['configSha256'] == PROBE_SHA256
    assert len(plan['entries']) == 34
    inputs = probe.gate.read(output / 'inputs.json')
    scratch = tmp_path / 'verify'
    scratch.mkdir()
    prepared, inventory = probe.gate.prepare(fixture, inputs, scratch)
    assert len(prepared) == 34
    assert all(row['configSha256'] == PROBE_SHA256 for row in inventory)
    # Even a semantically equivalent edit breaks the admitted byte binding.
    with (fixture / 'config.json').open('ab') as stream:
        stream.write(b'\n')
    with pytest.raises(ValueError, match='BUNDLE_METADATA_BINDING'):
        probe.gate.prepare(fixture, inputs, scratch)
