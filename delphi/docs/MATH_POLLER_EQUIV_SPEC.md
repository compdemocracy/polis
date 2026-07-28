# Poller-equivalence harness — spec (goal condition 2)

**Status:** spec — 2026-07-24 (session 5). Companion to `MATH_POLLER_DESIGN.md`
(the py poller under test) and `GOAL_R1_PARITY.md` ("DONE means": *poller
equivalence: identical math_main/bidToPid/ptptstats rows and tick/watermark
semantics vs the Clojure math container on the same vote streams, including a
restart-mid-schedule seam*).

## 1. Shape

One Postgres, two writers, one comparer:

```
scripts/poller_equiv.py  (CLI orchestrator)
  ├─ seed:   create throwaway DB (polis_equiv) with the polis schema subset
  │          (conversations, votes, comments, math_main, math_bidtopid,
  │          math_ptptstats, math_ticks); insert conversation + comments;
  │          votes are inserted in TIMED BATCHES by the driver loop below
  ├─ clj:    the REAL container loop — clojure -M:run full (math/), env
  │          DATABASE_URL=…/polis_equiv, MATH_ENV=clj-ref,
  │          POLL_FROM_DAYS_AGO=10000 (historical vote timestamps)
  ├─ py:     scripts/math_poller.py, same DB, MATH_ENV=py-shadow,
  │          POLISMATH_ENGINE_MODE=clojure-legacy, same poll window
  ├─ feed:   insert vote batch k → wait until BOTH math_envs' math_main
  │          rows advance past batch k's votes (poll by caching_tick /
  │          lastVoteTimestamp in the blob) → next batch. Batches mirror a
  │          battery schedule's cuts (vw uniform8; pc-meta-02 uniform6-mod
  │          for the moderation stream — comments.modified drives mod polls)
  ├─ seam:   after batch R (mid-schedule), SIGKILL the py poller process,
  │          restart it (load-or-init warm path — the from_dict restore
  │          fixed 2026-07-24), continue feeding. Also restart the clj
  │          container at the same seam for symmetry (its load-or-init).
  └─ compare per batch k and per table:
       math_main.data     → the SAME acceptance as certify (StepComparer:
                            structural identity on memberships/ids/
                            selections/priorities; declared float
                            tolerances; subgroup-* excluded per Q7)
       math_bidtopid.data → EXACT equality (bid→pids map)
       math_ptptstats.data→ structural + tolerances
       caching_tick       → per-env MAX+1 monotonicity (not cross-env equal —
                            each env has its own sequence)
       math_ticks         → equals the number of completed recomputes per env
       watermark semantics→ each batch processed exactly once (no vote
                            reprocessing: assert vote_counts in the blob
                            match cumulative inserts at each cut)
```

## 2. Acceptance — the float bar

The PRODUCTION clj container cannot be Q10/Q12-pinned (no Clojure source
edits allowed): its cold-tick PCA start is unseeded-random, so even two clj
container runs differ in float tails. The bar is therefore:

1. **clj self-jitter envelope first**: run the clj side TWICE on the same
   stream (fresh DB each). Per compared key, record the max cross-run
   delta — the envelope. (H-A/H-B self-jitter pattern, journal 2026-07-18.)
2. **py must sit within the envelope** (per key: |py − clj| ≤ envelope ×
   safety factor 2, floor 1e-9) AND be STRUCTURALLY identical (memberships,
   cluster ids, repness/consensus selections, priority ordering) to the clj
   reference run.
3. Report the envelope + verdict per (dataset, batch, table) in a compact
   JSON verdict file (terse-output contract: ≤40 lines to stdout).

Datasets: vw (knife-edge-free warm chain, certified 8/8) + pc-meta-02
(mod/meta warm chain, certified 6/6). Both small → container runtime fine.

## 3. Build plan (delegable, in order)

- **A. schema + seeder** — smallest schema subset the clj container's
  queries touch (poller.clj/postgres.clj: votes, comments, conversations,
  math_main, math_bidtopid, math_ptptstats, math_ticks; check
  db/load-conv's SELECT for exact columns). Seeder loads a replay dataset
  (real_data loaders) and inserts conversation+comments; vote inserts
  exposed as `insert_votes(conn, dataset, from_slot, to_slot)`.
- **B. runners** — subprocess wrappers: clj container (env as §1; verify
  `clojure -M:run full` works headless from math/ — bin/run wraps it),
  py poller CLI. Health = row appears in math_main for the env.
- **C. feeder + comparer** — batch loop, per-batch row snapshots, the
  StepComparer adapter (math_main.data JSON ≈ the certify blob surface —
  verify key overlap first; bidToPid exact; tick/watermark assertions).
- **D. seam + envelope** — restart choreography, two clj runs, envelope
  computation, verdict JSON.

Integration gates at the top level after each stage; the harness lives in
`polismath/replay/` + `scripts/` next to certify (same store/report
conventions). Tests: unit-test the comparer adapter + watermark assertions
with canned rows (no containers); the full harness is an opt-in script
(RUN_POLLER_EQUIV=1), like the RUN_CLJ_INTEGRATION certify tests.

## 4. Known hazards (from session-5 recon)

- Postgres reachable at localhost:15432 via OrbStack pgproxy (socat →
  polis-dev-postgres-1:5432); create polis_equiv there, NEVER touch
  polis-dev / polis_prodclone.
- Vote timestamps are historical → POLL_FROM_DAYS_AGO=10000 on BOTH sides.
- The clj container writes ALL zids it sees in the window — the throwaway
  DB isolates this.
- 4h JVM self-reboot (bin/run timeout) — irrelevant at harness timescales.
- polismath/poller/__init__.py "load-or-init finding" docstring is stale
  (base_clusters DO restore since 2026-07-24) — refresh it in stage B.
