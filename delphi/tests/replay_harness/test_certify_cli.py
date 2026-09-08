"""CLI-level tests for scripts/certify.py — SPEC A.

Drives the real click CLI via CliRunner, mocking the polismath.replay.certify
library calls that would otherwise touch real datasets, subprocesses, or the
committed ledger — this file never lets a real clojure/py driver run. Verifies
exit codes, flag plumbing, and the end-to-end ≤40-line stdout budget through
the actual CLI entry point. Unit coverage of the pure `render_*_lines`
functions themselves lives in test_certify.py.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

from click.testing import CliRunner

_CLI_PATH = Path(__file__).resolve().parents[2] / "scripts" / "certify.py"


def _module():
    spec = importlib.util.spec_from_file_location("certify_cli", _CLI_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_run_exits_zero_on_all_match(monkeypatch):
    mod = _module()
    report = {"battery": [
        {"dataset": "vw", "schedule_id": "single-cut-clojure-legacy",
         "verdict": "MATCH", "n_steps": 3},
    ], "root": "/tmp/x"}
    monkeypatch.setattr(mod.cert, "load_battery", lambda path: ["entry"])
    monkeypatch.setattr(mod.cert, "run_battery", lambda entries, **kw: report)

    res = CliRunner().invoke(mod.cli, ["run"])
    assert res.exit_code == 0, res.output
    assert mod.cert.ACCEPTANCE_NOTICE in res.output
    assert len(res.output.strip().splitlines()) <= 40


def test_run_exits_nonzero_on_divergence(monkeypatch):
    mod = _module()
    report = {"battery": [
        {"dataset": "vw", "schedule_id": "uniform8-clojure-legacy",
         "verdict": "DIVERGENCE",
         "first_div_step": 2, "n_div_steps": 1, "top_paths": []},
    ], "root": "/tmp/x"}
    monkeypatch.setattr(mod.cert, "load_battery", lambda path: ["entry"])
    monkeypatch.setattr(mod.cert, "run_battery", lambda entries, **kw: report)

    res = CliRunner().invoke(mod.cli, ["run"])
    assert res.exit_code == 1, res.output


def test_run_exits_nonzero_on_error(monkeypatch):
    mod = _module()
    report = {"battery": [
        {"dataset": "vw", "schedule_id": "x",
         "verdict": "ERROR", "stage": "py-driver", "reason": "boom"},
    ], "root": "/tmp/x"}
    monkeypatch.setattr(mod.cert, "load_battery", lambda path: ["entry"])
    monkeypatch.setattr(mod.cert, "run_battery", lambda entries, **kw: report)

    res = CliRunner().invoke(mod.cli, ["run"])
    assert res.exit_code == 1, res.output


def test_run_skipped_ok_by_default_but_fails_with_strict(monkeypatch):
    mod = _module()
    report = {"battery": [
        {"dataset": "vw", "schedule_id": "x",
         "verdict": "SKIPPED", "reason": "dataset-unavailable"},
    ], "root": "/tmp/x"}
    monkeypatch.setattr(mod.cert, "load_battery", lambda path: ["entry"])
    monkeypatch.setattr(mod.cert, "run_battery", lambda entries, **kw: report)

    res = CliRunner().invoke(mod.cli, ["run"])
    assert res.exit_code == 0, res.output

    res_strict = CliRunner().invoke(mod.cli, ["run", "--strict"])
    assert res_strict.exit_code == 1, res_strict.output


def test_run_passes_cli_flags_through_to_library(monkeypatch):
    mod = _module()
    captured: dict = {}

    def fake_run_battery(entries, **kw):
        captured.update(kw)
        return {"battery": [], "root": "/tmp/x"}

    monkeypatch.setattr(mod.cert, "load_battery", lambda path: [])
    monkeypatch.setattr(mod.cert, "run_battery", fake_run_battery)

    res = CliRunner().invoke(
        mod.cli,
        ["run", "--only", "vw:uniform8-clojure-legacy", "--refresh-clj", "--refresh-py"],
    )
    assert res.exit_code == 0, res.output
    assert captured["only"] == "vw:uniform8-clojure-legacy"
    assert captured["refresh_clj"] is True
    assert captured["refresh_py"] is True


def test_run_passes_workers_through_and_defaults_to_six(monkeypatch):
    mod = _module()
    captured: dict = {}

    def fake_run_battery(entries, **kw):
        captured.update(kw)
        return {"battery": [], "root": "/tmp/x"}

    monkeypatch.setattr(mod.cert, "load_battery", lambda path: [])
    monkeypatch.setattr(mod.cert, "run_battery", fake_run_battery)

    res = CliRunner().invoke(mod.cli, ["run", "--workers", "3"])
    assert res.exit_code == 0, res.output
    assert captured["workers"] == 3

    captured.clear()
    res = CliRunner().invoke(mod.cli, ["run"])
    assert res.exit_code == 0, res.output
    assert captured["workers"] == 6


def test_run_stdout_budget_with_large_mocked_battery(monkeypatch):
    mod = _module()
    report = {
        "battery": [
            {"dataset": "vw", "schedule_id": f"s{i}-clojure-legacy",
             "verdict": "MATCH", "n_steps": 3}
            for i in range(200)
        ],
        "root": "/tmp/x",
    }
    monkeypatch.setattr(mod.cert, "load_battery", lambda path: ["entry"] * 200)
    monkeypatch.setattr(mod.cert, "run_battery", lambda entries, **kw: report)

    res = CliRunner().invoke(mod.cli, ["run"])
    assert res.exit_code == 0, res.output
    assert len(res.output.strip().splitlines()) <= 40


def test_focus_exits_zero_on_match(monkeypatch):
    mod = _module()
    monkeypatch.setattr(
        mod.cert, "run_focus",
        lambda ds, sid, root=None: {"dataset": ds, "schedule_id": sid,
                                     "verdict": "MATCH", "n_steps": 4},
    )
    res = CliRunner().invoke(mod.cli, ["focus", "vw", "uniform8-clojure-legacy"])
    assert res.exit_code == 0, res.output
    assert mod.cert.ACCEPTANCE_NOTICE in res.output


def test_focus_exits_nonzero_on_divergence(monkeypatch):
    mod = _module()
    monkeypatch.setattr(mod.cert, "run_focus", lambda ds, sid, root=None: {
        "dataset": ds, "schedule_id": sid, "verdict": "DIVERGENCE", "step": 1,
        "families": {
            "exact": [{"path": "step_1.n", "a": 3, "b": 4, "known": None}],
            "tolerant": [],
        },
    })
    res = CliRunner().invoke(mod.cli, ["focus", "vw", "uniform8-clojure-legacy"])
    assert res.exit_code == 1, res.output
    assert len(res.output.strip().splitlines()) <= 40


def test_focus_exits_nonzero_on_error(monkeypatch):
    mod = _module()
    monkeypatch.setattr(mod.cert, "run_focus", lambda ds, sid, root=None: {
        "dataset": ds, "schedule_id": sid, "verdict": "ERROR",
        "stage": "recording-missing", "reason": "nope",
    })
    res = CliRunner().invoke(mod.cli, ["focus", "vw", "nope"])
    assert res.exit_code == 1, res.output
