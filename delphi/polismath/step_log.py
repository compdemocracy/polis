"""One structured line per step of a Delphi run: what the step cost.

Switched on by ``DELPHI_STEP_LOG=1`` (exactly "1"); otherwise every function
here does nothing and prints nothing, and a run's output is what it was.

Each line is written to standard output and flushed::

    delphi_step/1 {"attempt_id": ..., "job_id": ..., "peak_rss_mb": 812.4, ...}

Under the job daemon a child's standard output is stored as the attempt's log
lines (polis_queue_logs, stream stdout, keyed by the attempt id the run record
names) and reaches the container's log stream, so every run reports, beside
its run record, what each step took. The JSON carries counts, seconds,
megabytes and closed labels only: never a comment, a conversation id, a
participant or any text.

Fields of every line: ``step`` (a closed name), ``status`` (``ok`` or
``failed``), ``seconds`` (wall clock, monotonic), ``peak_rss_mb`` (the
highest resident memory seen during the step), ``peak_scope`` (how that peak
was measured: ``sampled``, a background sample of this process's resident set
every ``DELPHI_STEP_SAMPLE_MS`` milliseconds, default 20, so a spike shorter
than that can be missed; ``child``, the exact peak of a child process from
wait4; ``process``, the process's peak so far, when nothing finer is
available), ``process_peak_rss_mb`` (this process's peak resident set so
far, exact), ``job_id`` and ``attempt_id`` (from the daemon's environment,
null outside it), and the step's own facts (``n_comments``, ``layers``,
``clusters``, ``numba_threading_layer`` ...).
"""

from __future__ import annotations

import json
import os
import resource
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Optional, Sequence

SWITCH = "DELPHI_STEP_LOG"
PREFIX = "delphi_step/1"


def enabled() -> bool:
    return os.environ.get(SWITCH, "").strip() == "1"


def _rss_mb() -> Optional[float]:
    """This process's resident set now, in MiB (Linux /proc), else None."""
    try:
        with open("/proc/self/status", "rb") as f:
            for line in f:
                if line.startswith(b"VmRSS:"):
                    return int(line.split()[1]) / 1024.0
    except OSError:
        return None
    return None


def _maxrss_mb(who: int = resource.RUSAGE_SELF) -> float:
    raw = resource.getrusage(who).ru_maxrss
    # Linux reports KiB, macOS bytes.
    return raw / (1024.0 * 1024.0) if sys.platform == "darwin" else raw / 1024.0


def emit(step: str, **fields: Any) -> None:
    """Print one line, if the switch is on."""
    if not enabled():
        return
    line = {
        "step": step,
        "job_id": os.environ.get("DELPHI_JOB_ID") or None,
        "attempt_id": os.environ.get("DELPHI_ATTEMPT_ID") or None,
        "process_peak_rss_mb": round(_maxrss_mb(), 1),
    }
    line.update(fields)
    print(f"{PREFIX} {json.dumps(line, sort_keys=True, separators=(',', ':'), default=str)}", flush=True)


class _Sampler:
    """The highest resident set seen while running, sampled in a daemon thread."""

    def __init__(self, interval_s: float) -> None:
        self.interval_s = interval_s
        self.peak = _rss_mb()
        self._stop = threading.Event()
        self._thread = None
        if self.peak is not None:
            self._thread = threading.Thread(target=self._run, daemon=True, name="delphi-step-rss")
            self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self.interval_s):
            self._note()

    def _note(self) -> None:
        now = _rss_mb()
        if now is not None and (self.peak is None or now > self.peak):
            self.peak = now

    def stop(self) -> Optional[float]:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        self._note()
        return self.peak


def _interval_s() -> float:
    try:
        return max(1, int(os.environ.get("DELPHI_STEP_SAMPLE_MS", "20"))) / 1000.0
    except ValueError:
        return 0.02


# The run's own record of its steps, kept in memory only while a caller has
# asked for it (record()): the topic map step stores it with the run's map.
# None, nothing is kept and every function here is what it was.
_record: Optional[List[Dict[str, Any]]] = None


