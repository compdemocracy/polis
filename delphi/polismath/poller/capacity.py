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

A ``large`` record is *unresolved* from the first refusal or routed batch
until the small poller publishes the conversation itself, or until the small
label carries a promoted large-class bundle that covers its newest input
(``polismath.poller.promotion``). It is *demand* while unresolved and no
staged bundle covering its input is already waiting for promotion
(``pending_promotion``).

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
     "promoted_total":0,"refusals_total":5,"role":"primary","routed_total":17,
     "routing":1,"schema":"math_poller.capacity/1"}

The large worker logs the same schema with ``"class":"large"`` and its own
counts (``LARGE_COUNT_KEYS``).

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
it never stops the small poller.

The large memory class (P-073 r2; ``polismath.poller.capacity_queue``,
``polismath.poller.promotion`` and ``polismath.poller.rebuild_child``): a
``large`` conversation becomes one ``math_rebuild`` job of worker class
``large`` on the Postgres job queue, inserted by the small poller through the
queue's SQL contract over ``MATH_CAPACITY_QUEUE_DSN`` (an executor-member
login, its password from the secret named by
``MATH_CAPACITY_QUEUE_LOGIN_SECRET``; without a queue that answers, routing
is refused, P-084) in the namespace ``MATH_CAPACITY_QUEUE_ENV``; the large box's jobs daemon runs
``scripts/math_poller.py --job`` for it, which stages the bundle under
``MATH_CAPACITY_STAGED_LABEL`` (``python-large``), and the small poller
promotes it (``MATH_CAPACITY_PROMOTE``, 1 needs routing on;
``MATH_CAPACITY_PROMOTE_INTO`` names the target label on the child's side;
``MATH_CAPACITY_RESTAGE`` is a 16-64 hex nonce; unset). With a queue DSN,
``large_demand``, ``large_leased`` and ``large_parked`` on the line are the
queue's counts of class ``large`` (``pq_class_depth``: ``queued``, ``leased``
and ``parked``); without one ``large_demand`` is the records' count as before
and ``large_leased`` and ``large_parked`` are null. The scale-in alarm sums
demand, leased and parked and needs every term reported (cdk/workerClasses.ts),
so without ``large_parked`` the large group never scales in. ``large_poisoned`` counts the routed records the
queue refused as poisoned (their last jobs died under this source commit),
parked here until a new deploy or a ruling.
``MATH_CAPACITY_CLASS`` is ``small``; ``large`` is refused at start (the
large class runs only as a queue child).
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

logger = logging.getLogger(__name__)

SMALL = "small"
LARGE = "large"
EXCEEDS_LARGEST = "exceeds_largest"
DISPOSITIONS = (SMALL, LARGE, EXCEEDS_LARGEST)
ROUTED = frozenset({LARGE, EXCEEDS_LARGEST})

LINE_SCHEMA = "math_poller.capacity/1"
STATE_SCHEMA = "polis-math-capacity-state/1"
CLASS_SMALL = "small"
CLASS_LARGE = "large"
CLASSES = (CLASS_SMALL, CLASS_LARGE)

# The capacity line's keys, closed (tests pin them), and the counts it shares
# with the readiness line's ``capacity`` object. ``promoted_total`` was added
# with the promotion loop (P-073 PR3), ``large_leased`` and ``large_poisoned``
# with the queue (r2), ``large_parked`` for the scale-in alarm.
COUNT_KEYS = ("routing", "large_demand", "large_leased", "large_parked", "large_poisoned",
              "pending_promotion", "exceeds_largest", "fits_small", "oldest_unresolved_age_ms",
              "refusals_total", "routed_total", "promoted_total")
