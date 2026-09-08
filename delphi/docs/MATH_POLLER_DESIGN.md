# Python Math Poller — Clojure math-container replacement design

**Status:** Design + phase-1 implementation — 2026-07-18 (overnight session "Fable-Pyclj-Parity")
**Recon basis:** every file:line below verified against the working tree on 2026-07-18
(full recon in journal session entry). Companions: `SEQUENTIAL_BITS_PORT_SPEC.md` (the
warm-started engine this poller hosts), `REPLAY_HARNESS_DESIGN.md` (validation),
`STORAGE_V2_DESIGN.md` (provenance plumbing, to be wired when its stack lands).

## 1. Goal

A Python service that **completely replaces the Clojure math Docker container and its
poller**: polls Postgres for votes/moderation, maintains per-conversation math state
in-memory with the warm-started sequential engine, and writes the same four Postgres
tables the TS server and legacy clients consume — first in shadow mode next to Clojure,
then as the only math worker.

## 2. What the Clojure container actually does (verified)

Production runs `clojure -M:run full` (`math/bin/run:11`) = **poller-system only**
(`system.clj:51-58` — darwin/task components commented out): config, logger,
core-matrix-boot, postgres pool, conversation-manager, **vote-poller, mod-poller**.

Responsibilities checklist:

| Duty | Clojure | Disposition |
|---|---|---|
| Vote poll: `SELECT * FROM votes WHERE created > watermark ORDER BY zid,tid,pid,created`, ~1s cadence, group by zid, advance watermark to max(created) | poller.clj:12-37, postgres.clj:132-145 | **replace** |
| Mod poll: `SELECT * FROM comments WHERE modified > watermark`, same loop | postgres.clj:148-161 | **replace** |
| Per-zid serialized actor: coalesce queued batches (`take-all!`), process `[:votes :moderation]` in order, retry-chan (buf 10), errorconv EDN dump on failure | conv_man.clj:291-388 | **replace** |
| `math_main` upsert with **`caching_tick = (SELECT max(caching_tick)+1 … WHERE math_env=?)`** | postgres.clj:323-338 | **replace — fidelity-critical** (TS prefetch polls `caching_tick > last` every ~2.5s, pca.ts:84-151) |
| `math_bidtopid` upsert (bid→pids map, prep-bidToPid conv_man.clj:35-40) | postgres.clj:369-380 | **replace — net-new writer** (server bidToPid/bid/getPidsForGid depend on it) |
| `math_ptptstats` upsert | postgres.clj:350-361 | replace |
| `math_ticks` atomic increment (`ON CONFLICT … math_tick+1 RETURNING`) | postgres.clj:292-295 | **replace — must be atomic**, not read-modify-write |
| `math_profile` telemetry | postgres.clj:340-348 | scope out |
| Boot: watermark starts `POLL_FROM_DAYS_AGO=10` back; conv `load-or-init` from `math_main` + full vote rebuild; 4h JVM reboot (`timeout -s KILL 14400`) | poller.clj:15, conv_man.clj:188-207, bin/run | replicate load-or-init + configurable window; **no 4h reboot** (JVM workaround, not semantics) |
| CSV export (darwin→S3), report correlation, `update_math` task | tasks.clj, export.clj | **scope out**: not started in `full`; CSV export fully served by `server/src/routes/export.ts` + `report.ts`; correlation is a no-op ("No longer supported", conv_man.clj:209-219) |

Consumers pinned: `pca.ts:98` (caching_tick prefetch), `pca.ts:360` (`WHERE zid=? AND
math_env=?` — `Config.mathEnv` selects rows), `nextComment.ts:70-119`
(comment-priorities routing), `participants.ts:6-23` (bidToPid), `report.ts` (server CSV
export reads getPca!), client-participation + client-report via `/api/v3/math/pca2`.

## 3. Architecture (phase 1)

