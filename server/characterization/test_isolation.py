"""Isolation and runner integration controls without Docker/database mutation."""
import json
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest
from unittest.mock import patch

from isolation import isolated_environment

HERE = Path(__file__).resolve().parent


def fixture(**updates):
    env = dict(COMPOSE_PROJECT_NAME='p027-review-a1', POLIS_RECOVERY_PG_PORT='55930',
               P027_HTTP_PORT='55931', P027_CONTROL_PORT='55932')
    env.update(updates)
    return env


class IsolationTest(unittest.TestCase):
    def test_comments_plan_matches_governing_notes(self):
        plan = (HERE / "comments-plan.json").read_bytes()
        # Portable pin of the governing notes plan; also compare its current file
        # whenever the separate notes checkout is available to detect live drift.
        self.assertEqual(hashlib.sha256(plan).hexdigest(),
                         "b51438a86b99d9e36d4585feff397a4636247148544ebe9a2194dd5e4f48f471")
        notes = Path(os.environ.get("P027_NOTES_ROOT",
                     HERE.parents[2] / "polis" / "cost-reduction"))
        source = notes / "04-plans/p032-slice2-comments/recording-plan.json"
        if "P027_NOTES_ROOT" in os.environ or source.exists():
            self.assertEqual(json.loads(plan), json.loads(source.read_text()))

    def test_defaults_and_no_input_mutation(self):
        env = fixture(RECOVERY_PG_PORT='9999')
        self.assertEqual(isolated_environment(env)['RECOVERY_PG_PORT'], '55930')
        self.assertEqual(env['RECOVERY_PG_PORT'], '9999')

    def test_review_window_no_longer_requires_source_patch(self):
        env = fixture(COMPOSE_PROJECT_NAME='p027r5-e44', P027_PORT_MIN='55920',
                      P027_PORT_MAX='55929', POLIS_RECOVERY_PG_PORT='55921',
                      P027_HTTP_PORT='55922', P027_CONTROL_PORT='55923')
        self.assertEqual(isolated_environment(env)['RECOVERY_PG_PORT'], '55921')

    def test_invalid_projects(self):
        for project in ['', 'prod', 'p027', 'p027-', 'p027-review-', 'p027/a1']:
            with self.subTest(project=project), self.assertRaises(RuntimeError):
                isolated_environment(fixture(COMPOSE_PROJECT_NAME=project))

    def test_invalid_ports_and_bounds(self):
        for update in [dict(P027_HTTP_PORT='55930'), dict(P027_CONTROL_PORT='55940'),
                       dict(P027_HTTP_PORT=''), dict(P027_HTTP_PORT='nan'),
                       dict(P027_PORT_MIN='1'), dict(P027_PORT_MAX='65536'),
                       dict(P027_PORT_MIN='55940'), dict(P027_PORT_MAX='55931')]:
            with self.subTest(update=update), self.assertRaises(RuntimeError):
                isolated_environment(fixture(**update))
        for key in ['POLIS_RECOVERY_PG_PORT', 'P027_HTTP_PORT', 'P027_CONTROL_PORT']:
            env = fixture()
            del env[key]
            with self.subTest(missing=key), self.assertRaises(RuntimeError):
                isolated_environment(env)

    def test_both_real_entrypoints_fail_before_side_effects(self):
        for script in ['run.py', 'seed-pca2.py']:
            result = subprocess.run([sys.executable, str(HERE / script)],
                                    env={**fixture(COMPOSE_PROJECT_NAME='prod'),
                                         'PYTHONDONTWRITEBYTECODE': '1'},
                                    text=True, capture_output=True)
            with self.subTest(script=script):
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('set a unique COMPOSE_PROJECT_NAME', result.stderr)
                self.assertNotIn('ModuleNotFoundError', result.stderr)

    def test_runner_and_readme_execute_same_six_node_files(self):
        spec = importlib.util.spec_from_file_location('p027_runner', HERE / 'run.py')
        module = importlib.util.module_from_spec(spec)
        calls = []
        with patch.dict(os.environ, fixture(), clear=True):
            spec.loader.exec_module(module)
        module.dc = lambda *args, **kwargs: calls.append(args)
        module.ready = lambda: None
        module.provenance = lambda: None
        with patch.object(sys, 'argv', ['run.py', 'test']):
            module.main()
        command = next(c for c in calls if '--test' in c)
        files = list(command[command.index('--test') + 1:])
        expected = ['test.cjs', 'corrections.test.cjs', 'recorded.test.cjs',
                    'round2.test.cjs', 'pca2.test.cjs', 'runtime.test.cjs']
        self.assertEqual(files, ['characterization/' + f for f in expected])
        readme = (HERE / 'README.md').read_text()
        line = next(line for line in readme.splitlines() if 'exec -T server node --test' in line)
        self.assertEqual(line.split('--test ')[1].split(), files)


if __name__ == '__main__':
    unittest.main()
