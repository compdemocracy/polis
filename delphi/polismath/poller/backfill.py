"""Pre-switch backfill (P-070): bounded, low-priority background rebuilds
inside the admitted math poller.

The poller computes a conversation only when it sees a vote or a moderation
change after its boot lookback (POLL_FROM_DAYS_AGO), so a conversation that is
dormant never gets a row under the poller's label. Before readers switch
labels, every conversation that has a row under the SOURCE label (Clojure's
``prod``) must have a valid publication under the poller's own label. This
module finds those conversations and feeds them, one at a time by default,
into the poller's own per-zid worker pool as ``BACKFILL`` messages. It runs in
the poller process because that process already holds the label's
single-writer lock: nothing here opens a second writer.

What a backfill job does (``BackfillScheduler.run_job``, on a pool thread):
  1. reserves its memory in the poller's shared admission accountant
     (polismath.poller.admission) without waiting; no room means deferred;
  2. re-reads the target's state; a valid, caught-up publication is a no-op;
  3. rebuilds the conversation exactly as the poller's first touch does
     (``MathPollerService._load_or_init``: full vote history in engine order,
     full moderation state, recompute), but does NOT put it in the LRU cache;
  4. publishes through the poller's ``MathWriter`` (tick + three payload tables
     in one transaction). Inside that transaction, right after the tick upsert
     has locked ``(zid, label)``, it re-reads the target ``math_main`` row; if
     it differs from what step 2 saw, live ingestion published first and the
     backfill rolls back (the tie rule: the live write wins);
  5. verifies the postcondition with the same rules as selection and the
     shipped verification SQL: a valid bundle (``VALID_BUNDLE_SQL``) whose
     ``last_vote_timestamp`` is not behind the source row's.

Selection: every source conversation whose target publication is MISSING,
INCOMPLETE (a missing companion or ``math_ticks`` row, unequal generations, or
an uninitialized generation below 0), INVALID (a payload that fails the
reader-contract checks in ``VALID_BUNDLE_SQL``) or STALE (behind the source
and not itself published inside the grace window). A target that is behind
its source but was itself published inside the grace window is LIVE LAG: live
ingestion owns it, and it is counted and reported, never exempted from the
verification cutoff proof. Pages are keyset-ordered largest first
(participant count, then zid) and bounded; payloads are validated for the
page's rows only. A finished sweep starts again from the top after a pause,
so earlier failures and new source rows are picked up. The database is the
progress record: each sweep reconciles saved failures against it and clears
the ones live ingestion (or anything else) has since repaired.

Priority and budgets: a job is admitted only when live ingestion has nothing
queued or running, the live vote poll is healthy (recent success, mean latency
under a ceiling), the pacing interval has passed (minimum interval, a duty
cycle on compute time, an extra rest after a large conversation) and the
rolling vote-read budget allows it. Memory is the shared accountant's: the
estimate includes the vote-history rows, and a large job holds an exclusive
reservation, so live work that arrives while it runs waits for it rather than
computing beside it. Refusals never truncate input and never count as done.

Operator controls (see cost-reduction/04-plans/P-070-math-backfill.md): the
MATH_BACKFILL_* environment (read at start), SIGUSR1 to approve the gate after
the first N publications, SIGUSR2 to pause or resume. The gate approval is
bound to the calibration settings (memory model, budget, size rules): a change
to any of them re-arms the gate.
"""

from __future__ import annotations

import ctypes
import gc
import hashlib
import json
import logging
import math
import os
import re
import threading
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Callable, Deque, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import text

from polismath.poller.admission import (  # noqa: F401 - re-exported
    SIZES_SQL,
    MemoryAdmission,
    MemoryModel,
    read_cgroup_limit_bytes,
    read_rss_bytes,
)

logger = logging.getLogger(__name__)


# SQLSTATE -> fixed label. A driver's message can echo bound values or SQL
# (PostgreSQL 22P02 prints the rejected input), so a brief never carries
# exception text: only a validated SQLSTATE and a label from these tables.
_SQLSTATE_LABELS = {
    "57014": "statement_timeout",
    "42883": "undefined_function",
    "22P02": "invalid_text_representation",
    "22003": "numeric_value_out_of_range",
    "22P05": "untranslatable_character",
    "40P01": "deadlock_detected",
    "40001": "serialization_failure",
    "55P03": "lock_not_available",
    "57P01": "admin_shutdown",
    "42501": "insufficient_privilege",
}
_SQLSTATE_CLASS_LABELS = {
    "08": "connection_exception",
    "53": "insufficient_resources",
}
_SQLSTATE_RE = re.compile(r"[0-9A-Z]{5}")


def _sqlstate(exc: BaseException) -> Optional[str]:
    """The validated SQLSTATE of ``exc`` or its wrapped driver error, if any."""
    for source in (getattr(exc, "orig", None), exc):
        if source is None:
            continue
        diag = getattr(source, "diag", None)
        for code in (getattr(source, "pgcode", None), getattr(diag, "sqlstate", None)):
            if isinstance(code, str) and _SQLSTATE_RE.fullmatch(code):
                return code
    return None


def _exc_brief(exc: BaseException) -> str:
    """A fixed, allowlisted label for a log line; never exception text.

    With a SQLSTATE: ``sqlstate=<code> <label>`` (label ``other`` when the
    code and its class are not listed). Without one: the class names of the
    exception and its causes (``OperationalError/OSError``, at most three)."""
    code = _sqlstate(exc)
    if code is not None:
        label = (_SQLSTATE_LABELS.get(code)
                 or _SQLSTATE_CLASS_LABELS.get(code[:2])
                 or "other")
        return f"sqlstate={code} {label}"
    names: List[str] = []
    seen = set()
    current: Optional[BaseException] = exc
    while current is not None and id(current) not in seen and len(names) < 3:
        seen.add(id(current))
        names.append(current.__class__.__name__)
        current = current.__cause__ or current.__context__
    return "/".join(names)


_MB = 1024 * 1024

# --------------------------------------------------------------------------- #
# Vocabulary
# --------------------------------------------------------------------------- #
MISSING = "missing"
INCOMPLETE = "incomplete"
INVALID = "invalid"
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
SOURCE_AHEAD_ACCEPTED = "source_ahead_accepted"
LOST = "lost"

# The ruling on a source row that claims a later vote than the votes table
# holds (MATH_BACKFILL_SOURCE_AHEAD_RULING). UNRESOLVED (the default, and the
# only value until Colin rules): excluded, counted, and blocking COMPLETE.
# ACCEPT_INPUT: a valid target that reflects every vote in the table is
# accepted and counted as SOURCE_AHEAD_ACCEPTED; the source's later claim is
# never manufactured into the target.
RULING_UNRESOLVED = "unresolved"
RULING_ACCEPT_INPUT = "accept_input"
SOURCE_AHEAD_RULINGS = (RULING_UNRESOLVED, RULING_ACCEPT_INPUT)

# Counted as done for this conversation.
COMPLETE_OUTCOMES = frozenset({PUBLISHED, SUPERSEDED_LIVE, ALREADY_COMPLETE,
                               SOURCE_AHEAD_ACCEPTED})
# Retried with exponential backoff; each one spends an attempt.
FAILED_OUTCOMES = frozenset({FAILED_COMPUTE, FAILED_WRITE, FAILED_POSTCONDITION, LOST})
# Deferred to a later sweep without spending an attempt.
DEFERRED_OUTCOMES = frozenset({MEMORY_HEADROOM, LIVE_OWNED, PARKED_LIVE})
# Never retried automatically; needs an explicit disposition (a larger-budget
# run for the refusals, a ruling for SOURCE_AHEAD).
EXCLUDED_OUTCOMES = frozenset({SOURCE_AHEAD, OVER_MEMORY_CEILING, REFUSED_INPUT_SIZE})
ALL_OUTCOMES = COMPLETE_OUTCOMES | FAILED_OUTCOMES | DEFERRED_OUTCOMES | EXCLUDED_OUTCOMES

EXHAUSTED = "exhausted"
FAILURE_REASONS = ALL_OUTCOMES | {EXHAUSTED}


