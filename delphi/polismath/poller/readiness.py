"""Readiness and liveness evidence for the Python math poller (P-072).

Every ``interval_s`` (default 60 s, ``MATH_POLLER_READINESS_INTERVAL_S``) the
poller logs one structured line::

    math_poller readiness/1 role=<role> progress=<progress> {json}

and, when the admitted holder's discovery or live work has not moved for
``MATH_POLLER_DISCOVERY_STALE_S`` (default 600 s)::

    math_poller discovery_stale/1 {json}

The prefix before the JSON is what the CloudWatch metric filters match (they
cannot read JSON inside a line that is not itself JSON); the JSON carries the
evidence the operator's collector (``scripts/collect_readiness.py``) turns into
a ``polis-backfill-readiness/1`` record. Everything in a line is a count, a
millisecond clock, a closed label or a digest: no conversation ids, no content,
no error text.

Roles (closed): ``primary`` (this process holds the label's single-writer lock)
and ``standby`` (waiting for it, or just lost it). Only a primary line whose
progress is ``ok`` is the heartbeat the liveness alarm counts, so a standby, a
process whose poll loops stopped completing, or one with stuck live work never
satisfies it.

Progress (closed):
  ``ok``        primary, both poll loops completed at least once since the
                previous line, and no live work older than the stale bound;
  ``starting``  primary, no loop has completed yet, inside the stale bound;
  ``no_poll``   primary, a loop did not complete since the previous line;
  ``stale``     primary, a loop's last success is older than the stale bound
                (or it never succeeded within the bound since admission);
  ``stuck``     primary, loops fine but live work waited or ran longer than the
                stale bound;
  ``waiting``   standby.

The alert test (``MATH_POLLER_READINESS_ALERT_TEST=<16-64 lowercase hex nonce>``)
logs one ``math_poller readiness_test/1`` line at start, which the
discovery-stale metric filter also counts, so the real filter, metric, alarm
and topic are exercised end to end. With
``MATH_POLLER_READINESS_ALERT_TEST_SILENCE_S=<s>`` the primary additionally
withholds its heartbeat (logging ``readiness_silenced/1`` lines instead) for
that long, which exercises the liveness alarm without stopping the holder.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import socket
import threading
import time
import uuid
from dataclasses import asdict, is_dataclass
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("math_poller.readiness")

SCHEMA = "math_poller.readiness/1"
HEADER = "math_poller readiness/1"
SILENCED_HEADER = "math_poller readiness_silenced/1"
STALE_HEADER = "math_poller discovery_stale/1"
TEST_HEADER = "math_poller readiness_test/1"
STALE_SCHEMA = "math_poller.discovery_stale/1"
TEST_SCHEMA = "math_poller.readiness_test/1"

PRIMARY = "primary"
STANDBY = "standby"
ROLES = (PRIMARY, STANDBY)
PROGRESS = ("ok", "starting", "no_poll", "stale", "stuck", "waiting")
STALE_REASONS = ("discovery", "queue")
ERROR_CLASSES = ("database", "timeout", "other")
SWEEP_STATUS = ("COMPLETE", "NOT_COMPLETE", "UNKNOWN")
INSTANCE_SOURCES = ("instance_id", "hostname")

# Keys of each JSON object, closed (tests pin them).
LINE_KEYS = ("schema", "seq", "emitted_ms", "role", "progress", "instance_sha256", "instance_source",
             "image_digest", "source_commit", "run", "config", "poller_config", "interval_s",
             "stale_s", "discovery", "queue", "sweep", "drain", "admission")
DISCOVERY_KEYS = ("successes", "consecutive", "last_success_ms", "last_success_age_ms",
                  "failures_since_success", "last_error", "last_error_ms")
QUEUE_KEYS = ("pending", "in_flight", "parked", "oldest_live_age_ms", "oldest_backfill_age_ms",
              "oldest_work_age_ms")
SWEEP_KEYS = ("sweep_no", "finished_ms", "run", "config", "status", "unresolved", "parked_live",
              "in_flight")
DRAIN_KEYS = ("run", "drained_ms")
ADMISSION_KEYS = ("budget_mb", "reserved_mb", "granted", "held", "waiting")
STALE_KEYS = ("schema", "seq", "emitted_ms", "run", "reason", "age_ms", "stale_s")
TEST_KEYS = ("schema", "emitted_ms", "run", "nonce", "silence_s")

INTERVAL_ENV = "MATH_POLLER_READINESS_INTERVAL_S"
STALE_ENV = "MATH_POLLER_DISCOVERY_STALE_S"
ALERT_TEST_ENV = "MATH_POLLER_READINESS_ALERT_TEST"
ALERT_SILENCE_ENV = "MATH_POLLER_READINESS_ALERT_TEST_SILENCE_S"
INSTANCE_ENV = "MATH_POLLER_INSTANCE_ID"
IMAGE_ENV = "MATH_POLLER_IMAGE_DIGEST"
COMMIT_ENV = "MATH_POLLER_SOURCE_COMMIT"

DEFAULT_INTERVAL_S = 60.0
DEFAULT_STALE_S = 600.0
INTERVAL_RANGE = (5.0, 3600.0)
STALE_RANGE = (30.0, 86400.0)
SILENCE_RANGE = (0.0, 3600.0)

_HEX40 = re.compile(r"[0-9a-f]{40}")
_IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
_NONCE = re.compile(r"[0-9a-f]{16,64}")
_LINE = re.compile(r"math_poller (readiness|readiness_silenced)/1 role=(\w+) progress=(\w+) (\{.*\})\s*$")
_STALE_LINE = re.compile(r"math_poller discovery_stale/1 (\{.*\})\s*$")
_TEST_LINE = re.compile(r"math_poller readiness_test/1 (\{.*\})\s*$")


class ReadinessConfigError(ValueError):
    """A readiness setting is unusable; the poller refuses to start."""


def _seconds(env: Dict[str, str], name: str, default: float, bounds) -> float:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    low, high = bounds
    if not (math.isfinite(value) and low <= value <= high):
        raise ReadinessConfigError(f"{name}={raw!r} must be a number of seconds from {low:g} to {high:g}")
    return value


def _now_ms() -> int:
    return int(time.time() * 1000)


def classify_error(exc: BaseException) -> str:
    """A closed label for a poll failure (never the message)."""
    names = {c.__name__ for c in type(exc).__mro__}
    module = type(exc).__module__ or ""
    if isinstance(exc, TimeoutError) or names & {"QueryCanceled", "QueryCanceledError"}:
        return "timeout"
    if module.startswith(("psycopg2", "sqlalchemy")) or names & {"OperationalError", "InterfaceError",
                                                                  "DatabaseError"}:
        return "database"
    return "other"


def config_digest(config: Any) -> str:
    """12 hex of the sha256 of the effective poller config, secrets removed."""
    data = asdict(config) if is_dataclass(config) else dict(config)
    data.pop("database_url", None)
    blob = json.dumps(data, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def identity(env: Optional[Dict[str, str]] = None) -> Dict[str, Optional[str]]:
    """Instance digest (never the raw id), image digest and source commit."""
    env = os.environ if env is None else env
    instance = (env.get(INSTANCE_ENV) or "").strip()
    source = "instance_id"
    if not instance:
        instance, source = (env.get("HOSTNAME") or socket.gethostname()), "hostname"
    image = (env.get(IMAGE_ENV) or "").strip().lower()
    commit = (env.get(COMMIT_ENV) or "").strip().lower()
    return {
        "instance_sha256": hashlib.sha256(("polis-math-poller-instance:" + instance).encode()).hexdigest(),
        "instance_source": source,
        "image_digest": image if _IMAGE.fullmatch(image) else None,
        "source_commit": commit if _HEX40.fullmatch(commit) else None,
    }


class ReadinessSettings:
    """The validated MATH_POLLER_READINESS_* environment."""

    def __init__(self, interval_s: float = DEFAULT_INTERVAL_S, stale_s: float = DEFAULT_STALE_S,
                 alert_nonce: Optional[str] = None, silence_s: float = 0.0) -> None:
        self.interval_s = interval_s
        self.stale_s = stale_s
        self.alert_nonce = alert_nonce
        self.silence_s = silence_s if alert_nonce else 0.0

    @classmethod
    def from_env(cls, env: Optional[Dict[str, str]] = None) -> "ReadinessSettings":
        env = os.environ if env is None else env
        interval = _seconds(env, INTERVAL_ENV, DEFAULT_INTERVAL_S, INTERVAL_RANGE)
        stale = _seconds(env, STALE_ENV, DEFAULT_STALE_S, STALE_RANGE)
        if stale < 2 * interval:
            raise ReadinessConfigError(f"{STALE_ENV} must be at least twice {INTERVAL_ENV}")
        nonce = (env.get(ALERT_TEST_ENV) or "").strip()
        if nonce and not _NONCE.fullmatch(nonce):
            # A malformed test flag never stops the poller: logged, ignored.
            logger.error("%s ignored: it must be 16-64 lowercase hex characters", ALERT_TEST_ENV)
            nonce = ""
        silence = _seconds(env, ALERT_SILENCE_ENV, 0.0, SILENCE_RANGE)
        return cls(interval, stale, nonce or None, silence)


class ReadinessReporter:
    """Builds and logs the readiness lines. ``tick()`` is the whole behaviour;
    ``start()`` only runs it on a daemon thread every ``interval_s``.

    ``source`` (set once the service exists) returns the service's
    ``readiness_snapshot()``: discovery, queue, sweep, drain, admission and
    the backfill config digest. Before that (a standby waiting for the lock)
    the line carries empty evidence.
    """

    def __init__(self, settings: ReadinessSettings, poller_config: Any, *,
                 run: Optional[str] = None, env: Optional[Dict[str, str]] = None,
                 clock_ms: Callable[[], int] = _now_ms,
                 emit: Optional[Callable[[str], None]] = None) -> None:
        self.settings = settings
        self.run = run or uuid.uuid4().hex[:12]
        self.poller_config = config_digest(poller_config)
        self.identity = identity(env)
        self._clock = clock_ms
        self._emit = emit or (lambda line: logger.warning("%s", line))
        self._lock = threading.Lock()
        self._role = STANDBY
        self._primary_since_ms: Optional[int] = None
        self._seq = 0
        self._source: Optional[Callable[[], Dict[str, Any]]] = None
        self._last_marks: Optional[tuple] = None
        self._silence_until_ms: Optional[int] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- state -------------------------------------------------------------- #
    @property
    def role(self) -> str:
        return self._role

    def set_source(self, source: Callable[[], Dict[str, Any]]) -> None:
        self._source = source

    def became_primary(self) -> None:
        """The single-writer lock is held. Logs a line at once."""
        with self._lock:
            self._role = PRIMARY
            self._primary_since_ms = self._clock()
            self._last_marks = None
        self.tick()

    def lock_lost(self) -> None:
        """Admission is gone (the process is about to exit): a final standby
        line, so the evidence shows the transition, not just silence."""
        with self._lock:
            self._role = STANDBY
            self._primary_since_ms = None
        self.tick()

    # -- lines -------------------------------------------------------------- #
    def alert_test(self) -> Optional[str]:
        """The alert-test line (once, at start), when the flag is set."""
        nonce = self.settings.alert_nonce
        if not nonce:
            return None
        now = self._clock()
        if self.settings.silence_s:
            self._silence_until_ms = now + int(self.settings.silence_s * 1000)
        body = {"schema": TEST_SCHEMA, "emitted_ms": now, "run": self.run, "nonce": nonce,
                "silence_s": int(self.settings.silence_s)}
        line = f"{TEST_HEADER} {_dumps(body)}"
        self._emit(line)
        return line

    def tick(self) -> list:
        """Build, log and return this interval's lines."""
        with self._lock:
            now = self._clock()
            self._seq += 1
            seq = self._seq
            role = self._role
            snap = _empty_snapshot()
            if self._source is not None:
                try:
                    snap = self._source()
                except Exception as exc:  # noqa: BLE001 - evidence must not stop the poller
                    logger.error("readiness snapshot failed (%s)", exc.__class__.__name__)
                    snap = _empty_snapshot()
            progress, stale_reason, stale_age = self._progress(role, snap, now)
            discovery = dict(snap["discovery"])
            last = discovery.get("last_success_ms")
            discovery["last_success_age_ms"] = None if last is None else max(0, now - last)
            body = {
                "schema": SCHEMA, "seq": seq, "emitted_ms": now, "role": role, "progress": progress,
                **self.identity,
                "run": self.run, "config": snap.get("config"), "poller_config": self.poller_config,
                "interval_s": int(self.settings.interval_s), "stale_s": int(self.settings.stale_s),
                "discovery": {k: discovery.get(k) for k in DISCOVERY_KEYS},
                "queue": {k: snap["queue"].get(k) for k in QUEUE_KEYS},
                "sweep": snap.get("sweep"), "drain": snap.get("drain"),
                "admission": snap.get("admission"),
            }
            silenced = (role == PRIMARY and self._silence_until_ms is not None
                        and now < self._silence_until_ms)
            header = SILENCED_HEADER if silenced else HEADER
            lines = [f"{header} role={role} progress={progress} {_dumps(body)}"]
            if stale_reason is not None:
                stale = {"schema": STALE_SCHEMA, "seq": seq, "emitted_ms": now, "run": self.run,
                         "reason": stale_reason, "age_ms": stale_age,
                         "stale_s": int(self.settings.stale_s)}
                lines.append(f"{STALE_HEADER} {_dumps(stale)}")
        for line in lines:
            self._emit(line)
        return lines

    def _progress(self, role: str, snap: Dict[str, Any], now: int):
        """(progress, stale reason or None, stale age ms or None)."""
        if role != PRIMARY:
            self._last_marks = None
            return "waiting", None, None
        d, q = snap["discovery"], snap["queue"]
        stale_ms = int(self.settings.stale_s * 1000)
        marks = tuple(snap.get("loop_marks") or ())
        previous, self._last_marks = self._last_marks, marks
        since = self._primary_since_ms if self._primary_since_ms is not None else now
        last = d.get("last_success_ms")
        # Discovery: the older of the two loops' last successes.
        age = (now - last) if last is not None else (now - since)
        if age > stale_ms:
            return "stale", "discovery", age
        live_age = q.get("oldest_live_age_ms")
        if live_age is not None and live_age > stale_ms:
            return "stuck", "queue", live_age
        if last is None:
            return "starting", None, None
        if previous is not None and any(m == p for m, p in zip(marks, previous)):
            return "no_poll", None, None
        if d.get("failures_since_success"):
            return "no_poll", None, None
        return "ok", None, None

    # -- thread ------------------------------------------------------------- #
    def start(self) -> None:
        self.alert_test()
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="readiness", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        # A line at once (a process announces itself at boot, as a standby
        # until it holds the lock), then one per interval.
        while True:
            try:
                self.tick()
            except Exception as exc:  # noqa: BLE001 - the reporter never dies quietly
                logger.error("readiness tick failed (%s)", exc.__class__.__name__)
            if self._stop.wait(self.settings.interval_s):
                return


