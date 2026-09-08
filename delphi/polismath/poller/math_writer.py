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
per-cycle write and derives the bidToPid blob. Python publishes the tick and
all three tables in ONE transaction so readers never see a partial commit.
"""

import json
import logging
import os
import time
import traceback
import uuid
from typing import Any, Dict, List, Optional

import numpy as np

from polismath.utils.clj_hash import clojure_hash_map_key_order

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

    Note on element type: as of 2026-07-24 (poller-equivalence harness live
    debugging), ``PostgresClient.poll_votes``/``poll_votes_since`` no longer
    cast ``str(pid)`` — pids are native ints Python-side, matching Clojure's
    integer pids, end-to-end. (Before that date this docstring said Python
    pids were strings; that was a real, unintentional divergence — the CSV/
    certify replay driver never cast pid at all and already matched clj
    int-for-int, so the live poller path was the outlier, not the norm.) The
    server still ``parseInt()``s either form defensively
    (participants.ts:53-55), so this is stronger-than-required parity, not a
    behavior change for it. Members are left as-is so that
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


def _unfold_group_members(conv: Any) -> List[Dict[str, Any]]:
    """``[{"id": gid, "members": [pid, ...]}, ...]`` — each group's
    base-cluster members (bids) expanded to participant ids via
    ``conv.base_clusters``. Reimplemented locally rather than calling
    ``Conversation._unfolded_group_clusters`` (a private method) so this
    module stays testable against lightweight ``SimpleNamespace`` fakes
    exposing only public attrs — the same pattern :func:`derive_bidtopid`
    already uses (it re-sorts ``base_clusters`` itself rather than calling
    a conv method too)."""
    base_clusters = getattr(conv, "base_clusters", None) or []
    bid_to_pids = {c["id"]: list(c.get("members", [])) for c in base_clusters}
    unfolded = []
    for g in getattr(conv, "group_clusters", None) or []:
        members: List[Any] = []
        for bid in g.get("members", []):
            members.extend(bid_to_pids.get(bid, []))
        unfolded.append({"id": g["id"], "members": members})
    return unfolded


def _group_iteration_order(groups: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Clojure's ``group-data`` map (``conv_man.clj``'s ``(into {} (map (fn
    [{:keys [id members]}] [id {...}]) group-clusters))``) is an ARRAY-map
    (insertion / ``group-clusters`` order) for <=8 groups but a
    ``PersistentHashMap`` (HAMT id-hash order) for >8 groups — the EXACT same
    threshold ``legacy_kmeans.py``'s ``cleared-clusters`` scan order already
    documents and relies on (same :func:`clojure_hash_map_key_order`
    utility). Polis "groups" (as opposed to the finer base-clusters) are
    almost always a handful, so this only matters in pathological cases —
    but getting it right costs one function call."""
    if len(groups) <= 8:
        return groups
    order = clojure_hash_map_key_order([g["id"] for g in groups])
    by_id = {g["id"]: g for g in groups}
    return [by_id[gid] for gid in order]


def _columnize(rows: List[Dict[str, Any]]) -> Dict[str, List[Any]]:
    """Mirrors Clojure's ``columnize`` (conv_man.clj:79-88): transpose a list
    of per-participant stat dicts into ``{key: [val, val, ...]}`` using the
    FIRST row's key set (every row shares the same keys by construction
    here). An EMPTY ``rows`` returns ``{}`` — NOT a dict of empty-array
    columns — matching Clojure's own empty-seq behavior (``(-> stats first
    keys)`` on ``()`` is ``nil``, so ``columnize`` degenerates to
    ``(into {} nil)`` = ``{}``)."""
    if not rows:
        return {}
    keys = list(rows[0].keys())
    return {k: [r[k] for r in rows] for k in keys}