class ConfigError(ValueError):
    """A MATH_BACKFILL_* value is unusable; the backfill stays off."""


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class BackfillConfig:
    """Backfill settings. Every field has a MATH_BACKFILL_* variable
    (``_ENV_NAMES``); ``from_env`` validates them all. The memory model and
    budget are the poller's (MATH_POLLER_MEM_*, MATH_POLLER_MEMORY_*), shared
    with live work."""

    enabled: bool = False
    source_env: str = "prod"
    concurrency: int = 1
    large_threshold: int = 2000          # participants; above this, run alone
    gate_after_largest: int = 10          # 0 = no gate
    gate_approved: bool = False
    # Optional extra cap on one backfill job's estimated peak (MiB); 0 = only
    # the shared budget decides.
    memory_ceiling_mb: float = 0.0
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
    revalidate_s: float = 3600.0          # re-read valid payloads at least this often
    max_attempts: int = 5
    retry_base_s: float = 60.0
    retry_cap_s: float = 21600.0
    refusal_backoff_s: float = 1800.0
    summary_every: int = 25
    query_timeout_ms: int = 30000
    state_path: Optional[str] = None
    source_ahead_ruling: str = RULING_UNRESOLVED

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
            "memory_ceiling_mb": self.memory_ceiling_mb,
            "min_interval_s": self.min_interval_s, "large_sleep_s": self.large_sleep_s,
            "pause_poll_ms": self.pause_poll_ms, "telemetry_stale_s": self.telemetry_stale_s,
            "resweep_s": self.resweep_s, "stale_grace_s": self.stale_grace_s,
            "revalidate_s": self.revalidate_s,
            "retry_base_s": self.retry_base_s, "retry_cap_s": self.retry_cap_s,
            "refusal_backoff_s": self.refusal_backoff_s,
        }
        for name, value in non_negative.items():
            if not (math.isfinite(value) and value >= 0):
                raise ConfigError(f"{name} must be a finite number >= 0, got {value}")
        if not (math.isfinite(self.duty_cycle) and 0 < self.duty_cycle <= 1):
            raise ConfigError(f"duty_cycle must be in (0, 1], got {self.duty_cycle}")
        if self.source_ahead_ruling not in SOURCE_AHEAD_RULINGS:
            raise ConfigError(
                f"MATH_BACKFILL_SOURCE_AHEAD_RULING must be one of {SOURCE_AHEAD_RULINGS}, "
                f"got {self.source_ahead_ruling!r}")

    @property
    def accept_source_ahead(self) -> bool:
        return self.source_ahead_ruling == RULING_ACCEPT_INPUT

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
                elif f.name in ("source_env", "state_path", "source_ahead_ruling"):
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
    "revalidate_s": "MATH_BACKFILL_REVALIDATE_S",
    "max_attempts": "MATH_BACKFILL_MAX_ATTEMPTS",
    "retry_base_s": "MATH_BACKFILL_RETRY_BASE_S",
    "retry_cap_s": "MATH_BACKFILL_RETRY_CAP_S",
    "refusal_backoff_s": "MATH_BACKFILL_REFUSAL_BACKOFF_S",
    "summary_every": "MATH_BACKFILL_SUMMARY_EVERY",
    "query_timeout_ms": "MATH_BACKFILL_QUERY_TIMEOUT_MS",
    "state_path": "MATH_BACKFILL_STATE_PATH",
    "source_ahead_ruling": "MATH_BACKFILL_SOURCE_AHEAD_RULING",
}
ENV_NAMES = dict(_ENV_NAMES)


