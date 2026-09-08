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
           │       -> recompute()
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
needs.  ``derive_bidtopid`` (math_writer.py) implements this.

UPDATE 2026-07-24 (poller-equivalence harness live debugging, quirk finding):
until this date, ``PostgresClient.poll_votes``/``poll_votes_since`` cast
``str(pid)`` at ingress, while Clojure holds the DB's native int pid
throughout — the server's ``parseInt()`` (participants.ts:53-55) papered over
it, but it made ``bidToPid``/``base-clusters.members`` diverge bit-for-bit
from a live clj container (confirmed: the CSV/certify replay driver never
cast pid at all, and its blobs already matched clj int-for-int).
``Conversation.update_votes`` is deliberately type-agnostic at ingress
(``ptpt_id = vote.get('pid')``/``comment_id = vote.get('tid')  # Preserve
original type``) and raw_rating_mat/rating_mat are ALWAYS rebuilt fresh from
these two methods on load-or-init (never restored via ``from_dict`` — see
this file's "load-or-init finding" section), so removing the ``str()`` cast
was a one-point fix with no other code changes needed: pids are now native
ints end-to-end, Python-side AND Clojure-side, and ``derive_bidtopid``'s
``_normalize_bidtopid``-style int/str tolerance is now redundant
defensive-coding for this field rather than a load-bearing requirement
(kept — harmless, and guards a future regression).

UPDATE 2026-07-24, same day (session 3): ``tid`` (and ``zid``) had the
IDENTICAL bug, just masked by the sheer volume of pid divergences until
session 2's fix above landed — a follow-up live vw full-run then showed
``Type mismatch: golden=int, current=str`` on the top-level ``zid``, every
``tids[i]``, and every ``repness.<gid>[i].tid``. Fixed the same way, same
day: ``poll_votes``/``poll_votes_since`` no longer cast ``str(tid)`` either,
``poll_moderation`` (the single-zid full-state variant — NOT
``poll_moderation_since``, which already used int) no longer casts
``str()`` on tid OR pid (needed for internal consistency once votes-side
ids became int — see ``postgres.py``'s ``poll_moderation`` docstring for
why a stale str-tid there would have silently DISABLED moderated-out
comment zeroing), and ``polismath/poller/service.py``'s cold-start
``Conversation(str(zid), ...)`` construction now passes the int through.
The certified/CSV replay driver never cast tid (or zid) either, and matched
clj int-for-int across 20 cross-validated entries — the evidence that
authorized this follow-up fix. The scattered ``int(tid) if
isinstance(tid, str) and tid.isdigit()`` idioms elsewhere in
conversation.py are DEFENSIVE normalizers (no-ops on an already-int input),
not evidence tid needed to stay a string.

load-or-init finding (from_dict restoration is PARTIAL — updated 2026-07-24)
-----------------------------------------------------------------------------
``Conversation.from_dict`` (conversation.py:2818-2966) restores from a dict with
underscore/nested keys: ``zid, last_updated, participant_count, comment_count,
vote_stats, moderation{...}, pca{center,comps}, proj, group_clusters,
base_clusters, group_votes, repness, participant_info, comment_priorities``.
``Conversation.to_dict`` (used as the math_main ``data`` blob) is a SUPERSET
that carries those same underscore keys alongside the hyphenated Clojure keys,
so ``from_dict(to_dict(conv))`` round-trips the listed fields — notably the PCA
warm-start vectors, prior moderation, base-cluster LINEAGE (id/members, unfolded
exactly as Clojure's restructure-json-conv, conv_man.clj:171-186 ->
clusters.clj unfold-clusters), and group-votes (needed by the recovery tick's
comment-priorities calc, Q2, conversation.clj:658).

As of 2026-07-24, ``base_clusters`` / ``zid`` / ``group_votes`` ARE restored
(conversation.py:2905-2921 base_clusters, :2923-2952 group_votes) — this note
previously said they were NOT; that was fixed to mirror Clojure's
restructure-json-conv (conv_man.clj:173 keeps ``:base-clusters`` in the
subset, :180 unfolds them) instead of re-deriving base-cluster lineage cold.

``from_dict`` still does NOT restore: ``raw_rating_mat`` / ``rating_mat`` (the
vote matrices — never touched anywhere in ``from_dict``) or
``group_clusterings`` / ``group_k_smoother`` (warm smoother state), nor the
dead ``subgroup_clusters`` / ``consensus`` paths (CLOJURE_QUIRKS.md Q7).
Therefore load-or-init ALWAYS rebuilds the rating matrices from the full vote
history (``poll_votes(zid)`` ordered by zid,tid,pid,created — parity with
conv-poll offset 0); the non-persisted smoother state cold-starts. The
rating-matrix rebuild itself matches Clojure (conv_man.clj:188-207 rebuilds
``raw-rating-mat`` the same way on restart). The remaining gap versus a true
Clojure worker restart is narrower than before: only the non-persisted warm
smoother state (group_clusterings/group_k_smoother) cold-starts — tracked as a
KNOWN divergence to trace against Clojure's ``:reboot`` semantics before the
parity gate.

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

Shadow-mode deployment writes under a DISTINCT ``MATH_ENV`` (e.g. ``python``)
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
