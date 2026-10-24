#!/usr/bin/env python3
"""Build one native CLI review artifact; never publish or install it. Python 3.11+."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tomllib
import importlib.util

_IDENTITY_SPEC = importlib.util.spec_from_file_location("build_identity", Path(__file__).with_name("build_identity.py"))
_IDENTITY = importlib.util.module_from_spec(_IDENTITY_SPEC)
_IDENTITY_SPEC.loader.exec_module(_IDENTITY)
identity = _IDENTITY.identity

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("aarch64-apple-darwin", "x86_64-apple-darwin",
           "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu")
INPUTS = ("polis-cli", "queue-rs/polis-contracts", "scripts/build-polis-cli-release.py",
          "scripts/test-polis-cli.sh", "scripts/build_identity.py", "VERSION", "VERSION_STABLE_COMMIT", "LICENSE")


def output(argv, cwd=ROOT, env=None):
    return subprocess.check_output(argv, cwd=cwd, env=env, text=True).strip()


def commit_id(value):
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("Expected a full lowercase 40-character commit.")
    return value


def provenance(root, declared=None, allow_unverified=False):
    if declared is not None or allow_unverified:
        if not declared or not allow_unverified:
            raise ValueError("Archive builds require both --source-commit and --allow-unverified-source.")
        return commit_id(declared), "unverified-archive"
    try:
        top = Path(output(["git", "rev-parse", "--show-toplevel"], root)).resolve()
        if top != root.resolve():
            raise ValueError("The source must be the Git checkout root, not a directory inside another checkout.")
        commit = commit_id(output(["git", "rev-parse", "HEAD"], root))
        dirty = output(["git", "status", "--porcelain", "--untracked-files=all", "--", *INPUTS], root)
        if dirty:
            raise ValueError("Build inputs are modified or untracked; use a clean checkout.")
        return commit, "clean-checkout"
    except subprocess.CalledProcessError as error:
        raise ValueError("Cannot establish source provenance; archive rehearsals need an explicit unverified opt-in.") from error


def native_target(rustc, target):
    host = next((line[6:] for line in rustc.splitlines() if line.startswith("host: ")), "")
    if target not in TARGETS or target != host:
        raise ValueError("Build and smoke-test on a native host matching the selected supported target.")


def package(outdir, binary, version, commit, target, source, compiler, lock, license_bytes):
    commit_id(commit)
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid semantic CLI release version.")
    if target not in TARGETS or source not in ("clean-checkout", "unverified-archive"):
        raise ValueError("Invalid release target or source status.")
    suffix = "-unverified" if source == "unverified-archive" else ""
    name = f"polis-{version}-{commit[:12]}-{target}{suffix}"
    manifest = dict(schema="polis-cli-release/1", version=version, commit=commit,
                    target=target, source=source, rustc=compiler,
                    cargo_lock_sha256=hashlib.sha256(lock).hexdigest(),
                    binary_sha256=hashlib.sha256(binary).hexdigest())
    readme = ("Polis CLI\n\nVerify the archive SHA256 against your trusted release source.\n"
              "Read manifest.json and run ./polis --version before installing.\n"
              "Install explicitly into your own PATH directory; keep the previous binary\n"
              "for rollback. No configuration or credentials are included.\n"
              f"Source status: {source}. Unverified archives are rehearsal artifacts.\n"
              "GNU/Linux builds require a compatible glibc; macOS builds are unsigned\n"
              "unless the distributor separately signs and notarizes them.\n")
    members = {"polis": (binary, 0o755), "LICENSE": (license_bytes, 0o644),
               "manifest.json": ((json.dumps(manifest, indent=2, sort_keys=True)+"\n").encode(), 0o644),
               "README.txt": (readme.encode(), 0o644)}
    outdir.mkdir(parents=True, exist_ok=True)
    archive = outdir / (name + ".tar.gz")
    checksum = outdir / (archive.name + ".sha256")
    # Exclusive creation also refuses symlinks and accidental overwrites.
    if archive.exists() or checksum.exists():
        raise ValueError("Release output already exists; choose an empty output directory.")
    with archive.open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w") as tar:
                for path, (data, mode) in sorted(members.items()):
                    info = tarfile.TarInfo(f"{name}/{path}")
                    info.size, info.mode, info.mtime = len(data), mode, 0
                    tar.addfile(info, io.BytesIO(data))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    with checksum.open("x") as file:
        file.write(f"{digest}  {archive.name}\n")
    return archive


def check_tag(tag, version):
    if not re.fullmatch(r"cli-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag) or tag != f"cli-v{version}":
        raise ValueError("Release tag must be cli-v followed by the exact stable workspace version.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=TARGETS)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check-tag")
    parser.add_argument("--source-commit")
    parser.add_argument("--allow-unverified-source", action="store_true")
    args = parser.parse_args()
    try:
        if args.check_tag is not None:
            version = tomllib.loads((ROOT / "polis-cli/Cargo.toml").read_text())["workspace"]["package"]["version"]
            check_tag(args.check_tag, version)
            print("Release tag matches workspace version.")
            return
        if args.target is None or args.output is None:
            raise ValueError("Building requires --target and --output.")
        commit, source = provenance(ROOT, args.source_commit, args.allow_unverified_source)
        workspace = ROOT / "polis-cli"
        compiler = output(["rustc", "-vV"], workspace)
        native_target(compiler, args.target)
        version = tomllib.loads((workspace / "Cargo.toml").read_text())["workspace"]["package"]["version"]
        env = dict(os.environ, POLIS_BUILD_COMMIT=commit, POLIS_BUILD_SOURCE=source)
        # Use Cargo's actual target directory (including CARGO_TARGET_DIR overrides).
        metadata = json.loads(output(["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"], workspace, env))
        subprocess.run(["cargo", "build", "--locked", "--release", "--package", "polis", "--bin", "polis", "--target", args.target], cwd=workspace, env=env, check=True)
        binary = Path(metadata["target_directory"]) / args.target / "release" / "polis"
        info = identity(ROOT, env)
        distance = info["distance"] if info["distance"] is not None else "unknown"
        expected = f'polis {info["version_display"]} (commit {commit}; distance {distance}; {source})'
        if output([str(binary), "--version"], workspace, env) != expected:
            raise ValueError("Built binary version does not match source metadata.")
        # Version/help must work without a profile, sign-in, or server request.
        subprocess.run([str(binary), "--help"], cwd=workspace, env=env, check=True, stdout=subprocess.DEVNULL)
        archive = package(args.output.resolve(), binary.read_bytes(), version, commit,
                          args.target, source, compiler, (workspace / "Cargo.lock").read_bytes(),
                          (ROOT / "LICENSE").read_bytes())
        print(archive)
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"release build: {error}\n")


if __name__ == "__main__":
    main()
