# Delphi Storage V2 — Reproducible Runs, Unified Schema, Dual-Backend Storage

> **Superseded in part (P-011/P-033, 2026-09-08).** Nine write-only DynamoDB
> tables and the Python stages that fed them have since been removed from the
> code. Table names below are kept as a point-in-time record; see
> `delphi/docs/RETIRED_DYNAMODB_TABLES.md` for what still exists.

**Status:** DRAFT for review — 2026-07-06
**Author:** Claude (host session "Fable JobID"), for Julien
**Recon basis:** file:line pointers verified 2026-07-06 against `delphi/`, `server/`, and clients.

## 1. Problem

The Delphi pipeline (Python ML in `delphi/`, TypeScript server endpoints, reporting
clients) is **not reproducible from code**:

- No `job_id` flows through the operations pipeline — computations and their stored
  results cannot be traced back to the job that produced them.
- Input sets (votes, comments, moderation state, config) are not recorded per run.
- State is keyed by `zid` and **overwritten** on each re-run — no history, no replay.
- 18 entangled DynamoDB tables (`Delphi_*` prefix) with unclear ownership and duplication.

Goal: every computation replayable; the full state of a conversation reconstructible at
any point in time; a simpler schema; and a storage abstraction that can host the data in
**either DynamoDB or PostgreSQL** (config-selected).

## 2. Decisions (Julien, 2026-07-06)

| Question | Decision |
|---|---|
| Deliverable | Thorough study/audit + target design + phased implementation plan |
| Schema migration | **Dual-run transition**: new schema written alongside old tables; old readers keep working until explicitly switched over |
| Replay strictness | **Input-level reproducibility**: record exact inputs (vote/comment set, moderation state, config, seeds) + all outputs per job; LLM steps store prompt+response but re-runs may differ in phrasing |
| Backend abstraction | **Strictly neutral** repository interface; neither DynamoDB nor Postgres privileged |
| Narrative stores | **Unify** `Delphi_NarrativeReports` (Python) and `report_narrative_store` (server generator) into one entity |
| Clojure `math_main` dependency | **Snapshot as run input** (copy the blob); switching consumers to Python PCA results stays in the parity effort |
| PG backend rollout | **Both sides from the start** — Python AND TypeScript repository implementations land together; PG-only deployment viable as soon as the new schema exists |

## 3. Current-state audit

### 3.1 DynamoDB table inventory (18 tables)

Two schema sources **disagree**: `create_dynamodb_tables.py` (canonical, PAY_PER_REQUEST,
GSIs) vs `polismath/database/dynamodb.py::_ensure_tables_exist` (provisioned, no GSIs,
duplicate for the 6 math tables). Whichever runs first wins.

**Math tables** (written by `polismath/database/dynamodb.py::DynamoDBClient`, raw dicts, no Pydantic):

- `Delphi_PCAConversationConfig` — PK zid, **overwrite**; holds `latest_math_tick` pointer.
- `Delphi_PCAResults` — PK zid + SK math_tick; `Delphi_KMeansClusters`,
  `Delphi_CommentRouting`, `Delphi_RepresentativeComments`,
  `Delphi_PCAParticipantProjections` — keyed by `"{zid}:{math_tick}"` composites. *Look*
  versioned, but **`math_tick = 25000 + (time.time() % 10000)`** — computed at TWO
  serializer sites (`conversation.py:1932` and `:2479`; any fix must hit both) —
  pseudo-random, non-monotonic, collides within 10000s windows. And `run_delphi.py:54-69`
  calls `reset_conversation.py` **unconditionally at the start of every run**, wiping all
  16 tables → effective semantics is single-version replace-everything.

**UMAP tables** (written by `DynamoDBStorage` in
`umap_narrative/polismath_commentgraph/utils/storage.py`, Pydantic-based):

- `Delphi_UMAPConversationConfig`, `Delphi_CommentEmbeddings`,
  `Delphi_CommentHierarchicalClusterAssignments`, `Delphi_CommentClustersStructureKeywords`,
  `Delphi_UMAPGraph`, `Delphi_CommentClustersFeatures`, `Delphi_CommentExtremity` — all
  keyed by `conversation_id` (+item SK), **overwrite per item**, no job_id.
- `Delphi_CommentClustersLLMTopicNames` — the ONE UMAP table versioned by job_id
  (`topic_key = "{job_id}#{layer}#{cluster}"`).

**Narrative/job/server tables:**

- `Delphi_NarrativeReports` — PK `"{report_id}#{section}#{model}"` + SK timestamp —
  append; embeds job_id in section keys.
- `Delphi_JobQueue` — PK job_id, 4 GSIs, optimistic-lock mutation.
- `Delphi_CollectiveStatement` (PK `zid_topic_jobid`), `Delphi_TopicAgendaSelections` —
  **server-owned** (written by Node/TS, only created/reset from Python).

