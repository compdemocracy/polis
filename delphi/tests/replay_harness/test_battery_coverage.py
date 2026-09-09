"""Battery coverage enumeration — the replacement for a hard-coded entry list.

The P-044 G12 measurement hard-coded the two entries that happened to have
recordings when it was written, so four in-battery entries stayed invisible: an
entry nobody had recorded looked exactly like an entry nobody had asked for.
These tests pin the enumeration that replaces it — the battery is the list, the
disk decides coverage, and BOTH halves are reported by name.

Synthetic recording roots only: no engine, no dataset, no CI. The three cases
the G12 consumer actually hits are `present`, `missing clj` and `missing py`.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_DELPHI = Path(__file__).resolve().parents[2]
_MODULE_PATH = _DELPHI / "scripts" / "battery_coverage.py"


def _load():
    """Load the stdlib-only module by path (scripts/ is not a package)."""
    name = "battery_coverage_under_test"
    spec = importlib.util.spec_from_file_location(name, _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # @dataclass resolves through sys.modules
    spec.loader.exec_module(module)
    return module


bc = _load()


# ---------------------------------------------------------------------------
# Fixture builders.
# ---------------------------------------------------------------------------
def _write_battery(tmp_path: Path, entries: list[dict]) -> Path:
    path = tmp_path / "battery.json"
    path.write_text(json.dumps(entries))
    return path


def _write_steps(step_dir: Path, count: int, suffix: str) -> None:
    step_dir.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        (step_dir / f"step-{i:03d}{suffix}").write_text(json.dumps({"index": i, "blob": {}}))


def _record(root: Path, dataset: str, schedule_id: str, *, clj: int | None, py: int | None) -> Path:
    """Lay down a synthetic recording. ``None`` means that engine never ran."""
    rec = root / dataset / schedule_id
    rec.mkdir(parents=True, exist_ok=True)
    (rec / "schedule.json").write_text(json.dumps({"schedule_id": schedule_id}))
    (rec / "provenance.json").write_text(json.dumps({"engine": "test"}))
    if clj is not None:
        _write_steps(rec / "clj", clj, ".blob.json")
        # The Clojure driver writes a meta file per step alongside each blob;
        # counting `step-*.json` there would double every step count.
        _write_steps(rec / "clj", clj, ".meta.json")
    if py is not None:
        _write_steps(rec / "py", py, ".json")
    return rec


# ---------------------------------------------------------------------------
# Schedule-id derivation (must match certify's, byte for byte).
# ---------------------------------------------------------------------------
def test_derive_schedule_id_forms():
    assert bc.derive_schedule_id(preset="uniform", n_cuts=8) == "uniform8-clojure-legacy"
    assert bc.derive_schedule_id(preset="front-loaded", n_cuts=6) == "front-loaded6-clojure-legacy"
    assert bc.derive_schedule_id(preset="single-cut") == "single-cut-clojure-legacy"
    assert bc.derive_schedule_id(base_schedule_id="every-vote-56") == "every-vote-56-clojure-legacy"


def test_derive_schedule_id_requires_n_cuts_for_cut_presets():
    with pytest.raises(bc.BatteryError):
        bc.derive_schedule_id(preset="uniform")


# ---------------------------------------------------------------------------
# The three coverage cases the G12 measurement consumes.
# ---------------------------------------------------------------------------
@pytest.fixture()
def three_case_root(tmp_path: Path) -> tuple[Path, Path]:
    """A battery of three entries, one per outcome, over synthetic recordings."""
    battery = _write_battery(tmp_path, [
        {"dataset": "vw", "preset": "uniform", "n_cuts": 8},
        {"dataset": "vw", "preset": "front-loaded", "n_cuts": 6},
        {"dataset": "biodiversity", "preset": "uniform", "n_cuts": 8},
    ])
    root = tmp_path / "replays"
    _record(root, "vw", "uniform8-clojure-legacy", clj=8, py=8)          # present
    _record(root, "vw", "front-loaded6-clojure-legacy", clj=None, py=6)  # missing clj
    _record(root, "biodiversity", "uniform8-clojure-legacy", clj=8, py=None)  # missing py
    return battery, root


def test_present_entry_is_covered(three_case_root):
    battery, root = three_case_root
    report = bc.coverage(battery=battery, root=root)
    assert report["enumerated"] == 3
    assert report["covered_keys"] == ["vw/uniform8-clojure-legacy"]
    covered = report["covered"][0]
    assert covered["reasons"] == []
    assert covered["steps"] == 8
    # The clj meta files must not inflate the count.
    assert covered["engines"]["clj"]["steps"] == 8
    assert covered["engines"]["py"]["steps"] == 8


def test_missing_clj_is_reported_by_name(three_case_root):
    battery, root = three_case_root
    report = bc.coverage(battery=battery, root=root)
    row = next(r for r in report["missing"] if r["key"] == "vw/front-loaded6-clojure-legacy")
    assert row["reasons"] == ["missing-clj"]
    assert row["engines"]["py"]["steps"] == 6
    assert row["engines"]["clj"]["present"] is False


def test_missing_py_is_reported_by_name(three_case_root):
    battery, root = three_case_root
    report = bc.coverage(battery=battery, root=root)
    row = next(r for r in report["missing"] if r["key"] == "biodiversity/uniform8-clojure-legacy")
    assert row["reasons"] == ["missing-py"]
    assert row["engines"]["clj"]["steps"] == 8


def test_both_halves_are_always_reported(three_case_root):
    battery, root = three_case_root
    report = bc.coverage(battery=battery, root=root)
    assert len(report["covered"]) + len(report["missing"]) == report["enumerated"]
    assert sorted(report["missing_keys"]) == [
        "biodiversity/uniform8-clojure-legacy",
        "vw/front-loaded6-clojure-legacy",
    ]


def test_no_recording_dir_at_all(tmp_path: Path):
    battery = _write_battery(tmp_path, [{"dataset": "vw", "preset": "single-cut"}])
    report = bc.coverage(battery=battery, root=tmp_path / "nothing-here")
    row = report["missing"][0]
    assert row["reasons"] == ["no-recording-dir", "missing-clj", "missing-py"]


def test_step_count_mismatch_is_not_coverage(tmp_path: Path):
    """A half-written pair must not read as covered — certify refuses it too."""
    battery = _write_battery(tmp_path, [{"dataset": "vw", "preset": "uniform", "n_cuts": 8}])
    root = tmp_path / "replays"
    _record(root, "vw", "uniform8-clojure-legacy", clj=5, py=8)
    report = bc.coverage(battery=battery, root=root)
    assert report["covered"] == []
    assert report["missing"][0]["reasons"] == ["step-count-mismatch"]


def test_empty_engine_directory_is_missing_not_covered(tmp_path: Path):
    battery = _write_battery(tmp_path, [{"dataset": "vw", "preset": "single-cut"}])
    root = tmp_path / "replays"
    rec = _record(root, "vw", "single-cut-clojure-legacy", clj=1, py=1)
    for stale in (rec / "clj").glob("step-*.blob.json"):
        stale.unlink()
    report = bc.coverage(battery=battery, root=root)
    assert report["missing"][0]["reasons"] == ["missing-clj"]


# ---------------------------------------------------------------------------
# Enumeration itself.
# ---------------------------------------------------------------------------
def test_schedule_file_entries_take_their_id_from_the_file(tmp_path: Path):
    (tmp_path / "schedules").mkdir()
    (tmp_path / "schedules" / "vw-every-vote-56.json").write_text(
        json.dumps({"dataset": "vw", "schedule_id": "every-vote-56"}))
    battery = _write_battery(tmp_path, [
        {"dataset": "vw", "schedule": "schedules/vw-every-vote-56.json"},
    ])
    refs = bc.load_battery(battery)
    assert [r.key for r in refs] == ["vw/every-vote-56-clojure-legacy"]
    assert refs[0].schedule == "schedules/vw-every-vote-56.json"


def test_dataset_filter_restricts_enumeration(tmp_path: Path):
    battery = _write_battery(tmp_path, [
        {"dataset": "vw", "preset": "single-cut"},
        {"dataset": "pakistan", "preset": "uniform", "n_cuts": 8},
    ])
    report = bc.coverage(battery=battery, root=tmp_path / "replays", datasets=["vw"])
    assert report["enumerated"] == 1
    assert report["missing_keys"] == ["vw/single-cut-clojure-legacy"]


def test_unsafe_dataset_is_refused(tmp_path: Path):
    battery = _write_battery(tmp_path, [{"dataset": "../etc", "preset": "single-cut"}])
    with pytest.raises(bc.BatteryError):
        bc.load_battery(battery)


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------
def test_require_complete_exits_nonzero_when_an_entry_is_missing(three_case_root, capsys):
    battery, root = three_case_root
    rc = bc.main(["--battery", str(battery), "--root", str(root), "--require-complete"])
    assert rc == 1
    out = capsys.readouterr()
    assert "front-loaded6-clojure-legacy" in out.err


def test_require_complete_passes_when_every_entry_is_present(tmp_path: Path):
    battery = _write_battery(tmp_path, [{"dataset": "vw", "preset": "single-cut"}])
    root = tmp_path / "replays"
    _record(root, "vw", "single-cut-clojure-legacy", clj=1, py=1)
    assert bc.main(["--battery", str(battery), "--root", str(root), "--require-complete"]) == 0


def test_json_output_is_parseable_and_names_both_halves(three_case_root, capsys):
    battery, root = three_case_root
    assert bc.main(["--battery", str(battery), "--root", str(root), "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert len(payload["covered"]) == 1
    assert len(payload["missing"]) == 2
    assert "_engines" not in payload["covered"][0]


# ---------------------------------------------------------------------------
# Drift guard against the real certify implementation.
# ---------------------------------------------------------------------------
def test_agrees_with_certify_on_the_real_battery():
    """The stdlib copy must resolve the shipped battery exactly as certify does.

    This module cannot import certify (it runs on the CI worker under the system
    python3), so the only thing standing between the two is this test.
    """
    certify = pytest.importorskip("polismath.replay.certify")
    real = certify.load_battery(certify.DEFAULT_BATTERY_PATH)
    mine = bc.load_battery(bc.DEFAULT_BATTERY_PATH)
    assert [(e.dataset, e.schedule_id) for e in real] == [(e.dataset, e.schedule_id) for e in mine]
    assert certify._LEGACY_SUFFIX == bc.LEGACY_SUFFIX
    assert set(certify._VALID_PRESETS) == set(bc.VALID_PRESETS)
    assert set(certify._NCUTS_PRESETS) == set(bc.NCUTS_PRESETS)


def test_shipped_battery_enumerates_the_six_public_entries():
    """The six the CI battery runs, named — the list G12 has to cover."""
    refs = bc.load_battery(bc.DEFAULT_BATTERY_PATH)
    public = [r.key for r in refs if r.dataset in ("vw", "biodiversity")]
    assert public == [
        "vw/uniform8-clojure-legacy",
        "vw/front-loaded6-clojure-legacy",
        "vw/single-cut-clojure-legacy",
        "biodiversity/uniform8-clojure-legacy",
        "vw/every-vote-56-clojure-legacy",
        "vw/uniform8-restart4-clojure-legacy",
    ]
