"""The same build identity is consumed by CLI, server and browser builds."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('build_identity', Path(__file__).parents[1] / 'build_identity.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA = 'a' * 40
BASE = 'b' * 40


class BuildIdentityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'VERSION').write_text('2.40.0\n')
        (self.root / 'VERSION_STABLE_COMMIT').write_text(BASE + '\n')

    def archive(self, **env):
        with patch.object(module, 'git', return_value=None):
            return module.identity(self.root, env)

    def test_tagged_archive(self):
        info = self.archive(GIT_HASH=SHA, POLIS_BUILD_DISTANCE='0',
                            POLIS_BUILD_TAG='v2.40.0', POLIS_BUILD_SOURCE='clean-checkout')
        self.assertEqual(info['version_display'], '2.40.0')
        self.assertEqual(info['distance'], 0)
        self.assertEqual(info['commit'], SHA)

    def test_untagged_archive(self):
        self.assertEqual(self.archive(GIT_HASH=SHA, POLIS_BUILD_DISTANCE='16')['version_display'],
                         '2.40.0+dev.16.aaaaaaaaaaaa')

    def test_no_git_or_metadata(self):
        info = self.archive()
        self.assertEqual(info['version_display'], '2.40.0+dev.unknown.unknown')
        self.assertIsNone(info['distance'])

    def test_existing_ci_labels_are_explicit(self):
        for label in ('test', 'characterization'):
            with self.subTest(label=label):
                info = self.archive(GIT_HASH=label, POLIS_BUILD_DISTANCE='16')
                self.assertEqual(info['commit'], label)
                self.assertEqual(info['source'], 'test-label')
                self.assertEqual(info['channel'], 'development')
                self.assertIsNone(info['distance'])
                self.assertEqual(info['version_display'], f'2.40.0+dev.unknown.{label[:12]}')

    def test_ci_label_cannot_claim_stable(self):
        for metadata in ({'POLIS_BUILD_TAG': 'v2.40.0'}, {'POLIS_BUILD_SOURCE': 'clean-checkout'}):
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                self.archive(GIT_HASH='test', **metadata)

    def test_invalid_metadata(self):
        for env in [dict(GIT_HASH='short'), dict(POLIS_BUILD_DISTANCE='-1'),
                    dict(POLIS_BUILD_TAG='v2.40.0'), dict(POLIS_BUILD_SOURCE='invalid'),
                    dict(GIT_HASH=SHA, POLIS_BUILD_DISTANCE='0', POLIS_BUILD_TAG='v2.40.0', POLIS_BUILD_SOURCE='development')]:
            with self.subTest(env=env), self.assertRaises(ValueError):
                self.archive(**env)

    def test_invalid_version(self):
        for value in ['02.40.0\n', '2.40.0', ' 2.40.0\n', '2.40.0\n\n', '2.40.0 # version\n']:
            (self.root / 'VERSION').write_text(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.archive()

    def checkout(self, *, clean=True, on_stable=True, tags='v2.40.0', shallow=False, env=None):
        def fake_git(root, *args):
            return {
                ('rev-parse', '--show-toplevel'): str(self.root),
                ('rev-parse', 'HEAD'): SHA,
                ('for-each-ref', '--points-at', SHA, '--format=%(refname:short)', 'refs/tags'): tags,
                ('rev-list', '--first-parent', 'origin/stable'): SHA + '\n' + BASE if on_stable else BASE,
                ('status', '--porcelain', '--untracked-files=normal'): '' if clean else ' M VERSION',
                ('rev-parse', '--is-shallow-repository'): 'true' if shallow else 'false',
                ('rev-list', '--first-parent', '--count', BASE + '..' + SHA): '16',
            }.get(args)
        with patch.object(module, 'git', side_effect=fake_git):
            return module.identity(self.root, env or {})

    def test_clean_tag_on_stable(self):
        self.assertEqual(self.checkout()['version_display'], '2.40.0')

    def test_edge_tag_cannot_assert_stable(self):
        self.assertEqual(self.checkout(on_stable=False)['version_display'], '2.40.0+dev.16.aaaaaaaaaaaa')

    def test_unverified_checkout_cannot_assert_stable(self):
        self.assertEqual(self.checkout(env={'POLIS_BUILD_SOURCE': 'unverified-archive'})['channel'], 'development')

    def test_dirty_tag_cannot_assert_stable(self):
        self.assertEqual(self.checkout(clean=False)['channel'], 'development')

    def test_untagged_checkout(self):
        self.assertEqual(self.checkout(tags='')['distance'], 16)

    def test_shallow_history_is_not_zero(self):
        self.assertIsNone(self.checkout(tags='', shallow=True)['distance'])
