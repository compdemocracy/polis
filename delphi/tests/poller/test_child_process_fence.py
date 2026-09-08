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


def _jump_the_clock(monkeypatch, seconds=10_000):
    """Send the poller's clock far forward once, without freezing it.

    The job timeout compares ``time.time()`` against the start it took on the
    first call, so a single jump trips it. Pinning the clock to a constant
    instead — which this file used to do — makes the poller's own bounded waits
    (``deadline = time.time() + CHILD_TERMINATE_GRACE_SECONDS``) unable to
    expire, so a group that does not empty spins forever. That was the CI hang.

    The patch replaces the ``time`` module *in the poller's namespace* only;
    setting ``scripts.job_poller.time.time`` would have doctored the clock of
    the whole process, tests and libraries included.
    """
    real_time = time.time
    calls = {'n': 0}

    def jumped():
        calls['n'] += 1
        return real_time() + (0 if calls['n'] == 1 else seconds)

    monkeypatch.setattr(
        "scripts.job_poller.time", SimpleNamespace(time=jumped, sleep=time.sleep)
    )


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
        _jump_the_clock(monkeypatch)

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
        _jump_the_clock(monkeypatch)
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
    """Running — not merely still present in the process table.

    A killed process stays a zombie until its parent reaps it, and a grandchild
    orphaned by the job's parent is re-parented to PID 1, which in a container
    is the image's command (the CI compose file runs `tail -f /dev/null`), not
    a reaping init. `os.kill(pid, 0)` keeps succeeding for such a zombie, so
    "the tree is gone" has to be asked of the process state, as the poller's
    own `_live_group_members` asks it.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        with open(f"/proc/{pid}/stat", "rb") as stat_file:
            state = stat_file.read().rpartition(b")")[2].split()[0]
    except (OSError, IndexError):
        # No /proc (macOS): the platform's init reaps, so the probe is enough.
        return True
    return state not in (b"Z", b"X", b"x")


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


# --- Round 11: an incomplete or non-snapshot /proc read must not claim exit ---
#
# The round-10 zombie fix reads /proc to tell a live group member from a dead
# entry. Two ways that read can be wrong were reported (Astra review, round 10);
# both must resolve to "still live", never to an authorized exit:
#
#   1. An unreadable or malformed `/proc/<pid>/stat` (a pid vanishing mid-read,
#      a permission error, a short read) was silently skipped, so a single
#      uncounted live member made the group look empty.
#   2. Enumeration is not a snapshot: the last live member can fork a successor
#      and exit between listing `/proc` and reading the stats, so one pass
#      reports empty while a live successor remains in the same group.
#
# These use the poller's own group-liveness helpers directly, mocking /proc so
# they exercise the Linux path (and the same defect) on any host; a real-fork
# variant guarded on /proc runs the exact interleaving under Linux CI.


def _fresh_stat(mapping):
    """An `open` replacement that yields a fresh reader per call.

    `/proc/<pid>/stat` is read once per open; a single shared buffer would be
    exhausted on a second pass, so each call gets its own BytesIO.
    """

    def _open(path, *args, **kwargs):
        pid = path.split("/")[2]
        return io.BytesIO(mapping[pid])

    return _open


def _stat_line(pid, state, pgid):
    # comm deliberately contains spaces and a ')' to exercise the rpartition.
    return f"{pid} (job proc) ) {state} 1 {pgid} 0".encode()


def test_unreadable_member_does_not_authorize_exit(monkeypatch):
    """Defect 1a: a member whose stat cannot be read is uncertainty, not absence.

    A single live member the poller cannot read (permission error) must not let
    `confirm_process_tree_gone` claim the tree is gone. On 955cca0a1 the read
    error was skipped, the group looked empty and the exit was authorized.
    """
    monkeypatch.setattr("scripts.job_poller.CHILD_TERMINATE_GRACE_SECONDS", 0)
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: ["101"])
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)

    def _raise(path, *args, **kwargs):
        raise PermissionError("synthetic unreadable member")

    monkeypatch.setattr("builtins.open", _raise)

    assert JobProcessor._live_group_members(77) is None
    assert JobProcessor._process_group_alive(77) is True

    worker = JobProcessor.__new__(JobProcessor)
    assert worker.confirm_process_tree_gone(77, "synthetic") is False


def test_malformed_stat_does_not_authorize_exit(monkeypatch):
    """Defect 1b: a short/malformed stat read is uncertainty, not absence."""
    monkeypatch.setattr("scripts.job_poller.CHILD_TERMINATE_GRACE_SECONDS", 0)
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: ["101"])
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)
    monkeypatch.setattr("builtins.open", _fresh_stat({"101": b"incomplete"}))

    assert JobProcessor._live_group_members(77) is None
    assert JobProcessor._process_group_alive(77) is True

    worker = JobProcessor.__new__(JobProcessor)
    assert worker.confirm_process_tree_gone(77, "synthetic") is False


def test_vanished_member_is_confirmed_gone(monkeypatch):
    """A pid that truly exited mid-scan is dropped — the fix stays conservative
    only about genuine uncertainty, not about a confirmed disappearance."""
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: ["101"])
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)

    def _gone(path, *args, **kwargs):
        raise FileNotFoundError("pid exited between listdir and open")

    monkeypatch.setattr("builtins.open", _gone)
    # os.kill(pid, 0) raising ProcessLookupError confirms it is really gone.
    monkeypatch.setattr(
        os, "kill", lambda pid, sig: (_ for _ in ()).throw(ProcessLookupError())
    )

    assert JobProcessor._live_group_members(77) == []
    assert JobProcessor._process_group_alive(77) is False


def test_successor_forked_between_scans_is_not_reported_empty(monkeypatch):
    """Defect 2: enumeration is not a snapshot.

    Pass one lists only the parent (already a zombie after forking) and misses
    the live successor; pass two sees the successor. Two stable passes with a
    killpg re-check between them keep the group alive. On 955cca0a1 the single
    pass reported the group empty.
    """
    listings = iter([["201"], ["202"]])  # pass 1 misses 202; pass 2 sees it
    stats = {
        "201": _stat_line(201, "Z", 77),  # parent forked, then exited -> zombie
        "202": _stat_line(202, "S", 77),  # forked successor, still running
    }
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: next(listings))
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)  # group still alive
    monkeypatch.setattr("builtins.open", _fresh_stat(stats))

    assert JobProcessor._process_group_alive(77) is True


def test_zombie_only_group_is_still_reported_empty(monkeypatch):
    """Round-10 behaviour preserved: a group holding only a zombie is empty.

    Both stable passes see only the dead entry, so the two-pass rule must not
    reintroduce the hang by keeping a reaped-to-PID1 zombie group alive forever.
    """
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: ["101"])
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)
    monkeypatch.setattr("builtins.open", _fresh_stat({"101": _stat_line(101, "Z", 77)}))

    assert JobProcessor._process_group_alive(77) is False


def test_running_member_keeps_the_group_alive(monkeypatch):
    """A single running member is enough to keep the group alive on pass one."""
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: ["101"])
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)
    monkeypatch.setattr("builtins.open", _fresh_stat({"101": _stat_line(101, "R", 77)}))

    assert JobProcessor._live_group_members(77) == [101]
    assert JobProcessor._process_group_alive(77) is True


@pytest.mark.skipif(not os.path.isdir("/proc"), reason="needs Linux /proc")
def test_real_successor_forked_between_scans_is_not_reported_empty(monkeypatch):
    """Astra's exact real-process interleaving, under Linux CI.

    Capture the /proc listing while the parent is alive, let it fork a sleeping
    successor and exit before the stats are read, then inspect that stale list:
    the successor is absent and the parent reads as gone. The next pass, with a
    live killpg re-check, finds the successor in the same group.
    """
    code = (
        "import subprocess,sys;"
        "sys.stdin.readline();"
        "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],"
        "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);"
        "print(p.pid,flush=True)"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", code],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    successor = {"pid": None}
    real_listdir = os.listdir
    calls = {"n": 0}

    def racing_listdir(path):
        if path == "/proc" and calls["n"] == 0:
            calls["n"] += 1
            snapshot = real_listdir(path)  # parent listed and alive
            parent.stdin.write("go\n")
            parent.stdin.flush()
            successor["pid"] = int(parent.stdout.readline())
            parent.wait(timeout=5)  # parent exits -> gone, successor orphaned
            return snapshot  # stale: missing the just-forked successor
        return real_listdir(path)  # later passes see the successor

    try:
        monkeypatch.setattr(os, "listdir", racing_listdir)
        assert JobProcessor._process_group_alive(parent.pid) is True
        monkeypatch.undo()
        assert os.getpgid(successor["pid"]) == parent.pid
    finally:
        try:
            os.killpg(parent.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        parent.wait(timeout=5)
        parent.stdin.close()
        parent.stdout.close()
