# Python Math Poller — Clojure math-container replacement design

**Status:** Design + phase-1 implementation — 2026-07-18 (the overnight Pyclj-parity session)
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

## 7. Capacity disposition and the demand line

`polismath/poller/capacity.py`. Every conversation the poller's memory budget
refuses (a live `OverBudget`, or a backfill `over_memory_ceiling`) gets one record,
classified by its cold-rebuild size under the admission model:

| Disposition | Meaning |
|---|---|
| `small` | fits this poller's budget after all; the refusal had another cause |
| `large` | above `MATH_CAPACITY_ROUTE_FRACTION` of the small compute capacity (budget minus the measured baseline); `MATH_CAPACITY_KEEP_FRACTION` once already routed |
| `exceeds_largest` | above `MATH_CAPACITY_LARGE_BUDGET_MB` minus the model base; never counted as demand |

A `large` record is unresolved from its first refusal (or routed batch) until this poller
publishes the conversation itself, or until this poller's label carries a promoted
large-class bundle that covers its newest input (§8). It is demand while unresolved and
no staged bundle covering its input already waits for promotion. Records live in memory,
and in `MATH_CAPACITY_STATE_PATH` when set (a private file; it names zids).

| Setting | Default | Effect |
|---|---|---|
| `MATH_CAPACITY_ROUTING` | `0` | `1`: a cold touch or rebuild classified `large` or `exceeds_largest` is not computed here (cache entry dropped, work resolved, no dump/retry/park); a refusal classified `large` is resolved the same way. `0`: nothing changes in what is computed; the records and lines are observation only |
| `MATH_CAPACITY_ROUTE_FRACTION` | `0.9` | route before the wall |
| `MATH_CAPACITY_KEEP_FRACTION` | `0.7` | hysteresis: un-route only below this |
| `MATH_CAPACITY_LARGE_BUDGET_MB` | unset | unset: nothing is `exceeds_largest` |
| `MATH_CAPACITY_RESIZE_S` | `3600` | a routed conversation is re-sized at most this often on new input (or when the binding changes) |
| `MATH_CAPACITY_STATE_PATH` | unset | unset: records are in memory only |

A bad value turns routing off and is logged; it never stops the poller. These settings
are not part of `PollerConfig`, so the readiness `poller_config` digest and the
backfill's calibration binding do not change.

The demand line, once per readiness interval, is a bare JSON event (no log prefix):

```json
{"class":"small","exceeds_largest":0,"fits_small":0,"label":"python","large_demand":1,
 "large_leased":null,"large_poisoned":0,"oldest_unresolved_age_ms":412000,"pending_promotion":0,
 "promoted_total":0,"refusals_total":3,"role":"primary","routed_total":0,"routing":0,
 "schema":"math_poller.capacity/1"}
```

`pending_promotion` counts unresolved `large` records whose staged bundle covers their
input and is newer than this label's bundle; `promoted_total` counts promotions since
the process started; `oldest_unresolved_age_ms` covers every unresolved `large` record,
pending promotion included (§8). With the job queue configured (§8), `large_demand` and
`large_leased` are the queue's counts of worker class `large` (`pq_class_depth`,
migration 000024: `queued` = queued + waiting, `leased` = running), read once per
readiness interval; without it `large_demand` is the records' count above and
`large_leased` is null (never a false 0). `large_poisoned` counts the routed records
the queue refused as poisoned (§8.1), parked until a new deploy or a ruling.

Counts and closed labels only. A primary always reports counts (0 with no demand); a
standby reports `role=standby` with null counts; a primary whose snapshot failed logs
no line, so a missing small poller is missing data, never a false 0. CloudWatch Logs
Insights:
`filter schema = "math_poller.capacity/1" and role = "primary" | stats max(large_demand) by bin(5m)`.
A metric filter pattern:
`{ ($.schema = "math_poller.capacity/1") && ($.class = "small") && ($.role = "primary") }`
with metric value `$.large_demand`.

The same counts ride on the `math_poller readiness/1` line as `capacity` (null on a
standby; optional on parse, so earlier lines still validate). The heartbeat phrase and
every other readiness key are unchanged.

## 8. The large memory class (P-073 PR3, r2)

Conversations the small poller routes away (§7) are jobs on the Postgres job queue
(`polis-queue`: migrations 000019 and 000023, and the `polis-queue/3` functions that
admit worker class `large` and stage `math_rebuild`). The large box runs the `polis-jobs`
daemon as a worker of class `large`; for each job it runs this entrypoint as a child
for one conversation, which stages the bundle under its own label; the small poller
promotes it into its own label itself. Everything here is off by default: nothing
changes until `MATH_CAPACITY_ROUTING=1` on the small poller, and nothing is enqueued
without `MATH_CAPACITY_QUEUE_DSN`.

