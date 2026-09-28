"""The CI recordings packer: what it ships, what it refuses, what it pins.

`ci/p022_recordings_manifest.py` is what makes a certification dispatch return
the recordings it produced instead of destroying them with the box. These tests
run it over public-fixture recording roots — no engine, no instance, no AWS.

The properties that matter are all refusals: it packs only entries the battery
inventory admitted, only allowlisted file names, and it fails rather than
reporting a shorter-but-clean inventory when an admitted entry has no pair.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tarfile
from pathlib import Path

import pytest

# CI copies tests to /app/tests and the checkout inputs to /app/projgate.
# Use the same explicit root as the projection-gate tests; a missing input
# remains a collection failure so this acceptance suite cannot silently skip.
_REPO = Path(os.environ.get("POLIS_CHECKOUT_DIR", Path(__file__).resolve().parents[3]))
_MODULE_PATH = _REPO / "ci" / "p022_recordings_manifest.py"


def _load():
    name = "p022_recordings_manifest_under_test"
    spec = importlib.util.spec_from_file_location(name, _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # @dataclass resolves through sys.modules
    spec.loader.exec_module(module)
    return module


pack = _load()


def _write_steps(step_dir: Path, count: int, suffix: str) -> None:
    step_dir.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        (step_dir / f"step-{i:03d}{suffix}").write_text(json.dumps({"index": i, "blob": {"n": i}}))


def _record(root: Path, dataset: str, schedule_id: str, *, clj: int | None, py: int | None) -> Path:
    rec = root / dataset / schedule_id
    rec.mkdir(parents=True, exist_ok=True)
    (rec / "schedule.json").write_text(json.dumps({"schedule_id": schedule_id, "cuts": {"mode": "vote-count", "at": list(range(1, max(clj or 0, py or 0) + 1))}}))
    (rec / "provenance.json").write_text(json.dumps({"engine": "test"}))
    if clj is not None:
        _write_steps(rec / "clj", clj, ".blob.json")
        _write_steps(rec / "clj", clj, ".meta.json")
        (rec / "clj" / "cache_manifest.json").write_text("{}")
    if py is not None:
        _write_steps(rec / "py", py, ".json")
        (rec / "py" / "cache_manifest.json").write_text("{}")
    return rec


@pytest.fixture()
def scene(tmp_path: Path):
    """Two admitted entries (one recorded, one not) and one never admitted."""
    battery = tmp_path / "battery.json"
    battery.write_text(json.dumps([
        {"dataset": "vw", "preset": "uniform", "n_cuts": 8},
        {"dataset": "vw", "preset": "front-loaded", "n_cuts": 6},
        {"dataset": "pakistan", "preset": "uniform", "n_cuts": 8},
    ]))
    datasets = tmp_path / "datasets.json"
    datasets.write_text(json.dumps({"public_fixtures": [{"slug": "vw"}, {"slug": "biodiversity"}]}))
    selection = tmp_path / "battery-selection.json"
    selection.write_text(json.dumps({
        "public_slugs": ["biodiversity", "vw"],
        "selected": [
            {"dataset": "vw", "preset": "uniform", "n_cuts": 8},
            {"dataset": "vw", "preset": "front-loaded", "n_cuts": 6},
        ],
        "selected_count": 2,
        "missing": [],
        "inventory_digest": pack._inventory(battery, datasets)[0],
    }))
    root = tmp_path / "certify-run"
    _record(root, "vw", "uniform8-clojure-legacy", clj=3, py=3)
    _record(root, "vw", "front-loaded6-clojure-legacy", clj=None, py=2)
    _record(root, "pakistan", "uniform8-clojure-legacy", clj=2, py=2)
    return battery, selection, root, tmp_path / "out"


def _verify(scene, **overrides):
    battery, selection, root, out = scene
    args = dict(expected_inventory_digest=json.loads(selection.read_text())["inventory_digest"],
                battery=battery, datasets=battery.parent / "datasets.json")
    args.update(overrides)
    return pack.verify(out, **args)


def test_packs_only_covered_admitted_entries(scene):
    battery, selection, root, out = scene
    manifest, rc = pack.build(replays_root=root, out_dir=out, battery=battery,
                              selection=selection, require_complete=False)
    assert rc == 0
    assert [e["schedule_id"] for e in manifest["entries"]] == ["uniform8-clojure-legacy"]
    assert [m["schedule_id"] for m in manifest["missing"]] == ["front-loaded6-clojure-legacy"]
    # The private dataset is in the battery file, is not a public fixture, and
    # is named as skipped rather than silently vanishing from the inventory.
    assert manifest["skipped_not_public"] == ["pakistan/uniform8-clojure-legacy"]
    assert manifest["skipped_not_in_inventory"] == []


def test_an_entry_outside_the_admitted_inventory_is_not_shipped(scene):
    """A public entry the battery did not select is evidence of some other run."""
    battery, selection, root, out = scene
    sel = json.loads(selection.read_text())
    sel["selected"] = [e for e in sel["selected"] if e.get("preset") != "uniform"]
    sel["selected_count"] = 1
    selection.write_text(json.dumps(sel))
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=selection, require_complete=False)
    assert manifest["entries"] == []
    assert manifest["skipped_not_in_inventory"] == ["vw/uniform8-clojure-legacy"]


def test_manifest_records_steps_digests_and_bytes(scene):
    battery, selection, root, out = scene
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=selection, require_complete=False)
    entry = manifest["entries"][0]
    assert entry["dataset"] == "vw"
    assert entry["engines"]["clj"]["steps"] == 3
    assert entry["engines"]["py"]["steps"] == 3
    assert sorted(entry["engines"]["py"]["step_sha256"]) == [
        "py/step-000.json", "py/step-001.json", "py/step-002.json",
    ]
    assert all(len(v) == 64 for v in entry["engines"]["clj"]["step_sha256"].values())
    assert entry["bytes"] > 0
    assert entry["archive_bytes"] > 0
    assert len(entry["archive_sha256"]) == 64
    assert manifest["totals"]["step_files"] == 6
    assert len(manifest["manifest_digest"]) == 64


def test_archive_members_extract_into_the_canonical_store_layout(scene, tmp_path):
    battery, selection, root, out = scene
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=selection, require_complete=False)
    archive = out / manifest["entries"][0]["archive"]
    with tarfile.open(archive) as tar:
        names = sorted(tar.getnames())
    assert "vw/uniform8-clojure-legacy/schedule.json" in names
    assert "vw/uniform8-clojure-legacy/py/step-000.json" in names
    assert "vw/uniform8-clojure-legacy/clj/step-000.blob.json" in names

    replays = tmp_path / "replays"
    replays.mkdir()
    with tarfile.open(archive) as tar:
        tar.extractall(replays, filter="data")
    assert (replays / "vw" / "uniform8-clojure-legacy" / "clj" / "step-002.meta.json").is_file()


def test_unlisted_files_are_reported_and_left_behind(scene):
    battery, selection, root, out = scene
    rec = root / "vw" / "uniform8-clojure-legacy"
    (rec / "clj" / "step-000.edn").write_text("{:huge true}")
    (rec / "scratch.log").write_text("not evidence")
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=selection, require_complete=False)
    entry = manifest["entries"][0]
    assert sorted(entry["unlisted"]) == ["clj/step-000.edn", "scratch.log"]
    with tarfile.open(out / entry["archive"]) as tar:
        names = tar.getnames()
    assert not any(n.endswith(".edn") or n.endswith("scratch.log") for n in names)


def test_require_complete_fails_on_an_admitted_entry_without_a_pair(scene):
    battery, selection, root, out = scene
    _, rc = pack.build(replays_root=root, out_dir=out, battery=battery,
                       selection=selection, require_complete=True)
    assert rc == 1


def test_require_complete_passes_once_both_engines_are_present(scene):
    battery, selection, root, out = scene
    _record(root, "vw", "front-loaded6-clojure-legacy", clj=2, py=2)
    manifest, rc = pack.build(replays_root=root, out_dir=out, battery=battery,
                              selection=selection, require_complete=True)
    assert rc == 0
    assert manifest["totals"]["entries"] == 2
    assert manifest["missing"] == []


def test_battery_inventory_digest_is_carried_verbatim(scene):
    battery, selection, root, out = scene
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=selection, require_complete=False)
    assert manifest["battery_inventory_digest"] == json.loads(selection.read_text())["inventory_digest"]
    assert manifest["battery_selected_count"] == 2


def test_verify_accepts_a_faithful_bundle_and_rejects_a_tampered_one(scene, capsys):
    battery, selection, root, out = scene
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=selection, require_complete=False)
    assert _verify(scene) == 0

    archive = out / manifest["entries"][0]["archive"]
    archive.write_bytes(archive.read_bytes() + b"tamper")
    assert _verify(scene) == 1
    assert "DIGEST MISMATCH" in capsys.readouterr().err


def test_verify_reports_a_missing_archive_rather_than_passing(scene):
    battery, selection, root, out = scene
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=selection, require_complete=False)
    (out / manifest["entries"][0]["archive"]).unlink()
    assert _verify(scene) == 1


def test_archive_digest_is_stable_across_repacks(scene):
    """Two packs of the same bytes must agree, so a digest identifies content."""
    battery, selection, root, out = scene
    first, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                          selection=selection, require_complete=False)
    second, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                           selection=selection, require_complete=False)
    assert first["entries"][0]["archive_sha256"] == second["entries"][0]["archive_sha256"]
    assert first["manifest_digest"] == second["manifest_digest"]


def test_without_a_selection_every_battery_entry_is_enumerated(scene):
    battery, _selection, root, out = scene
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=None, require_complete=False)
    assert manifest["skipped_not_public"] == []
    assert manifest["skipped_not_in_inventory"] == []
    assert {e["dataset"] for e in manifest["entries"]} == {"vw", "pakistan"}
    assert manifest["battery_inventory_digest"] == ""


def test_selected_entry_absent_from_battery_is_missing(scene):
    battery, selection, root, out = scene
    battery.write_text(json.dumps(json.loads(battery.read_text())[1:]))
    manifest, rc = pack.build(replays_root=root, out_dir=out, battery=battery,
                              selection=selection, require_complete=True)
    assert rc == 1
    assert any("selected-entry-absent-from-battery" in row["reasons"] for row in manifest["missing"])

@pytest.mark.parametrize("field", ["manifest_digest", "file_sha256", "inventory", "empty", "census", "steps", "bytes"])
@pytest.mark.parametrize("resign", [False, True])
def test_manifest_mutations_refused(scene, field, resign):
    battery, selection, root, out = scene
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=selection, require_complete=False)
    entry = manifest["entries"][0]
    if field == "manifest_digest":
        manifest["manifest_digest"] = "0" * 64
    elif field == "file_sha256":
        entry["engines"]["py"]["file_sha256"]["py/step-000.json"] = "0" * 64
    elif field == "inventory":
        manifest["battery_inventory_digest"] = "0" * 64
    elif field == "empty":
        manifest["entries"] = []
    elif field == "census":
        manifest["missing"] = []
    elif field == "steps":
        entry["engines"]["clj"]["steps"] = 99
    else:
        entry["bytes"] += 1
    if resign and field != "manifest_digest":
        manifest["manifest_digest"] = pack.manifest_digest(manifest)
    (out / pack.MANIFEST_NAME).write_text(json.dumps(manifest))
    assert _verify(scene) == 1


def test_verifier_requires_independent_inventory_anchor(scene):
    battery, selection, root, out = scene
    pack.build(replays_root=root, out_dir=out, battery=battery,
               selection=selection, require_complete=False)
    assert _verify(scene, expected_inventory_digest=None) == 1
    assert _verify(scene, expected_inventory_digest="0" * 64) == 1

@pytest.mark.parametrize("component", ["dataset", "recording", "engine"])
def test_packer_refuses_directory_symlinks(scene, component):
    battery, selection, root, out = scene
    path = root / {"dataset": "vw", "recording": "vw/uniform8-clojure-legacy",
                   "engine": "vw/uniform8-clojure-legacy/clj"}[component]
    outside = root.parent / "outside"
    path.rename(outside)
    path.symlink_to(outside, target_is_directory=True)
    manifest, rc = pack.build(replays_root=root, out_dir=out, battery=battery,
                              selection=selection, require_complete=True)
    assert rc == 1
    assert not manifest["entries"]
    assert not list(out.rglob("*.tar.gz"))

@pytest.mark.parametrize("kind", ["parent", "absolute", "symlink", "hardlink", "duplicate"])
def test_transport_rejects_unsafe_members_before_extraction(tmp_path, kind):
    import io
    archive = tmp_path / "transport.tar"
    with tarfile.open(archive, "w") as tar:
        names = ["recordings-manifest.json", {"parent": "../escape", "absolute": "/escape"}.get(kind, "entries/a__b.tar.gz")]
        if kind == "duplicate":
            names[-1] = names[0]
        for index, name in enumerate(names):
            info = tarfile.TarInfo(name)
            if index and kind in ("symlink", "hardlink"):
                info.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                info.linkname = "../escape"
            else:
                info.size = 2
            tar.addfile(info, io.BytesIO(b"{}"))
    destination = tmp_path / "out"
    assert pack.extract_bundle(archive, destination) == 1
    assert not destination.exists()
    assert not (tmp_path / "escape").exists()


def test_safe_transport_is_verified_then_extracted(scene):
    battery, selection, root, out = scene
    pack.build(replays_root=root, out_dir=out, battery=battery,
               selection=selection, require_complete=False)
    transport = out.parent / "transport.tar"
    with tarfile.open(transport, "w") as tar:
        tar.add(out, arcname=".")
    destination = out.parent / "download"
    assert pack.extract_bundle(transport, destination,
        expected_inventory_digest=json.loads(selection.read_text())["inventory_digest"],
        battery=battery, datasets=battery.parent / "datasets.json") == 0
    assert (destination / pack.MANIFEST_NAME).read_bytes() == (out / pack.MANIFEST_NAME).read_bytes()


def test_inner_archive_traversal_rejected_even_with_updated_digests(scene):
    import io
    battery, selection, root, out = scene
    manifest, _ = pack.build(replays_root=root, out_dir=out, battery=battery,
                             selection=selection, require_complete=False)
    entry = manifest["entries"][0]
    archive = out / entry["archive"]
    with tarfile.open(archive, "w:gz") as tar:
        info = tarfile.TarInfo("vw/uniform8-clojure-legacy/../../escape")
        info.size = 2
        tar.addfile(info, io.BytesIO(b"{}"))
    entry["archive_sha256"] = pack.sha256_file(archive)
    manifest["manifest_digest"] = pack.manifest_digest(manifest)
    (out / pack.MANIFEST_NAME).write_text(json.dumps(manifest))
    assert _verify(scene) == 1
