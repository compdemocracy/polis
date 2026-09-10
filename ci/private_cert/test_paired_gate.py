"""Gate intake controls. Requires the lossless-ingress change in the source tree.

The existing bundle test factory makes explicitly synthetic role metadata; no
private data or engine run is part of these intake tests. Public CSVs are the
committed fixtures and are verified against the independent source copy.
"""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent / 'images'))
import gate
from polismath.replay import fixture_config, fixture_bundle
from tests.test_certify_bundle import _generate, _manifest


class PairedGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.old_mapping = os.environ.pop('POLIS_REPLAY_INPUT_MAP', None)
        self.addCleanup(self.restore_mapping)
        config = fixture_config.load_config()
        payload, summaries = _generate(config, self.root)
        self.fixture = payload.parent
        manifest = _manifest(config, payload, generated_summaries=summaries)
        self.entries = [e for e in gate.certify.load_battery() if e.dataset in {'vw', 'biodiversity'}]
        plan_entries = []
        import shutil
        for alias in {'vw', 'biodiversity'}:
            source = gate.real_data.dataset_dir(alias)
            dest = payload / ('public-' + alias)
            dest.mkdir()
            for pattern in ('*-votes.csv', '*-comments.csv'):
                for f in source.glob(pattern):
                    shutil.copyfile(f, dest / f.name)
        for e in self.entries:
            expected = gate.certify.prepare_entry(e)
            plan_entries.append({'dataset': e.dataset, 'schedule_id': e.schedule_id,
                                 'role': next(x['role'] for x in config['public_fixtures'] if x['slug'] == e.dataset),
                                 'directory': 'public-' + e.dataset, 'schedule': expected.spec.to_dict()})
        manifest['files'] = fixture_bundle.scan_files(payload)
        manifest['root_digest'] = fixture_bundle.root_digest(manifest['files'])
        (self.fixture / 'config.json').write_bytes(fixture_config.DEFAULT_CONFIG_PATH.read_bytes())
        gate.dump(self.fixture / 'manifest.json', manifest)
        self.plan = {'schema': 'polis-private-paired-plan/1', 'scope': 'public',
                     'manifestSha256': gate.file_digest(self.fixture / 'manifest.json'),
                     'configSha256': gate.file_digest(self.fixture / 'config.json'), 'entries': plan_entries}
        gate.dump(self.fixture / 'plan.json', self.plan)
        self.inputs = dict(candidateSha='c'*40, oracleSha='d'*40, policySha256=gate.sha(gate.POLICY),
                           scheduleSha256='', inventorySha256='', expectedChecks=0)
        scratch = self.root / 'derive'
        scratch.mkdir()
        prepared, inventory = gate.prepare(self.fixture, self.inputs, scratch, bind=False)
        self.inputs.update(scheduleSha256=gate.sha([p.spec.to_dict() for p in prepared]),
                           inventorySha256=gate.sha(inventory), expectedChecks=sum(len(p.checkpoints) for p in prepared))

    def restore_mapping(self):
        os.environ.pop('POLIS_REPLAY_INPUT_MAP', None)
        if self.old_mapping is not None:
            os.environ['POLIS_REPLAY_INPUT_MAP'] = self.old_mapping

    def run_prepare(self, inputs=None):
        scratch = self.root / 'verify'
        scratch.mkdir()
        return gate.prepare(self.fixture, inputs or self.inputs, scratch)

    def write_plan(self):
        (self.fixture / 'plan.json').write_bytes(gate.encoded(self.plan))

    def test_complete_public_fixture_inventory(self):
        prepared, inventory = self.run_prepare()
        self.assertEqual(len(prepared), 6)
        self.assertEqual(self.inputs['expectedChecks'], 87)
        self.assertEqual(gate.sha(inventory), self.inputs['inventorySha256'])

    def test_producer_uses_separate_schedule_input_and_fresh_serial_engines(self):
        from unittest.mock import patch
        output = self.root / 'output'
        output.mkdir()
        input_path = self.root / 'inputs.json'
        gate.dump(input_path, self.inputs)
        engines = []
        def run(cmd, cwd, log):
            source = Path(cmd[cmd.index('--schedule') + 1])
            raw = source.read_bytes()
            self.assertTrue(raw)
            if cmd[0] == 'clojure':
                engines.append('clj')
                target = Path(cmd[cmd.index('--out') + 1]) / 'schedule.json'
                self.assertNotEqual(source, target)
                target.write_bytes(raw)
            else:
                engines.append('py')
                json.loads(raw)
            log.write_bytes(b'synthetic driver control')
            return 0
        with patch.object(gate, 'run_engine', side_effect=run):
            gate.produce(self.fixture, output, input_path)
        self.assertEqual(engines, ['clj', 'py'] * 6)
        self.assertEqual(len(gate.read(output / 'producer.json')['runs']), 12)
        with self.assertRaisesRegex(ValueError, 'FRESH_OUTPUT'):
            gate.produce(self.fixture, output, input_path)

    def test_wrong_policy_fails_before_execution(self):
        with self.assertRaisesRegex(ValueError, 'POLICY'):
            self.run_prepare({**self.inputs, 'policySha256': '0'*64})

    def test_wrong_input_inventory_fails(self):
        with self.assertRaisesRegex(ValueError, 'INVENTORY_BINDING'):
            self.run_prepare({**self.inputs, 'inventorySha256': '0'*64})

    def test_short_entry_inventory_fails(self):
        self.plan['entries'].pop()
        self.write_plan()
        with self.assertRaisesRegex(ValueError, 'INCOMPLETE_ENTRY'):
            self.run_prepare()

    def test_duplicate_entry_fails(self):
        self.plan['entries'].append(copy.deepcopy(self.plan['entries'][0]))
        self.write_plan()
        with self.assertRaisesRegex(ValueError, 'ENTRY_INVENTORY'):
            self.run_prepare()

    def test_role_substitution_fails(self):
        self.plan['entries'][0]['role'] = 'wrong'
        self.write_plan()
        with self.assertRaisesRegex(ValueError, 'ROLE_BINDING'):
            self.run_prepare()

    def test_short_checkpoint_schedule_fails(self):
        self.plan['entries'][0]['schedule']['cuts']['at'].pop(0)
        self.write_plan()
        with self.assertRaisesRegex(ValueError, 'CHECKPOINT_COUNT'):
            self.run_prepare()

    def test_restart_recipe_cannot_be_removed(self):
        row = next(r for r in self.plan['entries'] if 'restart' in r['schedule_id'])
        row['schedule']['restart_after'] = None
        self.write_plan()
        with self.assertRaisesRegex(ValueError, 'RECIPE_CHANGED'):
            self.run_prepare()

    def test_extra_fixture_file_fails(self):
        (self.fixture / 'extra').write_text('unlisted')
        with self.assertRaisesRegex(ValueError, 'EXTRA_FILES'):
            self.run_prepare()

    def test_corrupt_fixture_file_fails(self):
        csv = next((self.fixture / 'payload/public-vw').glob('*-votes.csv'))
        csv.write_bytes(csv.read_bytes()[:-1])
        with self.assertRaises(fixture_bundle.VerificationError):
            self.run_prepare()


if __name__ == '__main__':
    unittest.main()
