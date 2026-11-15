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
from typing import Any, Dict, Iterator, List, Optional

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


@contextmanager
def step(name: str, **facts: Any) -> Iterator[Dict[str, Any]]:
    """Time a block and record its peak memory. The yielded dict collects the
    step's facts; it is printed with the line when the block ends."""
    data: Dict[str, Any] = dict(facts)
    if not enabled():
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
        emit(name, status=status, seconds=round(time.monotonic() - start, 3),
             peak_rss_mb=round(peak, 1), peak_scope=scope, **data)


def run_child(name: str, command: List[str], **facts: Any) -> int:
    """Run a child process to completion and return its exit code. With the
    switch on, also print the step line with the child's exact peak (wait4)."""
    if not enabled():
        return subprocess.run(command).returncode
    start = time.monotonic()
    proc = subprocess.Popen(command)
    _, status, usage = os.wait4(proc.pid, 0)
    code = os.waitstatus_to_exitcode(status)
    proc.returncode = code
    raw = usage.ru_maxrss
    peak = raw / (1024.0 * 1024.0) if sys.platform == "darwin" else raw / 1024.0
    emit(name, status="ok" if code == 0 else "failed", seconds=round(time.monotonic() - start, 3),
         peak_rss_mb=round(peak, 1), peak_scope="child", exit_code=code,
         child_cpu_seconds=round(usage.ru_utime + usage.ru_stime, 3), **facts)
    return code
