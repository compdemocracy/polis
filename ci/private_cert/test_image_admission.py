import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from control import encoded, sha
import image_admission as images


def recipe(role):
    return {'schema': 'polis-private-image-recipe/1', 'role': role,
            'sourceCommit': ('a' if role == 'producer' else 'b') * 40,
            'candidateSha': 'c' * 40, 'oracleSha': 'd' * 40, 'policySha256': 'e' * 64,
            'runtimeImage': 'localhost/synthetic-runtime@sha256:' + 'f' * 64,
            'entrypoint': 'gate.py', 'files': {'gate.py': hashlib.sha256(b'# synthetic test only\n').hexdigest()},
            'gates': sorted(images.GATES)}


def config(r):
    return {'User': '65534:65534',
            'Entrypoint': ['/usr/bin/python3', '/opt/polis-private-image/launcher.py'],
            'Cmd': [], 'WorkingDir': '/opt/polis-private-image',
            'Env': ['HOME=/tmp', 'PATH=/usr/bin'],
            'Labels': {'org.polis.private.role': r['role'], 'org.polis.private.recipe': sha(r)}}


def tar_bytes(files):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as t:
        for name, raw in files.items():
            m = tarfile.TarInfo(name)
            m.size = len(raw)
            t.addfile(m, io.BytesIO(raw))
    return out.getvalue()


