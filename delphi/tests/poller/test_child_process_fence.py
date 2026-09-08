"""The poller must stop a job's child process before it marks the job failed.

Marking a root FAILED while its subprocess is still alive leaves an orphan that
can still submit provider work and can still create a checker row *after* the
server has concluded the job finished. The server's submission guard uses a
root's terminal transition as evidence that no more work will appear under it,
so this is the writer half of that fence (P-003 S3, round-3 review R1).
"""

import io
import json
import subprocess
from types import SimpleNamespace

import pytest

from scripts.job_poller import JobProcessor


def _is_confirmed(result):
    """True if a confirmation result authorizes releasing the guard.

    Round 13 makes `confirm_process_tree_gone`/`stop_child_process` return an
    `ExitConfirmation` enum (read via `.confirmed`); earlier commits returned a
    plain bool. Reading it this way lets the same assertion run against the
    pre-fix code, where it observes the unsafe `True`.
    """
    return bool(getattr(result, "confirmed", result))


@pytest.fixture
def kernel_fence():
    """Establish the real kernel exit fence, or skip where it is unavailable.

    A CONFIRMED exit requires the child-subreaper (Linux); without it the poller
    fails closed by design, so tests that assert a confirmed exit run only where
    the fence can actually be established. The module flag is restored by the
    autouse fixture in the round-12 section.
    """
    import scripts.job_poller as jp

    if not jp.mark_child_subreaper():
        pytest.skip("kernel process-exit fence unavailable on this platform")
    yield


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


def test_timeout_stops_the_whole_job_tree(monkeypatch, kernel_fence):
    child = NestedRealProcess(hang=True)
    try:
        completions = run_process_job_with(monkeypatch, child, timed_out=True)
        assert completions == [(False, True)]
        assert child.poll() is not None
        assert not _alive(child.grandchild_pid)
    finally:
        child.cleanup()


def test_pipe_error_stops_the_whole_job_tree(monkeypatch, kernel_fence):
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


def test_stopping_a_job_kills_its_grandchildren(kernel_fence):
    worker = JobProcessor.__new__(JobProcessor)
    parent, grandchild_pid = _spawn_nested(new_session=True)
    try:
        assert _is_confirmed(worker.stop_child_process(parent, "synthetic-root")) is True
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
        assert _is_confirmed(worker.stop_child_process(parent, "synthetic-root")) is False
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
def test_normal_parent_exit_still_fences_the_tree(monkeypatch, exit_code, kernel_fence):
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
    assert _is_confirmed(worker.confirm_process_tree_gone(77, "synthetic")) is False


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
    assert _is_confirmed(worker.confirm_process_tree_gone(77, "synthetic")) is False


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


# --- Round 12: the kernel, not a /proc scan, is the emptiness authority -------
#
# Astra (round 11) showed that adding scan passes cannot win: N generations each
# forking and exiting after their own enumeration make N passes all come back
# empty while a live successor remains in the group. Enumeration is not a
# snapshot and never will be. The fix stops scanning for the exit authority: the
# poller marks itself a child-subreaper (PR_SET_CHILD_SUBREAPER) so orphaned
# grandchildren re-parent to it instead of the container's non-reaping PID 1;
# the confirmation reaps the group's dead members and then trusts that
# `killpg(pgid, 0)` raising ESRCH means the group is truly empty. A zombie can no
# longer linger to fake liveness, and a live successor simply keeps killpg
# succeeding until it too exits and is reaped. The /proc scan survives only as a
# best-effort fallback where the subreaper is unavailable (macOS, prctl failure).


@pytest.fixture(autouse=True)
def _restore_subreaper_flag():
    """Keep the module's subreaper flag from leaking between tests."""
    import scripts.job_poller as jp

    saved = getattr(jp, "_child_subreaper_set", None)
    yield
    if saved is not None:
        jp._child_subreaper_set = saved


def _install_fake_waitid(monkeypatch, fake):
    """Make the kernel reap path callable on any host.

    `os.waitid` and its `P_PGID`/`WEXITED` constants exist on Linux but not on
    macOS; `raising=False` lets these deterministic tests exercise the
    subreaper path (which production only takes on Linux) regardless of host.
    """
    monkeypatch.setattr(os, "P_PGID", getattr(os, "P_PGID", 2), raising=False)
    monkeypatch.setattr(os, "WEXITED", getattr(os, "WEXITED", 4), raising=False)
    monkeypatch.setattr(os, "WNOHANG", getattr(os, "WNOHANG", 1), raising=False)
    monkeypatch.setattr(os, "waitid", fake, raising=False)