```
scripts/math_poller.py (CLI)
  └─ polismath/poller/service.py   MathPollerService
       ├─ watermark loops (threads): votes (created>wm), moderation (modified>wm)
       │    reuse PostgresClient.poll_votes / poll_moderation (already flip signs
       │    to Delphi convention at ingress)
       ├─ per-zid dispatch: ConversationWorkerPool
       │    one FIFO queue + lock per zid → strict serialization per conversation,
       │    coalescing (drain queue, merge batches, votes-then-moderation order,
       │    mirroring take-all!/split-batches), bounded pool across zids
       ├─ engine: Conversation chain in-memory (update_votes/update_moderation →
       │    recompute) — Clojure-exact legacy semantics, the engine's only
       │    path since the mode collapse (2026-07-27)
       ├─ load-or-init: on first message for a zid, restore from math_main
       │    (from_dict) + rebuild rating matrices from full vote history
       │    (conv-poll offset 0 analog), mirroring conv_man.clj:188-207;
       │    non-persisted warm state (smoother counters) cold-starts, exactly
       │    like a Clojure worker restart
       ├─ writer: polismath/poller/math_writer.py
       │    math_main (Clojure-exact caching_tick=MAX+1 SQL), math_bidtopid
       │    (derived from base_clusters like prep-bidToPid), math_ptptstats,
       │    atomic math_ticks; all under one math_env string; one tick value
       │    shared across the writes (Clojure writes all three with the same
       │    math_tick, conv_man.clj:158-169)
       └─ error handling: on update failure, dump conv.to_dict() + failing batch
            to an errorconv JSON in a dump dir, requeue once (retry cap),
            then park the zid with a loud log (circuit breaker)
```

Config (mirrors Clojure + delphi's existing unwired poller config,
`delphi/polismath/components/config.py:216-269`): `DATABASE_URL`, `MATH_ENV` (the
math_env string written), `VOTE_POLLING_INTERVAL` (ms, default 1000),
`MOD_POLLING_INTERVAL` (1000), `POLL_FROM_DAYS_AGO` (10), `MATH_ZID_ALLOWLIST` /
`MATH_ZID_BLOCKLIST`, worker-pool size.

## 4. Cutover phases

1. **Shadow (this PR):** new compose service `math-python` (profile-gated,
   `--profile math-python`; renamed s7 from delphi-math-poller) running
   next to the Clojure `math` service, writing under a
   DIFFERENT `math_env` (e.g. `MATH_ENV=python` while Clojure writes `prod`/`dev`).
   `UNIQUE(zid, math_env)` makes the rows invisible to the prod server. No consumer
   change, zero production risk.
2. **Parity monitoring:** a comparer job diffs Python-vs-Clojure `math_main` rows per
   zid/tick (ClojureComparer/stepcompare tolerance classes; R1 certification via the
   replay harness feeds the same verdict). Exit criterion: agreed tolerance classes
   green over an agreed soak window on dev + prodclone traffic.
3. **Flip:** point the server at the Python rows — either set the poller's `MATH_ENV`
   to the server's `Config.mathEnv` (and stop Clojure), or flip the server's
   `MATH_ENV`. One env-var change, instantly reversible.
4. **Decommission:** remove the `math` service from compose/deploy; archive the Clojure
   tree (it remains the R1 oracle in the repo).

## 5. Explicitly scoped out of phase 1

CSV export + correlation tasks (dead/covered — §2); `math_profile`; multi-worker
horizontal scaling (per-zid serialization makes a single instance correct; scale-out
needs zid sharding — later); DynamoDB writes (the existing delphi job pipeline is
untouched); storage-v2 provenance wiring (lands with that stack — the writer keeps a
seam for job-id/run-manifest fields).

## 6. Testing

- Unit: watermark advancement (strict `>`, max-of-batch), per-zid coalescing order
  (votes before moderation, batch merge), writer SQL (caching_tick MAX+1, atomic tick)
  against mocked cursors; bidToPid derivation from base_clusters; load-or-init
  restoration path with a canned math_main blob.
- Integration (opt-in, needs Postgres like tests/test_postgres_real_data.py): end-to-end
  poll→compute→write on a seeded conversation; shadow-mode row invisibility
  (`math_env` isolation); restart resumes from math_main.
- Live shadow soak on dev compose = phase 2.
