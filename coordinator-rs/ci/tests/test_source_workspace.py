"""Current merge source is tested; old receipts stay historical.

Git responses are fixtures: no repository is initialized, committed or mutated.
"""
import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import source_workspace as sw
from verify import source_pins


def write(root: Path, name: str, value: bytes) -> None:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)


def fixture(root: Path) -> None:
    write(root, "delphi/polismath/science.py", b"answer = 42\n")
    manifest = {"schema": "polis-poller-engine/1", "engine_version": "python-math-poller/1",
                "scope": "package source", "sha256": {"polismath/science.py": sw.digest(b"answer = 42\n")}}
    raw = (json.dumps(manifest, indent=2) + "\n").encode()
    write(root, sw.ENGINE, raw)
    old = sw.digest(raw)
    write(root, "coordinator-rs/src/bridge.rs", f'pub const ENGINE_SHA256: &str = "{old}";\n'.encode())
    write(root, "delphi/polismath/poller/coordinator_bridge.py", f'COORDINATOR_ENGINE_SHA256 = "{old}"\n'.encode())
    for name in sw.CLOSURES:
        receipt = {"state": "PARTIAL", "results": {"passed": 7},
                   "sha256": {"delphi/polismath/science.py": sw.digest(b"answer = 42\n")}}
        if name == "s2-closure.json":
            path = "coordinator-rs/evidence/s2-production-reader.json"
            receipt["sha256"][path] = sw.digest((root / path).read_bytes())
        write(root, "coordinator-rs/evidence/" + name, json.dumps(receipt).encode())


def fake_git(monkeypatch, root: Path, *, dirty: bool = False, subject: str = "event ingress (#2770)") -> None:
    names = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())
    def query(_root: Path, *args: str) -> bytes:
        if args == ("rev-parse", "HEAD"):
            return b"a" * 40 + b"\n"
        if args == ("rev-parse", "--absolute-git-dir"):
            return str(root / ".fixture-git").encode()
        if args == ("ls-files", "-z"):
            return "\0".join(names).encode() + b"\0"
        if args[0] == "diff":
            return b"delphi/polismath/science.py\0" if dirty else b""
        if args[0] == "log":
            return ("b" * 40 + "\0" + subject + "\n").encode()
        raise AssertionError(args)
    monkeypatch.setattr(sw, "git", query)


def test_merge_drift_runs_current_bytes_and_retains_original_receipts(tmp_path, monkeypatch):
    root, dest = tmp_path / "original", tmp_path / "campaign"
    fixture(root)
    old_receipts = {n: (root / "coordinator-rs/evidence" / n).read_bytes() for n in sw.CLOSURES}
    write(root, "delphi/polismath/science.py", b"answer = 43\n")
    fake_git(monkeypatch, root)
    report = sw.prepare(root, dest)
    assert source_pins(dest)
    assert (dest / "delphi/polismath/science.py").read_bytes() == b"answer = 43\n"
    assert report["drift"] and all(r["attribution"]["pull_request"] == 2770 for r in report["drift"])
    assert set(report["metadata_transforms"]) == {sw.ENGINE, *sw.BRIDGES,
        *("coordinator-rs/evidence/" + name for name in sw.CLOSURES)}
    for name, old in old_receipts.items():
        assert (root / "coordinator-rs/evidence" / name).read_bytes() == old
        current = json.loads((dest / "coordinator-rs/evidence" / name).read_bytes())
        assert {k: v for k, v in current.items() if k != "sha256"} == {
            k: v for k, v in json.loads(old).items() if k != "sha256"}
    new_hash = sw.digest((dest / sw.ENGINE).read_bytes())
    for path in sw.BRIDGES:
        assert new_hash in (dest / path).read_text()
    # A semantic change is still visible to a real assertion, never blessed by
    # re-hashing: the original answer oracle must fail against the merged source.
    namespace = {}
    exec((dest / "delphi/polismath/science.py").read_text(), namespace)
    with pytest.raises(AssertionError):
        assert namespace["answer"] == 42
    write(dest, "delphi/polismath/science.py", b"answer = 44\n")
    with pytest.raises(ValueError, match="stale source pin"):
        source_pins(dest)


def test_no_drift_keeps_every_metadata_byte(tmp_path, monkeypatch):
    root = tmp_path / "original"
    fixture(root)
    fake_git(monkeypatch, root)
    report = sw.prepare(root, tmp_path / "campaign")
    assert report["drift"] == [] and report["metadata_transforms"] == {}


@pytest.mark.parametrize("subject,expected", [("Merge pull request #2770 from example/branch", 2770),
    ("fix replay (#2770)", 2770), ("Merge a into b", None), ("reference issue #2770", None)])
def test_attribution_does_not_invent_pr_links(tmp_path, monkeypatch, subject, expected):
    fixture(tmp_path)
    fake_git(monkeypatch, tmp_path, subject=subject)
    result = sw.attribution(tmp_path, "a" * 40, "delphi/polismath/science.py")
    assert result["pull_request"] == expected
    assert result["method"] == "git-first-parent-subject"


def test_local_changes_explicit_and_never_hosted(tmp_path, monkeypatch):
    root = tmp_path / "original"
    fixture(root)
    fake_git(monkeypatch, root, dirty=True)
    with pytest.raises(ValueError, match="explicit local"):
        sw.prepare(root, tmp_path / "one")
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    report = sw.prepare(root, tmp_path / "two", allow_local=True)
    assert report["local_changes"] == ["delphi/polismath/science.py"]
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    with pytest.raises(ValueError, match="forbidden in hosted"):
        sw.prepare(root, tmp_path / "three", allow_local=True)


@pytest.mark.parametrize("mutation", ["missing", "outside", "symlink", "constant", "circular", "digest"])
def test_bad_closure_or_runtime_binding_is_not_refreshed(tmp_path, mutation):
    fixture(tmp_path)
    if mutation == "missing":
        (tmp_path / "delphi/polismath/science.py").unlink()
    elif mutation == "outside":
        path = tmp_path / "coordinator-rs/evidence/s1-closure.json"
        value = json.loads(path.read_bytes()); value["sha256"]["../escape"] = "1" * 64
        path.write_text(json.dumps(value))
    elif mutation == "symlink":
        path = tmp_path / "delphi/polismath/science.py"
        path.unlink(); path.symlink_to(tmp_path / "coordinator-rs/src/bridge.rs")
    elif mutation == "constant":
        path = tmp_path / "coordinator-rs/src/bridge.rs"
        path.write_text('pub const ENGINE_SHA256: &str = "' + "0" * 64 + '";\n')
    elif mutation == "circular":
        path = tmp_path / sw.ENGINE
        value = json.loads(path.read_bytes()); value["sha256"]["polismath/poller/coordinator_bridge.py"] = "1" * 64
        path.write_text(json.dumps(value))
    else:
        path = tmp_path / "coordinator-rs/evidence/s1-closure.json"
        value = json.loads(path.read_bytes()); value["sha256"]["delphi/polismath/science.py"] = "invalid"
        path.write_text(json.dumps(value))
    with pytest.raises(ValueError):
        sw.reconcile(tmp_path)


def test_added_package_sources_enter_the_fresh_engine_inventory(tmp_path):
    fixture(tmp_path)
    write(tmp_path, "delphi/polismath/new_module.py", b"pass\n")
    sw.reconcile(tmp_path)
    value = json.loads((tmp_path / sw.ENGINE).read_bytes())
    assert value["sha256"]["polismath/new_module.py"] == hashlib.sha256(b"pass\n").hexdigest()