# Nullable on a primary: ``oldest_unresolved_age_ms`` with nothing unresolved,
# ``large_leased`` and ``large_parked`` with no queue read (no DSN, or the read
# failed this tick).
NULLABLE_COUNT_KEYS = frozenset(("oldest_unresolved_age_ms", "large_leased", "large_parked"))
# The capacity line's REVISION (``rev``), a minor version under the same
# schema string. Each revision only ADDS keys to the counts; the table says
# which keys each one added, and ``CAPACITY_REV`` is the revision this emitter
# writes. Revision 1 is production's line (P-073 PR3, nine counts); revision 2
# added the queue's ``large_leased``, ``large_poisoned`` (r2) and
# ``large_parked``. Lines logged before revisioning carry no ``rev``: they are
# revision 1 or 2, told apart by their keys (``UNREVISIONED``). During a mixed
# deploy, and for retained log history, decoders read every revision from 1 to
# ``CAPACITY_REV + REV_FORWARD``: a line of an older revision carries exactly
# its own keys (the newer ones decode as null); a line of a newer revision
# must carry every key this decoder knows, and the keys its newer revision
# declared are checked as counts and dropped, never relayed (``decode_counts``).
CAPACITY_REV_KEYS: Dict[int, Tuple[str, ...]] = {
    1: ("routing", "large_demand", "pending_promotion", "exceeds_largest", "fits_small",
        "oldest_unresolved_age_ms", "refusals_total", "routed_total", "promoted_total"),
    2: ("large_leased", "large_poisoned", "large_parked"),
}
UNREVISIONED = (1, 2)
CAPACITY_REV = max(CAPACITY_REV_KEYS)
REV_FORWARD = 8
# Admission (cost-reduction plan P-084), revision 3: ``queue_full`` is 1 while
# the last admission was refused at the queued-job cap; ``queue_unreachable``
# is 1 while routing is configured on and refused because the queue is
# missing, unproven or failing (the small poller then computes as with
# routing off).
CAPACITY_REV_KEYS[3] = ("queue_full", "queue_unreachable")
COUNT_KEYS = COUNT_KEYS + CAPACITY_REV_KEYS[3]
CAPACITY_REV = max(CAPACITY_REV_KEYS)
LINE_KEYS = ("schema", "class", "role", "label", "rev") + COUNT_KEYS
# The former large worker's line (``class=large``, P-073 PR3): its closed
# counts, kept so recorded lines still parse. Nothing emits it since r2: the
# large class runs as a queue child, which prints no capacity line.
LARGE_COUNT_KEYS = ("busy", "queued", "skew", "allowlisted", "unfit", "refusal")
LARGE_LINE_KEYS = ("schema", "class", "role", "label") + LARGE_COUNT_KEYS
REFUSALS = ("manifest_missing", "manifest_unreadable", "label", "skew", "budget")

ROUTING_ENV = "MATH_CAPACITY_ROUTING"
ROUTE_FRACTION_ENV = "MATH_CAPACITY_ROUTE_FRACTION"
KEEP_FRACTION_ENV = "MATH_CAPACITY_KEEP_FRACTION"
LARGE_BUDGET_ENV = "MATH_CAPACITY_LARGE_BUDGET_MB"
RESIZE_ENV = "MATH_CAPACITY_RESIZE_S"
STATE_PATH_ENV = "MATH_CAPACITY_STATE_PATH"
CLASS_ENV = "MATH_CAPACITY_CLASS"
QUEUE_DSN_ENV = "MATH_CAPACITY_QUEUE_DSN"
QUEUE_ENV_ENV = "MATH_CAPACITY_QUEUE_ENV"
QUEUE_LOGIN_SECRET_ENV = "MATH_CAPACITY_QUEUE_LOGIN_SECRET"
PROMOTE_ENV = "MATH_CAPACITY_PROMOTE"
STAGED_LABEL_ENV = "MATH_CAPACITY_STAGED_LABEL"
PROMOTE_INTO_ENV = "MATH_CAPACITY_PROMOTE_INTO"
RESTAGE_ENV = "MATH_CAPACITY_RESTAGE"
DEFAULT_STAGED_LABEL = "python-large"

_LABEL = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_NONCE = re.compile(r"[0-9a-f]{16,64}")
_QUEUE_ENV = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")

