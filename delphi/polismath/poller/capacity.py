"""Capacity disposition and the capacity demand line (P-073 PR2).

The small poller keeps one record per conversation that its memory budget
refused (or, with routing on, would refuse) and classifies it, by its
cold-rebuild size under the admission model, into one closed disposition:

  ``small``            fits the small poller's budget after all (a refusal
                       caused by something else holding memory at the time);
  ``large``            needs the large memory class: above ``route_fraction``
                       of the small compute capacity (``keep_fraction`` once it
                       is already routed, so a conversation near the line does
                       not flap), and within the large class's budget;
  ``exceeds_largest``  does not fit even the large class
                       (``MATH_CAPACITY_LARGE_BUDGET_MB``). Never counted as
                       demand: no large instance could compute it.

A ``large`` record is *demand* while its input is unresolved: from the first
refusal or routed batch until the small poller publishes the conversation
itself (or, in a later change, a large-class bundle is promoted).

Routing (``MATH_CAPACITY_ROUTING=1``, default off). Off: nothing changes in
what the poller computes; refusals still take the dump/retry/park path, and
the records and the demand line are observation only. On: a cold touch or
rebuild is sized and classified BEFORE its reservation, and a ``large`` or
``exceeds_largest`` conversation is not computed by this poller at all: its
cache entry is dropped and the work is resolved for the pool (no dump, retry
or park, so the readiness line never reports ``stuck`` for a capacity case).
A memory refusal of a conversation that classifies ``large`` is resolved the
same way. A routed conversation is re-sized at most once per
``MATH_CAPACITY_RESIZE_S`` (or when the binding changes), on new input.

The demand line. Once per readiness interval the reporter logs one line that
is a JSON object and nothing else (a CloudWatch JSON metric filter needs the
whole event to be JSON), on a dedicated logger with a bare ``%(message)s``
handler::

    {"class":"small","exceeds_largest":0,"fits_small":0,"label":"python",
     "large_demand":2,"oldest_unresolved_age_ms":412000,"pending_promotion":0,
     "refusals_total":5,"role":"primary","routed_total":17,"routing":1,
     "schema":"math_poller.capacity/1"}

Counts and closed labels only: zids never leave the private state file. A
primary always reports its counts (0 when there is no demand); a standby
reports ``role=standby`` with null counts, so a dead primary is missing data,
never a false 0. The same counts ride on the readiness line as ``capacity``.

Settings (never part of PollerConfig, so the poller config digest and the
backfill's calibration binding do not move): ``MATH_CAPACITY_ROUTING`` (0),
``MATH_CAPACITY_ROUTE_FRACTION`` (0.9), ``MATH_CAPACITY_KEEP_FRACTION`` (0.7),
``MATH_CAPACITY_LARGE_BUDGET_MB`` (unset: nothing is ``exceeds_largest``),
``MATH_CAPACITY_RESIZE_S`` (3600), ``MATH_CAPACITY_STATE_PATH`` (unset:
records live in memory only). A bad value turns routing off and is logged;
it never stops the poller.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import sys
import threading
import time
from dataclasses import asdict, dataclass
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

logger = logging.getLogger(__name__)

SMALL = "small"
LARGE = "large"
EXCEEDS_LARGEST = "exceeds_largest"
DISPOSITIONS = (SMALL, LARGE, EXCEEDS_LARGEST)
ROUTED = frozenset({LARGE, EXCEEDS_LARGEST})

LINE_SCHEMA = "math_poller.capacity/1"
STATE_SCHEMA = "polis-math-capacity-state/1"
CLASS_SMALL = "small"

# The capacity line's keys, closed (tests pin them), and the counts it shares
# with the readiness line's ``capacity`` object.
COUNT_KEYS = ("routing", "large_demand", "pending_promotion", "exceeds_largest", "fits_small",
              "oldest_unresolved_age_ms", "refusals_total", "routed_total")
LINE_KEYS = ("schema", "class", "role", "label") + COUNT_KEYS

ROUTING_ENV = "MATH_CAPACITY_ROUTING"
ROUTE_FRACTION_ENV = "MATH_CAPACITY_ROUTE_FRACTION"
KEEP_FRACTION_ENV = "MATH_CAPACITY_KEEP_FRACTION"
LARGE_BUDGET_ENV = "MATH_CAPACITY_LARGE_BUDGET_MB"
RESIZE_ENV = "MATH_CAPACITY_RESIZE_S"
STATE_PATH_ENV = "MATH_CAPACITY_STATE_PATH"

MB = 1024 * 1024
MAX_RECORDS = 1000


class CapacityConfigError(ValueError):
    """A MATH_CAPACITY_* value is unusable."""


def _now_ms() -> int:
    return int(time.time() * 1000)


def _optional_number(env: Mapping[str, str], name: str, low: float,
                     high: float) -> Optional[float]:
    raw = (env.get(name) or "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not (math.isfinite(value) and low <= value <= high):
        raise CapacityConfigError(f"{name}={raw!r} must be a number from {low:g} to {high:g}")
    return value


def _number(env: Mapping[str, str], name: str, default: float, low: float,
            high: float) -> float:
    value = _optional_number(env, name, low, high)
    return default if value is None else value


@dataclass(frozen=True)
class CapacitySettings:
    routing: bool = False
    route_fraction: float = 0.9
    keep_fraction: float = 0.7
    large_budget_mb: Optional[float] = None
    resize_s: float = 3600.0
    state_path: Optional[str] = None

    def __post_init__(self) -> None:
        if not (0 < self.keep_fraction <= self.route_fraction <= 1):
            raise CapacityConfigError(
                f"need 0 < {KEEP_FRACTION_ENV} <= {ROUTE_FRACTION_ENV} <= 1, got "
                f"{self.keep_fraction} and {self.route_fraction}")
        if self.large_budget_mb is not None and not self.large_budget_mb > 0:
            raise CapacityConfigError(f"{LARGE_BUDGET_ENV} must be > 0")
        if not self.resize_s >= 0:
            raise CapacityConfigError(f"{RESIZE_ENV} must be >= 0")

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "CapacitySettings":
        env = os.environ if env is None else env
        raw = (env.get(ROUTING_ENV) or "0").strip()
        if raw not in ("0", "1"):
            raise CapacityConfigError(f"{ROUTING_ENV}={raw!r} must be 0 or 1")
        return cls(
            routing=raw == "1",
            route_fraction=_number(env, ROUTE_FRACTION_ENV, 0.9, 0.0, 1.0),
            keep_fraction=_number(env, KEEP_FRACTION_ENV, 0.7, 0.0, 1.0),
            large_budget_mb=_optional_number(env, LARGE_BUDGET_ENV, 1.0, 16 * 1024 * 1024),
            resize_s=_number(env, RESIZE_ENV, 3600.0, 0.0, 30 * 86400.0),
            state_path=(env.get(STATE_PATH_ENV) or "").strip() or None,
        )

    @classmethod
    def from_env_or_off(cls, env: Optional[Mapping[str, str]] = None) -> "CapacitySettings":
        """The env settings, or the defaults (routing off) when any is unusable."""
        try:
            return cls.from_env(env)
        except CapacityConfigError as exc:
            logger.error("capacity settings unusable (%s); routing OFF, defaults used", exc)
            return cls()


@dataclass
class Disposition:
    """One conversation's record. JSON-serialisable; private (it names the zid)."""

    zid: int
    disposition: str
    need_bytes: int
    votes: Optional[int] = None
    voters: Optional[int] = None
    comments: Optional[int] = None
    binding: str = ""
    sized_ms: int = 0
    input_through_ms: Optional[int] = None
    # Wall clock when its input first became unresolved; None when caught up.
    first_unresolved_ms: Optional[int] = None
    refusals: int = 0

    @classmethod
    def from_dict(cls, raw: Any) -> "Disposition":
        """A record read back from the state file, every field type-checked:
        anything else raises ValueError (the loader drops that record)."""
        if not isinstance(raw, dict):
            raise ValueError("bad capacity record")
        for k in ("zid", "need_bytes", "sized_ms", "refusals"):
            if k in raw and not _is_count(raw[k]):
                raise ValueError(f"bad capacity record field {k}")
        for k in ("votes", "voters", "comments", "input_through_ms", "first_unresolved_ms"):
            if raw.get(k) is not None and not _is_count(raw[k]):
                raise ValueError(f"bad capacity record field {k}")
        if not isinstance(raw.get("binding", ""), str):
            raise ValueError("bad capacity record field binding")
        if "zid" not in raw or "need_bytes" not in raw or raw.get("disposition") not in DISPOSITIONS:
            raise ValueError("bad capacity record")
        return cls(**{k: raw[k] for k in cls.__dataclass_fields__ if k in raw})


