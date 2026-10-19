# Shared Rust contracts

This dependency contains no database, HTTP client, credentials or provider work.
The CLI consumes this crate by path; other Rust services can share it the same way. The queue adapter
re-exports `Completion<Value>`; the route and CLI share `Pca2ErrorCode` spellings.
The CLI error envelope remains `polis-cli/1` and remains distinct from legacy
server wire bytes. Moving these types changes no queue SQL or route response.

`upstream` recognizes the error codes the server's routes return, plus the
narrative exchange. Guidance is curated; internal exceptions, dynamic SDK
text and localized client strings retain an HTTP fallback. Only allowlisted
codes are echoed. No automatic request retry is introduced. HTTP 200 failures
and unconfirmed writes keep `outcome: unknown`; recovery advice is not evidence
that a write was rejected.

Narrative input/export schemas remain owned by the exchange server. This change
does not claim all Node routes or the job DAG have typed Rust equivalents.

## Reviewing a contract

The reviewable artifacts are the contracts below (their names, fields and
rules), the JSON Schema documents and the golden fixtures under
`tests/fixtures/`, not the Rust source. Each serialized contract is versioned
by name (`delphi-job-result/1`, `delphi-run/1`): a field change is a new
version, never an edit of `/1`.

Both Delphi contracts encode through `wire` (`wire::to_json`, the bytes a
route serves, and `wire::to_json_pretty`, the bytes a fixture holds). For
the same value it writes the bytes Node's `JSON.stringify` writes:

- numbers as JavaScript writes them: `1`, never `1.0`; `0.0000015`; `1e-7`;
  `1e+21`. They are read with correct rounding, as `JSON.parse` reads them.
- object keys in JavaScript's order: array-index keys (`"0"`, `"12"`) first,
  ascending, then every other key in insertion order. A record keyed by
  topic or section keeps the order it was built or read in.
