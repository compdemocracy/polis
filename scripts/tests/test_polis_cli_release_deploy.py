"""Deploy identity from real disposable Git checkouts; no deployment commands."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('identity', ROOT / 'scripts/build_identity.py')
identity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(identity)


class DeployIdentityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.repo = self.directory / 'remote'
        self.repo.mkdir()
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_AUTHOR_NAME='Release Test', GIT_AUTHOR_EMAIL='release@example.invalid',
                        GIT_COMMITTER_NAME='Release Test', GIT_COMMITTER_EMAIL='release@example.invalid')
        self.git(self.repo, 'init', '--quiet', '--initial-branch=stable')
        self.git(self.repo, 'commit', '--quiet', '--allow-empty', '-m', 'Baseline')
        baseline = self.git(self.repo, 'rev-parse', 'HEAD')
        (self.repo / 'VERSION').write_text('2.42.2\n')
        (self.repo / 'VERSION_STABLE_COMMIT').write_text(baseline + '\n')
        (self.repo / '.gitignore').write_bytes((ROOT / '.gitignore').read_bytes())
        self.git(self.repo, 'add', 'VERSION', 'VERSION_STABLE_COMMIT', '.gitignore')
        self.git(self.repo, 'commit', '--quiet', '-m', 'Prepared source')
        self.commit = self.git(self.repo, 'rev-parse', 'HEAD')

    def git(self, root, *args):
        return subprocess.check_output(['git', '-C', str(root), *args], env=self.env,
                                       text=True, stderr=subprocess.PIPE).strip()

    def clone(self, name, *options):
        root = self.directory / name
        self.git(self.directory, 'clone', '--quiet', *options, self.repo.as_uri(), str(root))
        return root

    def test_publish_before_full_checkout_produces_stable_deploy_identity(self):
        untagged = self.clone('before-publication')
        self.assertEqual(identity.identity(untagged, {})['channel'], 'development')
        self.git(self.repo, 'tag', '-a', 'v2.42.2', '-m', 'Polis 2.42.2')
        shallow = self.clone('shallow', '--depth=1', '--no-tags')
        self.assertEqual(self.git(shallow, 'rev-parse', '--is-shallow-repository'), 'true')
        info = identity.identity(shallow, {})
        self.assertEqual(info['channel'], 'development')
        self.assertIsNone(info['distance'])

        full = self.clone('full')
        self.assertEqual(self.git(full, 'rev-parse', '--is-shallow-repository'), 'false')
        # The runner creates these before build-on-box computes identity. The
        # actual ignore rules must keep them from dirtying a published checkout.
        self.git(full, 'archive', '--format=tar.gz', '-o', 'build-source.tar.gz', 'HEAD')
        (full / 'build-box-instances.txt').write_text('')
        self.assertEqual(self.git(full, 'status', '--porcelain'), '')
        info = identity.identity(full, {})
        self.assertEqual(info, dict(version_base='2.42.2', version_display='2.42.2',
                                   commit=self.commit, distance=0, channel='stable', source='clean-checkout'))
        archive = self.directory / 'archive'
        archive.mkdir()
        (archive / 'VERSION').write_text('2.42.2\n')
        # Same metadata crossing the source-archive boundary in build-on-box.
        self.assertEqual(identity.identity(archive, dict(GIT_HASH=self.commit,
                         POLIS_BUILD_TAG='v2.42.2', POLIS_BUILD_DISTANCE=str(info['distance']),
                         POLIS_BUILD_SOURCE=info['source'])), info)

    def test_only_build_images_checkout_requires_complete_history(self):
        workflow = (ROOT / '.github/workflows/deploy-alpha-aws.yml').read_text()
        build, deploy = workflow.split('\n  deploy-us:\n', 1)
        checkout = build.split('      - name: Checkout code\n', 1)[1].split('\n      - name:', 1)[0]
        self.assertIn('fetch-depth: 0', checkout)
        self.assertNotIn('fetch-depth:', deploy)
        self.assertEqual(workflow.count('fetch-depth:'), 1)
        ci = (ROOT / '.github/workflows/polis-cli-ci.yml').read_text()
        self.assertEqual(ci.count("- '.github/workflows/deploy-alpha-aws.yml'"), 2)

    def test_check_tag_cli_uses_polis_version_instead_of_cargo_version(self):
        # Exercise the actual entry point with disagreeing Cargo/root versions.
        (self.repo / 'scripts').mkdir()
        for name in ('build_identity.py', 'build-polis-cli-release.py'):
            (self.repo / 'scripts' / name).write_bytes((ROOT / 'scripts' / name).read_bytes())
        (self.repo / 'polis-cli').mkdir()
        (self.repo / 'polis-cli/Cargo.toml').write_text('[workspace.package]\nversion = "0.1.0"\n')
        script = self.repo / 'scripts/build-polis-cli-release.py'
        for tag, valid in [('v2.42.2', True), ('cli-v0.1.0', False), ('cli-v2.42.2', False), ('v0.1.0', False)]:
            with self.subTest(tag=tag):
                result = subprocess.run([sys.executable, str(script), '--check-tag', tag],
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode == 0, valid, result.stderr)


if __name__ == '__main__':
    unittest.main()