def _empty_snapshot() -> Dict[str, Any]:
    return {
        "discovery": {"successes": 0, "consecutive": 0, "last_success_ms": None,
                      "failures_since_success": 0, "last_error": None, "last_error_ms": None},
        "queue": {"pending": 0, "in_flight": 0, "parked": 0, "oldest_live_age_ms": None,
                  "oldest_backfill_age_ms": None, "oldest_work_age_ms": 0},
        "sweep": None, "drain": None, "admission": None, "config": None, "loop_marks": (),
    }


def _dumps(body: Dict[str, Any]) -> str:
    return json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False)


# --------------------------------------------------------------------------- #
# Parsing (the collector and the tests)
# --------------------------------------------------------------------------- #
def parse_readiness(line: str) -> Optional[Dict[str, Any]]:
    """The JSON of a readiness (or silenced) line, with its header fields
    checked against the body; None for any other line. Raises ValueError for
    a readiness line that does not match the closed shape."""
    m = _LINE.search(line)
    if not m:
        return None
    kind, role, progress, raw = m.groups()
    body = json.loads(raw)
    validate_line(body)
    if body["role"] != role or body["progress"] != progress:
        raise ValueError("readiness header disagrees with its body")
    body = dict(body)
    body["_silenced"] = kind == "readiness_silenced"
    return body


