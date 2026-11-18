"""The recompute line: how long each published recompute of a conversation took.

After every live recompute the poller publishes (a cold load or rebuild from
the whole history, or a warm update of the cached conversation), it writes one
line to standard error that is a JSON object and nothing else, like the
capacity line (CloudWatch Logs Insights then reads its fields without a
``parse``)::

    {"batch_moderation":0,"batch_votes":200,"comments":125,"encode_s":0.005736,
     "label":"python","lines_dropped":0,"load":"warm","math_tick":42,
     "participants":69,"payload_bytes":185107,"prepare_s":0.002534,
     "published_ms":1795060089123,"queue_wait_s":3.8e-05,
     "recompute_cpu_s":0.035159,"recompute_s":0.035161,
     "schema":"math_poller.recompute/1","total_votes":4555,"write_s":6.2e-05,
     "zid":9301}

What each field is:

* ``prepare_s``: wall seconds from the start of the computation (after its
  memory reservation) to the start of ``Conversation.recompute``: cold, the
  persisted row's read and restore, the full vote history's read, the matrix
  build and the moderation read; warm, applying the batch (``update_votes``)
  and, when the batch carries moderation, the moderation re-read and
  ``update_moderation``.
* ``recompute_s``: wall seconds of ``Conversation.recompute`` (PCA, clusters,
  representativeness, comment priorities, participant info).
* ``recompute_cpu_s``: CPU seconds of the worker thread over the same span
  (``time.thread_time``). The per-conversation pool runs each recompute on one
  of its threads, beside other conversations and the poll loops, so the
  process clock would count their work too; the thread clock counts this
  recompute's own thread. Compose runs the engine with its BLAS and OpenMP
  pools at one thread (``OMP_NUM_THREADS``, ``OPENBLAS_NUM_THREADS``,
  ``MKL_NUM_THREADS`` = 1), so there the thread clock is the recompute's whole
  CPU; a process started without them may run library threads it does not
  count. ``recompute_s - recompute_cpu_s`` is time the thread was not running:
  waiting for a CPU or for the interpreter lock.
* ``encode_s``: wall seconds of ``Conversation.to_dict`` and of deriving and
  encoding the three blobs (math_main, bidToPid, ptptstats).
* ``write_s``: wall seconds of the publication: the tick upsert, the three
  writes and the commit (with a coordinator publisher, its publish call).
* ``queue_wait_s``: wall seconds from when the oldest message of the batch was
  queued for the conversation to when the pool took it (read just after it
  coalesced the batch); null when the work did not come through the pool (the
  large worker's rebuild). It ends before the memory reservation, whose wait
  the readiness line reports.
* ``load``: ``cold`` (no cached conversation, or a forced rebuild; it may still
  restore persisted state) or ``warm``.
* ``participants`` and ``comments``: the vote matrix's rows and columns;
  ``total_votes``: its cells holding a vote (each participant's latest vote on
  each comment, passes included), not the count of vote rows;
  ``batch_votes`` and ``batch_moderation``: the rows of this batch (a cold
  load reads the whole history instead, and the batch is subsumed).
* ``math_tick``: the tick the publication wrote; ``payload_bytes``: the three
  encoded blobs; ``label``: the engine's math_env; ``zid``: the conversation.
* ``published_ms``: epoch milliseconds when the publication finished, taken on
  the pool thread, so the line keeps its time if it is written later.
* ``lines_dropped``: how many lines this process has dropped since it started
  because the queue below was full (0 while nothing is lost); every written
  line carries the total, so a loss shows on the next line that is written.

Counts, seconds, times, a tick, closed words and the conversation id: no
comment text, no participant identifier. A line exists only when the
recompute and its publication both completed.

How it is written, so that it can never hold the engine. The pool thread
builds a small record of the scalars above (no reference to the conversation
or the batch) and hands it to a bounded queue without waiting
(``put_nowait``); when the queue is full the record is dropped and counted.
One background daemon thread takes records off the queue, formats each line
and writes it with ``os.write`` on file descriptor 2, holding no Python lock
while the write waits: not through ``logging``, whose handler lock and
``logging.shutdown`` at exit would otherwise wait on a stalled write. So a
standard error that blocks, fails or loses its writer thread costs the engine
nothing but these lines. If the writer thread dies, the next record starts a
new one (at most once per ``RESTART_S``). At exit the queue is flushed for at
most ``EXIT_FLUSH_S``; the writer is a daemon thread, so exit never waits on
it beyond that.

``QUEUE_MAX`` (1,024 lines) is the bound. The engine publishes about one line
every 9 s on weekly average and about one a second in a surge of one busy
conversation; 1,024 lines hold about 17 minutes of a surge (hours of ordinary
traffic) while standard error is slow, and a full queue of these small records
is a few megabytes at most, nothing beside the engine's conversations. A sink
stalled for longer than that loses lines, counted, rather than memory.

The cost on the pool thread is a few clock reads, building one small dict and
one ``put_nowait``. The queue's own mutex is held only for an append or a
pop, never across a write; no query, no other lock, and nothing changes in
what is computed or written.
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import threading
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Optional

SCHEMA = "math_poller.recompute/1"
QUEUE_MAX = 1024
EXIT_FLUSH_S = 1.0
RESTART_S = 60.0

_STOP = object()
_span = threading.local()
_start_lock = threading.Lock()  # taken only while starting the writer thread
_queue: "queue.Queue[Any]" = queue.Queue(maxsize=QUEUE_MAX)
_dropped = 0  # under _queue.mutex
_consumer: Optional[threading.Thread] = None
_last_start: Optional[float] = None
_atexit_registered = False


# --------------------------------------------------------------------------- #
# Timing, on the computing thread
# --------------------------------------------------------------------------- #
@contextmanager
def span() -> Iterator[Dict[str, Any]]:
    """Collect the timings of one computation on this thread. ``timed_recompute``
    and ``note`` record into the innermost open span; with none open they
    record nothing."""
    rec: Dict[str, Any] = {"start": time.perf_counter()}
    outer = getattr(_span, "rec", None)
    _span.rec = rec
    try:
        yield rec
    finally:
        _span.rec = outer


def note(**fields: Any) -> None:
    rec = getattr(_span, "rec", None)
    if rec is not None:
        rec.update(fields)


def timed_recompute(conv: Any) -> Any:
    """``conv.recompute()``, timed into the open span (if any)."""
    rec = getattr(_span, "rec", None)
    if rec is None:
        return conv.recompute()
    wall0, cpu0 = time.perf_counter(), time.thread_time()
    out = conv.recompute()
    cpu1, wall1 = time.thread_time(), time.perf_counter()
    rec["recompute_start"] = wall0
    rec["recompute_s"] = wall1 - wall0
    rec["recompute_cpu_s"] = cpu1 - cpu0
    # The sizes, read now: the span keeps no reference to the conversation,
    # so no memory outlives the computation's reservation through it.
    try:
        stats = getattr(out, "vote_stats", None)
        rec["participants"] = getattr(out, "participant_count", None)
        rec["comments"] = getattr(out, "comment_count", None)
        rec["total_votes"] = stats.get("n_votes") if isinstance(stats, dict) else None
    except Exception:  # noqa: BLE001 - the sizes are for the line only
        pass
    return out


def _seconds(value: Any) -> Optional[float]:
    return None if value is None else round(float(value), 6)


def _count(value: Any) -> Optional[int]:
    return None if value is None else int(value)


def fields(rec: Dict[str, Any], *, zid: int, label: str, load: str,
           batch: Any) -> Optional[Dict[str, Any]]:
    """The line's fields for one computation's span (``batch``: its
    CoalescedBatch), scalars only; None when it did not both recompute and
    publish."""
    if "recompute_s" not in rec or "math_tick" not in rec:
        return None
    return {
        "schema": SCHEMA,
        "label": str(label),
        "zid": int(zid),
        "load": load,
        "math_tick": _count(rec["math_tick"]),
        "queue_wait_s": _seconds(getattr(batch, "queue_wait_s", None)),
        "prepare_s": _seconds(rec["recompute_start"] - rec["start"]),
        "recompute_s": _seconds(rec["recompute_s"]),
        "recompute_cpu_s": _seconds(rec["recompute_cpu_s"]),
        "encode_s": _seconds(rec.get("encode_s")),
        "write_s": _seconds(rec.get("write_s")),
        "payload_bytes": _count(rec.get("payload_bytes")),
        "participants": _count(rec.get("participants")),
        "comments": _count(rec.get("comments")),
        "total_votes": _count(rec.get("total_votes")),
        "batch_votes": len(batch.votes),
        "batch_moderation": len(batch.moderation),
        "published_ms": int(time.time() * 1000),
    }


def emit(rec: Dict[str, Any], **kwargs: Any) -> None:
    """Hand the line for a finished span to the writer thread. Never waits
    for space, never writes, never raises."""
    try:
        body = fields(rec, **kwargs)
        if body is None:
            return
        q = _queue
        try:
            q.put_nowait(body)
        except queue.Full:
            _count_drop(q)
        # Also when full: a dead writer thread is what fills the queue.
        _ensure_consumer()
    except Exception:  # noqa: BLE001 - a lost line must never fail the recompute
        pass


def _count_drop(q: "queue.Queue[Any]") -> None:
    global _dropped
    with q.mutex:
        _dropped += 1


def dropped_total() -> int:
    with _queue.mutex:
        return _dropped


# --------------------------------------------------------------------------- #
# Writing, on the writer thread
# --------------------------------------------------------------------------- #
def format_line(body: Dict[str, Any], dropped: int) -> str:
    return json.dumps(dict(body, lines_dropped=dropped), sort_keys=True,
                      separators=(",", ":"), allow_nan=False) + "\n"


def _write(data: bytes) -> None:
    """Standard error, file descriptor 2, in whole lines (one ``os.write`` of
    a line this size to a pipe is atomic)."""
    view = memoryview(data)
    while view:
        view = view[os.write(2, view):]


def _consume(q: "queue.Queue[Any]") -> None:
    while True:
        body = q.get()
        try:
            if body is _STOP:
                return
            with q.mutex:
                dropped = _dropped
            _write(format_line(body, dropped).encode())
        except Exception:  # noqa: BLE001 - this line is lost; the next one is tried
            pass
        finally:
            q.task_done()


def _ensure_consumer() -> None:
    global _consumer, _last_start, _atexit_registered
    current = _consumer
    if current is not None and current.is_alive():
        return
    with _start_lock:
        if _consumer is not None and _consumer.is_alive():
            return
        now = time.monotonic()
        if _last_start is not None and now - _last_start < RESTART_S:
            return  # a writer thread died recently: lines wait, or drop, until then
        _last_start = now
        thread = threading.Thread(target=_consume, args=(_queue,),
                                  name="recompute-line", daemon=True)
        thread.start()
        _consumer = thread
        if not _atexit_registered:
            atexit.register(_flush_at_exit)
            _atexit_registered = True


def drain(timeout: float) -> bool:
    """Wait at most ``timeout`` seconds for every queued line to be handled.
    True when the queue is empty and nothing is being written."""
    q = _queue
    deadline = time.monotonic() + timeout
    with q.all_tasks_done:
        while q.unfinished_tasks:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            q.all_tasks_done.wait(remaining)
    return True


def _flush_at_exit() -> None:
    consumer = _consumer
    if consumer is not None and consumer.is_alive():
        drain(EXIT_FLUSH_S)


def _reset(maxsize: int = QUEUE_MAX, *, stop_old: bool = True) -> None:
    """A new, empty queue and no writer thread (tests; a forked child). The
    old writer thread, if any, stops when it reaches the end of its queue."""
    global _queue, _dropped, _consumer, _last_start
    old = _queue
    _queue = queue.Queue(maxsize=maxsize)
    _dropped = 0
    _consumer = None
    _last_start = None
    if stop_old:
        try:
            old.put_nowait(_STOP)
        except queue.Full:
            pass


# A forked child has no writer thread, and the parent's queue mutex may have
# been held at the fork: start afresh without touching it.
if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=lambda: _reset(stop_old=False))


__all__ = ["EXIT_FLUSH_S", "QUEUE_MAX", "RESTART_S", "SCHEMA", "drain", "dropped_total",
           "emit", "fields", "format_line", "note", "span", "timed_recompute"]
