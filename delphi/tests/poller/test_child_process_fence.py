"""The poller must stop a job's child process before it marks the job failed.

Marking a root FAILED while its subprocess is still alive leaves an orphan that
can still submit provider work and can still create a checker row *after* the
server has concluded the job finished. The server's submission guard uses a
root's terminal transition as evidence that no more work will appear under it,
so this is the writer half of that fence (P-003 S3, round-3 review R1).
"""

import io
import subprocess
from types import SimpleNamespace

import pytest

from scripts.job_poller import JobProcessor


class FakeProcess:
    """A child that does not die unless someone actually stops it."""

    def __init__(self, *, read_error=False, exit_code=0, ignore_terminate=False):
        self.calls = []
        self.alive = True
        self.returncode = None
        self._exit_code = exit_code
        self._ignore_terminate = ignore_terminate
        if read_error:
            self.stdout = SimpleNamespace(
                readline=self._raise_read_error, close=lambda: None
            )
        else:
            self.stdout = io.StringIO("still running\n")

    def _raise_read_error(self):
        raise OSError("synthetic pipe failure")

    def poll(self):
        return None if self.alive else self.returncode

    def terminate(self):
        self.calls.append("terminate")
        if not self._ignore_terminate:
            self.alive = False
            self.returncode = -15

    def kill(self):
        self.calls.append("kill")
        self.alive = False
        self.returncode = -9

    def wait(self, timeout=None):
        self.calls.append("wait")
        if self.alive:
            if self._ignore_terminate and "kill" not in self.calls:
                raise subprocess.TimeoutExpired("synthetic", timeout or 0)
            self.alive = False
            self.returncode = self._exit_code
        return self.returncode


def run_process_job(monkeypatch, child, *, timed_out=False):
    """Drive the real process_job against an inert child and store."""
    completions = []
    worker = JobProcessor.__new__(JobProcessor)
    worker.worker_id = "synthetic-worker"
    worker.update_job_logs = lambda *args, **kwargs: None
    worker.complete_job = lambda job, success, **kwargs: completions.append(
        (success, kwargs.get("process_exited"))
    )
    worker.release_lock = lambda *args, **kwargs: None

    monkeypatch.setattr(
        "scripts.job_poller.subprocess.Popen", lambda *a, **kw: child
    )
    monkeypatch.setenv("ANTHROPIC_MODEL", "synthetic-model")
    if timed_out:
        clock = iter([0, 10_000])
        monkeypatch.setattr(
            "scripts.job_poller.time.time", lambda: next(clock, 10_000)
        )

    worker.process_job(
        {
            "job_id": "synthetic-root",
            "job_type": "CREATE_NARRATIVE_BATCH",
            "conversation_id": "1",
            "timeout_seconds": 1,
        }
    )
    return completions


def test_timeout_stops_the_child_before_failing_the_job(monkeypatch):
    child = FakeProcess()
    completions = run_process_job(monkeypatch, child, timed_out=True)

    assert completions == [(False, True)]
    assert not child.alive
    assert "terminate" in child.calls
    assert "wait" in child.calls


def test_pipe_error_stops_the_child_before_failing_the_job(monkeypatch):
    child = FakeProcess(read_error=True)
    completions = run_process_job(monkeypatch, child)

    assert completions == [(False, True)]
    assert not child.alive
    assert "terminate" in child.calls


def test_child_that_ignores_terminate_is_killed(monkeypatch):
    child = FakeProcess(read_error=True, ignore_terminate=True)
    completions = run_process_job(monkeypatch, child)

    assert completions == [(False, True)]
    assert not child.alive
    assert child.calls.count("terminate") == 1
    assert "kill" in child.calls


def test_ordinary_completion_still_waits_and_claims_exit(monkeypatch):
    child = FakeProcess()
    completions = run_process_job(monkeypatch, child)

    # No terminate needed: the normal path already joins the child.
    assert completions == [(True, True)]
    assert child.calls == ["wait"]


def test_unconfirmed_exit_is_not_claimed(monkeypatch):
    """If the child cannot be stopped, the failure must not claim it exited."""

    class Unstoppable(FakeProcess):
        def terminate(self):
            self.calls.append("terminate")
            raise OSError("synthetic terminate failure")

        def kill(self):
            self.calls.append("kill")
            raise OSError("synthetic kill failure")

    child = Unstoppable(read_error=True)
    completions = run_process_job(monkeypatch, child)

    assert completions == [(False, False)]
    assert child.alive


@pytest.mark.parametrize("success", [True, False])
def test_complete_job_records_the_exit_claim(success):
    """complete_job writes process_exit_confirmed for the guard to read."""
    captured = {}

    worker = JobProcessor.__new__(JobProcessor)
    worker.table = SimpleNamespace(
        update_item=lambda **kwargs: captured.update(kwargs)
    )
    worker.update_job_logs = lambda *args, **kwargs: None

    worker.complete_job(
        {"job_id": "synthetic-root", "version": 1}, success, process_exited=True
    )

    assert "process_exit_confirmed" in captured["UpdateExpression"]
    assert captured["ExpressionAttributeValues"][":process_exited"] is True

    captured.clear()
    worker.complete_job({"job_id": "synthetic-root", "version": 1}, success)
    assert captured["ExpressionAttributeValues"][":process_exited"] is False