```
small poller (MATH_ENV=python)                 the large box
  routes by size, never computes a               polis-jobs daemon, POLIS_JOBS_WORKER_CLASS=large
  routed conversation                              claims one math_rebuild job, leases it, runs
  inserts one math_rebuild job per   ───────►      scripts/math_poller.py --job as a child:
  routed conversation (pd_enqueue,                   exactly the frame's zid, a cold full-history
  scope math:<label>:<zid>, one                      rebuild under its own budget, published
  active job per scope)                              under python-large (its lock, the ordinary
  reads pq_class_depth each readiness                writer); never writes python
  tick: large_demand, large_leased
  promotes python-large -> python   ◄──────      the job's output manifest names the staged
  (one transaction, compare-and-set)             bundle's tick and newest vote
```

One writer per label holds: the small poller is the only writer of `python` (its own
publications and promotions, both under the target tick lock), the child the only
writer of `python-large` while it runs (lock key `polis-math-python:python-large`,
taken once; held by another writer, the attempt fails and the daemon retries). No
schema change on the math side: `python-large` is a third value of the existing
`math_env` column.

### 8.1 The job

`polismath/poller/capacity_queue.py`. The small poller reaches the queue only through a
closed inventory of SQL functions (`pd_enqueue`, `pd_release_scope`, `pq_class_depth`,
`pq_job_status`, `pq_cancel`, `pq_attempt_logs`), one short transaction per call on its
own connection, every value bound
with a fixed cast, over `MATH_CAPACITY_QUEUE_DSN`: a login that is a member of
`polis_queue_executor` with no table access and no path to the owner role, re-checked
on every connection. The publication path keeps `DATABASE_URL`.

