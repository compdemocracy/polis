"""Offline provenance and exact-delta check for the vendored postgres crate.

The upstream manifest is generated only from a checksum-verified .crate archive.
Reverse the recorded diff, hash every reconstructed upstream file, then require
that the regenerated diff is byte-for-byte canonical. No Cargo cache is needed.
"""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
import tomllib

VENDOR = Path("queue-rs/vendor/postgres")
MANIFEST = "UPSTREAM_SHA256.json"
DELTA = "POLIS_CHANGES.patch"
ADDITIONS = {MANIFEST, DELTA, "POLIS_CHANGES.md"}
# These upstream packaging/development files were deliberately not vendored.
OMITTED = {".cargo_vcs_info.json", "CHANGELOG.md", "Cargo.lock",
           "Cargo.toml.orig", "benches/bench.rs"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inventory(directory):
    result = {}
    for path in sorted(directory.rglob("*")):
        name = path.relative_to(directory).as_posix()
        require(not path.is_symlink(), f"{VENDOR / name}: symlink is not an upstream file")
        if path.is_file():
            result[name] = path.read_bytes()
    return result


def provenance(root):
    lock_path = root / "queue-rs/Cargo.lock"
    lock = tomllib.loads(lock_path.read_text())
    packages = [p for p in lock["package"] if p["name"] == "postgres"]
    require(len(packages) == 1, "queue-rs/Cargo.lock: expected one postgres package")
    package = packages[0]
    version = package["version"]
    require("source" not in package and "checksum" not in package,
            "queue-rs/Cargo.lock: postgres must be the patched path dependency")
    # Cargo records only the resolved version for this path dependency.
    # Archive provenance lives in the reviewed README and upstream hash manifest.
    checksums = re.findall(r"`([a-f0-9]{64})`", (root / VENDOR / "README.md").read_text())
    require(len(checksums) == 1, f"{VENDOR / 'README.md'}: expected one archive SHA-256")
    checksum = checksums[0]
    cargo = tomllib.loads((root / VENDOR / "Cargo.toml").read_text())
    require(cargo["package"]["name"] == "postgres" and cargo["package"]["version"] == version,
            f"{VENDOR / 'Cargo.toml'}: version differs from queue-rs/Cargo.lock")
    workspace = tomllib.loads((root / "queue-rs/Cargo.toml").read_text())
    require(workspace.get("patch", {}).get("crates-io", {}).get("postgres") ==
            {"path": "vendor/postgres"}, "queue-rs/Cargo.toml: postgres patch path drift")
    for filename, pattern in [("README.md", r"This is `postgres` ([0-9.]+) from crates.io"),
                              ("POLIS_CHANGES.md", r"source of postgres ([0-9.]+),")]:
        text = (root / VENDOR / filename).read_text()
        versions = re.findall(pattern, text)
        checksums = re.findall(r"`([a-f0-9]{64})`", text)
        require(versions == [version] and checksums == [checksum],
                f"{VENDOR / filename}: version differs from queue-rs/Cargo.lock or checksum differs from README.md")
    changes = (root / VENDOR / "POLIS_CHANGES.md").read_text()
    require(f"[{DELTA}]({DELTA})" in changes,
            f"{VENDOR / 'POLIS_CHANGES.md'}: missing recorded diff link")
    return version, checksum


def canonical_diff(upstream, current):
    result = []
    for name in sorted(current):
        for line in difflib.diff_bytes(difflib.unified_diff,
                                      upstream[name].splitlines(keepends=True),
                                      current[name].splitlines(keepends=True),
                                      fromfile=f"a/{name}".encode(),
                                      tofile=f"b/{name}".encode()):
            result.append(line if line.endswith(b"\n") else
                          line + b"\n\\ No newline at end of file\n")
    return b"".join(result)


def reverse_diff(delta, current):
    """Strictly reverse our unified diff: no fuzz, offset search, or subprocess."""
    lines = []
    for line in delta.splitlines(keepends=True):
        if line == b"\\ No newline at end of file\n":
            require(lines and lines[-1][:1] in (b" ", b"+", b"-"),
                    f"{DELTA}: misplaced newline marker")
            lines[-1] = lines[-1][:-1]
        else:
            lines.append(line)
    originals = dict(current)
    seen = set()
    i = 0
    while i < len(lines):
        require(lines[i].startswith(b"--- a/"), f"{DELTA}: invalid file header")
        name = lines[i][6:].removesuffix(b"\n").decode()
        require(name in current and name not in seen, f"{DELTA}: unexpected/repeated file {name}")
        seen.add(name)
        i += 1
        require(i < len(lines) and lines[i] == f"+++ b/{name}\n".encode(),
                f"{DELTA}: invalid new-file header for {name}")
        i += 1
        source = current[name].splitlines(keepends=True)
        output, cursor, hunks = [], 0, 0
        while i < len(lines) and not lines[i].startswith(b"--- a/"):
            header = re.fullmatch(rb"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\n", lines[i])
            require(header, f"{DELTA}: invalid hunk for {name}")
            old_start, old_count, new_start, new_count = [int(v) if v is not None else 1
                                                        for v in header.groups()]
            old_pos = old_start - (old_count != 0)
            new_pos = new_start - (new_count != 0)
            require(cursor <= new_pos <= len(source), f"{DELTA}: invalid offset for {name}")
            output.extend(source[cursor:new_pos])
            require(len(output) == old_pos, f"{DELTA}: old offset drift for {name}")
            cursor, old_seen, new_seen = new_pos, 0, 0
            i += 1
            while old_seen < old_count or new_seen < new_count:
                require(i < len(lines), f"{DELTA}: truncated hunk for {name}")
                kind, value = lines[i][:1], lines[i][1:]
                require(kind in (b" ", b"+", b"-"), f"{DELTA}: invalid hunk line for {name}")
                if kind in (b" ", b"+"):
                    require(cursor < len(source) and source[cursor] == value,
                            f"{VENDOR / name}: bytes differ from {DELTA} at line {cursor + 1}")
                    cursor += 1
                    new_seen += 1
                if kind in (b" ", b"-"):
                    output.append(value)
                    old_seen += 1
                i += 1
            require((old_seen, new_seen) == (old_count, new_count),
                    f"{DELTA}: hunk count drift for {name}")
            hunks += 1
        require(hunks, f"{DELTA}: no hunks for {name}")
        output.extend(source[cursor:])
        originals[name] = b"".join(output)
    return originals


def check(root):
    version, checksum = provenance(root)
    files = inventory(root / VENDOR)
    manifest = json.loads(files[MANIFEST])
    require(manifest["version"] == version and manifest["archive_sha256"] == checksum,
            f"{VENDOR / MANIFEST}: version differs from queue-rs/Cargo.lock or checksum differs from README.md")
    require(manifest["omitted"] == sorted(OMITTED), f"{VENDOR / MANIFEST}: omitted files drift")
    hashes = manifest["files"]
    require(OMITTED <= hashes.keys(), f"{VENDOR / MANIFEST}: missing omitted upstream hashes")
    for name, digest in hashes.items():
        require(not Path(name).is_absolute() and ".." not in Path(name).parts and
                re.fullmatch(r"[a-f0-9]{64}", digest), f"{MANIFEST}: invalid entry {name}")
    expected = (hashes.keys() - OMITTED) | ADDITIONS
    require(files.keys() == expected,
            f"{VENDOR}: missing {sorted(expected - files.keys())}; unexpected {sorted(files.keys() - expected)}")
    current = {name: data for name, data in files.items() if name not in ADDITIONS}
    original = reverse_diff(files[DELTA], current)
    for name, data in original.items():
        require(sha(data) == hashes[name],
                f"{VENDOR / name}: upstream SHA-256 mismatch (file or {DELTA} drift)")
    require(canonical_diff(original, current) == files[DELTA],
            f"{VENDOR / DELTA}: recorded diff is not byte-for-byte canonical")
    print(f"postgres {version}: {len(current)} upstream file hashes, exact delta, "
          f"{len(OMITTED)} documented omissions, README/lock provenance OK (offline)")


def refresh(root, archive):
    """Deliberate maintainer operation; never called by the normal check."""
    version, checksum = provenance(root)
    require(sha(archive.read_bytes()) == checksum, f"{archive.name}: archive SHA-256 differs from README.md")
    upstream = {}
    prefix = f"postgres-{version}/"
    with tarfile.open(archive) as crate:
        for member in crate:
            require(member.isfile() and member.name.startswith(prefix),
                    f"{archive.name}: unexpected archive member {member.name}")
            name = member.name[len(prefix):]
            require(name and not Path(name).is_absolute() and ".." not in Path(name).parts
                    and name not in upstream, f"{archive.name}: invalid member {name}")
            upstream[name] = crate.extractfile(member).read()
    current = {name: data for name, data in inventory(root / VENDOR).items() if name not in ADDITIONS}
    require(current.keys() == upstream.keys() - OMITTED and OMITTED <= upstream.keys(),
            f"{VENDOR}: retained/omitted files differ from archive")
    manifest = {"version": version, "archive_sha256": checksum,
                "files": {name: sha(data) for name, data in sorted(upstream.items())},
                "omitted": sorted(OMITTED)}
    (root / VENDOR / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n")
    (root / VENDOR / DELTA).write_bytes(canonical_diff(upstream, current))
    check(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--refresh", type=Path, metavar="VERIFIED_CRATE",
                        help="deliberately regenerate manifest/diff from a local archive")
    args = parser.parse_args()
    try:
        if args.refresh:
            refresh(args.root, args.refresh)
        else:
            check(args.root)
    except (ValueError, KeyError, OSError, tarfile.TarError) as error:
        print(f"vendor postgres: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
