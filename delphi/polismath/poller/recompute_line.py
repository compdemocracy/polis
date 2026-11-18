"""The recompute line: how long each published recompute of a conversation took.

After every live recompute the poller publishes (a cold load or rebuild from
the whole history, or a warm update of the cached conversation), it logs one
line that is a JSON object and nothing else, on a dedicated logger with a bare
``%(message)s`` handler, at info level, the way the capacity line is logged
(CloudWatch Logs Insights then reads its fields without a ``parse``)::

    {"batch_moderation":0,"batch_votes":200,"comments":125,"encode_s":0.005736,
     "label":"python","load":"warm","math_tick":42,"participants":69,
     "payload_bytes":185107,"prepare_s":0.002534,"queue_wait_s":3.8e-05,
     "recompute_cpu_s":0.035159,"recompute_s":0.035161,
     "schema":"math_poller.recompute/1","total_votes":4555,"write_s":6.2e-05,
     "zid":9301}

What each field is:

* ``prepare_s``: wall seconds from the start of the computation to the start
  of ``Conversation.recompute``: cold, the persisted row's read and restore,
  the full vote history's read, the matrix build and the moderation read;
  warm, applying the batch (``update_votes``) and, when the batch carries
  moderation, the moderation re-read and ``update_moderation``.
* ``recompute_s``: wall seconds of ``Conversation.recompute`` (PCA, clusters,
  representativeness, comment priorities, participant info).
* ``recompute_cpu_s``: CPU seconds of the worker thread over the same span
  (``time.thread_time``). The per-conversation pool runs each recompute on one
  of its threads, beside other conversations and the poll loops, so the
  process clock would count their work too; the thread clock counts this
  recompute's own thread. It does not count helper threads a numerical
  library may start for large products. ``recompute_s - recompute_cpu_s`` is
  time the thread was not running: waiting for a CPU, for the interpreter
  lock, or for such helpers.
* ``encode_s``: wall seconds of ``Conversation.to_dict`` and of deriving and
  encoding the three blobs (math_main, bidToPid, ptptstats).
* ``write_s``: wall seconds of the publication: the tick upsert, the three
  writes and the commit (with a coordinator publisher, its publish call).
* ``queue_wait_s``: wall seconds from when the oldest message of the batch was
  queued for the conversation to when the pool took it; null when the work did
  not come through the pool (the large worker's rebuild). It ends before the
  memory reservation, whose wait the readiness line reports.
* ``load``: ``cold`` (no cached conversation, or a forced rebuild) or ``warm``.
* ``participants`` and ``comments``: the vote matrix's rows and columns;
  ``total_votes``: its cells holding a vote (each participant's latest vote on
  each comment, passes included, moderated-out participants excluded);
  ``batch_votes`` and ``batch_moderation``: the rows of this batch (a cold
  load reads the whole history instead, and the batch is subsumed).
* ``math_tick``: the tick the publication wrote; ``payload_bytes``: the three
  encoded blobs; ``label``: the engine's math_env; ``zid``: the conversation.

Counts, seconds, a tick, closed words and the conversation id: no comment
text, no participant identifier. A line is logged only when the recompute and
its publication both completed. Building or logging it can never raise into
the recompute: any failure is swallowed, and the line is lost.

The cost is a few clock reads and one log call per recompute: no query, no
new lock on the hot path (the one below configures the logger once), and
nothing changes in what is computed or written.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Optional

from polismath.poller.capacity import _CurrentStderr

SCHEMA = "math_poller.recompute/1"
LINE_LOGGER = "math_poller.recompute_line"

_lock = threading.Lock()
_span = threading.local()


def _line_logger() -> logging.Logger:
    log = logging.getLogger(LINE_LOGGER)
    if not getattr(log, "_recompute_configured", False):
        with _lock:
            if not getattr(log, "_recompute_configured", False):
                handler = _CurrentStderr()
                handler.setFormatter(logging.Formatter("%(message)s"))
                log.addHandler(handler)
                log.setLevel(logging.INFO)
                log.propagate = False
                log._recompute_configured = True  # type: ignore[attr-defined]
    return log


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


def build_line(rec: Dict[str, Any], *, zid: int, label: str, load: str,
               batch: Any) -> Optional[str]:
    """The line for one computation's span (``batch``: its CoalescedBatch);
    None when it did not both recompute and publish."""
    if "recompute_s" not in rec or "math_tick" not in rec:
        return None
    body = {
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
    }
    return json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False)


def emit(rec: Dict[str, Any], **fields: Any) -> None:
    """Log the line for a finished span. Never raises."""
    try:
        line = build_line(rec, **fields)
        if line is not None:
            _line_logger().info("%s", line)
    except Exception:  # noqa: BLE001 - a lost line must never fail the recompute
        pass


__all__ = ["LINE_LOGGER", "SCHEMA", "build_line", "emit", "note", "span", "timed_recompute"]
