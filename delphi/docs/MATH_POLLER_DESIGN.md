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
 "oldest_unresolved_age_ms":412000,"pending_promotion":0,"promoted_total":0,
 "refusals_total":3,"role":"primary","routed_total":0,"routing":0,
 "schema":"math_poller.capacity/1"}
```

`pending_promotion` counts unresolved `large` records whose staged bundle covers their
input and is newer than this label's bundle; `promoted_total` counts promotions since
the process started; `oldest_unresolved_age_ms` covers every unresolved `large` record,
pending promotion included (§8).

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

## 8. The large memory class (P-073 PR3)

Conversations the small poller routes away (§7) are computed by a second process of the
same image, the **large worker**, and published into the small poller's label by the small
poller itself. Everything here is off by default: nothing changes until
`MATH_CAPACITY_ROUTING=1` on the small poller and a large worker runs.

```
small poller (MATH_ENV=python)            large worker (MATH_ENV=python-large,
  routes by size, never computes a          MATH_CAPACITY_CLASS=large)
  routed conversation                         reads the manifest each readiness interval
  writes the capacity manifest  ───────►      computes only the manifest's conversations
  (private store, conditional put)            publishes them under python-large (its own
                                              lock, the ordinary writer)
  promotes python-large -> python  ◄──────    never writes python
  (one transaction, compare-and-set)
```

One writer per label holds: the small poller is the only writer of `python` (its own
publications and promotions, both under the target tick lock), the large worker the only
writer of `python-large` (lock key `polis-math-python:python-large`). No schema change:
`python-large` is a third value of the existing `math_env` column.

### 8.1 The capacity manifest

`polismath/poller/capacity_manifest.py`. One private JSON object
(`polis-math-capacity-manifest/1`), written only by the small primary, read by the large
worker: the routed records (zid, sizes, need, input mark, first-unresolved time,
`exceeds_largest`), the writer's label, run, source commit, binding, small compute
capacity and declared large budget, the staged label and the applied restage nonce. It
names zids, so it lives only in a private store, never in a log line, metric or receipt.

| `MATH_CAPACITY_MANIFEST_URI` | Backend |
|---|---|
| `s3://<bucket>/<key>` | an object in the bucket the Delphi service already uses (`AWS_S3_BUCKET_NAME`), recommended key `math-capacity/<label>/manifest.json`; `AWS_S3_ENDPOINT` (MinIO under docker) and `AWS_REGION` as the rest of Delphi; credentials from the environment or the instance role |
| `file:///<path>` or an absolute path | a local file (tests; docker runs sharing a volume) |

Writes are conditional (`If-Match` on the last-read ETag, `If-None-Match: *` to create);
a lost precondition writes nothing and the writer re-reads before its next write. The
pinned boto3 predates the `IfMatch` parameter, so the S3 backend sets the two headers
through botocore's event hooks (signed with the request; S3 and MinIO answer 412). The
large worker reads with `If-None-Match` and reuses its last manifest when unchanged.

### 8.2 The small poller's loop

`polismath/poller/promotion.py`, once at start and then on the reconciler's cadence
(`MATH_POLLER_RECONCILE_INTERVAL_MS`), only with routing on:

1. **Restore** (once, retried until the store answers): routed records the state file
   lacks are read back from the manifest. A manifest written for another label is never
   overwritten; an unreadable one is replaced.
2. **Restage** (`MATH_CAPACITY_RESTAGE=<16-64 hex>`, once per value, kept in the state
   file and the manifest): every `large` record gets an input mark of the database clock,
   so the large worker rebuilds it and the loop promotes the result (same votes, later
   write). Remove the nonce after use.
3. **Re-size on a binding change**: a routed record classified under another binding (a
   resized box, a recalibrated model, changed fractions or large budget) is sized again
   without waiting for new input; one that now fits is un-routed and submitted as a
   REBUILD, so the small poller computes it at once.