def _is_count(v: Any) -> bool:
    return type(v) is int and v >= 0


class CapacityRouter:
    """One per poller process. Thread-safe; never touches the database (the
    service passes sizes in)."""

    def __init__(self, admission: Any, settings: Optional[CapacitySettings] = None, *,
                 clock_ms: Callable[[], int] = _now_ms) -> None:
        self._adm = admission
        self.settings = settings or CapacitySettings()
        self._clock = clock_ms
        self._lock = threading.Lock()
        self._records: Dict[int, Disposition] = {}
        self.refusals_total = 0
        self.routed_total = 0
        self._load()

    @property
    def routing(self) -> bool:
        return self.settings.routing

    # -- classification ----------------------------------------------------- #
    def binding(self) -> str:
        """16 hex: the model, the small budget, the fractions and the large
        budget. A record classified under another binding is re-classified."""
        s = self.settings
        blob = json.dumps({
            "model": self._adm.model.describe(), "budget_bytes": self._adm.budget_bytes,
            "route": s.route_fraction, "keep": s.keep_fraction,
            "large_budget_mb": s.large_budget_mb,
        }, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:16]

    def small_capacity(self) -> Optional[int]:
        """The most one computation may use here: the budget minus the measured
        quiescent baseline. None when the budget is unlimited."""
        return self._adm.compute_capacity_bytes()

    def large_capacity(self) -> Optional[int]:
        if self.settings.large_budget_mb is None:
            return None
        return int(self.settings.large_budget_mb * MB) - self._adm.model.base_bytes()

    def need_bytes(self, sizes: Tuple[int, int, int]) -> int:
        votes, voters, comments = sizes
        return self._adm.model.above_base_bytes(votes, voters, comments)

    def classify(self, need: int, *, routed: bool = False) -> str:
        """The disposition of a cold rebuild needing ``need`` bytes above the
        base. ``routed``: already large, so the lower keep fraction applies."""
        cap = self.small_capacity()
        if cap is None:
            return SMALL
        large = self.large_capacity()
        if large is not None and need > large:
            return EXCEEDS_LARGEST
        fraction = self.settings.keep_fraction if routed else self.settings.route_fraction
        return LARGE if need > fraction * cap else SMALL

    # -- records ------------------------------------------------------------ #
    def disposition(self, zid: int) -> Optional[str]:
        with self._lock:
            rec = self._records.get(zid)
            return None if rec is None else rec.disposition

    def is_routed(self, zid: int) -> bool:
        return self.disposition(zid) in ROUTED

    def needs_resize(self, zid: int) -> bool:
        with self._lock:
            rec = self._records.get(zid)
            if rec is None:
                return True
            return (rec.binding != self.binding() or rec.votes is None
                    or self._clock() - rec.sized_ms >= self.settings.resize_s * 1000)

    def observe(self, zid: int, *, sizes: Optional[Tuple[int, int, int]] = None,
                need: Optional[int] = None, input_ms: Optional[int] = None,
                refused: bool = False) -> str:
        """Classify a sized conversation and keep its record. ``sizes`` are its
        (vote rows, voters, comments); without them, ``need`` (bytes above the
        base) classifies it. A ``small`` conversation keeps a record only when
        it was refused; an existing routed record that now classifies small is
        un-routed (removed). Returns the disposition."""
        if sizes is not None:
            need = self.need_bytes(sizes)
        if need is None:
            raise ValueError("observe needs sizes or need")
        now = self._clock()
        with self._lock:
            if refused:
                self.refusals_total += 1
            rec = self._records.get(zid)
            disposition = self.classify(int(need), routed=rec is not None
                                        and rec.disposition in ROUTED)
            if disposition == SMALL and not refused:
                if rec is not None:
                    del self._records[zid]
                    logger.info("capacity: zid=%s now fits the small class; un-routed", zid)
                    self._save_locked()
                return SMALL
            if rec is None:
                rec = Disposition(zid, disposition, int(need))
                self._records[zid] = rec
                logger.info("capacity: zid=%s disposition=%s need_mb=%.0f", zid,
                               disposition, need / MB)
            elif rec.disposition != disposition:
                logger.info("capacity: zid=%s disposition %s -> %s need_mb=%.0f", zid,
                               rec.disposition, disposition, need / MB)
            rec.disposition = disposition
            rec.need_bytes = int(need)
            if sizes is not None:
                rec.votes, rec.voters, rec.comments = (int(x) for x in sizes)
            rec.binding = self.binding()
            rec.sized_ms = now
            if refused:
                rec.refusals += 1
            self._advance_locked(rec, input_ms, now)
            self._trim_locked()
            self._save_locked()
            return disposition

    def advance(self, zid: int, input_ms: Optional[int]) -> None:
        """New input for a recorded conversation, without re-sizing it."""
        with self._lock:
            rec = self._records.get(zid)
            if rec is not None and self._advance_locked(rec, input_ms, self._clock()):
                self._save_locked()

    def note_routed(self) -> None:
        with self._lock:
            self.routed_total += 1

    def resolved(self, zid: int) -> None:
        """This poller published the conversation: its record is closed."""
        with self._lock:
            if self._records.pop(zid, None) is not None:
                logger.info("capacity: zid=%s published by the small class; record closed", zid)
                self._save_locked()

    def _advance_locked(self, rec: Disposition, input_ms: Optional[int], now: int) -> bool:
        changed = False
        if input_ms is not None and (rec.input_through_ms is None
                                     or input_ms > rec.input_through_ms):
            rec.input_through_ms = int(input_ms)
            changed = True
        if rec.first_unresolved_ms is None:
            rec.first_unresolved_ms = now
            changed = True
        return changed

    def _trim_locked(self) -> None:
        """Bounded: past MAX_RECORDS the oldest-sized records go, ``small``
        (evidence only) before any demand."""
        while len(self._records) > MAX_RECORDS:
            victim = min(self._records.values(),
                         key=lambda r: (r.disposition != SMALL, r.sized_ms))
            del self._records[victim.zid]

    # -- the demand ---------------------------------------------------------- #
    def counts(self) -> Dict[str, Any]:
        """The closed counts (COUNT_KEYS) for the capacity and readiness lines."""
        now = self._clock()
        with self._lock:
            recs = list(self._records.values())
            refusals, routed = self.refusals_total, self.routed_total
        demand = [r for r in recs if r.disposition == LARGE and r.first_unresolved_ms is not None]
        oldest = min((r.first_unresolved_ms for r in demand
                      if r.first_unresolved_ms is not None), default=None)
        return {
            "routing": int(self.settings.routing),
            "large_demand": len(demand),
            "pending_promotion": 0,  # no staged bundles until the large class exists
            "exceeds_largest": sum(1 for r in recs if r.disposition == EXCEEDS_LARGEST),
            "fits_small": sum(1 for r in recs if r.disposition == SMALL),
            "oldest_unresolved_age_ms": None if oldest is None else max(0, now - oldest),
            "refusals_total": refusals,
            "routed_total": routed,
        }

    # -- persistence (the private state volume) ------------------------------ #
    def _load(self) -> None:
        path = self.settings.state_path
        if not path or not os.path.exists(path):
            return
        try:
            with open(path) as fh:
                raw = json.load(fh)
            if not isinstance(raw, dict) or raw.get("schema") != STATE_SCHEMA:
                raise ValueError("unknown schema")
            rows = raw.get("records", [])
            if not isinstance(rows, list):
                raise ValueError("records is not a list")
        except Exception as exc:  # noqa: BLE001 - a bad file starts empty, never stops the poller
            logger.error("capacity: state file unreadable (%s); starting with no records",
                         exc.__class__.__name__)
            return
        records, dropped = [], 0
        for row in rows:
            try:
                records.append(Disposition.from_dict(row))
            except (TypeError, ValueError):
                dropped += 1
        if dropped:
            logger.error("capacity: dropped %d malformed records from the state file", dropped)
        self._records = {r.zid: r for r in records}
        logger.info("capacity: restored %d records", len(self._records))

    def _save_locked(self) -> None:
        path = self.settings.state_path
        if not path:
            return
        body = {"schema": STATE_SCHEMA, "written_ms": self._clock(),
                "records": [asdict(r) for r in sorted(self._records.values(),
                                                      key=lambda r: r.zid)]}
        tmp = f"{path}.tmp"
        try:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(tmp, "w") as fh:
                json.dump(body, fh, sort_keys=True, separators=(",", ":"))
            os.replace(tmp, path)
        except OSError as exc:
            logger.error("capacity: state file not written (%s)", exc.__class__.__name__)


