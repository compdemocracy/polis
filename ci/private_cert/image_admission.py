#!/usr/bin/env python3
"""Offline P-053 OCI closure/admission checks. Does not pull, build or publish.

An OCI manifest digest is not an image configuration ID or the tar SHA256.
The reviewer pins all three separately. Labels are cross-checks of an already
reviewed image, never proof of mathematical correctness or independence.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

from control import encoded, sha

SCHEMA = 'polis-private-images/1'
ROLES = {'producer': 'produce', 'verifier': 'verify'}
# BOARD [677]: step-2 paired-recording scope; shadow diagnostics are separate.
GATES = {'inventory', 'strict', 'g12'}
CONTROLS = {'missing-evidence', 'forged-evidence', 'truncated-evidence',
            'short-inventory', 'wrong-input', 'wrong-policy', 'stale-checkpoint',
            'candidate-control-isolation'}
HEX = re.compile(r'^[a-f0-9]{64}$')
COMMIT = re.compile(r'^[a-f0-9]{40}$')
IMAGE = re.compile(r'^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$')
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
CONFIG = 'application/vnd.oci.image.config.v1+json'
LAYER = 'application/vnd.oci.image.layer.v1.tar'
MAX_JSON = 4 * 1024 * 1024


def digest_stream(f):
    h = hashlib.sha256()
    size = 0
    for b in iter(lambda: f.read(1024 * 1024), b''):
        size += len(b)
        h.update(b)
    return h.hexdigest(), size


def file_digest(path):
    with Path(path).open('rb') as f:
        return digest_stream(f)[0]


def json_bytes(raw):
    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                raise ValueError('DUPLICATE_JSON_KEY')
            out[k] = v
        return out
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON')))


def regular_path(name):
    p = PurePosixPath(name)
    if (not name or p.is_absolute() or '..' in p.parts or str(p) != name
            or '\\' in name or any(ord(c) < 32 for c in name)):
        raise ValueError('UNSAFE_IMAGE_PATH')
    return p


def validate_recipe(recipe):
    fields = {'schema', 'role', 'sourceCommit', 'candidateSha', 'oracleSha',
              'policySha256', 'runtimeImage', 'files', 'entrypoint', 'gates'}
    if (type(recipe) is not dict or set(recipe) != fields
            or recipe['schema'] != 'polis-private-image-recipe/1'
            or recipe['role'] not in ROLES):
        raise ValueError('IMAGE_RECIPE_SCHEMA')
    for k in ('sourceCommit', 'candidateSha', 'oracleSha'):
        if not isinstance(recipe[k], str) or not COMMIT.fullmatch(recipe[k]):
            raise ValueError('IMAGE_SOURCE_PIN')
    if not isinstance(recipe['policySha256'], str) or not HEX.fullmatch(recipe['policySha256']):
        raise ValueError('IMAGE_POLICY_PIN')
    if not isinstance(recipe['runtimeImage'], str) or not IMAGE.fullmatch(recipe['runtimeImage']):
        raise ValueError('RUNTIME_IMAGE_PIN')
    if (not isinstance(recipe['gates'], list) or len(recipe['gates']) != len(GATES)
            or set(recipe['gates']) != GATES):
        raise ValueError('INCOMPLETE_IMAGE_GATES')
    files = recipe['files']
    if not isinstance(files, dict) or not files:
        raise ValueError('EMPTY_SOURCE_CLOSURE')
    for name, digest in files.items():
        p = regular_path(name)
        # Source-only context: no ambient checkout/private data/credential copy.
        if (any(part in {'.git', '.local', '.venv', '.aws', '.ssh', '__pycache__'}
                or part == '.env' or part.endswith('.env') for part in p.parts)
                or ('real_data' in p.parts and p.parts[:2] != ('delphi', 'real_data'))
                or not isinstance(digest, str) or not HEX.fullmatch(digest)):
            raise ValueError('UNSAFE_SOURCE_CLOSURE')
    if recipe['entrypoint'] not in files or not recipe['entrypoint'].endswith('.py'):
        raise ValueError('IMAGE_ENTRYPOINT')
    return recipe


def inspect_oci(path):
    """Validate one Linux ARM64 image and its entire referenced blob closure.

    Supports single-image OCI tar exports, gzip/plain layers, no attestations or
    multi-platform index. Export the ARM manifest explicitly; do not guess which
    platform or signature an index intended. No archive extraction occurs.
    """
    with tarfile.open(path, 'r:') as archive:
        members = {}
        for m in archive:
            name = m.name.rstrip('/') if m.isdir() else m.name
            regular_path(name)
            if m.isdir():
                continue
            if not m.isfile() or name in members or m.size < 0:
                raise ValueError('UNSAFE_OCI_MEMBER')
            members[name] = m
        used = set()
        def read(name, limit=MAX_JSON):
            if name not in members or members[name].size > limit:
                raise ValueError('MISSING_OR_OVERSIZE_OCI_JSON')
            used.add(name)
            return archive.extractfile(members[name]).read()
        if json_bytes(read('oci-layout')) != {'imageLayoutVersion': '1.0.0'}:
            raise ValueError('OCI_LAYOUT')
        index = json_bytes(read('index.json'))
        if index.get('schemaVersion') != 2 or len(index.get('manifests', [])) != 1:
            raise ValueError('SINGLE_OCI_IMAGE_REQUIRED')
        def descriptor(d, media):
            digest = d.get('digest', '')
            if (d.get('mediaType') != media or not digest.startswith('sha256:')
                    or not HEX.fullmatch(digest[7:]) or type(d.get('size')) is not int
                    or d['size'] < 0 or d.get('urls')):
                raise ValueError('OCI_DESCRIPTOR')
            name = 'blobs/sha256/' + digest[7:]
            if name not in members or members[name].size != d['size']:
                raise ValueError('OCI_BLOB_SIZE')
            used.add(name)
            with archive.extractfile(members[name]) as f:
                actual, size = digest_stream(f)
            if actual != digest[7:] or size != d['size']:
                raise ValueError('OCI_BLOB_DIGEST')
            return name
        md = index['manifests'][0]
        manifest = json_bytes(read(descriptor(md, MANIFEST)))
        if manifest.get('schemaVersion') != 2 or manifest.get('mediaType') != MANIFEST:
            raise ValueError('OCI_MANIFEST')
        config = json_bytes(read(descriptor(manifest['config'], CONFIG)))
        if config.get('os') != 'linux' or config.get('architecture') != 'arm64':
            raise ValueError('OCI_PLATFORM')
        rootfs = config.get('rootfs', {})
        layers = manifest.get('layers', [])
        if rootfs.get('type') != 'layers' or len(rootfs.get('diff_ids', [])) != len(layers) or not layers:
            raise ValueError('OCI_ROOTFS')
        private_files = {}
        private_root = 'opt/polis-private-image'
        for d, expected in zip(layers, rootfs['diff_ids']):
            media = d.get('mediaType')
            if media not in {LAYER, LAYER + '+gzip'}:
                raise ValueError('OCI_LAYER_TYPE')
            name = descriptor(d, media)
            with archive.extractfile(members[name]) as f:
                stream = gzip.GzipFile(fileobj=f) if media.endswith('+gzip') else f
                actual, _ = digest_stream(stream)
            if 'sha256:' + actual != expected:
                raise ValueError('OCI_DIFF_ID')
            # Verify the final overlay's source closure, not just its labels.
            with archive.extractfile(members[name]) as f:
                stream = gzip.GzipFile(fileobj=f) if media.endswith('+gzip') else f
                with tarfile.open(fileobj=stream, mode='r|') as layer:
                    for member in layer:
                        rel = member.name
                        while rel.startswith('./'):
                            rel = rel[2:]
                        rel = rel.rstrip('/') if member.isdir() else rel
                        if rel in ('', '.') and member.isdir():
                            continue
                        regular_path(rel)
                        parent, _, leaf = rel.rpartition('/')
                        ancestor = rel == private_root or private_root.startswith(rel + '/')
                        inside = rel.startswith(private_root + '/')
                        if (ancestor and not member.isdir()) or (
                            inside and not (member.isfile() or member.isdir())):
                            raise ValueError('OCI_SOURCE_LINK_OR_TYPE')
                        if leaf.startswith('.wh.') and (
                            private_root.startswith(parent + '/') or parent == private_root
                            or parent.startswith(private_root + '/') or parent == ''):
                            raise ValueError('OCI_SOURCE_WHITEOUT')
                        if inside and member.isfile():
                            with layer.extractfile(member) as body:
                                value, _ = digest_stream(body)
                            private_files[rel[len(private_root) + 1:]] = value
        if set(members) != used:
            raise ValueError('UNREFERENCED_OCI_CONTENT')
        return {'manifestDigest': md['digest'], 'configDigest': manifest['config']['digest'],
                'archiveSha256': file_digest(path), 'architecture': 'arm64', 'os': 'linux',
                'config': config.get('config', {}), 'privateFiles': private_files}


def validate_config(config, recipe):
    labels = config.get('Labels', {})
    expected = {'org.polis.private.role': recipe['role'], 'org.polis.private.recipe': sha(recipe)}
    if any(labels.get(k) != v for k, v in expected.items()):
        raise ValueError('IMAGE_LABEL_BINDING')
    if (config.get('User') != '65534:65534'
            or config.get('Entrypoint') != ['/usr/bin/python3', '/opt/polis-private-image/launcher.py']
            or config.get('Cmd') not in (None, []) or config.get('Volumes')
            or config.get('ExposedPorts') or config.get('OnBuild') or config.get('WorkingDir') != '/opt/polis-private-image'):
        raise ValueError('IMAGE_EXECUTION_CONTRACT')
    permitted = {'PATH', 'HOME', 'LANG', 'LC_ALL', 'JAVA_HOME', 'JAVA_VERSION',
                 'PYTHON_VERSION', 'PYTHON_SHA256', 'GPG_KEY', 'PYTHONDONTWRITEBYTECODE',
                 'PYTHONNOUSERSITE', 'PYTHONUNBUFFERED', 'UV_OFFLINE', 'PIP_NO_INDEX',
                 'OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'}
    if any(not isinstance(e, str) or '=' not in e or e.split('=', 1)[0] not in permitted
           for e in config.get('Env', [])):
        raise ValueError('IMAGE_AMBIENT_ENVIRONMENT')


def make_lock(producer, verifier, recipes, review):
    """The supplied review is a separately reviewed artifact, not self-attestation.

    Its digest is frozen in the signed runtime lock, alongside exact OCI bytes.
    No tool fabricates a passing canary receipt from a successful build.
    """
    if (set(review) != {'schema', 'recipeSha256', 'controls', 'gateReviewSha256'}
            or review['schema'] != 'polis-private-image-review/1'
            or not isinstance(review['gateReviewSha256'], str)
            or not HEX.fullmatch(review['gateReviewSha256'])
            or set(review['controls']) != CONTROLS
            or any(v != 'PASS' for v in review['controls'].values())):
        raise ValueError('IMAGE_REVIEW_INCOMPLETE')
    entries = {}
    for role, archive in [('producer', producer), ('verifier', verifier)]:
        recipe = validate_recipe(recipes[role])
        if recipe['role'] != role or review['recipeSha256'].get(role) != sha(recipe):
            raise ValueError('IMAGE_REVIEW_BINDING')
        image = inspect_oci(archive)
        validate_config(image.pop('config'), recipe)
        launcher_sha = file_digest(Path(__file__).parent / 'images' / 'launcher.py')
        files = {'recipe.json': sha(recipe), 'launcher.py': launcher_sha,
                 **{'payload/' + k: v for k, v in recipe['files'].items()}}
        if image.pop('privateFiles') != files:
            raise ValueError('OCI_SOURCE_CLOSURE')
        image['launcherSha256'] = launcher_sha
        entries[role] = {**image, 'recipe': recipe, 'recipeSha256': sha(recipe)}
    if entries['producer']['manifestDigest'] == entries['verifier']['manifestDigest']:
        raise ValueError('VERIFIER_NOT_SEPARATE')
    for key in ('candidateSha', 'oracleSha', 'policySha256'):
        if recipes['producer'][key] != recipes['verifier'][key]:
            raise ValueError('IMAGE_PAIR_BINDING')
    return {'schema': SCHEMA, 'images': entries, 'reviewSha256': sha(review)}


def validate_lock(lock, admission):
    if set(lock) != {'schema', 'images', 'reviewSha256'} or lock['schema'] != SCHEMA:
        raise ValueError('IMAGE_LOCK_SCHEMA')
    if set(lock['images']) != set(ROLES) or not HEX.fullmatch(lock['reviewSha256']):
        raise ValueError('IMAGE_LOCK_INCOMPLETE')
    for role, image_key in [('producer', 'runnerImage'), ('verifier', 'verifierImage')]:
        image = lock['images'][role]
        if set(image) != {'manifestDigest', 'configDigest', 'archiveSha256', 'architecture',
                          'os', 'recipe', 'recipeSha256', 'launcherSha256'}:
            raise ValueError('IMAGE_LOCK_ENTRY')
        recipe = validate_recipe(image['recipe'])
        if (recipe['role'] != role or image['recipeSha256'] != sha(recipe)
                or image['architecture'] != 'arm64' or image['os'] != 'linux'
                or not IMAGE.fullmatch(admission[image_key])
                or admission[image_key].rsplit('@', 1)[1] != image['manifestDigest']):
            raise ValueError('IMAGE_ADMISSION_BINDING')
        for key in ('candidateSha', 'oracleSha', 'policySha256'):
            if recipe[key] != admission[key]:
                raise ValueError('IMAGE_SOURCE_POLICY_BINDING')
        if (not HEX.fullmatch(image['launcherSha256'])
                or not HEX.fullmatch(image['archiveSha256'])
                or not image['configDigest'].startswith('sha256:')
                or not HEX.fullmatch(image['configDigest'][7:])):
            raise ValueError('IMAGE_DIGEST_SCHEMA')
    if lock['images']['producer']['manifestDigest'] == lock['images']['verifier']['manifestDigest']:
        raise ValueError('VERIFIER_NOT_SEPARATE')
    return lock


def check_preloaded(lock, admission, *, verifier_only=False):
    validate_lock(lock, admission)
    roles = [('verifier', 'verifierImage')] if verifier_only else [('producer', 'runnerImage'), ('verifier', 'verifierImage')]
    for role, key in roles:
        # Local only. No pull/run and no mutable-tag fallback.
        result = subprocess.run(['podman', 'image', 'inspect', admission[key]],
                                check=True, capture_output=True, timeout=30)
        rows = json_bytes(result.stdout)
        if len(rows) != 1:
            raise ValueError('PRELOADED_IMAGE_MISSING')
        row, expected = rows[0], lock['images'][role]
        if (row.get('Digest') != expected['manifestDigest']
                or row.get('Id', '').removeprefix('sha256:') != expected['configDigest'][7:]
                or row.get('Architecture') != 'arm64' or row.get('Os') != 'linux'):
            raise ValueError('PRELOADED_IMAGE_BINDING')
        validate_config(row.get('Config', {}), expected['recipe'])


def bind_runtime_lock(image_lock, runtime_lock, admission):
    if sha(runtime_lock) != admission['runtimeSha256'] or runtime_lock.get('image-lock.json') != sha(image_lock):
        raise ValueError('IMAGE_RUNTIME_BINDING')
    return validate_lock(image_lock, admission)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--producer-oci', type=Path, required=True)
    p.add_argument('--verifier-oci', type=Path, required=True)
    p.add_argument('--producer-recipe', type=Path, required=True)
    p.add_argument('--verifier-recipe', type=Path, required=True)
    p.add_argument('--review', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    lock = make_lock(a.producer_oci, a.verifier_oci,
                     {r: json_bytes(getattr(a, r + '_recipe').read_bytes()) for r in ROLES},
                     json_bytes(a.review.read_bytes()))
    with a.out.open('xb') as f:
        f.write(encoded(lock))
    print(json.dumps({'imageLockSha256': sha(lock),
                      'images': {r: {k: v for k, v in entry.items() if k != 'recipe'}
                                 for r, entry in lock['images'].items()}}))


if __name__ == '__main__':
    main()