4. **Promotion** (`MATH_CAPACITY_PROMOTE=1`): every `large` record's staged and target
   bundles are fingerprinted (`math_fingerprints`: tick, newest vote, write time,
   completeness; no payload read). A complete staged bundle newer than the target is
   promoted with `PostgresClient.promote_bundle`.
5. **Manifest**: written when its content changed.

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

### 8.3 The large worker

`polismath/poller/large_class.py`, `MATH_CAPACITY_CLASS=large`. Each readiness interval
the driver reads the manifest and either refuses to compute anything (empty dynamic
allowlist; the reason on its capacity line) or drives the pool:

| `refusal` | When |
|---|---|
| `manifest_missing` / `manifest_unreadable` | no manifest yet, or not the closed shape |
| `label` | written for another label pair (writer label is not `MATH_CAPACITY_PROMOTE_INTO`, or staged label is not this worker's `MATH_ENV`) |
| `skew` | the version-skew guard: the small poller's source commit (`MATH_POLLER_SOURCE_COMMIT`) differs from this worker's; it waits for the deploy |
| `budget` | the manifest declares a large budget above this worker's own memory budget |

Otherwise the dynamic allowlist is the manifest's conversations that fit this worker's
compute capacity (`exceeds_largest` and oversized entries are never attempted; the
latter count as `unfit`); the ordinary vote and moderation loops update them warm; a
conversation whose staged bundle is missing, incomplete or older than its input is
submitted as a REBUILD (cold full history) when it is not cached, when the restage nonce
changed, or when its input is older than two readiness intervals; cached conversations
that left the manifest are dropped. Every reservation is exclusive. A transient store
failure keeps the last allowlist.

Startup refusals (exit 2, before any connection): `MATH_CAPACITY_CLASS` other than
`small`/`large`; for `large`, any unparsable `MATH_CAPACITY_*` value, no manifest URI, no
`MATH_CAPACITY_PROMOTE_INTO`, `MATH_ENV` equal to it or to the served label or different
from `MATH_CAPACITY_STAGED_LABEL`, `MATH_POLLER_ALLOW_SERVED_ENV=1`, `MATH_BACKFILL=1`,
routing/promotion/restage set (small-poller settings), sharding, and a declared
`MATH_CAPACITY_LARGE_BUDGET_MB` above this worker's own budget.

Its readiness lines carry a class token before the line kind, so no large line contains
the heartbeat, discovery-stale or alert-test phrases (the P-072 filters match them across
the whole log group) and the readiness collector never selects them:

```
math_poller class=large readiness/1 role=primary progress=ok {...}
math_poller class=large discovery_stale/1 {...}
```

The JSON bodies are unchanged (`capacity` is null). Its capacity line:

```json
{"allowlisted":1,"busy":1,"class":"large","label":"python-large","queued":1,
 "refusal":null,"role":"primary","schema":"math_poller.capacity/1","skew":0,"unfit":0}
```

`busy`: allowlisted conversations queued, running or behind their input (the scale-in
input); `queued`: those behind their input.

### 8.4 Settings

| Setting | Default | Where | Effect |
|---|---|---|---|
| `MATH_CAPACITY_CLASS` | `small` | both | `large` runs the large worker |
| `MATH_CAPACITY_MANIFEST_URI` | unset | both | unset: no hand-off (small); refused (large) |
| `MATH_CAPACITY_PROMOTE` | `0` | small | `1` (needs routing): promote staged bundles |
| `MATH_CAPACITY_STAGED_LABEL` | `python-large` | both | the large worker's label |
| `MATH_CAPACITY_PROMOTE_INTO` | unset | large | the small poller's label; required |
| `MATH_CAPACITY_RESTAGE` | unset | small | a 16-64 hex nonce; a malformed one is ignored and logged |
| `MATH_CAPACITY_LARGE_BUDGET_MB` | unset | both | small: the `exceeds_largest` line and the manifest's declared budget; large: refused when above its own budget |

On the small poller a bad value turns routing off and is logged (§7); on the large worker
it refuses to start.