MB = 1024 * 1024
DAY_MS = 86_400_000
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
    # P-073 PR3/r2: the large memory class.
    capacity_class: str = CLASS_SMALL
    queue_dsn: Optional[str] = None
    queue_env: Optional[str] = None
    # The NAME of the secret holding the queue login's password (P-084); the
    # DSN itself never carries one.
    queue_login_secret: Optional[str] = None
    promote: bool = False
    staged_label: str = DEFAULT_STAGED_LABEL
    promote_into: Optional[str] = None
    restage: Optional[str] = None

    def __post_init__(self) -> None:
        if not (0 < self.keep_fraction <= self.route_fraction <= 1):
            raise CapacityConfigError(
                f"need 0 < {KEEP_FRACTION_ENV} <= {ROUTE_FRACTION_ENV} <= 1, got "
                f"{self.keep_fraction} and {self.route_fraction}")
        if self.large_budget_mb is not None and not self.large_budget_mb > 0:
            raise CapacityConfigError(f"{LARGE_BUDGET_ENV} must be > 0")
        if not self.resize_s >= 0:
            raise CapacityConfigError(f"{RESIZE_ENV} must be >= 0")
        if self.capacity_class not in CLASSES:
            raise CapacityConfigError(f"{CLASS_ENV} must be one of {', '.join(CLASSES)}")
        if self.promote and not self.routing:
            # Promotion writes the small label for routed conversations only;
            # without routing the small poller still computes them itself.
            raise CapacityConfigError(f"{PROMOTE_ENV}=1 needs {ROUTING_ENV}=1")
        if not _LABEL.fullmatch(self.staged_label or ""):
            raise CapacityConfigError(f"{STAGED_LABEL_ENV} must be 1-64 of [A-Za-z0-9_.-]")
        if self.promote_into is not None and not _LABEL.fullmatch(self.promote_into):
            raise CapacityConfigError(f"{PROMOTE_INTO_ENV} must be 1-64 of [A-Za-z0-9_.-]")
        if self.restage is not None and not _NONCE.fullmatch(self.restage):
            raise CapacityConfigError(f"{RESTAGE_ENV} must be 16-64 lowercase hex characters")
        if self.queue_dsn is not None and not _QUEUE_ENV.fullmatch(self.queue_env or ""):
            raise CapacityConfigError(f"{QUEUE_ENV_ENV} must be set with {QUEUE_DSN_ENV}: 1-64 of "
                                      "[a-z0-9-], starting with a letter or digit")
        if self.queue_dsn is not None and _dsn_has_password(self.queue_dsn):
            # The login is referenced by its secret's name only (P-084).
            raise CapacityConfigError(f"{QUEUE_DSN_ENV} must not carry a password; name the "
                                      f"login's secret in {QUEUE_LOGIN_SECRET_ENV}")
        if self.queue_login_secret is not None and (
                self.queue_dsn is None or not _SECRET_NAME.fullmatch(self.queue_login_secret)):
            raise CapacityConfigError(f"{QUEUE_LOGIN_SECRET_ENV} must be a secret name "
                                      f"(1-512 of [A-Za-z0-9/_+=.@-]) set with {QUEUE_DSN_ENV}")

    @property
    def large(self) -> bool:
        return self.capacity_class == CLASS_LARGE

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "CapacitySettings":
        env = os.environ if env is None else env
        raw = (env.get(ROUTING_ENV) or "0").strip()
        if raw not in ("0", "1"):
            raise CapacityConfigError(f"{ROUTING_ENV}={raw!r} must be 0 or 1")
        promote = (env.get(PROMOTE_ENV) or "0").strip()
        if promote not in ("0", "1"):
            raise CapacityConfigError(f"{PROMOTE_ENV}={promote!r} must be 0 or 1")
        restage = (env.get(RESTAGE_ENV) or "").strip() or None
        if restage is not None and not _NONCE.fullmatch(restage):
            # Like the readiness alert-test nonce: a malformed operator flag
            # is logged and ignored, never a reason to turn routing off.
            logger.error("%s ignored: it must be 16-64 lowercase hex characters", RESTAGE_ENV)
            restage = None
        return cls(
            routing=raw == "1",
            route_fraction=_number(env, ROUTE_FRACTION_ENV, 0.9, 0.0, 1.0),
            keep_fraction=_number(env, KEEP_FRACTION_ENV, 0.7, 0.0, 1.0),
            large_budget_mb=_optional_number(env, LARGE_BUDGET_ENV, 1.0, 16 * 1024 * 1024),
            resize_s=_number(env, RESIZE_ENV, 3600.0, 0.0, 30 * 86400.0),
            state_path=(env.get(STATE_PATH_ENV) or "").strip() or None,
            capacity_class=(env.get(CLASS_ENV) or "").strip() or CLASS_SMALL,
            queue_dsn=(env.get(QUEUE_DSN_ENV) or "").strip() or None,
            queue_env=(env.get(QUEUE_ENV_ENV) or "").strip() or None,
            queue_login_secret=(env.get(QUEUE_LOGIN_SECRET_ENV) or "").strip() or None,
            promote=promote == "1",
            staged_label=(env.get(STAGED_LABEL_ENV) or "").strip() or DEFAULT_STAGED_LABEL,
            promote_into=(env.get(PROMOTE_INTO_ENV) or "").strip() or None,
            restage=restage,
        )

    @classmethod
    def from_env_or_off(cls, env: Optional[Mapping[str, str]] = None) -> "CapacitySettings":
        """The env settings, or the defaults (routing off) when any is unusable.
        The small class only: ``scripts/math_poller.py`` refuses to start a
        large-class worker whose settings do not parse."""
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
    # The active math_rebuild job for a ``large`` record (P-073 r2), or None.
    job_id: Optional[str] = None
    # Set when the queue refused the record as poisoned (its last jobs died
    # under this source commit): the commit it happened under, so a new
    # deploy asks again and the same one does not. ``job_id`` then names the
    # latest dead job.
    poisoned_commit: Optional[str] = None
    # Wall clock of each job the queue admitted for this record in the last
    # 24 hours (P-084: at most 2 a day per scope; older ones are dropped).
    admitted_ms: List[int] = field(default_factory=list)

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
        if raw.get("job_id") is not None and not isinstance(raw["job_id"], str):
            raise ValueError("bad capacity record field job_id")
        if raw.get("poisoned_commit") is not None and not isinstance(raw["poisoned_commit"], str):
            raise ValueError("bad capacity record field poisoned_commit")
        admitted = raw.get("admitted_ms", [])
        if not isinstance(admitted, list) or not all(_is_count(v) for v in admitted):
            raise ValueError("bad capacity record field admitted_ms")
        if "zid" not in raw or "need_bytes" not in raw or raw.get("disposition") not in DISPOSITIONS:
            raise ValueError("bad capacity record")
        return cls(**{k: raw[k] for k in cls.__dataclass_fields__ if k in raw})