**In-place mutation hotspots:** `Delphi_CommentRouting.priority` (stage 502),
`Delphi_JobQueue` status transitions.

**Pydantic coverage:** only the 7 UMAP tables; math tables, JobQueue, NarrativeReports,
and the actual extremity writer bypass models. Latent bugs: `LLMTopicName` model silently
drops job_id (only the key carries it); `EnhancedTopicName` path references a nonexistent
table key (dead).

### 3.2 job_id lifecycle and gaps

- Created at submission: `scripts/delphi_cli.py:81` `uuid.uuid4()` (server submits
  similarly, but `batchReports.ts` uses a **different format**:
  `batch_report_{rid}_{ts}_{rand}`).
- Propagated **only as env var** `DELPHI_JOB_ID` set by `scripts/job_poller.py:727` —
  `run_delphi.py` doesn't read it; subprocesses just inherit env.
- Lands only in: `umap_narrative/run_pipeline.py:1378` (→ LLM topic-name keys) and
  `801_narrative_report_batch.py` (→ report section keys + JobQueue updates).
- **Dropped everywhere else**: the entire polismath/math side (zero job_id awareness;
  uses pseudo-random math_tick), all UMAP embedding/graph/cluster/keyword/features
  writes, stages 501/502.

### 3.3 Pipeline orchestration & input flow

Two historically-separate pipelines stitched by `run_delphi.py` (no `run_delphi.sh`
anymore), communicating via **live Postgres re-reads** and DynamoDB tables, not in-memory
hand-off:

| # | Stage | Entry | Reads | Writes |
|---|---|---|---|---|
| 0 | Reset | `umap_narrative/reset_conversation.py` | — | **deletes** all DynamoDB rows for zid |
| 1 | Math (PCA/kmeans/repness) | `polismath/run_math_pipeline.py` (raw psycopg2) | **live PG** votes (ALL rows, `ORDER BY created`, LIMIT/OFFSET batches), comments, moderation | DynamoDB PCA/KMeans/Repness/Routing/Projections/Config tables |
| 2 | UMAP narrative | `umap_narrative/run_pipeline.py` | **live PG** comments + `report_comment_selections` (NOT votes) | DynamoDB meta/embeddings/graph/cluster-assignments/topics |
| 3 | Comment extremity | `501_calculate_comment_extremity.py` | **live PG `math_main` (CLOJURE blob!)**, fallback placeholder heuristic from raw votes | DynamoDB `Delphi_CommentExtremity` |
| 4 | Priorities | `502_calculate_priorities.py` | DynamoDB CommentRouting + CommentExtremity | DynamoDB CommentRouting.priority |
| 5 | Visualizations | `700_datamapplot_for_layer.py` | DynamoDB cluster assignments | HTML/PNG/SVG + S3/MinIO |
| N | Narrative (separate job type `CREATE_NARRATIVE_BATCH`) | `801_narrative_report_batch.py` → Anthropic Batch API → `803_check_batch_status.py` | **live PG `math_main` (Clojure)** + live PG comments + DynamoDB clusters/topics | DynamoDB `Delphi_NarrativeReports` |

**Job queue** (`scripts/job_poller.py`, `scripts/delphi_cli.py`, table `Delphi_JobQueue`
keyed by `job_id`, 4 GSIs): optimistic-locking claim via conditional update + `version`;
zombie-lock re-queue; job types actually dispatched are only `FULL_PIPELINE`,
`CREATE_NARRATIVE_BATCH`, `AWAITING_NARRATIVE_BATCH` (PCA/UMAP "types" exist only as
unused `job_config.stages`). Priority stored+indexed but **not used in ordering**. Retry
fields exist but no retry is implemented. Logs stored in the job item, truncated to last
50 entries. Job size routing queries live PG comment count. 3–4 separate PostgresClient
implementations exist (`polismath/database/postgres.py` SQLAlchemy;
`umap_narrative/.../utils/storage.py`; `job_poller.py`'s own; raw psycopg2 in
`run_math_pipeline.py`).

**Input provenance recorded: NONE on the Python path.** No last-vote-timestamp, vote
count, tick, or hash stored with outputs. (Clojure's `math_main` has
`last_vote_timestamp`/`math_tick` but Python only reads, never writes them.) Moderation
filtered in Python not SQL; stage 1 uses raw `votes` (incl. superseded votes) while other
paths use `votes_latest_unique` — inconsistent. Vote-sign flip (PG AGREE=-1 → Delphi
AGREE=+1) duplicated in 3 places.

**For faithful replay, must snapshot:** PG `votes`, `comments`, `participants`,
`conversations`, `report_comment_selections`, **and the Clojure `math_main` blob**
(extremity/consensus/narrative depend on it). Stages 4–5 are replayable from stages 1–3
outputs if those are captured.