# --------------------------------------------------------------------------- #
# The capacity line
# --------------------------------------------------------------------------- #
LINE_LOGGER = "math_poller.capacity_line"
_line_lock = threading.Lock()


class _CurrentStderr(logging.StreamHandler):
    """Writes to whatever ``sys.stderr`` is at emit time (as the root
    handler's output does), so a replaced stream is never written after it
    is closed."""

    def __init__(self) -> None:
        super().__init__(sys.stderr)

    @property
    def stream(self):  # type: ignore[override]
        return sys.stderr

    @stream.setter
    def stream(self, _value: Any) -> None:
        pass


def _line_logger() -> logging.Logger:
    """A logger whose events are the bare JSON (no time/level prefix) and that
    never reaches the root handler's formatter."""
    log = logging.getLogger(LINE_LOGGER)
    with _line_lock:
        if not getattr(log, "_capacity_configured", False):
            handler = _CurrentStderr()
            handler.setFormatter(logging.Formatter("%(message)s"))
            log.addHandler(handler)
            log.setLevel(logging.INFO)
            log.propagate = False
            log._capacity_configured = True  # type: ignore[attr-defined]
    return log


def emit_line(line: str) -> None:
    _line_logger().info("%s", line)


def build_line(role: str, label: str, counts: Optional[Dict[str, Any]]) -> str:
    """The capacity line for one readiness tick. ``counts`` None (a standby,
    or no service yet): null counts, which no metric filter turns into 0."""
    body: Dict[str, Any] = {"schema": LINE_SCHEMA, "class": CLASS_SMALL, "role": role,
                            "label": label}
    for k in COUNT_KEYS:
        body[k] = None if counts is None else counts.get(k)
    return json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _count(v: Any, nullable: bool) -> None:
    if v is None and nullable:
        return
    if type(v) is not int or v < 0:
        raise ValueError("expected a non-negative integer")