def parse_stale(line: str) -> Optional[Dict[str, Any]]:
    m = _STALE_LINE.search(line)
    if not m:
        return None
    body = json.loads(m.group(1))
    _closed(body, STALE_KEYS)
    if body["schema"] != STALE_SCHEMA or body["reason"] not in STALE_REASONS:
        raise ValueError("bad discovery_stale line")
    return body


def parse_test(line: str) -> Optional[Dict[str, Any]]:
    m = _TEST_LINE.search(line)
    if not m:
        return None
    body = json.loads(m.group(1))
    _closed(body, TEST_KEYS)
    if body["schema"] != TEST_SCHEMA or not _NONCE.fullmatch(str(body["nonce"])):
        raise ValueError("bad readiness_test line")
    return body


def _closed(obj: Any, keys) -> None:
    if not isinstance(obj, dict) or set(obj) != set(keys):
        raise ValueError(f"expected keys {sorted(keys)}")


def _count(v: Any, nullable: bool = False) -> None:
    if v is None and nullable:
        return
    if type(v) is not int or v < 0:
        raise ValueError("expected a non-negative integer")


def _hex(v: Any, width: int, nullable: bool = False) -> None:
    if v is None and nullable:
        return
    if not isinstance(v, str) or not re.fullmatch(r"[0-9a-f]{%d}" % width, v):
        raise ValueError(f"expected {width} hex")


