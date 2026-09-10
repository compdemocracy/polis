#!/usr/bin/env python3
"""Stage only an explicitly reviewed source closure into a fresh build context.

No git mutation, dependency resolution, image pull/build or cloud action. Source
pins must describe committed reviewed code; dirty file bytes cannot masquerade
as that commit. The independent verifier uses its own source checkout/recipe.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from control import encoded, sha
from image_admission import file_digest, json_bytes, validate_recipe


def stage(source, recipe, destination):
    recipe = validate_recipe(recipe)
    source = source.resolve(strict=True)
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    if head != recipe['sourceCommit']:
        raise ValueError('UNREVIEWED_SOURCE_COMMIT')
    # Content hashes and trackedness are both mandatory. Ignore unrelated edits.
    for rel, digest in recipe['files'].items():
        path = source / rel
        if path.is_symlink() or not path.is_file() or source not in path.resolve().parents:
            raise ValueError('SOURCE_FILE_BOUNDARY')
        if any(p.is_symlink() for p in path.parents if p != source and source in p.parents):
            raise ValueError('SOURCE_DIRECTORY_SYMLINK')
        tracked = subprocess.check_output(['git', 'ls-files', '--error-unmatch', '--', rel], cwd=source)
        committed = subprocess.check_output(['git', 'show', f'{head}:{rel}'], cwd=source)
        import hashlib
        if (not tracked or file_digest(path) != digest
                or hashlib.sha256(committed).hexdigest() != digest):
            raise ValueError('UNREVIEWED_SOURCE_BYTES')
        if recipe['role'] == 'producer':
            origin = recipe['candidateSha'] if rel.startswith('delphi/polismath/') else (
                recipe['oracleSha'] if rel.startswith('math/') else None)
            if origin is not None:
                origin_bytes = subprocess.check_output(['git', 'show', f'{origin}:{rel}'], cwd=source)
                if hashlib.sha256(origin_bytes).hexdigest() != digest:
                    raise ValueError('ENGINE_SOURCE_COMMIT_BINDING')
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    for rel in recipe['files']:
        out = destination / 'payload' / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / rel, out)
        out.chmod(0o444)
    (destination / 'recipe.json').write_bytes(encoded(recipe))
    here = Path(__file__).resolve().parent
    for name in ('Dockerfile', 'launcher.py'):
        shutil.copyfile(here / name, destination / name)
    (destination / 'build.json').write_bytes(encoded({
        'schema': 'polis-private-image-build/1', 'recipeSha256': sha(recipe),
        'dockerfileSha256': file_digest(here / 'Dockerfile'),
        'launcherSha256': file_digest(here / 'launcher.py'),
        'platform': 'linux/arm64', 'network': 'none',
        'runtimeImage': recipe['runtimeImage'],
    }))
    return sha(recipe)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--recipe', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    print(stage(a.source, json_bytes(a.recipe.read_bytes()), a.out))


if __name__ == '__main__':
    main()
