"""The Delphi shard combine reads the latest run attempt of each shard.

A re-run of a failed shard on hosted CI uploads a second artifact for that
shard; GitHub keeps both, and the download returns them in no useful order
(artifact ids do not grow with time). These tests lay out two attempts' result
directories and run ci/local/delphi_python_results.py the way
ci/local/delphi-python.sh combine does: `latest`, then `combine` on what it kept.
Standard library only: `python3 ci/tests/test_delphi_python_results.py`.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'local' / 'delphi_python_results.py'
SHARDS = 3


def shard_dir(root, name, index, counts, attempt=None, job_id=None):
    """One downloaded shard artifact: manifest, pytest counts, results and,
    on hosted CI, attempt.json."""
    d = Path(root) / name
    d.mkdir(parents=True)
    tests = [f't{index}_{k}' for k in range(4)]
    collected = [f't{i}_{k}' for i in range(1, SHARDS + 1) for k in range(4)]
    (d / 'manifest.json').write_text(json.dumps({
        'shard': f'{index}/{SHARDS}', 'collected': collected, 'selected': tests,
        'units': {t: f'u{index}' for t in tests}, 'serial': []}))
    (d / 'results-parallel.jsonl.counts.json').write_text(json.dumps(counts))
    (d / 'results-parallel.jsonl').write_text(
        ''.join(json.dumps({'nodeid': t, 'duration': 1.0}) + '\n' for t in tests))
    if attempt is not None:
        (d / 'attempt.json').write_text(json.dumps({
            'shard': f'{index}/{SHARDS}', 'run_id': '39203156719',
            'run_attempt': attempt, 'job_id': job_id}))
    return str(d)


def run(*args, env=None):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True,
                          text=True, env={**os.environ, **(env or {})})


class LatestAttempt(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        passed = {'passed': 4}
        self.s1 = shard_dir(self.root, 'delphi-shard-1-attempt-1', 1, passed, 1, '101')
        self.s2 = shard_dir(self.root, 'delphi-shard-2-attempt-1', 2, passed, 1, '102')
        # Shard 3 failed two tests on attempt 1 and passed when re-run (attempt 2).
        self.stale = shard_dir(self.root, 'delphi-shard-3-attempt-1', 3,
                               {'passed': 2, 'failed': 2}, 1, '103')
        self.fresh = shard_dir(self.root, 'delphi-shard-3-attempt-2', 3, passed, 2, '203')

    def tearDown(self):
        self.tmp.cleanup()

    def latest(self, *dirs):
        r = run('latest', *dirs)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.splitlines(), r.stderr

    def test_keeps_the_rerun_whatever_order_the_download_gives(self):
        for order in ([self.s1, self.s2, self.stale, self.fresh],
                      [self.fresh, self.stale, self.s2, self.s1]):
            kept, notes = self.latest(*order)
            self.assertEqual(sorted(kept), sorted([self.s1, self.s2, self.fresh]))
            self.assertIn('shard 3/3: attempt 2 (job 203) replaces attempt 1 (job 103)', notes)

    def test_combine_of_the_kept_directories_passes_and_names_attempt_and_job(self):
        kept, _ = self.latest(self.s1, self.s2, self.stale, self.fresh)
        summary = Path(self.root) / 'step-summary.md'
        r = run('combine', '--out', str(Path(self.root) / 'combined'), *kept,
                env={'GITHUB_STEP_SUMMARY': str(summary)})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('shard 3/3 (attempt 2, job 203): 4 tests; 4 passed, 0 failed', r.stdout)
        self.assertIn('shard 1/3 (attempt 1, job 101): 4 tests', r.stdout)
        self.assertIn('all shards: 12 of 12 collected tests; 12 passed, 0 failed', r.stdout)
        table = summary.read_text()
        self.assertIn('| 3/3 | 2 | 203 | 4 passed, 0 failed', table)
        self.assertIn('| 1/3 | 1 | 101 |', table)

    def test_the_stale_attempt_alone_still_fails_the_combine(self):
        r = run('combine', '--out', str(Path(self.root) / 'combined'),
                self.s1, self.s2, self.stale)
        self.assertEqual(r.returncode, 1)
        self.assertIn('2 failed and 0 errors across the shards', r.stderr)

    def test_local_directories_without_attempt_json_are_kept_as_they_are(self):
        local = [shard_dir(self.root, f'local-{i}', i, {'passed': 4}) for i in (1, 2, 3)]
        kept, notes = self.latest(*local)
        self.assertEqual(kept, local)
        self.assertEqual(notes, '')
        r = run('combine', '--out', str(Path(self.root) / 'combined'), *kept)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('shard 2/3: 4 tests; 4 passed', r.stdout)

    def test_two_directories_for_one_shard_and_attempt_are_an_error(self):
        twin = shard_dir(self.root, 'twin', 3, {'passed': 4}, 2, '204')
        r = run('latest', self.s1, self.s2, self.fresh, twin)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('shard 3/3: attempt 2 has more than one result directory', r.stderr)
        self.assertEqual(r.stdout, '')

    def test_attempt_json_naming_a_different_shard_than_the_manifest_is_an_error(self):
        Path(self.fresh, 'attempt.json').write_text(json.dumps(
            {'shard': '2/3', 'run_id': '1', 'run_attempt': 2, 'job_id': '203'}))
        r = run('combine', '--out', str(Path(self.root) / 'combined'), self.s1, self.s2, self.fresh)
        self.assertEqual(r.returncode, 1)
        self.assertIn('attempt.json names shard 2/3 but its manifest is shard 3/3', r.stderr)


if __name__ == '__main__':
    unittest.main()
