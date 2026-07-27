# Clojure→Python math cutover runbook

Written 2026-07-26 (post R1-parity DONE, GOAL_STATE.md). Companion:
MATH_POLLER_DESIGN.md §4 (phases), MATH_POLLER_EQUIV_SPEC.md (the live
equivalence evidence), CLOJURE_QUIRKS.md (Q1-Q19).

## Evidence base (what is PROVEN as of 2026-07-26)

- R1 battery: 20/20 MATCH on four consecutive clean pass-pairs (2026-07-24),
  ledger zero open. Warm chains, moderation, meta, bans, revotes, degenerate
  ticks, restart seams.
- Live poller equivalence vs the REAL Clojure container: vw 8/8 batches +
  pc-meta-02 6/6 batches MATCH (moderation stream live, kill+restart seam,
  tick/watermark semantics, bidToPid/ptptstats row-identical; floats within
  the measured clj self-jitter envelope).
- Full delphi suite green (1134 passed at goal close; CI green at stack tip).

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
3. **Poller throughput**: ~1.66 ticks/s per process — measured on EC2
   (r8g.4xlarge, cost-model study) on biodiversity-sized replays.
   **PRE-FLIP MEASUREMENT REQUIRED: one full-PCA tick of the largest
   prodclone conv (33k ptpts) on the target EC2 instance** — 7 historical
   convs sit above the old Clojure large-conv cutoffs and python runs
   full PCA at every size (est. 0.5-2 min/tick at the extreme; fine for
   7 rarely-active convs, but measure, don't estimate).
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

## Step 0 — land the stack (morning)

1. Triage the 18 Copilot reviews requested overnight (2026-07-26) on
   #2641-#2658; apply/reply per the standing triage rules.
2. Confirm CI green: stack-tip python-ci dispatch + PR checks (see
   spr status; #2648's mid-stack red is a stack-position artifact — the
   same tests pass from #2656 upward — cosmetic for deploy, which builds
   the tip).
3. Merge bottom-up: `jj spr merge --count <N>` (spr handles squash order).
   NEVER the GitHub UI. Then a normal edge deploy.

## Step 1 — shadow in prod (same day)

Infrastructure already in compose (#2625): service `delphi-math-poller`,
profile `delphi-math`, `MATH_ENV=${DELPHI_MATH_ENV:-delphi}` — distinct
from Clojure's env, rows invisible to the server (UNIQUE(zid, math_env)).

```
docker compose --profile delphi-math up -d delphi-math-poller
# env: DELPHI_MATH_ENV=delphi   (engine has one path since the mode collapse)
```

Verify within minutes:
- math_main rows appearing under math_env='delphi' with advancing
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
  'delphi' — pick ONE mechanism and write it down.)
- Watch: TS prefetch (pca.ts caching_tick > last, ~2.5s poll) keeps
  serving; nextComment routing gets comment-priorities; participants
  bidToPid present.

Rollback = revert the env var + restart clojure math. Rows for both envs
coexist; nothing is destroyed by the flip in either direction.

## Step 3 — decommission (later)

Remove the `math` service from compose/deploy; archive the Clojure tree
(it remains the R1 oracle). Follow-ups parked in the journal: equiv-in-CI
decision, improved-mode ban coverage, fraction-cut py-round fix, quirk
un-replication in improved mode (the post-cutover engine option).