def derive_ptptstats(
    conv: Any, zid: int, user_vote_counts: Optional[Dict[Any, int]] = None,
) -> Dict[str, Any]:
    """Derive the prep-ptpt-stats blob (conv_man.clj:90-94), matching
    Clojure's COLUMNAR shape verbatim — a REAL py-poller bug fix, 2026-07-24
    (poller-equivalence harness live debugging session 2): production
    consumers read the clj shape, and what this function emitted before this
    date (a bare wrap of ``conv.participant_info``) was not merely
    differently-SHAPED but a COMPLETELY DIFFERENT STATISTIC — Python's
    ``participant_info`` is vote-correlation-based (n_agree/n_disagree/
    n_pass/group_correlations, ``_compute_participant_info_optimized``),
    while Clojure's ``ptptstats`` is GEOMETRIC (distance-to-center in the
    PCA-projected plane, ``repness/participant-stats``, math/repness.clj:
    383-413). ``participant_info`` is left UNTOUCHED — it's still consumed
    elsewhere (run_math_pipeline.py, narrative reporting) under its own,
    Python-only semantics (crosslang.py explicitly excludes it from the
    clj-parity acceptance surface); this function no longer reads it at all.

    Verbatim port of ``repness/participant-stats``:

        bid->pid       = base-clusters id -> members (participant ids)
        global-center  = mean of ALL in-conv participants' proj positions
        for each group (base-cluster ids expanded to participant ids):
          center            = mean of THIS group's participants' proj positions
          extreme-direction = normalise(center - global-center)
          for each participant pid in the group:
            centricness = 1 - |proj[pid] - global-center|
            coreness    = 1 - |proj[pid] - center|
            extremeness = dot(proj[pid] - center, extreme-direction)
            n-votes     = user_vote_counts.get(pid)  (None if missing, like
                          Clojure's (get ptpt-vote-counts pid) -> nil)

    then COLUMNIZED (:func:`_columnize`) into ``{pid, gid, n-votes,
    centricness, coreness, extremeness}``, each a same-length, positionally-
    aligned array — group visitation order via :func:`_group_iteration_order`
    (Clojure array-map vs hash-map, threshold 8).

    ``user_vote_counts`` is the caller's ALREADY-COMPUTED
    ``data["user-vote-counts"]`` (from ``conv.to_dict()``, needed for
    math_main anyway) rather than recomputed here — keeps this function
    testable against lightweight fakes with no pandas dependency, and avoids
    a second full vote-count pass per write cycle.

    Structural fidelity verified against a REAL clj-ref row captured live
    (real_data/.local/replays/poller_equiv/vw/main/clj-ref/batch-000/
    math_ptptstats.json, 2026-07-24 vw full-run) — see
    tests/poller/test_math_writer.py::TestDerivePtptstatsMatchesLiveClj.
    """
    user_vote_counts = user_vote_counts or {}
    groups = _group_iteration_order(_unfold_group_members(conv))
    proj = getattr(conv, "proj", None) or {}

    rows: List[Dict[str, Any]] = []
    if groups and proj:
        positions = np.array(list(proj.values()), dtype=float)
        global_center = positions.mean(axis=0)

        for g in groups:
            members = [pid for pid in g["members"] if pid in proj]
            if not members:
                continue
            member_positions = np.array([proj[pid] for pid in members], dtype=float)
            center = member_positions.mean(axis=0)
            direction = center - global_center
            norm = float(np.linalg.norm(direction))
            extreme_direction = direction / norm if norm > 0 else direction

            for pid in members:
                pos = np.asarray(proj[pid], dtype=float)
                rows.append({
                    "pid": pid,
                    "gid": g["id"],
                    "n-votes": user_vote_counts.get(pid),
                    "centricness": float(1 - np.linalg.norm(pos - global_center)),
                    "coreness": float(1 - np.linalg.norm(pos - center)),
                    "extremeness": float(np.dot(pos - center, extreme_direction)),
                })

    return {
        "zid": zid,
        "ptptstats": _columnize(rows),
        "lastVoteTimestamp": getattr(conv, "last_updated", None),
    }


class MathWriter:
    """Writes a computed conversation's results to Postgres for one cycle."""

    def __init__(self, pg_client: Any):
        self._pg = pg_client

    def write_conv_updates(self, zid: int, conv: Any) -> int:
        """Atomically mint one math_tick and publish all three data tables.

        Returns the math_tick used (handy for logging / tests).
        """
        data = conv.to_dict()
        last_vote_timestamp = data.get("lastVoteTimestamp")
        if last_vote_timestamp is None:
            last_vote_timestamp = getattr(conv, "last_updated", None)

        # Derive blobs before opening the transaction/holding any row locks.
        bidtopid = derive_bidtopid(conv, zid)
        ptptstats = derive_ptptstats(conv, zid, data.get("user-vote-counts", {}))
        with self._pg.transaction() as connection:
            # The tick upsert locks this (zid, math_env) until all three writes
            # commit. Other zids use independent connections on the shared client.
            math_tick = self._pg.increment_math_tick(zid, connection=connection)
            self._pg.write_math_main(
                zid, data, last_vote_timestamp=last_vote_timestamp,
                math_tick=math_tick, connection=connection,
            )
            self._pg.write_math_bidtopid(
                zid, data=bidtopid, math_tick=math_tick, connection=connection,
            )
            self._pg.write_participant_stats(
                zid, data=ptptstats, math_tick=math_tick, connection=connection,
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
