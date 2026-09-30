"""Fail-closed guards around the math poller's single-writer admission.

No database needed. Covers (1) the two admission intervals are refused
(exit 2) before any connection unless they are finite seconds within the
accepted range, and (2) any failure inside the lock watchdog's loop, the
sleep included, terminates the whole process with code 3 rather than
ending only the watchdog thread. The real-Postgres admission cases live in
test_single_writer_lock.py.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import math_poller

DELPHI_ROOT = Path(__file__).resolve().parents[2]
INTERVAL_VARS = (math_poller.LOCK_RETRY_ENV, math_poller.LOCK_LIVENESS_ENV)


class _Connected(Exception):
    pass


@pytest.fixture
def poller_env(monkeypatch):
    """main() with a valid label; records any attempt to open the lock
    connection (and stops there)."""
    attempts = []

    def fake_open(config):
        attempts.append(config.math_env)
        raise _Connected

    monkeypatch.setattr(math_poller, "_open_lock_connection", fake_open)
    monkeypatch.setattr(math_poller, "_build_service", lambda config: pytest.fail("service built"))
    monkeypatch.setenv("MATH_ENV", "python")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/db")
    monkeypatch.delenv("MATH_POLLER_ALLOW_SERVED_ENV", raising=False)
    monkeypatch.setenv("MATH_POLLER_INSTANCE_ID", "i-0guardtest")
    monkeypatch.delenv("MATH_POLLER_ALLOW_HOSTNAME_IDENTITY", raising=False)
    for name in INTERVAL_VARS:
        monkeypatch.delenv(name, raising=False)
    return attempts


@pytest.mark.parametrize("allow", ["", "0", "yes", "true"])
def test_hostname_identity_is_refused_before_connecting(poller_env, monkeypatch, capsys, allow):
    """P-072: without MATH_POLLER_INSTANCE_ID the readiness lines would name
    the holder by container hostname; refused unless explicitly allowed."""
    monkeypatch.delenv("MATH_POLLER_INSTANCE_ID")
    monkeypatch.setenv("MATH_POLLER_ALLOW_HOSTNAME_IDENTITY", allow)
    with pytest.raises(SystemExit) as exc:
        math_poller.main([])
    assert exc.value.code == 2 and poller_env == []
    assert "MATH_POLLER_INSTANCE_ID is empty" in capsys.readouterr().err


def test_hostname_identity_proceeds_only_when_allowed(poller_env, monkeypatch):
    monkeypatch.delenv("MATH_POLLER_INSTANCE_ID")
    monkeypatch.setenv("MATH_POLLER_ALLOW_HOSTNAME_IDENTITY", "1")
    with pytest.raises(_Connected):
        math_poller.main([])
    assert poller_env == ["python"]


@pytest.mark.parametrize("name", INTERVAL_VARS)
@pytest.mark.parametrize(
    "raw",
    ["nan", "NaN", "inf", "-inf", "infinity", "1e309", "1e100", "3600.5", "0", "0.0", "0.5", "-1", "-30", "abc", "30s", "1_0x"],
)
def test_invalid_interval_refused_before_connecting(poller_env, monkeypatch, capsys, name, raw):
    monkeypatch.setenv(name, raw)
    with pytest.raises(SystemExit) as exc:
        math_poller.main([])
    assert exc.value.code == 2
    assert poller_env == [], "an invalid interval must be refused before any connection"
    err = capsys.readouterr().err
    assert f"refusing to start: {name}=" in err
    assert "from 1 to 3600" in err


@pytest.mark.parametrize("name", INTERVAL_VARS)
@pytest.mark.parametrize("raw", ["", "1", "5", "30", " 30 ", "3600", "1e3"])
def test_valid_interval_proceeds_to_admission(poller_env, monkeypatch, name, raw):
    monkeypatch.setenv(name, raw)
    with pytest.raises(_Connected):
        math_poller.main([])
    assert poller_env == ["python"]


@pytest.mark.parametrize("name,default", [(math_poller.LOCK_RETRY_ENV, 30.0), (math_poller.LOCK_LIVENESS_ENV, 5.0)])
def test_interval_defaults(monkeypatch, name, default):
    monkeypatch.delenv(name, raising=False)
    fallback = math_poller.DEFAULT_LOCK_RETRY_S if name == math_poller.LOCK_RETRY_ENV else math_poller.DEFAULT_LOCK_LIVENESS_S
    assert fallback == default
    assert math_poller._interval_seconds(name, fallback) == default


# Each case runs the real watchdog in a child process (os._exit would end
# pytest), with a fake connection, and leaves the main thread idling as the
# service would. The child must die with code 3 on its own.
WATCHDOG_CHILD = """
import logging, sys, threading, time
from scripts import math_poller

logging.basicConfig(level=logging.INFO, stream=sys.stderr)
case = sys.argv[1]

class Cursor:
    def __enter__(self):
        return self
    def __exit__(self, *exc):
        return False
    def execute(self, sql, params):
        if case == "query-raises":
            raise RuntimeError("boom")
    def fetchone(self):
        return (case != "lock-gone",)

class Conn:
    def cursor(self):
        if case == "cursor-raises-baseexception":
            raise KeyboardInterrupt
        return Cursor()

if case == "sleep-raises":
    def bad_sleep(seconds):
        raise OverflowError("sleep length is too large")
    math_poller.time.sleep = bad_sleep

math_poller._start_lock_watchdog(Conn(), "python", 0.05, logging.getLogger("t"))
# The "service": keeps running unless the watchdog kills the process.
threading.Event().wait(20)
print("SERVICE-OUTLIVED-WATCHDOG", flush=True)
raise SystemExit(0)
"""


@pytest.mark.parametrize(
    "case,reason",
    [
        ("sleep-raises", "watchdog failed: OverflowError"),
        ("cursor-raises-baseexception", "watchdog failed: KeyboardInterrupt"),
        ("query-raises", "lock connection failed: RuntimeError"),
        ("lock-gone", "session no longer holds the lock"),
    ],
)
def test_any_watchdog_failure_kills_the_process(case, reason):
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(DELPHI_ROOT), env.get("PYTHONPATH")]))
    child = subprocess.run(
        [sys.executable, "-c", WATCHDOG_CHILD, case],
        cwd=DELPHI_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert "SERVICE-OUTLIVED-WATCHDOG" not in child.stdout
    assert child.returncode == 3, child.stderr
    assert f"single-writer lock lost ({reason})" in child.stderr
