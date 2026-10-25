#!/usr/bin/env python3
"""Validate the complete native CLI set, then publish an existing release tag."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tarfile

SPEC = importlib.util.spec_from_file_location("build_release", Path(__file__).with_name("build-polis-cli-release.py"))
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


def validate(directory, tag, commit):
    build.commit_id(commit)
    if not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Publication requires a stable vMAJOR.MINOR.PATCH tag.")
    version = tag.removeprefix("v")
    expected = set()
    assets = []
    for target in build.TARGETS:
        name = f"polis-{version}-{commit[:12]}-{target}"
        archive = directory / (name + ".tar.gz")
        checksum = directory / (archive.name + ".sha256")
        expected.update((archive.name, checksum.name))
        if archive.is_symlink() or checksum.is_symlink() or not archive.is_file() or not checksum.is_file():
            raise ValueError("Missing or linked release asset.")
        if archive.stat().st_size > 200 * 1024 * 1024:
            raise ValueError("Release archive exceeds the updater limit.")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if checksum.read_text() != f"{digest}  {archive.name}\n":
            raise ValueError("Release checksum mismatch.")
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            names = {f"{name}/{part}" for part in ("polis", "manifest.json", "LICENSE", "README.txt")}
            if len(members) != 4 or {m.name for m in members} != names or not all(m.isfile() for m in members):
                raise ValueError("Unexpected release archive members.")
            if any(m.size > (300 * 1024 * 1024 if m.name.endswith('/polis') else 64 * 1024) for m in members):
                raise ValueError("Release member exceeds the updater limit.")
            manifest = json.load(tar.extractfile(f"{name}/manifest.json"))
            for key, value in dict(schema="polis-cli-release/1", version=version, commit=commit,
                                   target=target, source="clean-checkout").items():
                if manifest.get(key) != value:
                    raise ValueError(f"Release manifest mismatch: {key}.")
            binary = tar.extractfile(f"{name}/polis").read()
            if not binary or hashlib.sha256(binary).hexdigest() != manifest.get("binary_sha256"):
                raise ValueError("Release binary checksum mismatch.")
        assets.extend((archive, checksum))
    if {p.name for p in directory.iterdir()} != expected:
        raise ValueError("Publication requires exactly the four archives and their checksums.")
    return assets


def publish(directory, tag, commit, repository, notes):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository):
        raise ValueError("Invalid release repository.")
    assets = validate(directory, tag, commit)
    if notes is None or not notes.is_file() or "schema: " not in notes.read_text():
        raise ValueError("Prepared release notes with schema status are required.")
    # --verify-tag prevents creation of a missing tag. Existing releases cause create
    # to fail: reruns never overwrite a release or silently reuse earlier assets.
    subprocess.run(["gh", "release", "create", tag, "--repo", repository,
                    "--verify-tag", "--draft", "--title", f"Polis {tag[1:]}",
                    "--notes-file", str(notes)], check=True)
    subprocess.run(["gh", "release", "upload", tag, "--repo", repository,
                    *map(str, assets)], check=True)
    subprocess.run(["gh", "release", "edit", tag, "--repo", repository,
                    "--draft=false", "--latest"], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--notes", type=Path)
    args = parser.parse_args()
    try:
        if args.validate_only:
            validate(args.directory, args.tag, args.commit)
        else:
            publish(args.directory, args.tag, args.commit, args.repository, args.notes)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"release publication: {error}\n")


if __name__ == "__main__":
    main()
