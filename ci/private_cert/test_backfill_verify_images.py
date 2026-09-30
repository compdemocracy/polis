"""Backfill-verify images: recipes, admission, the registry entry, the launcher
and each role's self-contained source closure.

Dependency-free; no runtime/cloud build.
"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'images'))
sys.path.insert(0, str(HERE.parent / 'probe_box'))
from control import encoded, sha
from image_admission import validate_recipe
from test_roles_images import archive
from contracts import validate_job
import backfill_verify as bv
from backfill_verify_queries import SQL_SHA256
from backfill_verify_recipe import recipe
from backfill_verify_registry import admit

SQL = 'ci/probe_box/backfill_verification.sql'


def job():
    return validate_job(dict(schema='polis-probe-job/2', kind='backfill-verify', run_id='c' * 32, max_seconds=7200,
                             run_spec=dict(bv.TEMPLATE_RUN_SPEC, cutoff_ms=1_899_999_400_000),
                             reader={'image': 'localhost/polis-verify-reader@sha256:' + '1' * 64, 'args': ['read']},
                             producer={'image': 'localhost/polis-verify-producer@sha256:' + '2' * 64, 'args': ['produce']},
                             verifier={'image': 'localhost/polis-verify-verifier@sha256:' + '3' * 64, 'args': ['verify']}))


class Images(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.recipes = {r: recipe(REPO, r, 'localhost/runtime@sha256:' + '1' * 64)
                        for r in ('reader', 'producer', 'verifier')}

    def review(self):
        return dict(schema='polis-verify-image-review/1', recipeSha256={r: sha(s) for r, s in self.recipes.items()},
                    reviewSha256='2' * 64)

    def test_recipes_are_closed_per_role(self):
        for role, r in self.recipes.items():
            files = r['files']
            self.assertEqual(r['kind'], 'backfill-verify')
            self.assertEqual(r['policySha256'], bv.POLICY_SHA)
            self.assertEqual(r['entrypoint'], f'ci/private_cert/images/backfill_verify_{role}.py')
            self.assertFalse(any(p.startswith(('delphi/', 'math/')) for p in files))
            self.assertEqual(SQL in files, role == 'reader')
            for other in {'reader', 'producer', 'verifier'} - {role}:
                self.assertNotIn(f'ci/private_cert/images/backfill_verify_{other}.py', files)
        self.assertEqual(self.recipes['reader']['files'][SQL], SQL_SHA256)

    def test_admission_refuses_foreign_closures(self):
        for role, extra in (('reader', 'delphi/polismath/__init__.py'), ('verifier', 'math/deps.edn')):
            r = copy.deepcopy(self.recipes[role])
            r['files'][extra] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'VERIFY_SOURCE_CLOSURE'):
                validate_recipe(r)
        with self.assertRaisesRegex(ValueError, 'VERIFY_ENTRYPOINT'):
            validate_recipe(dict(self.recipes['reader'], entrypoint='ci/probe_box/backfill_verify.py'))
        with self.assertRaisesRegex(ValueError, 'VERIFY_POLICY'):
            validate_recipe(dict(self.recipes['reader'], policySha256='0' * 64))
        with self.assertRaisesRegex(ValueError, 'INCOMPLETE_IMAGE_GATES'):
            validate_recipe(dict(self.recipes['reader'], gates=['light-shadow-compare']))

    def test_registry_admits_three_archives_into_the_template_job(self):
        paths = {r: archive(self.root / (r + '.oci.tar'), s, REPO) for r, s in self.recipes.items()}
        job_, images = admit(paths, self.recipes, self.review())
        self.assertEqual(job_['run_spec'], bv.TEMPLATE_RUN_SPEC)
        self.assertEqual(len({i['manifestDigest'] for i in images.values()}), 3)
        registry = json.loads((REPO / 'ci/probe_box/jobs.json').read_bytes())['jobs']['math-backfill-verify-v1']
        self.assertEqual({k: v for k, v in job_.items() if k not in ('reader', 'producer', 'verifier')},
                         {k: v for k, v in registry.items() if k not in ('reader', 'producer', 'verifier')})
        with self.assertRaises(ValueError):
            admit(dict(paths, reader=paths['producer']), self.recipes, self.review())
        review = self.review()
        review['schema'] = 'polis-shadow-image-review/1'
        with self.assertRaisesRegex(ValueError, 'VERIFY_IMAGE_REVIEW'):
            admit(paths, self.recipes, review)

    def test_reader_must_carry_exactly_the_reviewed_sql(self):
        paths = {r: archive(self.root / (r + '.oci.tar'), s, REPO) for r, s in self.recipes.items()}
        for role, change in (('reader', lambda f: f.pop(SQL)), ('producer', lambda f: f.update({SQL: SQL_SHA256})),
                             ('reader', lambda f: f.update({SQL: '0' * 64}))):
            recipes = copy.deepcopy(self.recipes)
            change(recipes[role]['files'])
            self.recipes, saved = recipes, self.recipes
            review = self.review()
            self.recipes = saved
            with self.assertRaisesRegex(ValueError, 'VERIFY_IMAGE_SQL'):
                admit(paths, recipes, review)

    def test_launcher_admits_only_the_role_action(self):
        import launcher
        original_read = Path.read_bytes
        for role, action in (('reader', 'read'), ('producer', 'produce'), ('verifier', 'verify')):
            root = self.root / role
            r = self.recipes[role]
            self.stage(root / 'payload', r)
            (root / 'recipe.json').write_bytes(encoded(r))

            def read(path, r=r):
                if str(path) == '/run-spec/inputs.json':
                    return encoded({k: r[k] for k in ('candidateSha', 'oracleSha', 'policySha256')})
                return original_read(path)
            with patch.object(launcher, 'ROOT', root), patch.object(launcher.sys, 'argv', ['launcher', action]), \
                 patch.object(Path, 'read_bytes', read), patch.object(launcher.os, 'chdir'), \
                 patch.object(launcher.os, 'execve') as execute:
                launcher.main()
                self.assertEqual(execute.call_args.args[1][-1], action)
            with patch.object(launcher, 'ROOT', root), patch.object(launcher.sys, 'argv', ['launcher', 'extract']):
                with self.assertRaisesRegex(ValueError, 'IMAGE_ACTION'):
                    launcher.main()

    def stage(self, payload, r):
        for name in r['files']:
            target = payload / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((REPO / name).read_bytes())

    def test_each_closure_runs_isolated(self):
        """Only the recipe's own files, under python -I: the image's import view."""
        checks = {'reader': 'import backfill_verify_reader as r; from backfill_verify_queries import shipped_statements; '
                            'assert len(shipped_statements(r.SQL_PATH.read_bytes())) == 5',
                  'producer': 'import backfill_verify_producer',
                  'verifier': 'import json, backfill_verify_verifier as v; from contracts import validate_job; '
                              'job = validate_job(json.loads(open("job.json").read())); '
                              'assert all(v.controls(job).values())'}
        for role, code in checks.items():
            with self.subTest(role=role):
                payload = self.root / ('closure-' + role)
                self.stage(payload, self.recipes[role])
                entry = payload / 'ci/private_cert/images'
                (entry / 'job.json').write_text(json.dumps(job()))
                subprocess.run([sys.executable, '-I', '-B', '-c', 'import sys; sys.path.insert(0, "."); ' + code],
                               cwd=entry, check=True, timeout=300,
                               env={'PATH': '/usr/bin:/bin', 'HOME': str(self.root)})


if __name__ == '__main__':
    unittest.main()
