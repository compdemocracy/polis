"""Pre-switch backfill (P-070): bounded, low-priority background rebuilds
inside the admitted math poller.

The poller computes a conversation only when it sees a vote or a moderation
change after its boot lookback (POLL_FROM_DAYS_AGO), so a conversation that is
dormant never gets a row under the poller's label. Before readers switch
labels, every conversation that has a row under the SOURCE label (Clojure's
``prod``) must have a coherent publication under the poller's own label. This
module finds those conversations and feeds them, one at a time by default,
into the poller's own per-zid worker pool as ``BACKFILL`` messages. It runs in
the poller process because that process already holds the label's
single-writer lock: nothing here opens a second writer.

What a backfill job does (``BackfillScheduler.run_job``, on a pool thread):
  1. re-reads the target's state; a coherent, caught-up publication is a no-op;
  2. rebuilds the conversation exactly as the poller's first touch does
     (``MathPollerService._load_or_init``: full vote history in engine order,
     full moderation state, recompute), but does NOT put it in the LRU cache;
  3. publishes through the poller's ``MathWriter`` (tick + three payload tables
     in one transaction). Inside that transaction, right after the tick upsert
     has locked ``(zid, label)``, it re-reads the target ``math_main`` row; if
     it differs from what step 1 saw, live ingestion published first and the
     backfill rolls back (the tie rule: the live write wins);
  4. verifies the postcondition (all four generations equal, the published
     ``last_vote_timestamp`` not behind the source row's) before counting it.

Selection: every source conversation whose target publication is MISSING,
INCOMPLETE (a missing companion or ``math_ticks`` row, or unequal generations)
or STALE (its last vote timestamp behind the source's, beyond a grace window).
Pages are keyset-ordered largest first (participant count, then zid) and
bounded; a finished sweep starts again from the top after a pause, so earlier
failures and new source rows are picked up. The database is the progress
record; the optional state file only carries retry/backoff, the gate, manual
pause and the report tables across a restart.

Priority and budgets: a job is admitted only when live ingestion has nothing
queued or running, the live vote poll is healthy (recent success, mean latency
under a ceiling), the pacing interval has passed (minimum interval, a duty
cycle on compute time, an extra rest after a large conversation), the rolling
vote-read budget allows it, and the memory model says it fits under the
ceiling beside the process's current RSS. A conversation above the size
threshold runs only when no other backfill job is in flight, and nothing else
is admitted while it runs. Refusals never truncate input and never count as
done. A conversation whose estimated peak alone exceeds the ceiling is
excluded until a larger ceiling is configured (reported in every sweep
summary); one that only lacks headroom beside the live cache is retried on a
later sweep.

Memory model (02-findings/python-engine-memory-scaling.md): a standalone
rebuild peaks at about 209 MiB + 116 MiB per million voter x comment cells;
the estimate is that times a 1.15 safety factor, against a 4500 MiB ceiling
for the 6g poller container. A backfilled conversation is never kept in the
live LRU cache.

Operator controls (see cost-reduction/04-plans/P-070-math-backfill.md): the
MATH_BACKFILL_* environment (read at start), SIGUSR1 to approve the gate after
the N largest, SIGUSR2 to pause or resume.
"""

from __future__ import annotations

import ctypes
import gc
import hashlib
import json
import logging
import math
import os
import resource
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

from sqlalchemy import text

logger = logging.getLogger(__name__)

_MB = 1024 * 1024

# --------------------------------------------------------------------------- #
# Vocabulary
# --------------------------------------------------------------------------- #
MISSING = "missing"
INCOMPLETE = "incomplete"
STALE = "stale"

PUBLISHED = "published"
SUPERSEDED_LIVE = "superseded_live"
ALREADY_COMPLETE = "already_complete"
LIVE_OWNED = "live_owned"
PARKED_LIVE = "parked_live"
OVER_MEMORY_CEILING = "over_memory_ceiling"
MEMORY_HEADROOM = "memory_headroom"
REFUSED_INPUT_SIZE = "refused_input_size"
FAILED_COMPUTE = "failed_compute"
FAILED_WRITE = "failed_write"
FAILED_POSTCONDITION = "failed_postcondition"
SOURCE_AHEAD = "source_ahead"
LOST = "lost"

# Counted as done for this conversation.
COMPLETE_OUTCOMES = frozenset({PUBLISHED, SUPERSEDED_LIVE, ALREADY_COMPLETE})
# Retried with exponential backoff; each one spends an attempt.
FAILED_OUTCOMES = frozenset({FAILED_COMPUTE, FAILED_WRITE, FAILED_POSTCONDITION, LOST})
# Deferred to a later sweep without spending an attempt.
DEFERRED_OUTCOMES = frozenset({MEMORY_HEADROOM, LIVE_OWNED, PARKED_LIVE})
# Never retried automatically; needs an explicit disposition (a larger-budget
# run for the refusals, a ruling for SOURCE_AHEAD).
EXCLUDED_OUTCOMES = frozenset({SOURCE_AHEAD, OVER_MEMORY_CEILING, REFUSED_INPUT_SIZE})
ALL_OUTCOMES = COMPLETE_OUTCOMES | FAILED_OUTCOMES | DEFERRED_OUTCOMES | EXCLUDED_OUTCOMES

EXHAUSTED = "exhausted"


