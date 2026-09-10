"""Clojure timing probe (Spec C) — unit tests + one gated integration test.

Unit tests mock the Clojure subprocess entirely (fast, no toolchain needed).
The single integration test drives the REAL `clojure -M:replay` at the two
smallest sizes; it is skipped unless `clojure` is on PATH AND
RUN_CLJ_INTEGRATION=1 (mirrors the gating convention already used by
math/dev/replay_smoke.sh, which is a manual smoke, not part of the fast suite).
"""

from __future__ import annotations

import csv
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from click.testing import CliRunner

_SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "clj_timing_probe.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("clj_timing_probe", _SCRIPT_PATH)
    mod = importlib.util.module_from_spec(spec)
    # Dataclasses need their defining module registered in sys.modules (it
    # looks itself up there to resolve field types) — exec_module alone does
    # not register it for a dynamically-loaded file.
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def mod():
    return _load_module()


# ---------------------------------------------------------------------------
# parse_sizes
# ---------------------------------------------------------------------------

def test_parse_sizes_dedup_cap_sorted(mod):
    sizes = mod.parse_sizes("500,1000,2000,5000,9999999", n_max=4683)
    assert sizes == [500, 1000, 2000, 4683]  # 5000 and 9999999 both cap to n_max


def test_parse_sizes_ascending_even_if_input_unordered(mod):
    sizes = mod.parse_sizes("2000,500,1000", n_max=10000)
    assert sizes == [500, 1000, 2000]


def test_parse_sizes_rejects_non_positive(mod):
    with pytest.raises(Exception):
        mod.parse_sizes("0,500", n_max=1000)


# ---------------------------------------------------------------------------
# truncate_votes_csv
# ---------------------------------------------------------------------------

def _write_votes_csv(path: Path, n_rows: int) -> None:
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamp", "datetime", "comment-id", "voter-id", "vote"])
        for i in range(n_rows):
            w.writerow([1700000000 + i, "some-date", i % 5, i % 7, 1 if i % 2 == 0 else -1])


def test_truncate_votes_csv_header_preserved_and_exact_row_count(mod, tmp_path):
    src = tmp_path / "votes.csv"
    _write_votes_csv(src, 100)
    dest = tmp_path / "truncated.csv"

    n_written = mod.truncate_votes_csv(src, 10, dest)

    assert n_written == 10
    with dest.open() as f:
        rows = list(csv.reader(f))
    assert rows[0] == ["timestamp", "datetime", "comment-id", "voter-id", "vote"]
    assert len(rows) == 11  # header + 10 data rows
    # first N rows in FILE order (no resort).
    assert rows[1][0] == "1700000000"
    assert rows[10][0] == "1700000009"


def test_truncate_votes_csv_n_greater_than_file_writes_all_rows(mod, tmp_path):
    src = tmp_path / "votes.csv"
    _write_votes_csv(src, 5)
    dest = tmp_path / "truncated.csv"

    n_written = mod.truncate_votes_csv(src, 1000, dest)

    assert n_written == 5
    with dest.open() as f:
        rows = list(csv.reader(f))
    assert len(rows) == 6


# ---------------------------------------------------------------------------
# count_data_rows
# ---------------------------------------------------------------------------

def test_count_data_rows_excludes_header(mod, tmp_path):
    src = tmp_path / "votes.csv"
    _write_votes_csv(src, 42)
    assert mod.count_data_rows(src) == 42


# ---------------------------------------------------------------------------
# build_schedule
# ---------------------------------------------------------------------------

def test_build_schedule_shape(mod):
    sched = mod.build_schedule("vw", 1234)
    assert sched["dataset"] == "vw"
    assert sched["schedule_id"] == "probe-1234"
    assert sched["source"] == "votes-csv"
    assert sched["cuts"] == {"mode": "vote-count", "at": ["end"]}
    assert sched["moderation"] == "none"
    assert sched["clojure"] == {"warm_start": "chain"}


def test_write_schedule_json_roundtrips(mod, tmp_path):
    sched = mod.build_schedule("vw", 500)
    dest = tmp_path / "sched.json"
    mod.write_schedule_json(sched, dest)
    assert json.loads(dest.read_text()) == sched


