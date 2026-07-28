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


@dataclass
class CoalescedBatch:
    """The merged work for one processing cycle of a single zid."""

    votes: List[Any] = field(default_factory=list)
    moderation: List[Any] = field(default_factory=list)

    def has_work(self) -> bool:
        return bool(self.votes) or bool(self.moderation)


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
    for message_type, batch in messages:
        if message_type == VOTES:
            votes.extend(batch)
        elif message_type == MODERATION:
            moderation.extend(batch)
        else:  # pragma: no cover - defensive; unknown types ignored like Clojure
            logger.warning("Ignoring unknown message-type %r", message_type)
    return CoalescedBatch(votes=votes, moderation=moderation)


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
    ):
        self._process_fn = process_fn
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="conv-worker"
        )
        self._queues: Dict[int, Deque[Message]] = {}
        self._active: Set[int] = set()
        self._parked: Set[int] = set()
        self._lock = threading.Lock()
        self._idle = threading.Condition(self._lock)
        self._closed = False

    def park(self, zid: int) -> None:
        """Stop processing a zid (circuit breaker). Queued/future work dropped."""
        with self._lock:
            self._parked.add(zid)
            self._queues.pop(zid, None)

    def unpark(self, zid: int) -> None:
        """Re-enable processing for a previously parked zid (self-heal on new
        work). The Clojure retry-chan self-heals on the next message; park is
        transient across cycles, not a permanent death sentence."""
        with self._lock:
            self._parked.discard(zid)

    def is_parked(self, zid: int) -> bool:
        with self._lock:
            return zid in self._parked

    def submit(self, zid: int, message_type: str, batch: List[Any]) -> None:
        """Queue a batch for a zid; ensure exactly one worker drains it."""
        with self._lock:
            if self._closed or zid in self._parked:
                return
            self._queues.setdefault(zid, deque()).append((message_type, batch))
            if zid not in self._active:
                self._active.add(zid)
                self._executor.submit(self._run, zid)

    def _run(self, zid: int) -> None:
        while True:
            with self._lock:
                q = self._queues.get(zid)
                if not q or zid in self._parked:
                    # Nothing left (or parked mid-flight): release the zid.
                    self._queues.pop(zid, None)
                    self._active.discard(zid)
                    self._idle.notify_all()
                    return
                messages = list(q)
                q.clear()

            coalesced = coalesce_messages(messages)
            if coalesced.has_work():
                try:
                    self._process_fn(zid, coalesced)
                except Exception:  # pragma: no cover - process_fn owns its errors
                    logger.exception("Unhandled error processing zid=%s", zid)
            # loop: re-check for messages that arrived while we were processing

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
