"""Snapshot-relative schedules retain the admitted full-stream recipe."""
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0,str(Path(__file__).parent/'images'))
import probe
from polismath.replay.schedule import ScheduleSpec


class ProbeTests(unittest.TestCase):
    def test_receipt_exports_only_observed_legacy_omissions_and_retains_raw_files(self):
        from receipt import decode_receipt
        from contracts import validate_job

        gate = probe.gate
        job = validate_job(dict(schema='polis-probe-job/1', run_id='a' * 32, max_seconds=3600,
            producer={'image': 'localhost/producer@sha256:' + '1' * 64, 'args': ['produce']},
            verifier={'image': 'localhost/verifier@sha256:' + '2' * 64, 'args': ['verify']}))
        inputs = {'policySha256': gate.sha(gate.POLICY)}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recordings = root / 'recordings'
            spec = ScheduleSpec.from_json_file(gate.REPO / 'delphi/scripts/schedules/pc-zerovote-01-empty.json')
            checkpoint = {'index': 0, 'prev_slot': 0, 'cut_slot': 0, 'batch_size': 0, 'cut_time_ms': 0}
            expected = gate.certify.ExpectedEntry(
                gate.certify.BatteryEntry(spec.dataset, spec.schedule_id), spec,
                root / 'public-events.jsonl', 'a' * 64, None, None, 0, [checkpoint])
            rec = gate.store.recording_dir(spec.dataset, spec.schedule_id, root=recordings)
            (rec / 'clj').mkdir(parents=True)
            (rec / 'py').mkdir()
            gate.dump(rec / 'schedule.json', spec.to_dict())
            python_blob = {'pca': {'comps': [[1.0], [1.0]]}, 'mod-in': [], 'mod-out': []}
            for key, value in spec.empty_output.items():
                if key.startswith('pca.'):
                    python_blob['pca'][key.split('.')[1]] = value
                else:
                    python_blob[key] = value
            gate.dump(rec / 'clj/step-000.meta.json', checkpoint)
            gate.dump(rec / 'py/step-000.json', {**checkpoint, 'blob': python_blob})
            read, dump, tree = gate.read, gate.dump, gate.regular_tree
            def verify_recordings(evidence, admitted, scratch, fixture):
                return gate.verify_pairs([expected], recordings, scratch)
            def read_input(path):
                admitted = {'/job/job.json': job, '/run-spec/inputs.json': inputs,
                            '/fixture/manifest.json': {}}
                return admitted[str(path)] if str(path) in admitted else read(path)
            import itertools
            for omitted, lists in itertools.product((['n'], [], ['mod-in'], ['mod-out'], ['mod-in', 'mod-out']), (([], []), ([2, 7], [3, 8]))):
                with self.subTest(omitted=omitted, lists=lists):
                    python_blob.update(dict(zip(['mod-in', 'mod-out'], lists)))
                    (rec / 'py/step-000.json').write_bytes(gate.encoded({**checkpoint, 'blob': python_blob}))
                    (rec / 'clj/step-000.blob.json').write_bytes(gate.encoded(
                        {**{k: v for k, v in python_blob.items() if k not in omitted},
                         'lastVoteTimestamp': 0}))
                    (root / 'receipt.json').unlink(missing_ok=True)
                    before = tree(recordings)
                    with patch.object(gate, 'read', side_effect=read_input), \
                         patch.object(gate, 'verify_recordings', side_effect=verify_recordings), \
                         patch.object(gate, 'regular_tree', side_effect=lambda _: tree(recordings)), \
                         patch.object(gate, 'dump', side_effect=lambda path, value: dump(root / path.name, value)):
                        probe.verify()
                    receipt = decode_receipt((root / 'receipt.json').read_bytes(), job)
                    self.assertEqual(receipt['verdict'], 'PASS')
                    if omitted:
                        self.assertEqual(receipt['entries'][0]['legacy_defects'],
                            [{'name': 'legacy-defect-empty-omits-keys', 'keys': omitted}])
                    else:
                        self.assertNotIn('legacy_defects', receipt['entries'][0])
                    self.assertEqual(tree(recordings), before)
                    self.assertTrue(all(k not in read(rec / 'clj/step-000.blob.json') for k in omitted))

    def test_image_recipe_includes_exact_approved_probe_config(self):
        import recipe
        from polismath.replay import fixture_config

        root = Path(__file__).resolve().parents[2]
        files = recipe.source_files(root)
        self.assertEqual(probe.PROBE_CONFIG_PATH, root / 'delphi/scripts/certify_datasets.probe.json')
        self.assertEqual(files[str(probe.PROBE_CONFIG_PATH.relative_to(root))],
                         '3ee9dd88ea0a4ebf0a94995978d8012f8d499d81cac8036231458549c833a939')
        self.assertNotEqual(probe.PROBE_CONFIG_PATH, fixture_config.DEFAULT_CONFIG_PATH)

    def test_reader_forwards_only_the_configs_recorded_approvals(self):
        self.assertEqual(probe.accepted_replacements({}), ())
        self.assertEqual(probe.accepted_replacements({'accepted_public_fixture_replacements': ['pc-v1-dense', 'pc-v1-dense-max']}),
                         ('pc-v1-dense', 'pc-v1-dense-max'))
        import inspect
        source = inspect.getsource(probe.extract)
        self.assertIn('accept_public_fixture=accepted_replacements(config)', source)

    def test_stage_failure_final_line_is_class_and_origin_code_only(self):
        import io, contextlib
        def raiser():
            raise ValueError("3 blob text(s) for 5 math_main row(s): zid 42 topic secret")
        try:
            raiser()
        except ValueError as error:
            self.assertEqual(probe.failure_origin(error), 'TEST_PROBE_L%d' % error.__traceback__.tb_next.tb_lineno)
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                probe.report_failure(error)
        last = err.getvalue().strip().splitlines()[-1]
        self.assertRegex(last, r'^builtins\.ValueError: TEST_PROBE_L\d+$')
        self.assertNotIn('zid', last); self.assertNotIn('blob', last)

    def test_explicit_schedule_scales_to_snapshot_preserving_semantics(self):
        raw=dict(dataset='public-fixture',schedule_id='two',cuts={'mode':'vote-count','at':[25,100]},
                 coverage='full-stream',restart_after=0,moderation='interleave-by-timestamp',clojure={'warm_start':'chain'})
        with patch.object(probe.gate.certify,'build_effective_spec',return_value=ScheduleSpec.from_dict(raw)):
            actual=probe.resolve_private_spec(SimpleNamespace(schedule_path=True),SimpleNamespace(votes=[None]*40)).to_dict()
        self.assertEqual(actual,{**raw,'cuts':{'mode':'vote-count','at':[10,40]}})

    def test_empty_and_presets_not_reinterpreted(self):
        for path,slots in [(True,[0]),(False,[10,20])]:
            raw=dict(dataset='public-fixture',schedule_id='empty',cuts={'mode':'vote-count','at':slots,'empty_checkpoint':True})
            with patch.object(probe.gate.certify,'build_effective_spec',return_value=ScheduleSpec.from_dict(raw)):
                self.assertEqual(probe.resolve_private_spec(SimpleNamespace(schedule_path=path),SimpleNamespace(votes=[])).to_dict(),raw)


    def test_primary_and_replica_require_readonly_session(self):
        for recovery in (False, True):
            conn = MagicMock()
            conn.cursor.return_value.__enter__.return_value.fetchone.return_value = (recovery, 'on')
            probe.validate_reader_session(conn)
            conn.cursor.return_value.__enter__.return_value.execute.assert_called_once_with(
                "SELECT pg_is_in_recovery(), current_setting('transaction_read_only')")

    def test_writable_or_unknown_source_refused(self):
        for row in [(False, 'off'), (True, 'off'), (None, 'on'), (1, 'on'), None, (), (False,)]:
            with self.subTest(row=row):
                conn = MagicMock()
                conn.cursor.return_value.__enter__.return_value.fetchone.return_value = row
                with self.assertRaisesRegex(ValueError, 'READ_ONLY_SOURCE_REQUIRED'):
                    probe.validate_reader_session(conn)