# ---------------------------------------------------------------------------
# find_final_blob
# ---------------------------------------------------------------------------

def test_find_final_blob_none_when_absent(mod, tmp_path):
    assert mod.find_final_blob(tmp_path / "out") is None


def test_find_final_blob_finds_last_step(mod, tmp_path):
    clj = tmp_path / "out" / "clj"
    clj.mkdir(parents=True)
    (clj / "step-000.blob.json").write_text("{}")
    (clj / "step-001.blob.json").write_text('{"n": 1}')
    found = mod.find_final_blob(tmp_path / "out")
    assert found is not None
    assert found.name == "step-001.blob.json"


# ---------------------------------------------------------------------------
# run_probe_size — MOCKED clojure subprocess.
# ---------------------------------------------------------------------------

def test_run_probe_size_success_writes_temp_inputs_and_reports_ok(mod, tmp_path):
    votes_src = tmp_path / "votes.csv"
    _write_votes_csv(votes_src, 50)

    seen = {}

    def fake_invoke(cmd, cwd, timeout):
        # Locate --votes and --out among cmd args to assert shape, and
        # simulate the clojure driver writing a final step blob.
        seen["cmd"] = cmd
        seen["cwd"] = cwd
        seen["timeout"] = timeout
        votes_arg = Path(cmd[cmd.index("--votes") + 1])
        out_arg = Path(cmd[cmd.index("--out") + 1])
        with votes_arg.open() as f:
            rows = list(csv.reader(f))
        assert len(rows) == 1 + 20  # header + 20 data rows requested below
        clj_dir = out_arg / "clj"
        clj_dir.mkdir(parents=True, exist_ok=True)
        (clj_dir / "step-000.blob.json").write_text('{"n": 20}')
        return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

    result = mod.run_probe_size(
        20, votes_src, dataset="vw", math_dir=tmp_path, timeout=30.0, invoke=fake_invoke
    )

    assert result.ok is True
    assert result.size == 20
    assert result.seconds >= 0.0
    assert result.error is None
    assert seen["cwd"] == tmp_path
    assert seen["timeout"] == 30.0
    assert "-M:replay" in seen["cmd"]


def test_run_probe_size_nonzero_returncode_is_failure(mod, tmp_path):
    votes_src = tmp_path / "votes.csv"
    _write_votes_csv(votes_src, 50)

    def fake_invoke(cmd, cwd, timeout):
        return subprocess.CompletedProcess(cmd, returncode=1, stdout="", stderr="boom")

    result = mod.run_probe_size(
        10, votes_src, dataset="vw", math_dir=tmp_path, timeout=30.0, invoke=fake_invoke
    )
    assert result.ok is False
    assert result.error is not None


def test_run_probe_size_missing_final_blob_is_failure_even_with_returncode_zero(mod, tmp_path):
    votes_src = tmp_path / "votes.csv"
    _write_votes_csv(votes_src, 50)

    def fake_invoke(cmd, cwd, timeout):
        # returncode 0 but never writes a step blob.
        return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

    result = mod.run_probe_size(
        10, votes_src, dataset="vw", math_dir=tmp_path, timeout=30.0, invoke=fake_invoke
    )
    assert result.ok is False
    assert "blob" in result.error.lower()


def test_run_probe_size_timeout_is_failure_but_records_elapsed(mod, tmp_path):
    votes_src = tmp_path / "votes.csv"
    _write_votes_csv(votes_src, 50)

    def fake_invoke(cmd, cwd, timeout):
        raise subprocess.TimeoutExpired(cmd, timeout)

    result = mod.run_probe_size(
        10, votes_src, dataset="vw", math_dir=tmp_path, timeout=0.01, invoke=fake_invoke
    )
    assert result.ok is False
    assert result.seconds >= 0.0
    assert "timeout" in result.error.lower()


def test_run_all_runs_in_ascending_order(mod, tmp_path):
    votes_src = tmp_path / "votes.csv"
    _write_votes_csv(votes_src, 50)
    def fake_invoke(cmd, cwd, timeout):
        out_arg = Path(cmd[cmd.index("--out") + 1])
        clj_dir = out_arg / "clj"
        clj_dir.mkdir(parents=True, exist_ok=True)
        (clj_dir / "step-000.blob.json").write_text("{}")
        return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

    results = mod.run_all(
        [30, 10, 20], votes_src, dataset="vw", math_dir=tmp_path, timeout=30.0, invoke=fake_invoke
    )
    assert [r.size for r in results] == [30, 10, 20]  # run_all does not re-sort; caller must pass sorted


