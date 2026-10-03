"""MathPollerService — the Python replacement for the Clojure math poller.

Two watermark loops (votes, moderation) poll Postgres, group results by zid, and
dispatch per-zid batches to a serialized worker pool.  Each zid keeps a
Conversation in memory; the engine chain is
``update_votes(recompute=False) -> update_moderation(recompute=False) -> recompute()``
and the results are written back to math_main / math_bidtopid / math_ptptstats
under one math_env and one shared math_tick.

Recon anchors (Clojure): poller.clj:12-37 (poll loop + watermark + allow/block),
conv_man.clj:188-207 (load-or-init), :291-388 (actor + error handling).
"""

import logging
import os
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

from polismath.conversation.conversation import Conversation
from polismath.poller.admission import (
    MemoryAdmission,
    OverBudget,
    conversation_dims,
    read_conversation_sizes,
)
from polismath.poller.capacity import SMALL, CapacityRouter, CapacitySettings
from polismath.poller.math_writer import MathWriter, dump_error
from polismath.poller.readiness import classify_error
from polismath.poller.worker_pool import (
    ConversationWorkerPool,
    CoalescedBatch,
    VOTES,
    MODERATION,
    REBUILD,
    BACKFILL,
)

logger = logging.getLogger(__name__)

_MS_PER_DAY = 24 * 60 * 60 * 1000


class PoolDrainTimeout(TimeoutError):
    """``poll_once``'s worker pool did not drain within its join bound.

    A ``TimeoutError`` subclass so existing ``except TimeoutError`` / ``except
    Exception`` handlers (the daemon loops, the ``--once`` CLI) keep matching,
    but distinguishable by type from the socket and database timeouts that
    share the builtin — ``TimeoutError`` is an ``OSError``, so catching the
    builtin alone would also swallow those.
    """


# --------------------------------------------------------------------------- #
# Pure poll-loop helpers (unit-tested in isolation)
# --------------------------------------------------------------------------- #
def advance_watermark(current: int, timestamps: Iterable[int]) -> int:
    """Advance a watermark to max(current, *timestamps); never regress.

    Clojure: ``(apply max 0 last-timestamp (map timestamp-key results))``
    (poller.clj:27).  Because the loop's ``WHERE created > watermark`` is a
    STRICT ``>``, monotonic-max advancement guarantees each row is delivered
    exactly once and the watermark can only move forward.
    """
    result = current
    for ts in timestamps:
        if ts is not None and ts > result:
            result = ts
    return result


def initial_watermark(poll_from_days_ago: float, now_millis: Optional[int] = None) -> int:
    """Starting watermark = now - poll_from_days_ago days (poller.clj:15)."""
    if now_millis is None:
        now_millis = int(time.time() * 1000)
    return int(now_millis - poll_from_days_ago * _MS_PER_DAY)


def should_process_zid(
    zid: int,
    allowlist: List[int],
    blocklist: List[int],
    shard_index: int = 0,
    shard_count: int = 1,
) -> bool:
    """Allow/block filter (poller.clj:30-32), plus zid-sharding.

    Clojure ``cond``: if an allowlist is set, only listed zids pass; else if a
    blocklist is set, listed zids are excluded; else everything passes.  The
    allowlist branch is evaluated first, so it wins over the blocklist.

    Sharding (``shard_count > 1``) selects a slice of zids for this process, so
    that N single-worker PROCESSES can share the fleet's work -- threads cannot
    (measured: threaded serial fraction 0.9884, i.e. 1.0x from 1 to 16 workers;
    independent processes 0.0013, i.e. 15.7x).  The default ``shard_count=1``
    is a no-op, so sharding is strictly opt-in.

    The shard test runs FIRST, and that ordering is a correctness property
    rather than a style choice: a shard must never process a zid outside its
    slice, even one an allowlist names.  ``ConversationWorkerPool`` serialises
    per zid only WITHIN a process, so two shards both accepting one zid would
    run concurrent updates on the same conversation with no mutual exclusion.
    """
    if shard_count > 1 and zid % shard_count != shard_index:
        return False
    if allowlist:
        return zid in allowlist
    if blocklist:
        return zid not in blocklist
    return True


def _newest_input_ms(coalesced: CoalescedBatch) -> Optional[int]:
    """The newest input a batch carries: vote ``created`` or moderation
    ``modified`` (None for a rebuild with no rows)."""
    marks = [v.get("created") for v in coalesced.votes if hasattr(v, "get")]
    marks += [m.get("modified") for m in coalesced.moderation if hasattr(m, "get")]
    marks = [int(m) for m in marks if isinstance(m, (int, float)) and not isinstance(m, bool)]
    return max(marks) if marks else None


