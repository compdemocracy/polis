"""Release workflow structure, and the head check run as written; no GitHub calls."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ('polis-release.yml', 'polis-promotion-prepare.yml', 'polis-cli-release-build.yml')
INPUT_BRANCH = {'${{ inputs.stable_commit }}': 'stable', '${{ inputs.commit }}': 'stable',
                '${{ inputs.candidate }}': 'edge'}
A, B = 'a' * 40, 'b' * 40


def parse(name):
    """{job: {'header': text, 'steps': [text]}} from these files' two-space layout.

    Each step is returned as a mapping indented by eight spaces. Comment lines
    outside run scripts are dropped.
    """
    text = (ROOT / '.github/workflows' / name).read_text()
    jobs, job, in_steps = {}, None, False
    for line in text.split('\njobs:\n', 1)[1].splitlines():
        indent = len(line) - len(line.lstrip())
        if not line.strip() or (line.lstrip().startswith('#') and indent < 10):
            continue
        job_name = re.fullmatch(r'  ([A-Za-z0-9_-]+):', line)
        if job_name:
            job = jobs[job_name[1]] = {'header': '', 'steps': []}
            in_steps = False
        elif line == '    steps:':
            in_steps = True
        elif in_steps and line.startswith('      - '):
            job['steps'].append(' ' * 8 + line[8:] + '\n')
        elif in_steps:
            job['steps'][-1] += line + '\n'
        else:
            job['header'] += line + '\n'
    return jobs


def field(step, key):
    match = re.search(rf'^        {key}: (.*)$', step, re.M)
    return match[1] if match else None


def env(step):
    block = re.search(r'^        env:\n((?: {10}\S.*\n)+)', step, re.M)
    return dict(line.strip().split(': ', 1) for line in block[1].splitlines()) if block else {}


def script(step):
    block = re.search(r'^        run: \|\n((?:(?: {10}.*)?\n)+)', step, re.M)
    return textwrap.dedent(block[1]) if block else field(step, 'run')


def checkout_ref(step):
    if not (field(step, 'uses') or '').startswith('actions/checkout@'):
        return None
    match = re.search(r'^          ref: (.*)$', step, re.M)
    return match[1] if match else 'default'


class WorkflowTests(unittest.TestCase):
    def all_jobs(self):
        return [(name, job_name, job) for name in WORKFLOWS for job_name, job in parse(name).items()]

    def test_every_input_checkout_follows_a_head_check_in_workflow_code(self):
        checked, scripts = [], set()
        for name, job_name, job in self.all_jobs():
            if not job['steps']:
                continue  # The reusable builder call.
            refs = [checkout_ref(step) for step in job['steps'] if checkout_ref(step)]
            with self.subTest(job=f'{name}:{job_name}'):
                # No checkout leaves its token behind for later steps.
                for step in job['steps']:
                    if checkout_ref(step):
                        self.assertIn('          persist-credentials: false\n', step)
                # Every job with steps checks out exactly the dispatched input.
                self.assertEqual(len(refs), 1)
                self.assertIn(refs[0], INPUT_BRANCH)
                first = job['steps'][0]
                self.assertTrue(field(first, 'name').startswith('Require the current'))
                self.assertIsNone(field(first, 'uses'))
                self.assertEqual(env(first), {'INPUT_COMMIT': refs[0], 'BRANCH': INPUT_BRANCH[refs[0]]})
                self.assertIn('git ls-remote', script(first))
                scripts.add(script(first))
                checked.append((name, job_name))
        self.assertEqual(sorted(checked), [
            ('polis-cli-release-build.yml', 'build'), ('polis-promotion-prepare.yml', 'prepare'),
            ('polis-promotion-prepare.yml', 'tool'), ('polis-release.yml', 'plan'),
            ('polis-release.yml', 'publish'), ('polis-release.yml', 'review'), ('polis-release.yml', 'tool')])
        # One script everywhere, so the run below covers each copy.
        self.assertEqual(len(scripts), 1)

    def head_check(self, branch, commit, remote, status=0):
        step = parse('polis-release.yml')['tool']['steps'][0]
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / 'git'
            fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_GIT_ARGS"\n'
                            'printf "%s" "$FAKE_GIT_OUTPUT"\nexit "$FAKE_GIT_STATUS"\n')
            fake.chmod(0o755)
            arguments = Path(directory) / 'arguments'
            environment = dict(PATH=directory + os.pathsep + os.environ['PATH'],
                               GITHUB_SERVER_URL='https://github.example', GITHUB_REPOSITORY='example/project',
                               INPUT_COMMIT=commit, BRANCH=branch, FAKE_GIT_ARGS=str(arguments),
                               FAKE_GIT_OUTPUT=remote, FAKE_GIT_STATUS=str(status))
            # GitHub runs an unspecified run shell as `bash -e {0}`.
            result = subprocess.run(['bash', '-e', '-c', script(step)], env=environment,
                                    capture_output=True, text=True, check=False)
            return result.returncode, arguments.read_text().splitlines(), result.stdout

    def test_head_check_accepts_only_the_exact_current_head(self):
        code, arguments, _ = self.head_check('stable', A, f'{A}\trefs/heads/stable\n')
        self.assertEqual(code, 0)
        self.assertEqual(arguments, ['ls-remote', 'https://github.example/example/project', 'refs/heads/stable'])
        self.assertEqual(self.head_check('edge', B, f'{B}\trefs/heads/edge\n')[0], 0)
        for branch, commit, remote, status in [
                ('stable', B, f'{A}\trefs/heads/stable\n', 0),  # stable moved, or any other SHA
                ('stable', A, '', 0),  # no such branch
                ('stable', A, f'{A}\trefs/heads/stable\n{A}\trefs/heads/x/refs/heads/stable\n', 0),
                ('stable', A, f'{A}\trefs/heads/stable\n', 128),  # ls-remote failed
                ('stable', A.upper(), f'{A}\trefs/heads/stable\n', 0),
                ('stable', A[:12], f'{A}\trefs/heads/stable\n', 0),
                ('stable', A + '\n', f'{A}\trefs/heads/stable\n', 0),
                ('stable', f'{A}\trefs/heads/stable', f'{A}\trefs/heads/stable\n', 0),
                ('edge', A, f'{A}\trefs/heads/stable\n', 0)]:
            with self.subTest(branch=branch, commit=commit, remote=remote, status=status):
                code, _, stdout = self.head_check(branch, commit, remote, status)
                self.assertNotEqual(code, 0)
                if status == 0:
                    self.assertIn('::error::The input commit is not the current', stdout)
                    self.assertNotIn(commit, stdout)

    def test_jobs_given_a_token_compile_nothing(self):
        compile_words = ('cargo ', 'test-polis-cli.sh', 'build-polis-cli-release.py --target')
        compiling, holding = [], []
        for name, job_name, job in self.all_jobs():
            text = job['header'] + ''.join(job['steps'])
            compiles = any(word in text for word in compile_words)
            holds = 'github.token' in text or 'secrets.' in text
            self.assertFalse(compiles and holds, f'{name}:{job_name}')
            if compiles:
                compiling.append((name, job_name))
            if holds:
                holding.append((name, job_name))
                # Token holders run the tool the token-free job built.
                downloads = [s for s in job['steps'] if 'name: polis-version-tool' in s]
                self.assertEqual(len(downloads), 1)
                self.assertTrue(field(downloads[0], 'uses').startswith('actions/download-artifact@'))
                self.assertIn('--tool "$VERSION_TOOL"', text)
                self.assertIn('VERSION_TOOL: ${{ runner.temp }}/tool/polis-version', text)
            if 'contents: write' in job['header']:
                self.assertIn((name, job_name), holding)
        self.assertEqual(sorted(compiling), [('polis-cli-release-build.yml', 'build'),
                                             ('polis-promotion-prepare.yml', 'tool'),
                                             ('polis-release.yml', 'tool')])
        self.assertEqual(sorted(holding), [('polis-promotion-prepare.yml', 'prepare'), ('polis-release.yml', 'plan'),
                                           ('polis-release.yml', 'publish'), ('polis-release.yml', 'review')])
        for name in ('polis-release.yml', 'polis-promotion-prepare.yml'):
            tool = parse(name)['tool']
            self.assertIn("if: github.ref == 'refs/heads/edge'", tool['header'])
            upload = [s for s in tool['steps'] if 'name: polis-version-tool' in s]
            self.assertEqual(len(upload), 1)
            self.assertTrue(field(upload[0], 'uses').startswith('actions/upload-artifact@'))
            self.assertIn('path: ${{ runner.temp }}/version-target/debug/polis-version', upload[0])
            self.assertNotIn('permissions:', tool['header'])

    def test_native_builder_packages_only_the_stable_release_binary(self):
        steps = parse('polis-cli-release-build.yml')['build']['steps']
        builds = [s for s in steps if 'build-polis-cli-release.py --target' in (script(s) or '')]
        self.assertEqual(len(builds), 1)
        self.assertEqual(env(builds[0])['RELEASE_TAG'], '${{ inputs.tag }}')
        self.assertEqual(env(builds[0])['RELEASE_COMMIT'], '${{ inputs.commit }}')
        self.assertIn('--release-tag "$RELEASE_TAG" --release-commit "$RELEASE_COMMIT"', script(builds[0]))
        # The local tag that gives the build its stable identity comes first.
        tagging = next(i for i, s in enumerate(steps) if 'git tag "$RELEASE_TAG" "$RELEASE_COMMIT"' in s)
        self.assertLess(tagging, steps.index(builds[0]))


if __name__ == '__main__':
    unittest.main()