# --------------------------------------------------------------------------- #
# Memory telemetry
# --------------------------------------------------------------------------- #
def release_memory() -> None:
    """Return freed heap to the OS after a large rebuild (glibc only)."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass


class PeakSampler:
    """Samples RSS on a background thread while a job runs; reports the
    highest SAMPLE. A transient between samples is not observed: this is
    sampled telemetry, not proof that an unobserved peak fit."""

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
# Validity: ONE rule for selection, the postcondition and the verifier
# --------------------------------------------------------------------------- #
# A target bundle is valid when all four rows exist at one initialized
# generation (>= 0) and the three payloads carry what the readers use, bound
# to their row: math_main's zid and lastVoteTimestamp equal its row's zid and
# last_vote_timestamp column; the companions' zids equal their rows'; the
# reader-used members have the reader's JSON types; base-clusters members and
# math_bidtopid.bidToPid line up with base-clusters.id (the server indexes
# bidToPid by that position); in-conv never exceeds n; and n = 0 only in
# Python's named empty form (no base clusters, groups or in-conv members, a
# zero timestamp and empty participant stats). Types and bindings only: no
# numeric acceptance policy. Review [1447] B extended it to the nested shapes
# the readers index: every group-clusters entry an object with a numeric id and
# a numeric members array (the server's processMathObject reads g.id); pca
# center a numeric array and comps an array of numeric arrays; base-clusters
# ids numeric and members arrays of numbers; every bidToPid entry an array of
# numbers (the server's bidsForPids calls indexOf on each); participant stats
# either {} or columnar (pid and gid arrays, every column an array of the pid
# column's length); and both companions' lastVoteTimestamp equal to main's
# last_vote_timestamp column (the writer stamps all three from one value).
# Review [1449] B completed it from the readers' side: the server's
# processMathObject dereferences every group-votes and repness entry, and the
# Python warm restore iterates each group-votes entry's votes, so group-votes
# must be an object whose every entry is an object with numeric n-members and
# a votes object of {A, D, S} number objects, and every repness entry an array
# of objects. Absent the check, group-votes [null] passed and crashed the
# reader, and [1] / [{}] passed and were presented as empty.
# Every cast, array length and set-returning call is guarded, so a malformed
# payload evaluates to false instead of raising. The shipped verification SQL
# contains this exact text (a test holds them together).
# Every payload reference is cast (m.data::jsonb): the migrations declare the
# data columns jsonb, but production's math tables carry them as json, which
# has no jsonb_typeof, jsonb_array_length, jsonb_each, ?& or = (the backfill's
# first production step failed on exactly that). The cast is a no-op on jsonb.
# Each payload is cast once per row, not once per reference: on json every
# cast re-parses the text, and a page holding a 14.7 MB math_main payload ran
# past the 120 s statement timeout. The scalar subquery binds md, bd and pd
# once; OFFSET 0 keeps the planner from inlining the casts back into every
# reference; and its WHERE holds the structural checks, so an incomplete or
# uninitialized bundle is not parsed at all. Same truth table: a structural
# failure yields no row, which COALESCE turns into false as before.
VALID_BUNDLE_SQL = """COALESCE((
    SELECT jsonb_typeof(md) = 'object'
    AND CASE WHEN jsonb_typeof(md->'zid') = 'number'
             THEN (md->>'zid')::numeric = m.zid ELSE false END
    AND CASE WHEN jsonb_typeof(md->'lastVoteTimestamp') = 'number'
             THEN (md->>'lastVoteTimestamp')::numeric = m.last_vote_timestamp
             ELSE false END
    AND jsonb_typeof(md->'tids') = 'array'
    AND jsonb_typeof(md->'pca') = 'object'
    AND jsonb_typeof(md->'repness') = 'object'
    AND jsonb_typeof(bd) = 'object'
    AND CASE WHEN jsonb_typeof(bd->'zid') = 'number'
             THEN (bd->>'zid')::numeric = b.zid ELSE false END
    AND CASE WHEN jsonb_typeof(bd->'lastVoteTimestamp') = 'number'
             THEN (bd->>'lastVoteTimestamp')::numeric = m.last_vote_timestamp
             ELSE false END
    AND jsonb_typeof(pd) = 'object'
    AND CASE WHEN jsonb_typeof(pd->'zid') = 'number'
             THEN (pd->>'zid')::numeric = p.zid ELSE false END
    AND CASE WHEN jsonb_typeof(pd->'lastVoteTimestamp') = 'number'
             THEN (pd->>'lastVoteTimestamp')::numeric = m.last_vote_timestamp
             ELSE false END
    AND CASE WHEN jsonb_typeof(pd->'ptptstats') = 'object'
         THEN pd->'ptptstats' = '{}'::jsonb
              OR (jsonb_typeof(pd->'ptptstats'->'pid') = 'array'
                  AND jsonb_typeof(pd->'ptptstats'->'gid') = 'array'
                  AND NOT EXISTS (
                      SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(pd->'ptptstats') = 'object'
                                                    THEN pd->'ptptstats' ELSE '{}'::jsonb END) e
                      WHERE (CASE WHEN jsonb_typeof(e.value) = 'array'
                                  THEN jsonb_array_length(e.value) END)
                            IS DISTINCT FROM
                            (CASE WHEN jsonb_typeof(pd->'ptptstats'->'pid') = 'array'
                                  THEN jsonb_array_length(pd->'ptptstats'->'pid') END)))
         ELSE false END
    AND jsonb_typeof(md->'pca'->'center') = 'array'
    AND jsonb_typeof(md->'pca'->'comps') = 'array'
    AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(md->'pca'->'center') = 'array'
                                                THEN md->'pca'->'center' ELSE '[]'::jsonb END) x
        WHERE jsonb_typeof(x) <> 'number')
    AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(md->'pca'->'comps') = 'array'
                                                THEN md->'pca'->'comps' ELSE '[]'::jsonb END) c
        WHERE jsonb_typeof(c) <> 'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c) = 'array'
                                                              THEN c ELSE '[]'::jsonb END) x
                      WHERE jsonb_typeof(x) <> 'number'))
    AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(md->'group-clusters') = 'array'
                                                THEN md->'group-clusters' ELSE '[]'::jsonb END) g
        WHERE jsonb_typeof(g) <> 'object'
           OR jsonb_typeof(g->'id') IS DISTINCT FROM 'number'
           OR jsonb_typeof(g->'members') IS DISTINCT FROM 'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(g->'members') = 'array'
                                                              THEN g->'members' ELSE '[]'::jsonb END) x
                      WHERE jsonb_typeof(x) <> 'number'))
    AND jsonb_typeof(md->'group-votes') = 'object'
    AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(md->'group-votes') = 'object'
                                      THEN md->'group-votes' ELSE '{}'::jsonb END) g
        WHERE jsonb_typeof(g.value) IS DISTINCT FROM 'object'
           OR jsonb_typeof(g.value->'n-members') IS DISTINCT FROM 'number'
           OR jsonb_typeof(g.value->'votes') IS DISTINCT FROM 'object'
           OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(g.value->'votes') = 'object'
                                                    THEN g.value->'votes' ELSE '{}'::jsonb END) v
                      WHERE jsonb_typeof(v.value) IS DISTINCT FROM 'object'
                         OR jsonb_typeof(v.value->'A') IS DISTINCT FROM 'number'
                         OR jsonb_typeof(v.value->'D') IS DISTINCT FROM 'number'
                         OR jsonb_typeof(v.value->'S') IS DISTINCT FROM 'number'))
    AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(md->'repness') = 'object'
                                      THEN md->'repness' ELSE '{}'::jsonb END) r
        WHERE jsonb_typeof(r.value) IS DISTINCT FROM 'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.value) = 'array'
                                                              THEN r.value ELSE '[]'::jsonb END) x
                      WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'))
    AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(md->'base-clusters'->'id') = 'array'
                                                THEN md->'base-clusters'->'id' ELSE '[]'::jsonb END) x
        WHERE jsonb_typeof(x) <> 'number')
    AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(md->'base-clusters'->'members') = 'array'
                                                THEN md->'base-clusters'->'members' ELSE '[]'::jsonb END) c
        WHERE jsonb_typeof(c) <> 'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c) = 'array'
                                                              THEN c ELSE '[]'::jsonb END) x
                      WHERE jsonb_typeof(x) <> 'number'))
    AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(bd->'bidToPid') = 'array'
                                                THEN bd->'bidToPid' ELSE '[]'::jsonb END) c
        WHERE jsonb_typeof(c) <> 'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c) = 'array'
                                                              THEN c ELSE '[]'::jsonb END) x
                      WHERE jsonb_typeof(x) <> 'number'))
    AND CASE WHEN jsonb_typeof(md->'n') = 'number'
              AND jsonb_typeof(md->'base-clusters') = 'object'
              AND jsonb_typeof(md->'base-clusters'->'id') = 'array'
              AND jsonb_typeof(md->'base-clusters'->'members') = 'array'
              AND jsonb_typeof(md->'group-clusters') = 'array'
              AND jsonb_typeof(md->'in-conv') = 'array'
              AND jsonb_typeof(bd->'bidToPid') = 'array'
         THEN (md->>'n')::numeric >= 0
              AND jsonb_array_length(md->'base-clusters'->'members')
                  = jsonb_array_length(md->'base-clusters'->'id')
              AND jsonb_array_length(bd->'bidToPid')
                  = jsonb_array_length(md->'base-clusters'->'id')
              AND jsonb_array_length(md->'in-conv') <= (md->>'n')::numeric
              AND ((md->>'n')::numeric > 0
                   OR (jsonb_array_length(md->'base-clusters'->'id') = 0
                       AND jsonb_array_length(md->'group-clusters') = 0
                       AND jsonb_array_length(md->'in-conv') = 0
                       AND m.last_vote_timestamp = 0
                       AND pd->'ptptstats' = '{}'::jsonb))
         ELSE false END
    FROM (SELECT m.data::jsonb AS md, b.data::jsonb AS bd, p.data::jsonb AS pd OFFSET 0) AS payload
    WHERE m.zid IS NOT NULL AND b.zid IS NOT NULL AND p.zid IS NOT NULL AND k.zid IS NOT NULL
    AND m.math_tick >= 0 AND b.math_tick = m.math_tick
    AND p.math_tick = m.math_tick AND k.math_tick = m.math_tick
    AND m.last_vote_timestamp IS NOT NULL
), false)"""


def structurally_coherent(row: Dict[str, Any]) -> bool:
    """All four rows present at one initialized (>= 0) generation."""
    ticks = [row.get("main_tick"), row.get("bid_tick"), row.get("stats_tick"), row.get("ticks_tick")]
    return (
        row.get("main_zid") is not None
        and all(t is not None for t in ticks)
        and len(set(ticks)) == 1
        and ticks[0] >= 0
    )


def behind_source(row: Dict[str, Any]) -> bool:
    source_lvt, target_lvt = row.get("source_lvt"), row.get("target_lvt")
    return source_lvt is not None and target_lvt is not None and target_lvt < source_lvt


def source_ahead(row: Dict[str, Any]) -> bool:
    """Behind its source row although it reflects every vote in the votes
    table (``input_lvt``, the table's newest vote for the zid, read only for
    rows behind their source): the source claims a vote the table does not
    hold. Live tail (a newer vote the target has not consumed yet) is not
    source-ahead."""
    input_lvt = row.get("input_lvt")
    return behind_source(row) and input_lvt is not None and row["target_lvt"] >= input_lvt


def classify(row: Dict[str, Any], stale_cutoff_ms: int, *,
             accept_source_ahead: bool = False) -> Optional[str]:
    """MISSING / INCOMPLETE / INVALID / STALE, or None when the target is a
    valid publication that needs no background rebuild: caught up, in live
    lag, recently source-ahead, or source-ahead under the accept ruling. None
    is NOT "caught up" (see ``caught_up``). ``row`` carries main_zid, the four
    ticks, target_lvt, source_lvt, input_lvt and bundle_valid (the result of
    ``VALID_BUNDLE_SQL``; anything but True counts as invalid)."""
    if row.get("main_zid") is None:
        return MISSING
    if not structurally_coherent(row):
        return INCOMPLETE
    if row.get("bundle_valid") is not True:
        return INVALID
    if behind_source(row):
        if accept_source_ahead and source_ahead(row):
            return None
        if row["target_lvt"] < stale_cutoff_ms:
            return STALE
    return None


def caught_up(row: Dict[str, Any]) -> bool:
    """Authoritatively caught up: not behind its source row."""
    return row.get("target_lvt") is not None and not behind_source(row)


def live_lag(row: Dict[str, Any], stale_cutoff_ms: int) -> bool:
    """Behind the source with votes it has not consumed yet, but itself
    published inside the grace window (live ingestion owns the tail)."""
    return (behind_source(row) and not source_ahead(row)
            and row["target_lvt"] >= stale_cutoff_ms)


def _fingerprint(row: Dict[str, Any]) -> Optional[Tuple[int, int]]:
    if row.get("main_zid") is None:
        return None
    return (int(row["main_tick"]), int(row["target_lvt"]) if row["target_lvt"] is not None else -1)


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
    target_lvt: Optional[int] = None
    # The votes table's newest vote for the zid; read only when the target
    # is behind its source.
    input_lvt: Optional[int] = None

    def as_row(self) -> Dict[str, Any]:
        return {"source_lvt": self.source_lvt, "target_lvt": self.target_lvt,
                "input_lvt": self.input_lvt}


_TARGET_COLUMNS = """
    src.zid AS zid,
    src.participants AS participants,
    src.source_lvt AS source_lvt,
    m.zid AS main_zid,
    m.math_tick AS main_tick,
    m.caching_tick AS main_caching_tick,
    m.last_vote_timestamp AS target_lvt,
    b.math_tick AS bid_tick,
    p.math_tick AS stats_tick,
    k.math_tick AS ticks_tick,
    CASE WHEN m.last_vote_timestamp < src.source_lvt
         THEN (SELECT COALESCE(max(v.created), 0) FROM votes v WHERE v.zid = src.zid)
    END AS input_lvt
"""

_TARGET_JOINS = """
    LEFT JOIN math_main m ON m.zid = src.zid AND m.math_env = :target
    LEFT JOIN math_bidtopid b ON b.zid = src.zid AND b.math_env = :target
    LEFT JOIN math_ptptstats p ON p.zid = src.zid AND p.math_env = :target
    LEFT JOIN math_ticks k ON k.zid = src.zid AND k.math_env = :target
"""

_SOURCE = """
    SELECT s.zid, COALESCE(c.participant_count, 0) AS participants,
           s.last_vote_timestamp AS source_lvt
    FROM math_main s
    LEFT JOIN conversations c ON c.zid = s.zid
    WHERE s.math_env = :source
