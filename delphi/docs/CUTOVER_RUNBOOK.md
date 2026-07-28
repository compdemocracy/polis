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
   **PRE-FLIP MEASUREMENT DONE (2026-07-27, s7)** — one full-PCA tick of
   the largest prodclone shape (33,422 ptpts x 783 cmts, 2.0M votes;
   synthesized, seeded) on r8g.4xlarge via
   scripts/large_conv_tick_bench.py:
   **cold tick 519.6s (~8.7 min); WARM (steady-state) tick 1856.0s
   (~30.9 min)** — the warm tick is ~3.6x the cold one (legacy kmeans
   lineage warm-start dominates). Local M-series cross-check: 430.8s /
   2095.3s — same order, so this is algorithmic, not instance-bound.
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