- the same string escapes: `"`, `\` and control characters only.

## `delphi-job-result/1`

One Delphi job's outputs as one versioned envelope: the shape a future
`GET /api/v3/delphi/runs/:job_id` serves. No route serves it yet. It is a
port of the Node contract in `server/src/contracts/delphiJobResult.ts` with
no field change.

Five states, told apart by `status`, each with its own rules:

| `status` | `job_id` | `as_of` | `attempt` | `failure` | `outputs` |
|---|---|---|---|---|---|
| `ready` | the job | completed_at | `null` | `null` | the requested families |
| `pending` | the job | `null` or a time | `null` | `null` | `{}` |
| `running` | the job | started_at | the current attempt (≥ 1) | `null` | `{}` |
| `failed` | the job | started_at | the attempt that ended it | a closed code, never log text | `{}` |
| `empty` | `null` | `null` | `null` | `null` | `{}` |

Every envelope has, in this order: `contract_version`, `job_id`, `run_id`,
`conversation_id` (the zinvite, never the zid), `report_id`, `status`,
`as_of`, `inputs` (the math snapshot the run captured: `math_tick`,
`math_env`, `vote_count`, `comment_count`, the models and prompt versions),
`attempt`, `failure` (`code`, `stage`, `attempt`, `at`), `pinned`, `label`,
`outputs`, `omitted`. `omitted` lists every family `outputs` does not carry,
so a client never reads "not requested" or "not produced" as "empty"; the
Rust type computes it from `outputs` and cannot disagree with it.

The nine families, and the run-record families (`delphi-run/1`) each is
read from:

| Family | Read from |
|---|---|
| `topics_by_layer` | `Delphi_CommentClustersLLMTopicNames`, `Delphi_CommentHierarchicalClusterAssignments` |
| `assignments` | `Delphi_CommentHierarchicalClusterAssignments` |
| `keywords` | `Delphi_CommentClustersStructureKeywords` |
| `umap` | `Delphi_UMAPGraph`, `Delphi_CommentHierarchicalClusterAssignments` |
| `visualizations` | `visualizations` (the datamapplot pages) |
| `narratives` | `Delphi_NarrativeReports` |
| `collective_statements` | `Delphi_CollectiveStatement` |
| `topic_stats` | `topic_stats`, over the run's math snapshot |
| `consensus_inputs` | the run's math snapshot only |

None of the run record's additions (each family's state, producing run,
upstream runs and publication, the math snapshot identity) is in `/1`: the
served bytes stay the Node shape. Serving them, or a family `/1` does not
have, is a `/2`.

**The proof that Rust and Node agree.**

- `schema_json()` is `server/src/contracts/delphiJobResult.schema.json` and
  `client-report/src/contract/delphiJobResult.schema.json` byte for byte, and
  `schema_json_alpha()` is
  `client-participation-alpha/src/api/contract/delphiJobResult.schema.json`
  byte for byte (that copy is prettier's layout; `schema.rs` reproduces it).
- `tests/fixtures/delphi-job-result/` holds 19 envelopes recorded by Node from
  the Node contract's own test fixtures (`contractHelpers.ts`: the five
  states, the four distinct recorded states, each family served alone, and
  one envelope of number, escape and key-order edge cases). Each is Node's
  `JSON.stringify(envelope, null, 2)` with keys in the schema's property
  order. Rust decodes each one and encodes it back to the same bytes, pretty
  and compact. To record them again, with the server's dependencies
  installed: `node queue-rs/polis-contracts/tests/fixtures/delphi-job-result/record.cjs`.
- The 30 values the Node contract test rejects are refused by the Rust type
  and by the schema.

**Where the Rust type is narrower than the schema.** Each value below passes
the JSON Schema and is refused by Rust, because the schema states the rule
only in prose or because JavaScript could not write the value back with the
same bytes:

- `omitted` that does not list exactly the families `outputs` lacks;
- a topic's `seen` that is not `agree + disagree + pass`;
- a cluster below `-1` (`-1` is unassigned);
- a tid, layer id or group id key that is not a canonical decimal (`"01"`);
- an empty topic key;
- an additional key of an open object (narrative documents, pca2 entries)
  that is an array index such as `"7"`: JavaScript lists such a key before
  the typed fields, an order a fixed field list cannot write;
- a duplicate object key (`JSON.parse` keeps the last one), and a string
  with an unpaired surrogate (Rust strings cannot hold one).

## `delphi-run/1`

One Delphi job's run record: who ran it, on what, how it went, and what each
result family it touches looks like now. It is the record a future
`GET /api/v3/delphi/runs` lists, assembled from tables and functions the
executor login can already read. No route serves it yet.

Fields, in this order:

- **identity:** `job_id`, `run_id` (`null` only for a legacy import, never
  an invented id), `root_job_id`, `parent_job_id`, `graph_id`,
  `conversation_id`, `report_id`, `origin` (`queued`, `legacy_import`),
  `kind` (`delphi_jobs.kind`);
- **execution:** `stage` (`polis_queue_jobs.stage`), `state`, `attempt`
  (`attempt_id`, `number`, `lease_epoch`, `max_attempts`, `outcome`,
  `started_at`, `ended_at`, `process_exit_confirmed_at`), and on a graph
  root `nodes`: each other node's `job_id`, `run_id`, `stage`, `state` and
  `attempt`;
- **math snapshot:** `math_snapshot`, the math the run is computed against:
  the math engine's published `math_main` row for the conversation, captured
  when the run is admitted, named as the row names it (`math_env`,
  `math_tick`, `caching_tick`) plus `data_sha256`, the digest of the captured
  `data` blob. Delphi computes no math of its own; `null` until admission
  captures the snapshot. A tick of -1, `math_main`'s default for a row never
  ticked, is not a published generation and is refused;
- **inputs:** what the run read when it started (its manifest's `inputs`):
  `math_env`, `math_tick`, `math_caching_tick`, `comment_set_sha256`,
  `vote_hwm`, and `inputs_sha256`, the sha256 of
  `{"math_env":…,"math_tick":…,"math_caching_tick":…,"comment_set_sha256":…,"vote_hwm":…}`
  in that order. The digest is computed, never stored, so it cannot
  disagree with the values. When both are present, the math the run read
  must be the snapshot it was admitted against;
- **configuration:** `config_effective` (kept byte for byte),
  `code_version`, `models` (`embedding`, `cluster`, `cluster_seed`,
  `topic_names`, `narrative`, `statement`), `prompt_versions`;
- **outputs:** `manifest_sha256` and `families`, one entry per result family
  the run touches (below);
- **cost:** `llm_tokens_in`, `llm_tokens_out`, `provider_requests`
  (`request_id`, `provider`, `batch_id`, `state`);
- `pinned`, `label`, `created_at`, `completed_at`, and `failure` (a closed
  code, never log text).

The closed sets are the executor's own, and a test reads them from the
migrations: `state` is `polis_queue_jobs.state` (`queued`, `running`,
`retry_wait`, `parked`, `succeeded`, `dead`, `cancelled`); an attempt's
`outcome` is `polis_queue_attempts.outcome` (the same plus `expired`);
`stage` is `polis_queue_jobs.stage` without the test-only `noop`; `kind` is
`delphi_jobs.kind`; a provider request's `state` is
`delphi_provider_requests.state`.

**The families.** A run produces these (`RunFamily`), in this order:
`Delphi_CommentEmbeddings` (all-MiniLM-L6-v2); the EVoC and UMAP output,
`Delphi_CommentHierarchicalClusterAssignments`, `Delphi_UMAPGraph`,
`Delphi_UMAPConversationConfig`; keywords and features,
`Delphi_CommentClustersStructureKeywords`, `Delphi_CommentClustersFeatures`;
topic names, `Delphi_CommentClustersLLMTopicNames`; `topic_stats`;
`Delphi_NarrativeReports`; `Delphi_CollectiveStatement`; `visualizations`.
Stored families keep their `delphi_result_catalog` names; `topic_stats` and
`visualizations` have no catalog row yet.

The other catalog families are legacy (`LegacyFamily`): Delphi's own math
stage (`Delphi_PCAConversationConfig`, `Delphi_PCAResults`,
`Delphi_KMeansClusters`, `Delphi_RepresentativeComments`,
`Delphi_PCAParticipantProjections`, and `Delphi_CommentRouting`, whose
priorities Delphi's stage 4 wrote), both retired because the math comes
from the math engine's `math_main`; `Delphi_CommentExtremity`;
`Delphi_TopicAgendaSelections`; `report_narrative_store`. A record lists a
legacy family only as published, carried by the DynamoDB import; no new run
computes or produces one.

**Each family is published on its own.** A family entry has a state:

| `state` | Carries |
|---|---|
| `not_started` | nothing else: the run will produce it and has not begun |
| `running` | `producer`, `upstream` |
| `succeeded` | `producer`, `upstream`, `batch`, `publication`: published, and served now |
| `failed` | `producer`, `upstream`, `failure` (`reason`, a closed code; `at`) |
| `superseded` | `producer`, `upstream`, `batch`, `publication`: published, then replaced by a later publication of the same family |

`producer` is the run (`job_id`, `run_id`) that produced the family, which
can be an earlier run than the record's own. `upstream` names, for each
family this family depends on, the run it was computed from. `batch` is the
stored batch (`batch_id`, the attempt that sealed it; `content_sha256`;
`row_count`). `publication` is the family's own pointer generation and the
scope it belongs to. Today the database keeps one pointer per conversation
and scope, so the families of one run share a scope and generation; the
record already has one publication per family.

The dependencies between families, declared in `RunFamily::upstream`. When
an upstream family's publication changes, its dependents are recomputed; a
dependent whose `upstream` run is not the upstream family's current producer
was computed over an older run:

| Family | Depends on | Why |
|---|---|---|
| `Delphi_UMAPGraph`, `Delphi_UMAPConversationConfig`, `Delphi_CommentHierarchicalClusterAssignments` | `Delphi_CommentEmbeddings` | UMAP and EVoC run on the embeddings |
| `Delphi_CommentClustersStructureKeywords`, `Delphi_CommentClustersFeatures` | `Delphi_CommentHierarchicalClusterAssignments` | keywords and TF-IDF features are per cluster |
| `Delphi_CommentClustersLLMTopicNames` | `Delphi_CommentHierarchicalClusterAssignments`, `Delphi_UMAPGraph` | topics name the clusters, from the comments nearest each centroid in the UMAP map |
| `topic_stats` | `Delphi_CommentClustersLLMTopicNames`, `Delphi_CommentHierarchicalClusterAssignments` | the votes on each topic's comments, over the math snapshot |
| `Delphi_NarrativeReports` | `Delphi_CommentClustersLLMTopicNames` | narratives are written over the topics run that named the topics |
| `Delphi_CollectiveStatement` | `Delphi_CommentClustersLLMTopicNames` | a statement is written for a topic |
| `visualizations` | `Delphi_UMAPGraph` | the datamapplot draws the UMAP run's map |

Legacy families have no declared dependencies.

A `DelphiRun` is built only through `DelphiRun::new` or by decoding, and
both refuse:

- a legacy import with a run id, stage, attempt or nodes, or that is not
  terminal; a queued job without a run id or a stage;
- a `kind` that does not follow from the stage (`pd_enqueue`: `full_pipeline`,
  `narrative`, `math_rebuild`; a graph node: its stage without `graph_`);
- a graph position that does not hold: a job that is its own parent, a
  parent other than the graph's root, a parent outside a graph, a graph
  stage outside a graph or a writer stage inside one, nodes on a record
  that is not the root's, a node listed twice;
- a running job without a running attempt or a running attempt on any
  other job; a succeeded job whose attempt did not succeed; a running
  attempt that has ended; `completed_at` before the job is terminal;
- a `failure` on a job that is not dead or cancelled, a `cancelled` code on
  a dead job (or another code on a cancelled one), a failure naming an
  attempt other than the job's last;
- a clustering seed without a clustering model; a submitted or completed
  provider request without its batch id; a provider request or a family
  listed twice;
- a family state without exactly the parts its row above lists; an
  `upstream` that does not name each declared upstream family exactly once;
  a family produced here under another run id, in a batch other than the
  one its last attempt sealed, or published by a job that has not
  succeeded; another run's family listed as anything but published;
- a legacy family listed as anything but published, or produced by a job
  that is not a legacy import; a run whose inputs read other math than the
  snapshot it was admitted against;
- any unknown key, at any depth.

`tests/fixtures/delphi-run/` holds eleven golden records (writer runs that
succeeded, are running, died, and were cancelled queued and running; a
parked narrative batch with its provider request; a synchronous statement
save whose family was superseded; a graph root with its nodes and a graph
node; a legacy import; a math rebuild whose lease expired). Together they
use every job state, attempt outcome, stage and family state; each decodes
and encodes back to its own bytes.

`delphi_result_read` is the request/refusal contract for the assignments-only
`GET /api/v3/delphi/runs/:job_id?families=assignments` route. Success uses the
unchanged `delphi_job_result` types; the `delphi-run/1` companion supplies
per-family producer provenance. The two route switches remain off by default.