**Postgres writes from delphi: none live.** `polismath/database/postgres.py` has
dead-code write methods mirroring the Clojure worker (`write_math_main`,
`increment_math_tick`, `math_ptptstats`, `worker_tasks`) — zero callers. Prior art for a
PG results backend.

### 3.4 Nondeterminism inventory

- Seeded: sklearn PCA (`random_state=42`), math KMeans (`random_state=42` — but init
  depends on vote-encounter row order, deliberate for Clojure parity; the vestigial
  `np.random.seed(42)` was removed lower in this stack), UMAP (`random_state=42`),
  KMeans fallback (42).
- **Unseeded: EVōC clustering** (`run_pipeline.py:184`, `evoc.EVoC(min_samples=5)`) —
  primary nondeterminism source.
- Embeddings deterministic given model, but model version only partially recorded.
- LLMs: no temperature/seed set anywhere; Ollama topic-name responses NOT persisted;
  Anthropic narrative **responses persisted** (`{report_id}#{section}#{model}` key) but
  **prompts NOT persisted** (assembled at runtime from XML templates + live comments).

### 3.5 Config handling

Config passed via env vars + CLI args + hardcoded values; `polismath/components/config.py`
(layered Config with save/load) exists but is NOT wired into the production run path.
`job_config` JSON on job items is **not a faithful record** (records UMAP params the code
hardcodes differently). No record of seeds, library versions, `MATH_ENV`, git SHA, prompts.

### 3.6 Server/TypeScript + client consumption

**Routes** (registered in `server/app.ts` monolith, handlers in `server/src/routes/**`;
clients always speak `report_id`, server resolves rid→zid then queries Dynamo by
`conversation_id=String(zid)`):

- **Job enqueue** (the ONLY Delphi triggers — explicit admin/user action, no cron, gated
  on `delphiEnabled`): `POST /api/v3/delphi/jobs` (uuid job_id, FULL_PIPELINE →
  `Delphi_JobQueue`); `POST /api/v3/delphi/batchReports` (different job_id format,
  CREATE_NARRATIVE_BATCH).
- **Result reads**: `GET /delphi` (LLMTopicNames + NarrativeReports), `GET /delphi/reports`
  (NarrativeReports via GSI, groups by job_id, returns `current_job_id` +
  `available_runs[]` — **the server/clients already have a run-pinning notion**),
  `GET /delphi/visualizations` (JobQueue GSI + S3), `topicMod/*` (LLMTopicNames,
  CommentClusters, TopicModerationStatus, UMAPGraph, ClusterAssignments,
  StructureKeywords), `topicStats`, `collectiveStatement` (writes
  `Delphi_CollectiveStatement`), `topicAgenda/selections` (Postgres table
  `topic_agenda_selections`, stamps `delphi_job_id` from latest COMPLETED job), RSS
  `feeds`, and `nextComment.ts` reads Delphi cluster tables directly for comment routing.
- `GET /reportNarrative` — a **second, server-side narrative generator** writing a
  PARALLEL store `report_narrative_store` via `DynamoStorageService`
  (`server/src/utils/storage.ts`) — the only existing TS storage abstraction; everything
  else uses ad-hoc per-file Dynamo clients (~10 files re-deriving creds/endpoint).
- **Server reads tables that no creation script defines**: `Delphi_CommentClusters`,
  `Delphi_TopicModerationStatus`.
- "Latest run" is inferred by sorting timestamps — no first-class latest pointer.

**Legacy Clojure math prior art for a PG backend**
(`server/postgres/migrations/000000_initial.sql`): JSONB blobs keyed `(zid, math_env)`
(`math_main`, `math_ptptstats`, `math_bidtopid`, `math_cache`, ...; `(rid, math_env)` for
`math_report_correlationmatrix`), monotonic version in `math_ticks`
(`UNIQUE(zid, math_env)`), `caching_tick` for server cache polling
(`server/src/utils/pca.ts`), and `worker_tasks` as the job queue. This is the model to port.

**Clients**: `client-report` is the main consumer (`/delphi`, `/delphi/reports` with
`available_runs`/`current_job_id`, `/delphi/visualizations`, `topicStats`,
`collectiveStatement`, `topicAgenda`); `client-admin` topic moderation uses `topicMod/*`;
`client-participation-alpha` has typed wrappers (`src/api/delphi.ts`, `topicAgenda.ts`).
Clients never see zid.

**Implication: the abstraction layer must be two-sided.** Both the Python pipeline AND
the TypeScript server touch the store directly. A neutral repository interface needs a
Python implementation (pipeline read/write) and a TypeScript implementation (server: job
enqueue + result reads + topicMod/collectiveStatement writes).

