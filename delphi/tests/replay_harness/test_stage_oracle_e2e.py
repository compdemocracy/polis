"""End-to-end stage-oracle run on the smallest public battery case (R-ORACLE).

``vw:single-cut`` — "single cold-start recompute over all votes",
``scripts/certify_battery.json`` entry 3, over the public export
``real_data/r6vbnhffkxbd7ifmfbdrd-vw`` (4 683 votes, 69 participants,
125 comments). It is the smallest entry over a dataset that is actually in the
checkout: the other public entries are 6-8-step warm chains or the 56-step
every-vote schedule, and every other battery dataset is prodclone-derived and
absent here.

The run produces BOTH stage recordings and a comparison report:

  1. ``clojure -M:replay --schedule … --stage-json`` -> ``clj-stages/``
  2. ``stages.run_stage_dump`` -> ``py-stages/``
  3. ``stagecompare.compare_recordings`` -> the report

Everything is generated into ``tmp_path``. Nothing is checked in: a single
step's dump for this case is ~350 KB per engine, well over the 200 KB fixture
ceiling, and it would be a derived artifact of two engines at a given commit —
exactly the thing that goes stale silently.

Step 1 needs a JVM and the Clojure toolchain, so the full test is opt-in via
``RUN_CLJ_INTEGRATION=1`` (the gate ``test_certify.py`` already uses). The
Python half and the comparer run unconditionally in
``test_stage_dump_runs_on_the_battery_case``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from polismath.replay import certify, real_data
from polismath.replay import stagecompare as sc
from polismath.replay import stages

_DELPHI_ROOT = Path(__file__).resolve().parents[2]
_MATH_ROOT = _DELPHI_ROOT.parent / "math"

#: The smallest public battery entry (scripts/certify_battery.json).
BATTERY_DATASET = "vw"
BATTERY_PRESET = "single-cut"
BATTERY_SCHEDULE_ID = "single-cut-clojure-legacy"  # derive_schedule_id adds the profile suffix

_HAVE_DATASET = real_data.dataset_dir(BATTERY_DATASET) is not None
_HAVE_CLJ = (
    shutil.which("clojure") is not None
    and (_MATH_ROOT / "dev" / "replay.clj").exists()
    and os.environ.get("RUN_CLJ_INTEGRATION") == "1"
)

requires_dataset = pytest.mark.skipif(
    not _HAVE_DATASET,
    reason=f"public dataset {BATTERY_DATASET!r} not present in this checkout")
requires_clojure = pytest.mark.skipif(
    not _HAVE_CLJ,
    reason="needs the Clojure toolchain and RUN_CLJ_INTEGRATION=1")


def _battery_entry():
    """The battery's own entry, so this test tracks the file rather than a copy."""
    battery = certify.load_battery()
    for e in battery:
        if e.dataset == BATTERY_DATASET and getattr(e, "preset", None) == BATTERY_PRESET:
            return e
    pytest.fail(f"{BATTERY_DATASET}:{BATTERY_PRESET} is no longer in the battery")


def _spec(dataset):
    entry = _battery_entry()
    return certify.build_effective_spec(entry, dataset)


@requires_dataset
def test_the_battery_still_carries_the_case_this_test_pins():
    entry = _battery_entry()
    assert entry.schedule_id == BATTERY_SCHEDULE_ID
    assert "single cold-start recompute" in entry.notes


@requires_dataset
def test_stage_dump_runs_on_the_battery_case(tmp_path):
    """The Python half end-to-end: a real replay of the battery entry produces a
    well-formed stage recording with every stage populated."""
    ds = real_data.load_export_votes(BATTERY_DATASET)
    out = stages.run_stage_dump(ds, _spec(ds),
                                out_dir=tmp_path / "py-stages")

    manifest = json.loads((out / "stages-manifest.json").read_text())
    assert manifest["schema"] == stages.STAGE_DUMP_SCHEMA
    assert manifest["engine"] == "py"
    assert manifest["vote_sign_convention"] == "delphi"
    assert manifest["n_steps"] == 1
    row = manifest["steps"][0]
    assert row["index"] == 0
    assert row["file"] == "step-000.stages.json"
    assert row["input_digest"].startswith("sha256:")
    assert isinstance(row["tick"], int) and row["tick"] > 0

    doc = json.loads((out / row["file"]).read_text())
    assert list(doc["stages"]) == stages.STAGE_ORDER
    r01 = doc["stages"]["R01_ingest"]
    assert r01["n"] == 69 and r01["n-cmts"] == 125
    assert len(r01["tids"]) == 125
    assert doc["stages"]["R04_pca"]["pca"]["center"] is not None
    assert doc["stages"]["R06_base_clusters"]["base-clusters"]
    assert doc["stages"]["R09_group_clusters"]["group-clusters"]
    assert doc["stages"]["R11_repness"]["repness"]

    # The file must be re-readable by the comparer's own loader.
    assert len(sc.load_stage_dumps(out)) == 1


