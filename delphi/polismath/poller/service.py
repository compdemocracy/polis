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
from polismath.utils.engine_mode import (
    ENGINE_MODE_ENV_VAR,
    ENGINE_MODE_CHOICES,
    resolve_engine_mode,
)
from polismath.poller.math_writer import MathWriter, dump_error
from polismath.poller.worker_pool import (
    ConversationWorkerPool,
    CoalescedBatch,
    VOTES,
    MODERATION,
)

logger = logging.getLogger(__name__)

_MS_PER_DAY = 24 * 60 * 60 * 1000


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
      engine_mode        POLISMATH_ENGINE_MODE                      (default None -> compute's own default)
      shard_index        POLL_SHARD_INDEX | MATH_SHARD_INDEX        (default 0)
      shard_count        POLL_SHARD_COUNT | MATH_SHARD_COUNT        (default 1 = unsharded)
      worker_pool_size   MATH_WORKER_POOL_SIZE                       (default 4)
      dump_dir           MATH_POLLER_DUMP_DIR                        (default 'scratch/errorconv')
      retry_cap          MATH_POLLER_RETRY_CAP                       (default 1)
      conv_cache_cap     MATH_CONV_CACHE_CAP                         (default 0 = unlimited)
    """

    database_url: Optional[str] = None
    math_env: str = "dev"
    vote_interval_ms: int = 1000
    mod_interval_ms: int = 1000
    poll_from_days_ago: float = 10
    allowlist: List[int] = field(default_factory=list)
    blocklist: List[int] = field(default_factory=list)
    engine_mode: Optional[str] = None
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
    # Max in-memory conversations before LRU-evicting the coldest. 0 = unlimited
    # (the default preserves current behavior; the compose deploy memory limit is
    # the hard backstop). Clojure's 4h reboot was the de-facto memory cap, which
    # we dropped — set this to bound a long shadow soak; an evicted conv is
    # reloaded from math_main + fully rebuilt on next touch (= Clojure restart).
    conv_cache_cap: int = 0

    def __post_init__(self) -> None:
        self._validate_shard()

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
            engine_mode=os.environ.get(ENGINE_MODE_ENV_VAR),
            shard_index=int(
                _env_first("POLL_SHARD_INDEX", "MATH_SHARD_INDEX", default="0")
            ),
            shard_count=int(
                _env_first("POLL_SHARD_COUNT", "MATH_SHARD_COUNT", default="1")
            ),
            worker_pool_size=int(os.environ.get("MATH_WORKER_POOL_SIZE", "4")),
            dump_dir=os.environ.get("MATH_POLLER_DUMP_DIR", "scratch/errorconv"),
            retry_cap=int(os.environ.get("MATH_POLLER_RETRY_CAP", "1")),
            conv_cache_cap=int(os.environ.get("MATH_CONV_CACHE_CAP", "0")),
        )


# --------------------------------------------------------------------------- #
# Service
# --------------------------------------------------------------------------- #
class MathPollerService:
    """Owns the poll loops, the in-memory conv cache, the worker pool + writer."""

    def __init__(self, pg_client: Any, config: PollerConfig):
        self._pg = pg_client
        self.config = config
        self._writer = MathWriter(pg_client)
        # LRU order: most-recently-touched zid last, so popitem(last=False) evicts
        # the coldest (see _remember).
        self._convs: "OrderedDict[int, Conversation]" = OrderedDict()
        self._retry_counts: Dict[int, int] = {}
        self._parked: set = set()
        self._pool: Optional[ConversationWorkerPool] = None
        self._threads: List[threading.Thread] = []
        self._stop = threading.Event()
        self._vote_wm: Optional[int] = None
        self._mod_wm: Optional[int] = None

    # -- engine-mode passthrough ------------------------------------------- #
    def apply_engine_mode(self) -> str:
        """Propagate the configured engine mode into the process environment so
        the in-process compute (conversation._compute_pca/_compute_clusters,
        which read POLISMATH_ENGINE_MODE at call time) honors it.  Returns the
        resolved mode actually in effect."""
        if self.config.engine_mode:
            if self.config.engine_mode not in ENGINE_MODE_CHOICES:
                logger.warning(
                    "Unknown POLISMATH_ENGINE_MODE=%r; compute will fall back to "
                    "its default",
                    self.config.engine_mode,
                )
            os.environ[ENGINE_MODE_ENV_VAR] = self.config.engine_mode
        return resolve_engine_mode()

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
        self.apply_engine_mode()
        self._ensure_runtime()
        self._stop.clear()
        self._threads = [
            threading.Thread(target=self._vote_loop, name="vote-poller", daemon=True),
            threading.Thread(target=self._mod_loop, name="mod-poller", daemon=True),
        ]
        for t in self._threads:
            t.start()
        logger.info(
            "MathPollerService started (math_env=%s engine_mode=%s pool=%d shard=%s)",
            self.config.math_env,
            resolve_engine_mode(),
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

        Used by ``--once`` and the integration test.
        """
        self.apply_engine_mode()
        self._ensure_runtime()
        self._poll_votes_once()
        self._poll_moderation_once()
        assert self._pool is not None
        self._pool.join(timeout=120.0)

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

    def _unpark(self, zid: int) -> None:
        """Self-heal a parked zid when a NEW batch arrives (Clojure retry-chan
        equivalent). Park is transient across cycles: a transient write blip must
        not leave a zid dead until process restart. Clears the retry counter so
        the zid gets a fresh retry budget; the next batch reprocesses on the
        last-good conv (or a rebuild if it was evicted)."""
        if zid not in self._parked:
            return
        self._parked.discard(zid)
        self._retry_counts.pop(zid, None)
        if self._pool is not None:
            self._pool.unpark(zid)
        logger.info("Un-parked zid=%s: a new batch arrived (self-heal)", zid)

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
        if zid in self._parked:
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
        conv = self._convs.get(zid)
        if conv is not None:
            self._convs.move_to_end(zid)  # LRU touch

        if conv is None:
            # First message for this zid: load-or-init (full rebuild + compute).
            conv = self._load_or_init(zid)
            self._remember(zid, conv)
            self._writer.write_conv_updates(zid, conv)
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
        self._remember(zid, conv)
        self._writer.write_conv_updates(zid, conv)

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
        dump_error(zid, self._convs.get(zid), coalesced, error, self.config.dump_dir)
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
            self._parked.add(zid)
            if self._pool is not None:
                self._pool.park(zid)

    def _requeue(self, zid: int, coalesced: CoalescedBatch) -> None:
        if self._pool is None:
            return
        if coalesced.votes:
            self._pool.submit(zid, VOTES, list(coalesced.votes))
        if coalesced.moderation:
            self._pool.submit(zid, MODERATION, list(coalesced.moderation))
