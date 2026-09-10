#!/usr/bin/env python3
"""Deterministically convert one local `docker save` image to a plain OCI tar.

For builders whose local Docker driver cannot export OCI. No registry, daemon,
image load or push is performed. Config and layer bytes are kept unchanged.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from control import encoded
from image_admission import CONFIG, LAYER, MANIFEST, digest_stream, json_bytes, regular_path


def convert(source, destination):
    with tarfile.open(source, 'r:') as src:
        members = {}
        for member in src:
            name = member.name.rstrip('/') if member.isdir() else member.name
            regular_path(name)
            if member.isdir():
                continue
            if not member.isfile() or name in members:
                raise ValueError('UNSAFE_DOCKER_ARCHIVE')
            members[name] = member
        rows = json_bytes(src.extractfile(members['manifest.json']).read())
        if len(rows) != 1:
            raise ValueError('EXACTLY_ONE_IMAGE_REQUIRED')
        row = rows[0]
        closure = []
        def descriptor(name, media):
            regular_path(name)
            member = members[name]
            with src.extractfile(member) as f:
                digest, size = digest_stream(f)
            closure.append((digest, member))
            return {'mediaType': media, 'digest': 'sha256:' + digest, 'size': size}
        cfg = descriptor(row['Config'], CONFIG)
        layers = [descriptor(name, LAYER) for name in row['Layers']]
        manifest = encoded({'schemaVersion': 2, 'mediaType': MANIFEST, 'config': cfg, 'layers': layers})
        digest = hashlib.sha256(manifest).hexdigest()
        index = encoded({'schemaVersion': 2, 'manifests': [
            {'mediaType': MANIFEST, 'digest': 'sha256:' + digest, 'size': len(manifest)}]})
        with destination.open('xb') as raw, tarfile.open(fileobj=raw, mode='w') as out:
            def add(name, size, body):
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = size, 0o444, 0
                out.addfile(info, body)
            for name, body in [('oci-layout', encoded({'imageLayoutVersion': '1.0.0'})),
                               ('index.json', index), ('blobs/sha256/' + digest, manifest)]:
                add(name, len(body), io.BytesIO(body))
            seen = set()
            for blob_digest, member in sorted(closure, key=lambda x: x[0]):
                if blob_digest in seen:
                    continue
                seen.add(blob_digest)
                with src.extractfile(member) as body:
                    add('blobs/sha256/' + blob_digest, member.size, body)
    return 'sha256:' + digest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--docker-archive', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(convert(args.docker_archive, args.out))