A job is admitted the moment a cold touch, rebuild or memory refusal classifies
`large` (§7), and again by the promotion pass (§8.2) whenever a `large` record has no
staged bundle covering its newest input. Both are idempotent: the scope
`math:<label>:<zid>` admits one active job (queued, waiting or running); a second
admission returns it. The scope is released by the daemon after a terminal attempt
whose exit it proved (`pd_release_scope`, which re-checks every condition: every job
of the scope terminal, every exit proven, no provider work); when an admission hands
the poller a terminal job still holding its guard (a cancel nobody ran, a daemon lost
before its release) the poller calls the same guarded function and asks once more.
Terminal status alone releases nothing. New input after a finished job is a new job.
The poison latch is the contract's (migration 000024): when a scope's last three jobs
all died under the code image being admitted now, `pd_enqueue` answers `poisoned`
(naming the latest dead job) and admits nothing; the poller parks the record with
that reason (not asked again under this source commit; `large_poisoned` on the line)
until a new deploy, or the restage nonce (the operator's ruling), un-parks it. The run's `input_uri` carries the admission frame
(`frame://inline/` + base64url, bound by `input_sha256`): the zid, `inputs.math_env` =
the staged label, and the typed math config (`staged_label`, `target_label`,
`need_bytes`, `input_through_ms`, `binding`, `source_commit`), which the daemon checks
whole before any child spawns and carries whole into the child's frame, where every
key is checked again before anything runs. The record keeps the job id (in the state
file when set). `exceeds_largest` is never a job.

### 8.2 The small poller's loop

`polismath/poller/promotion.py`, once at start and then on the reconciler's cadence
(`MATH_POLLER_RECONCILE_INTERVAL_MS`), only with routing on:

1. **Restage** (`MATH_CAPACITY_RESTAGE=<16-64 hex>`, once per value, kept in the state
   file): every `large` record gets an input mark of the database clock, so the pass
   below asks for a fresh job and promotes the result (same votes, later write). Remove
   the nonce after use.
2. **Re-size on a binding change**: a routed record classified under another binding (a
   resized box, a recalibrated model, changed fractions or large budget) is sized again
   without waiting for new input; one that now fits is un-routed and submitted as a
   REBUILD, so the small poller computes it at once.
3. **Promotion** (`MATH_CAPACITY_PROMOTE=1`) and the jobs: every `large` record's staged
   and target bundles are fingerprinted (`math_fingerprints`: tick, newest vote, write
   time, completeness; no payload read). A complete staged bundle newer than the target
   is promoted with `PostgresClient.promote_bundle`, and only on the receipt of the job
   that produced it: the record's job is `succeeded` and finalized (`pq_job_status`),
   and the attempt's manifest row (`pq_attempt_logs`) hashes to the job's output digest,
   names the job and names the staged bundle's label, tick and newest vote. A bundle
   the child committed before the daemon finalized the attempt, or whose job failed,
   has no receipt and is not served; without a queue nothing is promoted. A record
   whose staged bundle is missing, incomplete or behind its input is enqueued (at most
   a page per tick); a poisoned record is not.

Nothing is restored from the queue at start: a routed conversation this process has no
record of is sized again on its next cold touch and enqueued again, which the guard
makes idempotent; the records are a cache of sizes and marks, the queue rows the truth.

`promote_bundle` is one transaction: mint the target tick (row-locks `(zid, python)`),
take the staged tick row `FOR SHARE` (a staged publication in progress is waited for; the
staged writer cannot publish mid-copy), re-read both bundles and compare with what the
loop saw (`superseded`), require the staged bundle complete and valid by the shared
validity SQL (`invalid_staged`, `missing_staged`) and newer (`not_newer`: never an
older newest vote, and on an equal newest vote only a later write), copy the two
companions and then `math_main` (same `caching_tick` rule as every publication), and
check the target's four ticks. Any refusal rolls everything back, the tick included. The
payloads never leave Postgres.

A record is resolved when the staged bundle covers its input (written at or after its
newest input) and the target is not older than it. The backfill skips routed
conversations (`_BackfillHost.accepts`), and a backfill job admitted before a
conversation was routed is not run.

### 8.3 The queue child

`polismath/poller/rebuild_child.py`, `scripts/math_poller.py --job`, started by the
daemon under its child contract (`polismath.job_child`: the attempt's identity in the
environment, the frame at `DELPHI_FRAME`, the output manifest at
`DELPHI_OUTPUT_MANIFEST`). It binds to the frame (stage `math_rebuild`; the one zid; the
frame's `inputs.math_env` must equal its `MATH_ENV`), takes the label's single-writer
lock once, runs one cold full-history rebuild under an exclusive reservation against its
own budget through the ordinary engine path, publishes the three-table bundle under the
staged label with the ordinary writer, and writes the manifest (`inputs.math_env`,
`inputs.math_tick` and `inputs.vote_hwm` = the staged bundle's label, tick and newest
vote; no stores outside Postgres). It starts no readiness reporter and prints no
readiness or capacity line, so nothing it logs contains the heartbeat, discovery-stale or
alert-test phrases.

Refusals, exit 2 before any connection: a frame whose `config.source_commit` differs
from `MATH_POLLER_SOURCE_COMMIT` (the version-skew guard; a set and an unset commit are
skew; a frame without the key is admitted and logged, the row's `code_version` being
the daemon's guard); a served label (`prod`, `python`), an empty one, or the job's target
label; `MATH_POLLER_ALLOW_SERVED_ENV=1`, `MATH_BACKFILL=1`, or routing, promotion or the
restage nonce in its environment (small-poller settings); a declared
`MATH_CAPACITY_LARGE_BUDGET_MB` above its own budget. Failed attempts, exit 1: a
conversation above its compute capacity, another writer holding the label, an engine
error. Exit 5: the bundle published but the manifest could not be built.

### 8.4 Settings

| Setting | Default | Where | Effect |
|---|---|---|---|
| `MATH_CAPACITY_CLASS` | `small` | small | `large` refuses to start: the large class is a child, not a poller |
| `MATH_CAPACITY_QUEUE_DSN` | unset | small | the queue login (an executor member); unset: routed conversations are not enqueued |
| `MATH_CAPACITY_QUEUE_ENV` | unset | small | the queue env namespace; required with the DSN |
| `MATH_CAPACITY_PROMOTE` | `0` | small | `1` (needs routing): promote staged bundles |
| `MATH_CAPACITY_STAGED_LABEL` | `python-large` | small | the label the child writes (its `MATH_ENV`) |
| `MATH_CAPACITY_RESTAGE` | unset | small | a 16-64 hex nonce; a malformed one is ignored and logged |
| `MATH_CAPACITY_LARGE_BUDGET_MB` | unset | both | small: the `exceeds_largest` line; child: refused when above its own budget |

On the small poller a bad value turns routing off and is logged (§7); in the child it
refuses the job.

### 8.5 Compose and the deploy hooks

`docker-compose.yml` forwards every setting above to `math-python` (which pins
`MATH_CAPACITY_CLASS=small` and the literal staged label). There is no large poller
service: the large box's worker is the `polis-jobs` daemon run with
`POLIS_JOBS_WORKER_CLASS=large` inside the Delphi image, whose compose service lands with
the daemon; until then a box whose service type is `delphi-large` writes the readiness
identity (`scripts/after_install.sh`) and starts nothing, and `scripts/application_stop.sh`
stops nothing there. `docs/configuration.md` lists the knobs;
`tests/test_compose_math_env.py` pins the forwarding; `tests/poller/test_capacity_queue.py`
and `test_capacity_queue_postgres.py` cover the queue side.
