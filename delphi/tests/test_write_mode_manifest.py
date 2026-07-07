"""P7a (Storage V2 design §4.3, §6.1 M0→M1): DELPHI_WRITE_MODE + the run
manifest lifecycle mirrored from the old job queue.

Contract under test:

- resolve_write_mode: explicit tri-state old|both|v2 from DELPHI_WRITE_MODE,
  FAIL-LOUD when unset (design §4.3: a silently-defaulted writer would break
  §6.2 invariant 2 undetected). Dev/test environments set it explicitly.
- manifest helpers (ensure_run / mark_running / record_input_fingerprints /
  mark_completed / mark_failed) are idempotent wrappers over the store's
  semantic ops — usable by BOTH the poller and run_delphi without
  coordination (complete_run is already idempotent/crash-healing).
- the poller mirrors FULL_PIPELINE jobs into v2 runs when v2 writes are
  enabled (claim → RUNNING mirror; terminal → COMPLETED/FAILED mirror).
  Narrative job types are deliberately NOT mirrored yet (P7d).
- run_delphi drives capture + manifest from the write mode: old = today's
  behavior; both = capture + manifest, v2-write failures LOG AND CONTINUE
  (M1: the old path must keep serving; divergence is caught by coverage
  tooling); v2 = failures ABORT (v2 is the only store). The explicit
  --snapshot-inputs flag keeps its abort-on-failure semantics.
- purge_zid removes every run's snapshot/artifact partitions for a
  conversation (per-zid GDPR path, §9), via the now-existing manifests.
"""

import importlib
import os
import sys
from types import SimpleNamespace

import pytest

from delphi_storage.backends.memory import MemoryDelphiStore
from delphi_storage.interface import Invalid
from delphi_storage.manifest import (
    ensure_run,
    mark_completed,
    mark_failed,
    mark_running,
    record_input_fingerprints,
)
from delphi_storage.models import JobType, RunStatus, StoreItem
from delphi_storage.purge import purge_zid
from delphi_storage.write_mode import (
    WriteMode,
    old_writes_enabled,
    resolve_write_mode,
    v2_writes_enabled,
)

DELPHI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if DELPHI_DIR not in sys.path:
    sys.path.insert(0, DELPHI_DIR)


class TestResolveWriteMode:
    def test_unset_fails_loud(self, monkeypatch):
        monkeypatch.delenv("DELPHI_WRITE_MODE", raising=False)
        with pytest.raises(Invalid) as excinfo:
            resolve_write_mode()
        assert "DELPHI_WRITE_MODE" in str(excinfo.value)

    @pytest.mark.parametrize("raw,expected", [
        ("old", WriteMode.OLD),
        ("both", WriteMode.BOTH),
        ("v2", WriteMode.V2),
        ("BOTH", WriteMode.BOTH),  # case-insensitive
    ])
    def test_parses(self, monkeypatch, raw, expected):
        monkeypatch.setenv("DELPHI_WRITE_MODE", raw)
        assert resolve_write_mode() is expected

    def test_bogus_fails(self, monkeypatch):
        monkeypatch.setenv("DELPHI_WRITE_MODE", "new")
        with pytest.raises(Invalid):
            resolve_write_mode()

    def test_truth_table(self):
        assert not v2_writes_enabled(WriteMode.OLD)
        assert v2_writes_enabled(WriteMode.BOTH)
        assert v2_writes_enabled(WriteMode.V2)
        assert old_writes_enabled(WriteMode.OLD)
        assert old_writes_enabled(WriteMode.BOTH)
        assert not old_writes_enabled(WriteMode.V2)