### 3.7 Existing docs / prior proposals

- `docs/DATABASE_NAMING_PROPOSAL.md` — authoritative table→key→purpose catalog.
- `docs/JOB_QUEUE_SCHEMA.md` — job table design; documents unimplemented features
  (CANCELLED, dependencies, retention).
- `docs/deep-analysis-for-julien/` — cleanest dataflow map; PG = source of truth.
- `docs/DATA_FORMAT_STANDARDS.md` — composite-key formats (`#` delimiter).
- `docs/REPLAY_HARNESS_DESIGN.md` — the schedule-replay harness (see §8; complementary,
  different kind of replay).
- No existing doc addresses run manifests / input snapshots — a genuinely new axis.
  Closest prior art: golden-snapshot regression harness (snapshots outputs, not inputs).

## 4. Design

### 4.1 Core move

From "18 tables keyed by zid, overwritten on every run" to **"immutable runs +
append-only artifacts + a latest pointer"**. Every computed result becomes an artifact of
a run; "current state of a conversation" is a pointer, not a table. This single change
eliminates: the unconditional `reset_conversation.py` wipe, the pseudo-random
`math_tick`, the in-place `CommentRouting.priority` mutation, and timestamp-sorting to
find "latest".

### 4.2 Six logical entities (replacing 18+ tables)

1. **`runs`** — manifest AND job queue in one (the queue row becomes the manifest as the
   job executes). Key: `job_id` (uuid for ALL job types; the `batch_report_...` format
   retires). Holds: zid, rid, job_type (`FULL_PIPELINE`|`NARRATIVE_BATCH`|
   `SERVER_NARRATIVE`|`IMPORTED` — §6.3), status, priority, optimistic-lock `version`,
   worker/lease fields,
   `config_requested` vs **`config_effective`** (what the code actually used — assembled
   by stages registering their real params at execution time), `code_version` (git SHA +
   library versions), `seeds`, `input_fingerprints` (sha256 + row counts + max vote
   `created`), per-stage status/timings, `replay_of`, `math_tick_legacy` (transition only).
2. **`run_inputs`** — immutable snapshots written once at job start. Key
   `(job_id, kind#part)`. Kinds: `votes` (RAW stream, order preserved — see §4.4),
   `comments` (full rows incl. mutable `mod`), `participants`,
   `report_comment_selections`, `conversation_meta`, **`clojure_math_main`** (full JSONB
   copy — locked decision), `config_effective`.
3. **`artifacts`** — every stage output. Key `(job_id, artifact_key)` using the existing
   `#` composite convention: `math#pca`, `math#kmeans`, `math#repness`,
   `math#routing#<chunk>`, `math#projections#<chunk>`, `umap#meta`,
   `umap#embeddings#<chunk>`, `umap#assignments#<chunk>`, `umap#graph#<chunk>`,
   `umap#keywords#<layer>`, `umap#features#<layer>`, `umap#extremity`,
   `umap#topic#<layer>#<cluster>`, **`priorities`** (own artifact — no more in-place
   mutation), `viz#<layer>#<variant>` (S3 keys + hashes), **`llm#<stage>#<seq>`**
   (prompt+response+model+params — fixes unpersisted Ollama responses and Anthropic
   prompts), **`narrative#<section>#<model>`** (the unified narrative entity),
   `log#<seq>` (append-only, replaces truncate-to-50). Large numeric payloads stored
   zstd-compressed packed float64 (base64 in Dynamo, `bytea` in PG) — bit-exact
   round-trip, ~5-10x smaller; chunking >300KB is a Dynamo-backend concern hidden behind
   the interface.
4. **`latest`** — first-class "latest successful run" pointer. Key `scope`
   (`zid#<zid>#FULL_PIPELINE`, `rid#<rid>#NARRATIVE_BATCH`, `rid#<rid>#SERVER_NARRATIVE`)
   → `job_id` + monotonic `seq` (the legitimate heir of `math_ticks`/`caching_tick`,
   supports server cache polling) + the run's `job_type` (so conditional writes can
   discriminate real vs IMPORTED runs in a single atomic operation — §6.2 invariant 1).
   **Written last, after manifest flips COMPLETED — it is the commit point.** Crashed
   half-written runs are simply never referenced; a janitor (generalizing today's
   zombie-lock re-queue, lands with P7) marks lease-expired runs FAILED while
   **retaining their artifacts and `log#` chunks for diagnosis** — deletion happens only
   via the retention policy (§9).
5. **`topic_moderation`** and 6. **`collective_statements`** — server-owned USER state
   (not computed), separate entities but behind the same repository so PG-only
   deployments include them. PG `topic_agenda_selections` stays a native PG table as today.

