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

**Shadow vs clean replace (analysis 2026-07-28; decision pending
Julien):** recommended = TIME-BOXED SHADOW, 24-48h, exit checklist
below. Rationale: it tests the only untested dimension (real prod
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
zids structurally identical (poller_equiv comparer on row pairs);
large-conv divergence dismissed per risk 2/Q10.

**One WIP PR per step (for a future session):**
- PR-S0 (promote): get the stack onto `stable` (prod deploys track
  stable, not edge — after_install.sh pulls stable).
- PR-S1 (shadow): scripts/after_install.sh math role line →
  `up -d math math-python`; add MATH_CONV_CACHE_CAP + MATH_PYTHON_ENV
  to the SSM-sourced .env (polis-web-app-env-vars secret); exit
  checklist copied into the PR body.
- PR-S2 (flip): ONE mechanism (ruling needed: poller MATH_ENV→'prod' vs
  server mathEnv→'python'); revert instructions in the PR body.
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
- spot-compare a few active zids' blobs vs the clojure rows (the certify
  StepComparer acceptance; scripts/poller_equiv.py compare machinery is
  reusable for row pairs).

Soak: hours-to-a-day of prod traffic. Exit = no structural divergence on
small/mid convs; large-conv divergence understood per risk #2.

## Step 2 — flip (evening, if soak clean)

One env change, instantly reversible:
- Set the python poller's MATH_ENV to the server's Config.mathEnv ('prod');
  stop the clojure `math` service. (Or flip the server's MATH_ENV to
  'python' — pick ONE mechanism and write it down.)
- Watch: TS prefetch (pca.ts caching_tick > last, ~2.5s poll) keeps
  serving; nextComment routing gets comment-priorities; participants
  bidToPid present.

Rollback = revert the env var + restart clojure math. Rows for both envs
coexist; nothing is destroyed by the flip in either direction.

### Step 2 as built (PR-S2, 2026-09)

Mechanism chosen: the READERS move. One shared `MATH_ENV` in the production env
secret sets the label the server and Delphi read; at the switch it becomes
`python`, the label `math-python` has been writing since the shadow started
(`MATH_PYTHON_ENV=python`, unchanged). In the same deploy the math role in
`scripts/after_install.sh` stops starting the Clojure `math` service, so the
math box runs nothing until step 3 deletes the tier. The poller's startup guard
still refuses to write `prod` (Clojure's label); the override
`MATH_POLLER_ALLOW_SERVED_ENV` stays unset. The single-writer lock key stays
`polis-math-python:python`.

Before the switch: every conversation the readers can serve must have a row
under `python`. The poller only computes conversations with votes since
`POLL_FROM_DAYS_AGO` days before its start, so older conversations have `prod`
rows and no `python` rows; the server would present them as empty. The switch
waits for a backfill of those conversations under `python`.

`/api/v3/math/pca2` sends the entity tag `"<math_env>-<math_tick>"` and
compares held tags as opaque values (weakly): `math_tick` is per
`(zid, math_env)`, so a tick alone cannot say which label's body a browser
holds, and an equal tick across labels would answer 304. A legacy numeric tag
(`"57"`, which client-participation builds from JSON) always gets 200. The
synthesized empty presentation carries no generation tag. This lands as its own
PR before the switch.

Writer safety, independent of the hook: `math/bin/run` refuses to start the
Clojure engine under `python` always, and under any label but exactly `prod`
unless `MATH_CLOJURE_ALLOW_NONPROD_ENV=1` (dev/test overlays only;
`docker-compose.yml` does not forward it). The hook fails closed on an unknown
role, and the math role fails the deploy unless no container of the compose
service `math` remains after cleanup.

Order of operations (CodeDeploy runs the hook PACKAGED in a deployment, and an
ASG replacement gets the last successful revision, so a `stable` merge alone
does not change the hook a new box runs):
1. merge to `stable`;
2. box deploy while the secret still says `MATH_ENV=prod` (packages this hook;
   confirm it Succeeded and is the deployment group's last successful one);
3. secret `MATH_ENV=python`;
4. box deploy again (the readers switch; the math role runs nothing).
Between 2 and 4 nothing writes `prod` while the readers still read it (served
math is stale for that interval); keep it short.
Rollback, in this order: secret `MATH_ENV=prod`; replace the math role's
retirement check with its `up -d math` line (keep the fail-closed fallback and
the Clojure guard); redeploy. On start Clojure re-polls the last 10 days of
votes and rewrites those conversations' `prod` rows in about a minute. If the
switch lasted longer than 10 days, a conversation whose last vote falls between
the switch and 10 days before the rollback keeps its pre-switch `prod` row until
its next vote.

## Step 3 — decommission (later)

Remove the `math` service from compose/deploy (and its `up -d math`
line in scripts/after_install.sh); archive the Clojure tree (it remains
the certification oracle). Follow-ups now live in
POST_CUTOVER_IMPROVEMENTS.md (items 2-9b, 11, 12 — quirk un-replication,
warm-start persistence, optional seeded sampled PCA) plus the journal's
equiv-in-CI decision and the fraction-cut py-round fix.