class TestManifestHelpers:
    def test_ensure_run_creates_and_is_idempotent(self):
        store = MemoryDelphiStore()
        run = ensure_run(store, job_id="m-1", job_type=JobType.FULL_PIPELINE, zid=7)
        assert run.status == RunStatus.QUEUED
        again = ensure_run(store, job_id="m-1", job_type=JobType.FULL_PIPELINE, zid=7)
        assert again.job_id == "m-1"
        assert store.get_run("m-1") is not None

    def test_mark_running_and_fingerprints(self):
        store = MemoryDelphiStore()
        ensure_run(store, job_id="m-2", job_type=JobType.FULL_PIPELINE, zid=7)
        run = mark_running(store, "m-2")
        assert run.status == RunStatus.RUNNING
        run = record_input_fingerprints(
            store, "m-2", {"votes": {"sha256": "ab", "row_count": 5}}
        )
        assert run.input_fingerprints["votes"]["row_count"] == 5

    def test_completion_flips_latest_and_is_idempotent(self):
        store = MemoryDelphiStore()
        ensure_run(store, job_id="m-3", job_type=JobType.FULL_PIPELINE, zid=9)
        mark_running(store, "m-3")
        mark_completed(store, "m-3")
        pointer = store.get_latest("zid#9#FULL_PIPELINE")
        assert pointer is not None and pointer.job_id == "m-3" and pointer.seq == 1
        mark_completed(store, "m-3")  # idempotent, seq unchanged
        assert store.get_latest("zid#9#FULL_PIPELINE").seq == 1

    def test_mark_failed(self):
        store = MemoryDelphiStore()
        ensure_run(store, job_id="m-4", job_type=JobType.FULL_PIPELINE, zid=9)
        run = mark_failed(store, "m-4", error="boom")
        assert run.status == RunStatus.FAILED and run.error == "boom"
        assert store.get_latest("zid#9#FULL_PIPELINE") is None


class TestPollerMirror:
    """The mirror functions are module-level in scripts.job_poller so they
    are testable without a JobProcessor (which needs DynamoDB)."""

    @pytest.fixture()
    def poller(self, monkeypatch):
        poller = importlib.import_module("scripts.job_poller")
        store = MemoryDelphiStore()
        monkeypatch.setattr(poller, "_get_v2_store", lambda: store)
        return poller, store

    def _job(self, **kw):
        job = {"job_id": "q-1", "job_type": "FULL_PIPELINE", "conversation_id": "42"}
        job.update(kw)
        return job

    def test_old_mode_is_a_noop(self, poller, monkeypatch):
        module, store = poller
        monkeypatch.setenv("DELPHI_WRITE_MODE", "old")
        module.mirror_job_claimed(self._job())
        assert store.get_run("q-1") is None

    def test_both_mode_mirrors_claim(self, poller, monkeypatch):
        module, store = poller
        monkeypatch.setenv("DELPHI_WRITE_MODE", "both")
        # report ids are ALPHANUMERIC public ids — must be recorded verbatim,
        # never int()-coerced (a coercion failure would kill the mirror)
        module.mirror_job_claimed(self._job(report_id="r4tykwac8thvzv35jrn53"))
        run = store.get_run("q-1")
        assert run is not None
        assert run.status == RunStatus.RUNNING
        assert run.zid == 42 and run.rid is None
        assert run.config_requested["report_id"] == "r4tykwac8thvzv35jrn53"
        assert run.job_type == JobType.FULL_PIPELINE

    def test_finish_mirrors_completion_and_latest(self, poller, monkeypatch):
        module, store = poller
        monkeypatch.setenv("DELPHI_WRITE_MODE", "both")
        module.mirror_job_claimed(self._job())
        module.mirror_job_finished(self._job(), success=True)
        assert store.get_run("q-1").status == RunStatus.COMPLETED
        assert store.get_latest("zid#42#FULL_PIPELINE").job_id == "q-1"

    def test_finish_mirrors_failure(self, poller, monkeypatch):
        module, store = poller
        monkeypatch.setenv("DELPHI_WRITE_MODE", "both")
        module.mirror_job_claimed(self._job())
        module.mirror_job_finished(self._job(), success=False, error="exit 1")
        run = store.get_run("q-1")
        assert run.status == RunStatus.FAILED and run.error == "exit 1"

    def test_narrative_types_not_mirrored_yet(self, poller, monkeypatch):
        module, store = poller
        monkeypatch.setenv("DELPHI_WRITE_MODE", "both")
        module.mirror_job_claimed(self._job(job_type="CREATE_NARRATIVE_BATCH"))
        module.mirror_job_finished(
            self._job(job_type="CREATE_NARRATIVE_BATCH"), success=True
        )
        assert store.get_run("q-1") is None

    def test_mirror_errors_never_raise(self, poller, monkeypatch):
        """M1 policy: the old path keeps serving; a broken v2 store must not
        take the poller down."""
        module, _ = poller
        monkeypatch.setenv("DELPHI_WRITE_MODE", "both")

        def broken():
            raise RuntimeError("store unreachable")

        monkeypatch.setattr(module, "_get_v2_store", broken)
        module.mirror_job_claimed(self._job())  # must not raise
        module.mirror_job_finished(self._job(), success=True)  # must not raise