def _group_by_zid(rows: List[Dict[str, Any]]) -> Dict[int, List[Dict[str, Any]]]:
    """Group polled rows by zid, preserving row order within each group."""
    grouped: Dict[int, List[Dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(int(row["zid"]), []).append(row)
    return grouped


def _parse_int_list(raw: Optional[str]) -> List[int]:
    if not raw:
        return []
    return [int(x.strip()) for x in raw.split(",") if x.strip()]


def _env_first(*names: str, default: Optional[str] = None) -> Optional[str]:
    """Return the first env var that is set among names, else default.

    Lets us PREFER delphi's existing config.py names while accepting the design
    doc's aliases (documented in the poller package docstring / config mapping).
    """
    for name in names:
        val = os.environ.get(name)
        if val is not None and val != "":
            return val
    return default


def _env_float(name: str, default: Optional[float] = None) -> Optional[float]:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return float(raw)


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
@dataclass
class PollerConfig:
    """Poller configuration.

    Env-var mapping (preferred name first, then design-doc alias):
      database_url       DATABASE_URL
      math_env           MATH_ENV                                   (default 'dev')
      vote_interval_ms   POLL_VOTE_INTERVAL_MS | VOTE_POLLING_INTERVAL | POLL_INTERVAL_MS (1000)
      mod_interval_ms    POLL_MOD_INTERVAL_MS  | MOD_POLLING_INTERVAL | POLL_INTERVAL_MS (1000)
      poll_from_days_ago POLL_FROM_DAYS_AGO                          (default 10)
      allowlist          POLL_ALLOWLIST | MATH_ZID_ALLOWLIST         (default [])
      blocklist          POLL_BLOCKLIST | MATH_ZID_BLOCKLIST         (default [])
      shard_index        POLL_SHARD_INDEX | MATH_SHARD_INDEX        (default 0)
      shard_count        POLL_SHARD_COUNT | MATH_SHARD_COUNT        (default 1 = unsharded)
      worker_pool_size   MATH_WORKER_POOL_SIZE                       (default 4)
      dump_dir           MATH_POLLER_DUMP_DIR                        (default 'scratch/errorconv')
      retry_cap          MATH_POLLER_RETRY_CAP                       (default 1)
      conv_cache_cap     MATH_CONV_CACHE_CAP                (default 200; 0 = unlimited)
      reconcile_interval_ms MATH_POLLER_RECONCILE_INTERVAL_MS        (default 60000)
      memory_limit_mb    MATH_POLLER_MEMORY_LIMIT_MB   (fallback when no cgroup limit)
      memory_headroom    MATH_POLLER_MEMORY_HEADROOM                 (default 0.15)
      conv_cache_mb      MATH_CONV_CACHE_MB        (default 30% of the memory budget)
      mem_*              MATH_POLLER_MEM_BASE_MB, _PER_MCELL_MB, _PER_VOTE_ROW_BYTES,
                         _SAFETY, _JOB_FLOOR_MB, _RETAINED_BASE_MB,
                         _RETAINED_PER_MCELL_MB, _RETAINED_PER_VOTER_KB
                         (polismath.poller.admission)
    """

    database_url: Optional[str] = None
    math_env: str = "dev"
    vote_interval_ms: int = 1000
    mod_interval_ms: int = 1000
    poll_from_days_ago: float = 10
    allowlist: List[int] = field(default_factory=list)
    blocklist: List[int] = field(default_factory=list)
    # zid-sharding: this process handles zids where zid % shard_count ==
    # shard_index.  shard_count=1 (the default) is unsharded -- every zid.
    # One shard = one PROCESS: threads do not parallelise this workload
    # (serial fraction 0.9884, 1.0x at 16 workers), independent processes do
    # (0.0013, 15.7x at 16).  See _validate_shard() for why a bad index must
    # be fatal rather than silently empty.
    shard_index: int = 0
    shard_count: int = 1
    # NOT lowered to 1 for sharding, deliberately: the pool's threads cannot
    # overlap math with math, but the Clojure implementation this replaces does
    # parallelise per conversation, and a >1 pool may still overlap DB write I/O
    # with math.  Treat as a tuning parameter to MEASURE once sharding is
    # deployed -- the cost study measured a CPU-bound tick and cannot settle it.
    worker_pool_size: int = 4
    dump_dir: str = "scratch/errorconv"
    retry_cap: int = 1
    # Max in-memory conversations before LRU-evicting the coldest. Defaults to a
    # FINITE 200 (M4, P-019): an unbounded cache is not acceptable for prod —
    # Clojure's 4h reboot was the de-facto memory cap, which we dropped, so a
    # long shadow soak with no cap grows without bound. 0 = unlimited is retained
    # but must be set EXPLICITLY (and is documented in example.env). An evicted
    # conv is reloaded from math_main + fully rebuilt on next touch (= Clojure
    # restart). Negative caps are rejected in __post_init__ (a negative cap would
    # pop an empty cache forever).
    conv_cache_cap: int = 200
    # Parked-zid reconciler cadence (ms): every interval a background pass
    # rebuilds each parked zid from authoritative history so a conversation that
    # failed and received no subsequent vote is still recovered (M1, P-019).
    reconcile_interval_ms: int = 60000
    # Shared memory admission (polismath.poller.admission). The budget is the
    # cgroup limit (else memory_limit_mb) minus the headroom fraction; the CLI
    # refuses to start when neither limit is known. conv_cache_mb bounds the
    # retained bytes of the live cache (default 30% of the budget); the count
    # cap above still applies too.
    memory_limit_mb: Optional[float] = None
    memory_headroom: float = 0.15
    conv_cache_mb: Optional[float] = None
    mem_base_mb: float = 209.0
    # P-073 §2.1: 116 -> 133 MiB per million cells, 413 -> 1000 B per vote
    # row and a 64 MiB per-job floor, so every recorded production attempt's
    # observed increment is within 0.95 of its reservation. Setting 116, 413
    # and 0 restores the previous model.
    mem_per_mcell_mb: float = 133.0
    mem_per_vote_row_bytes: float = 1000.0
    mem_safety: float = 1.15
    mem_job_floor_mb: float = 64.0
    mem_retained_base_mb: float = 40.0
    mem_retained_per_mcell_mb: float = 30.0
    mem_retained_per_voter_kb: float = 27.0

    def __post_init__(self) -> None:
        self._validate_shard()
        self._validate_cache_cap()
        self._validate_memory()

    def _validate_memory(self) -> None:
        if self.memory_limit_mb is not None and not (self.memory_limit_mb > 0):
            raise ValueError(f"memory_limit_mb must be > 0, got {self.memory_limit_mb}")
        if not (0 <= self.memory_headroom < 1):
            raise ValueError(f"memory_headroom must be in [0, 1), got {self.memory_headroom}")
        if self.conv_cache_mb is not None and not (self.conv_cache_mb >= 0):
            raise ValueError(f"conv_cache_mb must be >= 0, got {self.conv_cache_mb}")

    def _validate_cache_cap(self) -> None:
        """Reject a negative cache cap at construction time (M4, P-019).

        A negative cap makes ``len(self._convs) > cap`` true even when empty, so
        ``_remember`` would ``popitem`` a just-inserted conversation immediately —
        a silently self-defeating cache. 0 = unlimited is a legitimate (documented)
        value; any positive value is a real LRU bound.
        """
        if self.conv_cache_cap < 0:
            raise ValueError(
                f"conv_cache_cap must be >= 0, got {self.conv_cache_cap} "
                "(0 = unlimited; a positive value LRU-evicts the coldest conv)"
            )

    def _validate_shard(self) -> None:
        """Reject an unusable shard slice loudly, at construction time.

        This is the worst failure mode in the whole design if left silent: an
        out-of-range index matches NO zid, so the process starts, polls, logs
        happily and computes nothing.  The fleet looks up while a slice of
        conversations silently goes stale.  Crash instead.
        """
        if self.shard_count < 1:
            raise ValueError(
                f"shard_count must be >= 1, got {self.shard_count} "
                "(1 = unsharded; set POLL_SHARD_COUNT to the fleet size)"
            )
        if not 0 <= self.shard_index < self.shard_count:
            raise ValueError(
                f"shard_index must be in [0, {self.shard_count}), got "
                f"{self.shard_index} -- such a shard would process NO zids "
                "while appearing healthy (set POLL_SHARD_INDEX per instance)"
            )

    @classmethod
    def from_env(cls) -> "PollerConfig":
        return cls(
            database_url=os.environ.get("DATABASE_URL"),
            math_env=os.environ.get("MATH_ENV", "dev"),
            vote_interval_ms=int(
                _env_first(
                    "POLL_VOTE_INTERVAL_MS",
                    "VOTE_POLLING_INTERVAL",
                    "POLL_INTERVAL_MS",
                    default="1000",
                )
            ),
            mod_interval_ms=int(
                _env_first(
                    "POLL_MOD_INTERVAL_MS",
                    "MOD_POLLING_INTERVAL",
                    "POLL_INTERVAL_MS",
                    default="1000",
                )
            ),
            poll_from_days_ago=float(os.environ.get("POLL_FROM_DAYS_AGO", "10")),
            allowlist=_parse_int_list(
                _env_first("POLL_ALLOWLIST", "MATH_ZID_ALLOWLIST")
            ),
            blocklist=_parse_int_list(
                _env_first("POLL_BLOCKLIST", "MATH_ZID_BLOCKLIST")
            ),
            shard_index=int(
                _env_first("POLL_SHARD_INDEX", "MATH_SHARD_INDEX", default="0")
            ),
            shard_count=int(
                _env_first("POLL_SHARD_COUNT", "MATH_SHARD_COUNT", default="1")
            ),
            worker_pool_size=int(os.environ.get("MATH_WORKER_POOL_SIZE", "4")),
            dump_dir=os.environ.get("MATH_POLLER_DUMP_DIR", "scratch/errorconv"),
            retry_cap=int(os.environ.get("MATH_POLLER_RETRY_CAP", "1")),
            conv_cache_cap=int(os.environ.get("MATH_CONV_CACHE_CAP", "200")),
            reconcile_interval_ms=int(
                os.environ.get("MATH_POLLER_RECONCILE_INTERVAL_MS", "60000")
            ),
            memory_limit_mb=_env_float("MATH_POLLER_MEMORY_LIMIT_MB"),
            memory_headroom=_env_float("MATH_POLLER_MEMORY_HEADROOM", 0.15),
            conv_cache_mb=_env_float("MATH_CONV_CACHE_MB"),
            mem_base_mb=_env_float("MATH_POLLER_MEM_BASE_MB", 209.0),
            mem_per_mcell_mb=_env_float("MATH_POLLER_MEM_PER_MCELL_MB", 133.0),
            mem_per_vote_row_bytes=_env_float("MATH_POLLER_MEM_PER_VOTE_ROW_BYTES", 1000.0),
            mem_safety=_env_float("MATH_POLLER_MEM_SAFETY", 1.15),
            mem_job_floor_mb=_env_float("MATH_POLLER_MEM_JOB_FLOOR_MB", 64.0),
            mem_retained_base_mb=_env_float("MATH_POLLER_MEM_RETAINED_BASE_MB", 40.0),
            mem_retained_per_mcell_mb=_env_float("MATH_POLLER_MEM_RETAINED_PER_MCELL_MB", 30.0),
            mem_retained_per_voter_kb=_env_float("MATH_POLLER_MEM_RETAINED_PER_VOTER_KB", 27.0),
        )


# --------------------------------------------------------------------------- #
# Service
# --------------------------------------------------------------------------- #
class _BackfillHost:
    """What the backfill scheduler (polismath.poller.backfill) may touch in the
    service: the pool (as BACKFILL messages), cache membership, the shard
    filter, the first-touch rebuild, the writer and live-poll health."""

    def __init__(self, service: "MathPollerService") -> None:
        self._svc = service
        self.target_env = service.config.math_env
        self.writer = service._writer
        self.admission = service.admission

    def submit(self, zid: int) -> bool:
        assert self._svc._pool is not None
        return self._svc._pool.submit(zid, BACKFILL, [])

    def pending_zids(self) -> set:
        return self._svc._pool.pending_zids() if self._svc._pool is not None else set()

    def is_pending(self, zid: int) -> bool:
        return self._svc._pool is not None and self._svc._pool.is_pending(zid)

    def is_cached(self, zid: int) -> bool:
        with self._svc._convs_lock:
            return zid in self._svc._convs

    def evict(self, zid: int) -> None:
        self._svc._cache_drop(zid)

    def parked_count(self) -> int:
        return len(self._svc._parked)

    def accepts(self, zid: int) -> bool:
        c = self._svc.config
        return should_process_zid(zid, c.allowlist, c.blocklist, c.shard_index, c.shard_count)

    def load_full_history(self, zid: int, restore: bool = False) -> Conversation:
        """The first-touch rebuild. ``restore=False`` (any target that failed
        validation) skips the persisted row: a malformed row, a wrong body zid
        for example, must never be restored into the rebuild that replaces
        it. Set per call on this thread; ``_load_or_init`` keeps its
        signature."""
        if restore:
            return self._svc._load_or_init(zid)
        self._svc._cold_start.active = True
        try:
            return self._svc._load_or_init(zid)
        finally:
            self._svc._cold_start.active = False

    def live_poll_health(self):
        return self._svc._live_poll_health()

    def capacity_refused(self, zid: int, sizes: Tuple[int, int, int]) -> None:
        """An over-ceiling backfill refusal, recorded under its capacity
        disposition (P-073)."""
        self._svc.capacity.observe(zid, sizes=sizes, refused=True)


class MathPollerService:
    """Owns the poll loops, the in-memory conv cache, the worker pool + writer."""

    def __init__(
        self,
        pg_client: Any,
        config: PollerConfig,
        publisher: Any = None,
        backfill_config: Any = None,
        admission: Optional[MemoryAdmission] = None,
        run_id: Optional[str] = None,
        capacity: Optional[CapacityRouter] = None,
    ) -> None:
        self._pg = pg_client
        # The process run id (P-072): shared by the readiness lines and the
        # backfill's sweep/DRAINED lines so the collector can bind them.
        self.run_id = run_id
        self.config = config
        # Shared memory admission (P-070 R1): every compute path reserves here
        # before loading, and the cache's retained bytes are accounted here.
        # Without a known limit (library/test construction) it grants every
        # reservation; scripts/math_poller.py refuses to start in that case.
        self.admission = admission if admission is not None else MemoryAdmission.from_config(config)
        self.admission.set_evictor(self._evict_for_admission)
        # Capacity disposition (P-073): records memory refusals and, with
        # MATH_CAPACITY_ROUTING=1, routes oversized conversations away from
        # this process instead of refusing them over and over.
        self.capacity = capacity if capacity is not None else CapacityRouter(
            self.admission, CapacitySettings.from_env_or_off())
        self._writer = MathWriter(pg_client, publisher=publisher)
        self._bridge_stage = publisher.stage if publisher is not None else lambda stage: None
        self._coordinator_rebuild = publisher is not None
        # LRU order: most-recently-touched zid last, so popitem(last=False) evicts
        # the coldest (see _remember).
        self._convs: "OrderedDict[int, Conversation]" = OrderedDict()
        # One lock covers every cache access, including compound get/touch and
        # store/evict operations. Never hold it across engine work or DB I/O:
        # the pool serializes each zid, and a worker's local reference survives
        # eviction until it publishes and remembers the updated conversation.
        self._convs_lock = threading.Lock()
        # Per-thread flag: the backfill's cold rebuild (see _load_or_init).
        self._cold_start = threading.local()
        self._retry_counts: Dict[int, int] = {}
        self._pool: Optional[ConversationWorkerPool] = None
        self._threads: List[threading.Thread] = []
        self._stop = threading.Event()
        self._vote_wm: Optional[int] = None
        self._mod_wm: Optional[int] = None
        # Set ONLY on a scan that completed without raising. Until then the
        # parked-zid reconciler retries it every cycle (see _reconcile_once);
        # the lock serialises start()/poll_once()/reconciler so a retry cannot
        # run concurrently with the scan it is retrying and double-submit.
        self._startup_repair_done = False
        self._startup_repair_lock = threading.Lock()
        # Live vote-poll health, read by the backfill's admission control:
        # durations (ms) of the last successful polls and the time of the last
        # success. Written only by the vote loop.
        self._vote_poll_ms: "deque[float]" = deque(maxlen=10)
        self._vote_poll_ok_at: Optional[float] = None
        # Discovery-loop evidence for the readiness line (P-072), per loop:
        # successful passes (empty polls count), consecutive successes, wall
        # clock of the last success, failures since it, and the last failure's
        # closed class. Written by the two poll loops only.
        self._health_lock = threading.Lock()
        self._health: Dict[str, Dict[str, Any]] = {
            name: {"successes": 0, "consecutive": 0, "last_success_ms": None,
                   "failures_since_success": 0, "last_error": None, "last_error_ms": None}
            for name in (VOTES, MODERATION)
        }
        # Opt-in pre-switch backfill (P-070). Off unless MATH_BACKFILL=1; a bad
        # backfill setting disables the backfill, never the poller.
        self.backfill = None
        if backfill_config is not None and getattr(backfill_config, "enabled", False):
            from polismath.poller.backfill import ConfigError, build_scheduler

            try:
                if publisher is not None:
                    raise ConfigError("the backfill does not run with a coordinator publisher")
                extra = {"run_id": run_id} if run_id else {}
                self.backfill = build_scheduler(_BackfillHost(self), pg_client, backfill_config,
                                                **extra)
            except ConfigError as exc:
                logger.error("math-backfill DISABLED: %s", exc)
                self.backfill = None
            except Exception as exc:  # noqa: BLE001 - the optional backfill never stops the poller
                logger.error("math-backfill DISABLED: construction failed (%s)",
                             exc.__class__.__name__)
                self.backfill = None

    @property
    def _parked(self) -> set:
        """Parked-zid truth is owned SOLELY by the worker pool — one
        lock-protected set (P-022 R04). This is a READ-ONLY view; the service
        never keeps a second set that could disagree with the pool's. Park and
        unpark always go through ``pool.park`` / ``pool.unpark`` (each atomic
        with the pool's queue/active bookkeeping under the same lock), so an
        interleaving between "mark parked" and "stop the queue" — the old
        divergence bug — is no longer expressible.

        Returns an empty set before the pool is constructed so early lookups are
        safe."""
        if self._pool is None:
            return set()
        return self._pool.parked_zids()

    # -- lifecycle ---------------------------------------------------------- #
    def _ensure_runtime(self) -> None:
        if self._pool is None:
            self._pool = ConversationWorkerPool(
                self._handle_zid, max_workers=self.config.worker_pool_size
            )
        if self._vote_wm is None:
            self._vote_wm = initial_watermark(self.config.poll_from_days_ago)
        if self._mod_wm is None:
            self._mod_wm = initial_watermark(self.config.poll_from_days_ago)

    def start(self) -> None:
        self._ensure_runtime()
        # A boot-time database blip must not abort startup. Before the startup
        # scan existed, start() touched no database at all and a blip was
        # absorbed by the poll loops' own try/except; keep that property. The
        # scan leaves _startup_repair_done False on failure, and the parked-zid
        # reconciler thread started just below retries it every cycle until it
        # succeeds — swallowing the error here must NOT strand dormant mixed
        # generations for the process lifetime, and no vote/moderation traffic
        # is required to trigger the retry. poll_once() deliberately still
        # propagates — the --once contract and
        # test_startup_scan_failure_is_retried depend on it.
        try:
            self._repair_incomplete_snapshots()
        except Exception:
            logger.exception(
                "Startup repair scan failed; continuing without it "
                "(the next poll cycle retries)"
            )
        self._stop.clear()
        self._threads = [
            threading.Thread(target=self._vote_loop, name="vote-poller", daemon=True),
            threading.Thread(target=self._mod_loop, name="mod-poller", daemon=True),
            threading.Thread(
                target=self._reconcile_loop, name="parked-reconciler", daemon=True
            ),
        ]
        for t in self._threads:
            t.start()
        if self.backfill is not None:
            self.backfill.start()
        logger.info(
            "MathPollerService started (math_env=%s pool=%d shard=%s)",
            self.config.math_env,
            self.config.worker_pool_size,
            # Spelled out so a misconfigured fleet is visible in the logs rather
            # than silently leaving a slice of conversations unprocessed.
            f"{self.config.shard_index}/{self.config.shard_count}"
            if self.config.shard_count > 1
            else "unsharded",
        )

    def stop(self) -> None:
        self._stop.set()
        if self.backfill is not None:
            self.backfill.stop()
        for t in self._threads:
            t.join(timeout=5.0)
        if self._pool is not None:
            self._pool.join(timeout=30.0)
            self._pool.shutdown(wait=True)
        logger.info("MathPollerService stopped")

    def run_forever(self) -> None:
        self.start()
        try:
            while not self._stop.is_set():
                self._stop.wait(1.0)
        finally:
            self.stop()

    # -- poll cycles -------------------------------------------------------- #
    def poll_once(self) -> None:
        """Run one vote + one moderation cycle, blocking until processed.

        Used by ``--once`` and the integration test. Raises
        ``PoolDrainTimeout`` (a ``TimeoutError``) if the worker pool has not
        drained within 120 seconds. A timeout does not cancel in-flight work;
        callers must not treat it as completion.
        """
        self._ensure_runtime()
        self._repair_incomplete_snapshots()
        self._poll_votes_once()
        self._poll_moderation_once()
        # Recover any zids parked in earlier cycles even if they got no new votes.
        self._reconcile_once()
        assert self._pool is not None
        if not self._pool.join(timeout=120.0):
            raise PoolDrainTimeout(
                "Poll cycle worker pool did not drain within 120 seconds"
            )

    def _repair_incomplete_snapshots(self) -> None:
        """Schedule legacy partial generations even outside the boot lookback.

        IDEMPOTENT and re-entrant-safe: it is a no-op once it has completed
        successfully, and the flag is set ONLY after the whole scan+submit pass
        returns. A scan failure must propagate, leaving the scan pending; the
        caller decides. ``start()`` catches it so a boot-time blip cannot abort
        startup, and ``_reconcile_once`` — the one daemon path that runs
        without any vote/moderation traffic — retries it every cycle until it
        succeeds. ``poll_once`` still propagates. The lock serialises those
        three entry points so a retry cannot overlap the scan it is retrying
        and submit each zid twice. Once submitted, ordinary worker retry/park
        reconciliation owns recovery, including a failed rebuild with no votes.

        TODO(review E4 - startup REBUILD burst cap): this submits an UNBOUNDED
        number of REBUILDs (each a full vote-history recompute), logs one
        WARNING per zid, and runs before the poll threads start. The scan is
        three seq scans (math_env is unindexed on all three tables) and the
        burst on a large production namespace has not been benchmarked. Wants a
        cap, a summary count log instead of per-zid warnings, an env kill
        switch, and a benchmark. Note R10: poll_once now raises when its
        join(timeout=120) bound is exhausted, so a startup burst that outruns
        that bound fails `--once` rather than reporting success with work
        still pending.

        TODO(review E5 - rebuild-thrash metering): _load_or_init's mismatch
        path discards warm state and re-reads full vote history every time it
        fires, unthrottled. A second writer (Clojure during dual-run) holding
        one table at a different tick would make that zid full-rebuild every
        cycle. Wants a counter/metric so it is visible.

        Both are deliberate follow-ups, not part of this change.
        """
        if self._startup_repair_done:
            return
        assert self._pool is not None
        with self._startup_repair_lock:
            if self._startup_repair_done:  # won by another entry point
                return
            for zid in self._pg.find_incomplete_math_snapshots():
                if should_process_zid(
                    zid, self.config.allowlist, self.config.blocklist,
                    self.config.shard_index, self.config.shard_count,
                ):
                    logger.warning(
                        "Startup repair: incomplete math snapshot for zid=%s "
                        "math_env=%s (missing rows or mismatched math_tick); "
                        "scheduling full rebuild", zid, self.config.math_env,
                    )
                    self._pool.submit(zid, REBUILD, [])
            self._startup_repair_done = True

    def _vote_loop(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self._poll_votes_once()
                self._vote_poll_ms.append((time.monotonic() - started) * 1000.0)
                self._vote_poll_ok_at = time.monotonic()
                self._note_poll(VOTES)
            except Exception as exc:
                self._note_poll(VOTES, exc)
                logger.exception("Vote poll cycle failed")
            self._stop.wait(self.config.vote_interval_ms / 1000.0)

    def _note_poll(self, loop: str, exc: Optional[BaseException] = None) -> None:
        """Record one discovery-loop pass for the readiness evidence."""
        now_ms = int(time.time() * 1000)
        with self._health_lock:
            h = self._health[loop]
            if exc is None:
                h["successes"] += 1
                h["consecutive"] += 1
                h["last_success_ms"] = now_ms
                h["failures_since_success"] = 0
            else:
                h["consecutive"] = 0
                h["failures_since_success"] += 1
                h["last_error"] = classify_error(exc)
                h["last_error_ms"] = now_ms

    def readiness_snapshot(self) -> Dict[str, Any]:
        """Counts, clocks and closed labels for the readiness line (P-072).
        Discovery is the weaker of the two poll loops: the older last success,
        the smaller success counts, the failures of both."""
        with self._health_lock:
            loops = [dict(self._health[VOTES]), dict(self._health[MODERATION])]
        lasts = [h["last_success_ms"] for h in loops]
        errors = sorted((h for h in loops if h["last_error_ms"] is not None),
                        key=lambda h: h["last_error_ms"])
        discovery = {
            "successes": min(h["successes"] for h in loops),
            "consecutive": min(h["consecutive"] for h in loops),
            "last_success_ms": None if None in lasts else min(lasts),
            "failures_since_success": sum(h["failures_since_success"] for h in loops),
            "last_error": errors[-1]["last_error"] if errors else None,
            "last_error_ms": errors[-1]["last_error_ms"] if errors else None,
        }
        if self._pool is not None:
            queue = self._pool.queue_stats()
        else:
            queue = {"pending": 0, "in_flight": 0, "parked": 0, "oldest_live_age_ms": None,
                     "oldest_backfill_age_ms": None, "oldest_work_age_ms": 0}
        # The readiness tick is the quiet-time baseline sampler (P-073 §2.2):
        # re-measured only when nothing is granted or held. The readiness
        # admission keys are closed (readiness.validate_line), so the
        # baseline is logged by the accountant, not added here.
        self.admission.refresh_baseline()
        snap = self.admission.snapshot()
        admission = {
            "budget_mb": snap.get("budget_mb"), "reserved_mb": int(snap.get("reserved_mb") or 0),
            "granted": int(snap.get("granted") or 0), "held": int(snap.get("held") or 0),
            "waiting": int(snap.get("waiting") or 0),
        }
        sweep = drain = config = None
        if self.backfill is not None:
            sweep, drain = self.backfill.readiness()
            config = self.backfill.config.digest()
        return {"discovery": discovery, "queue": queue, "sweep": sweep, "drain": drain,
                "admission": admission, "config": config, "capacity": self.capacity.counts(),
                "loop_marks": tuple(h["successes"] for h in loops)}

    def _live_poll_health(self):
        """(mean ms of the recent successful vote polls or None, seconds since
        the last success or None). Read by the backfill admission control."""
        samples = list(self._vote_poll_ms)
        mean_ms = sum(samples) / len(samples) if samples else None
        ok_at = self._vote_poll_ok_at
        return mean_ms, (None if ok_at is None else time.monotonic() - ok_at)

    def _mod_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._poll_moderation_once()
                self._note_poll(MODERATION)
            except Exception as exc:
                self._note_poll(MODERATION, exc)
                logger.exception("Moderation poll cycle failed")
            self._stop.wait(self.config.mod_interval_ms / 1000.0)

    def _reconcile_loop(self) -> None:
        while not self._stop.is_set():
            self._stop.wait(self.config.reconcile_interval_ms / 1000.0)
            if self._stop.is_set():
                break
            try:
                self._reconcile_once()
            except Exception:
                logger.exception("Reconcile cycle failed")

    def _reconcile_once(self) -> None:
        """Recover parked zids from authoritative history WITHOUT waiting for a
        new vote (M1, P-019).

        The new-batch self-heal (`_unpark`) only fires when a parked conversation
        receives more traffic; a conversation that failed and then goes quiet
        would stay stale until an unrelated restart/eviction. This periodic pass
        unparks each parked zid (which invalidates its cache) and enqueues a
        REBUILD so the worker reloads the full vote history from Postgres and
        re-persists — reprocessing the interval that was skipped when the global
        watermark advanced past the failure.

        It ALSO retries the startup repair scan until that has completed
        successfully once. This is the only daemon path that runs without new
        votes or moderation, so it is the only place a dormant zid with mixed
        math_tick generations can be rediscovered after a boot-time DB error;
        without it, swallowing that error in start() would strand the zid for
        the process lifetime (start() runs no other scan, and the vote/mod
        loops never look outside the watermark lookback). The retry is bounded
        by the reconciler's own cadence, so a persistently failing scan retries
        once per interval rather than hot-looping."""
        assert self._pool is not None
        if not self._startup_repair_done:
            logger.warning(
                "Startup repair scan still pending; retrying it from the "
                "parked-zid reconciler"
            )
            # Swallowed like the parked-zid work below: a still-broken database
            # must not kill the reconciler thread, and the flag stays False so
            # the next cycle retries again.
            try:
                self._repair_incomplete_snapshots()
            except Exception:
                logger.exception(
                    "Startup repair scan retry failed; the next reconcile "
                    "cycle retries"
                )
        for zid in sorted(self._pool.parked_zids()):
            logger.info("Reconciler recovering parked zid=%s (M1)", zid)
            self._unpark(zid)  # clears park + invalidates cache
            self._pool.submit(zid, REBUILD, [])

    def _unpark(self, zid: int) -> None:
        """Self-heal a parked zid when a NEW batch arrives (Clojure retry-chan
        equivalent). Park is transient across cycles: a transient write blip must
        not leave a zid dead until process restart. Clears the retry counter so
        the zid gets a fresh retry budget.

        M1 (P-019): the cached conversation is INVALIDATED here so the next batch
        rebuilds from authoritative history (`_load_or_init` reads the full vote
        stream from Postgres, which still contains the interval that failed and
        was skipped when the global watermark advanced). Reprocessing the new
        batch on the stale cached conv would leave the failed interval missing
        forever. Dropping the cache entry forces `_run_engine` down the
        load-or-init path, which subsumes both the lost and the new votes."""
        if self._pool is None or not self._pool.is_parked(zid):
            return
        self._retry_counts.pop(zid, None)
        self._cache_drop(zid)  # next touch rebuilds full history
        self._pool.unpark(zid)  # pool owns parked truth (P-022 R04)
        logger.info(
            "Un-parked zid=%s: invalidated cache; next batch rebuilds full "
            "history (M1 recovery)", zid,
        )

    def _poll_votes_once(self) -> None:
        assert self._pool is not None
        rows = self._pg.poll_votes_since(self._vote_wm)
        logger.info("Polled %d votes since watermark %s", len(rows), self._vote_wm)
        for zid, batch in _group_by_zid(rows).items():
            if should_process_zid(
                zid,
                self.config.allowlist,
                self.config.blocklist,
                self.config.shard_index,
                self.config.shard_count,
            ):
                self._unpark(zid)  # new batch self-heals a parked zid
                self._pool.submit(zid, VOTES, batch)
        self._vote_wm = advance_watermark(
            self._vote_wm, (r["created"] for r in rows)
        )

    def _poll_moderation_once(self) -> None:
        assert self._pool is not None
        rows = self._pg.poll_moderation_since(self._mod_wm)
        logger.info("Polled %d mod changes since watermark %s", len(rows), self._mod_wm)
        for zid, batch in _group_by_zid(rows).items():
            if should_process_zid(
                zid,
                self.config.allowlist,
                self.config.blocklist,
                self.config.shard_index,
                self.config.shard_count,
            ):
                self._unpark(zid)  # new batch self-heals a parked zid
                self._pool.submit(zid, MODERATION, batch)
        self._mod_wm = advance_watermark(
            self._mod_wm, (r["modified"] for r in rows)
        )

    # -- per-zid processing (runs on pool threads) -------------------------- #
    def _handle_zid(self, zid: int, coalesced: CoalescedBatch) -> Optional[bool]:
        """Returns whether the live work was resolved (False keeps its age
        counting in the readiness evidence, P-072); None for a backfill job."""
        if self._pool is not None and self._pool.is_parked(zid):
            if coalesced.backfill and self.backfill is not None:
                self.backfill.job_skipped(zid, "parked_live")
            return False
        if coalesced.backfill and not coalesced.has_live_work():
            # P-070: a backfill job alone. It never touches the cache, owns
            # its errors and reports its own outcome.
            if self.backfill is not None:
                self.backfill.run_job(zid)
            return None
        live_ok = False
        routed = False
        try:
            routed = self._run_engine(zid, coalesced)
            self._retry_counts.pop(zid, None)
            if not routed:
                self.capacity.resolved(zid)
            live_ok = True
        except OverBudget as error:
            # P-073: a memory refusal is a capacity disposition, not an
            # engine error. Routed (routing on, classified large): resolved
            # for the pool, no dump, retry or park. Otherwise today's path.
            try:
                routed = self._capacity_refusal(zid, coalesced, error)
            except Exception:  # noqa: BLE001 - the record never changes the error path
                logger.exception("capacity: refusal record failed for zid=%s", zid)
            if routed:
                self._retry_counts.pop(zid, None)
                live_ok = True
            else:
                self._on_engine_error(zid, coalesced, error)
        except Exception as error:  # noqa: BLE001 - top of the per-zid boundary
            self._on_engine_error(zid, coalesced, error)
        finally:
            if coalesced.backfill and self.backfill is not None:
                # Live work for the zid ran instead of the backfill job. A
                # routed zid published nothing: the job is deferred, not done.
                self.backfill.job_superseded_by_live(zid, live_ok and not routed)
        return live_ok

    def _remember(self, zid: int, conv: Conversation) -> None:
        """Store a conversation as most-recently-used, LRU-evicting the coldest
        when conv_cache_cap (>0) is exceeded or, with a known memory budget,
        when the cache's retained bytes exceed their budget (3'.c.3). The
        most recently used entry is always kept; its bytes still count against
        the process budget. An evicted conv is reloaded from math_main and
        fully rebuilt on its next touch (= Clojure-restart semantics), so
        eviction is lossless — just a memory/latency trade."""
        with self._convs_lock:
            self._convs[zid] = conv
            self._convs.move_to_end(zid)
            if self.admission.limited:
                voters, comments = conversation_dims(conv)
                self.admission.set_retained(
                    zid, self.admission.model.retained_bytes(voters, comments))
            cap = self.config.conv_cache_cap
            # Review [1447] A: evicting a conversation a worker still holds
            # removes it from the cache, but the accountant keeps its charge
            # until the worker releases it (drop_retained detaches it), so
            # memory still referenced is always counted.
            while len(self._convs) > 1 and (
                (cap and len(self._convs) > cap) or self.admission.over_cache_budget()
            ):
                evicted_zid, _ = self._convs.popitem(last=False)  # coldest
                self.admission.drop_retained(evicted_zid)
                logger.info(
                    "LRU-evicting cold conversation zid=%s (cache cap=%d, retained "
                    "budget=%s); it will reload from math_main + rebuild on next touch",
                    evicted_zid, cap, self.admission.cache_budget_bytes,
                )

    def _cache_drop(self, zid: int) -> None:
        with self._convs_lock:
            self._convs.pop(zid, None)
            self.admission.drop_retained(zid)

    def _evict_for_admission(self, shortfall: int, protect: set) -> int:
        """Evict least-recently-used cached conversations not held by a
        running computation until ``shortfall`` bytes are freed. Called by the
        admission accountant with no admission lock held."""
        freed = 0
        with self._convs_lock:
            for zid in list(self._convs):
                if freed >= shortfall:
                    break
                if zid in protect or self.admission.is_held(zid):
                    continue
                self._convs.pop(zid, None)
                got = self.admission.drop_retained(zid)
                freed += got
                logger.info("memory admission: evicted cached zid=%s (%.0f MiB)",
                            zid, got / (1024 * 1024))
        return freed

    # -- capacity disposition (P-073) ------------------------------------- #
    def _capacity_refusal(self, zid: int, coalesced: CoalescedBatch,
                          error: OverBudget) -> bool:
        """Record a memory refusal under its disposition, classified by the
        conversation's cold-rebuild size (the refusal's own need when the
        size query fails). True when it is routed away (routing on and not
        ``small``): the caller then resolves the live work."""
        sizes = None
        try:
            sizes = read_conversation_sizes(self._pg, zid)
        except Exception as exc:  # noqa: BLE001 - classify from the refusal instead
            logger.warning("capacity: size query failed for zid=%s (%s)", zid,
                           exc.__class__.__name__)
        need = error.need_bytes if sizes is None else None
        if sizes is None and need is None:
            return False
        disposition = self.capacity.observe(zid, sizes=sizes, need=need,
                                            input_ms=_newest_input_ms(coalesced), refused=True)
        if not self.capacity.routing or disposition == SMALL:
            return False
        self._cache_drop(zid)
        self.capacity.note_routed()
        return True

    def _route_before_reserve(self, zid: int, coalesced: CoalescedBatch, cold: bool) -> bool:
        """With routing on: True when this work is routed to the large class
        and must not be computed here. A cold touch or rebuild is sized and
        classified; a warm update is not (its conversation was small when it
        was cached). A recorded large conversation is re-sized only when its
        binding changed or its sizing is older than MATH_CAPACITY_RESIZE_S;
        otherwise new input only advances its record."""
        cap = self.capacity
        if not cap.routing:
            return False
        input_ms = _newest_input_ms(coalesced)
        if cap.is_routed(zid):
            if cap.needs_resize(zid):
                sizes = read_conversation_sizes(self._pg, zid)
                disposition = cap.observe(zid, sizes=sizes, input_ms=input_ms)
            else:
                cap.advance(zid, input_ms)
                disposition = cap.disposition(zid)
        elif cold:
            sizes = read_conversation_sizes(self._pg, zid)
            disposition = cap.observe(zid, sizes=sizes, input_ms=input_ms)
        else:
            return False
        if disposition == SMALL:
            return False
        self._cache_drop(zid)
        cap.note_routed()
        return True

    def _reserve(self, zid: int, conv: Optional[Conversation], coalesced: CoalescedBatch):
        """Reserve this computation's memory before anything is loaded. A
        cold touch or rebuild is sized from the database (vote rows, voters,
        comments); an incremental update from the cached matrix plus the
        batch. Live work waits for room; it is refused only when it could
        never fit."""
        adm = self.admission
        if not adm.limited:
            return adm.reserve(zid, 0, kind="live", stop=self._stop)
        if conv is None:
            votes, voters, comments = read_conversation_sizes(self._pg, zid)
            need = adm.model.above_base_bytes(votes, voters, comments)
            kind = "live_rebuild"
        else:
            voters, comments = conversation_dims(conv)
            batch = coalesced.votes
            new_voters = len({v.get("pid") for v in batch})
            new_comments = len({v.get("tid") for v in batch})
            need = adm.model.above_base_bytes(
                len(batch) + len(coalesced.moderation), voters + new_voters,
                comments + new_comments)
            kind = "live_update"
        return adm.reserve(zid, need, kind=kind, stop=self._stop)

    def _run_engine(self, zid: int, coalesced: CoalescedBatch) -> bool:
        """Compute and publish. Returns True when the work was routed to the
        large class instead (P-073; only with MATH_CAPACITY_ROUTING=1)."""
        if self.capacity.routing:
            with self._convs_lock:
                cold = coalesced.rebuild or zid not in self._convs
            if self._route_before_reserve(zid, coalesced, cold):
                return True
        # M1 (P-019): an explicit rebuild request (parked-zid reconciler) forces a
        # full-history reload even when a cached conv exists — the cached state may
        # be missing the interval that failed before the zid was parked.
        held = False
        with self._convs_lock:
            conv = None if coalesced.rebuild else self._convs.get(zid)
            if conv is not None:
                self._convs.move_to_end(zid)  # LRU touch
                # Review [1447] A: hold the object from this lookup, through
                # any admission wait and the computation, until release. Taken
                # under the cache lock, so no eviction can slip in between.
                self.admission.hold(zid)
                held = True
        try:
            reservation = self._reserve(zid, conv, coalesced)
            try:
                self._compute_and_publish(zid, conv, coalesced)
            finally:
                # Review [1449] A: an immutable recompute caches a distinct
                # replacement whose charge replaces this zid's retained
                # charge, while this frame still references the old object.
                # Only the reservation covers that old object, so drop the
                # reference and the hold BEFORE releasing the reservation;
                # a waiter woken by the release never sees the old object
                # outside the accounting.
                conv = None
                if held:
                    held = False
                    self.admission.unhold(zid)
                self.admission.release(reservation)
        finally:
            # Reached with the hold still taken only when the reservation
            # itself failed or raised (nothing was computed).
            if held:
                conv = None
                self.admission.unhold(zid)
        return False

    def _compute_and_publish(
        self, zid: int, conv: Optional[Conversation], coalesced: CoalescedBatch
    ) -> None:
        if conv is None:
            # First message (or forced rebuild) for this zid: load-or-init (full
            # rebuild + compute from authoritative history).
            #
            # M1/M2 (P-019): write BEFORE caching. If the write fails, the cache
            # keeps the last-good (persisted) state rather than an unpersisted
            # rebuild, so a retry re-derives from Postgres and a park leaves a
            # recoverable cache — never a phantom in-memory-only state.
            conv = self._load_or_init(zid)
            self._writer.write_conv_updates(zid, conv)
            self._remember(zid, conv)
            # The triggering batch is subsumed by the full-history rebuild.
            return

        if coalesced.votes:
            last_ts = advance_watermark(
                conv.last_updated,
                (v.get("created") for v in coalesced.votes),
            )
            conv = conv.update_votes(
                {"votes": coalesced.votes, "lastVoteTimestamp": last_ts},
                recompute=False,
            )
        if coalesced.moderation:
            # Re-derive the FULL current moderation state (idempotent; also
            # captures un-moderation), then apply.
            mods = self._pg.poll_moderation(zid, None)
            conv = conv.update_moderation(mods, recompute=False)

        conv = conv.recompute()
        # M2 (P-019): write BEFORE caching so a write failure does not leave the
        # cache holding a state that was never persisted (which a retry would then
        # apply the batch on top of, double-advancing the temporal state). On
        # write failure the cache still holds the pre-batch conv, so the retry
        # re-applies the (idempotent, created-sorted) batch cleanly.
        self._writer.write_conv_updates(zid, conv)
        self._remember(zid, conv)

    def _restorable(self, zid: int, row: Dict[str, Any]) -> bool:
        """P-070 review [1447] E: warm state is restored only from a row that
        passes the shared validity rule (``bundle_valid``, computed by
        ``load_math_main`` in the same snapshot) and whose body names this
        zid. Anything else rebuilds cold, so a live first touch or rebuild
        never republishes a malformed body (a wrong zid, say)."""
        if row.get("bundle_valid") is False:
            logger.warning(
                "load-or-init: persisted math for zid=%s math_env=%s fails the shared "
                "validity rule; discarding it and rebuilding cold", zid, self.config.math_env)
            return False
        data = row.get("data")
        body_zid = data.get("zid") if isinstance(data, dict) else None
        if body_zid is not None and (isinstance(body_zid, bool) or body_zid != zid):
            logger.warning(
                "load-or-init: persisted math for zid=%s names zid=%r in its body; "
                "discarding it and rebuilding cold", zid, body_zid)
            return False
        return True

    def _load_or_init(self, zid: int) -> Conversation:
        """Mirror Clojure load-or-init (conv_man.clj:188-207).

        Restores warm state from math_main via ``Conversation.from_dict`` when a
        row exists (as of 2026-07-24 this includes base_clusters/zid/group_votes,
        mirroring Clojure's restructure-json-conv — from_dict still does NOT
        restore the rating matrices or the warm smoother state; see the poller
        package docstring's "load-or-init finding"), then ALWAYS rebuilds the
        rating matrices from the full vote history and applies the full
        moderation state.  Non-persisted warm smoother state cold-starts,
        exactly like a Clojure worker restart.

        last_updated is seeded NONZERO-but-low (not wall-clock): ``Conversation``'s
        ``last_updated = last_updated or now`` footgun (conversation.py:205) means a
        cold ``Conversation(str(zid))`` starts at wall-clock now, and
        ``advance_watermark(now, historical_created)`` can never regress it — so
        the wall-clock leaks into math_main.last_vote_timestamp forever (Clojure
        floors at 0 -> true max(created), conversation.clj:161-165). Seeding 1
        (dodging the falsy-0 fallback), or the persisted last_vote_timestamp when
        restoring, lets the full-history update_votes below resolve last_updated to
        the true max(created).
        """
        conv: Optional[Conversation] = None
        row = None
        if not getattr(self._cold_start, "active", False):
            try:
                row = self._pg.load_math_main(zid)
            except Exception:
                logger.exception("load_math_main failed for zid=%s; cold start", zid)
                row = None

        if row and row.get("snapshot_complete") is False:
            logger.warning(
                "load-or-init: incomplete math snapshot for zid=%s math_env=%s "
                "(missing rows or mismatched math_tick); discarding persisted "
                "state and rebuilding full history", zid, self.config.math_env,
            )
            row = None

        if row and row.get("data") and not self._restorable(zid, row):
            row = None

        if row and row.get("data"):
            try:
                self._bridge_stage("before_restore")
                conv = Conversation.from_dict(row["data"])
                # Prefer the persisted last_vote_timestamp column over the blob's
                # last_updated (which a prior wall-clock write may have poisoned).
                # A persisted 0 is legitimate (Clojure's floor) and must be
                # preserved — only a NULL column falls back to the 0 floor. The
                # constructor's `last_updated or now` footgun does not apply to
                # this post-construction assignment.
                persisted_ts = row.get("last_vote_timestamp")
                conv.last_updated = persisted_ts if persisted_ts is not None else 0
                logger.info(
                    "load-or-init: restored warm state (pca/moderation) from "
                    "math_main for zid=%s",
                    zid,
                )
            except Exception:
                logger.exception(
                    "from_dict restore failed for zid=%s; cold start", zid
                )
                conv = None
        if conv is None:
            # NB the nonzero seed dodges the constructor's falsy-0 -> wall-clock
            # fallback; immediately floor to 0 afterwards (Clojure's floor,
            # conversation.clj:161-165) so a zero-votes conversation emits
            # lastVoteTimestamp=0, not the internal seed. Any real vote advances
            # it via max() in update_votes.
            #
            # `zid` (int) passed through AS-IS — NOT str(zid) — since
            # 2026-07-24 (live poller-equivalence harness finding, session
            # 3): Conversation.__init__ just does a bare
            # `self.conversation_id = conversation_id` (no string-specific
            # logic anywhere on that attribute — every `.conversation_id`
            # use site was grepped; the only str() casts are at the
            # DynamoDB boundary, database/dynamodb.py, which already
            # handles either type defensively) and Clojure holds zid as an
            # int throughout, so this was a real, live, one-point Type-
            # mismatch divergence (to_dict()['zid'], every tids[i], every
            # repness.*.tid all trace back to this same conversation_id).
            conv = Conversation(zid, last_updated=1)
            conv.last_updated = 0

        votes = self._pg.poll_votes(zid, None)  # full history, ordered, sign-flipped
        if votes:
            last_ts = advance_watermark(
                conv.last_updated, (v.get("created") for v in votes)
            )
            conv = conv.update_votes(
                {"votes": votes, "lastVoteTimestamp": last_ts}, recompute=False
            )

        mods = self._pg.poll_moderation(zid, None)
        if self._coordinator_rebuild:
            # Snapshot replacement must carry un-moderation across a restore.
            for key in ("mod_out_tids", "mod_in_tids", "meta_tids", "mod_out_ptpts"):
                setattr(conv, key, set())
        conv = conv.update_moderation(mods, recompute=False)
        if self._coordinator_rebuild and row and row.get("data"):
            self._bridge_stage("after_restore")

        conv = conv.recompute()
        return conv

    # -- error handling ----------------------------------------------------- #
    def _on_engine_error(
        self, zid: int, coalesced: CoalescedBatch, error: BaseException
    ) -> None:
        with self._convs_lock:
            conv = self._convs.get(zid)
        dump_error(zid, conv, coalesced, error, self.config.dump_dir)
        attempts = self._retry_counts.get(zid, 0) + 1
        self._retry_counts[zid] = attempts
        if attempts <= self.config.retry_cap:
            logger.error(
                "Conversation update failed for zid=%s (attempt %d/%d); retrying: %s",
                zid,
                attempts,
                self.config.retry_cap,
                error,
            )
            self._requeue(zid, coalesced)
        else:
            logger.error(
                "PARKING zid=%s after %d failed attempts (circuit breaker). "
                "Last error: %s",
                zid,
                attempts,
                error,
            )
            # The pool is the SINGLE owner of parked truth (P-022 R04): park
            # here in one atomic step instead of setting a separate service-side
            # marker first and then calling pool.park. The old two-step sequence
            # let a reconciliation land in the gap — clearing the service marker
            # and queueing a REBUILD that pool.park then dropped — leaving the
            # service (unparked) and pool (parked) permanently disagreeing.
            if self._pool is not None:
                self._pool.park(zid)

    def _requeue(self, zid: int, coalesced: CoalescedBatch) -> None:
        if self._pool is None:
            return
        # Preserve ALL coalesced message kinds on retry (P-022 R03). Dropping the
        # REBUILD flag here was the old bug: a reconciler rebuild that failed once
        # was never re-submitted, and because the reconciler had already cleared
        # the parked marker (`_unpark`) the zid ended up neither parked nor queued
        # — silently lost until an unrelated restart.
        if coalesced.rebuild:
            self._pool.submit(zid, REBUILD, [])
        if coalesced.votes:
            self._pool.submit(zid, VOTES, list(coalesced.votes))
        if coalesced.moderation:
            self._pool.submit(zid, MODERATION, list(coalesced.moderation))
