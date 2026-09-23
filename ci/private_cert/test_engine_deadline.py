"""Campaign deadline and closed timeout attribution controls; public inputs only."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent / 'images'))
import gate
import probe
import worker
from run import clean_heartbeat
from receipt import validate_engine_timeout, RECIPE_TOKENS, ENGINE_TOKENS, ELAPSED_BUCKETS


class EngineDeadlineTests(unittest.TestCase):
    def test_remaining_campaign_budget_over_one_hour_and_no_reset(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, POLIS_REPLAY_INPUT_MAP='/public/map'), \
                patch.object(gate.time, 'time', side_effect=[1000, 5100, 10000]), \
                patch.object(gate.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            for i in range(3):
                gate.run_engine(['engine'], Path(tmp), Path(tmp)/str(i), deadline=20000,
                                engine='legacy', recipe='sample-uniform6')
            self.assertEqual([c.kwargs['timeout'] for c in run.call_args_list], [19000, 14900, 10000])

    def test_expired_budget_never_launches_and_retains_attribution(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, POLIS_REPLAY_INPUT_MAP='/public/map'), \
                patch.object(gate.time, 'time', return_value=1000), patch.object(gate.subprocess, 'run') as run:
            for deadline in (999, 1000):
                with self.assertRaises(gate.EngineTimeoutError) as caught:
                    gate.run_engine(['private-command'], Path(tmp), Path(tmp)/str(deadline), deadline=deadline,
                                    engine='python', recipe='sample-uniform6')
                self.assertEqual(caught.exception.context, dict(engine='python', recipe='sample-uniform6', elapsed_bucket='le-1h'))
            run.assert_not_called()

    def test_real_child_timeout_round_trips_worker_and_operator_without_raw_output(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, POLIS_REPLAY_INPUT_MAP='/public/map'):
            log = Path(tmp)/'driver.log'
            with self.assertRaises(gate.EngineTimeoutError) as caught:
                gate.run_engine([sys.executable, '-c', 'import time; print("private-payload", flush=True); time.sleep(30)'],
                                Path(tmp), log, deadline=time.time()+0.3, engine='legacy', recipe='sample-uniform6')
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                probe.report_failure(caught.exception)
            log.write_text(err.getvalue())
            token = worker.last_exception_token(log)
            expected = dict(engine='legacy', recipe='sample-uniform6', elapsed_bucket='le-1h')
            self.assertEqual(token, dict(code='ENGINE_DEADLINE_EXCEEDED', **{'class':'gate.EngineTimeoutError'}, **expected))
            record = worker.failure_record('producer', worker.SandboxFailure('producer', 1, False, token))
            clean = clean_heartbeat(record)
            self.assertEqual(clean['container'], record['container'])
            self.assertNotIn('private-payload', json.dumps(record))
            self.assertNotIn(str(tmp), json.dumps(record))

    def test_elapsed_bucket_boundaries_and_all_engines(self):
        for engine in ENGINE_TOKENS:
            for elapsed, bucket in ((0,'le-1h'),(3600,'le-1h'),(3600.1,'le-2h'),(7200,'le-2h'),
                                    (7200.1,'le-4h'),(14400,'le-4h'),(14400.1,'gt-4h')):
                self.assertEqual(gate.EngineTimeoutError(engine, 'sample-uniform6', elapsed).context['elapsed_bucket'], bucket)

    def test_timeout_elapsed_uses_monotonic_clock(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, POLIS_REPLAY_INPUT_MAP='/public/map'), \
                patch.object(gate.time, 'time', return_value=1000), \
                patch.object(gate.time, 'monotonic', side_effect=[10, 10+7201]), \
                patch.object(gate.subprocess, 'run', side_effect=subprocess.TimeoutExpired('private command', 9999)):
            with self.assertRaises(gate.EngineTimeoutError) as caught:
                gate.run_engine(['engine'], Path(tmp), Path(tmp)/'log', deadline=20000,
                                engine='python', recipe='public-vw-single')
            self.assertEqual(caught.exception.context['elapsed_bucket'], 'le-4h')
            self.assertEqual(str(caught.exception), 'ENGINE_DEADLINE_EXCEEDED')

    def test_invalid_deadline_cannot_launch(self):
        for value in (None, True, '12345', float('nan'), float('inf'), -1, 0, [], {}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'ENGINE_DEADLINE'):
                gate.validate_engine_deadline(value)

    def test_probe_requires_worker_deadline_even_for_public_fixtures(self):
        for scope in ('public', 'private'):
            with patch.object(probe, 'admit_fixture_selection'), \
                    patch.object(gate, 'read', side_effect=lambda p: {'/fixture/plan.json':{'scope':scope},
                        '/selection/context.json':{}, '/run-spec/deadline.json':{'engine_deadline_unix':123456}}[str(p)]), \
                    patch.object(gate, 'produce') as produce:
                probe.produce()
                produce.assert_called_once_with(deadline=123456)
        for budget in ({}, {'engine_deadline_unix':12345,'duration':3600}, {'engine_deadline_unix':True}):
            with patch.object(gate, 'read', side_effect=[{'scope':'public'},budget]), patch.object(gate,'produce') as produce:
                with self.assertRaisesRegex(ValueError,'ENGINE_DEADLINE'): probe.produce()
                produce.assert_not_called()
        with patch.object(gate, 'read', side_effect=[{'scope':'public'},FileNotFoundError()]), patch.object(gate,'produce') as produce:
            with self.assertRaises(FileNotFoundError): probe.produce()
            produce.assert_not_called()

    def test_local_certify_default_is_configurable_and_box_ignores_it(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(gate.certify.driver_timeout_seconds(), 43200)
        with patch.dict(os.environ, POLIS_CERTIFY_DRIVER_TIMEOUT_SECONDS='50000.5'), \
                patch.object(gate.certify.subprocess,'run') as run:
            gate.certify._run_subprocess(['public'],cwd=Path('/tmp'),env={})
            self.assertEqual(run.call_args.kwargs['timeout'],50000.5)
        for value in ('0','-1','nan','inf','bad'):
            with patch.dict(os.environ,POLIS_CERTIFY_DRIVER_TIMEOUT_SECONDS=value), self.assertRaisesRegex(ValueError,'DRIVER_TIMEOUT_CONFIG'):
                gate.certify.driver_timeout_seconds()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, POLIS_CERTIFY_DRIVER_TIMEOUT_SECONDS='bad'), \
                patch.object(gate, 'prepare', side_effect=RuntimeError('PREPARE_REACHED')):
            inputs=Path(tmp)/'inputs.json';inputs.write_text('{}');output=Path(tmp)/'out';output.mkdir()
            with self.assertRaisesRegex(RuntimeError,'PREPARE_REACHED'):
                gate.produce(output=output,inputs_path=inputs,deadline=999999)

    def test_worker_allocation_is_frozen_readonly_and_uses_remaining_admission(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            import datetime as dt
            expires=dt.datetime.fromtimestamp(44200,dt.timezone.utc).isoformat()
            deadline=worker.absolute_deadline(dict(started=1000,terminateBy=44200,
                admission=dict(started=1000,expiresAt=expires)),43200)
            actual=worker.write_engine_deadline(root,deadline,now=5000)
            self.assertEqual(actual,40172)
            self.assertEqual(json.loads((root/'deadline.json').read_bytes()),{'engine_deadline_unix':40172})
            self.assertEqual((root/'deadline.json').stat().st_mode & 0o777,0o444)
            self.assertLess(actual,deadline-120)
            self.assertLess(deadline-120,deadline-30)
            with self.assertRaises(FileExistsError): worker.write_engine_deadline(root,deadline,now=6000)
        with tempfile.TemporaryDirectory() as tmp:
            # No minimum per-engine timeout revives an exhausted allocation.
            self.assertEqual(worker.write_engine_deadline(Path(tmp),1000,now=999),880)

    def test_worker_wires_deadline_into_existing_readonly_run_spec(self):
        import ast
        tree=ast.parse(Path(worker.__file__).read_text())
        run=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run')
        calls=[n for n in ast.walk(run) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name)]
        write=next(n for n in calls if n.func.id=='write_engine_deadline')
        self.assertEqual([ast.unparse(n) for n in write.args],['run_spec','deadline'])
        sandboxes={n.args[1].value:n for n in calls if n.func.id=='sandbox'}
        self.assertEqual(ast.unparse(sandboxes['reader'].args[3]),'deadline - 180')
        self.assertEqual(ast.unparse(sandboxes['producer'].args[3]),'deadline - 120')
        self.assertEqual(ast.unparse(sandboxes['verifier'].args[3]),'deadline - 30')
        self.assertLess(write.lineno,sandboxes['producer'].lineno)
        mounts=next(n.value for n in ast.walk(run) if isinstance(n,ast.Assign)
                    and any(isinstance(t,ast.Name) and t.id=='producer_mounts' for t in n.targets))
        self.assertIn("(run_spec, '/run-spec', 'ro')",ast.unparse(mounts))

    def test_all_closed_contexts_and_forgery_rejection_at_both_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            log=Path(tmp)/'log'
            for engine in ENGINE_TOKENS:
                for recipe in RECIPE_TOKENS:
                    for bucket in ELAPSED_BUCKETS:
                        context=dict(engine=engine,recipe=recipe,elapsed_bucket=bucket)
                        validate_engine_timeout(context)
                        log.write_text('gate.EngineTimeoutError: ENGINE_DEADLINE_EXCEEDED '+
                                       ' '.join((engine,recipe,bucket))+'\n')
                        token=worker.last_exception_token(log)
                        record=worker.failure_record('producer',worker.SandboxFailure('producer',1,False,token))
                        self.assertEqual({k:clean_heartbeat(record)['container'][k] for k in context},context)
            good=dict(engine='python',recipe='sample-uniform6',elapsed_bucket='le-1h')
            for key in good:
                for bad in ('private-payload', '', None, True, [], {}):
                    forged={**good,key:bad}
                    with self.assertRaises(ValueError):validate_engine_timeout(forged)
                    record=worker.failure_record('producer',worker.SandboxFailure('producer',1,False,
                        dict(code='ENGINE_DEADLINE_EXCEEDED',**forged)))
                    self.assertTrue(set(good).isdisjoint(clean_heartbeat(record)['container']))
            for value in ({**good,'extra':'private-payload'}, {}, [], None):
                with self.assertRaises(ValueError):validate_engine_timeout(value)
            for line in ('gate.EngineTimeoutError: ENGINE_DEADLINE_EXCEEDED python sample-uniform6 le-1h extra',
                         'gate.EngineTimeoutError: ENGINE_DEADLINE_EXCEEDED python private-payload le-1h',
                         'ValueError: ENGINE_DEADLINE_EXCEEDED python sample-uniform6 le-1h'):
                log.write_text(line+'\n')
                self.assertTrue(set(good).isdisjoint(worker.last_exception_token(log)))

    def test_sandbox_preserves_engine_tokens_before_cleanup(self):
        def execute(argv,**kw):
            if 'run' in argv:
                kw['stdout'].write(b'gate.EngineTimeoutError: ENGINE_DEADLINE_EXCEEDED python sample-uniform6 le-2h\n')
                return SimpleNamespace(returncode=1)
            return SimpleNamespace(returncode=0)
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker,'SCRATCH',Path(tmp)), \
                patch.object(worker.subprocess,'run',side_effect=execute), \
                patch.object(worker.subprocess,'check_output',return_value=b'[{"State":{"ExitCode":1,"OOMKilled":false}}]'):
            with self.assertRaises(worker.SandboxFailure) as caught:
                worker.sandbox({'args':['produce']},'producer',[],time.time()+30,'sha256:'+'a'*64)
            record=worker.failure_record('producer',caught.exception)
            self.assertEqual(record['container']['engine'],'python')
            self.assertEqual(record['container']['elapsed_bucket'],'le-2h')
            self.assertEqual(clean_heartbeat(record)['container'],record['container'])
