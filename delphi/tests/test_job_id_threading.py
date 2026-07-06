"""P5 (Storage V2 design §4.4): explicit --job-id threading.

The job id must flow to every stage on the COMMAND LINE — today it exists
only as the DELPHI_JOB_ID env var set by the poller, reaching 2 of 18 tables.
Contract under test:

- resolve_job_id precedence: CLI arg > DELPHI_JOB_ID env (transition
  fallback) > auto `local-<uuid4>`;
- run_delphi.py accepts --job-id and passes the SAME id to all six stage
  subprocesses (and exports it for un-migrated env readers);
- every stage entry point accepts --job-id;
- the poller puts --job-id on the run_delphi and 801 command lines (803
  keeps its existing --job-id semantics: the batch-tracking id).
"""

import importlib
import os
import sys
from types import SimpleNamespace

import pytest

from delphi_storage.job_id import resolve_job_id

DELPHI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
UMAP_DIR = os.path.join(DELPHI_DIR, "umap_narrative")
for path in (DELPHI_DIR, UMAP_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)


@pytest.fixture(autouse=True)
def _isolate_delphi_job_id_env():
    """run_delphi.main() writes DELPHI_JOB_ID to the real os.environ (the
    transition export, design §4.4) — monkeypatch can't undo out-of-band
    writes, so restore it ourselves to keep the test session hermetic."""
    original = os.environ.pop("DELPHI_JOB_ID", None)
    yield
    if original is None:
        os.environ.pop("DELPHI_JOB_ID", None)
    else:
        os.environ["DELPHI_JOB_ID"] = original


class TestResolveJobId:
    def test_cli_wins(self, monkeypatch):
        monkeypatch.setenv("DELPHI_JOB_ID", "env-id")
        assert resolve_job_id("cli-id") == "cli-id"

    def test_env_fallback(self, monkeypatch):
        monkeypatch.setenv("DELPHI_JOB_ID", "env-id")
        assert resolve_job_id(None) == "env-id"

    def test_auto_local(self, monkeypatch):
        monkeypatch.delenv("DELPHI_JOB_ID", raising=False)
        generated = resolve_job_id(None)
        assert generated.startswith("local-")
        assert generated != resolve_job_id(None)


def _run_run_delphi(monkeypatch, argv):
    run_delphi = importlib.import_module("run_delphi")
    recorded = []

    def fake_run(cmd, **kwargs):
        recorded.append(list(cmd))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_delphi.subprocess, "run", fake_run)
    monkeypatch.setenv("OLLAMA_MODEL", "test-model")
    monkeypatch.setenv("DELPHI_APP_PATH", DELPHI_DIR)
    # Make the in-function `import boto3` fail so layer discovery falls back
    # to layer 0 without touching the network.
    monkeypatch.setitem(sys.modules, "boto3", None)
    monkeypatch.setattr(sys, "argv", ["run_delphi.py"] + argv)
    with pytest.raises(SystemExit) as excinfo:
        run_delphi.main()
    assert excinfo.value.code == 0
    return recorded


def _job_id_args(cmd):
    return [arg for arg in cmd if arg.startswith("--job-id=")]


class TestRunDelphiThreading:
    def test_explicit_job_id_reaches_all_stages(self, monkeypatch):
        monkeypatch.delenv("DELPHI_JOB_ID", raising=False)
        commands = _run_run_delphi(monkeypatch, ["--zid=123", "--job-id=test-job-1"])
        assert len(commands) == 6, [c[1] for c in commands]
        for cmd in commands:
            assert _job_id_args(cmd) == ["--job-id=test-job-1"], cmd

    def test_auto_job_id_is_shared_across_stages(self, monkeypatch):
        monkeypatch.delenv("DELPHI_JOB_ID", raising=False)
        commands = _run_run_delphi(monkeypatch, ["--zid=123"])
        ids = {arg for cmd in commands for arg in _job_id_args(cmd)}
        assert len(ids) == 1, ids
        (only,) = ids
        assert only.startswith("--job-id=local-")
        # exported for un-migrated env readers (transition, design §4.4)
        assert os.environ.get("DELPHI_JOB_ID") == only.removeprefix("--job-id=")

    def test_env_fallback_still_honored(self, monkeypatch):
        monkeypatch.setenv("DELPHI_JOB_ID", "from-env-7")
        commands = _run_run_delphi(monkeypatch, ["--zid=123"])
        for cmd in commands:
            assert _job_id_args(cmd) == ["--job-id=from-env-7"], cmd


# (module_import_name, cli_entry_attr) — every pipeline stage entry point.
# reset_conversation's CLI lives in cli() (main() is the worker function);
# 801's main() is async.
STAGE_MODULES = [
    ("reset_conversation", "cli"),
    ("polismath.run_math_pipeline", "main"),
    ("run_pipeline", "main"),
    ("501_calculate_comment_extremity", "main"),
    ("502_calculate_priorities", "main"),
    ("700_datamapplot_for_layer", "main"),
    ("801_narrative_report_batch", "main"),
]


class TestStageParsersAcceptJobId:
    @pytest.mark.parametrize("module_name,entry", STAGE_MODULES)
    def test_help_mentions_job_id(self, module_name, entry, monkeypatch, capsys):
        import asyncio
        import inspect

        module = importlib.import_module(module_name)
        monkeypatch.setattr(sys, "argv", [f"{module_name}.py", "--help"])
        entry_point = getattr(module, entry)
        with pytest.raises(SystemExit) as excinfo:
            if inspect.iscoroutinefunction(entry_point):
                asyncio.run(entry_point())
            else:
                entry_point()
        assert excinfo.value.code == 0
        help_text = capsys.readouterr().out
        assert "--job-id" in help_text, f"{module_name} --help lacks --job-id"

    def test_run_pipeline_process_conversation_takes_job_id(self):
        import inspect

        run_pipeline = importlib.import_module("run_pipeline")
        assert "job_id" in inspect.signature(run_pipeline.process_conversation).parameters


class TestPollerCommands:
    def _poller(self):
        return importlib.import_module("scripts.job_poller")

    def test_full_pipeline_command_carries_job_id(self, monkeypatch):
        monkeypatch.setenv("DELPHI_APP_PATH", "/app")
        poller = self._poller()
        cmd = poller.build_job_command(
            {"job_id": "j-123", "job_type": "FULL_PIPELINE", "conversation_id": "42"},
            app_path="/app",
        )
        assert f"/app/run_delphi.py" in " ".join(cmd)
        assert "--job-id=j-123" in cmd

    def test_narrative_batch_command_carries_job_id(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_MODEL", "claude-test")
        poller = self._poller()
        cmd = poller.build_job_command(
            {"job_id": "j-801", "job_type": "CREATE_NARRATIVE_BATCH", "conversation_id": "42"},
            app_path="/app",
        )
        assert "801_narrative_report_batch.py" in " ".join(cmd)
        assert "--job-id=j-801" in cmd

    def test_awaiting_batch_keeps_batch_id_semantics(self):
        poller = self._poller()
        cmd = poller.build_job_command(
            {
                "job_id": "j-803",
                "job_type": "AWAITING_NARRATIVE_BATCH",
                "conversation_id": "42",
                "batch_job_id": "batch-77",
            },
            app_path="/app",
        )
        assert "803_check_batch_status.py" in " ".join(cmd)
        assert "--job-id=batch-77" in cmd
        assert "--job-id=j-803" not in cmd
