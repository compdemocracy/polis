"""The per-step lines (delphi_step/1): off by default, and what they carry.

Off (DELPHI_STEP_LOG unset or anything but "1"), nothing is printed and a
child runs exactly as subprocess.run ran it. On, each step prints one line on
standard output with its seconds and peak memory; a child's peak is its own,
exact (wait4). The lines carry counts and labels, never text or ids other than
the daemon's job and attempt ids.
"""

import json
import sys

import pytest

from polismath import step_log
from tests.test_run_delphi_exit_codes import app_dir, ran_stages, run_delphi  # noqa: F401


def lines(text):
    out = []
    for line in text.splitlines():
        if line.startswith(step_log.PREFIX + " "):
            out.append(json.loads(line[len(step_log.PREFIX) + 1:]))
    return out


@pytest.mark.parametrize("value", [None, "", "0", "true"])
def test_off_prints_nothing(monkeypatch, capsys, value):
    if value is None:
        monkeypatch.delenv("DELPHI_STEP_LOG", raising=False)
    else:
        monkeypatch.setenv("DELPHI_STEP_LOG", value)
    with step_log.step("x", n=1) as facts:
        facts["y"] = 2
    step_log.emit("z")
    assert step_log.run_child("c", [sys.executable, "-c", "import sys; sys.exit(3)"]) == 3
    assert capsys.readouterr().out == ""


def test_on_prints_one_line_per_step(monkeypatch, capsys):
    monkeypatch.setenv("DELPHI_STEP_LOG", "1")
    monkeypatch.setenv("DELPHI_JOB_ID", "00000000-0000-4000-8000-000000000001")
    monkeypatch.delenv("DELPHI_ATTEMPT_ID", raising=False)
    with step_log.step("embed_encode", n_comments=3) as facts:
        facts["dims"] = 384
    (line,) = lines(capsys.readouterr().out)
    assert line["step"] == "embed_encode" and line["status"] == "ok"
    assert line["n_comments"] == 3 and line["dims"] == 384
    assert line["job_id"] == "00000000-0000-4000-8000-000000000001"
    assert line["attempt_id"] is None
    assert line["seconds"] >= 0
    assert line["peak_rss_mb"] > 0 and line["process_peak_rss_mb"] > 0
    assert line["peak_scope"] in ("sampled", "process")


def test_a_failed_step_is_recorded_and_still_raises(monkeypatch, capsys):
    monkeypatch.setenv("DELPHI_STEP_LOG", "1")
    with pytest.raises(ValueError):
        with step_log.step("evoc"):
            raise ValueError("no")
    with pytest.raises(SystemExit):
        with step_log.step("run"):
            sys.exit(0)
    with pytest.raises(SystemExit):
        with step_log.step("run"):
            sys.exit(4)
    got = lines(capsys.readouterr().out)
    assert [(g["step"], g["status"]) for g in got] == [("evoc", "failed"), ("run", "ok"), ("run", "failed")]
    assert got[2]["exit_code"] == 4


def test_a_childs_peak_is_its_own(monkeypatch, capsys):
    monkeypatch.setenv("DELPHI_STEP_LOG", "1")
    grow = "b = bytearray(64 * 1024 * 1024); b[::4096] = b'x' * len(b[::4096]); import sys; sys.exit(2)"
    assert step_log.run_child("datamapplot", [sys.executable, "-c", grow], layer=1) == 2
    (line,) = lines(capsys.readouterr().out)
    assert line["step"] == "datamapplot" and line["status"] == "failed"
    assert line["exit_code"] == 2 and line["layer"] == 1 and line["peak_scope"] == "child"
    assert line["peak_rss_mb"] >= 60


def test_run_delphi_reports_its_steps(app_dir, monkeypatch):  # noqa: F811
    monkeypatch.setenv("DELPHI_STEP_LOG", "1")
    result = run_delphi(app_dir)
    assert result.returncode == 0, result.stdout + result.stderr
    got = lines(result.stdout)
    assert [g["step"] for g in got] == ["pipeline", "datamapplot", "run"]
    assert got[0]["peak_scope"] == "child" and got[1]["layer"] == 0
    assert all(g["status"] == "ok" for g in got)
    for g in got:
        assert set(g) <= {"step", "status", "seconds", "peak_rss_mb", "peak_scope", "process_peak_rss_mb",
                          "job_id", "attempt_id", "exit_code", "child_cpu_seconds", "layer"}


def test_run_delphi_reports_the_skipped_pages(app_dir, monkeypatch):  # noqa: F811
    monkeypatch.setenv("DELPHI_STEP_LOG", "1")
    monkeypatch.setenv("DELPHI_SKIP_DATAMAPPLOT", "1")
    result = run_delphi(app_dir)
    assert result.returncode == 0, result.stdout + result.stderr
    got = lines(result.stdout)
    assert [(g["step"], g["status"]) for g in got] == [("pipeline", "ok"), ("datamapplot", "skipped"), ("run", "ok")]


def test_run_delphi_off_prints_no_step_line(app_dir, monkeypatch):  # noqa: F811
    monkeypatch.delenv("DELPHI_STEP_LOG", raising=False)
    result = run_delphi(app_dir)
    assert result.returncode == 0
    assert step_log.PREFIX not in result.stdout