def oci(path, r, *, config_patch=None, platform='arm64', source_patch=None, extra=False, corrupt=False):
    files = {'opt/polis-private-image/recipe.json': encoded(r),
             'opt/polis-private-image/launcher.py': (Path(images.__file__).parent / 'images/launcher.py').read_bytes(),
             'opt/polis-private-image/payload/gate.py': b'# synthetic test only\n'}
    files.update(source_patch or {})
    layer = tar_bytes(files)
    image_config = config(r)
    image_config.update(config_patch or {})
    cfg = encoded({'architecture': platform, 'os': 'linux', 'config': image_config,
                   'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + hashlib.sha256(layer).hexdigest()]}})
    blobs = {}
    def desc(raw, media):
        digest = hashlib.sha256(raw).hexdigest()
        blobs['blobs/sha256/' + digest] = raw
        return {'mediaType': media, 'digest': 'sha256:' + digest, 'size': len(raw)}
    manifest = encoded({'schemaVersion': 2, 'mediaType': images.MANIFEST,
                        'config': desc(cfg, images.CONFIG), 'layers': [desc(layer, images.LAYER)]})
    index = encoded({'schemaVersion': 2, 'manifests': [desc(manifest, images.MANIFEST)]})
    if corrupt:
        key = next(iter(blobs))
        blobs[key] = b'X' + blobs[key][1:]
    if extra:
        blobs['unexpected'] = b'unknown'
    path.write_bytes(tar_bytes({'oci-layout': encoded({'imageLayoutVersion': '1.0.0'}),
                                'index.json': index, **blobs}))
    return path


def review(recipes):
    return {'schema': 'polis-private-image-review/1',
            'recipeSha256': {k: sha(v) for k, v in recipes.items()},
            'controls': {k: 'PASS' for k in images.CONTROLS}, 'gateReviewSha256': '1' * 64}


class ImageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.recipes = {r: recipe(r) for r in images.ROLES}
        self.paths = {r: oci(self.root / (r + '.tar'), self.recipes[r]) for r in images.ROLES}

    def lock(self):
        return images.make_lock(self.paths['producer'], self.paths['verifier'], self.recipes, review(self.recipes))

    def admission(self, lock):
        return {'candidateSha': 'c'*40, 'oracleSha': 'd'*40, 'policySha256': 'e'*64,
                'runnerImage': 'localhost/producer@' + lock['images']['producer']['manifestDigest'],
                'verifierImage': 'localhost/verifier@' + lock['images']['verifier']['manifestDigest']}

    def test_real_digest_closure_not_config_or_tar_id(self):
        lock = self.lock()
        images.validate_lock(lock, self.admission(lock))
        for entry in lock['images'].values():
            self.assertEqual(len({entry['manifestDigest'][7:], entry['configDigest'][7:], entry['archiveSha256']}), 3)

    def test_corrupt_blob_rejected(self):
        oci(self.paths['producer'], self.recipes['producer'], corrupt=True)
        with self.assertRaisesRegex(ValueError, 'BLOB_DIGEST'):
            self.lock()

    def test_extra_archive_member_rejected(self):
        oci(self.paths['producer'], self.recipes['producer'], extra=True)
        with self.assertRaisesRegex(ValueError, 'UNREFERENCED'):
            self.lock()

    def test_wrong_platform_rejected(self):
        oci(self.paths['producer'], self.recipes['producer'], platform='amd64')
        with self.assertRaisesRegex(ValueError, 'PLATFORM'):
            self.lock()

    def test_forged_source_label_cannot_hide_changed_file(self):
        oci(self.paths['producer'], self.recipes['producer'], source_patch={
            'opt/polis-private-image/payload/gate.py': b'forged code'})
        with self.assertRaisesRegex(ValueError, 'SOURCE_CLOSURE'):
            self.lock()

    def test_unexpected_image_source_rejected(self):
        oci(self.paths['verifier'], self.recipes['verifier'], source_patch={
            'opt/polis-private-image/payload/extra.py': b'extra'})
        with self.assertRaisesRegex(ValueError, 'SOURCE_CLOSURE'):
            self.lock()

    def test_wrong_entrypoint_user_and_ambient_env_rejected(self):
        for change in ({'User': '0'}, {'Entrypoint': ['/bin/sh']}, {'Cmd': ['produce']},
                       {'Volumes': {'/host': {}}}, {'Env': ['AWS_ACCESS_KEY_ID=synthetic']},
                       {'OnBuild': ['RUN anything']}):
            with self.subTest(change=change):
                oci(self.paths['producer'], self.recipes['producer'], config_patch=change)
                with self.assertRaises(ValueError):
                    self.lock()

    def test_review_missing_failed_or_wrong_recipe_is_rejected(self):
        good = review(self.recipes)
        for mutate in (lambda r: r['controls'].pop('forged-evidence'),
                       lambda r: r['controls'].update({'forged-evidence': 'FAIL'}),
                       lambda r: r['recipeSha256'].update({'verifier': '0'*64})):
            r = copy.deepcopy(good)
            mutate(r)
            with self.assertRaises(ValueError):
                images.make_lock(self.paths['producer'], self.paths['verifier'], self.recipes, r)

    def test_moving_runtime_tag_missing_gate_or_private_source_rejected(self):
        for change in ({'runtimeImage': 'localhost/runtime:latest'}, {'gates': ['strict']},
                       {'files': {'real_data/private.json': 'a'*64}}, {'files': {'../gate.py': 'a'*64}},
                       {'sourceCommit': 'edge'}, {'development': True}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                images.validate_recipe({**self.recipes['producer'], **change})

    def test_admission_tuple_and_lock_binding(self):
        lock = self.lock()
        a = self.admission(lock)
        runtime = {'image-lock.json': sha(lock)}
        a['runtimeSha256'] = sha(runtime)
        images.bind_runtime_lock(lock, runtime, a)
        for key in ('candidateSha', 'oracleSha', 'policySha256', 'runnerImage', 'verifierImage'):
            bad = {**a, key: 'wrong'}
            with self.subTest(key=key), self.assertRaises(ValueError):
                images.bind_runtime_lock(lock, runtime, bad)
        runtime['image-lock.json'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'RUNTIME_BINDING'):
            images.bind_runtime_lock(lock, runtime, a)

    def test_preloaded_digest_inspection_never_pulls(self):
        lock = self.lock()
        a = self.admission(lock)
        def inspect(cmd, **kwargs):
            role = 'verifier' if 'verifier' in cmd[-1] else 'producer'
            e = lock['images'][role]
            return subprocess.CompletedProcess(cmd, 0, encoded([{
                'Digest': e['manifestDigest'], 'Id': e['configDigest'],
                'Os': 'linux', 'Architecture': 'arm64', 'Config': config(e['recipe'])}]))
        with patch('image_admission.subprocess.run', side_effect=inspect) as run:
            images.check_preloaded(lock, a, verifier_only=True)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][:3], ['podman', 'image', 'inspect'])
        with patch('image_admission.subprocess.run', return_value=subprocess.CompletedProcess([], 0, b'[]')):
            with self.assertRaisesRegex(ValueError, 'MISSING'):
                images.check_preloaded(lock, a)

    def test_docker_export_is_deterministic_and_preserves_source_closure(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('export_oci', Path(images.__file__).parent / 'images/export_oci.py')
        exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(exporter)
        with tarfile.open(self.paths['producer']) as src:
            index = images.json_bytes(src.extractfile('index.json').read())
            manifest = images.json_bytes(src.extractfile('blobs/sha256/' + index['manifests'][0]['digest'][7:]).read())
            config_bytes = src.extractfile('blobs/sha256/' + manifest['config']['digest'][7:]).read()
            layer_bytes = src.extractfile('blobs/sha256/' + manifest['layers'][0]['digest'][7:]).read()
        docker = self.root / 'docker.tar'
        docker.write_bytes(tar_bytes({'manifest.json': encoded([{'Config': 'config.json', 'Layers': ['layer.tar']}]),
                                     'config.json': config_bytes, 'layer.tar': layer_bytes}))
        a, b = self.root / 'a.oci.tar', self.root / 'b.oci.tar'
        self.assertEqual(exporter.convert(docker, a), exporter.convert(docker, b))
        self.assertEqual(a.read_bytes(), b.read_bytes())
        self.assertEqual(images.inspect_oci(a)['privateFiles'], images.inspect_oci(self.paths['producer'])['privateFiles'])
        with self.assertRaises(FileExistsError):
            exporter.convert(docker, a)

    def test_stager_rejects_dirty_bytes_even_with_matching_recipe_hash(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('image_stage', Path(images.__file__).parent / 'images/stage.py')
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        source = self.root / 'source'
        source.mkdir()
        (source / 'gate.py').write_bytes(b'changed code')
        r = self.recipes['producer']
        r['files']['gate.py'] = images.file_digest(source / 'gate.py')
        with patch.object(stage.subprocess, 'check_output', side_effect=[r['sourceCommit'], b'gate.py', b'committed code']):
            with self.assertRaisesRegex(ValueError, 'UNREVIEWED_SOURCE_BYTES'):
                stage.stage(source, r, self.root / 'context')
        self.assertFalse((self.root / 'context').exists())

    def test_stager_rejects_mismatched_engine_commit(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('image_stage', Path(images.__file__).parent / 'images/stage.py')
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        source = self.root / 'source'
        path = source / 'delphi/polismath/gate.py'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'committed code')
        r = {**self.recipes['producer'], 'entrypoint': 'delphi/polismath/gate.py',
             'files': {'delphi/polismath/gate.py': images.file_digest(path)}}
        with patch.object(stage.subprocess, 'check_output', side_effect=[r['sourceCommit'], b'tracked', b'committed code', b'other engine commit']):
            with self.assertRaisesRegex(ValueError, 'ENGINE_SOURCE_COMMIT_BINDING'):
                stage.stage(source, r, self.root / 'context')
        self.assertFalse((self.root / 'context').exists())

    def test_stager_copies_only_reviewed_files_and_requires_new_context(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('image_stage', Path(images.__file__).parent / 'images/stage.py')
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        source = self.root / 'source'
        source.mkdir()
        raw = b'# synthetic test only\n'
        (source / 'gate.py').write_bytes(raw)
        (source / 'ambient.txt').write_bytes(b'must not enter image')
        r = self.recipes['verifier']
        with patch.object(stage.subprocess, 'check_output', side_effect=[r['sourceCommit'], b'gate.py', raw]*2):
            stage.stage(source, r, self.root / 'context')
            with self.assertRaises(FileExistsError):
                stage.stage(source, r, self.root / 'context')
        self.assertEqual(list((self.root / 'context/payload').iterdir()), [self.root / 'context/payload/gate.py'])

    def test_duplicate_json_rejected(self):
        with self.assertRaisesRegex(ValueError, 'DUPLICATE'):
            images.json_bytes(b'{"schema":1,"schema":1}')


if __name__ == '__main__':
    unittest.main()