class ConfigError(ValueError):
    """A MATH_BACKFILL_* value is unusable; the backfill stays off."""


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class BackfillConfig:
    """Backfill settings. Every field has a MATH_BACKFILL_* variable
    (``_ENV_NAMES``); ``from_env`` validates them all."""

    enabled: bool = False
    source_env: str = "prod"
    concurrency: int = 1
    large_threshold: int = 2000          # participants; above this, run alone
    gate_after_largest: int = 10          # 0 = no gate
    gate_approved: bool = False
    # Estimated peak = safety x (base + per_mcell x cells/1e6 + per_vote x votes)
    # MiB, cells = voters x comments. Defaults are the local measurement in
    # 02-findings/python-engine-memory-scaling.md (209 MiB base, 110-116 MiB
    # per million cells on a 5.5%-dense fixture). The vote term is 0 because
    # that fixture's vote lists are inside the per-cell figure; a denser real
    # conversation carries ~400 B per extra vote, which the gate's measured
    # peak_over_est ratio exposes.
    memory_ceiling_mb: float = 4500.0     # for the 6g poller container
    mem_base_mb: float = 209.0
    mem_per_mcell_mb: float = 116.0
    mem_per_vote_bytes: float = 0.0
    mem_safety: float = 1.15
    max_votes: int = 10_000_000           # per-conversation input refusal
    min_interval_s: float = 3.0
    large_sleep_s: float = 30.0
    duty_cycle: float = 0.5               # share of wall time spent computing
    max_votes_per_min: int = 2_000_000    # rolling read budget
    pause_poll_ms: float = 1000.0         # live vote-poll mean latency ceiling
    telemetry_stale_s: float = 60.0       # no live poll success for this long
    page_size: int = 50
    resweep_s: float = 300.0
    stale_grace_s: float = 3600.0
    max_attempts: int = 5
    retry_base_s: float = 60.0
    retry_cap_s: float = 21600.0
    refusal_backoff_s: float = 1800.0
    summary_every: int = 25
    query_timeout_ms: int = 30000
    state_path: Optional[str] = None

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        if not self.source_env.strip():
            raise ConfigError("MATH_BACKFILL_SOURCE_ENV must not be empty")
        positive_ints = {
            "concurrency": self.concurrency, "page_size": self.page_size,
            "max_attempts": self.max_attempts, "summary_every": self.summary_every,
            "max_votes": self.max_votes, "max_votes_per_min": self.max_votes_per_min,
            "query_timeout_ms": self.query_timeout_ms,
        }
        for name, value in positive_ints.items():
            if int(value) < 1:
                raise ConfigError(f"{name} must be >= 1, got {value}")
        if self.large_threshold < 0 or self.gate_after_largest < 0:
            raise ConfigError("large_threshold and gate_after_largest must be >= 0")
        non_negative = {
            "mem_base_mb": self.mem_base_mb,
            "mem_per_vote_bytes": self.mem_per_vote_bytes,
            "mem_per_mcell_mb": self.mem_per_mcell_mb,
            "min_interval_s": self.min_interval_s, "large_sleep_s": self.large_sleep_s,
            "pause_poll_ms": self.pause_poll_ms, "telemetry_stale_s": self.telemetry_stale_s,
            "resweep_s": self.resweep_s, "stale_grace_s": self.stale_grace_s,
            "retry_base_s": self.retry_base_s, "retry_cap_s": self.retry_cap_s,
            "refusal_backoff_s": self.refusal_backoff_s,
        }
        for name, value in non_negative.items():
            if not (math.isfinite(value) and value >= 0):
                raise ConfigError(f"{name} must be a finite number >= 0, got {value}")
        if not (math.isfinite(self.duty_cycle) and 0 < self.duty_cycle <= 1):
            raise ConfigError(f"duty_cycle must be in (0, 1], got {self.duty_cycle}")
        if not (math.isfinite(self.mem_safety) and self.mem_safety >= 1):
            raise ConfigError(f"mem_safety must be >= 1, got {self.mem_safety}")
        if not (math.isfinite(self.memory_ceiling_mb) and self.memory_ceiling_mb > 0):
            raise ConfigError(
                f"memory_ceiling_mb must be a finite number > 0, got {self.memory_ceiling_mb}"
            )

    def digest(self) -> str:
        """Short, stable binding of the settings for the report lines."""
        payload = json.dumps(asdict(self), sort_keys=True, default=str)
        return hashlib.sha256(payload.encode()).hexdigest()[:12]

    @classmethod
    def from_env(cls, environ: Optional[Dict[str, str]] = None) -> "BackfillConfig":
        env = os.environ if environ is None else environ
        kwargs: Dict[str, Any] = {}
        for f in fields(cls):
            raw = env.get(_ENV_NAMES[f.name])
            if raw is None or raw.strip() == "":
                continue
            raw = raw.strip()
            try:
                if f.name in ("enabled", "gate_approved"):
                    kwargs[f.name] = raw.lower() in ("1", "true", "yes", "on")
                elif f.name in ("source_env", "state_path"):
                    kwargs[f.name] = raw
                elif f.type in ("int",):
                    kwargs[f.name] = int(raw)
                else:
                    kwargs[f.name] = float(raw)
            except ValueError as exc:
                raise ConfigError(f"{_ENV_NAMES[f.name]}={raw!r}: {exc}") from None
        return cls(**kwargs)


_ENV_NAMES = {
    "enabled": "MATH_BACKFILL",
    "source_env": "MATH_BACKFILL_SOURCE_ENV",
    "concurrency": "MATH_BACKFILL_CONCURRENCY",
    "large_threshold": "MATH_BACKFILL_LARGE_THRESHOLD",
    "gate_after_largest": "MATH_BACKFILL_GATE_AFTER_LARGEST",
    "gate_approved": "MATH_BACKFILL_GATE_APPROVED",
    "memory_ceiling_mb": "MATH_BACKFILL_MEMORY_CEILING_MB",
    "mem_base_mb": "MATH_BACKFILL_MEM_BASE_MB",
    "mem_per_mcell_mb": "MATH_BACKFILL_MEM_PER_MCELL_MB",
    "mem_per_vote_bytes": "MATH_BACKFILL_MEM_PER_VOTE_BYTES",
    "mem_safety": "MATH_BACKFILL_MEM_SAFETY",
    "max_votes": "MATH_BACKFILL_MAX_VOTES",
    "min_interval_s": "MATH_BACKFILL_MIN_INTERVAL_S",
    "large_sleep_s": "MATH_BACKFILL_LARGE_SLEEP_S",
    "duty_cycle": "MATH_BACKFILL_DUTY_CYCLE",
    "max_votes_per_min": "MATH_BACKFILL_MAX_VOTES_PER_MIN",
    "pause_poll_ms": "MATH_BACKFILL_PAUSE_POLL_MS",
    "telemetry_stale_s": "MATH_BACKFILL_TELEMETRY_STALE_S",
    "page_size": "MATH_BACKFILL_PAGE_SIZE",
    "resweep_s": "MATH_BACKFILL_RESWEEP_S",
    "stale_grace_s": "MATH_BACKFILL_STALE_GRACE_S",
    "max_attempts": "MATH_BACKFILL_MAX_ATTEMPTS",
    "retry_base_s": "MATH_BACKFILL_RETRY_BASE_S",
    "retry_cap_s": "MATH_BACKFILL_RETRY_CAP_S",
    "refusal_backoff_s": "MATH_BACKFILL_REFUSAL_BACKOFF_S",
    "summary_every": "MATH_BACKFILL_SUMMARY_EVERY",
    "query_timeout_ms": "MATH_BACKFILL_QUERY_TIMEOUT_MS",
    "state_path": "MATH_BACKFILL_STATE_PATH",
}
ENV_NAMES = dict(_ENV_NAMES)


