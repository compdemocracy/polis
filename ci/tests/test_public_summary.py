"""Exercise the worker's real summary writer against the runner's checker."""
import copy
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('summary_checker', ROOT / 'ci/p022_check_summary.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class PublicSummaryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.art = self.root / 'art'
        self.state.mkdir()
        for phase, reports, count in [('recovery', 1, 100), ('races', 20, 10)]:
            folder = self.art / 'junit' / phase
            folder.mkdir(parents=True)
            for i in range(reports):
                (folder / f'{i}.xml').write_text(
                    f'<testsuite tests="{count}" failures="0" errors="0" skipped="0"/>')
        for key, value in {'recovery_main_rc': 0, 'recovery_races_rc': 0,
                           'battery_rc': 0, 'expected_main_reports': 1,
                           'expected_race_reports': 20}.items():
            (self.state / key).write_text(str(value))
        (self.state / 'battery-selection.json').write_text(json.dumps({
            'selected_count': 6, 'selected': [{'dataset': 'vw'}, {'dataset': 'biodiversity'}],
            'inventory_digest': 'b' * 64, 'restart_cases': 1, 'missing': []}))
        self.sha = self.root / 'sha'
        self.sha.write_text('a' * 40)
        self.expected = {'sha': 'a' * 40, 'battery_digest': 'b' * 64,
                         'junit_dir': str(self.art / 'junit')}

    def write_summary(self):
        shell = (ROOT / 'ci/p022_ec2_run.sh').read_text().split('phase_summary() {', 1)[1]
        writer = shell.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        # Relocate only the host identity file; execute the actual producer code.
        writer = writer.replace('pathlib.Path("/var/lib/polis-ci-sha")',
                                f'pathlib.Path({str(self.sha)!r})')
        result = subprocess.run([sys.executable, '-', str(ROOT), str(self.root),
                                 str(self.state), str(self.art)], input=writer,
                                text=True, capture_output=True, check=True)
        return json.loads(result.stdout)

    def test_pass_producer_and_checker_agree(self):
        summary = self.write_summary()
        self.assertEqual(summary['schema'], 'p022-public-battery/4')
        self.assertEqual(checker.check(summary, self.expected), 'PUBLIC-BATTERY-PASS')

    def test_failure_producer_and_checker_agree(self):
        (self.state / 'battery_rc').write_text('1')
        self.assertEqual(checker.check(self.write_summary(), self.expected), 'PUBLIC-BATTERY-FAIL')

    def test_declared_recovery_only(self):
        (self.state / 'battery_rc').unlink()
        self.expected['run_battery'] = False
        self.assertEqual(checker.check(self.write_summary(), self.expected), 'PUBLIC-BATTERY-PASS')

    def test_rejects_incoherent_names_and_evidence(self):
        good = self.write_summary()
        for key, value in [('schema', 'wrong/4'), ('kind', 'wrong-kind'),
                           ('verdict', 'PASS'), ('ref_sha', 'c' * 40)]:
            with self.subTest(key=key):
                bad = copy.deepcopy(good)
                bad[key] = value
                with self.assertRaises(checker.Invalid):
                    checker.check(bad, self.expected)
        (self.art / 'junit/races/0.xml').unlink()
        with self.assertRaises(checker.Invalid):
            checker.check(good, self.expected)

    def test_workflow_and_default_trust_environment_agree(self):
        workflow = (ROOT / '.github/workflows/certification-ec2.yml').read_text()
        stack = (ROOT / 'cdk/lib/cdk-stack.ts').read_text()
        self.assertIn('name: Public battery certification (EC2)\n', workflow)
        self.assertRegex(workflow, r'(?m)^    environment: certification-public$')
        self.assertRegex(stack, r"ciEc2GithubEnvironment[\s\S]{0,120}\?\? 'certification-public'")
        self.assertIn('name: public-battery-ec2-', workflow)
