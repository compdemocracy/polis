# Polis Math Algorithm History & the 2025 Comment-Routing Regression

**Status:** reference. Compiled 2026-07 from full git-history archaeology (repo history
back to 2012-10-13). Commit hashes quoted verbatim from git.

> Scope: the **Clojure reference math** at `math/src/polismath/` (the implementation that
> has actually run in pol.is production), its evolution, and the 2025 regression that
> silently disabled priority-based comment routing. The Python port (`delphi/polismath/`)
> is a recent (2024–2026) re-implementation and is noted only where it diverges.
>
> This document is sourced entirely from the public git history and code. It contains no
> production data or conversation identifiers.

---

## TL;DR

- Priority-based comment routing **did not exist before January 2018**; comments were
  served at uniform random (`ORDER BY random()`). It was introduced **2018-01-17**.
- On **2025-03-15**, commit `512b504807` (merged to `edge` as `dff835d7e`, PR **#1961**,
  "cutoff for large-convo processing if > 5000 comments") introduced a one-line
  regression that makes **every** comment's routing priority collapse to the constant
  `META_PRIORITY² = 49`. Priority routing degrades to **uniform random** — i.e. it
  reverts to the pre-2018 behavior.
- Root cause: the meta-comment lookup default was changed from `nil` to `0`, and **`0`
  is truthy in Clojure**, so `priority-metric`'s `(if is-meta …)` always takes the meta
  branch.
- Went live in pol.is prod **between 2025-03-15 and ~2025-03-20** (first "PROD DEPLOY"
  marker after the commit is 3/20; the bug was not in the 3/4 deploy).
- Fixed on the Clojure side in **#2611** (`(contains? meta-tids tid)`). The Python port
  still **deliberately mirrors** the bug for byte-parity, tracked by issue **#2571**.

---

## 1. Core math algorithm change timeline