def test_two_generation_fork_race_does_not_authorize_exit(monkeypatch):
    """Astra's round-11 defect: two (or more) generations defeat the scan.

    With the subreaper active the kernel is the authority: a live successor
    keeps `killpg(pgid, 0)` succeeding even for the exact /proc schedule that
    would come back empty. On 5f82a1047 there is no kernel path, so
    `_process_group_alive` runs the scan, sees the empty passes and wrongly
    reports the group empty — this assertion fails there.
    """
    monkeypatch.setattr("scripts.job_poller._child_subreaper_set", True, raising=False)
    # A live member remains, so there is nothing to reap and the group still
    # answers killpg.
    _install_fake_waitid(monkeypatch, lambda idtype, gid, options: None)
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)
    # The scan the pre-fix code would run reports empty for this schedule.
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: ["101"])
    monkeypatch.setattr("builtins.open", _fresh_stat({"101": _stat_line(101, "Z", 77)}))

    assert JobProcessor._process_group_alive(77) is True


def test_kernel_path_reaps_zombies_then_reports_empty(monkeypatch):
    """The round-10 hang cannot return: reaped zombies leave killpg with ESRCH.

    A group holding only dead members is reaped through `waitid(P_PGID)`, after
    which `killpg` raises ESRCH and the group is proven empty — no accumulating
    zombie keeps it alive forever.
    """
    monkeypatch.setattr("scripts.job_poller._child_subreaper_set", True, raising=False)
    reaped = []
    calls = {"n": 0}

    def fake_waitid(idtype, gid, options):
        calls["n"] += 1
        if calls["n"] == 1:
            reaped.append(gid)
            return SimpleNamespace(si_pid=999)  # collected one zombie
        raise ChildProcessError()  # nothing of ours left in the group

    _install_fake_waitid(monkeypatch, fake_waitid)

    def esrch(pgid, sig):
        raise ProcessLookupError()

    monkeypatch.setattr(os, "killpg", esrch)

    assert JobProcessor._process_group_alive(77) is False
    assert reaped == [77]


def test_kernel_path_live_member_keeps_group_alive(monkeypatch):
    """A group still holding a live member is not empty."""
    monkeypatch.setattr("scripts.job_poller._child_subreaper_set", True, raising=False)
    _install_fake_waitid(monkeypatch, lambda idtype, gid, options: None)
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)  # group answers

    assert JobProcessor._process_group_alive(77) is True


def test_subreaper_unavailable_uses_scan_fallback(monkeypatch):
    """Without a subreaper the decision delegates to the best-effort scan and
    never reaps (there is nothing re-parented here to reap)."""
    monkeypatch.setattr("scripts.job_poller._child_subreaper_set", False, raising=False)

    def no_reap(*args, **kwargs):
        raise AssertionError("waitid must not run without a subreaper")

    _install_fake_waitid(monkeypatch, no_reap)
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: ["101"])

    # A running member -> the scan reports the group alive.
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)
    monkeypatch.setattr("builtins.open", _fresh_stat({"101": _stat_line(101, "R", 77)}))
    assert JobProcessor._process_group_alive(77) is True

    # ESRCH -> the scan reports the group empty.
    def esrch(pgid, sig):
        raise ProcessLookupError()

    monkeypatch.setattr(os, "killpg", esrch)
    assert JobProcessor._process_group_alive(77) is False


def test_mark_child_subreaper_is_linux_only(monkeypatch):
    """On a non-Linux platform the subreaper is declined and the flag stays off,
    so the confirmation falls back to the scan."""
    import scripts.job_poller as jp

    monkeypatch.setattr(jp.sys, "platform", "darwin")
    monkeypatch.setattr(jp, "_child_subreaper_set", False, raising=False)
    assert jp.mark_child_subreaper() is False
    assert jp._child_subreaper_set is False