def _is_count(v: Any) -> bool:
    return type(v) is int and v >= 0


_SECRET_NAME = re.compile(r"[A-Za-z0-9/_+=.@-]{1,512}")


def _dsn_has_password(dsn: str) -> bool:
    """True when a libpq DSN (URL or key/value) names a password."""
    try:
        from psycopg2.extensions import parse_dsn

        return bool(parse_dsn(dsn).get("password"))
    except Exception:  # noqa: BLE001 - an unparseable DSN is refused later, at connect
        return False


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
        self.promoted_total = 0
        # P-073 PR3. Routed conversations whose staged bundle covers their
        # input and waits for promotion (set by the promotion pass; not
        # demand). In memory only: the next pass recomputes it.
        self._waiting: set = set()
        # The restage nonce last applied (persisted with the records).
        self.restage_applied: Optional[str] = None
        # The queue's counts of class large (P-073 r2), set by the service
        # once per readiness tick from pq_class_depth; None without a queue.
        self._queue_depth: Optional[Dict[str, Any]] = None
        # P-084: why routing is refused right now (None: it is not). Set by
        # the service: the queue is missing, unproven at start, or its last
        # read failed. While refused the small poller computes as with
        # routing off.
        self._queue_refused: Optional[str] = None
        # P-084: the last admission was refused at the queued-job cap.
        self._queue_full = False
        self._load()

    @property
    def routing(self) -> bool:
        """Routing is on: configured on and not refused (P-084)."""
        return self.settings.routing and self._queue_refused is None

    def set_queue_refused(self, reason: Optional[str]) -> None:
        """Refuse routing for ``reason`` (``queue_dsn_missing``,
        ``source_commit_missing``, ``queue_unproven``,
        ``queue_unreachable``), or None to allow it again."""
        with self._lock:
            self._queue_refused = reason

    @property
    def queue_refused(self) -> Optional[str]:
        return self._queue_refused

    def set_queue_full(self, full: bool) -> None:
        with self._lock:
            self._queue_full = bool(full)

    def admissions_today(self, zid: int) -> int:
        """Jobs the queue admitted for ``zid`` in the last 24 hours."""
        now = self._clock()
        with self._lock:
            rec = self._records.get(zid)
            return 0 if rec is None else sum(1 for t in rec.admitted_ms if now - t < DAY_MS)

    def note_admitted(self, zid: int) -> None:
        """The queue admitted a new job for ``zid`` (outcome ``enqueued``)."""
        now = self._clock()
        with self._lock:
            rec = self._records.get(zid)
            if rec is None:
                return
            rec.admitted_ms = [t for t in rec.admitted_ms if now - t < DAY_MS] + [now]
            self._save_locked()

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
                refused: bool = False, advance: bool = True) -> str:
        """Classify a sized conversation and keep its record. ``sizes`` are its
        (vote rows, voters, comments); without them, ``need`` (bytes above the
        base) classifies it. A ``small`` conversation keeps a record only when
        it was refused; an existing routed record that now classifies small is
        un-routed (removed). ``advance=False`` (a re-size with no new input)
        leaves an existing record's input marks alone. Returns the
        disposition."""
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
                    self._waiting.discard(zid)
                    logger.info("capacity: zid=%s now fits the small class; un-routed", zid)
                    self._save_locked()
                return SMALL
            created = rec is None
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
            if advance or created:
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
            self._waiting.discard(zid)
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
            self._waiting.discard(victim.zid)

    # -- the large class hand-off (P-073 PR3) -------------------------------- #
    def routed_records(self) -> List[Disposition]:
        """Copies of the routed records (``large`` and ``exceeds_largest``),
        by zid."""
        with self._lock:
            return [Disposition(**asdict(r)) for r in sorted(self._records.values(),
                                                             key=lambda r: r.zid)
                    if r.disposition in ROUTED]

    def stale_binding_zids(self) -> List[int]:
        """Routed conversations classified under another binding (a resized
        box, a recalibrated model, changed fractions or large budget): the
        promotion loop re-sizes them without waiting for new input."""
        binding = self.binding()
        with self._lock:
            return sorted(r.zid for r in self._records.values()
                          if r.disposition in ROUTED and r.binding != binding)

    def restore(self, rows: List[Dict[str, Any]], *, binding: str, sized_ms: int) -> int:
        """Routed records given back (rows of zid, need_bytes, exceeds_largest
        and the optional sizes and marks), for zids this process has no
        record of. Returns how many."""
        added = 0
        with self._lock:
            for row in rows:
                zid = row["zid"]
                if zid in self._records:
                    continue
                self._records[zid] = Disposition(
                    zid=zid, disposition=EXCEEDS_LARGEST if row["exceeds_largest"] else LARGE,
                    need_bytes=row["need_bytes"], votes=row.get("votes"),
                    voters=row.get("voters"), comments=row.get("comments"), binding=binding,
                    sized_ms=sized_ms, input_through_ms=row.get("input_through_ms"),
                    first_unresolved_ms=row.get("first_unresolved_ms"))
                added += 1
            if added:
                self._trim_locked()
                self._save_locked()
        return added

    def apply_restage(self, nonce: str, mark_ms: Optional[int] = None) -> int:
        """The operator's restage nonce (``MATH_CAPACITY_RESTAGE``), once per
        value: every ``large`` record gets an input mark of ``mark_ms`` (the
        database clock, which stamps the staged bundle's write time; this
        process's clock when not given), so the promotion pass enqueues a
        fresh rebuild and promotes the result. A record parked as poisoned is
        un-parked by it (the nonce is the operator's ruling: the queue is
        asked again, and answers ``poisoned`` again unless the code image
        changed). Returns how many records were marked (0 when this nonce
        was already applied)."""
        now = self._clock()
        mark = now if mark_ms is None else int(mark_ms)
        with self._lock:
            if self.restage_applied == nonce:
                return 0
            marked = 0
            for rec in self._records.values():
                if rec.disposition != LARGE:
                    continue
                rec.input_through_ms = max(rec.input_through_ms or 0, mark)
                if rec.first_unresolved_ms is None:
                    rec.first_unresolved_ms = now
                rec.poisoned_commit = None
                self._waiting.discard(rec.zid)
                marked += 1
            self.restage_applied = nonce
            self._save_locked()
            return marked

    def settle(self, zid: int, *, waiting: bool, resolved: bool,
               through_ms: Any = "unchecked") -> None:
        """The promotion pass's verdict for one routed conversation: its
        staged bundle covers its input and waits for promotion (not demand),
        and/or the small label already reflects its input (record caught up).
        ``through_ms``: the input mark the verdict was reached on; when the
        record has moved past it since (new input during the pass), the
        verdict is stale and ignored."""
        with self._lock:
            rec = self._records.get(zid)
            if rec is None:
                return
            if through_ms != "unchecked" and rec.input_through_ms != through_ms:
                return
            if waiting and rec.disposition == LARGE:
                self._waiting.add(zid)
            else:
                self._waiting.discard(zid)
            if resolved and rec.first_unresolved_ms is not None:
                rec.first_unresolved_ms = None
                logger.info("capacity: zid=%s caught up through promotion", zid)
                self._save_locked()

    def note_promoted(self) -> None:
        with self._lock:
            self.promoted_total += 1

    # -- the queue (P-073 r2) -------------------------------------------------- #
    def record(self, zid: int) -> Optional[Disposition]:
        """A copy of one record, or None."""
        with self._lock:
            rec = self._records.get(zid)
            return None if rec is None else Disposition(**asdict(rec))

    def set_job(self, zid: int, job_id: Optional[str]) -> None:
        """The math_rebuild job admitted for a routed conversation (a job
        admitted means the record is not poisoned)."""
        with self._lock:
            rec = self._records.get(zid)
            if rec is not None and (rec.job_id != job_id or rec.poisoned_commit is not None):
                rec.job_id = job_id
                rec.poisoned_commit = None
                self._save_locked()

    def park_poisoned(self, zid: int, job_id: Optional[str], source_commit: Optional[str]) -> None:
        """The queue refused the record as poisoned under ``source_commit``:
        parked with the reason; ``job_id`` is the latest dead job."""
        with self._lock:
            rec = self._records.get(zid)
            if rec is None:
                return
            rec.job_id = job_id
            rec.poisoned_commit = source_commit or "unknown"
            self._save_locked()

    def poisoned(self, zid: int, source_commit: Optional[str]) -> bool:
        """Parked as poisoned under this very source commit (a new deploy
        asks the queue again)."""
        with self._lock:
            rec = self._records.get(zid)
            return (rec is not None and rec.poisoned_commit is not None
                    and rec.poisoned_commit == (source_commit or "unknown"))

    def set_queue_depth(self, depth: Optional[Dict[str, Any]]) -> None:
        """The queue's counts of class large for this tick (000024's
        ``queued`` and ``leased``), or None when there is no queue or the read
        failed."""
        with self._lock:
            self._queue_depth = None if depth is None else dict(depth)


    # -- the demand ---------------------------------------------------------- #
    def counts(self) -> Dict[str, Any]:
        """The closed counts (COUNT_KEYS) for the capacity and readiness lines."""
        now = self._clock()
        with self._lock:
            recs = list(self._records.values())
            waiting = set(self._waiting)
            refusals, routed = self.refusals_total, self.routed_total
            promoted = self.promoted_total
            depth = self._queue_depth
            queue_full, refused = self._queue_full, self._queue_refused
        unresolved = [r for r in recs
                      if r.disposition == LARGE and r.first_unresolved_ms is not None]
        # Demand: unresolved and no staged bundle already waiting for
        # promotion (that needs the small poller, not a large instance).
        demand = [r for r in unresolved if r.zid not in waiting]
        oldest = min((r.first_unresolved_ms for r in unresolved
                      if r.first_unresolved_ms is not None), default=None)
        # With a queue, demand and leased are the queue's counts of class
        # large (000024: queued = queued + retry_wait, leased = running,
        # parked = parked); without one, demand is the records' count as
        # before and leased and parked are unknown (null, never 0). Poisoned records are parked here, so they
        # are neither demand nor pending promotion.
        return {
            "rev": CAPACITY_REV,
            "routing": int(self.settings.routing),
            "large_demand": len(demand) if depth is None else int(depth["queued"]),
            "large_leased": None if depth is None else int(depth["leased"]),
            "large_parked": None if depth is None else int(depth["parked"]),
            "large_poisoned": sum(1 for r in recs
                                  if r.disposition == LARGE and r.poisoned_commit is not None),
            "pending_promotion": sum(1 for r in unresolved if r.zid in waiting),
            "exceeds_largest": sum(1 for r in recs if r.disposition == EXCEEDS_LARGEST),
            "fits_small": sum(1 for r in recs if r.disposition == SMALL),
            "oldest_unresolved_age_ms": None if oldest is None else max(0, now - oldest),
            "refusals_total": refusals,
            "routed_total": routed,
            "promoted_total": promoted,
            "queue_full": int(queue_full),
            "queue_unreachable": int(self.settings.routing and refused is not None),
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
            restage = raw.get("restage_applied")
            if restage is not None and not (isinstance(restage, str)
                                            and _NONCE.fullmatch(restage)):
                restage = None
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
        self.restage_applied = restage
        logger.info("capacity: restored %d records", len(self._records))

    def _save_locked(self) -> None:
        path = self.settings.state_path
        if not path:
            return
        body = {"schema": STATE_SCHEMA, "written_ms": self._clock(),
                "restage_applied": self.restage_applied,
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


def build_line(role: str, label: str, counts: Optional[Dict[str, Any]], *,
               klass: str = CLASS_SMALL) -> str:
    """The capacity line for one readiness tick. ``counts`` None (a standby,
    or no service yet): null counts, which no metric filter turns into 0.
    ``klass`` selects the key set: the small poller's demand counts, or the
    large worker's (LARGE_COUNT_KEYS)."""
    keys = LARGE_COUNT_KEYS if klass == CLASS_LARGE else COUNT_KEYS
    body: Dict[str, Any] = {"schema": LINE_SCHEMA, "class": klass, "role": role,
                            "label": label}
    if klass != CLASS_LARGE:
        body["rev"] = CAPACITY_REV
    for k in keys:
        body[k] = None if counts is None else counts.get(k)
    return json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _count(v: Any, nullable: bool) -> None:
    if v is None and nullable:
        return
    if type(v) is not int or v < 0:
        raise ValueError("expected a non-negative integer")


_FORWARD_KEY = re.compile(r"[a-z][a-z0-9_]{0,63}\Z")


def keys_through(rev: int) -> Tuple[str, ...]:
    """The count keys a line of revision ``rev`` carries (up to this
    decoder's own revision)."""
    out: Tuple[str, ...] = ()
    for r in sorted(CAPACITY_REV_KEYS):
        if r <= rev:
            out += CAPACITY_REV_KEYS[r]
    return out


def decode_counts(counts: Any, *, nullable: bool = False) -> Dict[str, Any]:
    """The counts object (readiness ``capacity`` and the line's fields) of any
    revision from 1 to ``CAPACITY_REV + REV_FORWARD``, validated, as this
    decoder's closed shape: every key of COUNT_KEYS (null where the line's
    older revision lacks it) plus ``rev``. Keys a newer revision declared are
    validated as counts and dropped."""
    if not isinstance(counts, dict):
        raise ValueError("expected an object")
    if "rev" in counts:
        rev = counts["rev"]
    else:
        keys = set(counts)
        rev = next((r for r in UNREVISIONED if set(keys_through(r)) == keys), UNREVISIONED[-1])
    if type(rev) is not int or not 1 <= rev <= CAPACITY_REV + REV_FORWARD:
        raise ValueError(f"capacity revision must be 1..{CAPACITY_REV + REV_FORWARD}")
    expected = keys_through(rev)
    have = set(counts) - {"rev"}
    missing = set(expected) - have
    if missing:
        raise ValueError(f"revision {rev} lacks {sorted(missing)}")
    extra = have - set(expected)
    if extra and rev <= CAPACITY_REV:
        raise ValueError(f"revision {rev} does not declare {sorted(extra)}")
    for k in extra:
        if not _FORWARD_KEY.match(k):
            raise ValueError("bad key")
        _count(counts[k], True)
    for k in expected:
        _count(counts[k], nullable or k in NULLABLE_COUNT_KEYS)
    if counts["routing"] not in (None, 0, 1):
        raise ValueError("routing must be 0 or 1")
    out: Dict[str, Any] = {"rev": rev}
    for k in COUNT_KEYS:
        out[k] = counts.get(k)
    return out


def validate_counts(counts: Any, *, nullable: bool = False) -> None:
    """The counts object (readiness ``capacity`` and the line's fields), of
    any revision ``decode_counts`` reads."""
    decode_counts(counts, nullable=nullable)


def validate_large_counts(counts: Any, *, nullable: bool = False) -> None:
    """The large worker's closed counts."""
    if not isinstance(counts, dict) or set(counts) != set(LARGE_COUNT_KEYS):
        raise ValueError(f"expected keys {sorted(LARGE_COUNT_KEYS)}")
    for k in LARGE_COUNT_KEYS:
        if k == "refusal":
            if counts[k] is not None and counts[k] not in REFUSALS:
                raise ValueError("bad refusal label")
            continue
        _count(counts[k], nullable)
    if counts["skew"] not in (None, 0, 1):
        raise ValueError("skew must be 0 or 1")


def parse_line(line: str) -> Optional[Dict[str, Any]]:
    """A capacity line's body, validated; None for any other line."""
    text = line.strip()
    if not text.startswith("{") or LINE_SCHEMA not in text:
        return None
    body = json.loads(text)
    if not isinstance(body, dict) or body.get("schema") != LINE_SCHEMA:
        return None
    if body.get("class") not in CLASSES or body.get("role") not in ("primary", "standby"):
        raise ValueError("bad class or role")
    large = body["class"] == CLASS_LARGE
    if not isinstance(body.get("label"), str):
        raise ValueError("bad label")
    nullable = body["role"] != "primary"
    if large:
        if set(body) != set(LARGE_LINE_KEYS):
            raise ValueError(f"expected keys {sorted(LARGE_LINE_KEYS)}")
        validate_large_counts({k: body[k] for k in LARGE_COUNT_KEYS}, nullable=nullable)
        return body
    head = {k: body[k] for k in ("schema", "class", "role", "label")}
    counts = {k: v for k, v in body.items() if k not in head}
    return {**head, **decode_counts(counts, nullable=nullable)}


__all__ = [
    "CAPACITY_REV", "CAPACITY_REV_KEYS", "CLASS_LARGE", "CLASS_SMALL", "COUNT_KEYS",
    "CapacityConfigError", "CapacityRouter", "REV_FORWARD", "UNREVISIONED", "decode_counts",
    "keys_through",
    "CapacitySettings", "DISPOSITIONS", "Disposition", "EXCEEDS_LARGEST", "LARGE",
    "LARGE_COUNT_KEYS", "LARGE_LINE_KEYS", "LINE_KEYS", "LINE_SCHEMA", "NULLABLE_COUNT_KEYS",
    "REFUSALS", "SMALL", "build_line", "emit_line", "parse_line", "validate_counts",
    "validate_large_counts",
]
