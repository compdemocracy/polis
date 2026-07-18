# Sequential-Bits Port Spec — Clojure warm-start/stateful behaviors → Python `clojure-legacy` mode

**Status:** Verified inventory + port design — 2026-07-18
**Provenance:** Produced by a read-only spec agent (opus) during the overnight orchestration
session of 2026-07-17→18; every file:line reference originally verified against the working
tree at commit `c51b7425` (D1b tip). Integrated and reviewed by the session integrator.
**Citations re-verified against commit `2d6c87035` (2026-07-18)** — conversation.py grew
~250 lines since `c51b7425`, so the conversation.py:NNN cites below were re-grepped and
corrected (rows 2, 3, 7, 11, §2.4, and the subgroup headline bullet).
**Companions:** `REPLAY_HARNESS_DESIGN.md` (the validation substrate),
`PLAN_DISCREPANCY_FIXES.md` (D1/D3 entries), `CLJ-PARITY-FIXES-JOURNAL.md` (session log).

Python's delphi engine does full cold recompute every tick; Clojure threads warm-start
state across `conv-update` ticks. This spec is the complete inventory of that state and
the plan for reproducing it in Python behind an engine-mode flag, so that
Python-legacy-mode can replay Clojure trajectories step-for-step (R1/R2 prerequisite).

## Headline verification results