@pytest.mark.skipif(
    not sys.platform.startswith("linux"), reason="child-subreaper is Linux-only"
)
def test_real_two_generation_group_is_reaped_to_empty(monkeypatch):
    """Astra's real interleaving, but decided by the kernel.

    A session-leader forks a child that forks a grandchild; the two ancestors
    exit, orphaning the live grandchild into the poller's (subreaper) care in the
    same process group. While it lives the group is alive; once the group is
    killed the grandchild is reaped here (not left a zombie under PID 1) and
    killpg raises ESRCH, so the group is proven empty without any /proc scan.
    """
    import scripts.job_poller as jp

    assert jp.mark_child_subreaper() is True
    code = (
        "import os,sys,time\n"
        "for _ in range(2):\n"
        "    pid = os.fork()\n"
        "    if pid:\n"
        "        print(pid, flush=True)\n"
        "        os._exit(0)\n"
        "time.sleep(60)\n"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        # Drain both intermediate pids; the process still printing is the live
        # grandchild that will be orphaned into our care.
        parent.stdout.readline()
        deadline = time.time() + 5
        while parent.poll() is None and time.time() < deadline:
            time.sleep(0.02)
        assert JobProcessor._process_group_alive(parent.pid) is True

        os.killpg(parent.pid, signal.SIGKILL)
        deadline = time.time() + 5
        while JobProcessor._process_group_alive(parent.pid) and time.time() < deadline:
            time.sleep(0.02)
        assert JobProcessor._process_group_alive(parent.pid) is False
    finally:
        try:
            os.killpg(parent.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            parent.wait(timeout=5)
        except Exception:
            pass
        if parent.stdout:
            parent.stdout.close()


# --- Round 13: without the kernel fence, exit confirmation fails CLOSED --------
#
# Astra (round 12) accepted the kernel path but showed that when subreaper setup
# FAILS the code fell back to the known-racy /proc scan and STILL claimed
# process_exit_confirmed=True with a live successor in the group. "Logging
# best-effort" does not protect the guard release. The fix: `confirm_process_tree_gone`
# and `stop_child_process` return a typed ExitConfirmation; without the kernel
# fence they never return CONFIRMED, only UNCONFIRMED (treated like a timeout:
# the guard is not released, the job records the reason). The /proc scan survives
# only as diagnostics. On Linux the poller refuses to start if the fence cannot
# be established; non-Linux keeps the fail-closed path.


def test_fallback_with_live_successor_is_not_confirmed(monkeypatch):
    """The round-12 defect: no fence + a live successor must NOT confirm exit.

    killpg succeeds (a live member remains) while the /proc scan comes back empty
    — the exact schedule that fooled the scan. Without the subreaper the result
    must be a refusal, not a confirmation. On 028a90c3a `confirm_process_tree_gone`
    returns the plain bool True here, so this assertion fails there.
    """
    monkeypatch.setattr("scripts.job_poller._child_subreaper_set", False, raising=False)
    monkeypatch.setattr("scripts.job_poller.CHILD_TERMINATE_GRACE_SECONDS", 0)
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: ["101"])
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)  # group still answers
    monkeypatch.setattr("builtins.open", _fresh_stat({"101": _stat_line(101, "Z", 77)}))

    worker = JobProcessor.__new__(JobProcessor)
    assert _is_confirmed(worker.confirm_process_tree_gone(77, "synthetic")) is False


def test_fallback_empty_group_is_still_not_confirmed(monkeypatch):
    """Fail closed is the point: even a genuinely empty group is not confirmed
    from the scan alone without the kernel fence."""
    import scripts.job_poller as jp

    monkeypatch.setattr("scripts.job_poller._child_subreaper_set", False, raising=False)

    def esrch(pgid, sig):
        raise ProcessLookupError()

    monkeypatch.setattr(os, "killpg", esrch)  # group is genuinely gone
    monkeypatch.setattr(os.path, "isdir", lambda path: True)
    monkeypatch.setattr(os, "listdir", lambda path: [])

    worker = JobProcessor.__new__(JobProcessor)
    result = worker.confirm_process_tree_gone(77, "synthetic")
    assert _is_confirmed(result) is False
    assert result is jp.ExitConfirmation.UNCONFIRMED


