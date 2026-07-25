# Post-cutover improvement roadmap (the ONE central list)

Established 2026-07-27 with Julien's decisions on the deferred items.
Companions: CUTOVER_RUNBOOK.md (the switch itself), CLOJURE_QUIRKS.md
(Q1-Q19 — each row's "Later fix" column feeds this list),
MATH_POLLER_DESIGN.md §4 (cutover phases).

## Standing decisions (Julien, 2026-07-27)

- Equivalence protocol stays a RELEASE-GATE SCRIPT, not CI: its purpose is
  the one-time conviction that Python is equivalent; Clojure is removed
  once convinced. (scripts/poller_equiv.py full-run.)
- fraction-cut py-round clj-driver bug: WONTFIX (test tooling for the
  component being deleted).
- Participant bans: CONFIRMED negligible on prodclone — 201 banned
  participants / 67 conversations / 735,226 total (0.027%), and Clojure
  never honored them, so bans have never affected prod math. DROPPED
  ENTIRELY as a feature (not part of Polis) — see queue item 1.
- Sharding: NOT needed at current traffic — prodclone vote history shows
  p95 = 3, p99 = 5 distinct active conversations per minute (2024+),
  max 14; all-time historical peak 116/min. One serial Python process
  sustains ~100 recompute-ticks/min — MEASURED ON EC2 (r8g.4xlarge,
  cost-model study, #2658's bench) on biodiversity-sized replays, NOT
  the dev laptop. Caveat: that tick rate is for small/mid convs; the
  large-conv (Q10-class) tick cost is unmeasured on EC2 — see queue
  item 9. The scaffolding (#2658) stays opt-in and parked unless a
  scale event approaches the historical peak (which would want 2-4
  shards).

## THE CUTOVER PRECONDITION — mode collapse (Julien directive 2026-07-27)

The committed, switched-to code must be the EXACT legacy match with NO
improvement code paths. Improvements re-land AFTERWARD as separate,
sequential PRs so the git history documents each one. Mechanically:
extract today's improved-mode branches into parked jj commits, collapse
the engine to unconditional legacy behavior, re-certify, switch; then
rebase the improvement commits on top one at a time.

Implication to decide consciously: the "improved" branches are what the
delphi DynamoDB pipeline (run_delphi.py) executes today, and what the
golden snapshots pin. run_delphi.py is PRODUCTION-CALLED, not a dev
script: POST /api/v3/delphi/jobs (server/src/routes/delphi/jobs.ts)
enqueues DynamoDB jobs and delphi's job_poller.py FULL_PIPELINE branch
executes run_delphi.py. After the collapse there is only ONE engine
path, so the API pipeline automatically follows the poller's exact
legacy semantics (Julien requirement 2026-07-27). Collapsing to legacy-only changes THAT service's
math outputs too (to the Clojure-equivalent values prod consumers have
always seen from the math worker) and requires re-recording the golden
snapshots at the collapse commit.

## The improvement queue (one PR each, in rough order)

Each PR: change + tests + re-certified outputs + a CHANGELOG-quality
description. Sources: CLOJURE_QUIRKS "Later fix" column, journal parked
items.

1. ~~Honor participant bans~~ — DROPPED ENTIRELY (Julien 2026-07-27):
   bans are not a Polis feature (201 rows ever, never honored by any
   engine). The mode collapse DELETES the improved-mode ban-filtering
   branch outright; mod_out_ptpts stays ingested-but-inert exactly as
   prod has always behaved.
2. Degenerate-tick guards — un-replicate Q4/Q5 (skip clustering below
   2 participants/base-clusters instead of running k=2 on one point).
3. Group-level k-means gets its intended 100 iterations — un-replicate
   Q3 (Clojure silently ran 20).
4. Persistent moderation watermark — un-replicate Q15 (Clojure drops it
   every votes tick).
5. Comment priorities read CURRENT-tick group-votes — un-replicate Q2
   (Clojure reads the previous tick's).
6. Distance formula: true euclidean instead of the cancellation-lossy
   vectorz form — un-replicate Q11 (removes the 0.0-tie merges) and with
   it the Q17 hash-order tie-break scaffolding.
7. Projection rank-1 fix — un-replicate Q16 (pad pc2 instead of zeroing
   everything).
8. Modern solver paths (sklearn PCA/k-means) where they beat the ports —
   the original "improved" aspiration, now landing with certification
   discipline.
9. **Deterministic large-conversation handling** (Julien 2026-07-27, from
   the Q10 discussion): 7 of 15,575 prodclone convs ever crossed the
   Clojure cutoffs (largest: 33,422 ptpts x 783 cmts / 2.0M votes;
   18,082 x 9,030). Python currently runs full PCA at every size —
   deterministic but O(ptpts x cmts x iters) per tick; large-conv tick
   cost on EC2 is UNMEASURED (see CUTOVER_RUNBOOK risk register). If
   measurement says it is too slow, add a DETERMINISTIC large-conv path
   (seeded mini-batch or randomized-SVD with fixed seed) as its own PR —
   keeping determinism, unlike Clojure's unseeded sampling (#2660).
10. MOVED PRE-CUTOVER (Julien 2026-07-27: "we need to land clean code"):
    vectorized-code readability + blob-injection tests — PR 14b/14c from
    HANDOFF_PR14_VECTORIZED_REFACTOR.md (14a shipped as #2564). Now Phase 3
    of GOAL_CUTOVER_READY.md, battery-guarded; listed here for lineage only.
11. Cleanup pass: the deferred cosmetic simplifications (e.g. the #2644
    legacy reindex no-op), dead update_moderation seams, the Q7 subgroup
    computation deletion upstream if the Clojure tree is still around.

## Explicitly NOT planned

- Clojure-side fixes for #2660/#2661/#2662 (Q10/Q12/Q13+Q18
  nondeterminism) — resolved by replacement, not repair.
- Q19 (Clojure conv-actor race): moot at decommission; the Python
  design (per-zid FIFO + lock) is the fix.