Physical naming: Dynamo `Delphi2_*` (prefix configurable); PG schema `delphi` with typed
key columns + JSONB/bytea payload, following the legacy `math_main` pattern
(`server/postgres/migrations/000000_initial.sql:658`). DDL: new migration
`server/postgres/migrations/000019_create_delphi_storage.sql` + additions to
`create_dynamodb_tables.py`.

**Disposition of all 18 existing tables** maps 1:1 into these entities. Notable:
`Delphi_TopicAgendaSelections` (Dynamo) is vestigial → drop after verifying zero readers;
phantom `Delphi_CommentClusters` reads redirect to `umap#assignments`;
`report_narrative_store` → `narrative#` artifacts under `SERVER_NARRATIVE` runs with
one-time backfill as `IMPORTED` runs.

### 4.3 Storage abstraction (both languages, one conformance spec)

- Python package **`delphi/delphi_storage/`**: `interface.py` (protocol), `keys.py`,
  `models.py` (Pydantic), `codec.py` (canonical JSON, zstd, packed floats, chunking,
  Decimal handling), `backends/dynamodb.py`, `backends/postgres.py`, `factory.py`,
  `inputs.py` (snapshot capture), `manifest.py`, `llm_recorder.py`, `replay.py`,
  `conformance/cases/*.json`.
- TS package **`server/src/storage/delphi/`**: `interface.ts`, `keys.ts`, `codec.ts`,
  `dynamoStore.ts`, `postgresStore.ts`, `factory.ts`.
- **Shared conformance spec**: JSON operation-scripts in `delphi_storage/conformance/cases/`
  executed by BOTH pytest (parametrized over backends) and jest — round-trips (unicode,
  floats, chunk-spanning payloads), prefix queries + ordering, latest-pointer monotonic
  seq, queue claim incl. two-claimants-one-wins race, idempotent completion. This keeps
  the two implementations honest.
- Operations: generic `get/put/put_batch/query(prefix|between)/delete_partition` +
  semantic queue ops `enqueue_run / claim_next_run / extend_lease / update_run_status /
  complete_run / append_log / get_latest / list_runs`. Claim: Dynamo = conditional update
  on `version` (lift of working `job_poller.py:490-537` logic); PG = `UPDATE ... WHERE
  job_id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`. Priority finally
  participates in claim ordering (both backends).
- Config: `DELPHI_STORAGE_BACKEND=dynamodb|postgres` (+ `DELPHI_STORAGE_TABLE_PREFIX`,
  `DELPHI_STORAGE_PG_SCHEMA`, `DELPHI_STORAGE_PG_URL`). Migration flags (§6):
  `DELPHI_WRITE_MODE=old|both|v2` (all writers, pipeline AND server-side; `both` for the
  whole M1–M5 window; an explicit tri-state rather than a boolean so its meaning never
  inverts mid-migration, and **fail-loud if unset** while old tables still exist —
  a silently-defaulted writer would break §6.2 invariant 2 undetected),
  `DELPHI_READ_V2=<endpoint groups>|all|none` (serving flip + canary),
  `DELPHI_ENQUEUE_V2` (single queue-master flag),
  `DELPHI_SHADOW_READS=<sample rate>` (divergence logging, both directions).
- Consistency, honestly: never require cross-item atomicity — write order is
  inputs (once, at job start) → artifacts (as stages complete) → manifest COMPLETED →
  latest flip. Dynamo uses ConsistentRead for
  runs/latest; claim conditions on the base table (as today). Float fidelity solved at
  codec level so fingerprints/diffs are backend-independent.
- Consolidation: the 3-4 duplicate PostgresClients collapse into `inputs.py` (source PG
  read ONCE per run — architectural fix: today stages 1-3 each re-read live PG and can
  see different data within one run); ~12 direct-boto3 sites and ~10 ad-hoc server Dynamo
  clients funnel through the factories.

### 4.4 job_id threading + snapshots

- Explicit `--job-id` args: poller passes on the command line; `run_delphi.py` gains
  `--job-id` (auto `local-<uuid4>` for dev) and threads to all 8 stage entry points; env
  fallback kept one transition phase, then removed. math_tick keeps feeding legacy tables
  during dual-write only.
- **Votes snapshot = full compressed copy of the RAW stream** (all rows,
  `ORDER BY created`, order preserved — exactly what stage 1 reads; preserves the
  vote-encounter order the math KMeans init deliberately depends on).
  `votes_latest_unique` derived deterministically in-pipeline (tested against the PG
  view). ~0.3-0.7MB zstd per 100k votes. Full copy chosen over cutoff-pointer
  reconstruction because upstream mutation (GDPR deletions, `comments.mod` changes)
  silently breaks pointer-based replay; hashes still recorded as fingerprints.
