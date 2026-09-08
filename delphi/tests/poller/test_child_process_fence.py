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


class NestedRealProcess:
    """A real parent+grandchild pair, wrapped so process_job can drive it.

    Delegates everything to an actual Popen so the process-group fence is
    exercised for real; only stdout is faked, to inject a pipe failure.
    """

    def __init__(self, read_error=False, hang=False):
        code = (
            "import subprocess,sys,time;"
            "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']);"
            "print(p.pid,flush=True);"
            "p.wait()"
        )
        self._proc = subprocess.Popen(
            [sys.executable, "-c", code],
            stdout=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        self.grandchild_pid = int(self._proc.stdout.readline())
        if read_error:
            self.stdout = SimpleNamespace(
                readline=self._raise_read_error, close=lambda: None
            )
        elif hang:
            # Never yields a line, so the timeout check is what ends the loop.
            self.stdout = SimpleNamespace(
                readline=lambda: " ", close=lambda: None
            )
        else:
            self.stdout = self._proc.stdout

    def _raise_read_error(self):
        raise OSError("synthetic pipe failure")

    @property
    def pid(self):
        return self._proc.pid

    def poll(self):
        return self._proc.poll()

    def wait(self, timeout=None):
        return self._proc.wait(timeout=timeout)

    def kill(self):
        self._proc.kill()

    def cleanup(self):
        _reap(self._proc, self.grandchild_pid)


def run_process_job_with(monkeypatch, child, *, timed_out=False):
    completions = []
    worker = JobProcessor.__new__(JobProcessor)
    worker.worker_id = "synthetic-worker"
    worker.update_job_logs = lambda *args, **kwargs: None
    worker.complete_job = lambda job, success, **kwargs: completions.append(
        (success, kwargs.get("process_exited"))
    )
    worker.release_lock = lambda *args, **kwargs: None
    monkeypatch.setattr("scripts.job_poller.subprocess.Popen", lambda *a, **kw: child)
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


def test_timeout_stops_the_whole_job_tree(monkeypatch):
    child = NestedRealProcess(hang=True)
    try:
        completions = run_process_job_with(monkeypatch, child, timed_out=True)
        assert completions == [(False, True)]
        assert child.poll() is not None
        assert not _alive(child.grandchild_pid)
    finally:
        child.cleanup()


def test_pipe_error_stops_the_whole_job_tree(monkeypatch):
    child = NestedRealProcess(read_error=True)
    try:
        completions = run_process_job_with(monkeypatch, child)
        assert completions == [(False, True)]
        assert child.poll() is not None
        assert not _alive(child.grandchild_pid)
    finally:
        child.cleanup()


def test_ordinary_completion_without_an_owned_group_is_not_claimed(monkeypatch):
    """Joining the parent is not evidence about what the parent left running.

    The server treats this — a successful completion carrying an explicit
    `process_exit_confirmed=False` — as outstanding work, exactly as it treats
    an unconfirmed failure.
    """
    child = FakeProcess()
    completions = run_process_job(monkeypatch, child)

    assert completions == [(True, False)]


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


# --- Real nested processes -------------------------------------------------
#
# The fake Popen above cannot show the failure round 3 missed: a FULL_PIPELINE
# child is run_delphi.py, which launches and waits on its own subprocesses.
# Stopping the direct child leaves those grandchildren running, still able to
# write output and reach a provider. These use actual sleeping processes.

import os
import signal
import sys
import time


def _spawn_nested(new_session):
    """A parent that spawns a grandchild and waits on it, like run_delphi.py."""
    code = (
        "import subprocess,sys,time;"
        "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']);"
        "print(p.pid,flush=True);"
        "p.wait()"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=new_session,
    )
    grandchild_pid = int(parent.stdout.readline())
    return parent, grandchild_pid


def _reap(parent, grandchild_pid):
    for pid in (grandchild_pid,):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if parent.poll() is None:
        parent.kill()
    parent.wait(timeout=5)
    if parent.stdout:
        parent.stdout.close()


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_stopping_a_job_kills_its_grandchildren():
    worker = JobProcessor.__new__(JobProcessor)
    parent, grandchild_pid = _spawn_nested(new_session=True)
    try:
        assert worker.stop_child_process(parent, "synthetic-root") is True
        assert parent.poll() is not None
        # The point of the whole change: the grandchild goes too.
        deadline = time.time() + 5
        while _alive(grandchild_pid) and time.time() < deadline:
            time.sleep(0.05)
        assert not _alive(grandchild_pid)
    finally:
        _reap(parent, grandchild_pid)


def test_a_child_without_its_own_group_is_not_claimed():
    """A process the poller does not own as a group cannot be confirmed.

    It is stopped as best we can, but the exit is not claimed, so the server
    keeps the guard instead of releasing a scope whose descendants may live on.
    """
    worker = JobProcessor.__new__(JobProcessor)
    parent, grandchild_pid = _spawn_nested(new_session=False)
    try:
        assert worker.stop_child_process(parent, "synthetic-root") is False
    finally:
        _reap(parent, grandchild_pid)


def test_process_job_starts_the_child_in_its_own_session(monkeypatch):
    """The group only exists if Popen is asked for it."""
    captured = {}

    class Recorded(FakeProcess):
        pass

    child = Recorded()

    def fake_popen(*args, **kwargs):
        captured.update(kwargs)
        return child

    monkeypatch.setattr("scripts.job_poller.subprocess.Popen", fake_popen)
    monkeypatch.setenv("ANTHROPIC_MODEL", "synthetic-model")

    worker = JobProcessor.__new__(JobProcessor)
    worker.worker_id = "synthetic-worker"
    worker.update_job_logs = lambda *a, **kw: None
    worker.complete_job = lambda *a, **kw: None
    worker.release_lock = lambda *a, **kw: None
    worker.process_job(
        {
            "job_id": "synthetic-root",
            "job_type": "CREATE_NARRATIVE_BATCH",
            "conversation_id": "1",
            "timeout_seconds": 1,
        }
    )

    assert captured.get("start_new_session") is True


def _run_nested_to_completion(monkeypatch, exit_code):
    """A real parent that leaves a grandchild behind and then exits normally."""
    code = (
        "import subprocess,sys;"
        "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],"
        "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);"
        "print(p.pid,flush=True);"
        f"sys.exit({exit_code})"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    grandchild_pid = int(parent.stdout.readline())
    completions = []
    worker = JobProcessor.__new__(JobProcessor)
    worker.worker_id = "synthetic-worker"
    worker.update_job_logs = lambda *a, **kw: None
    worker.complete_job = lambda job, success, **kw: completions.append(
        (success, kw.get("process_exited"))
    )
    worker.release_lock = lambda *a, **kw: None
    monkeypatch.setattr("scripts.job_poller.subprocess.Popen", lambda *a, **kw: parent)
    monkeypatch.setenv("ANTHROPIC_MODEL", "synthetic-model")
    try:
        worker.process_job(
            {
                "job_id": "synthetic-root",
                "job_type": "CREATE_NARRATIVE_BATCH",
                "conversation_id": "1",
                "timeout_seconds": 30,
            }
        )
        return completions, grandchild_pid
    finally:
        _reap(parent, grandchild_pid)


@pytest.mark.parametrize("exit_code", [1, 0])
def test_normal_parent_exit_still_fences_the_tree(monkeypatch, exit_code):
    """An ordinary return is not a tree fence on its own.

    The parent exits by itself — nonzero or zero — while a grandchild it
    started keeps running. Waiting on the parent proves nothing about that
    grandchild, so the completion path has to check the group, stop what is left
    and only then claim the exit.
    """
    completions, grandchild_pid = _run_nested_to_completion(monkeypatch, exit_code)

    assert completions == [(exit_code == 0, True)]
    deadline = time.time() + 5
    while _alive(grandchild_pid) and time.time() < deadline:
        time.sleep(0.05)
    assert not _alive(grandchild_pid)