# ---------------------------------------------------------------------------
# fit_power_law — public-fixture power-law recovery.
# ---------------------------------------------------------------------------

def test_fit_power_law_recovers_exponent_within_tolerance(mod):
    """The a_est-from-smallest-run approximation is only unbiased when the
    smallest probed N is small RELATIVE to the others (its own compute term
    must be negligible next to the fixed cost). Using N0=10 vs 1000..8000
    (ratio >= 100x) validates the log-log regression machinery itself,
    isolated from that known approximation error at closely-spaced sizes."""
    a_true = 2.0
    b_true = 1e-9
    k_true = 2.0
    sizes = [10, 1000, 2000, 4000, 8000]
    seconds = [a_true + b_true * (n ** k_true) for n in sizes]

    fit = mod.fit_power_law(sizes, seconds)

    assert fit.k is not None
    assert abs(fit.k - k_true) < 0.01
    assert abs(fit.a_est - a_true) < 0.01


def test_fit_power_law_single_point_yields_no_fit(mod):
    fit = mod.fit_power_law([500], [3.0])
    assert fit.a_est == 3.0
    assert fit.k is None
    assert fit.b is None
    assert fit.n_fit_points == 0


def test_fit_power_law_empty_raises(mod):
    with pytest.raises(ValueError):
        mod.fit_power_law([], [])


def test_fit_power_law_two_points_insufficient_for_regression(mod):
    # Need >= 2 points AFTER excluding the a_est-defining smallest point,
    # i.e. >= 3 sizes total, to fit a line.
    fit = mod.fit_power_law([500, 1000], [3.0, 3.5])
    assert fit.k is None


# ---------------------------------------------------------------------------
# recommend_max_votes
# ---------------------------------------------------------------------------

def test_recommend_max_votes_math(mod):
    fit = mod.FitResult(a_est=2.0, b=1e-9, k=2.0, n_fit_points=3)
    n = mod.recommend_max_votes(fit, budget_min=10.0)
    # a + b*N^k = 600s  ->  N = ((600 - 2) / 1e-9) ** 0.5
    expected = ((600.0 - 2.0) / 1e-9) ** 0.5
    assert n is not None
    assert abs(n - expected) / expected < 1e-6


def test_recommend_max_votes_none_when_no_fit(mod):
    fit = mod.FitResult(a_est=2.0, b=None, k=None, n_fit_points=0)
    assert mod.recommend_max_votes(fit, budget_min=10.0) is None


def test_recommend_max_votes_none_when_a_est_already_exceeds_budget(mod):
    fit = mod.FitResult(a_est=1000.0, b=1e-9, k=2.0, n_fit_points=3)
    assert mod.recommend_max_votes(fit, budget_min=1.0) is None


# ---------------------------------------------------------------------------
# format_report_lines — stdout line budget.
# ---------------------------------------------------------------------------

def test_format_report_lines_one_per_size_plus_fit_plus_recommendation(mod):
    results = [
        mod.ProbeResult(size=500, seconds=3.0, ok=True, error=None),
        mod.ProbeResult(size=1000, seconds=4.0, ok=True, error=None),
        mod.ProbeResult(size=2000, seconds=6.0, ok=True, error=None),
        mod.ProbeResult(size=5000, seconds=None, ok=False, error="returncode=1"),
    ]
    fit = mod.fit_power_law([500, 1000, 2000], [3.0, 4.0, 6.0])
    rec = mod.recommend_max_votes(fit, budget_min=10.0)

    lines = mod.format_report_lines(results, fit, rec, budget_min=10.0)

    assert len(lines) == len(results) + 2  # one per size + fit line + recommendation line
    assert len(lines) <= 20


