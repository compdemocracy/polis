"""Gate intake controls. Requires the lossless-ingress change in the source tree.

The existing bundle test factory makes explicitly public-fixture role metadata; no
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
        self.assertTrue(all('legacy_defects' not in item for item in inventory))

    def test_empty_contract_cannot_be_added_to_committed_recipe(self):
        self.plan['entries'][0]['schedule']['empty_output'] = {'n': 0}
        self.write_plan()
        with self.assertRaisesRegex(ValueError, 'RECIPE_CHANGED'):
            self.run_prepare()

    def test_legacy_omission_cannot_be_added_to_committed_recipe(self):
        self.plan['entries'][0]['schedule']['empty_output'] = {'n': 0}
        self.plan['entries'][0]['schedule']['legacy_absent_keys'] = ['n']
        self.plan['entries'][0]['schedule']['cuts']['empty_checkpoint'] = True
        self.plan['entries'][0]['schedule']['cuts']['at'].insert(0, 0)
        self.write_plan()
        with self.assertRaisesRegex(ValueError, 'RECIPE_CHANGED'):
            self.run_prepare()

    def test_moderation_omission_cannot_be_added_to_committed_recipe(self):
        spec = self.plan['entries'][0]['schedule']
        spec['empty_output'] = {'n': 0}
        spec['legacy_absent_moderation'] = ['mod-in', 'mod-out']
        spec['cuts']['empty_checkpoint'] = True
        spec['cuts']['at'].insert(0, 0)
        self.write_plan()
        with self.assertRaisesRegex(ValueError, 'RECIPE_CHANGED'):
            self.run_prepare()

    def test_empty_output_contract_cannot_be_added_to_committed_recipe(self):
        spec = self.plan['entries'][0]['schedule']
        spec['empty_output'] = {'lastVoteTimestamp': 0}
        spec['cuts']['empty_checkpoint'] = True
        spec['cuts']['at'].insert(0, 0)
        self.write_plan()
        with self.assertRaisesRegex(ValueError, 'RECIPE_CHANGED'):
            self.run_prepare()

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
            log.write_bytes(b'public-fixture driver control')
            return 0
        with patch.object(gate, 'run_engine', side_effect=run):
            gate.produce(self.fixture, output, input_path)
        self.assertEqual(engines, ['clj', 'py'] * 6)
        self.assertEqual(len(gate.read(output / 'producer.json')['runs']), 12)
        self.assertFalse((output / 'fixture').exists())
        self.assertFalse(any(p.name == 'events.jsonl' for p in output.rglob('*')))
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


class EmptyOutputGateTests(unittest.TestCase):
    """Real raw validators, strict comparer and G12 over small public recordings."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.recordings = self.root / 'recordings'
        self.scratch = self.root / 'scratch'
        self.scratch.mkdir()
        spec = gate.schedule.ScheduleSpec.from_json_file(
            gate.REPO / 'delphi/scripts/schedules/pc-zerovote-01-empty.json')
        self.checkpoint = {'index': 0, 'prev_slot': 0, 'cut_slot': 0,
                           'batch_size': 0, 'cut_time_ms': 0}
        self.expected = gate.certify.ExpectedEntry(
            gate.certify.BatteryEntry(spec.dataset, spec.schedule_id), spec,
            self.root / 'public-events.jsonl', 'a' * 64, None, None, 0,
            [self.checkpoint])
        self.rec = gate.store.recording_dir(spec.dataset, spec.schedule_id,
                                           root=self.recordings)
        (self.rec / 'clj').mkdir(parents=True)
        (self.rec / 'py').mkdir()
        self.clj = {'pca': {'comps': [[1.0], [1.0]]}, 'lastVoteTimestamp': 0}
        self.py = {'pca': {'comps': [[1.0], [1.0]]}, 'mod-in': [], 'mod-out': []}
        for key, value in spec.empty_output.items():
            if key.startswith('pca.'):
                self.py['pca'][key.split('.')[1]] = value
            else:
                self.py[key] = value
        self.write()

    def write(self):
        (self.rec / 'schedule.json').write_bytes(gate.encoded(self.expected.spec.to_dict()))
        (self.rec / 'clj/step-000.blob.json').write_bytes(gate.encoded(self.clj))
        (self.rec / 'clj/step-000.meta.json').write_bytes(gate.encoded(self.checkpoint))
        (self.rec / 'py/step-000.json').write_bytes(
            gate.encoded({**self.checkpoint, 'blob': self.py}))

    def test_declared_empty_omission_is_named_and_raw_bytes_stay_unchanged(self):
        before = gate.regular_tree(self.recordings)
        result = gate.verify_pairs([self.expected], self.recordings, Path(tempfile.mkdtemp(dir=self.root)))
        self.assertEqual(result['verdict'], 'PASS')
        defect = [{'name': 'legacy-defect-empty-omits-keys',
                  'keys': sorted(self.expected.spec.legacy_absent_keys + self.expected.spec.legacy_absent_moderation), 'checkpoints': [0]}]
        self.assertEqual(result['entries'][0]['legacy_defects'], defect)
        self.assertTrue(result['entries'][0]['g12']['authoritative_g12'])
        self.assertIn('unnormalized', result['entries'][0]['g12']['legacy_diagnostic']['note'])
        inventory = gate.recording_inventory(
            [self.expected], {'manifestSha256': 'b' * 64, 'configSha256': 'c' * 64})
        self.assertEqual(inventory[0]['legacy_defects'], defect)
        self.assertEqual(gate.regular_tree(self.recordings), before)

    def test_undeclared_absence_fails_both_authoritative_paths(self):
        from dataclasses import replace
        self.expected = replace(self.expected,
                                spec=replace(self.expected.spec, legacy_absent_keys=[]))
        self.write()
        self.assert_refused()

    def test_wrong_present_legacy_value_fails_both_authoritative_paths(self):
        self.clj['n'] = 1
        self.write()
        self.assert_refused()

    def test_missing_python_value_fails_both_authoritative_paths(self):
        self.py.pop('n')
        self.write()
        self.assert_refused()

    def test_wrong_present_python_value_fails_both_authoritative_paths(self):
        self.py['n'] = 1
        self.write()
        self.assert_refused()

    def test_omission_at_nonzero_cut_fails_both_authoritative_paths(self):
        self.checkpoint['cut_slot'] = 1
        self.checkpoint['batch_size'] = 1
        self.write()
        self.assert_refused()

    def test_every_empty_contract_value_is_exact_for_both_engines(self):
        import copy
        original_clj, original_py = copy.deepcopy(self.clj), copy.deepcopy(self.py)
        for engine in ('clj', 'py'):
            for key in self.expected.spec.empty_output:
                with self.subTest(engine=engine, key=key):
                    self.clj, self.py = copy.deepcopy(original_clj), copy.deepcopy(original_py)
                    blob = self.clj if engine == 'clj' else self.py
                    node, leaf = (blob['pca'], key.split('.')[1]) if key.startswith('pca.') else (blob, key)
                    node[leaf] = 9 if key in ('n', 'n-cmts', 'lastVoteTimestamp') else 'wrong'
                    self.write()
                    self.assert_refused()

    def test_pca_declared_values_remain_exact_inside_numeric_tolerance(self):
        import copy
        original_clj, original_py = copy.deepcopy(self.clj), copy.deepcopy(self.py)
        for engine in ('clj', 'py'):
            for key in gate.schedule.EMPTY_PCA_PATHS:
                with self.subTest(engine=engine, key=key):
                    self.clj, self.py = copy.deepcopy(original_clj), copy.deepcopy(original_py)
                    blob = self.clj if engine == 'clj' else self.py
                    leaf = key.split('.')[1]
                    value = copy.deepcopy(self.expected.spec.empty_output[key])
                    # The committed contract declares empty PCA leaves; a value
                    # within numeric tolerance of "nothing" is still not nothing.
                    if leaf == 'comment-projection':
                        if value and value[0]:
                            value[0][0] += 1e-10
                        else:
                            value = [[1e-10], [1e-10]]
                    elif value:
                        value[0] += 1e-10
                    else:
                        value = [1e-10]
                    blob['pca'][leaf] = value
                    self.write()
                    with self.assertRaises(gate.certify.CertifyError) as caught:
                        gate.verify_pairs([self.expected], self.recordings, Path(tempfile.mkdtemp(dir=self.root)))
                    self.assertEqual(caught.exception.stage, 'empty-output')
                    with self.assertRaises(gate.certify.CertifyError) as caught:
                        gate.g12.measure_main_blob(self.rec, gate.REPO / 'delphi', expected=self.expected)
                    self.assertEqual(caught.exception.stage, 'empty-output')

    def test_differing_present_timestamp_is_refused_like_any_other_empty_value(self):
        # The replay driver floors an empty conversation's clock to 0, so the
        # declared empty_output is 0 for both engines and lastVoteTimestamp has
        # no reconciliation of its own: a legacy 0 / Python 1 pair is simply a
        # present value that does not satisfy the contract.
        self.assertEqual(self.expected.spec.empty_output['lastVoteTimestamp'], 0)
        self.assertEqual(self.checkpoint['cut_slot'], 0)
        self.assertNotIn('lastVoteTimestamp', self.expected.spec.legacy_absent_keys)
        self.clj['lastVoteTimestamp'], self.py['lastVoteTimestamp'] = 0, 1
        self.write()
        self.assert_refused()

    def test_each_nested_omission_requires_its_own_declaration(self):
        from dataclasses import replace
        original = self.expected
        for key in gate.schedule.EMPTY_PCA_PATHS:
            with self.subTest(key=key):
                self.expected = replace(original, spec=replace(original.spec,
                    legacy_absent_keys=[k for k in original.spec.legacy_absent_keys if k != key]))
                self.write()
                self.assert_refused()

    def test_missing_pca_parent_and_changed_comps_are_never_reconciled(self):
        self.clj.pop('pca')
        self.write()
        self.assert_refused()
        self.clj['pca'] = {'comps': [[1.0], [1.0]]}
        self.py['pca']['comps'] = [[1.0], [2.0]]
        self.write()
        result = gate.verify_pairs([self.expected], self.recordings, Path(tempfile.mkdtemp(dir=self.root)))
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertFalse(result['entries'][0]['g12']['authoritative_g12'])

    def test_moderation_omitted_or_emitted_with_and_without_moderated_comments(self):
        for lists in (([], []), ([2, 7], [3, 8])):
            for omitted in ([], ['mod-in'], ['mod-out'], ['mod-in', 'mod-out']):
                with self.subTest(lists=lists, omitted=omitted):
                    self.py.update(dict(zip(['mod-in', 'mod-out'], lists)))
                    self.clj = copy.deepcopy(self.py)
                    for key in omitted:
                        self.clj.pop(key)
                    self.write()
                    before = gate.regular_tree(self.recordings)
                    result = gate.verify_pairs([self.expected], self.recordings, Path(tempfile.mkdtemp(dir=self.root)))
                    self.assertEqual(result['verdict'], 'PASS')
                    self.assertTrue(result['entries'][0]['g12']['authoritative_g12'])
                    observed = result['entries'][0]['strict']['per_step'][0].get('legacy_defects', [])
                    self.assertEqual(observed, ([{'name': 'legacy-defect-empty-omits-keys',
                        'keys': omitted}] if omitted else []))
                    self.assertEqual(gate.regular_tree(self.recordings), before)

    def test_moderation_present_difference_and_null_are_not_reconciled(self):
        self.py.update({'mod-in': [2], 'mod-out': []})
        for wrong in ([3], [], None):
            with self.subTest(wrong=wrong):
                self.clj = copy.deepcopy(self.py)
                self.clj['mod-in'] = wrong
                self.write()
                if wrong is None:
                    self.assert_refused()
                else:
                    result = gate.verify_pairs([self.expected], self.recordings, Path(tempfile.mkdtemp(dir=self.root)))
                    self.assertEqual(result['verdict'], 'FAIL')
                    self.assertFalse(result['entries'][0]['g12']['authoritative_g12'])

    def test_dynamic_omission_requires_declaration_and_zero_cut(self):
        from dataclasses import replace
        self.clj = copy.deepcopy(self.py)
        self.clj.pop('mod-in')
        original = self.expected
        self.expected = replace(original, spec=replace(original.spec, legacy_absent_moderation=[]))
        self.write()
        self.assertEqual(gate.verify_pairs([self.expected], self.recordings, Path(tempfile.mkdtemp(dir=self.root)))['verdict'], 'FAIL')
        self.expected = original
        self.checkpoint.update(cut_slot=1, batch_size=1)
        self.write()
        result = gate.verify_pairs([self.expected], self.recordings, Path(tempfile.mkdtemp(dir=self.root)))
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertFalse(result['entries'][0]['g12']['authoritative_g12'])

    def test_python_moderation_must_be_lists_even_if_both_engines_omit_or_null(self):
        for bad in (None, 'missing', [True], [1.5]):
            with self.subTest(bad=bad):
                self.py['mod-in'] = bad
                if bad == 'missing':
                    self.py.pop('mod-in')
                self.clj = copy.deepcopy(self.py)
                self.write()
                self.assert_refused()

    def assert_refused(self):
        with self.assertRaises(gate.certify.CertifyError):
            gate.verify_pairs([self.expected], self.recordings, Path(tempfile.mkdtemp(dir=self.root)))
        with self.assertRaises(gate.certify.CertifyError):
            gate.g12.measure_main_blob(self.rec, gate.REPO / 'delphi', expected=self.expected)


if __name__ == '__main__':
    unittest.main()