- EVōC gets seeded (`run_pipeline.py:184`, currently no seed); if numba parallelism keeps
  residual nondeterminism, record that in the manifest rather than pretend. Seeding
  changes UMAP-side outputs (documented); math goldens unaffected.

### 4.5 Unified narrative store

One narrative entity: `artifacts` rows of kind `narrative#<section>#<model>`. Two producers:

- **Python batch pipeline** (801/803): sections become artifacts of the batch job;
  Anthropic Batch request bodies and results recorded as `llm#narrative#<seq>`.
- **Server `/reportNarrative` generator**: on generation it creates a lightweight run
  (`job_type=SERVER_NARRATIVE`) with a slim manifest (model, params, prompts+responses as
  `llm#` artifacts, input snapshots of exactly what it read) and writes sections as
  `narrative#` artifacts, then flips `latest` for `rid#<rid>#SERVER_NARRATIVE`. Its
  current cache lookup becomes: `latest(...)` → get `narrative#<section>#<model>`.
  `DynamoStorageService` is superseded and deleted at decommission.

## 5. Replay tooling

New CLI `delphi/scripts/delphi_replay.py` backed by `delphi_storage/replay.py`:

- `replay show <job_id>` — manifest, fingerprints, artifact inventory.
- `replay run <job_id> [--stages ...]` — materializes the stored snapshot, runs the
  pipeline with `--input-source=store://<job_id>` (the same seam the snapshot-first phase
  introduces), writes results under a fresh job_id with `replay_of` set. No live PG, no
  reset, no old-table involvement.
- `replay diff <a> <b>` — artifact-by-artifact comparison reusing the tolerance machinery
  from `polismath/regression/comparer.py` (extract the numeric-dict-diff core into
  `polismath/regression/artifact_diff.py` so the golden harness and replay share it).
  Deterministic artifacts diff numerically; LLM-derived artifacts diff structurally
  (presence, keys, models, token counts) per the input-level-reproducibility decision.
- CI-friendly exit codes.

## 6. Zero-downtime migration (expand → backfill → verify → flip → contract)

**Constraint (Julien, 2026-07-06):** this is a production service with many active
conversations. No big-bang migration, no downtime. New data is recorded in BOTH formats
from the start; old data is progressively imported into the new format; **serving uses
only the old format until the import has fully caught up**; then a single reversible
switch moves serving to the new format (while still recording to the old format, just in
case); flip back instantly if anything looks wrong; decommission the old format only
after a trust period.

**Feasibility: yes.** This is the standard expand/backfill/verify/flip/contract
migration pattern, and §4's design already assumed dual-write and flag-gated readers.
The additions are: a backfill importer (one new component), catch-up/parity verification
tooling, and three invariants (§6.2) that make the flip-back guarantee real. Cost:
roughly 4–5 extra PRs plus a longer dual-write window (double writes and double storage
for the transition period — acceptable at Delphi's scale).

### 6.1 Phases

- **M0 — Expand.** New schema exists (Dynamo tables + PG migration), nothing writes.
  Zero behavior change.
- **M1 — Dual-write new data.** `DELPHI_WRITE_MODE=both`: every pipeline run writes old
  tables exactly as today (math outputs unchanged per the golden suite; row-level
  old-table parity proven by `scripts/verify_dual_write.py`) AND v2
  runs/inputs/artifacts/latest. Server-side writers (topicMod, collectiveStatement,
  reportNarrative) dual-write their entities too. Serving: 100% old format.
  **Reproducibility guarantees begin here** — from M1 on, every run has a manifest and
  input snapshot.
- **M2 — Progressive backfill.** `scripts/backfill_v2.py` walks all conversations (and
  report narrative histories) with old-format data and synthesizes **`IMPORTED` runs**
  (§6.3). Rate-limited, idempotent, resumable, safe to run continuously alongside M1.
  Serving: still 100% old format.
- **M3 — Catch-up + verify.** Coverage check: every zid/rid that has old-format data has
  a v2 `latest` pointer (from a dual-written run or an IMPORTED run). Then **shadow
  reads**: serving endpoints keep answering from the old format but (sampled) also read
  v2 and log any divergence (`verify_dual_write.py` for writes; shadow-read middleware
  for reads). Flip is gated on: coverage = 100%, shadow divergence = 0 over an agreed
  observation window.
- **M4 — Flip.** `DELPHI_READ_V2=all` (or group-by-group for a canary day:
  visualizations first, `nextComment` last). Serving: 100% new format. **Old-format
  writes CONTINUE** (both pipeline and server-side user state) — that is the rollback
  insurance. Rollback = set `DELPHI_READ_V2=none`; instant, config-only, loses nothing
  because the old format never stopped being complete (§6.2, invariant 2).
- **M5 — Trust period.** Weeks on v2 serving with old writes still on. Monitoring:
  shadow-compare now runs in the OTHER direction (serve new, sample-compare old) to
  confirm the old path would still be a safe landing zone.
- **M6 — Contract.** Stop old writes (`DELPHI_WRITE_MODE=v2`), retention window, then
  delete old writers (`DynamoDBClient`,
  `DynamoDBStorage`, `DynamoStorageService`), the old read paths, `reset_conversation.py`
  old-table logic, math_tick generation, the `DELPHI_JOB_ID` env fallback; drop the 18
  old tables + `report_narrative_store`.

### 6.2 Invariants that make flip-back safe (the load-bearing details)

1. **Importer never clobbers real runs.** The backfill only sets a `latest` pointer via
   a conditional write (set-if-absent, or only over another IMPORTED run with a lower
   `seq`) — atomic in one operation because the `latest` item carries the run's
   `job_type` (§4.2); a read-then-write check would reintroduce the race this invariant
   exists to close. If a conversation got a dual-written (real) v2 run since M1, the importer
   skips it — real provenance always beats imported.
2. **Every writer is bidirectional for the whole M1–M5 window.** Not just the pipeline:
   topic moderation, collective statements, and the server narrative generator must
   write old AND new on every mutation, in both serving modes. If v2-only writes were
   allowed after the flip, flipping back would silently lose user actions taken while on
   v2. This invariant is what makes M4's rollback lossless, and it is tested (a
   write-through-both assertion in the route tests for every mutating endpoint).
