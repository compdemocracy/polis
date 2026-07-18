"""End-to-end CLI smoke test for scripts/replay_driver.py (Phase H-A).

Drives the real CLI (via click's runner) on the public vw dataset with a tiny
explicit schedule so it stays fast, then compares the recording against itself
(→ match, exit 0). This exercises the whole spine: load → slice → drive →
store → compare.
"""

import importlib.util
import json
from pathlib import Path

import pytest
from click.testing import CliRunner

_CLI_PATH = Path(__file__).resolve().parents[2] / "scripts" / "replay_driver.py"


def _load_cli():
    spec = importlib.util.spec_from_file_location("replay_driver_cli", _CLI_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.cli


@pytest.fixture(scope="module")
def cli():
    return _load_cli()


def _write_schedule(tmp_path):
    # Small vote-count cuts (no "end") → fast prefix recomputes only.
    d = {
        "dataset": "vw",
        "schedule_id": "cli-smoke",
        "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [300, 700]},
        "moderation": "none",
        "clojure": {"warm_start": "chain"},
        "notes": "cli smoke",
    }
    p = tmp_path / "sched.json"
    p.write_text(json.dumps(d))
    return p


def test_run_then_compare_self(cli, tmp_path):
    runner = CliRunner()
    sched_path = _write_schedule(tmp_path)
    store_root = tmp_path / "store"

    res = runner.invoke(
        cli, ["run", "--schedule", str(sched_path), "--out", str(store_root)]
    )
    assert res.exit_code == 0, res.output
    rec_dir = store_root / "vw" / "cli-smoke"
    assert (rec_dir / "schedule.json").exists()
    assert (rec_dir / "provenance.json").exists()
    assert sorted((rec_dir / "py").glob("step-*.json"))

    # schedule.json is verbatim.
    assert json.loads((rec_dir / "schedule.json").read_text())["schedule_id"] == "cli-smoke"

    # Compare the recording against itself → match, exit 0.
    report_path = tmp_path / "report.json"
    res2 = runner.invoke(
        cli, ["compare", str(rec_dir), str(rec_dir), "--report", str(report_path)]
    )
    assert res2.exit_code == 0, res2.output
    assert "MATCH" in res2.output
    report = json.loads(report_path.read_text())
    assert report["overall_match"] is True
    assert report["aligned_steps"] == 2


def test_run_requires_schedule_or_preset(cli):
    runner = CliRunner()
    res = runner.invoke(cli, ["run", "--dataset", "vw"])
    assert res.exit_code != 0
    assert "either --schedule or --preset" in res.output