Areas: **R**=routing · **P**=PCA/projection · **X**=extremity/repness · **C**=clustering ·
**N**=consensus/vote-stats/moderation. Only introductions, numeric-output-changing edits,
and bugs. Pre-2020 commits are direct pushes in the standalone `polisMath` repo (no PR #).

| Date | Area | Commit | PR | Change | Impact |
|---|:--:|---|---|---|---|
| 2013-10-28 | P | `27de68680` | — | Power-iteration PCA introduced | first eigensolver |
| 2013-11-02 | P | `f058e3782` | — | Mean-centering added | correct eigenvectors |
| 2014-01-25 | C | `b7f648932` | — | K-means introduced | first clustering |
| 2014-02-09 | X | `e14539c0b` | #10 | Representativeness introduced (agreement ratio) | first repness |
| 2014-02-22 | C | `d2525976c` | — | Two-tier base→group clustering | groups over base clusters |
| 2014-03-22/23 | C | `f4a6c0661`/`176ac68fc` | #45/46/48 | Growing/shrinking K across updates | adaptive group count |
| 2014-06-05 | C | `3d89774a2` | — | Silhouette-based optimal-K selection | K chosen by silhouette |
| 2014-08-21 | X/N | `91c27787c` | — | Proportion z-tests + Laplace pseudocounts `(x+1)/(ns+2)` | modern stats schema (still current) |
| 2014-08-30 | C | `eaa29c666` | #77 | group-k-smoother (4-buffer) | K stops flickering per update |
| 2014-10-02 | P | `36ab1e7c0` | — | Sparsity-aware participant projection (rescale by √(n_cmt/n_vote)) | current participant placement |
| 2014-10-15 | C | `5dc04d08e` | — | `max-k` 12→5 | fewer groups |
| 2014-12-14 | X | `b361e3003` | — | Composite `repness-metric` (4-factor) | current rep ranking |
| 2014-12-15 | N | `aece03f0d` | — | Consensus (single-population) introduced | consensus feature |
| 2014-12-25/26 | N | `50c1afeb9`/`8164a6cc0` | — | Moderation filtering into rep/consensus selection | mod-out excluded |
| 2017-01-04 | C | `faa02981d` | — | Subgroup clustering | second-level groups |
| 2017-02-27 | N | `b68ca8b6a` | — | Column-zeroing of mod-out/meta before PCA (`zero-out-columns`) | moderation moves into matrix |
| 2017-04-14 | C | `32988e405` | — | `base-k` 50→100 | finer pre-clustering |
| 2017-05-02 | P/X | `f66cfe086` | #50 | Comment projection introduced | comments get 2D coords |
| 2017-09-12 | X | `5b44be232` | — | Comment-extremity = L2 norm of projection | extremity defined |
| 2017-10-21 | P/N | `90b5b9e62` | — | Missing-vote fill **0→column-mean**; `raw-rating-mat` split | **silent** numeric shift to PCA + all vote stats |
| 2017-11-30 | N | `3bd581fba` | — | group-aware-consensus introduced | cross-group agreement |
| 2017-12-06 | P | `31dcb5eb5` | — | Comment synthetic vote **+1→−1** | flips comment polarity; **last Clojure PCA algo change** |
| 2017-12-08 | C | `e07aec5ac` | — | base-kmeans iters key fix (ran 20 not 10) | numeric change to base clusters |
| 2017-12-30 | N | `01e7bb280` | — | consensus pseudocount `A/(S+1)→(A+1)/(S+2)` | numeric change |
| **2018-01-17** | **R** | `40a180563`/`4d6de6651` | — | **Priority routing introduced** (server `selectProbabilistically` + math `importance-metric`) | **uniform → priority-weighted** |
| 2018-01-20 | R | `8e8e6318a` | — | `priority-metric` matured (meta 49, novelty boost, square) | current formula |
| 2018-09-04 | X | `e920f9562` | — | Extremity wired into large-conv path | fixes ~1 yr of missing extremity on big convs |
| **2025-03-15** | **R/C/X** | `512b504807`→`dff835d7e` | **#1961** | **Truthy-0 routing bug** + large-conv dispatch now >5000 comments | **all priorities→49 (uniform)**; mid-size convs switch to sampled PCA path |
| 2026-04-07 | C/N | `9c506b29e` | #2529 | Guard nil `pid-to-row` in group-votes | crash fix (large convs) |
| 2026-04-09 | C/X | `40cccfd0a` | #2536 | Clamp stale `group-k-smoother` `smoothed-k` | crash fix (shrinking convs) |
| 2026-07-16 | C | `ed02b205e` | #2575 | Clamp stale `subgroup-k-smoother` (mirrors #2536) | crash fix |
| 2026-07-10 | N/R | `6ad954889` | #2597 | Python port merged: honors participant bans (**divergence**); mirrors routing bug for parity | Python ≠ Clojure on bans; Python = Clojure on the 49 bug |
| 2026-07-17 | R | (this stack) | **#2611** | Clojure fix: `(contains? meta-tids tid)` restores priority routing | undoes the #1961 regression |

---

## 2. Per-area evolution & notable bugs

### 2.1 Comment routing & priorities
Introduced 2018-01-17 (`40a180563` server, `4d6de6651` math), matured 2018-01-20
(`8e8e6318a`). The formula has been byte-stable since 2018 (a `git log -L` on the metric
defs shows only those two commits) until the 2025 regression. **Before 2018:** uniform
random (`getNextCommentRandomly`, since `7a1b2107b` 2015-05-31), with seed comments
served first after `5a5c993fc` (2017-10-04). See §3.

### 2.2 PCA / projection
Hand-rolled power iteration (2013), mean-centering (`f058e3782`), warm-start across
updates, port to `core.matrix`/vectorz (`a220921b5`, 2014). The defining shift:
**sparsity-aware participant projection** (`36ab1e7c0`, 2014-10-02) — projects only voted
comments and rescales by √(n_cmt/n_vote); still current. Comment projection added 2017
(`f66cfe086`), finalized by flipping the synthetic vote +1→−1 (`31dcb5eb5`, 2017-12-06,
the **last** Clojure PCA algo change). Config frozen since 2014: `n-comps=2`,
`pca-iters=100`, warm-started from the previous run.
**Bug/quirk:** non-deterministic component **sign** from random cold-start init
(`c46e7a86c`, 2014-02-06) — never fixed in Clojure; it's what the Python port's "D1 sign
flip prevention" targets.

### 2.3 Comment extremity & representativeness
Repness went from a crude agreement ratio (2014-02, `e14539c0b`) to the modern
proportion-test form with Beta(1,1) pseudocounts and two z-tests (`91c27787c`,
2014-08-21), top-5 per group by composite `repness-metric` (`b361e3003`, 2014-12).
Comment **extremity** = L2 norm of comment projection (`5b44be232`, 2017-09-12).
**Bugs:** tid-by-position mislabeling (`b523ed109` 2017, `ef66d24f1` 2017); extremity
absent on large conversations for ~1 year (introduced `5b44be232` 2017-09, fixed
`e920f9562` 2018-09). Still-present: function misspelled `with-proj-and-extremtiy`;
`two-prop-test` returns 0 when `pi-hat=1`.

### 2.4 Clustering
Weighted Lloyd k-means (`b7f648932`, 2014-01), adaptive grow/shrink K, two-tier
base→group architecture, silhouette-based K selection (`3d89774a2`), and the
group-k-smoother (`eaa29c666`, #77) that debounces K with a 4-update buffer. `max-k`
5, `base-k` 100 (since 2017). Subgroup clustering 2017 (`faa02981d`). Recent history is
crash-hardening on large/shrinking conversations: `9c506b29e` (#2529), **`40cccfd0a`
(#2536, the "stale group-k-smoother crash")**, `ed02b205e` (#2575, subgroup level).
**Bug:** base-kmeans silently ran 20 iters instead of 10 until `e07aec5ac` (2017-12-08).

### 2.5 Consensus, vote-stats & moderation / participant filtering
Per-comment agree/disagree probability estimates with `(x+1)/(ns+2)` pseudocounts
(`91c27787c`, 2014-08), single-population consensus (`aece03f0d`, 2014-12), group-aware
consensus as product of per-group agree-probs (`3bd581fba`, 2017-11). Moderation moved
into the matrix via `zero-out-columns` (`b68ca8b6a`, 2017-02); vote counting routed
through `raw-rating-mat` (`90b5b9e62`, 2017-10) so moderating a comment no longer erases
its votes from the stats.
**Bugs:** group-aware-consensus shipped returning the wrong structure for 29 days
(`3bd581fba`→`bd8548152`); `zero-out-columns` zeroed wrong columns (`9cbaea084`, same-day
fix).
**Structural gap (ALL Clojure versions):** Clojure only ever zeroed moderated *comment*
columns — it **never dropped banned-participant rows** (`participants.mod = -1`), so
banned participants influenced PCA/clustering/repness/consensus/stats forever. Fixed only
on the Python side in 2026 (`mod_out_ptpts`, #2597) — a deliberate *divergence*, not a
parity match.

---

## 3. The 2025 comment-routing regression ("all-49" bug)

### What / where / when
`math/src/polismath/math/conversation.clj`, in the `:comment-priorities` graph node.

```clojure
;; priority-metric's first arg is the is-meta FLAG:
(defn priority-metric [is-meta A P S E]
  (matrix/pow (if is-meta
                meta-priority                       ; 7  → squared = 49
                (* (importance-metric A P S E)       ; the real importance × novelty signal
                   (+ 1 (* 8 (matrix/pow 2 (/ S -5))))))
              2))

;; BEFORE (correct): (meta-tids tid) → nil for non-meta comments → falsy → real metric
(priority-metric (meta-tids tid) A P S extremity)

;; AFTER 512b504807 / dff835d7e (#1961, 2025-03-15) — THE BUG
;; (excerpt from the surrounding let-binding vector):
;;   meta-tid-value (if meta-tids (get meta-tids tid 0) 0)   ; non-meta → 0
(priority-metric meta-tid-value A P S extremity)         ; 0 is TRUTHY in Clojure!

;; FIX (#2611): pass a real boolean
(priority-metric (contains? meta-tids tid) A P S extremity)
```

Because `0` is truthy in Clojure, `(if is-meta …)` always takes the meta branch, so every
comment's priority = `7² = 49`. The `importance-metric × novelty` term becomes dead code.
The change rode along in a PR that was ostensibly about a large-conversation processing
cutoff.

### Why it matters
The server (`nextComment.ts`, `selectProbabilistically`) weights the next-comment lottery
by these priorities. All-equal priorities ⇒ **uniform random** selection — the
information-theoretic routing (surface high-extremity, low-vote, novel, meta comments
faster) is gone.

### Which conversations are affected (mechanism, not counts)
- A conversation's stored `comment-priorities` are all `49.0` iff its Clojure math was
  (re)computed under the buggy code. Since the math re-ticks on activity, any conversation
  actively processed after the deploy carries the flat-49 priorities.
- **Delphi topical routing is immune.** The topical path (`getNextTopicalComment`) selects
  from topic-clustered pools with `random:true` and **never reads the Clojure priorities**.
  But it only engages for conversations with per-participant `topic_agenda_selections`, and
  falls back to the prioritized (buggy) path otherwise.
- The **"importance"** feature (`importance_enabled`, PR #1682, 2024-12) is a
  **pre-Delphi/legacy** feature and does **not** change the routing path.

### Equivalence to pre-2018 routing
Functionally the bug ≈ the pre-2018 uniform-random era, with nuances: (a) same
distribution as the old `ORDER BY random()`, only the RNG moved from SQL to JS; (b) seed
comments lost the first-served boost they had 2017-10→2018-01, so the bug is *slightly
more* uniform; (c) meta comments are uniform under the bug by accident, not design.

### Follow-up: D12 priority parity is NOT achieved (discovered 2026-07-17)
The all-49 bug was *masking* a real Python↔Clojure priority non-parity. With the Clojure
bug fixed (#2611) and the Python `priority_metric` bug-mirror un-mirrored, fixed-Python vs
fixed-Clojure priorities are **rank-uncorrelated** (vw: Spearman ≈ −0.03). While both sides
returned the constant 49, the D12 parity check passed trivially. Un-mirroring Python +
regenerating cold-start blobs + a real D12 value-parity assertion is tracked in **#2571**,
blocked on extremity/PCA parity (D1/D1b). See `CLJ-PARITY-FIXES-JOURNAL.md` 2026-07-17.

---

## 4. Mapping conversations → algorithm versions (deploy timeline)

A conversation's `math_main` blob reflects whatever code was deployed when it was **last
recomputed**; its live routing at vote-time-T used whatever was deployed at T. To map
either, you need the **pol.is prod deploy timeline**. Signals, best to worst:

1. **"PROD DEPLOY" commits** — explicit, frequent (often multiple/day). Span
   **2025-02-15 → present**; explicit "PROD DEPLOY N/N" naming from **2025-03-20**.
   `git log --grep="PROD DEPLOY" --format="%ci %h %s"`.
2. **`origin/stable` first-parent history** — pol.is deploys by merging `edge`→`stable`
   (e.g. `8040579ef "Merge Edge into Stable to upgrade PROD to latest (#1871)"`). This is
   the only signal for the **pre-2025** period. `git log --first-parent origin/stable`.
3. **Tags** — *not* useful. Only a handful exist, all recent working tags
   (`pre-sklearn`, `sk-pca`, `forking-kmeans`, …), none are releases.

**Method to date an algorithm change C:** find the earliest deploy that contains C.
Ancestry (`git merge-base --is-ancestor C <deploy>`) is the clean way, **but squash
merges break it** — spr/edge squashes create new hashes, so `--is-ancestor` can return
false negatives. Cross-check with the commit date and (for output-visible changes) the
stored-blob signature.

**The bug's deploy window:** `dff835d7e` (2025-03-15) was **not** in the 2025-03-04
deploy; the first "PROD DEPLOY" after it is 3/20 (#1971). So the bug went live
**2025-03-15 … ~03-20**; using 2025-03-15 as an analysis cutoff over-counts by at most a
few days.

**Empirical alternative (no deploy log needed):** algorithm versions leave fingerprints
in the stored blobs. The all-49 routing bug is directly detectable (`comment-priorities`
all = 49); the 2017 comment-polarity flip and the pseudocount changes are similarly
detectable in golden/stored outputs. For "which version ran," the blob signature is often
more reliable than the deploy graph.

**Caveat:** the public repo records the *open-source* deploy mechanism. For the recent
"PROD DEPLOY" era this **is** the pol.is hosted-deploy log; for older history the `stable`
branch is a proxy and may lag the actual hosted deploy.

---

## 5. The fix (#2611)

One line, in the `:comment-priorities` node of `conversation.clj`: pass a real boolean
for `is-meta` instead of the truthy-`0`-defaulted value —
`(priority-metric (contains? meta-tids tid) A P S extremity)`. `contains?` returns
`false` for non-meta tids and safely returns `false` when `meta-tids` is `nil`, restoring
the pre-2025 behavior (non-meta → importance×novelty, meta → 49).

**Merged to `edge`:** 2026-07-18 02:53:24 UTC (2026-07-17 21:53:24 -05:00),
commit `424dcae0`.

> ⚠️ **Not yet in prod as of this writing.** The most recent "PROD DEPLOY" commit
> on `origin/stable` is `adce54b9a` "PROD DEPLOY 07/05/2026" (#2596), from
> 2026-07-05 19:15:35 -05:00 — **before** this fix merged, and `origin/stable`
> does not contain `424dcae0`. That means the routing bug is still live in
> production. **The moment a prod deploy lands after 2026-07-18, come back to
> this section and:**
> 1. Confirm the deploy commit contains `424dcae0` (`git merge-base
>    --is-ancestor 424dcae0 origin/stable`).
> 2. Record the deploy date/commit here as the end of the bug's live window
>    (companion to the start-of-window dating in §4).
> 3. Remove this warning once documented.

**Coupling to watch:** the Python port intentionally mirrors this bug for byte-parity
(issue **#2571**), and the parity golden snapshots encode the all-49 output. The Clojure
fix ships alone (only Clojure's blob feeds production routing); the Python un-mirror +
blob regen is deferred to #2571 because it exposes the deeper priority non-parity (§3),
which needs the extremity/PCA parity to close first.

---

## Appendix: methodology

- Git archaeology: full history (`git log --follow`, `-S` pickaxe, `-L`) across
  `math/src/polismath/`, fanned out over 5 areas (routing, PCA/projection,
  extremity/repness, clustering, consensus/moderation). Hashes quoted verbatim.
- The bug's stored-blob signature (`comment-priorities` all = 49) and its
  first-appearance date are consistent with the 2025-03 deploy window derived above.