# --------------------------------------------------------------------------- #
# Memory
# --------------------------------------------------------------------------- #
def read_rss_bytes() -> int:
    """Current resident set size of this process. Linux reads /proc; elsewhere
    the lifetime peak from getrusage is the best available stand-in."""
    try:
        with open("/proc/self/statm") as fh:
            return int(fh.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(peak if sys.platform == "darwin" else peak * 1024)


def read_cgroup_limit_bytes() -> Optional[int]:
    """The container's memory limit (cgroup v2, then v1), or None."""
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(path) as fh:
                raw = fh.read().strip()
        except OSError:
            continue
        if raw == "max":
            return None
        try:
            value = int(raw)
        except ValueError:
            continue
        if 0 < value < (1 << 60):
            return value
    return None


def release_memory() -> None:
    """Return freed heap to the OS after a large rebuild (glibc only)."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass


@dataclass(frozen=True)
class MemoryModel:
    """Size -> peak RSS of one standalone rebuild (base included).
    Coefficients come from MATH_BACKFILL_MEM_*; the gate reports measured
    peaks against this estimate so an operator can recalibrate."""

    base_mb: float
    per_mcell_mb: float
    per_vote_bytes: float
    safety: float

    def estimate_bytes(self, votes: int, voters: int, comments: int) -> int:
        cells = voters * comments
        raw = (
            self.base_mb * _MB
            + self.per_mcell_mb * _MB * cells / 1e6
            + self.per_vote_bytes * votes
        )
        return int(self.safety * raw)

    def above_base_bytes(self, votes: int, voters: int, comments: int) -> int:
        """What the rebuild adds to a process that already has its base."""
        return max(0, self.estimate_bytes(votes, voters, comments)
                   - int(self.safety * self.base_mb * _MB))


class PeakSampler:
    """Samples RSS on a background thread while a job runs; reports the peak."""

    def __init__(self, rss_fn: Callable[[], int], interval_s: float = 0.2) -> None:
        self._rss_fn = rss_fn
        self._interval = interval_s
        self._peak = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def __enter__(self) -> "PeakSampler":
        self._peak = self._rss_fn()
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="backfill-rss", daemon=True)
        self._thread.start()
        return self

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            self._peak = max(self._peak, self._rss_fn())

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._peak = max(self._peak, self._rss_fn())

    @property
    def peak(self) -> int:
        return self._peak


# --------------------------------------------------------------------------- #
# Database access
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Target:
    zid: int
    participants: int
    klass: str
    source_lvt: Optional[int]
    # The target math_main row as seen when classified: (math_tick,
    # last_vote_timestamp), or None when there was no row.
    fingerprint: Optional[Tuple[int, int]]


def classify(row: Dict[str, Any], stale_cutoff_ms: int) -> Optional[str]:
    """MISSING / INCOMPLETE / STALE, or None when the target is coherent and
    caught up. ``row`` carries main_zid, main_tick, bid_tick, stats_tick,
    ticks_tick, target_lvt and source_lvt (see ``_STATE_COLUMNS``)."""
    if row.get("main_zid") is None:
        return MISSING
    ticks = [row.get("main_tick"), row.get("bid_tick"), row.get("stats_tick"), row.get("ticks_tick")]
    if any(t is None for t in ticks) or len(set(ticks)) != 1:
        return INCOMPLETE
    source_lvt, target_lvt = row.get("source_lvt"), row.get("target_lvt")
    if (
        source_lvt is not None and target_lvt is not None
        and target_lvt < source_lvt and source_lvt < stale_cutoff_ms
    ):
        return STALE
    return None


def _fingerprint(row: Dict[str, Any]) -> Optional[Tuple[int, int]]:
    if row.get("main_zid") is None:
        return None
    return (int(row["main_tick"]), int(row["target_lvt"]))


_STATE_COLUMNS = """
    s.zid AS zid,
    COALESCE(c.participant_count, 0) AS participants,
    s.last_vote_timestamp AS source_lvt,
    m.zid AS main_zid,
    m.math_tick AS main_tick,
    m.last_vote_timestamp AS target_lvt,
    b.math_tick AS bid_tick,
    p.math_tick AS stats_tick,
    k.math_tick AS ticks_tick
"""

_STATE_JOINS = """
    FROM math_main s
    LEFT JOIN conversations c ON c.zid = s.zid
    LEFT JOIN math_main m ON m.zid = s.zid AND m.math_env = :target
    LEFT JOIN math_bidtopid b ON b.zid = s.zid AND b.math_env = :target
    LEFT JOIN math_ptptstats p ON p.zid = s.zid AND p.math_env = :target
    LEFT JOIN math_ticks k ON k.zid = s.zid AND k.math_env = :target
"""

_NEEDS_WORK = """
    (m.zid IS NULL OR b.zid IS NULL OR p.zid IS NULL OR k.zid IS NULL
     OR m.math_tick <> b.math_tick OR m.math_tick <> p.math_tick
     OR m.math_tick <> k.math_tick
     OR (m.last_vote_timestamp < s.last_vote_timestamp
         AND s.last_vote_timestamp < :stale_cutoff))
"""

PAGE_SQL = (
    "SELECT" + _STATE_COLUMNS + _STATE_JOINS
    + " WHERE s.math_env = :source AND" + _NEEDS_WORK
    + """ AND (COALESCE(c.participant_count, 0) < :after_p
          OR (COALESCE(c.participant_count, 0) = :after_p AND s.zid > :after_zid))
    ORDER BY COALESCE(c.participant_count, 0) DESC, s.zid ASC
    LIMIT :limit"""
)

STATE_SQL = (
    "SELECT" + _STATE_COLUMNS + _STATE_JOINS
    + " WHERE s.math_env = :source AND s.zid = :zid"
)

# Uses votes_zid_pid_idx and comments_zid_idx (by zid, never by created).
SIZES_SQL = """
    SELECT
        (SELECT count(*) FROM votes WHERE zid = :zid) AS votes,
        (SELECT count(DISTINCT pid) FROM votes WHERE zid = :zid) AS voters,
        (SELECT count(*) FROM comments WHERE zid = :zid) AS comments
"""

FINGERPRINT_SQL = """
    SELECT math_tick, last_vote_timestamp FROM math_main
    WHERE zid = :zid AND math_env = :target
"""

LABEL_COUNTS_SQL = (
    """SELECT
        count(*) AS source_rows,
        count(m.zid) AS target_main_rows,
        count(*) FILTER (WHERE m.zid IS NULL) AS missing,
        count(*) FILTER (WHERE m.zid IS NOT NULL AND NOT (
            b.zid IS NOT NULL AND p.zid IS NOT NULL AND k.zid IS NOT NULL
            AND m.math_tick = b.math_tick AND m.math_tick = p.math_tick
            AND m.math_tick = k.math_tick)) AS incomplete,
        count(*) FILTER (WHERE m.last_vote_timestamp < s.last_vote_timestamp
                         AND s.last_vote_timestamp < :stale_cutoff) AS stale"""
    + _STATE_JOINS
    + " WHERE s.math_env = :source"
)


class BackfillStore:
    """The backfill's SQL. Every statement runs under a statement timeout."""

    def __init__(self, pg: Any, source_env: str, target_env: str, query_timeout_ms: int) -> None:
        self._pg = pg
        self._source = source_env
        self._target = target_env
        self._timeout_ms = int(query_timeout_ms)

    def _rows(self, sql: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        with self._pg.transaction() as conn:
            conn.execute(text(f"SET LOCAL statement_timeout = {self._timeout_ms}"))
            result = conn.execute(text(sql), params)
            return [dict(r) for r in result.mappings().all()]

    def _params(self, **extra: Any) -> Dict[str, Any]:
        return {"source": self._source, "target": self._target, **extra}

    def page(
        self, after: Optional[Tuple[int, int]], limit: int, stale_cutoff_ms: int,
    ) -> List[Tuple[Target, Dict[str, Any]]]:
        """The next keyset page, largest first. ``after`` is the last
        (participants, zid) of the previous page, None for the first."""
        after_p, after_zid = after if after is not None else (2**31, -1)
        rows = self._rows(PAGE_SQL, self._params(
            after_p=after_p, after_zid=after_zid, limit=limit,
            stale_cutoff=stale_cutoff_ms,
        ))
        page = []
        for row in rows:
            klass = classify(row, stale_cutoff_ms)
            if klass is None:  # pragma: no cover - the SQL already filtered it
                continue
            page.append((Target(
                zid=int(row["zid"]), participants=int(row["participants"]),
                klass=klass, source_lvt=row["source_lvt"],
                fingerprint=_fingerprint(row),
            ), row))
        return page

    def state(self, zid: int, stale_cutoff_ms: int) -> Optional[Tuple[Optional[str], Target]]:
        """(class or None when nothing is needed, target) for one zid; None
        when the zid no longer has a source row."""
        rows = self._rows(STATE_SQL, self._params(zid=zid))
        if not rows:
            return None
        row = rows[0]
        klass = classify(row, stale_cutoff_ms)
        return klass, Target(
            zid=int(row["zid"]), participants=int(row["participants"]),
            klass=klass or "", source_lvt=row["source_lvt"],
            fingerprint=_fingerprint(row),
        )

    def coherent(self, zid: int) -> Tuple[bool, Optional[int], Optional[int]]:
        """(all four generations equal, the generation, target last vote ts)."""
        rows = self._rows(STATE_SQL, self._params(zid=zid))
        if not rows or rows[0].get("main_zid") is None:
            return False, None, None
        row = rows[0]
        ticks = {row["main_tick"], row["bid_tick"], row["stats_tick"], row["ticks_tick"]}
        ok = None not in ticks and len(ticks) == 1
        return ok, row["main_tick"], row["target_lvt"]

    def sizes(self, zid: int) -> Tuple[int, int, int]:
        row = self._rows(SIZES_SQL, {"zid": zid})[0]
        return int(row["votes"]), int(row["voters"]), int(row["comments"])

    def fingerprint_in(self, connection: Any, zid: int) -> Optional[Tuple[int, int]]:
        """The target math_main row read on the publication's own connection."""
        row = connection.execute(
            text(FINGERPRINT_SQL), {"zid": zid, "target": self._target}
        ).mappings().first()
        if row is None:
            return None
        return (int(row["math_tick"]), int(row["last_vote_timestamp"]))

    def label_counts(self, stale_cutoff_ms: int) -> Dict[str, int]:
        row = self._rows(LABEL_COUNTS_SQL, self._params(stale_cutoff=stale_cutoff_ms))[0]
        return {k: int(v) for k, v in row.items()}


# --------------------------------------------------------------------------- #
# Persistent state (optional)
# --------------------------------------------------------------------------- #
@dataclass
class Record:
    zid: int
    klass: str
    outcome: str
    participants: int = 0
    voters: int = 0
    votes: int = 0
    comments: int = 0
    seconds: float = 0.0
    peak_rss_delta_mb: float = 0.0
    est_mb: float = 0.0
    result_bytes: int = 0


@dataclass
class BackfillState:
    """Carried across restarts when MATH_BACKFILL_STATE_PATH is set. The
    database stays authoritative for what is done; losing this file only
    re-arms the gate, resets backoff and forgets the report tables."""

    source_env: str = ""
    target_env: str = ""
    gate_published: int = 0
    gate_approved: bool = False
    gate_records: List[Dict[str, Any]] = field(default_factory=list)
    paused: bool = False
    # zid (str) -> {"attempts", "next_at", "reason"}; reason EXHAUSTED or an
    # excluded outcome means "no automatic retry".
    failures: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    totals: Dict[str, int] = field(default_factory=dict)
    top_seconds: List[Dict[str, Any]] = field(default_factory=list)
    top_memory: List[Dict[str, Any]] = field(default_factory=list)

    @classmethod
    def load(cls, path: Optional[str], source_env: str, target_env: str) -> "BackfillState":
        fresh = cls(source_env=source_env, target_env=target_env)
        if not path:
            return fresh
        try:
            with open(path) as fh:
                raw = json.load(fh)
        except FileNotFoundError:
            return fresh
        except (OSError, ValueError) as exc:
            logger.warning("math-backfill: state file unreadable (%s); starting fresh",
                           exc.__class__.__name__)
            return fresh
        if raw.get("source_env") != source_env or raw.get("target_env") != target_env:
            logger.warning("math-backfill: state file is for other labels; starting fresh")
            return fresh
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in raw.items() if k in known})

    def save(self, path: Optional[str]) -> None:
        if not path:
            return
        tmp = f"{path}.tmp"
        try:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(tmp, "w") as fh:
                json.dump(asdict(self), fh, sort_keys=True)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        except OSError as exc:
            logger.warning("math-backfill: could not save state (%s)", exc.__class__.__name__)


