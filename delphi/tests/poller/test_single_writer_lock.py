"""Single-writer admission for the math poller CLI (scripts/math_poller.py).

Every Delphi-role host starts the poller, so the entrypoint admits exactly one
process per math_env label with a Postgres session-level advisory lock held on
a dedicated connection. These tests run real entrypoint processes against a
real Postgres (the CI service, else a throwaway postgres:17 on an ephemeral
port; skipped when neither is available). Only ``_build_service`` is replaced,
by a stand-in that prints ADMITTED and idles, so no polis data is touched.
"""

import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import psycopg2
import pytest

from tests.conftest import require_polis_postgres

pytestmark = pytest.mark.integration

DELPHI_ROOT = Path(__file__).resolve().parents[2]
FAST_S = "1"  # retry and liveness intervals for the tests (the accepted minimum)

# Runs the real main() with only the service construction replaced.
RUNNER = """
import threading
from scripts import math_poller

class Stand:
    def __init__(self):
        self._stop = threading.Event()
    def run_forever(self):
        print("ADMITTED", flush=True)
        self._stop.wait()
    def stop(self):
        pass

math_poller._build_service = lambda config: Stand()
raise SystemExit(math_poller.main([]))
"""

KEY_MATCH = (
    "l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 "
    "AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext(%s)::bigint"
)


@pytest.fixture(scope="module")
def pg_url():
    with require_polis_postgres() as url:
        yield url


@pytest.fixture
def admin(pg_url):
    conn = psycopg2.connect(pg_url)
    conn.autocommit = True
    yield conn
    conn.close()


