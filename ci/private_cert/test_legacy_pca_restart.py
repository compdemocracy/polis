"""Observed legacy restarts classify only their forward dependency closure."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent / 'images'))
import gate
import probe
from polismath.replay import legacy_pca


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.recordings = self.root / 'recordings'
        self.spec = gate.schedule.preset_uniform('pc-revote-02', 3, n_cuts=3,
                                                schedule_id='uniform6-clojure-legacy')
        self.checkpoints = [dict(index=i, prev_slot=i, cut_slot=i+1, batch_size=1,
                                 cut_time_ms=i+1) for i in range(3)]
        self.expected = gate.certify.ExpectedEntry(
            gate.certify.BatteryEntry(self.spec.dataset, self.spec.schedule_id, role='revote-heavy'),
            self.spec, self.root / 'events.jsonl', 'a'*64, None, None, 3, self.checkpoints)
        self.rec = gate.store.recording_dir(self.spec.dataset, self.spec.schedule_id, root=self.recordings)
        self.blob = {
            'n': 3, 'n-cmts': 2, 'tids': [0, 1], 'in-conv': [0, 1, 2],
            'pca': {'comps': [[0., 0.], [0., 0.]], 'center': [0., 0.],
                    'comment-projection': [[1., 0.], [0., 1.]], 'comment-extremity': [1., 1.]},
            'base-clusters': {'id': [0], 'members': [[0, 1, 2]], 'count': [3], 'x': [0.], 'y': [0.]},
            'group-clusters': [{'id': 0, 'members': [0], 'center': [0., 0.]}],
            'votes-base': {'0': {'A': [1], 'D': [1], 'S': [3]}},
            'group-votes': {'0': {'votes': {'0': {'A': 1, 'D': 1, 'S': 3}}}},
            'repness': {'0': [{'tid': 0, 'p': 0.5}]}, 'group-aware-consensus': {'0': 0.5},
            'comment-priorities': {'0': 0.5}, 'consensus': {'0': 0.5},
            'user-vote-counts': {'0': 1}, 'mod-in': [], 'mod-out': [], 'meta-tids': [],
        }
        self.blobs = [copy.deepcopy(self.blob) for _ in range(3)]
        self.legacy_blobs = [copy.deepcopy(self.blob) for _ in range(3)]
        self.starts = [['nonzero-warm']*2, ['zero-fallback', 'nonzero-warm'], ['nonzero-warm']*2]
        self.write()

    def write(self):
        def write(path, value):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(gate.encoded(value))
        write(self.rec / 'schedule.json', self.spec.to_dict())
        for i, checkpoint in enumerate(self.checkpoints):
            write(self.rec / 'clj' / f'step-{i:03d}.meta.json', checkpoint)
            write(self.rec / 'clj' / f'step-{i:03d}.blob.json', self.legacy_blobs[i])
            write(self.rec / 'py' / f'step-{i:03d}.json', dict(checkpoint, blob=self.blobs[i]))
            for engine in ('clj', 'py'):
                doc = dict(schema='polis-replay-attribution/1', checkpoint=i,
                           pids=[], tids=[], fold='a'*64, rating_fold='a'*64,
                           starts=self.starts[i] if engine == 'clj' else ['zero-fallback']*2,
                           center=None, comps=None, comments=None, person=[], partitions=[])
                write(self.rec / (engine+'-attribution') / f'step-{i:03d}.json', doc)

    def verify(self, *, attribution=True, expected=None):
        scratch = Path(tempfile.mkdtemp(dir=self.root))
        return gate.verify_pairs(expected or [self.expected], self.recordings, scratch,
                                 attribution=attribution)

    def change(self, path, value, index=1):
        node = self.blobs[index]
        parts = path.split('.')
        for part in parts[:-1]:
            node = node[part]
        node[parts[-1]] = value

    def assert_result(self, verdict):
        self.write()
        report = self.verify()
        self.assertEqual(report['verdict'], verdict)
        return report

    def test_every_affected_field_is_accepted_only_from_observed_onset(self):
        changes = {
            'pca.comps': [[0.3, 0.4], [0.4, 0.3]],
            'pca.comment-projection': [[9., 9.], [9., 9.]], 'pca.comment-extremity': [9., 9.],
            'base-clusters': {'id': [4, 5], 'members': [[0], [1, 2]], 'count': [1, 2], 'x': [1., 2.], 'y': [2., 3.]},
            'group-clusters': [{'id': 4, 'members': [4, 5], 'center': [4., 5.]}],
            'votes-base': {'0': {'A': [9], 'D': [1], 'S': [10]}},
            'group-votes': {'4': {'votes': {'0': {'A': 9}}}},
            'repness': {'4': [{'tid': 1, 'p': 0.9}]}, 'group-aware-consensus': {'0': 0.9},
            'comment-priorities': {'0': 0.9},
        }
        self.assertEqual(set(changes), set(legacy_pca.PATHS))
        for path, value in changes.items():
            for index in range(3):
                with self.subTest(path=path, index=index):
                    self.blobs = [copy.deepcopy(self.blob) for _ in range(3)]
                    self.change(path, value, index)
                    report = self.assert_result('FAIL' if index == 0 else 'PASS')
                    entry = report['entries'][0]
                    self.assertNotIn('legacy_defects', entry['strict']['per_step'][0])
                    self.assertEqual(entry['strict']['per_step'][1]['legacy_defects'], [{'name': legacy_pca.NAME}])

    def test_unrelated_fields_still_fail(self):
        for path, value in {'pca.center': [8., 8.], 'consensus': {'0': 0.9}, 'n': 4,
                            'n-cmts': 4, 'tids': [0, 2], 'in-conv': [0, 1],
                            'mod-in': [1], 'mod-out': [1], 'meta-tids': [1],
                            'user-vote-counts': {'0': 2}}.items():
            with self.subTest(path=path):
                self.blobs = [copy.deepcopy(self.blob) for _ in range(3)]
                self.change('pca.comment-projection', [[9., 9.], [9., 9.]])
                self.change(path, value)
                self.assert_result('FAIL')

    def test_no_legacy_restart_is_a_negative_control_even_if_python_restarts(self):
        self.change('pca.comment-projection', [[9., 9.], [9., 9.]])
        for kind in ('nonzero-warm', 'padded-warm', 'not-computed'):
            with self.subTest(kind=kind):
                self.starts = [[kind]*2 for _ in range(3)]
                report = self.assert_result('FAIL')
                self.assertNotIn('legacy_defects', report['entries'][0])

    def test_both_components_and_missing_fallback_activate(self):
        self.change('pca.comment-projection', [[9., 9.], [9., 9.]])
        for kind in legacy_pca.STARTS:
            for component in range(2):
                with self.subTest(kind=kind, component=component):
                    self.starts[1] = ['nonzero-warm']*2
                    self.starts[1][component] = kind
                    if kind == 'missing-fallback':
                        self.legacy_blobs[0]['pca'] = {}
                        self.blobs[0]['pca'] = {}
                    else:
                        self.legacy_blobs[0] = copy.deepcopy(self.blob)
                        self.blobs[0] = copy.deepcopy(self.blob)
                    self.assert_result('PASS')

    def test_forged_restart_without_matching_previous_component_cannot_activate(self):
        self.blob['pca']['comps'] = [[1., 0.], [0., 1.]]
        self.legacy_blobs = [copy.deepcopy(self.blob) for _ in range(3)]
        self.blobs = [copy.deepcopy(self.blob) for _ in range(3)]
        self.change('pca.comment-projection', [[9., 9.], [9., 9.]])
        for kind in sorted(legacy_pca.STARTS):
            for axis in range(2):
                with self.subTest(kind=kind, axis=axis):
                    self.starts[1] = ['nonzero-warm']*2
                    self.starts[1][axis] = kind
                    report = self.assert_result('FAIL')
                    self.assertNotIn('legacy_defects', report['entries'][0])
                    self.assertEqual(report['entries'][0]['attribution'][1]['legacy_starts'][axis], 'unavailable')

    def test_cold_start_is_pinned_ones_and_cannot_establish_onset(self):
        self.starts = [['nonzero-warm']*2 for _ in range(3)]
        self.change('pca.comment-projection', [[9., 9.], [9., 9.]], index=0)
        for kind in sorted(legacy_pca.STARTS):
            with self.subTest(kind=kind):
                self.starts[0] = [kind]*2
                report = self.assert_result('FAIL')
                self.assertNotIn('legacy_defects', report['entries'][0])

    def test_bad_python_sidecar_cancels_corroborated_legacy_onset(self):
        self.change('pca.comment-projection', [[9., 9.], [9., 9.]])
        for fault in ('missing', 'malformed', 'orphan'):
            with self.subTest(fault=fault):
                self.write()
                path = self.rec/'py-attribution/step-001.json'
                if fault == 'missing': path.unlink()
                if fault == 'malformed': path.write_text('{}')
                if fault == 'orphan': (path.parent/'step-999.json').write_text('{}')
                report = self.verify()
                self.assertEqual(report['verdict'], 'FAIL')
                self.assertNotIn('legacy_defects', report['entries'][0])

    def test_strict_and_observer_checkpoint_counts_must_agree(self):
        with patch.object(gate.certify, 'compare_recording_pair', return_value={'per_step': []}):
            with self.assertRaisesRegex(ValueError, '^COMPARISON_CHECKPOINT_COUNT$'):
                self.verify()

    def test_observation_faults_cannot_grant_exception(self):
        import attribution
        self.change('pca.comment-projection', [[9., 9.], [9., 9.]])
        for fault in ('missing', 'malformed', 'orphan', 'measurement', 'disabled'):
            with self.subTest(fault=fault):
                self.write()
                path = self.rec / 'clj-attribution/step-001.json'
                if fault == 'missing': path.unlink()
                if fault == 'malformed': path.write_text('{}')
                if fault == 'orphan': (path.parent / 'step-999.json').write_text('{}')
                if fault == 'measurement':
                    with patch.object(attribution, 'measure_recording', side_effect=ValueError):
                        self.assertEqual(self.verify()['verdict'], 'FAIL')
                else:
                    self.assertEqual(self.verify(attribution=fault != 'disabled')['verdict'], 'FAIL')

    def test_malformed_affected_fields_and_missing_keys_remain_failures(self):
        for path, value in {'pca.comps': [[1.]], 'base-clusters': {'id': ['bad']},
                            'group-clusters': [{'id': True}], 'group-votes': {'0': 1.5}}.items():
            with self.subTest(path=path):
                self.blobs = [copy.deepcopy(self.blob) for _ in range(3)]
                self.change(path, value)
                self.write()
                try:
                    self.assertEqual(self.verify()['verdict'], 'FAIL')
                except gate.certify.CertifyError as exc:
                    self.assertEqual(exc.stage, 'checkpoint-schema')
        for key in legacy_pca.DOWNSTREAM_KEYS:
            self.blobs = [copy.deepcopy(self.blob) for _ in range(3)]
            del self.blobs[1][key]
            self.assert_result('FAIL')

    def test_unavailable_after_onset_keeps_entry_history(self):
        self.change('pca.comment-projection', [[9., 9.], [9., 9.]], index=2)
        self.write()
        (self.rec / 'clj-attribution/step-002.json').unlink()
        self.assertEqual(self.verify()['verdict'], 'PASS')

    def test_no_entry_leakage_or_cached_verdict_reuse(self):
        self.change('pca.comment-projection', [[9., 9.], [9., 9.]])
        self.write()
        scratch = self.root / 'shared-cache'
        for onset, match in ((1, True), (None, False), (2, False), (1, True)):
            strict = gate.certify.compare_recording_pair(self.rec/'clj', self.rec/'py',
                cache_root=scratch, expected=self.expected, legacy_restart_from=onset)
            self.assertEqual(strict['per_step'][1]['match'], match)
        import dataclasses, shutil
        spec = gate.schedule.ScheduleSpec.from_dict({**self.spec.to_dict(), 'dataset': 'pc-revote-03'})
        second = dataclasses.replace(self.expected, spec=spec,
            entry=dataclasses.replace(self.expected.entry, dataset=spec.dataset))
        rec = gate.store.recording_dir(spec.dataset, spec.schedule_id, root=self.recordings)
        shutil.copytree(self.rec, rec)
        (rec/'schedule.json').write_bytes(gate.encoded(spec.to_dict()))
        for path in (rec/'clj-attribution').glob('*.json'):
            doc = json.loads(path.read_text()); doc['starts'] = ['nonzero-warm']*2
            path.write_bytes(gate.encoded(doc))
        report = self.verify(expected=[self.expected, second])
        self.assertEqual([e['pass'] for e in report['entries']], [True, False])
        self.assertEqual(report['verdict'], 'FAIL')

    def test_full_observations_drive_onset_and_bounded_export_reserves_it(self):
        import attribution
        rows = [dict(attribution.unavailable(i), legacy_starts=['nonzero-warm']*2)
                for i in range(12)]
        rows[10]['legacy_starts'] = ['nonzero-warm', 'zero-fallback']
        self.assertEqual(legacy_pca.restart_checkpoint(rows), 10)
        entries = [{'pass': True, 'strict': {'per_step': [{'match': True}]*12},
                    'attribution': rows, 'diagnostics': []}]
        result = attribution.bounded(entries)[0]
        self.assertTrue(result['attribution_truncated'])
        self.assertEqual(len(result['attribution']), 8)
        self.assertIn(10, [row['checkpoint'] for row in result['attribution']])

    def test_nonfinite_affected_output_is_rejected_before_reconciliation(self):
        for value in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(value=value):
                self.blobs[1]['pca']['comps'][0][0] = value
                # Deliberately bypass encoded's JSON-finiteness guard to test intake.
                path = self.rec/'py/step-001.json'
                path.write_text(json.dumps(dict(self.checkpoints[1], blob=self.blobs[1])))
                with self.assertRaises(gate.certify.CertifyError):
                    self.verify()

    def test_previous_policy_is_refused_and_helper_is_in_image_closure(self):
        import recipe
        previous = copy.deepcopy(gate.POLICY)
        previous.pop('legacy_pca_restart')
        inputs = dict.fromkeys(gate.INPUT_KEYS, '')
        inputs['policySha256'] = gate.sha(previous)
        with self.assertRaisesRegex(ValueError, 'PAIRED_POLICY_BINDING'):
            gate.prepare(self.root, inputs, self.root)
        self.assertIn('delphi/polismath/replay/legacy_pca.py', recipe.source_files(gate.REPO))

    def test_receipt_export_and_both_decoders_preserve_named_defect(self):
        import worker, run
        from contracts import validate_job
        self.change('pca.comment-projection', [[9., 9.], [9., 9.]])
        report = self.assert_result('PASS')
        before = gate.regular_tree(self.recordings)
        job = validate_job(dict(schema='polis-probe-job/1', run_id='a'*32, max_seconds=3600,
            producer={'image':'localhost/producer@sha256:'+'1'*64,'args':['produce']},
            verifier={'image':'localhost/verifier@sha256:'+'2'*64,'args':['verify']}))
        inputs = {'policySha256':gate.sha(gate.POLICY)}
        read, dump = gate.read, gate.dump
        def read_input(path):
            values = {'/job/job.json':job, '/run-spec/inputs.json':inputs,
                      '/fixture/manifest.json':{}, '/fixture/plan.json':{'scope':'public'}}
            return values[str(path)] if str(path) in values else read(path)
        with patch.object(gate,'read',side_effect=read_input), \
             patch.object(gate,'verify_recordings',return_value=report), \
             patch.object(gate,'regular_tree',return_value=before), \
             patch.object(gate,'dump',side_effect=lambda path,value:dump(self.root/path.name,value)):
            probe.verify()
        data = (self.root/'receipt.json').read_bytes()
        for decode in (worker.decode_receipt, run.decode_receipt):
            result = decode(data,job)
            self.assertEqual(result['schema'],'polis-probe-receipt/5')
            self.assertEqual(result['verdict'],'PASS')
            self.assertEqual(result['entries'][0]['legacy_defects'],[{'name':legacy_pca.NAME}])
        self.assertEqual(gate.regular_tree(self.recordings), before)


if __name__ == '__main__':
    unittest.main()
