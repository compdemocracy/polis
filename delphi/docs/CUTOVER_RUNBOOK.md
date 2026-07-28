# Clojure→Python math cutover runbook

Written 2026-07-26 (post R1-parity DONE); refreshed 2026-07-28 (s7, post
GOAL_CUTOVER_READY DONE). Companion: MATH_POLLER_DESIGN.md §4 (phases),
MATH_POLLER_EQUIV_SPEC.md (the live equivalence protocol),
CLOJURE_QUIRKS.md (Q1-Q19), POST_CUTOVER_IMPROVEMENTS.md (the queue).

## Evidence base (what is PROVEN as of 2026-07-28, s7)

- MODE COLLAPSE LANDED (#2665-#2671): the engine has ONE code path —
  exact legacy semantics; flag machinery deleted; improved branches
  parked (improvements/* bookmarks); bans deleted (not a Polis feature).
- Battery: 20/20 MATCH pairs re-certified at every s7 milestone —
  post-collapse, post-refactor (#2673), post-vectorization (#2679), and
  on the final tree; divergences ledger 81 entries, 0 open.
- Live poller equivalence vs the REAL Clojure container, RE-RUN on the
  collapsed tree: vw 8/8 + pc-meta-02 8/8 batches MATCH, non-vacuous,
  0 envelope-excused divergences (moderation stream, kill+restart seam,
  bidToPid/ptptstats row-identical).
- Goldens re-recorded at the collapse tree (verify-then-record; comparer
  7/7 PASS); full delphi suite green (1171 passed at s7 close).
- Clarity refactor 14b/14c (#2673) + vectorized warm-start kmeans
  (#2679, bit-identical, warm tick ~70x) landed pre-cutover.

## What is NOT yet proven (risk register)

1. **No prod-shaped shadow soak yet.** The equivalence harness ran replay
   datasets (small/mid convs). Prod adds: conversation churn, concurrent
   zids at scale, very large convs.
2. **Large convs (>10k ptpts or >5k comments) intentionally DIVERGE from
   Clojure**: clj dispatches to unseeded-random mini-batch PCA (Q10 — not
   even self-consistent); python runs deterministic full PCA at every size
   (documented improvement, same blob shape, server-compatible). A shadow
   comparer WILL flag these convs — expected, not a defect. Decide the
   acceptance for them up front (structural-only, or exclude from compare).
3. **Poller throughput**: ~1.66 ticks/s per process on biodiversity-sized
   replays — measured on EC2 (r8g.4xlarge, cost-model study) with the
   PRE-VECTORIZATION engine, so it is now a stale LOWER BOUND (#2679
   speeds up every conv's k-means, not just giants; re-measure during
   the shadow soak if a capacity number is needed).
   **PRE-FLIP MEASUREMENT (2026-07-27 s7, pre-vectorization —
   SUPERSEDED by the verdict below)** — one full-PCA tick of the largest
   prodclone shape (33,422 ptpts x 783 cmts, 2.0M votes; synthesized,
   seeded) on r8g.4xlarge via scripts/large_conv_tick_bench.py:
   cold tick 519.6s (~8.7 min); WARM (steady-state) tick 1856.0s
   (~30.9 min). The then-observed "warm ~3.6x cold" asymmetry was an
   artifact of the un-vectorized port's per-pair python loops in the
   lineage warm start — ELIMINATED by #2679 (post-vectorization the two
   are within ~10%: 29.0s vs 26.6s). Local M-series cross-check ran
   same-order both times (430.8s/2095.3s before; 28.2s/26.7s after).
   **VERDICT (FINAL, 2026-07-28 s7): serial is OK at every observed
   shape.** Item 9a (vectorized warm-start k-means, PR #2679 —
   bit-identical: exact-== pins vs the scalar reference, knife-edge Q11
   ties preserved, battery 20/20 x2) re-measured on the SAME r8g.4xlarge
   / shape / seed:
     cold tick  519.6s -> 29.0s   (~18x)
     warm tick 1856.0s -> 26.6s   (~70x)
   (local M-series cross-check: 430.8s -> 28.2s / 2095.3s -> 26.7s.)
   A ~27s worst-case steady-state tick on the 7 historical giants is
   compatible with the serial poller (~1.66 ticks/s on normal convs).
   NO blocklisting (Julien ruling s7) — none needed. The deterministic
   seeded sampled PCA (item 9b) is now OPTIONAL (further speedup /
   Q10-class hygiene), not a throughput requirement.
   Historical note: the pre-vectorization measurement (cold 519.6s, warm
   1856.0s, verdict then NOT serial-OK) drove item 9a; Clojure's own
   large-conv path only ever special-cased :pca (conversation.clj:
   760-773), never k-means — the Python fix was vectorizing our port's
   per-pair loops (~3.3M python calls/iteration -> batched-matmul BLAS
   columns, bit-equal by construction and by 85-combo probe).
   Sharding (#2658) is the scale-out path, opt-in via POLL_SHARD_INDEX/
   POLL_SHARD_COUNT — one shard = one process. Start UNSHARDED (defaults
   are a verified no-op); shard only if the shadow soak shows lag.
   If sharding: the deployment layer MUST guarantee each shard_index
   appears exactly once per MATH_ENV — no code guard exists against two
   processes owning the same slice (per-zid serialization is per-process
   only; #2658 review, 2026-07-26).
4. Q19 (clj actor race losing votes on new-zid discovery) is a CLOJURE bug;
   python's per-zid FIFO+lock design does not have it (equivalence runs
   verified py carries the full vote stream).

## Execution shape (s7 rulings + analysis — read before Step 0)

**Shadow vs clean replace — FINAL RULING (Colin, 2026-07-28): CLEAN
CUT, no shadow.** The collapse contingency below was EXECUTED the same
day: the Step 1 shadow PR was folded into the Step 2 flip PR (#2687) —
its keepers (MATH_CONV_CACHE_CAP compose passthrough, the
shadow_compare comparison tool + tests, these docs) ride there; the
shadow wiring itself (`up -d math math-python`) never ships. The shadow
narrative below is kept for provenance. Under clean cut the safe order
is SECRET-FIRST (set MATH_PYTHON_ENV=prod before merging: nothing
starts math-python until the flip PR deploys, so there is no two-writer
window at any point). Rationale: it tests the only untested dimension (real prod
churn/concurrency/dirty data) at near-zero complexity — the service,
env var, and compare machinery all exist; the time box kills
shadow-limbo risk. Clean replace is defensible on the evidence
(bit-exact battery + live equivalence) and rollback stays cheap
(restart `math`; caching_tick is MAX+1 both ways), but forfeits the
baseline rows that make subtle math weirdness detectable. Memory is a
non-issue either way: host 128 GiB, python capped 16g (set
MATH_CONV_CACHE_CAP — and keep it set in ANY long-running deployment,
not just the soak; eviction cost = the certified restart seam).
Shadow exit checklist (agree BEFORE starting): rows advancing on all
active zids; zero parked zids / errorconv dumps; spot-compare N active
zids structurally identical — MECHANICAL GATE (mandated by Julien's
ruling): `scripts/shadow_compare.py --min-matches <N>` must exit 0
(module `polismath/replay/shadow_compare.py`; reuses the poller_equiv
acceptance on live row pairs; only judges in-sync pairs; exit 1 =
unexpected divergence, exit 2 = coverage not yet demonstrated);
large-conv divergence dismissed per risk 2/Q10 (the tool classifies
those `large-conv-q10`, never a failure). **Step #2 must NOT be merged
until this gate passes.**

**Collapse contingency (if Colin rules clean-cut):** close the Step #1
PR unmerged; in the Step #2 PR, change the after_install.sh math role
line directly from `up -d math` to `up -d math-python` (Step #1's
intermediate `up -d math math-python` never ships); Secrets-Manager edit
becomes MATH_PYTHON_ENV='prod' + MATH_CONV_CACHE_CAP in ONE edit; the
shadow exit checklist is dropped (no soak), the flip gate falls back to
the certified evidence base (battery 20/20 + live equivalence 16/16).
shadow_compare.py stays useful POST-flip for spot-audits against
still-standing historical clj rows (they are not deleted by the flip).

**One draft PR per step (CREATED 2026-07-28, s8 — all open drafts,
nothing merged): Step #0 = #2685, Step #1 = #2686, Step #2 = #2687,
Step #3 = #2688, Step #4 = #2689 (the added Clojure-removal/math-move
PR). Bodies carry the checklists, Julien-actions, and rollback notes.
The bullet list below is the PRE-CREATION planning shape, kept for
provenance — the PR bodies supersede it (note: the old PR-S3 bullet's
"archive note" concern is split across #2688 + #2689).**
- PR-S0 (promote): get the stack onto `stable` (prod deploys track
  stable, not edge — after_install.sh pulls stable).
- PR-S1 (shadow): scripts/after_install.sh math role line →
  `up -d math math-python`; add MATH_CONV_CACHE_CAP + MATH_PYTHON_ENV
  to the SSM-sourced .env (polis-web-app-env-vars secret); exit
  checklist copied into the PR body.
- PR-S2 (flip): ONE mechanism — PROVISIONAL RULING (Julien, 2026-07-28):
  poller MATH_ENV→'prod' (Secrets-Manager MATH_PYTHON_ENV='prod' +
  restart math-python; stop the clj `math` service) — the seam the
  equivalence runs certified, no server config change, no server
  restart. FINAL confirmation BLOCKED-ON-RULING at flip time (the PR
  body presents both mechanisms); revert instructions in the PR body.
- PR-S3 (decommission): remove `math` from compose + its
  after_install.sh line; archive note for the Clojure tree.

**CDK impact: NONE required for steps 0-3.** The python poller runs on
the existing math-worker host (r8g.4xlarge, MathWorkerLaunchTemplate)
via compose; same Postgres path/security groups; math_writer needs no
new IAM (Postgres only); CodeDeploy math deployment group unchanged
(the only deploy-side edit is after_install.sh, which ships with the
repo). Verified: cdk/ec2.ts, cdk/launchTemplates.ts, appspec.yml,
scripts/after_install.sh. CDK would only enter later if the math host
itself is retired/resized post-decommission (candidate: downsize
r8g.4xlarge once the vectorized engine's real utilization is known —
measure during the soak first).

## Step 0 — land the stack (morning)

1. Reviews: DONE through #2682 (Copilot triage s6 = #2663; Copilot
   credits exhausted since — all later PRs reviewed by independent
   review agents, all sound; findings applied). Nothing outstanding.
2. Confirm CI green at the stack tip (python-ci workflow_dispatch on the
   tip branch; every s7 dispatch was green). Historic note: a mid-stack
   red (e.g. #2648-era) is a stack-position artifact — deploy builds the
   tip.
3. Merge bottom-up: `jj spr merge --count <N>` (spr handles squash order).
   NEVER the GitHub UI. Then a normal edge deploy.

## Step 1 — shadow in prod (same day)

Infrastructure already in compose (#2625; renamed s7 per Julien — the
math poller is engine, not delphi/UMAP): service `math-python`,
profile `math-python`, `MATH_ENV=${MATH_PYTHON_ENV:-python}` — distinct
from Clojure's env, rows invisible to the server (UNIQUE(zid, math_env)).

```
docker compose --profile math-python up -d math-python
# env: MATH_PYTHON_ENV=python   (engine has one path since the mode collapse)
# env: MATH_CONV_CACHE_CAP=<N>  — SET THIS FOR THE SOAK (s7): the conv cache
#   never evicts by default; a long soak accumulates convs toward the 16g
#   container limit and an OOM-kill restart loop. LRU eviction is cheap
#   (reload = from_dict warm restore). Memory math: host 128 GiB; python
#   capped 16g; clojure unchanged by shadow. Verify the clj container's
#   actual -Xmx on the host before the soak (empirically fits today).
# PROD NOTE (deploy-script reality, s7): prod instances start services BY
# NAME from scripts/after_install.sh per-role dispatch (profiles are a
# dev-only gate) — shadow on the math role = add `math-python` to its
# `docker-compose up -d math` line; prod tracks branch `stable`.
```

Verify within minutes:
- math_main rows appearing under math_env='python' with advancing
  caching_tick;
- no errorconv dumps / parked zids in the poller log;
- run the live comparer: `cd delphi && uv run python
  scripts/shadow_compare.py --json-out scratch/shadow_report.json`
  (module polismath/replay/shadow_compare.py — certify acceptance on
  live row pairs; judges only in-sync pairs, reports out-of-sync/
  not-ready for retry, classifies >10k-ptpt/>5k-cmt convs
  `large-conv-q10` per risk #2).

Soak: hours-to-a-day of prod traffic. Exit = shadow_compare.py exits 0
with `--min-matches <N>` (N = the active-zid count agreed up front) on
repeated runs; no structural divergence on small/mid convs; large-conv
divergence understood per risk #2. This exit gate is REQUIRED before
Step 2 (Julien ruling 2026-07-28).

## Step 2 — flip (evening, if soak clean)

GATE: `scripts/shadow_compare.py --min-matches <N>` exit 0 (see Step 1)
+ the rest of the shadow exit checklist. Mechanism per the provisional
ruling (2026-07-28): poller MATH_ENV→'prod'; final confirmation
BLOCKED-ON-RULING in the Step #2 PR.

One env change, instantly reversible:
- Set the python poller's MATH_ENV to the server's Config.mathEnv ('prod');
  stop the clojure `math` service. (Or flip the server's MATH_ENV to
  'python' — pick ONE mechanism and write it down.)
- Watch: TS prefetch (pca.ts caching_tick > last, ~2.5s poll) keeps
  serving; nextComment routing gets comment-priorities; participants
  bidToPid present.

Rollback = revert the env var + restart clojure math. Rows for both envs
coexist; nothing is destroyed by the flip in either direction.

## Step 3 — decommission (later)

Remove the `math` service from compose/deploy (and its `up -d math`
line in scripts/after_install.sh); archive the Clojure tree (it remains
the certification oracle). Follow-ups now live in
POST_CUTOVER_IMPROVEMENTS.md (items 2-9b, 11, 12 — quirk un-replication,
warm-start persistence, optional seeded sampled PCA) plus the journal's
equiv-in-CI decision and the fraction-cut py-round fix.