def _top10(rows: List[Dict[str, Any]], rec: Record, key: str) -> List[Dict[str, Any]]:
    rows = [r for r in rows if r.get("zid") != rec.zid] + [asdict(rec)]
    rows.sort(key=lambda r: (-float(r.get(key, 0.0)), int(r["zid"])))
    return rows[:10]


# --------------------------------------------------------------------------- #
# Scheduler
# --------------------------------------------------------------------------- #
class _Superseded(Exception):
    """Raised inside the publication transaction: live published first."""


@dataclass
class _Job:
    target: Target
    votes: int
    voters: int
    comments: int
    est_bytes: int
    large: bool


class BackfillScheduler:
    """Admits backfill jobs into the poller's pool and records their outcomes.

    ``host`` is the poller's adapter (``service._BackfillHost``): submit,
    pending_zids, is_pending, is_cached, evict, accepts, load_full_history,
    writer, live_poll_health, target_env.
    """

    def __init__(
        self,
        host: Any,
        store: BackfillStore,
        config: BackfillConfig,
        *,
        clock: Callable[[], float] = time.time,
        rss_fn: Callable[[], int] = read_rss_bytes,
        cgroup_limit_fn: Callable[[], Optional[int]] = read_cgroup_limit_bytes,
        release_fn: Callable[[], None] = release_memory,
    ) -> None:
        self._host = host
        self._store = store
        self.config = config
        self._clock = clock
        self._rss = rss_fn
        self._release = release_fn
        self._model = MemoryModel(config.mem_base_mb, config.mem_per_mcell_mb,
                                  config.mem_per_vote_bytes, config.mem_safety)
        self.ceiling_bytes = int(config.memory_ceiling_mb * _MB)
        limit = cgroup_limit_fn()
        if limit is not None and self.ceiling_bytes >= limit:
            raise ConfigError(
                f"MATH_BACKFILL_MEMORY_CEILING_MB={config.memory_ceiling_mb:g} is not "
                f"below the container limit ({limit / _MB:.0f} MiB)"
            )
        self.run_id = uuid.uuid4().hex[:12]
        self._lock = threading.RLock()
        self._state = BackfillState.load(config.state_path, config.source_env, host.target_env)
        self._in_flight: Dict[int, _Job] = {}
        self._buffer: Deque[Target] = deque()
        self._cursor: Optional[Tuple[int, int]] = None
        self._sweep_no = 0
        self._sweep_admitted = 0
        self._sweep_deferred = 0
        self._sweep_seen = 0
        self._next_admit_at = 0.0
        self._next_sweep_at = 0.0
        self._vote_window: Deque[Tuple[float, int]] = deque()
        self._done_since_summary = 0
        self._pressure_paused: Optional[str] = None
        self._gate_logged = False
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- operator controls ------------------------------------------------- #
    def approve_gate(self) -> None:
        with self._lock:
            self._state.gate_approved = True
            self._state.save(self.config.state_path)
        logger.warning("math-backfill: gate APPROVED (run=%s); continuing", self.run_id)

    def toggle_pause(self) -> bool:
        with self._lock:
            self._state.paused = not self._state.paused
            paused = self._state.paused
            self._state.save(self.config.state_path)
        logger.warning("math-backfill: %s by operator (run=%s)",
                       "PAUSED" if paused else "RESUMED", self.run_id)
        return paused

    @property
    def gate_pending(self) -> bool:
        cfg = self.config
        return (
            cfg.gate_after_largest > 0
            and not (cfg.gate_approved or self._state.gate_approved)
            and self._state.gate_published >= cfg.gate_after_largest
        )

    # -- thread ------------------------------------------------------------- #
    def start(self) -> None:
        logger.warning(
            "math-backfill ENABLED run=%s config=%s source=%s target=%s concurrency=%d "
            "large_threshold=%d gate_after_largest=%d ceiling_mb=%.0f state=%s",
            self.run_id, self.config.digest(), self.config.source_env,
            self._host.target_env, self.config.concurrency, self.config.large_threshold,
            self.config.gate_after_largest, self.ceiling_bytes / _MB,
            "file" if self.config.state_path else "memory-only",
        )
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="math-backfill", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                _, wait = self.step()
            except Exception as exc:  # noqa: BLE001 - never take the poller down
                logger.error("math-backfill: scheduling step failed (%s); retrying",
                             exc.__class__.__name__)
                wait = 30.0
            self._stop.wait(max(0.05, wait))

    # -- admission ---------------------------------------------------------- #
    def step(self) -> Tuple[str, float]:
        """One admission decision. Returns (status, seconds to wait)."""
        with self._lock:
            now = self._clock()
            self._reap_lost()
            if self._state.paused:
                return "paused_operator", 5.0
            if self.gate_pending:
                self._log_gate_once()
                return "gate", 5.0
            pressure = self._pressure(now)
            if pressure:
                return f"paused_{pressure}", 2.0
            if len(self._in_flight) >= self.config.concurrency or any(
                j.large for j in self._in_flight.values()
            ):
                return "busy", 0.5
            if self._host.pending_zids() - set(self._in_flight):
                return "live_priority", 0.5
            if now < self._next_admit_at:
                return "pacing", min(self._next_admit_at - now, 5.0)
            if now < self._next_sweep_at:
                return "between_sweeps", min(self._next_sweep_at - now, 5.0)

            target = self._next_target(now)
            if target is None:
                self._finish_sweep(now)
                return "sweep_complete", 1.0
            large = target.participants > self.config.large_threshold
            if large and self._in_flight:
                self._buffer.appendleft(target)
                return "serial_wait", 0.5

            votes, voters, comments = self._store.sizes(target.zid)
            est = self._model.estimate_bytes(votes, voters, comments)
            if votes > self.config.max_votes:
                self._record(Record(target.zid, target.klass, REFUSED_INPUT_SIZE,
                                    target.participants, voters, votes, comments,
                                    est_mb=est / _MB), large=large)
                return REFUSED_INPUT_SIZE, 0.0
            if est > self.ceiling_bytes:
                # Could never fit, whatever else the process holds: report it
                # for a reviewed larger-budget run; never truncate.
                self._record(Record(target.zid, target.klass, OVER_MEMORY_CEILING,
                                    target.participants, voters, votes, comments,
                                    est_mb=est / _MB), large=large)
                return OVER_MEMORY_CEILING, 0.0
            rss = self._rss()
            need = self._model.above_base_bytes(votes, voters, comments)
            reserved = sum(
                self._model.above_base_bytes(j.votes, j.voters, j.comments)
                for j in self._in_flight.values()
            )
            if rss + need > self.ceiling_bytes and not self._in_flight:
                # Does not fit beside what the process holds now (its cache):
                # defer to a later sweep.
                self._record(Record(target.zid, target.klass, MEMORY_HEADROOM,
                                    target.participants, voters, votes, comments,
                                    est_mb=est / _MB), large=large)
                return MEMORY_HEADROOM, 0.0
            if rss + reserved + need > self.ceiling_bytes:
                self._buffer.appendleft(target)
                return "memory_wait", 1.0
            window = self._window_votes(now)
            if window and window + votes > self.config.max_votes_per_min:
                self._buffer.appendleft(target)
                return "vote_budget", 1.0

            job = _Job(target, votes, voters, comments, est, large)
            self._in_flight[target.zid] = job
            if not self._host.submit(target.zid):
                self._in_flight.pop(target.zid, None)
                self._record(Record(target.zid, target.klass, PARKED_LIVE,
                                    target.participants, voters, votes, comments,
                                    est_mb=est / _MB), large=large)
                return "parked_live", 0.0
            self._vote_window.append((now, votes))
            self._sweep_admitted += 1
            self._next_admit_at = now + self.config.min_interval_s
            return "admitted", 0.0

    def _pressure(self, now: float) -> Optional[str]:
        mean_ms, since_ok = self._host.live_poll_health()
        if since_ok is None or since_ok > self.config.telemetry_stale_s:
            reason = "telemetry"
        elif mean_ms is not None and mean_ms > self.config.pause_poll_ms:
            reason = "db_latency"
        elif (
            self._pressure_paused == "db_latency" and mean_ms is not None
            and mean_ms > self.config.pause_poll_ms / 2
        ):
            reason = "db_latency"  # hysteresis: resume only below half
        else:
            reason = None
        if reason != self._pressure_paused:
            if reason:
                logger.warning("math-backfill: pausing (%s; live poll mean_ms=%s "
                               "since_ok_s=%s)", reason, _fmt(mean_ms), _fmt(since_ok))
            else:
                logger.warning("math-backfill: resuming after %s", self._pressure_paused)
            self._pressure_paused = reason
        return reason

    def _window_votes(self, now: float) -> int:
        while self._vote_window and self._vote_window[0][0] <= now - 60.0:
            self._vote_window.popleft()
        return sum(v for _, v in self._vote_window)

    def _eligible(self, target: Target, now: float) -> bool:
        if target.zid in self._in_flight or not self._host.accepts(target.zid):
            return False
        failure = self._state.failures.get(str(target.zid))
        if failure is None:
            return True
        reason = failure["reason"]
        if reason == OVER_MEMORY_CEILING:
            # Re-opened only by a larger ceiling than the one that refused it.
            return self.config.memory_ceiling_mb > float(failure.get("bound", math.inf))
        if reason == REFUSED_INPUT_SIZE:
            return self.config.max_votes > float(failure.get("bound", math.inf))
        if reason == EXHAUSTED or reason in EXCLUDED_OUTCOMES:
            return False
        return now >= float(failure["next_at"])

    def _next_target(self, now: float) -> Optional[Target]:
        while True:
            while self._buffer:
                target = self._buffer.popleft()
                if self._eligible(target, now):
                    return target
            if self._cursor == ("end",):
                return None
            page = self._store.page(self._cursor, self.config.page_size,
                                    self._stale_cutoff_ms(now))
            if not page:
                self._cursor = ("end",)
                return None
            last = page[-1][0]
            self._cursor = (last.participants, last.zid)
            self._sweep_seen += len(page)
            self._buffer.extend(t for t, _ in page)

    def _stale_cutoff_ms(self, now: float) -> int:
        return int((now - self.config.stale_grace_s) * 1000)

    def _finish_sweep(self, now: float) -> None:
        self._sweep_no += 1
        unresolved = self._unresolved()
        try:
            counts = self._store.label_counts(self._stale_cutoff_ms(now))
        except Exception as exc:  # noqa: BLE001 - reporting only
            counts = {"error": exc.__class__.__name__}
        logger.warning(
            "math-backfill sweep=%d run=%s config=%s seen=%d admitted=%d deferred=%d "
            "in_flight=%d unresolved=%s counts=%s totals=%s top_seconds=%s top_memory=%s",
            self._sweep_no, self.run_id, self.config.digest(), self._sweep_seen,
            self._sweep_admitted, self._sweep_deferred, len(self._in_flight),
            json.dumps(unresolved, sort_keys=True), json.dumps(counts, sort_keys=True),
            json.dumps(self._state.totals, sort_keys=True),
            [(r["zid"], round(r["seconds"], 1)) for r in self._state.top_seconds],
            [(r["zid"], round(r["peak_rss_delta_mb"], 1)) for r in self._state.top_memory],
        )
        refused = sorted(
            (int(z), f.get("est_mb"), f["reason"]) for z, f in self._state.failures.items()
            if f["reason"] in EXCLUDED_OUTCOMES or f["reason"] == EXHAUSTED
        )
        if refused:
            logger.warning(
                "math-backfill sweep=%d unresolved_list(zid, est_mb, reason)=%s%s",
                self._sweep_no, refused[:50],
                f" (+{len(refused) - 50} more)" if len(refused) > 50 else "",
            )
        if (
            self._sweep_seen == 0 and not self._in_flight
            and not any(unresolved.values())
        ):
            logger.warning(
                "math-backfill COMPLETE run=%s: every %s conversation has a coherent, "
                "caught-up %s publication", self.run_id, self.config.source_env,
                self._host.target_env,
            )
        self._cursor = None
        self._buffer.clear()
        self._sweep_seen = self._sweep_admitted = self._sweep_deferred = 0
        self._next_sweep_at = now + self.config.resweep_s

    def _unresolved(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for failure in self._state.failures.values():
            counts[failure["reason"]] = counts.get(failure["reason"], 0) + 1
        return counts

    def _reap_lost(self) -> None:
        """A queued BACKFILL message the pool dropped (the zid was parked
        after admission) never reports; release its slot."""
        for zid in list(self._in_flight):
            if not self._host.is_pending(zid):
                job = self._in_flight.pop(zid)
                self._record(Record(zid, job.target.klass, LOST, job.target.participants,
                                    job.voters, job.votes, job.comments,
                                    est_mb=job.est_bytes / _MB), large=job.large)

    # -- execution (pool thread) ------------------------------------------- #
    def run_job(self, zid: int) -> None:
        """Run one admitted job on the zid's pool worker. Never raises."""
        with self._lock:
            job = self._in_flight.get(zid)
        if job is None:  # pragma: no cover - admitted jobs always have an entry
            return
        started = time.monotonic()
        report: Dict[str, Any] = {}
        sampler = PeakSampler(self._rss)
        with sampler:
            before = self._rss()
            outcome = self._execute(zid, job, report)
        seconds = time.monotonic() - started
        delta_mb = max(0, sampler.peak - before) / _MB
        with self._lock:
            self._in_flight.pop(zid, None)
            self._record(Record(
                zid, job.target.klass, outcome, job.target.participants, job.voters,
                job.votes, job.comments, seconds, delta_mb, job.est_bytes / _MB,
                int(report.get("payload_bytes", 0)),
            ), large=job.large, compute_s=seconds)
        self._release()

    def _execute(self, zid: int, job: _Job, report: Dict[str, Any]) -> str:
        now = self._clock()
        if self._host.is_cached(zid):
            return LIVE_OWNED
        try:
            state = self._store.state(zid, self._stale_cutoff_ms(now))
        except Exception as exc:  # noqa: BLE001
            logger.error("math-backfill zid=%s: state read failed (%s)", zid,
                         exc.__class__.__name__)
            return FAILED_COMPUTE
        if state is None or state[0] is None:
            return ALREADY_COMPLETE
        _, current = state
        try:
            conv = self._host.load_full_history(zid)
        except Exception as exc:  # noqa: BLE001
            logger.error("math-backfill zid=%s: compute failed (%s)", zid,
                         exc.__class__.__name__)
            return FAILED_COMPUTE

        def before_publish(connection: Any, _math_tick: int) -> None:
            if self._store.fingerprint_in(connection, zid) != current.fingerprint:
                raise _Superseded()

        try:
            self._host.writer.write_conv_updates(
                zid, conv, before_publish=before_publish, report=report,
            )
        except _Superseded:
            return SUPERSEDED_LIVE
        except Exception as exc:  # noqa: BLE001
            logger.error("math-backfill zid=%s: publication failed (%s)", zid,
                         exc.__class__.__name__)
            return FAILED_WRITE
        finally:
            del conv
        try:
            ok, _tick, target_lvt = self._store.coherent(zid)
        except Exception as exc:  # noqa: BLE001
            logger.error("math-backfill zid=%s: postcondition read failed (%s)", zid,
                         exc.__class__.__name__)
            return FAILED_POSTCONDITION
        # Backfill never grows the live cache: the rebuilt conversation was
        # never remembered, and anything cached for it is dropped (per-zid
        # serialization means live cannot have cached it during this job).
        self._host.evict(zid)
        if not ok:
            return FAILED_POSTCONDITION
        if current.source_lvt is not None and (target_lvt is None or target_lvt < current.source_lvt):
            return SOURCE_AHEAD
        return PUBLISHED

    def job_skipped(self, zid: int, outcome: str) -> None:
        """The pool ran the zid without our job (parked) — release the slot."""
        with self._lock:
            job = self._in_flight.pop(zid, None)
            if job is not None:
                self._record(Record(zid, job.target.klass, outcome, job.target.participants,
                                    job.voters, job.votes, job.comments,
                                    est_mb=job.est_bytes / _MB), large=job.large)

    def job_superseded_by_live(self, zid: int, live_ok: bool) -> None:
        """Live work for the zid coalesced with our job and ran instead."""
        self.job_skipped(zid, SUPERSEDED_LIVE if live_ok else LIVE_OWNED)

    # -- bookkeeping -------------------------------------------------------- #
    def _record(self, rec: Record, *, large: bool, compute_s: float = 0.0) -> None:
        cfg, st, now = self.config, self._state, self._clock()
        assert rec.outcome in ALL_OUTCOMES, rec.outcome
        logger.info(
            "math-backfill zid=%d class=%s outcome=%s participants=%d voters=%d votes=%d "
            "comments=%d seconds=%.2f peak_rss_delta_mb=%.1f est_mb=%.1f result_bytes=%d",
            rec.zid, rec.klass, rec.outcome, rec.participants, rec.voters, rec.votes,
            rec.comments, rec.seconds, rec.peak_rss_delta_mb, rec.est_mb, rec.result_bytes,
        )
        st.totals[rec.outcome] = st.totals.get(rec.outcome, 0) + 1
        key = str(rec.zid)
        if rec.outcome in COMPLETE_OUTCOMES:
            st.failures.pop(key, None)
        elif rec.outcome in FAILED_OUTCOMES:
            prior = st.failures.get(key, {})
            attempts = int(prior.get("attempts", 0)) + 1
            delay = min(cfg.retry_cap_s, cfg.retry_base_s * 2 ** (attempts - 1))
            st.failures[key] = {
                "attempts": attempts, "next_at": now + delay,
                "reason": EXHAUSTED if attempts >= cfg.max_attempts else rec.outcome,
                "last": rec.outcome,
            }
        elif rec.outcome in DEFERRED_OUTCOMES:
            prior = st.failures.get(key, {})
            st.failures[key] = {
                "attempts": int(prior.get("attempts", 0)),
                "next_at": now + cfg.refusal_backoff_s, "reason": rec.outcome,
                "last": rec.outcome,
            }
            self._sweep_deferred += 1
        else:  # excluded
            st.failures[key] = {"attempts": 0, "next_at": 0, "reason": rec.outcome,
                                "last": rec.outcome}
            if rec.outcome == OVER_MEMORY_CEILING:
                st.failures[key]["bound"] = cfg.memory_ceiling_mb
                st.failures[key]["est_mb"] = round(rec.est_mb, 1)
            elif rec.outcome == REFUSED_INPUT_SIZE:
                st.failures[key]["bound"] = cfg.max_votes
        if rec.outcome == PUBLISHED:
            st.top_seconds = _top10(st.top_seconds, rec, "seconds")
            st.top_memory = _top10(st.top_memory, rec, "peak_rss_delta_mb")
            if cfg.gate_after_largest and not st.gate_approved and not cfg.gate_approved:
                if st.gate_published < cfg.gate_after_largest:
                    st.gate_published += 1
                    st.gate_records.append(asdict(rec))
        if compute_s or rec.outcome in (LIVE_OWNED, PARKED_LIVE, LOST):
            rest = cfg.min_interval_s
            if compute_s:
                rest = max(rest, compute_s * (1 - cfg.duty_cycle) / cfg.duty_cycle)
            if large and compute_s:
                rest = max(rest, cfg.large_sleep_s)
            self._next_admit_at = max(self._next_admit_at, now + rest)
        st.save(cfg.state_path)
        self._done_since_summary += 1
        if self._done_since_summary >= cfg.summary_every:
            self._done_since_summary = 0
            logger.warning(
                "math-backfill summary run=%s totals=%s in_flight=%d unresolved=%s "
                "rss_mb=%.0f ceiling_mb=%.0f gate=%d/%d%s",
                self.run_id, json.dumps(st.totals, sort_keys=True), len(self._in_flight),
                json.dumps(self._unresolved(), sort_keys=True), self._rss() / _MB,
                self.ceiling_bytes / _MB, st.gate_published, cfg.gate_after_largest,
                " approved" if (st.gate_approved or cfg.gate_approved) else "",
            )

    def _log_gate_once(self) -> None:
        if self._gate_logged:
            return
        self._gate_logged = True
        logger.warning(
            "math-backfill GATE run=%s: the %d largest are published; admission is "
            "PAUSED until approval (SIGUSR1 to the poller, or MATH_BACKFILL_GATE_APPROVED=1)",
            self.run_id, self.config.gate_after_largest,
        )
        for r in self._state.gate_records:
            ratio = (r["peak_rss_delta_mb"] / r["est_mb"]) if r["est_mb"] else 0.0
            logger.warning(
                "math-backfill GATE zid=%d participants=%d voters=%d votes=%d comments=%d "
                "seconds=%.2f peak_rss_delta_mb=%.1f est_mb=%.1f peak_over_est=%.2f",
                r["zid"], r["participants"], r["voters"], r["votes"], r["comments"],
                r["seconds"], r["peak_rss_delta_mb"], r["est_mb"], ratio,
            )


def _fmt(value: Optional[float]) -> str:
    return "none" if value is None else f"{value:.0f}"


def build_scheduler(host: Any, pg: Any, config: BackfillConfig, **kwargs: Any) -> BackfillScheduler:
    """Refuses (ConfigError) a source label equal to the poller's own."""
    if config.source_env.strip() == host.target_env.strip():
        raise ConfigError("MATH_BACKFILL_SOURCE_ENV must differ from the poller's MATH_ENV")
    store = BackfillStore(pg, config.source_env, host.target_env, config.query_timeout_ms)
    return BackfillScheduler(host, store, config, **kwargs)


__all__ = [
    "BackfillConfig", "BackfillScheduler", "BackfillState", "BackfillStore",
    "ConfigError", "ENV_NAMES", "MemoryModel", "Record", "Target", "build_scheduler",
    "classify",
]