"""

# The keyset page is chosen from the source rows alone (no payload is read),
# then joined to the target rows; payload validity is read separately for the
# page's structurally coherent rows only.
PAGE_SQL = (
    "WITH src AS (" + _SOURCE
    + """ AND (COALESCE(c.participant_count, 0) < :after_p
          OR (COALESCE(c.participant_count, 0) = :after_p AND s.zid > :after_zid))
        ORDER BY COALESCE(c.participant_count, 0) DESC, s.zid ASC
        LIMIT :limit)
    SELECT""" + _TARGET_COLUMNS + " FROM src" + _TARGET_JOINS
    + " ORDER BY src.participants DESC, src.zid ASC"
)

STATE_SQL = (
    "WITH src AS (" + _SOURCE + " AND s.zid = ANY(:zids)) SELECT"
    + _TARGET_COLUMNS + " FROM src" + _TARGET_JOINS
)

VALIDITY_SQL = (
    "SELECT m.zid AS zid, " + VALID_BUNDLE_SQL + """ AS valid
    FROM math_main m
    LEFT JOIN math_bidtopid b ON b.zid = m.zid AND b.math_env = m.math_env
    LEFT JOIN math_ptptstats p ON p.zid = m.zid AND p.math_env = m.math_env
    LEFT JOIN math_ticks k ON k.zid = m.zid AND k.math_env = m.math_env
    WHERE m.math_env = :target AND m.zid = ANY(:zids)"""
)

INPUT_LVT_SQL = "SELECT COALESCE(max(created), 0) AS input_lvt FROM votes WHERE zid = :zid"

FINGERPRINT_SQL = """
    SELECT math_tick, last_vote_timestamp FROM math_main
    WHERE zid = :zid AND math_env = :target
