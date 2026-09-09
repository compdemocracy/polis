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
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

from polismath.conversation.conversation import Conversation
from polismath.poller.math_writer import MathWriter, dump_error
from polismath.poller.worker_pool import (
    ConversationWorkerPool,
    CoalescedBatch,
    VOTES,
    MODERATION,
    REBUILD,
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

    def __post_init__(self) -> None:
        self._validate_shard()
        self._validate_cache_cap()

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
        )


# --------------------------------------------------------------------------- #
# Service
# --------------------------------------------------------------------------- #
class MathPollerService:
    """Owns the poll loops, the in-memory conv cache, the worker pool + writer."""

    def __init__(self, pg_client: Any, config: PollerConfig) -> None:
        self._pg = pg_client
        self.config = config
        self._writer = MathWriter(pg_client)
        # LRU order: most-recently-touched zid last, so popitem(last=False) evicts
        # the coldest (see _remember).
        self._convs: "OrderedDict[int, Conversation]" = OrderedDict()
        # One lock covers every cache access, including compound get/touch and
        # store/evict operations. Never hold it across engine work or DB I/O:
        # the pool serializes each zid, and a worker's local reference survives
        # eviction until it publishes and remembers the updated conversation.
        self._convs_lock = threading.Lock()
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
            try:
                self._poll_votes_once()
            except Exception:
                logger.exception("Vote poll cycle failed")
            self._stop.wait(self.config.vote_interval_ms / 1000.0)

    def _mod_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._poll_moderation_once()
            except Exception:
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
        with self._convs_lock:
            self._convs.pop(zid, None)  # next touch rebuilds full history
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
    def _handle_zid(self, zid: int, coalesced: CoalescedBatch) -> None:
        if self._pool is not None and self._pool.is_parked(zid):
            return
        try:
            self._run_engine(zid, coalesced)
            self._retry_counts.pop(zid, None)
        except Exception as error:  # noqa: BLE001 - top of the per-zid boundary
            self._on_engine_error(zid, coalesced, error)

    def _remember(self, zid: int, conv: Conversation) -> None:
        """Store a conversation as most-recently-used, LRU-evicting the coldest
        when conv_cache_cap (>0) is exceeded. An evicted conv is reloaded from
        math_main and fully rebuilt on its next touch (= Clojure-restart
        semantics), so eviction is lossless — just a memory/latency trade."""
        with self._convs_lock:
            self._convs[zid] = conv
            self._convs.move_to_end(zid)
            cap = self.config.conv_cache_cap
            if cap and len(self._convs) > cap:
                while len(self._convs) > cap:
                    evicted_zid, _ = self._convs.popitem(last=False)  # coldest
                    logger.info(
                        "LRU-evicting cold conversation zid=%s (cache cap=%d); it will "
                        "reload from math_main + rebuild on next touch",
                        evicted_zid, cap,
                    )

    def _run_engine(self, zid: int, coalesced: CoalescedBatch) -> None:
        with self._convs_lock:
            conv = self._convs.get(zid)
            if conv is not None:
                self._convs.move_to_end(zid)  # LRU touch

        # M1 (P-019): an explicit rebuild request (parked-zid reconciler) forces a
        # full-history reload even when a cached conv exists — the cached state may
        # be missing the interval that failed before the zid was parked.
        if coalesced.rebuild:
            conv = None

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

        if row and row.get("data"):
            try:
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
        conv = conv.update_moderation(mods, recompute=False)

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