def test_format_report_lines_stays_under_budget_for_many_sizes(mod):
    results = [
        mod.ProbeResult(size=n, seconds=float(n) / 100, ok=True, error=None)
        for n in [500, 1000, 2000, 3000, 4000, 5000]
    ]
    fit = mod.fit_power_law([r.size for r in results], [r.seconds for r in results])
    rec = mod.recommend_max_votes(fit, budget_min=10.0)
    lines = mod.format_report_lines(results, fit, rec, budget_min=10.0)
    assert len(lines) <= 20


# ---------------------------------------------------------------------------
# build_report — JSON shape.
# ---------------------------------------------------------------------------

def test_build_report_shape(mod):
    results = [
        mod.ProbeResult(size=500, seconds=3.0, ok=True, error=None),
        mod.ProbeResult(size=1000, seconds=None, ok=False, error="boom"),
    ]
    fit = mod.FitResult(a_est=3.0, b=None, k=None, n_fit_points=0)
    report = mod.build_report(
        votes_path=Path("/x/votes.csv"), dataset="vw", dataset_size=1000,
        budget_min=10.0, timeout_sec=900.0, results=results, fit=fit, recommended=None,
    )
    assert report["sizes"] == [500, 1000]
    assert report["seconds"] == [3.0, None]
    assert report["ok"] == [True, False]
    assert report["errors"] == [None, "boom"]
    assert report["fit"]["a_est"] == 3.0
    assert report["recommended_max_votes"] is None
    assert report["dataset"] == "vw"
    assert report["dataset_size"] == 1000
    assert "generated_at" in report


# ---------------------------------------------------------------------------
# CLI end-to-end (mocked subprocess).
# ---------------------------------------------------------------------------

@pytest.mark.skipif(
    not (Path(__file__).resolve().parents[3] / "math" / "dev" / "replay.clj").exists(),
    reason="math/ tree not present (delphi-only CI image runs from /app)",
)
def test_cli_probe_end_to_end_mocked(mod, tmp_path, monkeypatch):
    votes_src = tmp_path / "votes.csv"
    _write_votes_csv(votes_src, 200)
    out_json = tmp_path / "report.json"

    def fake_invoke(cmd, cwd, timeout):
        out_arg = Path(cmd[cmd.index("--out") + 1])
        clj_dir = out_arg / "clj"
        clj_dir.mkdir(parents=True, exist_ok=True)
        (clj_dir / "step-000.blob.json").write_text("{}")
        return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(mod, "_invoke_clojure", fake_invoke)

    runner = CliRunner()
    res = runner.invoke(
        mod.cli,
        [
            "probe",
            "--votes", str(votes_src),
            "--sizes", "50,100,150",
            "--out", str(out_json),
            "--budget-min", "5",
        ],
    )

    assert res.exit_code == 0, res.output
    lines = [l for l in res.output.splitlines() if l.strip()]
    assert len(lines) <= 20
    assert out_json.exists()
    report = json.loads(out_json.read_text())
    assert report["sizes"] == [50, 100, 150]
    assert all(report["ok"])


def test_cli_probe_requires_existing_votes_file(mod, tmp_path):
    runner = CliRunner()
    res = runner.invoke(
        mod.cli,
        ["probe", "--votes", str(tmp_path / "nope.csv"), "--out", str(tmp_path / "r.json")],
    )
    assert res.exit_code != 0


# ---------------------------------------------------------------------------
# Real integration test — gated.
# ---------------------------------------------------------------------------

_HAVE_CLJ = shutil.which("clojure") is not None
_RUN_INTEGRATION = _HAVE_CLJ and __import__("os").environ.get("RUN_CLJ_INTEGRATION") == "1"


@pytest.mark.skipif(
    not _RUN_INTEGRATION,
    reason="needs `clojure` on PATH and RUN_CLJ_INTEGRATION=1 (real subprocess, slow)",
)
def test_real_clojure_driver_two_smallest_sizes(mod, tmp_path):
    votes_src = mod.default_votes_path()
    assert votes_src is not None, "no *-vw/*-votes.csv dataset found"
    n_max = mod.count_data_rows(votes_src)
    sizes = mod.parse_sizes("50,100", n_max=n_max)

    results = mod.run_all(
        sizes, votes_src, dataset="vw", math_dir=mod.MATH_DIR, timeout=600.0
    )

    assert len(results) == 2
    for r in results:
        assert r.ok is True, f"size={r.size} failed: {r.error}"
        assert r.seconds > 0