3. **The queue never has two masters.** The poller claims from BOTH queues during the
   whole transition (old `Delphi_JobQueue` first, then v2 `runs`); the ENQUEUE target is
   a single flag flipped with M4 (and back on rollback). One job exists in exactly one
   queue, both queues drain naturally, no drain-and-wait step, no double execution.

### 6.3 `IMPORTED` runs (backfill semantics)

The old format holds only the LATEST state per conversation (overwritten per run), so
the importer synthesizes **one v2 run per conversation** capturing current old-format
state: `job_type=IMPORTED`, `provenance=legacy`, artifacts mapped 1:1 from the old
tables (math tables at `latest_math_tick`, UMAP tables, extremity, priorities), plus
per-narrative-run IMPORTED runs reconstructed from `Delphi_NarrativeReports` /
`report_narrative_store` history (those two are append-keyed, so historical narrative
runs ARE recoverable). IMPORTED runs have **partial manifests**: no input snapshots, no
seeds, no config_effective — they are servable but **not replayable**, and are marked so
(`replayable=false`). This is not a design compromise to fix later: the old format never
recorded its inputs, so pre-M1 history is unrecoverable in principle (independently
confirmed in `REPLAY_HARNESS_DESIGN.md` §10). The importer is a scan-cursor checkpointed
job (resumable), rate-limited, and re-runnable at any time — re-running refreshes
IMPORTED runs for conversations whose old-format state changed and which have no real v2
run yet.

### 6.4 Fresh deployments skip the migration

M0–M6 exist for the running production install. A fresh deployment (or a dev
environment) has no old data: it starts directly on v2
(`DELPHI_READ_V2=all`, `DELPHI_ENQUEUE_V2=true`, `DELPHI_WRITE_MODE=v2`) with either
backend — including PG-only — as soon as Stacks 1–3 code exists.

### 6.5 What this changes vs. a naive gradual reader switch

The per-endpoint-group `DELPHI_READ_V2` flags remain, but their role changes: they are a
**canary mechanism at flip time**, not a months-long progressive migration. Readers stay
on the old format wholesale until M3's gate passes, because serving a half-backfilled v2
would show older data than the old format for not-yet-imported conversations — the
user-visible regression this strategy exists to prevent.

## 7. Phased implementation (PR-sized, TDD, spr-stacked)

~22-28 PRs total — plan as **4 milestone stacks**:

**Stack 1 — Foundation** (P1-P4):
- P1: this design doc + conformance case schema + first cases.
- P2: Python `delphi_storage/` interface+codec+**both backends** + pytest conformance
  (dynamo-needing tests follow the standard skip convention; PG tests use dockerized test
  PG).
- P3 (∥ P2): TS `server/src/storage/delphi/` both backends + jest conformance reading the
  SAME case files.
- P4: DDL (Dynamo table additions + PG migration 000019); conformance green against real
  stores.

**Stack 2 — Provenance plumbing** (P5-P8):
- P5 (∥ anything): `--job-id` explicit threading through all 8 entry points.
- P6: input snapshots — 6a capture-only at job start; 6b stages read from snapshot
  (`--input-source` seam). **Golden suite must pass unchanged for both** (riskiest step,
  deliberately isolated; vote-order + votes_latest_unique-derivation tests are the RED
  phase).
- P7: manifest + dual-write per stage group (math; umap 500s; 501/502+700s; 801/803),
  each PR with `verify_dual_write` parity test.
