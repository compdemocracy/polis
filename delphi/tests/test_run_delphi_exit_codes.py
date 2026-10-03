"""run_delphi.py must report a failed stage in its exit code.

The poller marks a job COMPLETED on exit code 0 and FAILED otherwise
(scripts/job_poller.py process_job). run_delphi.py used to force exit 0 after a
UMAP failure and only warned on extremity, priority and visualisation failures,
so a job whose stages failed still read COMPLETED.

These tests run the real run_delphi.py (and, at the end, the real poller
process_job) against a generated fixture: an app directory whose stage scripts
are stubs that exit with a code chosen per test. Nothing here talks to AWS; the
layer discovery is pointed at a closed local port and falls back to layer 0.
"""

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

DELPHI_ROOT = Path(__file__).resolve().parents[1]
RUN_DELPHI = DELPHI_ROOT / "run_delphi.py"

# stage name -> path of its stub script inside the fixture app directory
STAGES = {
    "reset": "umap_narrative/reset_conversation.py",
    "math": "polismath/run_math_pipeline.py",
    "umap": "umap_narrative/run_pipeline.py",
    "extremity": "umap_narrative/501_calculate_comment_extremity.py",
    "priority": "umap_narrative/502_calculate_priorities.py",
    "visualization": "umap_narrative/700_datamapplot_for_layer.py",
}

STUB = '''import os, sys
name = {name!r}
with open(os.environ["STAGE_LOG"], "a") as f:
    f.write(name + "\\n")
sys.exit(int(os.environ.get("STUB_EXIT_" + name.upper(), "0")))
'''