def record() -> None:
    """Start keeping, in memory, one entry per step that ends and per note."""
    global _record
    _record = []


def recording() -> bool:
    return _record is not None


def recorded() -> List[Dict[str, Any]]:
    """The entries kept since record(), as plain JSON values."""
    return json.loads(json.dumps(_record or [], default=str))


def note(name: str, **facts: Any) -> None:
    """Keep a fact about how a step ran (an algorithm's parameters), only while
    recording. Prints nothing."""
    if _record is not None:
        _record.append(dict(facts, note=name))


@contextmanager
def _recorded_step(name: str, data: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    start = time.monotonic()
    status = "ok"
    try:
        yield data
    except SystemExit as e:
        if e.code not in (0, None):
            status = "failed"
        raise
    except BaseException:
        status = "failed"
        raise
    finally:
        if _record is not None:
            _record.append(dict(data, step=name, status=status, seconds=round(time.monotonic() - start, 3)))


@contextmanager
def step(name: str, **facts: Any) -> Iterator[Dict[str, Any]]:
    """Time a block and record its peak memory. The yielded dict collects the
    step's facts; it is printed with the line when the block ends."""
    data: Dict[str, Any] = dict(facts)
    if not enabled():
        if _record is None:
            yield data
            return
        with _recorded_step(name, data):
            yield data
        return
    sampler = _Sampler(_interval_s())
    start = time.monotonic()
    status = "ok"
    try:
        yield data
    except SystemExit as e:
        # sys.exit(0) inside a step is how a stage script finishes; any other
        # code is a failure.
        if e.code not in (0, None):
            status = "failed"
            data["exit_code"] = e.code if isinstance(e.code, int) else 1
        raise
    except BaseException:
        status = "failed"
        raise
    finally:
        peak = sampler.stop()
        scope = "sampled"
        if peak is None:
            peak, scope = _maxrss_mb(), "process"
        seconds = round(time.monotonic() - start, 3)
        emit(name, status=status, seconds=seconds,
             peak_rss_mb=round(peak, 1), peak_scope=scope, **data)
        if _record is not None:
            _record.append(dict(data, step=name, status=status, seconds=seconds))


# How long an interrupted run waits for its child to stop on SIGTERM.
STOP_SECONDS = 30.0


def _stop(proc: "subprocess.Popen") -> None:
    try:
        proc.terminate()
        proc.wait(timeout=STOP_SECONDS)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def run_child(name: str, command: List[str], pass_fds: Sequence[int] = (), **facts: Any) -> int:
    """Run a child process to completion and return its exit code. With the
    switch on, also print the step line with the child's exact peak (wait4).
    ``pass_fds``: descriptors the child keeps (a naming run's record pipe);
    without them the child is started exactly as before. With them, a child
    whose wait is interrupted (this process's SIGTERM) is stopped and reaped
    before the interruption goes on: SIGTERM, then SIGKILL after
    ``STOP_SECONDS``."""
    extra = {"pass_fds": tuple(pass_fds)} if pass_fds else {}
    if not pass_fds and not enabled():
        return subprocess.run(command).returncode
    start = time.monotonic()
    proc = subprocess.Popen(command, **extra)
    try:
        _, status, usage = os.wait4(proc.pid, 0)
    except BaseException:
        if pass_fds:
            _stop(proc)
        raise
    code = os.waitstatus_to_exitcode(status)
    proc.returncode = code
    if not enabled():
        return code
    raw = usage.ru_maxrss
    peak = raw / (1024.0 * 1024.0) if sys.platform == "darwin" else raw / 1024.0
    emit(name, status="ok" if code == 0 else "failed", seconds=round(time.monotonic() - start, 3),
         peak_rss_mb=round(peak, 1), peak_scope="child", exit_code=code,
         child_cpu_seconds=round(usage.ru_utime + usage.ru_stime, 3), **facts)
    return code