@requires_dataset
def test_a_recording_compared_against_itself_has_no_diverging_stage(tmp_path):
    """A self-comparison is the comparer's negative control: identical inputs
    must produce no diverging stage and zero error everywhere."""
    ds = real_data.load_export_votes(BATTERY_DATASET)
    a = stages.run_stage_dump(ds, _spec(ds), out_dir=tmp_path / "a")
    shutil.copytree(a, tmp_path / "b")

    report = sc.compare_recordings(a, tmp_path / "b")
    assert report["first_diverging_stage"] is None
    assert report["aligned_steps"] == 1
    for stage in report["per_step"][0]["stages"].values():
        for key in stage["keys"].values():
            assert key["n_diff"] == 0
            assert key["max_abs"] == 0.0


@requires_dataset
@requires_clojure
@pytest.mark.clojure_comparison
def test_both_engines_dump_stages_and_the_comparison_report_is_produced(tmp_path):
    """The full R-ORACLE loop on the smallest public battery case.

    Asserts what the harness OWES: both dumps exist, they were fed the same
    batch (equal input digests), and every stage is present on both sides with
    an error report. It does NOT assert a verdict — stage dumps are diagnostics
    (P-030 §2.3), and a numeric threshold here would quietly become the gate the
    plan forbids. The measured first-diverging-stage result is recorded in
    cost-reduction/04-plans/P-030-R-ORACLE-implementation-notes.md.
    """
    ds = real_data.load_export_votes(BATTERY_DATASET)
    spec = _spec(ds)

    schedule_path = tmp_path / "schedule.json"
    spec.write_json(schedule_path)
    votes_csv = certify.votes_csv_path(BATTERY_DATASET)
    assert votes_csv is not None

    proc = subprocess.run(
        ["clojure", "-M:replay",
         "--schedule", str(schedule_path),
         "--votes", str(votes_csv),
         "--out", str(tmp_path),
         "--stage-json"],
        cwd=_MATH_ROOT, capture_output=True, text=True, timeout=1800,
    )
    assert proc.returncode == 0, proc.stderr[-4000:]

    clj_stages = tmp_path / "clj-stages"
    assert (clj_stages / "stages-manifest.json").exists()
    # The sink must not have written into the blob dir: certify globs step-*
    # there for its inventory and digest sets.
    assert not list((tmp_path / "clj").glob("*.stages.json"))

    py_stages = stages.run_stage_dump(ds, spec, out_dir=tmp_path / "py-stages")

    clj_manifest = json.loads((clj_stages / "stages-manifest.json").read_text())
    py_manifest = json.loads((py_stages / "stages-manifest.json").read_text())
    assert clj_manifest["schema"] == py_manifest["schema"] == stages.STAGE_DUMP_SCHEMA
    assert clj_manifest["stage_order"] == py_manifest["stage_order"]
    assert clj_manifest["vote_sign_convention"] == "raw-db"
    assert py_manifest["vote_sign_convention"] == "delphi"

    # Same batch on both sides — the digest is taken in export sign convention
    # precisely so the raw-DB flip does not disturb it.
    assert [r["input_digest"] for r in clj_manifest["steps"]] == \
        [r["input_digest"] for r in py_manifest["steps"]]

    report = sc.compare_recordings(clj_stages, py_stages)
    report_path = tmp_path / "stagecompare.json"
    sc.write_report(report, report_path)
    assert report_path.exists()

    assert report["aligned_steps"] == 1
    assert report["step_count_mismatch"] is False
    # Two complete, step-identity-aligned, same-input recordings: the report is
    # entitled to a headline (review F5 — an invalid input must withhold one).
    assert report["input_valid"] is True, report["input_problems"]
    assert report["headline_withheld"] is False
    step = report["per_step"][0]
    assert step["input_digest_match"] is True
    assert step["tick_match"] is True
    assert step["comparable"] is True
    assert list(step["stages"]) == stages.STAGE_ORDER
    for name, stage in step["stages"].items():
        assert stage["keys"], f"{name} produced no compared keys"
        for key in stage["keys"].values():
            assert key["status"] in ("MATCH", "CARVED", "DIVERGENT",
                                     "ENGINE_LOCAL")
            assert "max_abs" in key and "max_rel" in key

    # The corrected R13 stage carries the engine contract's six geometric
    # columns and is compared with no waiver (review F1). Its Python-only
    # correlation view rides along, explicitly ungraded.
    r13 = step["stages"]["R13_ptpt_stats"]["keys"]
    assert r13["ptpt-stats"]["n_compared"] > 0
    assert "carve_out" not in r13["ptpt-stats"]
    assert r13["participant-info-legacy"]["status"] == "ENGINE_LOCAL"

    # The human rendering must name the first diverging stage either way.
    text = sc.format_report(report)
    assert "first diverging stage" in text