def validate_counts(counts: Any, *, nullable: bool = False) -> None:
    """The closed counts object (readiness ``capacity`` and the line's fields)."""
    if not isinstance(counts, dict) or set(counts) != set(COUNT_KEYS):
        raise ValueError(f"expected keys {sorted(COUNT_KEYS)}")
    for k in COUNT_KEYS:
        _count(counts[k], nullable or k == "oldest_unresolved_age_ms")
    if counts["routing"] not in (None, 0, 1):
        raise ValueError("routing must be 0 or 1")


def parse_line(line: str) -> Optional[Dict[str, Any]]:
    """A capacity line's body, validated; None for any other line."""
    text = line.strip()
    if not text.startswith("{") or LINE_SCHEMA not in text:
        return None
    body = json.loads(text)
    if not isinstance(body, dict) or body.get("schema") != LINE_SCHEMA:
        return None
    if set(body) != set(LINE_KEYS):
        raise ValueError(f"expected keys {sorted(LINE_KEYS)}")
    if body["class"] != CLASS_SMALL or body["role"] not in ("primary", "standby"):
        raise ValueError("bad class or role")
    if not isinstance(body["label"], str):
        raise ValueError("bad label")
    validate_counts({k: body[k] for k in COUNT_KEYS}, nullable=body["role"] != "primary")
    return body


__all__ = [
    "COUNT_KEYS", "CapacityConfigError", "CapacityRouter", "CapacitySettings", "DISPOSITIONS",
    "Disposition", "EXCEEDS_LARGEST", "LARGE", "LINE_KEYS", "LINE_SCHEMA", "SMALL",
    "build_line", "emit_line", "parse_line", "validate_counts",
]