@pytest.fixture
def app_dir(tmp_path, monkeypatch):
    """A generated fixture app directory with stub stages and a python shim."""
    app = tmp_path / "app"
    for name, rel in STAGES.items():
        path = app / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(STUB.format(name=name))
    (app / "run_delphi.py").symlink_to(RUN_DELPHI)

    # run_delphi.py and the poller invoke "python"; make it this interpreter.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    shim = bin_dir / "python"
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)

    log = tmp_path / "stages.log"
    log.write_text("")
    for name in STAGES:
        monkeypatch.delenv("STUB_EXIT_" + name.upper(), raising=False)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("DELPHI_APP_PATH", str(app))
    monkeypatch.setenv("STAGE_LOG", str(log))
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    # Layer discovery: a closed local port, one attempt, dummy credentials.
    monkeypatch.setenv("DYNAMODB_ENDPOINT", "http://127.0.0.1:1")
    monkeypatch.setenv("AWS_MAX_ATTEMPTS", "1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "dummy")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "dummy")
    monkeypatch.chdir(app)  # the reset stage is invoked by a relative path
    return app


def ran_stages(app_dir):
    return Path(os.environ["STAGE_LOG"]).read_text().split()


def run_delphi(app_dir):
    return subprocess.run(
        [sys.executable, str(app_dir / "run_delphi.py"), "--zid=1"],
        cwd=app_dir,
        capture_output=True,
        text=True,
        timeout=120,
    )


ALL_STAGES = ["reset", "math", "umap", "extremity", "priority", "visualization"]


def test_all_stages_succeed_exits_zero(app_dir):
    result = run_delphi(app_dir)
    assert result.returncode == 0, result.stdout + result.stderr
    assert ran_stages(app_dir) == ALL_STAGES


def test_umap_failure_exits_non_zero_and_still_runs_later_stages(app_dir, monkeypatch):
    monkeypatch.setenv("STUB_EXIT_UMAP", "1")
    result = run_delphi(app_dir)
    assert result.returncode != 0, result.stdout
    # What runs is unchanged: extremity and priority still run, and the
    # visualisations are still skipped after a UMAP failure.
    assert ran_stages(app_dir) == ["reset", "math", "umap", "extremity", "priority"]
    assert "UMAP narrative pipeline (exit code 1)" in result.stdout


@pytest.mark.parametrize("stage", ["extremity", "priority", "visualization"])
def test_later_stage_failure_exits_non_zero(app_dir, monkeypatch, stage):
    monkeypatch.setenv("STUB_EXIT_" + stage.upper(), "2")
    result = run_delphi(app_dir)
    assert result.returncode != 0, result.stdout
    assert ran_stages(app_dir) == ALL_STAGES


def test_math_export_failure_exits_non_zero_and_still_runs_later_stages(app_dir, monkeypatch):
    from polismath.run_math_pipeline import MATH_EXPORT_FAILED_EXIT_CODE

    monkeypatch.setenv("STUB_EXIT_MATH", str(MATH_EXPORT_FAILED_EXIT_CODE))
    result = run_delphi(app_dir)
    assert result.returncode != 0, result.stdout
    assert ran_stages(app_dir) == ALL_STAGES


def test_math_failure_still_aborts_before_umap(app_dir, monkeypatch):
    monkeypatch.setenv("STUB_EXIT_MATH", "1")
    result = run_delphi(app_dir)
    assert result.returncode == 1
    assert ran_stages(app_dir) == ["reset", "math"]


# --- the poller: a non-zero run_delphi.py exit marks the job FAILED ---------


class RecordingTable:
    def __init__(self):
        self.updates = []

    def update_item(self, **kwargs):
        self.updates.append(kwargs)
        return {}


def run_full_pipeline_job(app_dir):
    from scripts.job_poller import JobProcessor

    table = RecordingTable()
    worker = JobProcessor.__new__(JobProcessor)
    worker.worker_id = "generated-fixture-worker"
    worker.table = table
    worker.update_job_logs = lambda *args, **kwargs: None
    worker.release_lock = lambda *args, **kwargs: None
    worker.process_job(
        {
            "job_id": "generated-fixture-job",
            "job_type": "FULL_PIPELINE",
            "conversation_id": "1",
            "timeout_seconds": 120,
            "job_config": json.dumps({"include_moderation": True}),
            "version": 1,
        }
    )
    statuses = [u["ExpressionAttributeValues"][":new_status"] for u in table.updates]
    assert len(statuses) == 1, statuses
    return statuses[0], json.loads(table.updates[0]["ExpressionAttributeValues"][":job_results"])


def test_poller_marks_job_failed_when_umap_stage_fails(app_dir, monkeypatch):
    monkeypatch.setenv("STUB_EXIT_UMAP", "1")
    status, results = run_full_pipeline_job(app_dir)
    assert status == "FAILED"
    assert results["result_type"] == "FAILURE"


def test_poller_marks_job_completed_when_every_stage_succeeds(app_dir):
    status, results = run_full_pipeline_job(app_dir)
    assert status == "COMPLETED"
    assert results["result_type"] == "SUCCESS"


# --- run_pipeline.main: a conversation that could not be processed fails ----


def _run_pipeline_module():
    umap_dir = str(DELPHI_ROOT / "umap_narrative")
    if umap_dir not in sys.path:
        sys.path.insert(0, umap_dir)
    import run_pipeline

    return run_pipeline


@pytest.mark.parametrize("processed, expected_exit", [(False, 1), (True, None)])
def test_run_pipeline_main_exit_code_follows_process_conversation(monkeypatch, processed, expected_exit):
    run_pipeline = _run_pipeline_module()
    monkeypatch.setattr(run_pipeline, "setup_environment", lambda **kwargs: None)
    monkeypatch.setattr(run_pipeline, "process_conversation", lambda *a, **kw: processed)
    monkeypatch.setattr(sys, "argv", ["run_pipeline.py", "--zid=1", "--no-dynamo"])
    if expected_exit is None:
        run_pipeline.main()
    else:
        with pytest.raises(SystemExit) as exc:
            run_pipeline.main()
        assert exc.value.code == expected_exit


# --- the poller refuses a job type it does not know --------------------------


@pytest.mark.parametrize("job_type", ["FULL_PIPELIN", "full_pipeline", "", None])
def test_poller_rejects_unknown_job_type_without_running_anything(app_dir, monkeypatch, job_type):
    import scripts.job_poller as jp

    started = []
    monkeypatch.setattr(jp.subprocess, "Popen", lambda *a, **kw: started.append(a) or None)

    table = RecordingTable()
    worker = jp.JobProcessor.__new__(jp.JobProcessor)
    worker.worker_id = "generated-fixture-worker"
    worker.table = table
    worker.update_job_logs = lambda *args, **kwargs: None
    worker.release_lock = lambda *args, **kwargs: None
    job = {
        "job_id": "generated-fixture-job",
        "conversation_id": "1",
        "job_config": "{}",
        "version": 1,
    }
    if job_type is not None:
        job["job_type"] = job_type
    worker.process_job(job)

    assert started == []
    assert ran_stages(app_dir) == []  # in particular, no reset
    (update,) = table.updates
    values = update["ExpressionAttributeValues"]
    assert values[":new_status"] == "FAILED"
    assert "Unknown job_type" in json.loads(values[":job_results"])["error"]
    # Nothing was started, so the exit is certain and the guard may release.
    assert values[":process_exited"] is True


def test_known_job_types_are_exactly_the_three_the_poller_runs():
    from scripts.job_poller import KNOWN_JOB_TYPES

    assert KNOWN_JOB_TYPES == {"FULL_PIPELINE", "CREATE_NARRATIVE_BATCH", "AWAITING_NARRATIVE_BATCH"}
