"""Per-conversation serialized worker pool with batch coalescing.

Reproduces the Clojure conv-actor semantics (conv_man.clj) without core.async:

  * Each zid is processed by AT MOST ONE thread at a time (strict per-zid
    serialization) — the analog of one go-loop per conv (go-act!, :351-371).
  * Before processing, ALL queued batches for that zid are drained and merged
    (take-all!, :227-234) and split by message-type into a fixed
    [votes, moderation] order (split-batches :247-257, go-act! :368-370).
  * Different zids run concurrently up to ``max_workers`` (bounded pool) — the
    analog of many lightweight go-loops, capped for a thread-based runtime.
"""

import logging
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Deque, Dict, List, Set, Tuple

logger = logging.getLogger(__name__)

# A queued message is (message_type, batch) where message_type is
# "votes" | "moderation" and batch is a list of rows.
Message = Tuple[str, List[Any]]

VOTES = "votes"
MODERATION = "moderation"
# A rebuild request (M1, P-019): force a full-history reload for this zid even
# when the batch carries no votes/moderation. Used by the parked-zid reconciler
# so an inactive conversation can be recovered without waiting for a new vote.
REBUILD = "rebuild"
# A backfill request (P-070): compute this zid from its full history as
# low-priority background work, publishing only if live ingestion has not
# published it first. Admitted by polismath.poller.backfill, never by the poll
# loops. Coalesced with live work for the same zid, the live path runs instead
# (a cache miss is itself a full-history rebuild) and the backfill is told so.
BACKFILL = "backfill"


@dataclass
class CoalescedBatch:
    """The merged work for one processing cycle of a single zid."""

    votes: List[Any] = field(default_factory=list)
    moderation: List[Any] = field(default_factory=list)
    # Set when any REBUILD message was coalesced: the consumer must invalidate the
    # cached conversation and rebuild from authoritative history (M1 recovery).
    rebuild: bool = False
    # Set when a BACKFILL message was coalesced (P-070).
    backfill: bool = False

    def has_work(self) -> bool:
        return bool(self.votes) or bool(self.moderation) or self.rebuild or self.backfill

    def has_live_work(self) -> bool:
        """Anything other than a backfill request."""
        return bool(self.votes) or bool(self.moderation) or self.rebuild


def coalesce_messages(messages: List[Message]) -> CoalescedBatch:
    """Merge queued (type, batch) messages into one CoalescedBatch.

    Flattens every ``votes`` batch into one list (first-appearance order
    preserved) and every ``moderation`` batch into another, mirroring Clojure
    ``split-batches`` grouping by :message-type then flattening each group.
    Processing order (votes before moderation) is imposed by the consumer, which
    always applies ``.votes`` before ``.moderation``.
    """
    votes: List[Any] = []
    moderation: List[Any] = []
    rebuild = False
    backfill = False
    for message_type, batch in messages:
        if message_type == VOTES:
            votes.extend(batch)
        elif message_type == MODERATION:
            moderation.extend(batch)
        elif message_type == REBUILD:
            rebuild = True
        elif message_type == BACKFILL:
            backfill = True
        else:  # pragma: no cover - defensive; unknown types ignored like Clojure
            logger.warning("Ignoring unknown message-type %r", message_type)
    return CoalescedBatch(
        votes=votes, moderation=moderation, rebuild=rebuild, backfill=backfill
    )


