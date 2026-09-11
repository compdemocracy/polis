"""Snapshot current source and reconcile historical pins for one fresh campaign.

Only the disposable copy receives new closure hashes and the bridge's two
manifest constants. No historical receipt, Git object, index or source checkout
is changed. Behavioral expectations and case inventories are never regenerated.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess

CLOSURES = ("s2-production-reader.json", "s1-closure.json", "s2-closure.json")
ENGINE = "coordinator-rs/schemas/poller-engine-v1.json"
BRIDGES = {
    "coordinator-rs/src/bridge.rs": r'(pub const ENGINE_SHA256: &str = ")[a-f0-9]{64}(";)',
    "delphi/polismath/poller/coordinator_bridge.py": r'(COORDINATOR_ENGINE_SHA256 = ")[a-f0-9]{64}(")',
}


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)


def regular(root: Path, name: str) -> Path:
    relative = PurePosixPath(name)
    if (not name or relative.is_absolute() or ".." in relative.parts or
            str(relative) != name or "\\" in name):
        raise ValueError(f"invalid source path: {name}")
    path = root / name
    if not path.is_file() or any(p.is_symlink() for p in (path, *path.parents) if p != root and root in p.parents):
        raise ValueError(f"nonregular source: {name}")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"outside source: {name}")
    return path


def attribution(root: Path, head: str, name: str) -> dict[str, object]:
    # Subjects are evidence, not an API-confirmed PR association. Merge refs and
    # commits without a conventional PR trailer retain an explicit unknown PR.
    result: dict[str, object] = {"path": name, "commit": None, "subject": None,
                                "pull_request": None, "method": "git-first-parent-subject"}
    raw = git(root, "log", "-1", "--first-parent", "--format=%H%x00%s", head, "--", name).decode().strip()
    if raw:
        commit, subject = raw.split("\0", 1)
        match = re.search(r"(?:Merge pull request #|\(#)(\d+)(?:\)|\b)", subject)
        result.update(commit=commit, subject=subject,
                      pull_request=int(match[1]) if match else None)
    return result


def reconcile(copy: Path) -> dict[str, dict[str, str]]:
    """Rebind only mechanical metadata, preserving its exact path inventories."""
    changed: dict[str, dict[str, str]] = {}

    def write(name: str, raw: bytes) -> None:
        path = regular(copy, name)
        before = path.read_bytes()
        if before != raw:
            path.write_bytes(raw)
            changed[name] = {"before": digest(before), "after": digest(raw)}

    engine_path = regular(copy, ENGINE)
    original = engine_path.read_bytes()
    manifest = json.loads(original)
    if manifest.get("schema") != "polis-poller-engine/1" or not manifest.get("sha256"):
        raise ValueError("invalid engine source inventory")
    engine_pins = manifest["sha256"]
    if type(engine_pins) is not dict or "polismath/poller/coordinator_bridge.py" in engine_pins:
        raise ValueError("invalid or circular engine inventory")
    # Package additions must be included too. The manifest's stated scope is
    # the complete package excluding its separately bound bridge protocol.
    actual_names = {str(p.relative_to(copy / "delphi")) for p in
                    (copy / "delphi/polismath").rglob("*.py")}
    actual_names.discard("polismath/poller/coordinator_bridge.py")
    if not set(engine_pins) <= actual_names:
        raise ValueError("engine source inventory lost a file")
    manifest["sha256"] = {name: digest(regular(copy, "delphi/" + name).read_bytes())
                          for name in sorted(actual_names)}
    engine_raw = (json.dumps(manifest, indent=2) + "\n").encode()
    # Preserve already current original formatting and bytes.
    if manifest == json.loads(original):
        engine_raw = original
    old_hash, new_hash = digest(original), digest(engine_raw)
    for name, pattern in BRIDGES.items():
        text = regular(copy, name).read_text()
        matches = list(re.finditer(pattern, text))
        if len(matches) != 1 or matches[0][0] != matches[0][1] + old_hash + matches[0][2]:
            raise ValueError(f"bridge does not bind historical manifest: {name}")
        updated, count = re.subn(pattern, lambda m: m[1] + new_hash + m[2], text)
        if count != 1:
            raise ValueError("ambiguous bridge manifest constant")
        write(name, updated.encode())
    write(ENGINE, engine_raw)
    # Production reader -> S1 -> S2: S2 includes the production receipt.
    for filename in CLOSURES:
        name = "coordinator-rs/evidence/" + filename
        raw = regular(copy, name).read_bytes()
        receipt = json.loads(raw)
        pins = receipt.get("sha256")
        if type(pins) is not dict or not pins:
            raise ValueError(f"missing historical source inventory: {filename}")
        for rel, expected in pins.items():
            if type(expected) is not str or re.fullmatch(r"[a-f0-9]{64}", expected) is None:
                raise ValueError(f"invalid historical digest: {rel}")
            pins[rel] = digest(regular(copy, rel).read_bytes())
        if receipt != json.loads(raw):
            write(name, (json.dumps(receipt, indent=2) + "\n").encode())
    return changed


def prepare(root: Path, destination: Path, *, allow_local: bool = False,
            local_files: tuple[str, ...] = (), local_removed: tuple[str, ...] = ()) -> dict[str, object]:
    root = root.resolve(strict=True)
    if destination.exists() or destination.resolve().is_relative_to(root):
        raise ValueError("source workspace must be new and outside checkout")
    head = git(root, "rev-parse", "HEAD").decode().strip()
    tracked = {p.decode() for p in git(root, "ls-files", "-z").split(b"\0") if p}
    dirty = [p.decode() for p in git(root, "diff", "HEAD", "--name-only", "-z").split(b"\0") if p]
    if (dirty or local_files or local_removed) and not allow_local:
        raise ValueError("uncommitted source requires explicit local campaign mode")
    if allow_local and __import__("os").environ.get("GITHUB_ACTIONS") == "true":
        raise ValueError("local source mode is forbidden in hosted CI")
    removed = set(local_removed)
    if (len(removed) != len(local_removed) or not removed <= tracked or
            not removed <= set(dirty) or removed & set(local_files) or
            any((root / name).exists() or (root / name).is_symlink() for name in removed)):
        raise ValueError("local removal must name a missing tracked source change")
    names = sorted((tracked - removed) | set(local_files))
    source = {name: digest(regular(root, name).read_bytes()) for name in names}
    historical: dict[str, dict[str, str]] = {}
    for filename in CLOSURES:
        receipt = json.loads(regular(root, "coordinator-rs/evidence/" + filename).read_bytes())
        historical[filename] = receipt["sha256"]
    historical[ENGINE] = {"delphi/" + name: value for name, value in
                         json.loads(regular(root, ENGINE).read_bytes())["sha256"].items()}
    drift = []
    cache: dict[str, dict[str, object]] = {}
    for receipt, pins in historical.items():
        for name, expected in pins.items():
            if type(expected) is not str or re.fullmatch(r"[a-f0-9]{64}", expected) is None:
                raise ValueError(f"invalid historical digest: {name}")
            if name not in source:
                raise ValueError(f"historical source missing from current checkout: {name}")
            if source[name] != expected:
                if name not in cache:
                    cache[name] = attribution(root, head, name)
                drift.append({"receipt": receipt, "path": name, "historical_sha256": expected,
                              "current_sha256": source[name], "attribution": cache[name],
                              "uncommitted": name in dirty or name not in tracked})
    destination.mkdir(parents=True)
    for name in names:
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(regular(root, name), path)
        shutil.copymode(root / name, path)
        if digest(path.read_bytes()) != source[name]:
            raise ValueError(f"source changed during snapshot: {name}")
    # Historical git blobs remain read-only. No repository mutation is invoked.
    git_dir = git(root, "rev-parse", "--absolute-git-dir").decode().strip()
    (destination / ".git").write_text(f"gitdir: {git_dir}\n")
    modules = root / "server/node_modules"
    if modules.is_dir():
        (destination / "server/node_modules").symlink_to(modules.resolve(), target_is_directory=True)
    transforms = reconcile(destination)
    report = {"schema": "polis-coordinator-source-reconciliation/1", "source_head": head,
              "source_sha256": source, "historical_pins": historical, "drift": drift,
              "metadata_transforms": transforms, "local_changes": sorted(set(dirty) | (set(local_files) - tracked)),
              "local_removed": sorted(removed),
              "behavioral_expectations_changed": False,
              "historical_results_recertified": False}
    return report
