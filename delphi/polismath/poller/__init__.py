"""polismath.poller — Python replacement for the Clojure math poller (phase 1).

A service that polls Postgres for votes/moderation, maintains per-conversation
math state in-memory, and writes the same Postgres tables the TS server + legacy
clients consume.  See ``delphi/docs/MATH_POLLER_DESIGN.md`` for the full recon
and cutover plan.

Architecture
------------
::

    scripts/math_poller.py (CLI)
      └─ service.MathPollerService
           ├─ vote loop   (thread): poll_votes_since(wm)      cadence VOTE_POLLING_INTERVAL
           ├─ mod  loop   (thread): poll_moderation_since(wm)  cadence MOD_POLLING_INTERVAL
           │     both group-by zid, allow/block filter, advance watermark to max(ts)
           ├─ worker_pool.ConversationWorkerPool
           │     one FIFO queue + single-owner flag per zid  -> strict per-zid
           │     serialization; drains+coalesces queued batches (votes-before-
           │     moderation); bounded concurrency across zids
           ├─ engine: Conversation held in memory per zid
           │     update_votes(recompute=False) -> update_moderation(recompute=False)
           │       -> recompute()      (POLISMATH_ENGINE_MODE honored)
           ├─ load-or-init (first message per zid): from_dict(math_main) warm
           │     restore + full-history rating-matrix rebuild
           ├─ math_writer.MathWriter: math_main (caching_tick=MAX+1), math_bidtopid
           │     (derived from base_clusters), math_ptptstats — one shared math_tick
           └─ error path: dump conv+batch JSON -> retry once -> park zid (breaker)

Clojure provenance for every duty is cited inline in each module.

bidToPid shape (VERIFIED against both ends of the contract)
-----------------------------------------------------------
``math_bidtopid.data`` = ``{"zid", "bidToPid", "lastVoteTimestamp"}`` where
``bidToPid`` is a LIST OF PID-LISTS, positionally aligned with
``math_main.base-clusters.id`` (ascending by base-cluster id):

* Clojure ``prep-bidToPid`` (math/src/polismath/conv_man.clj:35-40) wraps
  ``:bid-to-pid`` = ``(mapv :members (sort-by :id base-clusters))``
  (math/src/polismath/math/conversation.clj:585-586) — "a vector of member
  vectors, sorted by base cluster id".
* The TS server (server/src/utils/participants.ts:33-51 with pca.ts:20-27
  ``base-clusters.members: number[][]``) indexes ``data.bidToPid`` by the
  position of a bid inside ``base-clusters.id``:
  ``bidToIndex[base_clusters.id[i]] = i`` then ``indexToPids[bidToIndex[bid]]``.

Python's ``Conversation.base_clusters`` is sorted ascending by ``id``
(conversation.py:789) and ``_fold_base_clusters`` writes ``base-clusters.id`` /
``.members`` in that order (conversation.py:1643-1649), so
``[c['members'] for c in conv.base_clusters]`` is the exact alignment the server
needs.  ``derive_bidtopid`` (math_writer.py) implements this.  Pids are strings
Python-side (poll_votes casts ``str(pid)``) vs ints Clojure-side; the server
parseInt()s them (participants.ts:53-55), so a parity comparer needs int/str
tolerance on this one field.

load-or-init finding (from_dict restoration is PARTIAL)
-------------------------------------------------------
``Conversation.from_dict`` (conversation.py:2249-2303) restores from a dict with
underscore/nested keys: ``last_updated, participant_count, comment_count,
vote_stats, moderation{...}, pca{center,comps}, proj, group_clusters, repness,
participant_info, comment_priorities``.  ``Conversation.to_dict`` (used as the
math_main ``data`` blob) is a SUPERSET that carries those same underscore keys
alongside the hyphenated Clojure keys, so ``from_dict(to_dict(conv))`` round-trips
the listed fields — notably the PCA warm-start vectors and prior moderation.

But ``from_dict`` does NOT restore: ``raw_rating_mat`` / ``rating_mat`` (the vote
matrices), ``base_clusters``, ``subgroup_clusters``, ``group_clusterings`` /
``group_k_smoother`` (warm smoother state), ``consensus`` or ``group_votes``.
Therefore load-or-init ALWAYS rebuilds the rating matrices from the full vote
history (``poll_votes(zid)`` ordered by zid,tid,pid,created — parity with
conv-poll offset 0) and recomputes base_clusters; the non-persisted smoother
state cold-starts.  This is CLOSE TO — but not byte-identical with — a Clojure
worker restart: on restart Clojure ``restructure-json-conv`` RESTORES
``base-clusters`` (and the PCA) from the persisted blob before its ``:reboot``
recompute (conv_man.clj:173 keeps ``:base-clusters`` in the subset, :180 unfolds
them), whereas Python re-derives base_clusters cold
from the vote matrices.  The rating-matrix rebuild itself matches
(conv_man.clj:188-207 rebuilds ``raw-rating-mat`` the same way), and we
opportunistically seed the warm PCA start from ``from_dict`` when a row exists
(low-risk, literally what ``restructure-json-conv`` does).  The base-cluster
lineage difference is a KNOWN divergence to trace against Clojure's ``:reboot``
semantics before the parity gate; a full cold rebuild is otherwise correct —
just without Clojure's restored-lineage warm start.

Config var mapping (config.py names PREFERRED, design aliases accepted)
-----------------------------------------------------------------------
======================  ==============================================  =======
PollerConfig field      Env var(s) (first set wins)                     Default
======================  ==============================================  =======
database_url            DATABASE_URL                                    —
math_env                MATH_ENV                                        dev
vote_interval_ms        POLL_VOTE_INTERVAL_MS | VOTE_POLLING_INTERVAL |
                        POLL_INTERVAL_MS                                1000
mod_interval_ms         POLL_MOD_INTERVAL_MS | MOD_POLLING_INTERVAL |
                        POLL_INTERVAL_MS                                1000
poll_from_days_ago      POLL_FROM_DAYS_AGO                              10
allowlist               POLL_ALLOWLIST | MATH_ZID_ALLOWLIST             []
blocklist               POLL_BLOCKLIST | MATH_ZID_BLOCKLIST             []
engine_mode             POLISMATH_ENGINE_MODE                           improved
worker_pool_size        MATH_WORKER_POOL_SIZE                           4
dump_dir                MATH_POLLER_DUMP_DIR                            scratch/errorconv
retry_cap               MATH_POLLER_RETRY_CAP                           1
======================  ==============================================  =======

``POLL_VOTE_INTERVAL_MS`` / ``POLL_MOD_INTERVAL_MS`` / ``POLL_ALLOWLIST`` /
``POLL_BLOCKLIST`` are the names already present in
``polismath.components.config.py`` (:216-269, previously unwired);
``VOTE_POLLING_INTERVAL`` / ``MOD_POLLING_INTERVAL`` / ``MATH_ZID_ALLOWLIST`` /
``MATH_ZID_BLOCKLIST`` are the design-doc aliases.  (config.py's example default
for the mod interval was 5000ms; the binding design §3 uses 1000ms, adopted here.)

Usage
-----
::

    # Run the service (blocks; SIGTERM/SIGINT -> graceful stop)
    uv run python scripts/math_poller.py

    # Single poll cycle then exit (smoke test / cron-style)
    uv run python scripts/math_poller.py --once

Shadow-mode deployment writes under a DISTINCT ``MATH_ENV`` (e.g. ``delphi``)
next to the Clojure ``math`` container; ``UNIQUE(zid, math_env)`` keeps the rows
invisible to the prod server until cutover.
"""

from polismath.poller.service import (
    MathPollerService,
    PollerConfig,
    advance_watermark,
    initial_watermark,
    should_process_zid,
)
from polismath.poller.worker_pool import (
    ConversationWorkerPool,
    CoalescedBatch,
    coalesce_messages,
)
from polismath.poller.math_writer import MathWriter, derive_bidtopid, dump_error

__all__ = [
    "MathPollerService",
    "PollerConfig",
    "advance_watermark",
    "initial_watermark",
    "should_process_zid",
    "ConversationWorkerPool",
    "CoalescedBatch",
    "coalesce_messages",
    "MathWriter",
    "derive_bidtopid",
    "dump_error",
]