def validate_line(body: Dict[str, Any]) -> None:
    """The closed vocabulary of a readiness line body."""
    _closed(body, LINE_KEYS)
    if body["schema"] != SCHEMA or body["role"] not in ROLES or body["progress"] not in PROGRESS:
        raise ValueError("bad schema, role or progress")
    if (body["role"] == STANDBY) != (body["progress"] == "waiting"):
        raise ValueError("standby lines, and only they, are waiting")
    for k in ("seq", "emitted_ms", "interval_s", "stale_s"):
        _count(body[k])
    _hex(body["instance_sha256"], 64)
    if body["instance_source"] not in INSTANCE_SOURCES:
        raise ValueError("bad instance_source")
    if body["image_digest"] is not None and not _IMAGE.fullmatch(str(body["image_digest"])):
        raise ValueError("bad image digest")
    _hex(body["source_commit"], 40, nullable=True)
    _hex(body["run"], 12)
    _hex(body["config"], 12, nullable=True)
    _hex(body["poller_config"], 12)
    d = body["discovery"]
    _closed(d, DISCOVERY_KEYS)
    for k in ("successes", "consecutive", "failures_since_success"):
        _count(d[k])
    for k in ("last_success_ms", "last_success_age_ms", "last_error_ms"):
        _count(d[k], nullable=True)
    if d["last_error"] is not None and d["last_error"] not in ERROR_CLASSES:
        raise ValueError("bad last_error class")
    q = body["queue"]
    _closed(q, QUEUE_KEYS)
    for k in ("pending", "in_flight", "parked", "oldest_work_age_ms"):
        _count(q[k])
    for k in ("oldest_live_age_ms", "oldest_backfill_age_ms"):
        _count(q[k], nullable=True)
    if body["sweep"] is not None:
        s = body["sweep"]
        _closed(s, SWEEP_KEYS)
        for k in ("sweep_no", "finished_ms", "unresolved", "parked_live", "in_flight"):
            _count(s[k])
        _hex(s["run"], 12)
        _hex(s["config"], 12)
        if s["status"] not in SWEEP_STATUS:
            raise ValueError("bad sweep status")
    if body["drain"] is not None:
        dr = body["drain"]
        _closed(dr, DRAIN_KEYS)
        _hex(dr["run"], 12)
        _count(dr["drained_ms"], nullable=True)
    if body["admission"] is not None:
        a = body["admission"]
        _closed(a, ADMISSION_KEYS)
        for k in ADMISSION_KEYS:
            _count(a[k], nullable=(k == "budget_mb"))


__all__ = [
    "HEADER", "PRIMARY", "PROGRESS", "ROLES", "STALE_HEADER", "STANDBY", "TEST_HEADER",
    "ReadinessConfigError", "ReadinessReporter", "ReadinessSettings", "classify_error",
    "config_digest", "identity", "parse_readiness", "parse_stale", "parse_test", "validate_line",
]