"""

# Counts without reading payloads (the sweep itself validates them).
_STRUCTURAL = """(b.zid IS NOT NULL AND p.zid IS NOT NULL AND k.zid IS NOT NULL
        AND m.math_tick >= 0 AND b.math_tick = m.math_tick
        AND p.math_tick = m.math_tick AND k.math_tick = m.math_tick)"""

# Behind the source although the target reflects every vote in the table.
_AHEAD = "COALESCE(m.last_vote_timestamp >= i.input_lvt, false)"

LABEL_COUNTS_SQL = (
    """SELECT
        count(*) AS source_rows,
        count(m.zid) AS target_main_rows,
        count(*) FILTER (WHERE m.zid IS NULL) AS missing,
        count(*) FILTER (WHERE m.zid IS NOT NULL AND NOT """ + _STRUCTURAL + """) AS incomplete,
        count(*) FILTER (WHERE m.zid IS NOT NULL AND """ + _STRUCTURAL + """
            AND m.last_vote_timestamp < src.source_lvt AND NOT """ + _AHEAD + """
            AND m.last_vote_timestamp < :stale_cutoff) AS stale,
        count(*) FILTER (WHERE m.zid IS NOT NULL AND """ + _STRUCTURAL + """
            AND m.last_vote_timestamp < src.source_lvt AND NOT """ + _AHEAD + """
            AND m.last_vote_timestamp >= :stale_cutoff) AS live_lag,
        count(*) FILTER (WHERE m.zid IS NOT NULL AND """ + _STRUCTURAL + """
            AND m.last_vote_timestamp < src.source_lvt AND """ + _AHEAD + """) AS source_ahead
    FROM (""" + _SOURCE + ") src" + _TARGET_JOINS + """
    CROSS JOIN LATERAL (SELECT CASE WHEN m.last_vote_timestamp < src.source_lvt
        THEN (SELECT COALESCE(max(v.created), 0) FROM votes v WHERE v.zid = src.zid)
        END AS input_lvt) i"""
)


class BackfillStore:
    """The backfill's SQL. Every statement runs under a statement timeout."""

    def __init__(self, pg: Any, source_env: str, target_env: str, query_timeout_ms: int,
                 *, revalidate_s: float = 3600.0, clock: Callable[[], float] = time.monotonic,
                 accept_source_ahead: bool = False) -> None:
        self._pg = pg
        self.accept_source_ahead = bool(accept_source_ahead)
        self._source = source_env
        self._target = target_env
        self._timeout_ms = int(query_timeout_ms)
        self._revalidate_s = float(revalidate_s)
        self._clock = clock
        # zid -> ((main_tick, caching_tick, target_lvt), validated_at): payloads
        # already found valid at that generation. Bounded by the source rows;
        # an entry expires after revalidate_s, so a payload changed in place
        # (same generation) is re-read within that time.
        self._valid_memo: Dict[int, Tuple[Tuple[Any, ...], float]] = {}

    def _rows(self, sql: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        with self._pg.transaction() as conn:
            conn.execute(text(f"SET LOCAL statement_timeout = {self._timeout_ms}"))
            result = conn.execute(text(sql), params)
            return [dict(r) for r in result.mappings().all()]

    def _params(self, **extra: Any) -> Dict[str, Any]:
        return {"source": self._source, "target": self._target, **extra}

    def _annotate_validity(self, rows: List[Dict[str, Any]], *, fresh: bool) -> None:
        """Set bundle_valid on every row: None-safe, payloads read only for
        structurally coherent rows not already validated at that generation."""
        now = self._clock()
        need: List[int] = []
        for row in rows:
            row["bundle_valid"] = False
            if not structurally_coherent(row):
                continue
            key = (row["main_tick"], row.get("main_caching_tick"), row["target_lvt"])
            memo = None if fresh else self._valid_memo.get(int(row["zid"]))
            if memo is not None and memo[0] == key and now - memo[1] < self._revalidate_s:
                row["bundle_valid"] = True
            else:
                need.append(int(row["zid"]))
        if not need:
            return
        valid = {int(r["zid"]): bool(r["valid"])
                 for r in self._rows(VALIDITY_SQL, self._params(zids=need))}
        for row in rows:
            zid = int(row["zid"])
            if zid in valid:
                row["bundle_valid"] = valid[zid]
                if valid[zid]:
                    key = (row["main_tick"], row.get("main_caching_tick"), row["target_lvt"])
                    self._valid_memo[zid] = (key, now)
                else:
                    self._valid_memo.pop(zid, None)

    def page(
        self, after: Optional[Tuple[int, int]], limit: int, stale_cutoff_ms: int,
    ) -> Tuple[List[Tuple[Target, Dict[str, Any]]], Optional[Tuple[int, int]], int]:
        """The next keyset page of SOURCE rows, largest first; returns (the
        targets among them that need work, the cursor for the next page or
        None at the end, how many were live lag). ``after`` is the last
        (participants, zid) of the previous page, None for the first."""
        after_p, after_zid = after if after is not None else (2**31, -1)
        rows = self._rows(PAGE_SQL, self._params(
            after_p=after_p, after_zid=after_zid, limit=limit,
        ))
        if not rows:
            return [], None, 0
        self._annotate_validity(rows, fresh=False)
        out, lagging = [], 0
        for row in rows:
            klass = classify(row, stale_cutoff_ms, accept_source_ahead=self.accept_source_ahead)
            if klass is None:
                lagging += live_lag(row, stale_cutoff_ms)
                continue
            out.append((_target(row, klass), row))
        last = rows[-1]
        return out, (int(last["participants"]), int(last["zid"])), lagging

    def states(self, zids: Iterable[int], stale_cutoff_ms: int, *, fresh: bool = True
               ) -> Dict[int, Tuple[Optional[str], Target]]:
        """{zid: (class or None when nothing is needed, target)} for zids that
        still have a source row; payloads are validated fresh by default."""
        zids = [int(z) for z in zids]
        if not zids:
            return {}
        rows = self._rows(STATE_SQL, self._params(zids=zids))
        self._annotate_validity(rows, fresh=fresh)
        out = {}
        for row in rows:
            klass = classify(row, stale_cutoff_ms, accept_source_ahead=self.accept_source_ahead)
            out[int(row["zid"])] = (klass, _target(row, klass or ""))
        return out

    def state(self, zid: int, stale_cutoff_ms: int) -> Optional[Tuple[Optional[str], Target]]:
        """(class or None, target) for one zid; None when the zid no longer
        has a source row."""
        return self.states([zid], stale_cutoff_ms).get(int(zid))

    def coherent(self, zid: int) -> Tuple[bool, Optional[int], Optional[int]]:
        """(a valid bundle by VALID_BUNDLE_SQL, the generation, target last
        vote ts): the postcondition, the same rule as selection."""
        rows = self._rows(STATE_SQL, self._params(zids=[zid]))
        if not rows or rows[0].get("main_zid") is None:
            return False, None, None
        self._annotate_validity(rows, fresh=True)
        row = rows[0]
        return bool(row["bundle_valid"]), row["main_tick"], row["target_lvt"]

    def input_lvt(self, zid: int) -> int:
        """The votes table's newest vote for zid (0 when it has none)."""
        return int(self._rows(INPUT_LVT_SQL, {"zid": zid})[0]["input_lvt"])

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
        lvt = row["last_vote_timestamp"]
        return (int(row["math_tick"]), int(lvt) if lvt is not None else -1)

    def label_counts(self, stale_cutoff_ms: int) -> Dict[str, int]:
        row = self._rows(LABEL_COUNTS_SQL, self._params(stale_cutoff=stale_cutoff_ms))[0]
        return {k: int(v) for k, v in row.items()}


def _target(row: Dict[str, Any], klass: str) -> Target:
    return Target(
        zid=int(row["zid"]), participants=int(row["participants"]), klass=klass,
        source_lvt=row["source_lvt"], fingerprint=_fingerprint(row),
        target_lvt=row.get("target_lvt"), input_lvt=row.get("input_lvt"),
    )


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
    # Sampled telemetry, all MiB: the observed increment (sampled peak minus
    # starting RSS), the model's estimated standalone peak, the reserved
    # increment, the starting RSS and the absolute sampled peak.
    peak_rss_delta_mb: float = 0.0
    est_mb: float = 0.0
    result_bytes: int = 0
    reserved_mb: float = 0.0
    start_rss_mb: float = 0.0
    peak_rss_mb: float = 0.0


class StateError(ValueError):
    """The state file's content cannot be trusted."""


_STATE_TYPES: Dict[str, Tuple[type, ...]] = {
    "source_env": (str,), "target_env": (str,), "binding": (str,),
    "gate_published": (int,), "gate_approved": (bool,), "gate_records": (list,),
    "paused": (bool,), "failures": (dict,), "totals": (dict,),
    "top_seconds": (list,), "top_memory": (list,),
}


def _check_state(raw: Any) -> None:
    """Schema of the persisted state; raises StateError on anything else."""
    if not isinstance(raw, dict):
        raise StateError(f"top level is {type(raw).__name__}, not an object")
    for key, value in raw.items():
        types = _STATE_TYPES.get(key)
        if types is None:
            continue  # unknown keys are ignored
        if isinstance(value, bool) and bool not in types:
            raise StateError(f"{key} has type bool")
        if not isinstance(value, types):
            raise StateError(f"{key} has type {type(value).__name__}")
    if isinstance(raw.get("gate_published"), int) and raw["gate_published"] < 0:
        raise StateError("gate_published is negative")
    for key in ("gate_records", "top_seconds", "top_memory"):
        for item in raw.get(key, []):
            if not _record_ok(item):
                raise StateError(f"{key} holds a malformed record")
    for key, value in raw.get("totals", {}).items():
        if key not in ALL_OUTCOMES or isinstance(value, bool) or not isinstance(value, int):
            raise StateError("totals holds a malformed entry")
    for key, value in raw.get("failures", {}).items():
        # One explicit integer-key contract (review [1449] D): "--1", "+1",
        # " 1", "1\n" or non-ASCII digits would pass isdigit-style checks
        # and then raise in int() during reconciliation and sweep reporting.
        if not (isinstance(key, str) and _ZID_KEY.fullmatch(key) and isinstance(value, dict)):
            raise StateError("failures holds a malformed entry")
        attempts, next_at, reason = value.get("attempts"), value.get("next_at"), value.get("reason")
        # reason / last are type-checked before set membership: a list or
        # object would raise TypeError (unhashable) instead of StateError.
        if (not _int_ok(attempts) or not _num_ok(next_at)
                or not isinstance(reason, str) or reason not in FAILURE_REASONS
                or ("last" in value and (not isinstance(value["last"], str)
                                         or value["last"] not in ALL_OUTCOMES))
                or any(k in value and not _num_ok(value[k]) for k in ("est_mb", "bound"))
                or any(k in value and not _int_ok(value[k]) for k in ("need_bytes", "est_bytes"))):
            raise StateError("failures holds a malformed entry")


# A failure-map key is a zid as str(int) writes it: ASCII digits, optional
# leading minus, no leading zeros (so no two keys can alias one zid).
_ZID_KEY = re.compile(r"0|-?[1-9][0-9]*")


def _int_ok(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _num_ok(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


# Record fields the sweep, gate and summary lines read without a default
# (review [1447] D); the rest are type-checked when present.
_RECORD_REQUIRED = ("participants", "voters", "votes", "comments", "seconds",
                    "peak_rss_delta_mb", "est_mb")
_RECORD_INTS = ("participants", "voters", "votes", "comments", "result_bytes")


def _record_ok(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    zid = item.get("zid")
    if not isinstance(zid, int) or isinstance(zid, bool):
        return False
    if any(k not in item for k in _RECORD_REQUIRED):
        return False
    for f in fields(Record):
        if f.name == "zid" or f.name not in item:
            continue
        value = item[f.name]
        if f.name in ("klass", "outcome"):
            if not isinstance(value, str):
                return False
        elif f.name in _RECORD_INTS:
            if not _int_ok(value):
                return False
        elif not _num_ok(value):
            return False
    return item.get("outcome", PUBLISHED) in ALL_OUTCOMES


@dataclass
class BackfillState:
    """Carried across restarts when MATH_BACKFILL_STATE_PATH is set. The
    database stays authoritative for what is done; losing this file only
    re-arms the gate, resets backoff and forgets the report tables. A file
    whose content cannot be trusted starts the backfill PAUSED (an operator
    resumes it with SIGUSR2 after looking)."""

    source_env: str = ""
    target_env: str = ""
    # Digest of the calibration settings the gate approval was given under.
    binding: str = ""
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
            _check_state(raw)
        except FileNotFoundError:
            return fresh
        except (OSError, ValueError, TypeError) as exc:
            # TypeError: a schema gap must still take the paused/fresh path
            # rather than stop the scheduler (review [1449] D).
            logger.error(
                "math-backfill: state file untrusted (%s: %s); starting PAUSED with fresh "
                "state (resume with SIGUSR2 after review)", exc.__class__.__name__,
                str(exc)[:120] if isinstance(exc, StateError) else "unreadable",
            )
            fresh.paused = True
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
    """The ten largest by ``key``, one row per zid: the zid's largest
    attempt, whatever its outcome (a later smaller attempt never hides an
    earlier dangerous one)."""
    new = asdict(rec)
    prior = [r for r in rows if r.get("zid") == rec.zid]
    if prior and float(prior[0].get(key, 0.0)) > float(new.get(key, 0.0)):
        new = prior[0]
    rows = [r for r in rows if r.get("zid") != rec.zid] + [new]
    rows.sort(key=lambda r: (-float(r.get(key, 0.0)), int(r["zid"])))
    return rows[:10]


# Bound on the gate table: every attempt during the gate window is kept
# (publications always), and past this many the smallest observed increment
# among the other attempts makes room, so the largest peaks always stay. The
# effective cap is never below gate_after_largest + concurrency, so the
# publications (including any that finish while the gate drains) always fit.
GATE_RECORDS_MAX = 50
# Refusals recorded in the gate table although nothing ran: each is once per
# zid (never retried automatically), and it is the size evidence for the
# window.
_GATE_REFUSALS = frozenset({OVER_MEMORY_CEILING, REFUSED_INPUT_SIZE})


def _gate_append(rows: List[Dict[str, Any]], rec: Record,
                 cap: int = GATE_RECORDS_MAX) -> List[Dict[str, Any]]:
    rows = rows + [asdict(rec)]
    while len(rows) > cap:
        others = [i for i, r in enumerate(rows) if r.get("outcome", PUBLISHED) != PUBLISHED]
        if not others:
            break
        drop = min(others, key=lambda i: float(rows[i].get("peak_rss_delta_mb", 0.0)))
        rows = rows[:drop] + rows[drop + 1:]
    return rows


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
    est_bytes: int      # estimated standalone peak (model, base included)
    need_bytes: int     # reserved increment above the base
    large: bool


class BackfillScheduler:
    """Admits backfill jobs into the poller's pool and records their outcomes.

    ``host`` is the poller's adapter (``service._BackfillHost``): submit,
    pending_zids, is_pending, is_cached, evict, accepts, load_full_history,
    writer, live_poll_health, target_env, admission, parked_count.
    """

    RECONCILE_CHUNK = 200

    def __init__(
        self,
        host: Any,
        store: BackfillStore,
        config: BackfillConfig,
        *,
        clock: Callable[[], float] = time.time,
        rss_fn: Callable[[], int] = read_rss_bytes,
        release_fn: Callable[[], None] = release_memory,
        run_id: Optional[str] = None,
    ) -> None:
        self._host = host
        self._store = store
        self.config = config
        self._clock = clock
        self._rss = rss_fn
        self._release = release_fn
        self._admission: MemoryAdmission = host.admission
        if not self._admission.limited:
            raise ConfigError(
                "the poller's memory limit is unknown (no cgroup limit and no "
                "MATH_POLLER_MEMORY_LIMIT_MB); the backfill needs the shared budget"
            )
        self._model: MemoryModel = self._admission.model
        self.ceiling_bytes = int(config.memory_ceiling_mb * _MB)
        if self.ceiling_bytes and self.ceiling_bytes >= self._admission.limit_bytes:
            raise ConfigError(
                f"MATH_BACKFILL_MEMORY_CEILING_MB={config.memory_ceiling_mb:g} is not "
                f"below the container limit ({self._admission.limit_bytes / _MB:.0f} MiB)"
            )
        # The poller passes its process run id (P-072) so the readiness lines
        # and these report lines bind to one run; standalone, a fresh one.
        if run_id is not None and not re.fullmatch(r"[0-9a-f]{12}", run_id):
            raise ConfigError("run_id must be 12 lowercase hex characters")
        self.run_id = run_id or uuid.uuid4().hex[:12]
        self.binding = self._calibration_binding()
        self._lock = threading.RLock()
        self._state = BackfillState.load(config.state_path, config.source_env, host.target_env)
        self._bind_calibration()
        self._in_flight: Dict[int, _Job] = {}
        self._buffer: Deque[Target] = deque()
        self._cursor: Optional[Tuple[int, int]] = None
        self._sweep_end = False
        self._sweep_no = 0
        self._sweep_admitted = 0
        self._sweep_deferred = 0
        self._sweep_seen = 0
        self._sweep_classes: Dict[str, int] = {}
        self._sweep_live_lag = 0
        self._next_admit_at = 0.0
        self._next_sweep_at = 0.0
        self._vote_window: Deque[Tuple[float, int]] = deque()
        self._done_since_summary = 0
        self._pressure_paused: Optional[str] = None
        self._gate_logged = False
        self._drained_logged = False
        # Readiness evidence (P-072): the last finished sweep's summary and
        # when DRAINED was logged (None while not drained).
        self._last_sweep: Optional[Dict[str, Any]] = None
        self._drained_ms: Optional[int] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- calibration binding ---------------------------------------------- #
    def _calibration_binding(self) -> str:
        """Everything a gate calibration depends on: the memory model, the
        budget and cache budget, and the backfill's size rules."""
        cfg = self.config
        payload = {
            "admission": self._admission.describe(),
            "backfill": {
                "concurrency": cfg.concurrency, "large_threshold": cfg.large_threshold,
                "memory_ceiling_mb": cfg.memory_ceiling_mb, "max_votes": cfg.max_votes,
                "gate_after_largest": cfg.gate_after_largest,
            },
        }
        blob = json.dumps(payload, sort_keys=True, default=str)
        return hashlib.sha256(blob.encode()).hexdigest()[:16]

    def _bind_calibration(self) -> None:
        """Keep a gate approval (and its counters) only under a matching,
        recognized binding. A state file with no binding (the prior schema)
        or a different one re-arms the gate (review [1447] D): a missing
        digest is not proof of a same-configuration approval."""
        st = self._state
        if st.binding != self.binding and (
            st.gate_approved or st.gate_published or st.gate_records
        ):
            logger.warning(
                "math-backfill: calibration settings changed or unbound (binding %s -> %s); "
                "the gate is RE-ARMED and its approval cleared: a reviewed approval is "
                "needed under the new settings", st.binding or "none", self.binding,
            )
            st.gate_approved = False
            st.gate_published = 0
            st.gate_records = []
        st.binding = self.binding
        st.save(self.config.state_path)

    # -- operator controls ------------------------------------------------- #
    def approve_gate(self) -> None:
        with self._lock:
            self._state.gate_approved = True
            self._state.save(self.config.state_path)
        logger.warning("math-backfill: gate APPROVED (run=%s binding=%s); continuing",
                       self.run_id, self.binding)

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
        adm = self._admission
        logger.warning(
            "math-backfill ENABLED run=%s config=%s binding=%s source=%s target=%s "
            "concurrency=%d large_threshold=%d gate_after_largest=%d budget_mb=%.0f "
            "limit_mb=%.0f (%s) ceiling_mb=%s state=%s source_ahead_ruling=%s",
            self.run_id, self.config.digest(), self.binding, self.config.source_env,
            self._host.target_env, self.config.concurrency, self.config.large_threshold,
            self.config.gate_after_largest, adm.budget_bytes / _MB, adm.limit_bytes / _MB,
            adm.source, f"{self.config.memory_ceiling_mb:.0f}" if self.ceiling_bytes else "none",
            "file" if self.config.state_path else "memory-only",
            self.config.source_ahead_ruling,
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
                logger.error("math-backfill: scheduling step failed (%s: %s); retrying",
                             exc.__class__.__name__, _exc_brief(exc))
                wait = 30.0
            self._stop.wait(max(0.05, wait))

    # -- admission ---------------------------------------------------------- #
    def _over_ceiling(self, need: int, est: int) -> bool:
        return (not self._admission.fits_alone(need)) or bool(
            self.ceiling_bytes and est > self.ceiling_bytes)

    def _is_large(self, participants: int, need: int) -> bool:
        cap = self._admission.compute_capacity_bytes() or 0
        return participants > self.config.large_threshold or 2 * need > cap

    def step(self) -> Tuple[str, float]:
        """One admission decision. Returns (status, seconds to wait)."""
        with self._lock:
            now = self._clock()
            self._reap_lost()
            if self._state.paused:
                # SIGUSR2 stops admission; it does not cancel a running job.
                # Confirm the drain once, so an operator (and the S2 handoff)
                # knows nothing is in flight.
                if not self._in_flight and not self._drained_logged:
                    self._drained_logged = True
                    self._drained_ms = int(now * 1000)
                    logger.warning("math-backfill DRAINED run=%s: paused by operator, nothing "
                                   "in flight", self.run_id)
                return "paused_operator", 5.0
            self._drained_logged = False
            self._drained_ms = None
            if self.gate_pending:
                # Admission stops at the publication threshold, but jobs
                # admitted before it are still running: wait for them, so
                # the once-only report carries every attempt of the window.
                if self._in_flight:
                    return "gate", 0.5
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
                if self._in_flight:
                    return "draining", 0.5  # finish the sweep once its jobs report
                self._finish_sweep(now)
                return "sweep_complete", 1.0
            if target.participants > self.config.large_threshold and self._in_flight:
                self._buffer.appendleft(target)
                return "serial_wait", 0.5

            votes, voters, comments = self._store.sizes(target.zid)
            need = self._model.above_base_bytes(votes, voters, comments)
            est = self._model.peak_bytes(votes, voters, comments)
            large = self._is_large(target.participants, need)
            rec = Record(target.zid, target.klass, "", target.participants, voters, votes,
                         comments, est_mb=est / _MB, reserved_mb=need / _MB)
            if large and self._in_flight:
                self._buffer.appendleft(target)
                return "serial_wait", 0.5
            if votes > self.config.max_votes:
                rec.outcome = REFUSED_INPUT_SIZE
                self._record(rec, large=large)
                return REFUSED_INPUT_SIZE, 0.0
            if self._over_ceiling(need, est):
                # Could never fit, whatever else the process holds: report it
                # for a reviewed larger-budget run; never truncate.
                rec.outcome = OVER_MEMORY_CEILING
                self._record(rec, large=large, need=need, est=est)
                return OVER_MEMORY_CEILING, 0.0
            window = self._window_votes(now)
            if window and window + votes > self.config.max_votes_per_min:
                self._buffer.appendleft(target)
                return "vote_budget", 1.0

            job = _Job(target, votes, voters, comments, est, need, large)
            self._in_flight[target.zid] = job
            if not self._host.submit(target.zid):
                self._in_flight.pop(target.zid, None)
                rec.outcome = PARKED_LIVE
                self._record(rec, large=large)
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
            # Re-opened only when the current budget (and ceiling) would hold it.
            need, est = failure.get("need_bytes"), failure.get("est_bytes")
            if not isinstance(need, int) or not isinstance(est, int):
                return False
            return not self._over_ceiling(need, est)
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
            if self._sweep_end:
                return None
            page, cursor, lagging = self._store.page(
                self._cursor, self.config.page_size, self._stale_cutoff_ms(now))
            self._sweep_live_lag += lagging
            if cursor is None:
                self._sweep_end = True
            else:
                self._cursor = cursor
            self._sweep_seen += len(page)
            for target, _ in page:
                self._sweep_classes[target.klass] = self._sweep_classes.get(target.klass, 0) + 1
            self._buffer.extend(t for t, _ in page)

    def _stale_cutoff_ms(self, now: float) -> int:
        return int((now - self.config.stale_grace_s) * 1000)

    # -- sweep end: reconcile, report, and the qualified COMPLETE ------------ #
    def _caught_up_outcome(self, target: Target) -> str:
        """For a valid target that needs no background rebuild (classify gave
        None): ALREADY_COMPLETE only when it is authoritatively caught up with
        its source row; SOURCE_AHEAD (or SOURCE_AHEAD_ACCEPTED under the accept
        ruling) when it reflects every vote in the table but the source claims
        a later one; otherwise LIVE_OWNED (live ingestion owns the tail).
        Review [1447] C: "no eligible background repair" is not "caught up"."""
        row = target.as_row()
        if caught_up(row):
            return ALREADY_COMPLETE
        if source_ahead(row):
            return SOURCE_AHEAD_ACCEPTED if self.config.accept_source_ahead else SOURCE_AHEAD
        return LIVE_OWNED

    def _reconcile_failures(self, now: float) -> Dict[str, int]:
        """Clear saved failures whose target is now valid and authoritatively
        caught up with its source row (repaired by live ingestion or anything
        else), whose source row is gone, or which the encoded source-ahead
        ruling accepts. A valid target that is only in live lag, or
        source-ahead with the ruling unresolved, keeps its failure (review
        [1447] C). Reads the same state and validity as selection, fresh, in
        bounded chunks. Returns {reason: cleared}."""
        cleared: Dict[str, int] = {}
        keys = [k for k in self._state.failures if int(k) not in self._in_flight]
        cutoff = self._stale_cutoff_ms(now)
        for i in range(0, len(keys), self.RECONCILE_CHUNK):
            chunk = keys[i:i + self.RECONCILE_CHUNK]
            states = self._store.states([int(k) for k in chunk], cutoff)
            for key in chunk:
                state = states.get(int(key))
                if state is not None and state[0] is not None:
                    continue  # still needs work: keep the failure
                if state is None:
                    label = "source_gone"
                else:
                    disposition = self._caught_up_outcome(state[1])
                    if disposition == ALREADY_COMPLETE:
                        label = self._state.failures[key]["reason"]
                    elif disposition == SOURCE_AHEAD_ACCEPTED:
                        label = SOURCE_AHEAD_ACCEPTED
                    else:
                        continue  # live lag or unresolved source-ahead: keep
                self._state.failures.pop(key)
                cleared[label] = cleared.get(label, 0) + 1
        if cleared:
            self._state.save(self.config.state_path)
            logger.warning(
                "math-backfill sweep=%d reconciled saved failures against the database: "
                "cleared=%s (now valid and caught up, or no source row)",
                self._sweep_no, json.dumps(cleared, sort_keys=True))
        return cleared

    def _finish_sweep(self, now: float) -> None:
        self._sweep_no += 1
        try:
            reconciled: Any = self._reconcile_failures(now)
        except Exception as exc:  # noqa: BLE001 - reported; completion refused below
            reconciled = {"error": exc.__class__.__name__}
        unresolved = self._unresolved()
        try:
            counts: Dict[str, Any] = self._store.label_counts(self._stale_cutoff_ms(now))
        except Exception as exc:  # noqa: BLE001 - reported; completion refused below
            counts = {"error": exc.__class__.__name__}
        parked = self._host.parked_count()
        logger.warning(
            "math-backfill sweep=%d run=%s config=%s binding=%s seen=%d classes=%s "
            "admitted=%d deferred=%d in_flight=%d live_lag=%d parked_live=%d unresolved=%s "
            "reconciled=%s counts=%s admission=%s totals=%s top_seconds=%s top_memory=%s",
            self._sweep_no, self.run_id, self.config.digest(), self.binding, self._sweep_seen,
            json.dumps(self._sweep_classes, sort_keys=True), self._sweep_admitted,
            self._sweep_deferred, len(self._in_flight), self._sweep_live_lag, parked,
            json.dumps(unresolved, sort_keys=True), json.dumps(reconciled, sort_keys=True),
            json.dumps(counts, sort_keys=True),
            json.dumps(self._admission.snapshot(), sort_keys=True),
            json.dumps(self._state.totals, sort_keys=True),
            [(r["zid"], round(r["seconds"], 1), r.get("outcome", PUBLISHED))
             for r in self._state.top_seconds],
            [(r["zid"], round(r["peak_rss_delta_mb"], 1), r.get("outcome", PUBLISHED))
             for r in self._state.top_memory],
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
        status = self._log_completion(unresolved, reconciled, counts, parked)
        self._last_sweep = {
            "sweep_no": self._sweep_no, "finished_ms": int(now * 1000), "run": self.run_id,
            "config": self.config.digest(), "status": status,
            "unresolved": sum(int(v) for v in unresolved.values()),
            "parked_live": int(parked), "in_flight": len(self._in_flight),
        }
        self._cursor = None
        self._sweep_end = False
        self._buffer.clear()
        self._sweep_seen = self._sweep_admitted = self._sweep_deferred = 0
        self._sweep_live_lag = 0
        self._sweep_classes = {}
        self._next_sweep_at = now + self.config.resweep_s

    def _log_completion(self, unresolved: Dict[str, int], reconciled: Any,
                        counts: Dict[str, Any], parked: int) -> str:
        """COMPLETE means the backfill's own queue is empty on fresh evidence;
        it is not cutover readiness (that is the verification SQL at a fixed
        cutoff, run by the reviewed probe job). Returns the sweep's status for
        the readiness evidence: COMPLETE, NOT_COMPLETE or UNKNOWN."""
        if self._sweep_seen or self._in_flight or any(unresolved.values()):
            return "NOT_COMPLETE"
        blockers = []
        if "error" in counts or (isinstance(reconciled, dict) and "error" in reconciled):
            logger.warning(
                "math-backfill sweep=%d status=UNKNOWN: the fresh aggregate could not be read "
                "(%s); not COMPLETE", self._sweep_no,
                counts.get("error") or reconciled.get("error"))
            return "UNKNOWN"
        blocking = ["missing", "incomplete", "stale"]
        if not self.config.accept_source_ahead:
            # Review [1447] C: unresolved source-ahead blocks COMPLETE even
            # when no saved failure records it (a fresh state file, say).
            blocking.append("source_ahead")
        for key in blocking:
            if counts.get(key):
                blockers.append(f"{key}={counts[key]}")
        if parked:
            blockers.append(f"parked_live={parked}")
        if blockers:
            logger.warning("math-backfill sweep=%d status=NOT_COMPLETE: the sweep found no "
                           "eligible target but the fresh aggregate shows %s",
                           self._sweep_no, " ".join(blockers))
            return "NOT_COMPLETE"
        logger.warning(
            "math-backfill COMPLETE run=%s sweep=%d: the backfill queue is empty (no missing, "
            "incomplete, invalid or stale %s target of a %s conversation; nothing unresolved, "
            "in flight or parked). live_lag=%d is live-owned. source_ahead=%d (ruling=%s). This "
            "is not a cutover proof: run the verification SQL at a fixed cutoff.", self.run_id,
            self._sweep_no, self._host.target_env, self.config.source_env,
            int(counts.get("live_lag", 0)), int(counts.get("source_ahead", 0)),
            self.config.source_ahead_ruling,
        )
        return "COMPLETE"

    def readiness(self) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
        """(the last finished sweep's summary or None, the drain state) for
        the readiness line (P-072). Counts, clocks, digests and closed labels
        only. Lock-free on purpose: the scheduler holds its lock across
        database reads, and the heartbeat must not wait on them. Each field
        is replaced whole, never mutated, so a read sees one consistent value."""
        last = self._last_sweep
        return (dict(last) if last is not None else None,
                {"run": self.run_id, "drained_ms": self._drained_ms})

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
                self._record(self._job_record(job, LOST), large=job.large)

    @staticmethod
    def _job_record(job: _Job, outcome: str) -> Record:
        return Record(job.target.zid, job.target.klass, outcome, job.target.participants,
                      job.voters, job.votes, job.comments, est_mb=job.est_bytes / _MB,
                      reserved_mb=job.need_bytes / _MB)

    # -- execution (pool thread) ------------------------------------------- #
    def run_job(self, zid: int) -> None:
        """Run one admitted job on the zid's pool worker. Never raises."""
        with self._lock:
            job = self._in_flight.get(zid)
        if job is None:  # pragma: no cover - admitted jobs always have an entry
            return
        reservation = None
        try:
            reservation = self._admission.reserve(
                zid, job.need_bytes, kind="backfill", exclusive=job.large, wait=False)
        except Exception as exc:  # noqa: BLE001 - OverBudget: the budget shrank
            logger.error("math-backfill zid=%s: reservation refused (%s: %s)", zid,
                         exc.__class__.__name__, _exc_brief(exc))
        if reservation is None:
            with self._lock:
                self._in_flight.pop(zid, None)
                self._record(self._job_record(job, MEMORY_HEADROOM), large=job.large)
            return
        started = time.monotonic()
        report: Dict[str, Any] = {}
        try:
            start_rss = self._rss()
            sampler = PeakSampler(self._rss)
            with sampler:
                outcome = self._execute(zid, job, report)
        finally:
            self._admission.release(reservation)
        seconds = time.monotonic() - started
        rec = self._job_record(job, outcome)
        rec.seconds = seconds
        rec.start_rss_mb = start_rss / _MB
        rec.peak_rss_mb = sampler.peak / _MB
        rec.peak_rss_delta_mb = max(0, sampler.peak - start_rss) / _MB
        rec.result_bytes = int(report.get("payload_bytes", 0))
        with self._lock:
            self._in_flight.pop(zid, None)
            self._record(rec, large=job.large, compute_s=seconds, ran=True)
        self._release()

    def _execute(self, zid: int, job: _Job, report: Dict[str, Any]) -> str:
        now = self._clock()
        try:
            state = self._store.state(zid, self._stale_cutoff_ms(now))
        except Exception as exc:  # noqa: BLE001
            logger.error("math-backfill zid=%s: state read failed (%s: %s)", zid,
                         exc.__class__.__name__, _exc_brief(exc))
            return FAILED_COMPUTE
        if state is None:
            return ALREADY_COMPLETE  # the source row is gone
        klass, current = state
        if klass is None:
            return self._caught_up_outcome(current)
        if self._host.is_cached(zid):
            # Review [1447] E: live ingestion holds this zid but its
            # publication needs repair. This job runs on the zid's serialized
            # pool worker, so no live computation for it is running: drop the
            # cached conversation (lossless: the next live touch reloads the
            # repaired row) and repair here instead of deferring forever.
            logger.warning("math-backfill zid=%s: live-cached but its publication is %s; "
                           "repairing through the serialized backfill job", zid, klass)
            self._host.evict(zid)
        try:
            # Warm state is restored only from a target that passed
            # validation (STALE); anything else rebuilds cold.
            conv = self._host.load_full_history(zid, restore=current.klass == STALE)
        except Exception as exc:  # noqa: BLE001
            logger.error("math-backfill zid=%s: compute failed (%s: %s)", zid,
                         exc.__class__.__name__, _exc_brief(exc))
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
            logger.error("math-backfill zid=%s: publication failed (%s: %s)", zid,
                         exc.__class__.__name__, _exc_brief(exc))
            return FAILED_WRITE
        finally:
            del conv
        try:
            ok, _tick, target_lvt = self._store.coherent(zid)
        except Exception as exc:  # noqa: BLE001
            logger.error("math-backfill zid=%s: postcondition read failed (%s: %s)", zid,
                         exc.__class__.__name__, _exc_brief(exc))
            return FAILED_POSTCONDITION
        # Backfill never grows the live cache: the rebuilt conversation was
        # never remembered, and anything cached for it is dropped (per-zid
        # serialization means live cannot have cached it during this job).
        self._host.evict(zid)
        if not ok:
            return FAILED_POSTCONDITION
        if current.source_lvt is not None and (target_lvt is None or target_lvt < current.source_lvt):
            # Behind the source after a full-history rebuild: source-ahead only
            # when the target reflects every vote in the table; otherwise a
            # vote arrived during the job and live ingestion owns the tail.
            try:
                input_lvt = self._store.input_lvt(zid)
            except Exception as exc:  # noqa: BLE001
                logger.error("math-backfill zid=%s: input read failed (%s: %s)", zid,
                             exc.__class__.__name__, _exc_brief(exc))
                return FAILED_POSTCONDITION
            return self._caught_up_outcome(Target(
                zid, current.participants, current.klass, current.source_lvt, None,
                target_lvt=target_lvt, input_lvt=input_lvt))
        return PUBLISHED

    def job_skipped(self, zid: int, outcome: str) -> None:
        """The pool ran the zid without our job (parked) — release the slot."""
        with self._lock:
            job = self._in_flight.pop(zid, None)
            if job is not None:
                self._record(self._job_record(job, outcome), large=job.large)

    def job_superseded_by_live(self, zid: int, live_ok: bool) -> None:
        """Live work for the zid coalesced with our job and ran instead."""
        self.job_skipped(zid, SUPERSEDED_LIVE if live_ok else LIVE_OWNED)

    # -- bookkeeping -------------------------------------------------------- #
    def _record(self, rec: Record, *, large: bool, compute_s: float = 0.0,
                need: int = 0, est: int = 0, ran: bool = False) -> None:
        """``ran``: the job held a reservation and executed, so its sampled
        RSS is evidence whatever the outcome (P-073 x.34)."""
        cfg, st, now = self.config, self._state, self._clock()
        assert rec.outcome in ALL_OUTCOMES, rec.outcome
        logger.info(
            "math-backfill zid=%d class=%s outcome=%s participants=%d voters=%d votes=%d "
            "comments=%d seconds=%.2f est_mb=%.1f reserved_mb=%.1f start_rss_mb=%.1f "
            "peak_rss_mb=%.1f peak_rss_delta_mb=%.1f result_bytes=%d",
            rec.zid, rec.klass, rec.outcome, rec.participants, rec.voters, rec.votes,
            rec.comments, rec.seconds, rec.est_mb, rec.reserved_mb, rec.start_rss_mb,
            rec.peak_rss_mb, rec.peak_rss_delta_mb, rec.result_bytes,
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
                                "last": rec.outcome, "est_mb": round(rec.est_mb, 1)}
            if rec.outcome == OVER_MEMORY_CEILING:
                st.failures[key]["need_bytes"] = int(need)
                st.failures[key]["est_bytes"] = int(est)
            elif rec.outcome == REFUSED_INPUT_SIZE:
                st.failures[key]["bound"] = cfg.max_votes
        # Every attempt is evidence (P-073 x.34): a job that ran is in the
        # top lists and the gate table whatever its outcome, and a size
        # refusal is in the gate table, so a dangerous peak is never omitted
        # because its job did not publish. The gate still counts
        # publications only.
        if ran or rec.outcome == PUBLISHED:
            st.top_seconds = _top10(st.top_seconds, rec, "seconds")
            st.top_memory = _top10(st.top_memory, rec, "peak_rss_delta_mb")
        # Collected until the GATE report is emitted: after the publication
        # threshold no new job is admitted, but jobs already in flight drain
        # into the table first (step() waits for them).
        if (cfg.gate_after_largest and not st.gate_approved and not cfg.gate_approved
                and not self._gate_logged
                and (ran or rec.outcome == PUBLISHED or rec.outcome in _GATE_REFUSALS)):
            if rec.outcome == PUBLISHED and st.gate_published < cfg.gate_after_largest:
                st.gate_published += 1
            st.gate_records = _gate_append(
                st.gate_records, rec,
                max(GATE_RECORDS_MAX, cfg.gate_after_largest + cfg.concurrency))
        if compute_s or rec.outcome in (LIVE_OWNED, PARKED_LIVE, LOST, MEMORY_HEADROOM):
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
                "rss_mb=%.0f admission=%s gate=%d/%d%s",
                self.run_id, json.dumps(st.totals, sort_keys=True), len(self._in_flight),
                json.dumps(self._unresolved(), sort_keys=True), self._rss() / _MB,
                json.dumps(self._admission.snapshot(), sort_keys=True),
                st.gate_published, cfg.gate_after_largest,
                " approved" if (st.gate_approved or cfg.gate_approved) else "",
            )

    def _log_gate_once(self) -> None:
        if self._gate_logged:
            return
        self._gate_logged = True
        logger.warning(
            "math-backfill GATE run=%s binding=%s: the first %d publications (in participant "
            "order, not by estimated memory) are done; admission is PAUSED until approval "
            "(SIGUSR1 to the poller, or MATH_BACKFILL_GATE_APPROVED=1). %d attempts follow, "
            "every outcome (failures and size refusals too). Memory figures are "
            "sampled RSS every 0.2 s: an unobserved transient is not ruled out",
            self.run_id, self.binding, self.config.gate_after_largest,
            len(self._state.gate_records),
        )
        for r in self._state.gate_records:
            reserved = r.get("reserved_mb", 0.0)
            ratio = (r["peak_rss_delta_mb"] / reserved) if reserved else 0.0
            logger.warning(
                "math-backfill GATE zid=%d outcome=%s participants=%d voters=%d votes=%d "
                "comments=%d seconds=%.2f start_rss_mb=%.1f peak_rss_mb=%.1f "
                "observed_increment_mb=%.1f reserved_increment_mb=%.1f est_peak_mb=%.1f "
                "observed_over_reserved=%.2f",
                r["zid"], r.get("outcome", PUBLISHED), r["participants"], r["voters"],
                r["votes"], r["comments"],
                r["seconds"], r.get("start_rss_mb", 0.0), r.get("peak_rss_mb", 0.0),
                r["peak_rss_delta_mb"], reserved, r["est_mb"], ratio,
            )


def _fmt(value: Optional[float]) -> str:
    return "none" if value is None else f"{value:.0f}"


def build_scheduler(host: Any, pg: Any, config: BackfillConfig, **kwargs: Any) -> BackfillScheduler:
    """Refuses (ConfigError) a source label equal to the poller's own."""
    if config.source_env.strip() == host.target_env.strip():
        raise ConfigError("MATH_BACKFILL_SOURCE_ENV must differ from the poller's MATH_ENV")
    store = BackfillStore(pg, config.source_env, host.target_env, config.query_timeout_ms,
                          revalidate_s=config.revalidate_s,
                          accept_source_ahead=config.accept_source_ahead)
    return BackfillScheduler(host, store, config, **kwargs)


__all__ = [
    "BackfillConfig", "BackfillScheduler", "BackfillState", "BackfillStore",
    "ConfigError", "ENV_NAMES", "MemoryModel", "Record", "Target", "VALID_BUNDLE_SQL",
    "behind_source", "build_scheduler", "caught_up", "classify", "live_lag", "source_ahead",
    "structurally_coherent",
]
