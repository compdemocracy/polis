"""Light-shadow images: certified comparison vectors, producer/verifier split,
receipt controls, recipes, admission and the self-contained source closure.

Needs the delphi engine dependencies (numpy, pandas); no runtime/cloud build.
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
sys.path.insert(0, str(REPO / 'delphi'))
from control import encoded, sha
from image_admission import validate_recipe
from test_roles_images import archive
from contracts import validate_job
from receipt import decode_receipt, LEGACY_EMPTY_KEYS
import light_shadow as ls
import light_shadow_compare as compare
import light_shadow_producer as producer
import light_shadow_verifier as verifier
from light_shadow_recipe import recipe
from light_shadow_registry import admit

SPEC = dict(ls.TEMPLATE_RUN_SPEC, shadow_started_ms=1_800_000_000_000, engine_commit='a' * 40,
            engine_image='sha256:' + 'b' * 64)


def job():
    return validate_job(dict(schema='polis-probe-job/2', kind='light-shadow-compare', run_id='c' * 32,
                             max_seconds=3600, run_spec=dict(SPEC),
                             reader={'image': 'localhost/polis-shadow-reader@sha256:' + '1' * 64, 'args': ['read']},
                             producer={'image': 'localhost/polis-shadow-producer@sha256:' + '2' * 64, 'args': ['produce']},
                             verifier={'image': 'localhost/polis-shadow-verifier@sha256:' + '3' * 64, 'args': ['verify']}))


class CertifiedConstants(unittest.TestCase):
    def test_policy_names_match_the_certified_modules(self):
        from polismath.replay import certify, legacy_pca
        import near_ties
        self.assertEqual(set(ls.ACCEPTANCE_KEYS), set(certify.ACCEPTANCE_KEYS))
        self.assertEqual(ls.NEAR_TIE_KEYS, legacy_pca.DOWNSTREAM_KEYS)
        self.assertEqual(sorted(ls.NEAR_TIE_KEYS), near_ties.PATHS)
        self.assertEqual(certify._DECLARED_ALIAS_FIELDS['group-clusters'][0], ls.PYTHON_TWIN)
        self.assertTrue(set(compare.empty_output()) <= LEGACY_EMPTY_KEYS | {'lastVoteTimestamp'})

    def test_certification_policy_is_the_gate_policy(self):
        import gate
        self.assertEqual(gate.sha(gate.POLICY), ls.CERTIFICATION_POLICY)


class Comparison(unittest.TestCase):
    def setUp(self):
        self.declared = compare.empty_output()

    def classify(self, prod, shadow):
        row = compare.classify(1, prod, shadow, self.declared)
        ls.validate_entry(row, ls.EVIDENCE)
        return row

    def test_every_fixture_vector(self):
        want = {'pass': ('PAIRED', None, 'PASS'), 'near-tie': ('PAIRED', None, 'NEAR-TIE-CANDIDATE'),
                'history': ('PAIRED', None, 'HISTORY-DIVERGENCE'), 'fail': ('PAIRED', None, 'FAIL'),
                'legacy-empty': ('PAIRED', None, 'PASS'), 'timestamps': ('UNPAIRED', 'TIMESTAMPS', None),
                'totals': ('UNPAIRED', 'TOTALS', None), 'no-prod-row': ('UNPAIRED', 'NO-PROD-ROW', None),
                'no-shadow-row': ('UNPAIRED', 'NO-SHADOW-ROW', None)}
        variants = compare.fixture_variants()
        self.assertEqual(set(variants), set(want))
        for name, (prod, shadow) in variants.items():
            with self.subTest(name=name):
                row = self.classify(prod, shadow)
                self.assertEqual((row['pairing'], row['unpaired'], row['outcome']), want[name])
        self.assertEqual(self.classify(*variants['legacy-empty'])['legacy_defect'], ls.EMPTY_DEFECT)

    def test_tolerance_is_g12(self):
        base = compare.fixture_blob()
        close, far = copy.deepcopy(base), copy.deepcopy(base)
        close['pca']['center'] = [0.1 * (1 + 5e-5), 0.2]
        far['pca']['center'] = [0.1 * (1 + 5e-3), 0.2]
        self.assertEqual(self.classify(base, close)['outcome'], 'PASS')
        row = self.classify(base, far)
        self.assertEqual((row['outcome'], row['differing'], row['g12_outliers']), ('HISTORY-DIVERGENCE', ['pca'], 1))
        self.assertEqual(row['worst_abs'], ls.rounded(abs(0.1 * 5e-3)))

    def test_discrete_fields_are_exact(self):
        base = compare.fixture_blob()
        for key, value in (('tids', [0, 2]), ('in-conv', [0, 1]), ('mod-out', [1]), ('meta-tids', [0])):
            other = copy.deepcopy(base)
            other[key] = value
            with self.subTest(key=key):
                self.assertEqual(self.classify(base, other)['outcome'], 'FAIL')

    def test_axis_sign_and_tick_counters_do_not_count(self):
        base = compare.fixture_blob()
        flipped = copy.deepcopy(base)
        flipped['pca']['comps'][0] = [-v for v in flipped['pca']['comps'][0]]
        flipped['pca']['comment-projection'][0] = [-v for v in flipped['pca']['comment-projection'][0]]
        flipped['math_tick'] = 99
        flipped['caching_tick'] = 3
        self.assertEqual(self.classify(base, flipped)['outcome'], 'PASS')

    def test_structure_is_never_a_triage_class(self):
        for name, (prod, shadow) in compare.structural_variants().items():
            with self.subTest(name=name):
                row = self.classify(prod, shadow)
                self.assertEqual((row['pairing'], row['outcome']), ('PAIRED', 'FAIL'))
                self.assertIn('row-schema', row['differing'])
        # Cluster cardinality may differ without being structure.
        base = compare.fixture_blob()
        more = copy.deepcopy(base)
        more['group-clusters'].append({'id': 1, 'members': [0], 'center': [1.0, 1.0]})
        row = self.classify(base, more)
        self.assertEqual((row['outcome'], row['differing']), ('NEAR-TIE-CANDIDATE', ['group-clusters']))

    def test_malformed_rows_fail_and_never_raise(self):
        base = compare.fixture_blob()
        for bad in (dict(base, n='3'), dict(base, **{'group_clusters': 'x'}), dict(base, tids='x')):
            with self.subTest(bad=list(bad)[-1]):
                row = self.classify(base, bad)
                self.assertEqual(row['outcome'], 'FAIL')


class Verifier(unittest.TestCase):
    def setUp(self):
        self.job = job()
        self.declared = compare.empty_output()
        self.p = verifier.fixture_projection(SPEC, self.declared)

    def test_controls_all_hold(self):
        c = verifier.controls(self.job, self.declared)
        self.assertEqual(set(c) | set(ls.LIVE_CONTROLS), set(ls.CONTROLS))
        self.assertTrue(all(c.values()), c)

    def test_producer_evidence_reproduced_and_exported(self):
        produced = producer.produce(self.p, SPEC)
        r = verifier.export(self.p, produced, self.job, '1' * 40, self.declared)
        self.assertEqual(decode_receipt(encoded(r), self.job), r)
        self.assertEqual(r['verdict'], 'OPERATIONAL-FAIL')
        self.assertEqual(r['totals']['FAIL'], 1)
        self.assertNotIn('zid', encoded(r).decode())
        clean = copy.deepcopy(self.p)
        clean['conversations'] = [c for c in clean['conversations']
                                  if compare.classify(1, c['prod'], c['shadow'], self.declared)['outcome'] != 'FAIL']
        clean['catalog']['active'] = len(clean['conversations'])
        r = verifier.export(clean, producer.produce(clean, SPEC), self.job, '1' * 40, self.declared)
        self.assertEqual(r['verdict'], 'OPERATIONAL-ATTENTION')
        self.assertEqual((r['totals']['NEAR-TIE-CANDIDATE'], r['totals']['HISTORY-DIVERGENCE'],
                          r['totals']['triage_required'], r['triage']['required']), (1, 1, 2, 2))
        flagged = sorted([c['zid'], c['shadow']['lastVoteTimestamp'], c['shadow']['lastModTimestamp']]
                         for c in clean['conversations']
                         if compare.classify(1, c['prod'], c['shadow'], self.declared)['outcome']
                         in ('NEAR-TIE-CANDIDATE', 'HISTORY-DIVERGENCE'))
        self.assertEqual(r['triage']['sha256'], ls.triage_digest(flagged))
        spec = ls.triage_spec(r, self.job)
        self.assertEqual(spec['conversations'], 2)
        calm = copy.deepcopy(clean)
        calm['conversations'] = [c for c in calm['conversations']
                                 if c['prod'] is not None and c['shadow'] is not None
                                 and compare.classify(1, c['prod'], c['shadow'], self.declared)['outcome']
                                 not in ('NEAR-TIE-CANDIDATE', 'HISTORY-DIVERGENCE')]
        calm['catalog']['active'] = len(calm['conversations'])
        r = verifier.export(calm, producer.produce(calm, SPEC), self.job, '1' * 40, self.declared)
        # Two paired of four active: exactly the coverage floor.
        self.assertEqual((r['verdict'], r['totals']['PAIRED'], r['totals']['UNPAIRED']), ('OPERATIONAL-PASS', 2, 2))

    def one(self, prod, shadow):
        p = copy.deepcopy(self.p)
        p['conversations'] = [dict(zid=1, created=1_700_000_000_000, prod=prod, shadow=shadow)]
        p['catalog']['active'] = 1
        r = verifier.export(p, producer.produce(p, SPEC), self.job, '1' * 40, self.declared)
        self.assertEqual(decode_receipt(encoded(r), self.job), r)
        self.assertTrue(all(r['controls'].values()))
        return r

    def test_structural_defects_fail_through_the_full_export_path(self):
        for name, (prod, shadow) in compare.structural_variants().items():
            with self.subTest(name=name):
                r = self.one(prod, shadow)
                self.assertEqual((r['conversations'][0]['outcome'], r['verdict']), ('FAIL', 'OPERATIONAL-FAIL'))
        r = self.one(*compare.fixture_empty_pair())
        self.assertEqual((r['conversations'][0]['legacy_defect'], r['verdict']), (ls.EMPTY_DEFECT, 'OPERATIONAL-PASS'))

    def test_unproven_differences_are_attention_not_pass(self):
        base = compare.fixture_blob()
        count = copy.deepcopy(base)
        count['votes-base']['0']['A'] = [999999]
        center = copy.deepcopy(base)
        center['pca']['center'] = [1e100, 1e100]
        for shadow in (count, center):
            r = self.one(base, shadow)
            self.assertEqual(r['verdict'], 'OPERATIONAL-ATTENTION')
            self.assertEqual(r['triage']['required'], 1)

    def test_one_pair_among_missing_shadows_is_incomplete(self):
        p = copy.deepcopy(self.p)
        base = compare.fixture_blob()
        p['conversations'] = [dict(zid=z, created=None, prod=copy.deepcopy(base),
                                   shadow=copy.deepcopy(base) if z == 1 else None) for z in range(1, 251)]
        p['catalog']['active'] = 250
        r = verifier.export(p, producer.produce(p, SPEC), self.job, '1' * 40, self.declared)
        self.assertEqual((r['verdict'], r['totals']['PAIRED'], r['totals']['NO-SHADOW-ROW']), ('INCOMPLETE', 1, 249))

    def test_forged_evidence_and_projection_are_refused(self):
        produced = producer.produce(self.p, SPEC)
        for mutate in (lambda e: e.pop(), lambda e: e[0].update(zid=99), lambda e: e[1].update(worst_abs=0.0),
                       lambda e: e.reverse()):
            forged = copy.deepcopy(produced)
            mutate(forged)
            with self.assertRaisesRegex(ValueError, 'SHADOW_RECONSTRUCTION'):
                verifier.receipt(self.p, forged, self.job, '1' * 40, self.declared)
        with self.assertRaisesRegex(ValueError, 'SHADOW_RECONSTRUCTION'):
            verifier.receipt(self.p, produced, self.job, '2' * 40, self.declared)
        with self.assertRaises(ValueError):
            verifier.receipt(dict(self.p, shadow_env='prod'), produced, self.job, '1' * 40, self.declared)

    def test_live_checks_fail_the_run(self):
        produced = producer.produce(self.p, SPEC)
        for catalog in ({'no_write': False}, {'prod_main_after': 7}):
            p = copy.deepcopy(self.p)
            p['catalog'].update(catalog)
            r = verifier.export(p, produced, self.job, '1' * 40, self.declared)
            name = 'reader-no-write' if 'no_write' in catalog else 'prod-count-not-decreased'
            self.assertFalse(r['controls'][name])
            self.assertEqual(r['verdict'], 'OPERATIONAL-FAIL')
        p = copy.deepcopy(self.p)
        p['conversations'][0]['prod'] = dict(p['conversations'][0]['prod'] or {}, group_clusters=[])
        r = verifier.export(p, producer.produce(p, SPEC), self.job, '1' * 40, self.declared)
        self.assertFalse(r['controls']['shadow-label-not-prod'])
        self.assertEqual((r['rows']['prod_python_shape'], r['verdict']), (1, 'OPERATIONAL-FAIL'))

    def test_empty_and_unreadable_snapshots_are_incomplete(self):
        empty = dict(self.p, conversations=[], catalog=dict(self.p['catalog'], active=0))
        self.assertEqual(verifier.export(empty, [], self.job, '1' * 40, self.declared)['verdict'], 'INCOMPLETE')
        hidden = dict(empty, status='NOT_VISIBLE', window=None)
        self.assertEqual(verifier.export(hidden, [], self.job, '1' * 40, self.declared)['verdict'], 'INCOMPLETE')

    def test_oversize_receipt_becomes_incomplete_without_entries(self):
        produced = producer.produce(self.p, SPEC)
        with patch.object(verifier, 'LIMIT', 2000):
            r = verifier.export(self.p, produced, self.job, '1' * 40, self.declared)
        self.assertEqual((r['verdict'], r['coverage']['status'], r['conversations']),
                         ('INCOMPLETE', 'LIMIT_EXCEEDED', []))


class Images(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.recipes = {r: recipe(REPO, r, 'localhost/runtime@sha256:' + '1' * 64)
                        for r in ('reader', 'producer', 'verifier')}

    def test_recipes_are_closed_per_role(self):
        reader = self.recipes['reader']['files']
        self.assertFalse(any(p.startswith(('delphi/', 'math/')) for p in reader))
        self.assertNotIn('ci/private_cert/images/light_shadow_compare.py', reader)
        for role in ('producer', 'verifier'):
            files = self.recipes[role]['files']
            self.assertIn('ci/private_cert/images/g12.py', files)
            self.assertIn('delphi/polismath/replay/certify.py', files)
            self.assertFalse(any(p.startswith('math/') for p in files))
        self.assertNotIn('ci/private_cert/images/light_shadow_producer.py', self.recipes['verifier']['files'])
        self.assertNotIn('ci/private_cert/images/light_shadow_verifier.py', self.recipes['producer']['files'])

    def test_admission_refuses_foreign_closures(self):
        for role, extra in (('reader', 'delphi/polismath/__init__.py'), ('producer', 'math/deps.edn')):
            r = copy.deepcopy(self.recipes[role])
            r['files'][extra] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'SHADOW_SOURCE_CLOSURE'):
                validate_recipe(r)
        r = dict(self.recipes['reader'], entrypoint='ci/probe_box/light_shadow.py')
        with self.assertRaisesRegex(ValueError, 'SHADOW_ENTRYPOINT'):
            validate_recipe(r)
        with self.assertRaisesRegex(ValueError, 'SHADOW_POLICY'):
            validate_recipe(dict(self.recipes['reader'], policySha256='0' * 64))

    def test_registry_admits_three_archives_into_a_template_job(self):
        paths = {r: archive(self.root / (r + '.oci.tar'), s, REPO) for r, s in self.recipes.items()}
        review = dict(schema='polis-shadow-image-review/1', recipeSha256={r: sha(s) for r, s in self.recipes.items()},
                      reviewSha256='2' * 64)
        job, images = admit(paths, self.recipes, review)
        self.assertEqual(job['run_spec'], ls.TEMPLATE_RUN_SPEC)
        self.assertEqual(len({i['manifestDigest'] for i in images.values()}), 3)
        registry = json.loads((REPO / 'ci/probe_box/jobs.json').read_bytes())['jobs']['light-shadow-compare-v1']
        self.assertEqual({k: v for k, v in job.items() if k not in ('reader', 'producer', 'verifier')},
                         {k: v for k, v in registry.items() if k not in ('reader', 'producer', 'verifier')})
        with self.assertRaises(ValueError):
            admit(dict(paths, reader=paths['producer']), self.recipes, review)

    def test_launcher_admits_only_the_role_action(self):
        import launcher
        original_read = Path.read_bytes
        for role, action in (('reader', 'read'), ('producer', 'produce'), ('verifier', 'verify')):
            root = self.root / role
            payload = root / 'payload'
            r = self.recipes[role]
            self.stage(payload, r)
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
        checks = {'reader': 'import light_shadow_reader',
                  'producer': 'import light_shadow_producer, light_shadow_compare as c; '
                              'assert c.classify(1, *c.fixture_variants()["pass"], c.empty_output())["outcome"] == "PASS"',
                  'verifier': 'import json, light_shadow_verifier as v; from contracts import validate_job; '
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
