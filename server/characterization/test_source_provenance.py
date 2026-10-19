"""Archive labels never replace the source-byte receipt or accept a partial pin."""
import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


class ArchivePinTests(unittest.TestCase):
    def load(self):
        spec = importlib.util.spec_from_file_location('archive_run', HERE / 'run.py')
        module = importlib.util.module_from_spec(spec)
        env = dict(COMPOSE_PROJECT_NAME='p027unit-archive', P027_PORT_MIN='57821', P027_PORT_MAX='57823',
                   POLIS_RECOVERY_PG_PORT='57821', P027_HTTP_PORT='57822', P027_CONTROL_PORT='57823')
        with patch.dict(os.environ, env):
            spec.loader.exec_module(module)
        return module

    def test_explicit_full_pin(self):
        module = self.load()
        module.ENV['P027_SOURCE_COMMIT'] = 'a' * 40
        with patch.object(module, 'run', side_effect=AssertionError('unexpected git')):
            self.assertEqual(module.source_commit(), 'a' * 40)
        for invalid in ('', 'a' * 39, 'a' * 41, 'A' * 40, 'not-a-commit'):
            module.ENV['P027_SOURCE_COMMIT'] = invalid
            with self.assertRaisesRegex(RuntimeError, 'invalid archive'):
                module.source_commit()

    def test_default_uses_git(self):
        module = self.load()
        module.ENV.pop('P027_SOURCE_COMMIT', None)
        with patch.object(module, 'run', return_value='b' * 40 + '\n') as git:
            self.assertEqual(module.source_commit(), 'b' * 40)
            git.assert_called_once_with('git', 'rev-parse', 'HEAD', capture=True)