def test_kernel_path_still_confirms_empty_group(monkeypatch):
    """The accepted kernel path is unchanged: a proven-empty group confirms."""
    import scripts.job_poller as jp

    monkeypatch.setattr("scripts.job_poller._child_subreaper_set", True, raising=False)
    _install_fake_waitid(monkeypatch, lambda idtype, gid, options: (_ for _ in ()).throw(ChildProcessError()))

    def esrch(pgid, sig):
        raise ProcessLookupError()

    monkeypatch.setattr(os, "killpg", esrch)

    worker = JobProcessor.__new__(JobProcessor)
    result = worker.confirm_process_tree_gone(77, "synthetic")
    assert result is jp.ExitConfirmation.CONFIRMED
    assert _is_confirmed(result) is True


def test_unconfirmed_completion_records_note_and_withholds_release():
    """An UNCONFIRMED confirmation completes the job with the guard withheld
    (process_exit_confirmed=False) and a recorded reason."""
    from scripts.job_poller import ExitConfirmation

    captured = {}
    worker = JobProcessor.__new__(JobProcessor)
    worker.table = SimpleNamespace(update_item=lambda **kwargs: captured.update(kwargs))
    worker.update_job_logs = lambda *args, **kwargs: None

    worker._complete_with_confirmation(
        {"job_id": "synthetic-root", "version": 1}, True, ExitConfirmation.UNCONFIRMED
    )

    values = captured["ExpressionAttributeValues"]
    assert values[":process_exited"] is False
    results = json.loads(values[":job_results"])
    assert "child-subreaper" in results["process_exit_note"]


def test_confirmed_completion_releases_the_guard():
    """A CONFIRMED confirmation sets process_exit_confirmed=True and no note."""
    from scripts.job_poller import ExitConfirmation

    captured = {}
    worker = JobProcessor.__new__(JobProcessor)
    worker.table = SimpleNamespace(update_item=lambda **kwargs: captured.update(kwargs))
    worker.update_job_logs = lambda *args, **kwargs: None

    worker._complete_with_confirmation(
        {"job_id": "synthetic-root", "version": 1}, True, ExitConfirmation.CONFIRMED
    )

    values = captured["ExpressionAttributeValues"]
    assert values[":process_exited"] is True
    results = json.loads(values[":job_results"])
    assert "process_exit_note" not in results


def test_startup_refuses_on_linux_without_fence(monkeypatch):
    """On Linux the poller refuses to start if the kernel fence cannot be set
    (it needs no capability, so failure means a broken environment)."""
    import scripts.job_poller as jp

    monkeypatch.setattr(jp, "mark_child_subreaper", lambda: False)
    monkeypatch.setattr(jp.sys, "platform", "linux")
    with pytest.raises(SystemExit):
        jp.ensure_process_exit_fence()


def test_startup_tolerates_non_linux_without_fence(monkeypatch):
    """On non-Linux the poller continues (fail-closed confirmation), no exit."""
    import scripts.job_poller as jp

    monkeypatch.setattr(jp, "mark_child_subreaper", lambda: False)
    monkeypatch.setattr(jp.sys, "platform", "darwin")
    jp.ensure_process_exit_fence()  # must not raise


@pytest.mark.skipif(
    not sys.platform.startswith("linux"), reason="needs Linux /proc + fork"
)
def test_real_two_generation_without_fence_is_unconfirmed(monkeypatch):
    """Astra's r12 defect case as a control: a failed/absent subreaper setup with
    a real two-generation live successor must return UNCONFIRMED, never confirm.
    """
    import scripts.job_poller as jp

    monkeypatch.setattr(jp, "_child_subreaper_set", False, raising=False)
    code = (
        "import os,sys,time\n"
        "for _ in range(2):\n"
        "    pid = os.fork()\n"
        "    if pid:\n"
        "        print(pid, flush=True)\n"
        "        os._exit(0)\n"
        "time.sleep(60)\n"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    worker = JobProcessor.__new__(JobProcessor)
    try:
        parent.stdout.readline()
        deadline = time.time() + 5
        while parent.poll() is None and time.time() < deadline:
            time.sleep(0.02)
        result = worker.confirm_process_tree_gone(parent.pid, "synthetic")
        assert result is jp.ExitConfirmation.UNCONFIRMED
        assert _is_confirmed(result) is False
    finally:
        try:
            os.killpg(parent.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        # Reap anything left; without a real subreaper an orphan may need it.
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                if not JobProcessor._live_group_members(parent.pid):
                    break
            except Exception:
                break
            time.sleep(0.02)
        try:
            parent.wait(timeout=5)
        except Exception:
            pass
        if parent.stdout:
            parent.stdout.close()
