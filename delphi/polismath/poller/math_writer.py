"""Postgres writer for the math poller.

Writes the three data tables the TS server + legacy clients consume, all under
one math_env string and ONE shared math_tick per cycle, exactly like Clojure's
write-conv-updates! (conv_man.clj:158-169):

    math-tick = inc-math-tick(zid)          ; atomic, postgres.clj:292-295
    upload-math-main      zid math-tick ...  ; postgres.clj:323-338
    upload-math-bidtopid  zid math-tick ...  ; postgres.clj:369-380
    upload-math-ptptstats zid math-tick ...  ; postgres.clj:350-361

The Clojure-exact SQL (caching_tick = MAX+1 subquery, atomic tick upsert) lives
in polismath.database.postgres.PostgresClient; this module orchestrates the
per-cycle write and derives the bidToPid blob.
"""

import json
import logging
import os
import time
import traceback
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def derive_bidtopid(conv: Any, zid: int) -> Dict[str, Any]:
    """Derive the prep-bidToPid blob from a computed Conversation.

    Shape (verified against BOTH sides of the contract):

      * Clojure ``prep-bidToPid`` (conv_man.clj:35-40) emits
        ``{:zid :bidToPid :lastVoteTimestamp}`` where ``:bidToPid`` is
        ``(mapv :members (sort-by :id base-clusters))`` (conversation.clj:585-586)
        — "a vector of member vectors, sorted by base cluster id".

      * The TS server (server/src/utils/participants.ts:33-51,
        pca.ts:20-27 ``members: number[][]``) indexes ``data.bidToPid`` by the
        POSITION of a base-cluster id inside ``base-clusters.id``:
        ``bidToIndex[base_clusters.id[i]] = i`` then ``bidToPid[i]``.

    Python's ``Conversation.base_clusters`` is already sorted ascending by ``id``
    (conversation.py:789) and ``_fold_base_clusters`` (conversation.py:1643-1649)
    writes ``base-clusters.id`` / ``base-clusters.members`` in that same order, so
    ``[c['members'] for c in conv.base_clusters]`` is positionally aligned with
    ``base-clusters.id`` — the exact alignment the server relies on.

    Note on element type: Python pids are strings (poll_votes casts ``str(pid)``),
    whereas Clojure emits integer pids.  The server parseInt()s them
    (participants.ts:53-55) so both work; a parity comparer needs int/str
    tolerance on this field.  Members are left as-is so that
    math_bidtopid.bidToPid and math_main.base-clusters.members stay identical.

    Args:
        conv: A computed Conversation (public attrs only).
        zid: Conversation id.

    Returns:
        ``{"zid": int, "bidToPid": [[pid, ...], ...], "lastVoteTimestamp": int}``
    """
    base_clusters = getattr(conv, "base_clusters", None) or []
    # Defensive: never rely on caller having sorted; sort by id here too
    # (idempotent since conversation.py already keeps them sorted).
    ordered = sorted(base_clusters, key=lambda c: c["id"])
    bid_to_pid: List[List[Any]] = [list(c.get("members", [])) for c in ordered]
    return {
        "zid": zid,
        "bidToPid": bid_to_pid,
        "lastVoteTimestamp": getattr(conv, "last_updated", None),
    }


def derive_ptptstats(conv: Any, zid: int) -> Dict[str, Any]:
    """Derive the prep-ptpt-stats blob (conv_man.clj:90-94).

    ptptstats is a secondary consumer (scoped "replace", not fidelity-critical
    like math_main / math_bidtopid).  We wrap the conversation's public
    ``participant_info`` under the same envelope keys Clojure uses.
    """
    return {
        "zid": zid,
        "ptptstats": getattr(conv, "participant_info", {}) or {},
        "lastVoteTimestamp": getattr(conv, "last_updated", None),
    }


class MathWriter:
    """Writes a computed conversation's results to Postgres for one cycle."""

    def __init__(self, pg_client: Any):
        self._pg = pg_client

    def write_conv_updates(self, zid: int, conv: Any) -> int:
        """Mint one math_tick and write all three data tables with it.

        Returns the math_tick used (handy for logging / tests).
        """
        math_tick = self._pg.increment_math_tick(zid)

        data = conv.to_dict()
        last_vote_timestamp = data.get("lastVoteTimestamp")
        if last_vote_timestamp is None:
            last_vote_timestamp = getattr(conv, "last_updated", None)

        # 1. math_main — client-facing PCA/cluster/repness blob (fidelity-critical)
        self._pg.write_math_main(
            zid,
            data,
            last_vote_timestamp=last_vote_timestamp,
            math_tick=math_tick,
        )
        # 2. math_bidtopid — server bid->pid mapping (fidelity-critical)
        self._pg.write_math_bidtopid(
            zid, data=derive_bidtopid(conv, zid), math_tick=math_tick
        )
        # 3. math_ptptstats — participant stats
        self._pg.write_participant_stats(
            zid, data=derive_ptptstats(conv, zid), math_tick=math_tick
        )

        logger.info(
            "Wrote math results for zid=%s math_tick=%s (main+bidtopid+ptptstats)",
            zid,
            math_tick,
        )
        return math_tick


def dump_error(
    zid: int,
    conv: Any,
    coalesced: Any,
    error: BaseException,
    dump_dir: str,
) -> str:
    """Dump conversation state + failing batch + traceback to an errorconv JSON.

    Mirrors Clojure's conv-update-dump on failure (conv_man.clj:319-323): a
    debugging artefact written before the batch is retried / the zid is parked.

    Returns the path written (best-effort; never raises).
    """
    try:
        os.makedirs(dump_dir, exist_ok=True)
        # ms + short uuid so back-to-back dumps within the same millisecond never
        # collide (the retry-then-park path dumps twice in quick succession).
        stamp = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
        path = os.path.join(dump_dir, f"errorconv-zid{zid}-{stamp}.json")
        try:
            conv_dump = conv.to_dict() if conv is not None else None
        except Exception:  # pragma: no cover - defensive
            conv_dump = {"_dump_error": "conv.to_dict() failed"}
        payload = {
            "zid": zid,
            "error": str(error),
            "traceback": "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            ),
            "batch": {
                "votes": getattr(coalesced, "votes", None),
                "moderation": getattr(coalesced, "moderation", None),
            },
            "conv": conv_dump,
        }
        with open(path, "w") as fh:
            json.dump(payload, fh, default=str)
        logger.error("Dumped failed conversation state for zid=%s to %s", zid, path)
        return path
    except Exception:  # pragma: no cover - dump must never mask the real error
        logger.exception("Unable to write errorconv dump for zid=%s", zid)
        return ""
