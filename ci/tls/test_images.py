"""The default gate must build and audit final runtimes, not just base stages."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from check_trust import HERE


class ImageMatrixTests(unittest.TestCase):
    def capture(self, selection=None):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / 'commands.jsonl'
            # Record argv without invoking Docker, Python packages, or a network.
            for name in ('docker', 'python3'):
                executable = root / name
                executable.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n')
                executable.chmod(0o755)
            env = dict(os.environ, PATH=f'{tmp}:{os.environ["PATH"]}', COMMAND_LOG=str(log), TLS_IMAGE_TAG='trust-matrix')
            env.pop('TLS_IMAGE_SELECTION', None)
            if selection is not None:
                env['TLS_IMAGE_SELECTION'] = selection
            result = subprocess.run(['bash', str(HERE / 'check-images.sh')], env=env, capture_output=True, text=True)
            return result, log.read_text().splitlines() if log.exists() else []

    def test_default_builds_all_final_images(self):
        result, commands = self.capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        builds = [c for c in commands if c.startswith('build ')]
        audits = [c for c in commands if c.startswith('ci/tls/check_image.py ')]
        names = ['server', 'python', 'nginx', 'postgres', 'java', 'api', 'migrate', 'oidc',
                 'coordinator', 'file-server', 'client-admin', 'client-participation',
                 'client-report', 'probe-base', 'probe-worker']
        self.assertEqual(len(builds), len(names))
        self.assertEqual(len(audits), len(names))
        for name in names:
            self.assertEqual(sum(c.split()[1] == f'trust-matrix-{name}' for c in audits), 1)
        self.assertIn('build --pull --target prod -t trust-matrix-server -f server/Dockerfile .', builds)
        self.assertTrue(any('--target final --build-context queue-rs=queue-rs' in c for c in builds))
        self.assertTrue(any('--target runtime -t trust-matrix-java math' in c for c in builds))
        self.assertTrue(any('-f server/Dockerfile-db server' in c for c in builds))
        self.assertIn('ci/tls/check_image.py trust-matrix-python --python --rds --jobs', audits)
        self.assertFalse(any('--target base' in c or '--target trust' in c for c in builds))

    def test_legacy_commentgraph_remains_selectable(self):
        result, commands = self.capture('commentgraph')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(commands, [
            'build --pull -t trust-matrix-commentgraph delphi/umap_narrative/polismath_commentgraph',
            'ci/tls/check_image.py trust-matrix-commentgraph --python --rpm',
        ])

    def test_hosted_matrix_matches_required_default(self):
        workflow = (HERE.parents[1] / '.github/workflows/tls-trust.yml').read_text()
        matrix_line = next(line for line in workflow.splitlines() if line.strip().startswith('image: ['))
        groups = matrix_line.split('[', 1)[1].split(']', 1)[0].split(', ')
        self.assertNotIn('commentgraph', groups)
        self.assertIn('probe', groups)
        result, default_commands = self.capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        hosted_commands = []
        for group in groups:
            result, commands = self.capture(group)
            self.assertEqual(result.returncode, 0, result.stderr)
            hosted_commands.extend(commands)
        self.assertEqual(hosted_commands, default_commands)

    def test_hosted_selection_is_bounded(self):
        result, commands = self.capture('python')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(commands), 2)
        self.assertIn('--target final', commands[0])
        self.assertIn('--python --rds --jobs', commands[1])

    def test_unknown_selection_fails_closed(self):
        result, commands = self.capture('typo')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(commands, [])