class ConversationWorkerPool:
    """Bounded pool that serializes work per zid and coalesces queued batches.

    Args:
        process_fn: callable(zid, CoalescedBatch) invoked once per drained cycle.
        max_workers: max concurrent zids processed at once.
    """

    def __init__(
        self,
        process_fn: Callable[[int, CoalescedBatch], None],
        max_workers: int = 4,
    ) -> None:
        self._process_fn = process_fn
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="conv-worker"
        )
        self._queues: Dict[int, Deque[Message]] = {}
        self._active: Set[int] = set()
        self._parked: Set[int] = set()
        # Readiness evidence (P-072): when each zid's oldest still-queued live
        # and backfill message arrived, and when its current run started.
        # Monotonic seconds; cleared as the worker takes the messages.
        self._queued_live: Dict[int, float] = {}
        self._queued_backfill: Dict[int, float] = {}
        self._running_since: Dict[int, Tuple[float, bool]] = {}
        self._clock = time.monotonic
        self._lock = threading.Lock()
        self._idle = threading.Condition(self._lock)
        self._closed = False

    def park(self, zid: int) -> None:
        """Stop processing a zid (circuit breaker). Queued/future work dropped."""
        with self._lock:
            self._parked.add(zid)
            self._queues.pop(zid, None)
            self._queued_live.pop(zid, None)
            self._queued_backfill.pop(zid, None)

    def unpark(self, zid: int) -> None:
        """Re-enable processing for a previously parked zid (self-heal on new
        work). The Clojure retry-chan self-heals on the next message; park is
        transient across cycles, not a permanent death sentence."""
        with self._lock:
            self._parked.discard(zid)

    def is_parked(self, zid: int) -> bool:
        with self._lock:
            return zid in self._parked

    def parked_zids(self) -> Set[int]:
        """Snapshot of currently-parked zids under the pool lock.

        The pool is the SINGLE owner of parked-zid truth (P-022 R04): the
        service reads its parked set through this method rather than keeping a
        second set that must agree by convention. Returning a fresh copy under
        the lock guarantees the snapshot cannot tear against a concurrent
        park()/unpark()/submit()."""
        with self._lock:
            return set(self._parked)

    def submit(self, zid: int, message_type: str, batch: List[Any]) -> bool:
        """Queue a batch for a zid; ensure exactly one worker drains it.

        Returns False when the message was dropped (pool closed or zid parked),
        True when it was queued. The poll loops ignore the result; the backfill
        scheduler needs it to know whether its job will ever run.
        """
        with self._lock:
            if self._closed or zid in self._parked:
                return False
            self._queues.setdefault(zid, deque()).append((message_type, batch))
            marks = self._queued_backfill if message_type == BACKFILL else self._queued_live
            marks.setdefault(zid, self._clock())
            if zid not in self._active:
                self._active.add(zid)
                self._executor.submit(self._run, zid)
            return True

    def pending_zids(self) -> Set[int]:
        """Snapshot of zids that are being processed or have queued messages."""
        with self._lock:
            return set(self._active) | {z for z, q in self._queues.items() if q}

    def is_pending(self, zid: int) -> bool:
        with self._lock:
            return zid in self._active or bool(self._queues.get(zid))

    def _run(self, zid: int) -> None:
        while True:
            with self._lock:
                q = self._queues.get(zid)
                if not q or zid in self._parked:
                    # Nothing left (or parked mid-flight): release the zid.
                    self._queues.pop(zid, None)
                    self._queued_live.pop(zid, None)
                    self._queued_backfill.pop(zid, None)
                    self._running_since.pop(zid, None)
                    self._active.discard(zid)
                    self._idle.notify_all()
                    return
                messages = list(q)
                q.clear()
                queued = [t for t in (self._queued_live.pop(zid, None),
                                      self._queued_backfill.pop(zid, None)) if t is not None]
                live = any(m[0] != BACKFILL for m in messages)
                started = min(queued) if queued else self._clock()
                # A run inherits the wait of the messages it drained, so a
                # wedged worker keeps ageing its work instead of resetting it.
                self._running_since[zid] = (started, live)

            coalesced = coalesce_messages(messages)
            if coalesced.has_work():
                try:
                    self._process_fn(zid, coalesced)
                except Exception:  # pragma: no cover - process_fn owns its errors
                    logger.exception("Unhandled error processing zid=%s", zid)
            # loop: re-check for messages that arrived while we were processing

    def queue_stats(self) -> Dict[str, Any]:
        """Counts and ages for the readiness line; no zids leave the pool.

        ``oldest_live_age_ms`` / ``oldest_backfill_age_ms``: the longest any
        live (votes, moderation, rebuild) or backfill work has been waiting or
        running, measured from when its oldest message was queued."""
        with self._lock:
            now = self._clock()
            live = list(self._queued_live.values()) + [
                t for t, is_live in self._running_since.values() if is_live]
            backfill = list(self._queued_backfill.values()) + [
                t for t, is_live in self._running_since.values() if not is_live]
            pending = len(self._active | {z for z, q in self._queues.items() if q})
            in_flight = len(self._running_since)
            parked = len(self._parked)

        def age(marks: List[float]):
            return None if not marks else int(max(0.0, now - min(marks)) * 1000)

        live_age, backfill_age = age(live), age(backfill)
        return {
            "pending": pending, "in_flight": in_flight, "parked": parked,
            "oldest_live_age_ms": live_age, "oldest_backfill_age_ms": backfill_age,
            "oldest_work_age_ms": max(live_age or 0, backfill_age or 0),
        }

    def join(self, timeout: float = 30.0) -> bool:
        """Block until all queues are drained and no worker is active.

        Returns True if fully idle, False on timeout. For tests / graceful stop.
        """
        with self._idle:
            return self._idle.wait_for(
                lambda: not self._active and not any(self._queues.values()),
                timeout=timeout,
            )

    def shutdown(self, wait: bool = True) -> None:
        with self._lock:
            self._closed = True
        self._executor.shutdown(wait=wait)