- **Group-level stale-k clamp (#2536): PRESENT** in Clojure HEAD —
  `math/src/polismath/math/conversation.clj:469-478`.
- **Subgroup-level stale-k clamp (#2575): NOW IN Clojure HEAD.** PR #2609 (`207fa9f93`,
  branch `jc/subgroup-k-smoother-clamp`) **merged 2026-07-18T02:52**, so current production
  Clojure now runs the **clamped** subgroup smoother (`conversation.clj:534-559`) with its
  regression test present in `math/test/conv_edge_cases_test.clj`. HISTORICAL NOTE: the
  overnight port work targeted PRE-merge HEAD, where the subgroup smoother was still
  UNCLAMPED — the "unclamped target" therefore applies only to a port certified against a
  pre-#2609 frozen Clojure ref (pin the edge SHA). → keep it a sub-flag keyed to the
  Clojure version being certified against.
- **Uncatalogued sequential divergence:** Clojure's `:comment-priorities` node reads the
  **previous tick's** group-votes (`(:group-votes conv)`, `conversation.clj:650`), not the
  freshly computed one. Python uses the current tick's. Currently masked by the #2571
  all-49 bug-mirror; must be honored when the mirror is removed.
- **Python computes no subgroups at all** (`conversation.py:1048` hardcodes
  `subgroup_clusters = {}`), so all subgroup-level behaviors are latent port items.

## 1. Inventory — cross-tick stateful behaviors

| # | Behavior | Clojure (reads prev conv) | In `math_main`? (prep-main whitelist, conv_man.clj:52-74) | Python status |
|---|----------|---------------------------|------------------------------------------------------------|---------------|
| 1 | PCA warm start (small conv) | conversation.clj:381-387 `:start-vectors (get-in conv [:pca :comps])` | `:pca` YES | **GAP** — powerit_pca has `start_vectors` (pca.py:169-237) but no production caller passes it |
| 1b | PCA warm start (large conv, mini-batch partial-pca) | conversation.clj:755-765 | `:pca` YES | GAP, deferred (D14; no large-conv path in Python) |
| 2 | Base-cluster warm start | conversation.clj:403-410 `:last-clusters (:base-clusters conv)` → clean-start-clusters | `:base-clusters` YES | base k-means block (conversation.py:842-888); legacy warm start now ported (PR-C #2622) |
| 3 | Group-clustering warm start (per k) | conversation.clj:433-445 `((:group-clusterings conv) k)` | NO | per-k group loop (conversation.py:996 improved / 952 legacy-warm); legacy warm start now ported (PR-C #2622) |
| 4 | group-k-smoother (buffer=4 + #2536 clamp) | conversation.clj:454-478 | NO | **GAP** — best-k picked fresh each tick, no memory |
| 5 | Subgroup-clustering warm start | conversation.clj:492-520 | NO | GAP (latent — no subgroups) |
| 6 | subgroup-k-smoother (buffer=4, **clamped** in HEAD since #2609 merged 2026-07-18) | conversation.clj:534-559 | NO | GAP (latent) |
| 7 | comment-priorities ← prev-tick group-votes | conversation.clj:650 | `:group-votes` YES | **DIVERGENT** — Python uses current tick (conversation.py:1366, group_votes recomputed at :1423); masked by #2571 mirror |
| 8 | in-conv monotonic carry + greedy top-15 | conversation.clj:243-269 | `:in-conv` YES | threshold part EQUIVALENT via full recompute (append-only votes); **greedy top-15 DIVERGENT** — Clojure persists greedily-added pids forever, Python recomputes them each tick |
| 9 | customs pids/tids caps (100k/10k) | conversation.clj:167-189 | partial | DIVERGENT edge — no caps in Python; only matters above thresholds |
| 10 | last-vote-timestamp monotonic max | conversation.clj:161-165 | YES | EQUIVALENT |
| 11 | mod-out/mod-in/meta-tids carry | conversation.clj:838-876 (incremental conj/disj per event) | YES | ~EQUIVALENT; Python replaces whole sets per payload (conversation.py:598-643, sets replaced at :621-626) — mid-conversation un-moderation trajectories can diverge; replay slicer must feed the event stream |

## 2. Key semantics (binding for the port)

### 2.1 PCA warm start
`powerit-pca` (pca.clj:86-105): per-component power iteration, FIXED iteration budget
(default 100, `:pca-iters`) identical cold vs warm; start vector = previous tick's
post-normalization unit component; new columns absorbed by 1-padding (pca.clj:46-49);
all-zero start → re-randomized (`wrapped-pca`, pca.clj:108-124). Python's `powerit_pca`
already implements all of this faithfully (1-padding pca.py:120-123, zero→None
pca.py:224-227, exact-equality early exit pca.py:131-144) — the port is pure plumbing:
store previous `pca['comps']`, pass as `start_vectors`. Cold first tick: Clojure uses
unseeded `(rand)`; Python uses deterministic seed-42 (documented deliberate divergence,
pca.py:71-86). Warm start applies only to the powerit impl (sklearn cannot inject start
vectors — REPLAY_HARNESS_DESIGN.md §12.6).

### 2.2 group-k-smoother (buffer = 4, conversation.clj:454-478)
State `{last_k, last_k_count (default 0), smoothed_k}`:

```
this_k       = argmax_k silhouette[k]        # TIE-BREAK: Clojure max-key keeps the LATER
                                             # arg over ascending keys ⇒ HIGHER k wins ties
                                             # (current Python best_k loop keeps LOWER k)
same         = last_k is not None and this_k == last_k
this_k_count = last_k_count + 1 if same else 1
smoothed_k   = this_k if this_k_count >= 4 else (smoothed_k ?? this_k)
smoothed_k   = smoothed_k if smoothed_k in group_clusterings else this_k   # #2536 clamp
state'       = {last_k: this_k, last_k_count: this_k_count, smoothed_k}
```

It is "best k must win 4 consecutive ticks before taking over", NOT a ring buffer.
First tick: smoothed_k None → accepts this_k ⇒ cold-start behavior unchanged (hard
regression constraint). Clamp is independent of the buffer: protects against the carried
k falling out of range when `max-k-fn = min(5, 2 + floor(n_base/12))` shrinks.

### 2.3 Base-cluster lineage (clean-start-clusters, clusters.clj:230-277)
1. `safe-recenter-clusters` (171-191): recenter each existing cluster on its surviving
   members; DROP clusters whose members all vanished; if all vanish → one fallback
   cluster with fresh id `(inc max-id)`.
2. `uniqify-clusters` (220-227): merge identical-center clusters; merged cluster keeps
   the LARGER side's id (194-199); center = size-weighted mean.
3. Split loop: while `min(k, #distinct rows) > count(clusters)`: pull the most-distal
   point (202-217) into a NEW cluster with id `(inc max-id)`; recenter; repeat.

Cluster ids are stable across ticks; new ids strictly increase. Cold init
(`init-clusters`, 55-65): first k distinct rows in encounter order, ids 0..k-1.
Iteration: `cluster-step` until `same-clustering?` (sorted-center distance < 0.01,
clusters.clj:68-76) or max-iters (base level uses `:base-iters` = 100).
**Python's off-production `clusters.py` warm-start machinery (302-403) is a DIFFERENT
algorithm — do not reuse.** Legacy mode needs a faithful numpy port and must use the
ported k-means loop (not sklearn Lloyd) when warm-starting.

### 2.4 in-conv greedy carry
`in-conv = carried ∪ {p : votes[p] >= min(7, n_cmts)}`; if |in-conv| < 15, greedily add
top-(15−n) by vote count. Clojure PERSISTS greedy admits (carried set). Python recomputes
greedy each tick → churn while <15 qualifiers. Threshold part is provably equivalent
under full recompute of append-only votes (see D2d design, conversation.py:1691-1751);
greedy part needs a carried set in legacy mode.

### 2.5 Persistence / worker restart
Clojure persists only the prep-main whitelist (`:pca`, `:base-clusters`,
`:group-clusters`, `:in-conv`, `:group-votes`, ...) — NOT smoother state, NOT per-k
clusterings. Worker restart = partial cold start (smoother counters reset, per-k warm
start lost; PCA/base warm start survive via math_main). For R1/R2 (single-process
chains) Python needs NO new serialization — state threads in memory across
update_votes calls. Restart modeling can later be encoded as schedule input boundaries.

## 3. Python design

- Engine switch `POLISMATH_ENGINE_MODE ∈ {clojure-legacy, improved}`, default `improved`
  (byte-identical to today — hard gate), resolved via the `_resolve_impl_flag` idiom
  (pca.py:37-57). Sub-flag for the #2575 subgroup clamp when subgroups ever land.
- New Conversation fields (cold defaults): `group_clusterings={}`,
  `group_k_smoother={}`, later `prev_group_votes={}`, persistent `in_conv=set()`.
- Legacy-mode recompute order: PCA(start_vectors=prev comps) → in-conv (union into
  carried set) → base kmeans(last_clusters=prev base) → per-k group
  kmeans(last_clusters=prev per-k) → smoother → group_clusters = clusterings[smoothed_k]
  → priorities over prev_group_votes (once #2571 un-mirrored).
- No to_dict/to_dynamo_dict changes (D2d precedent: defer persistence until delta
  processing or worker-restart modeling requires it).

## 4. PR split

| PR | Content | Size | Status |
|----|---------|------|--------|
| A | POLISMATH_ENGINE_MODE flag + prev-state scaffolding + cold-invariance tests | S | overnight 2026-07-18 |
| B | PCA warm start (legacy) — thread prev comps → start_vectors | S | overnight 2026-07-18 |
| D′ | group-k-smoother (buffer=4 + #2536 clamp + Clojure tie-break), smoother only | M | overnight 2026-07-18 |
| C | Clojure-exact base k-means lineage port + base & per-k warm start | L | landed 2026-07-18 (#2622) |
| E | in-conv greedy carry (legacy) | S | landed 2026-07-18 (#2623) |
| F | priorities ← prev-tick group-votes | S | blocked on #2571 un-mirror |
| G | subgroups + subgroup smoother (+#2575 sub-flag) | L | latent |
| H | large-conv partial-pca (D14) + optional persistence | L | deferred |

## 5. Test plan (summary)

Cold-start invariance gates first (improved == today byte-for-byte; legacy first tick ==
improved first tick). Smoother units: buffer counting, reset-on-change, clamp, tie-break
direction, first-tick acceptance. PCA warm-start: chained two-tick spy test + angle
tolerance. Lineage tests (PR-C): vanish-drop, `(inc max-id)` policy, merge-keeps-larger-id,
stable ids across chained updates; port conv_edge_cases_test.clj:66-98 (clamp) and
:110-127 (agg-bucket unknown pid). Incremental k-stability via the replay harness once
H-A lands; full R1 schedule-CCR parity once H-B records Clojure CCRs.

Expected xfail harvest (eventually): D3 xfails in test_discrepancy_fixes.py; several
incremental-variant divergences (gid/membership trajectory); the D12 priority-parity
blocker chain (extremity → D1/D1b → un-mirror).