class TestRunDelphiWriteMode:
    def _run(self, monkeypatch, argv, mode, capture_boom=False):
        run_delphi = importlib.import_module("run_delphi")
        stage_cmds, events = [], []
        monkeypatch.setattr(
            run_delphi.subprocess,
            "run",
            lambda cmd, **kw: stage_cmds.append(list(cmd)) or SimpleNamespace(returncode=0),
        )

        def capture(job_id, zid, rid):
            if capture_boom:
                raise RuntimeError("capture failed")
            events.append(("capture", job_id))

        monkeypatch.setattr(run_delphi, "_capture_run_inputs", capture)
        monkeypatch.setattr(
            run_delphi, "_v2_mark_run_started",
            lambda job_id, zid, rid: events.append(("started", job_id)),
        )
        monkeypatch.setattr(
            run_delphi, "_v2_mark_run_finished",
            lambda job_id, success: events.append(("finished", job_id, success)),
        )
        if mode is None:
            monkeypatch.delenv("DELPHI_WRITE_MODE", raising=False)
        else:
            monkeypatch.setenv("DELPHI_WRITE_MODE", mode)
        monkeypatch.delenv("DELPHI_SNAPSHOT_INPUTS", raising=False)
        monkeypatch.delenv("DELPHI_JOB_ID", raising=False)
        monkeypatch.setenv("OLLAMA_MODEL", "test-model")
        monkeypatch.setenv("DELPHI_APP_PATH", DELPHI_DIR)
        monkeypatch.setitem(sys.modules, "boto3", None)
        monkeypatch.setattr(sys, "argv", ["run_delphi.py"] + argv)
        with pytest.raises(SystemExit) as excinfo:
            run_delphi.main()
        return excinfo.value.code, stage_cmds, events

    def test_old_mode_no_v2_activity(self, monkeypatch):
        code, cmds, events = self._run(monkeypatch, ["--zid=1", "--job-id=j"], "old")
        assert code == 0 and len(cmds) == 6
        assert events == []

    def test_both_mode_captures_and_completes(self, monkeypatch):
        code, cmds, events = self._run(monkeypatch, ["--zid=1", "--job-id=j"], "both")
        assert code == 0 and len(cmds) == 6
        assert ("started", "j") in events
        assert ("capture", "j") in events
        assert ("finished", "j", True) in events
        assert events.index(("capture", "j")) < 3  # before stages ran

    def test_both_mode_capture_failure_continues(self, monkeypatch):
        code, cmds, events = self._run(
            monkeypatch, ["--zid=1", "--job-id=j"], "both", capture_boom=True
        )
        assert code == 0
        assert len(cmds) == 6  # stages still ran — old path keeps serving

    def test_v2_mode_capture_failure_aborts(self, monkeypatch):
        code, cmds, events = self._run(
            monkeypatch, ["--zid=1", "--job-id=j"], "v2", capture_boom=True
        )
        assert code == 1
        assert cmds == []

    def test_explicit_flag_still_aborts_on_failure(self, monkeypatch):
        code, cmds, _ = self._run(
            monkeypatch,
            ["--zid=1", "--job-id=j", "--snapshot-inputs"],
            "both",
            capture_boom=True,
        )
        assert code == 1
        assert cmds == []

    def test_unset_mode_fails_loud(self, monkeypatch):
        code, cmds, _ = self._run(monkeypatch, ["--zid=1", "--job-id=j"], None)
        assert code != 0
        assert cmds == []


class TestPurgeZid:
    def test_purges_all_runs_of_a_conversation(self):
        store = MemoryDelphiStore()
        for i, zid in enumerate([5, 5, 6]):
            job_id = f"p-{i}"
            ensure_run(store, job_id=job_id, job_type=JobType.FULL_PIPELINE, zid=zid)
            store.put(
                "run_inputs",
                StoreItem(pk=job_id, sk="votes", attributes={"enc": "json", "body": {}}),
            )
            store.put(
                "artifacts",
                StoreItem(pk=job_id, sk="math#pca", attributes={"enc": "json", "body": {}}),
            )
        result = purge_zid(store, 5)
        assert result["runs"] == 2 and result["items"] == 4
        assert store.query_prefix("run_inputs", "p-0") == []
        assert store.query_prefix("artifacts", "p-1") == []
        # the other conversation is untouched
        assert store.query_prefix("run_inputs", "p-2") != []