- P8: LLM recorder (Ollama + Anthropic), EVōC seeding, `config_effective` registration.

**Stack 3 — Backfill + consumers** (P9-P11e):
- P9: **backfill importer** `scripts/backfill_v2.py` (IMPORTED runs per §6.3, no-clobber
  invariant, checkpointed cursor, rate limit) + coverage report
  (`scripts/backfill_coverage.py`). RED phase: importer-idempotence and
  no-clobber-vs-real-run tests.
- P10 (∥ P9): server v2 READ code behind `DELPHI_READ_V2` (default `none`), one endpoint
  group per PR — lands dark, exercised by tests and shadow reads only until M4.
- P11: server-owned writes become **bidirectional** (topicMod, collectiveStatement,
  reportNarrative dual-write old + new; write-through-both assertions per §6.2
  invariant 2); dual-queue poller + single enqueue-target flag (§6.2 invariant 3);
  shadow-read sampling middleware + divergence logging.

**Stack 4 — Flip, replay, contract** (P12-P14):
- P12: replay CLI + `artifact_diff.py` extraction + replay-of-recorded-fixture e2e test
  (∥ Stack 3 — depends only on Stack 2).
- P13: M3/M4 operational gate — coverage=100% + shadow-divergence=0 dashboards, then the
  flip (`DELPHI_READ_V2=all`), canary order visualizations-first/`nextComment`-last,
  reverse-direction shadow compare during M5.
- P14: contract (M6) — stop old writes, retention window, delete old
  writers/read-paths/tables/reset/math_tick/env-fallback.

Critical path: P1 → P2/P3 → P4 → P6 → P7 → P9/P10/P11 → P13 → P14. The flip itself (M4) is
an ops action gated on M3 evidence, not a code change.

**Hard constraints honored throughout:** output-invariance on `polismath/` math results
(golden suite runs in every phase touching input plumbing; NO numerical changes); `uv`
for Python; standard pytest `--ignore` set locally; propose-then-wait applies to anything
touching math-core logic (the redesign deliberately avoids it — `conversation.py` changes
are surfacing-only).

## 8. Relationship to REPLAY_HARNESS_DESIGN.md (H)

Two different meanings of "replay", deliberately kept separate:

- **H** replays a conversation's *vote history* through both math engines at chosen
  recompute schedules — a research harness for Clojure-parity science (gap measurement,
  R1 certification, R2 schedule inference). Its §10 documents that historic math states
  are unrecoverable today (`math_main` latest-only) — the very gap Storage V2 closes
  going forward.
- **Storage V2** replays a *recorded production job* from its input snapshot — an
  operations capability.

Convergences to exploit: both reuse `ConversationComparer` tolerance machinery (the
`artifact_diff.py` extraction in §5 serves both); H's per-step recording could later
write into `run_inputs`/`artifacts` under synthetic job_ids; and once V2 manifests exist,
R2-style schedule inference becomes unnecessary for post-V2 data (the schedule is
recorded, not latent).

## 9. Open considerations

- **Data retention/GDPR**: input snapshots copy votes/comments outside the source PG.
  Needs a purge path (`delete_partition` per job + a per-zid purge tool replacing today's
  `reset_conversation.py` role) and a stated retention policy for old runs. Include purge
  tool in P6.
- Residual EVōC/numba nondeterminism possible even seeded — manifest records determinism
  status.
- `viz#` artifacts reference S3 objects; S3 lifecycle must match run retention.

## 10. Verification

- **Conformance suite** (pytest + jest, same JSON cases) green on both backends — the
  contract.
- **Golden-snapshot invariance**: standard test suite + `scripts/regression_comparer.py`
  — unchanged math outputs at every phase; any diff = regression.
- **Dual-write parity**: `scripts/verify_dual_write.py` compares old-table rows vs v2
  artifacts per job on real runs.
- **Migration gates (§6)**: backfill coverage = 100% of conversations with old-format
  data; shadow-read divergence = 0 over the observation window before M4; bidirectional
  write-through assertions on every mutating endpoint; a rehearsed flip-back
  (`DELPHI_READ_V2=all` → `none` → `all`) on staging with writes flowing, proving zero
  loss.
- **End-to-end replay proof** (the point of it all): run a job on a dev conversation →
  mutate the source data (add votes, moderate a comment) → `replay run <job_id>` →
  `replay diff` shows numeric-identical math/umap artifacts vs the original run.
- **PG-only smoke test**: `DELPHI_STORAGE_BACKEND=postgres DELPHI_READ_V2=all` full
  pipeline + server reads with the DynamoDB container stopped.
- Server: jest integration tests per switched endpoint group against seeded v2 fixtures;
  client-report manual check of `/delphi/reports` `available_runs`/`current_job_id`.
