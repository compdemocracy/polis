"""Certification battery runner — SPEC A unit tests.

Covers the ``polismath.replay.certify`` library: battery parsing + collision-
free schedule-id derivation, clj/py recording caches (subprocess calls always
MOCKED — never invoke real clojure or the real py driver here), the hash-first
step-compare shortcut + step-verdict cache, the acceptance projection
(subgroup-* dropped, CLOJURE_QUIRKS.md Q7), fingerprint normalization + the
divergences.json ledger, the first-divergence focuser, and the stdout
line-budget for both `run` and `focus`.

CLI-level (click) tests live in test_certify_cli.py.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from polismath.replay import certify as cert
from polismath.replay import schedule as sched
from polismath.replay.crosslang import PREP_MAIN_KEYS

CERTIFY_BATTERY_PATH = Path(__file__).resolve().parents[2] / "scripts" / "certify_battery.json"


# ---------------------------------------------------------------------------
# Fixtures / helpers.
# ---------------------------------------------------------------------------
def _acceptance_blob(n: int = 3, first_comp: float = 1.0) -> dict:
    """A minimal math_main-shaped blob (prep-main key spelling)."""
    return {
        "zid": "t",
        "n": n,
        "n-cmts": 2,
        "in-conv": [1, 2, 3],
        "tids": [0, 1],
        "pca": {"center": [0.1, 0.2], "comps": [[first_comp, 0.0], [0.0, 1.0]]},
        "base-clusters": {"id": [0, 1], "x": [0.1, -0.1], "y": [0.2, -0.2],
                          "count": [1, 2], "members": [[1], [2, 3]]},
        "repness": {},
    }


def _write_clj_step(clj_dir: Path, index: int, blob: dict) -> None:
    clj_dir.mkdir(parents=True, exist_ok=True)
    (clj_dir / f"step-{index:03d}.blob.json").write_text(json.dumps(blob))


def _write_py_step(py_dir: Path, index: int, blob: dict) -> None:
    py_dir.mkdir(parents=True, exist_ok=True)
    payload = {"index": index, "prev_slot": None, "cut_slot": None,
               "batch_size": None, "cut_time_ms": None, "blob": blob, "extras": {}}
    (py_dir / f"step-{index:03d}.json").write_text(json.dumps(payload))


def _fake_completed(returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout="", stderr=stderr)


def _make_entry(**overrides) -> "cert.BatteryEntry":
    defaults = dict(dataset="vw", engine_mode="clojure-legacy",
                    schedule_id="single-cut-clojure-legacy", preset="single-cut",
                    n_cuts=None, schedule_path=None, notes="")
    defaults.update(overrides)
    return cert.BatteryEntry(**defaults)


# ---------------------------------------------------------------------------
# Schedule-id derivation.
# ---------------------------------------------------------------------------
def test_derive_schedule_id_ncuts_preset():
    assert cert.derive_schedule_id(engine_mode="clojure-legacy", preset="uniform",
                                    n_cuts=8) == "uniform8-clojure-legacy"


def test_derive_schedule_id_no_ncuts_preset():
    assert cert.derive_schedule_id(engine_mode="clojure-legacy",
                                    preset="single-cut") == "single-cut-clojure-legacy"


def test_derive_schedule_id_from_explicit_base_id():
    assert cert.derive_schedule_id(engine_mode="improved",
                                    base_schedule_id="hb-3cut") == "hb-3cut-improved"


def test_derive_schedule_id_collision_free_across_preset_ncuts_engine_mode():
    ids = {
        cert.derive_schedule_id(engine_mode="clojure-legacy", preset="uniform", n_cuts=8),
        cert.derive_schedule_id(engine_mode="improved", preset="uniform", n_cuts=8),
        cert.derive_schedule_id(engine_mode="clojure-legacy", preset="front-loaded", n_cuts=8),
        cert.derive_schedule_id(engine_mode="clojure-legacy", preset="uniform", n_cuts=6),
    }
    assert len(ids) == 4


# ---------------------------------------------------------------------------
# Battery parsing.
# ---------------------------------------------------------------------------
def test_parse_battery_entry_preset_form():
    e = cert.parse_battery_entry(
        {"dataset": "vw", "preset": "uniform", "n_cuts": 8, "engine_mode": "clojure-legacy"}
    )
    assert e.dataset == "vw"
    assert e.engine_mode == "clojure-legacy"
    assert e.preset == "uniform" and e.n_cuts == 8
    assert e.schedule_id == "uniform8-clojure-legacy"
    assert e.schedule_path is None


def test_parse_battery_entry_defaults_engine_mode_to_clojure_legacy():
    e = cert.parse_battery_entry({"dataset": "vw", "preset": "single-cut"})
    assert e.engine_mode == "clojure-legacy"


def test_parse_battery_entry_ncuts_preset_requires_n_cuts():
    with pytest.raises(ValueError, match="n_cuts"):
        cert.parse_battery_entry({"dataset": "vw", "preset": "uniform"})


def test_parse_battery_entry_unknown_preset_rejected():
    with pytest.raises(ValueError, match="preset"):
        cert.parse_battery_entry({"dataset": "vw", "preset": "bogus"})


def test_parse_battery_entry_schedule_form_reads_base_id_from_file(tmp_path):
    schedule_json = {"dataset": "vw", "schedule_id": "hb-3cut",
                      "cuts": {"mode": "vote-count", "at": ["end"]}}
    p = tmp_path / "sched.json"
    p.write_text(json.dumps(schedule_json))
    e = cert.parse_battery_entry({"dataset": "vw", "schedule": "sched.json"}, battery_dir=tmp_path)
    assert e.schedule_path == p
    assert e.schedule_id == "hb-3cut-clojure-legacy"


def test_load_battery_starter_file_shape():
    entries = cert.load_battery(CERTIFY_BATTERY_PATH)
    ids = {(e.dataset, e.schedule_id) for e in entries}
    assert ("vw", "uniform8-clojure-legacy") in ids
    assert ("vw", "front-loaded6-clojure-legacy") in ids
    assert ("vw", "single-cut-clojure-legacy") in ids
    assert ("biodiversity", "uniform8-clojure-legacy") in ids
    assert len(entries) == 4
    assert all(e.engine_mode == "clojure-legacy" for e in entries)


# ---------------------------------------------------------------------------
# Tree / file hashing.
# ---------------------------------------------------------------------------
def test_sha256_tree_stable_and_sensitive_to_content(tmp_path):
    d = tmp_path / "pkg"
    d.mkdir()
    (d / "a.py").write_text("x = 1\n")
    (d / "sub").mkdir()
    (d / "sub" / "b.py").write_text("y = 2\n")

    h1 = cert.sha256_tree(d, "**/*.py")
    h2 = cert.sha256_tree(d, "**/*.py")
    assert h1 == h2

    (d / "a.py").write_text("x = 2\n")
    h3 = cert.sha256_tree(d, "**/*.py")
    assert h3 != h1


def test_sha256_tree_sensitive_to_relpath_not_just_content(tmp_path):
    d1 = tmp_path / "d1"
    d1.mkdir()
    (d1 / "a.py").write_text("x=1\n")
    d2 = tmp_path / "d2"
    d2.mkdir()
    (d2 / "b.py").write_text("x=1\n")
    assert cert.sha256_tree(d1, "**/*.py") != cert.sha256_tree(d2, "**/*.py")


def test_canonical_schedule_hash_ignores_id_but_sees_cuts():
    s1 = sched.preset_uniform("vw", 100, n_cuts=8, schedule_id="a")
    s2 = sched.preset_uniform("vw", 100, n_cuts=8, schedule_id="b")
    s3 = sched.preset_uniform("vw", 100, n_cuts=6, schedule_id="a")
    assert cert.canonical_schedule_hash(s1) == cert.canonical_schedule_hash(s2)
    assert cert.canonical_schedule_hash(s1) != cert.canonical_schedule_hash(s3)


# ---------------------------------------------------------------------------
# Acceptance projection (CLOJURE_QUIRKS.md Q7 — subgroup-* dead feature).
# ---------------------------------------------------------------------------
def test_project_acceptance_drops_subgroup_keys():
    blob = {k: f"v-{k}" for k in PREP_MAIN_KEYS}
    proj = cert.project_acceptance(blob)
    assert "subgroup-clusters" not in proj
    assert "subgroup-votes" not in proj
    assert "subgroup-repness" not in proj
    assert set(proj) == PREP_MAIN_KEYS - cert.ACCEPTANCE_EXCLUDED_KEYS
    assert proj["pca"] == "v-pca"


# ---------------------------------------------------------------------------
# Hash-first compare + step-verdict cache.
# ---------------------------------------------------------------------------
def test_hash_first_shortcut_skips_comparer_entirely(tmp_path, monkeypatch):
    blob = _acceptance_blob(n=3)
    _write_clj_step(tmp_path / "clj", 0, blob)
    _write_py_step(tmp_path / "py", 0, blob)

    comparer = cert._acceptance_projecting_comparer()
    calls = {"n": 0}
    orig = comparer.compare_step

    def spy(a, b, i):
        calls["n"] += 1
        return orig(a, b, i)

    monkeypatch.setattr(comparer, "compare_step", spy)

    result = cert.compare_recording_pair(
        tmp_path / "clj", tmp_path / "py", engine_mode="clojure-legacy",
        cache_root=tmp_path, comparer=comparer,
    )
    assert calls["n"] == 0
    assert result["per_step"][0]["match"] is True
    assert result["per_step"][0]["hash_match"] is True


def test_hash_mismatch_falls_back_to_comparer(tmp_path, monkeypatch):
    _write_clj_step(tmp_path / "clj", 0, _acceptance_blob(n=3))
    _write_py_step(tmp_path / "py", 0, _acceptance_blob(n=99))

    comparer = cert._acceptance_projecting_comparer()
    calls = {"n": 0}
    orig = comparer.compare_step

    def spy(a, b, i):
        calls["n"] += 1
        return orig(a, b, i)

    monkeypatch.setattr(comparer, "compare_step", spy)

    result = cert.compare_recording_pair(
        tmp_path / "clj", tmp_path / "py", engine_mode="clojure-legacy",
        cache_root=tmp_path, comparer=comparer,
    )
    assert calls["n"] == 1
    assert result["per_step"][0]["match"] is False
    assert result["per_step"][0]["hash_match"] is False


def test_step_verdict_cache_round_trip(tmp_path, monkeypatch):
    _write_clj_step(tmp_path / "clj", 0, _acceptance_blob(n=3))
    _write_py_step(tmp_path / "py", 0, _acceptance_blob(n=99))

    comparer1 = cert._acceptance_projecting_comparer()
    calls1 = {"n": 0}
    orig1 = comparer1.compare_step

    def spy1(a, b, i):
        calls1["n"] += 1
        return orig1(a, b, i)

    monkeypatch.setattr(comparer1, "compare_step", spy1)
    r1 = cert.compare_recording_pair(tmp_path / "clj", tmp_path / "py",
                                      engine_mode="clojure-legacy", cache_root=tmp_path,
                                      comparer=comparer1)
    assert calls1["n"] == 1

    # Fresh comparer instance, same config -> must hit the on-disk step-verdict
    # cache and NOT call compare_step again.
    comparer2 = cert._acceptance_projecting_comparer()
    calls2 = {"n": 0}
    orig2 = comparer2.compare_step

    def spy2(a, b, i):
        calls2["n"] += 1
        return orig2(a, b, i)

    monkeypatch.setattr(comparer2, "compare_step", spy2)
    r2 = cert.compare_recording_pair(tmp_path / "clj", tmp_path / "py",
                                      engine_mode="clojure-legacy", cache_root=tmp_path,
                                      comparer=comparer2)
    assert calls2["n"] == 0
    assert r2["per_step"][0]["families"] == r1["per_step"][0]["families"]


# ---------------------------------------------------------------------------
# Fingerprint normalization.
# ---------------------------------------------------------------------------
def test_normalize_path_strips_step_prefix_and_bracket_indices():
    assert cert.normalize_path("step_3.pca.comps[0][1]") == "pca.comps[][]"


def test_normalize_path_strips_dict_numeric_segments():
    assert cert.normalize_path(
        "step_0.comment-priorities.123.priority"
    ) == "comment-priorities.N.priority"


def test_compute_fingerprint_stable_across_indices():
    fp1 = cert.compute_fingerprint("step_1.pca.comps[0][1]", "tolerant", "clojure-legacy")
    fp2 = cert.compute_fingerprint("step_9.pca.comps[3][7]", "tolerant", "clojure-legacy")
    assert fp1 == fp2
    assert len(fp1) == 10


def test_compute_fingerprint_differs_by_family_and_engine_mode():
    a = cert.compute_fingerprint("step_1.pca.comps[0][1]", "tolerant", "clojure-legacy")
    b = cert.compute_fingerprint("step_1.pca.comps[0][1]", "exact", "clojure-legacy")
    c = cert.compute_fingerprint("step_1.pca.comps[0][1]", "tolerant", "improved")
    assert len({a, b, c}) == 3


# ---------------------------------------------------------------------------
# Ledger.
# ---------------------------------------------------------------------------
def test_update_ledger_appends_new_as_open():
    obs = [{"path_pattern": "pca.comps[][]", "family": "tolerant", "engine_mode": "clojure-legacy",
            "dataset": "vw", "schedule_id": "uniform8-clojure-legacy", "step": 3}]
    updated = cert.update_ledger({}, obs)
    key = cert.fingerprint_key_for("pca.comps[][]", "tolerant", "clojure-legacy")
    assert key in updated
    assert updated[key]["status"] == "open"
    assert updated[key]["diagnosis"] is None
    assert updated[key]["first_seen"] == {"dataset": "vw", "schedule": "uniform8-clojure-legacy", "step": 3}


def test_update_ledger_preserves_existing_diagnosis():
    key = cert.fingerprint_key_for("pca.comps[][]", "tolerant", "clojure-legacy")
    ledger = {key: {"path_pattern": "pca.comps[][]", "family": "tolerant",
                     "engine_mode": "clojure-legacy",
                     "first_seen": {"dataset": "vw", "schedule": "uniform8-clojure-legacy", "step": 1},
                     "status": "diagnosed", "diagnosis": "PCA power-iteration seed differs (see #123)"}}
    obs = [{"path_pattern": "pca.comps[][]", "family": "tolerant", "engine_mode": "clojure-legacy",
            "dataset": "biodiversity", "schedule_id": "uniform8-clojure-legacy", "step": 7}]
    updated = cert.update_ledger(ledger, obs)
    assert updated[key]["status"] == "diagnosed"
    assert updated[key]["diagnosis"] == "PCA power-iteration seed differs (see #123)"
    assert updated[key]["first_seen"]["dataset"] == "vw"


def test_save_and_load_ledger_round_trip_sorted(tmp_path):
    path = tmp_path / "divergences.json"
    ledger = {"FP-b000000000": {"status": "open"}, "FP-a000000000": {"status": "open"}}
    cert.save_ledger(ledger, path)
    text = path.read_text()
    assert text.index('"FP-a000000000"') < text.index('"FP-b000000000"')
    assert cert.load_ledger(path) == ledger


def test_load_ledger_missing_file_returns_empty_dict(tmp_path):
    assert cert.load_ledger(tmp_path / "does-not-exist.json") == {}


def test_annotate_by_key_with_and_without_diagnosis():
    ledger = {"FP-x": {"status": "open", "diagnosis": None},
              "FP-y": {"status": "diagnosed", "diagnosis": "A" * 100}}
    assert cert.annotate_by_key(ledger, "FP-x") == "[known FP-x: status=open]"
    assert cert.annotate_by_key(ledger, "FP-y") == f"[known FP-y: {'A' * 60}]"
    assert cert.annotate_by_key(ledger, "FP-missing") is None


# ---------------------------------------------------------------------------
# Recording caches (subprocess calls MOCKED).
# ---------------------------------------------------------------------------
def test_ensure_py_recording_cache_hit_then_miss_on_change(tmp_path, monkeypatch):
    calls = {"n": 0}

    def fake_run(cmd, *, cwd, env):
        calls["n"] += 1
        return _fake_completed()

    monkeypatch.setattr(cert, "_run_subprocess", fake_run)

    entry = _make_entry()
    spec = sched.preset_single_cut("vw", 100, schedule_id=entry.schedule_id)

    _, cached1 = cert.ensure_py_recording(entry, spec, "votes-sha-1", root=tmp_path)
    assert cached1 is False and calls["n"] == 1

    _, cached2 = cert.ensure_py_recording(entry, spec, "votes-sha-1", root=tmp_path)
    assert cached2 is True and calls["n"] == 1

    _, cached3 = cert.ensure_py_recording(entry, spec, "votes-sha-2", root=tmp_path)
    assert cached3 is False and calls["n"] == 2

    _, cached4 = cert.ensure_py_recording(entry, spec, "votes-sha-2", root=tmp_path, refresh=True)
    assert cached4 is False and calls["n"] == 3


def test_ensure_py_recording_raises_certify_error_on_nonzero_exit(tmp_path, monkeypatch):
    def fake_run(cmd, *, cwd, env):
        return _fake_completed(returncode=1, stderr="boom")

    monkeypatch.setattr(cert, "_run_subprocess", fake_run)

    entry = _make_entry()
    spec = sched.preset_single_cut("vw", 10, schedule_id=entry.schedule_id)
    with pytest.raises(cert.CertifyError) as exc_info:
        cert.ensure_py_recording(entry, spec, "sha", root=tmp_path)
    assert exc_info.value.stage


def test_ensure_clj_recording_cache_hit_then_miss_on_change(tmp_path, monkeypatch):
    calls = {"n": 0}

    def fake_run(cmd, *, cwd, env):
        calls["n"] += 1
        return _fake_completed()

    monkeypatch.setattr(cert, "_run_subprocess", fake_run)

    entry = _make_entry()
    spec = sched.preset_single_cut("vw", 100, schedule_id=entry.schedule_id)
    votes_csv = tmp_path / "vw-votes.csv"

    _, cached1 = cert.ensure_clj_recording(entry, spec, "votes-sha-1", votes_csv, root=tmp_path)
    assert cached1 is False and calls["n"] == 1

    _, cached2 = cert.ensure_clj_recording(entry, spec, "votes-sha-1", votes_csv, root=tmp_path)
    assert cached2 is True and calls["n"] == 1

    _, cached3 = cert.ensure_clj_recording(entry, spec, "votes-sha-1", votes_csv, root=tmp_path,
                                            refresh=True)
    assert cached3 is False and calls["n"] == 2


def test_ensure_clj_recording_raises_certify_error_on_nonzero_exit(tmp_path, monkeypatch):
    def fake_run(cmd, *, cwd, env):
        return _fake_completed(returncode=1, stderr="clojure blew up")

    monkeypatch.setattr(cert, "_run_subprocess", fake_run)

    entry = _make_entry()
    spec = sched.preset_single_cut("vw", 10, schedule_id=entry.schedule_id)
    with pytest.raises(cert.CertifyError) as exc_info:
        cert.ensure_clj_recording(entry, spec, "sha", tmp_path / "votes.csv", root=tmp_path)
    assert exc_info.value.stage


def test_certify_entry_skipped_for_missing_dataset(tmp_path):
    entry = _make_entry(dataset="no-such-dataset-xyz")
    result, ledger = cert.certify_entry(entry, root=tmp_path, ledger={})
    assert result["verdict"] == "SKIPPED"
    assert result["reason"] == "dataset-unavailable"
    assert ledger == {}


# ---------------------------------------------------------------------------
# Focuser.
# ---------------------------------------------------------------------------
def test_run_focus_picks_earliest_divergent_step(tmp_path):
    ds, sid = "vw", "uniform8-clojure-legacy"
    rec_dir = tmp_path / ds / sid
    clj_blobs = [_acceptance_blob(n=3), _acceptance_blob(n=4), _acceptance_blob(n=5)]
    py_blobs = [_acceptance_blob(n=3), _acceptance_blob(n=44), _acceptance_blob(n=55)]
    for i, b in enumerate(clj_blobs):
        _write_clj_step(rec_dir / "clj", i, b)
    for i, b in enumerate(py_blobs):
        _write_py_step(rec_dir / "py", i, b)

    ledger_path = tmp_path / "divergences.json"
    result = cert.run_focus(ds, sid, root=tmp_path, ledger_path=ledger_path)
    assert result["verdict"] == "DIVERGENCE"
    assert result["step"] == 1
    assert (rec_dir / "focus-report.json").exists()
    # The ledger is written to the INJECTED path, never the real committed one.
    assert ledger_path.exists()


def test_run_focus_match_when_no_divergence(tmp_path):
    ds, sid = "vw", "uniform8-clojure-legacy"
    rec_dir = tmp_path / ds / sid
    blobs = [_acceptance_blob(n=3), _acceptance_blob(n=4)]
    for i, b in enumerate(blobs):
        _write_clj_step(rec_dir / "clj", i, b)
        _write_py_step(rec_dir / "py", i, b)

    result = cert.run_focus(ds, sid, root=tmp_path, ledger_path=tmp_path / "divergences.json")
    assert result["verdict"] == "MATCH"
    assert result["n_steps"] == 2


def test_run_focus_missing_recording_is_error(tmp_path):
    result = cert.run_focus("vw", "no-such-schedule", root=tmp_path,
                             ledger_path=tmp_path / "divergences.json")
    assert result["verdict"] == "ERROR"


# ---------------------------------------------------------------------------
# stdout line budget.
# ---------------------------------------------------------------------------
def test_render_run_lines_within_budget_for_many_entries():
    results = [
        {"dataset": "vw", "schedule_id": f"s{i}-clojure-legacy", "engine_mode": "clojure-legacy",
         "verdict": "MATCH", "n_steps": 5}
        for i in range(100)
    ]
    report = {"battery": results, "root": "/tmp/x"}
    lines = cert.render_run_lines(report)
    assert len(lines) <= 40
    assert cert.ACCEPTANCE_NOTICE in lines


def test_render_run_lines_small_battery_one_line_per_entry():
    results = [
        {"dataset": "vw", "schedule_id": "single-cut-clojure-legacy", "engine_mode": "clojure-legacy",
         "verdict": "MATCH", "n_steps": 3},
        {"dataset": "vw", "schedule_id": "no-dataset", "engine_mode": "clojure-legacy",
         "verdict": "SKIPPED", "reason": "dataset-unavailable"},
    ]
    report = {"battery": results, "root": "/tmp/x"}
    lines = cert.render_run_lines(report)
    assert len(lines) <= 40
    assert any("MATCH" in line for line in lines)
    assert any("SKIPPED" in line for line in lines)


def test_render_focus_lines_within_budget_many_divergences():
    result = {
        "dataset": "vw", "schedule_id": "uniform8-clojure-legacy", "engine_mode": "clojure-legacy",
        "verdict": "DIVERGENCE", "step": 2,
        "families": {
            "exact": [{"path": f"step_2.n.{i}", "path_pattern": f"n.{i}", "a": i, "b": i + 1,
                       "fingerprint": f"FP-{i:010d}", "known": None} for i in range(20)],
            "tolerant": [{"path": f"step_2.pca.comps[{i}][0]", "path_pattern": "pca.comps[][]",
                          "a": 0.1 * i, "b": 0.2 * i, "fingerprint": "FP-aaaa", "known": None}
                         for i in range(20)],
        },
    }
    lines = cert.render_focus_lines(result)
    assert len(lines) <= 40


def test_render_focus_lines_caps_exact_divergences_shown():
    result = {
        "dataset": "vw", "schedule_id": "uniform8-clojure-legacy", "engine_mode": "clojure-legacy",
        "verdict": "DIVERGENCE", "step": 0,
        "families": {
            "exact": [{"path": f"step_0.n.{i}", "path_pattern": f"n.{i}", "a": i, "b": i + 1,
                       "fingerprint": f"FP-{i:010d}", "known": None} for i in range(8)],
            "tolerant": [],
        },
    }
    lines = cert.render_focus_lines(result, max_per_family=5)
    shown = [l for l in lines if l.strip().startswith("step_0.n.")]
    assert len(shown) == 5
    assert any("more" in l for l in lines)


# ---------------------------------------------------------------------------
# Battery-level exit code.
# ---------------------------------------------------------------------------
def test_battery_exit_code():
    results = [{"verdict": "MATCH"}, {"verdict": "SKIPPED"}]
    assert cert.battery_exit_code(results, strict=False) == 0
    assert cert.battery_exit_code(results, strict=True) == 1

    results2 = [{"verdict": "MATCH"}, {"verdict": "DIVERGENCE"}]
    assert cert.battery_exit_code(results2, strict=False) == 1


# ---------------------------------------------------------------------------
# Optional integration test: REAL clojure + REAL py drivers on vw single-cut.
# Opt-in only (slow: JVM startup + a full PCA/clustering pass on both engines).
# ---------------------------------------------------------------------------
@pytest.mark.skipif(
    shutil.which("clojure") is None or os.environ.get("RUN_CLJ_INTEGRATION") != "1",
    reason="opt-in: needs the clojure CLI on PATH and RUN_CLJ_INTEGRATION=1 "
           "(runs the REAL clojure + Python drivers, not mocked)",
)
def test_certify_entry_real_drivers_vw_single_cut(tmp_path):
    """End-to-end smoke: real clojure driver + real py driver on vw single-cut.

    Locks the whole pipeline (cache manifests -> subprocess invocation ->
    hash-first compare) against the ACTUAL drivers, not mocks. Verdict is
    intentionally not asserted to be MATCH — Python's clojure-legacy engine
    mode is a parity APPROXIMATION, not a guarantee of bit-identical output;
    this test only proves both drivers ran to completion and certify could
    compare their results end to end.
    """
    entry = cert.parse_battery_entry(
        {"dataset": "vw", "preset": "single-cut", "engine_mode": "clojure-legacy"}
    )
    result, ledger = cert.certify_entry(entry, root=tmp_path, ledger={})
    assert result["verdict"] in ("MATCH", "DIVERGENCE"), result

    rec_dir = tmp_path / "vw" / entry.schedule_id
    assert (rec_dir / "clj" / "step-000.blob.json").exists()
    assert (rec_dir / "py" / "step-000.json").exists()
    assert (rec_dir / "clj" / "cache_manifest.json").exists()
    assert (rec_dir / "py" / "cache_manifest.json").exists()

    # Re-running must be a pure cache hit — no new driver invocation needed.
    calls = {"n": 0}
    real_run_subprocess = cert._run_subprocess

    def spy(cmd, *, cwd, env):
        calls["n"] += 1
        return real_run_subprocess(cmd, cwd=cwd, env=env)

    import unittest.mock

    with unittest.mock.patch.object(cert, "_run_subprocess", spy):
        result2, _ = cert.certify_entry(entry, root=tmp_path, ledger=ledger)
    assert calls["n"] == 0
    assert result2["verdict"] == result["verdict"]