class Poller:
    def __init__(self, pg_url: str, math_env: str):
        env = dict(os.environ)
        env.update(
            DATABASE_URL=pg_url,
            DATABASE_SSL_MODE="disable",
            MATH_ENV=math_env,
            MATH_POLLER_LOCK_RETRY_S=FAST_S,
            MATH_POLLER_LOCK_LIVENESS_S=FAST_S,
            PYTHONUNBUFFERED="1",
            PYTHONPATH=os.pathsep.join(filter(None, [str(DELPHI_ROOT), env.get("PYTHONPATH")])),
        )
        env.pop("MATH_POLLER_ALLOW_SERVED_ENV", None)
        self.proc = subprocess.Popen(
            [sys.executable, "-c", RUNNER],
            cwd=DELPHI_ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.lines = []
        self._q = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for line in self.proc.stdout:
            self._q.put(line.rstrip("\n"))
        self._q.put(None)

    def wait_for(self, needle: str, timeout: float = 20.0, count: int = 1) -> bool:
        deadline = time.monotonic() + timeout
        while sum(needle in line for line in self.lines) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            try:
                line = self._q.get(timeout=remaining)
            except queue.Empty:
                return False
            if line is None:
                self._q.put(None)
                return sum(needle in line for line in self.lines) >= count
            self.lines.append(line)
        return True

    def admitted(self) -> bool:
        return any(line == "ADMITTED" for line in self.lines)

    def kill(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGKILL)
        self.proc.wait(timeout=10)


@pytest.fixture
def pollers(pg_url):
    started = []

    def start(math_env):
        poller = Poller(pg_url, math_env)
        started.append(poller)
        return poller

    yield start
    for poller in started:
        poller.kill()


def _label_with_sign(admin, negative: bool) -> str:
    # The holder lookup decodes the bigint key from pg_locks' two oid halves;
    # exercise both a negative and a positive hashtext.
    with admin.cursor() as cur:
        for _ in range(200):
            label = f"locktest-{uuid.uuid4().hex[:8]}"
            cur.execute("SELECT hashtext(%s)", (f"polis-math-python:{label}",))
            if (cur.fetchone()[0] < 0) == negative:
                return label
    raise AssertionError("no label with the wanted hashtext sign")


def _holder_pid(admin, label: str):
    with admin.cursor() as cur:
        cur.execute(
            f"SELECT l.pid FROM pg_locks l WHERE {KEY_MATCH}", (f"polis-math-python:{label}",)
        )
        rows = cur.fetchall()
    return [row[0] for row in rows]


@pytest.mark.parametrize("negative", [True, False], ids=["negative-key", "positive-key"])
def test_one_writer_per_label_and_takeover_when_the_holder_dies(admin, pollers, negative):
    label = _label_with_sign(admin, negative)
    first = pollers(label)
    assert first.wait_for("ADMITTED"), first.lines
    assert f"holding single-writer lock for math_env={label}" in "\n".join(first.lines)

    second = pollers(label)
    # The second waits (several retries) and never proceeds while the first lives.
    assert second.wait_for("waiting for single-writer lock; holder=", count=3), second.lines
    assert not second.admitted()
    (holder_pid,) = _holder_pid(admin, label)
    waiting = [line for line in second.lines if "waiting for single-writer lock" in line]
    assert all(f"holder=math-python:{label}@" in line for line in waiting), waiting
    assert all(f"(pid {holder_pid})" in line for line in waiting), waiting
    assert second.proc.poll() is None, "a waiting poller must not exit"

    first.kill()
    # The dead session's lock is released; the second takes over within a retry.
    assert second.wait_for("ADMITTED", timeout=10), second.lines
    assert len(_holder_pid(admin, label)) == 1


def test_different_labels_do_not_block_each_other(admin, pollers):
    a = pollers(f"locktest-{uuid.uuid4().hex[:8]}")
    b = pollers(f"locktest-{uuid.uuid4().hex[:8]}")
    assert a.wait_for("ADMITTED"), a.lines
    assert b.wait_for("ADMITTED"), b.lines
    assert not any("waiting for single-writer lock" in line for line in a.lines + b.lines)


def test_losing_the_lock_connection_stops_the_holder(admin, pollers):
    label = f"locktest-{uuid.uuid4().hex[:8]}"
    holder = pollers(label)
    assert holder.wait_for("ADMITTED"), holder.lines
    (pid,) = _holder_pid(admin, label)
    with admin.cursor() as cur:
        cur.execute("SELECT pg_terminate_backend(%s)", (pid,))
        assert cur.fetchone()[0]
    assert holder.proc.wait(timeout=10) == 3
    holder.wait_for("single-writer lock lost", timeout=2)
    assert any("single-writer lock lost" in line for line in holder.lines), holder.lines
    assert _holder_pid(admin, label) == []


def test_readiness_lines_follow_the_lock(admin, pollers):
    """P-072: a waiter logs standby lines, the holder a primary line once
    admitted, and a holder that loses the lock logs a final standby line
    before exiting 3."""
    from polismath.poller.readiness import parse_readiness

    label = f"locktest-{uuid.uuid4().hex[:8]}"
    holder = pollers(label)
    assert holder.wait_for("ADMITTED"), holder.lines
    waiter = pollers(label)
    assert waiter.wait_for("role=standby progress=waiting"), waiter.lines
    holder_bodies = [parse_readiness(x) for x in holder.lines if "math_poller readiness/1" in x]
    roles = [b["role"] for b in holder_bodies]
    assert roles[0] == "standby" and "primary" in roles, roles
    (pid,) = _holder_pid(admin, label)
    with admin.cursor() as cur:
        cur.execute("SELECT pg_terminate_backend(%s)", (pid,))
    assert holder.proc.wait(timeout=10) == 3
    holder.wait_for("single-writer lock lost", timeout=2)
    bodies = [parse_readiness(x) for x in holder.lines if "math_poller readiness/1" in x]
    assert bodies[-1]["role"] == "standby" and bodies[-2]["role"] == "primary", bodies
    seqs = [b["seq"] for b in bodies]
    assert seqs == list(range(1, len(seqs) + 1))
    # The waiter takes over and logs as primary.
    assert waiter.wait_for("ADMITTED", timeout=15), waiter.lines
    assert waiter.wait_for("role=primary"), waiter.lines
