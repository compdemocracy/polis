# Delphi Storage V2 — Conformance Spec

This directory is the **shared contract** between every implementation of the
Delphi Storage V2 repository interface:

- Python: `delphi/delphi_storage/` (backends: memory, DynamoDB, PostgreSQL)
- TypeScript: `server/src/storage/delphi/` (same backends)

Both test suites (pytest and jest) execute the **same** JSON case files in
`cases/`. A backend passes conformance iff every case passes. The prose below
is normative; the case files are executable examples of it.

Design: `delphi/docs/STORAGE_V2_DESIGN.md` (§4.2 entities, §4.3 interface).

## Data model

Six logical entities:

| entity | keying | written by |
|---|---|---|
| `runs` | `job_id` | semantic ops only (queue + manifest) |
| `run_inputs` | `(pk=job_id, sk=kind#part)` | generic ops |
| `artifacts` | `(pk=job_id, sk=artifact_key)` | generic ops + `append_log` |
| `latest` | `scope` | `complete_run` / `advance_latest` only |
| `topic_moderation` | `(pk, sk)` | generic ops |
| `collective_statements` | `(pk, sk)` | generic ops |

Generic ops accept only `run_inputs`, `artifacts`, `topic_moderation`,
`collective_statements`. `runs` and `latest` are mutated exclusively through
the semantic operations so their invariants cannot be bypassed.

### StoreItem

```
{ pk: string, sk: string, attributes: JSON object, blob: bytes | null }
```

- `attributes` is a JSON-safe object. Top-level keys starting with `_` are
  **reserved for backends** (e.g. chunk bookkeeping) and MUST be rejected on
  write (`invalid`).
- `sk` MUST NOT contain U+007F (reserved as the backend chunk-row marker) and
  MUST be non-empty. `pk` MUST be non-empty.
- `blob` is an opaque byte string. Backends MUST store and return it
  bit-exactly. The DynamoDB backend transparently splits blobs larger than
  300 000 bytes across chunk rows (sk prefixed with U+007F) and reassembles
  them on read; chunk rows are invisible to every read operation.
- Numbers inside `attributes` round-trip **by value**: a backend may return
  `2` for a stored `2.0` (DynamoDB does); conformance compares numbers
  numerically, everything else strictly. Non-finite floats (NaN/±Inf) are
  rejected (`invalid`).

### Ordering

All sort-key ordering (query results, claim order) is **UTF-8 byte order**
(equivalently: Unicode code-point order). This is DynamoDB's native range-key
order; PostgreSQL queries must use `COLLATE "C"`; in-memory implementations
must compare UTF-8 bytes (JavaScript: compare `Buffer`s, NOT UTF-16 string
comparison — they differ for astral-plane characters).

### Timestamps

All timestamps are strings, exactly `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC,
millisecond precision, 24 chars) so lexicographic order equals time order.
Semantic ops take an optional explicit `now` (used by conformance cases);
production omits it and the implementation uses the current time.

### RunManifest

Required on enqueue: `job_id`, `job_type` (`FULL_PIPELINE` | `NARRATIVE_BATCH`
| `SERVER_NARRATIVE` | `IMPORTED`), `enqueued_at`. Optional with defaults:
`status` (`QUEUED`), `priority` (0), `version` (0), `zid`, `rid`,
`replay_of`, `provenance` (`pipeline`; `legacy` for imports), `replayable`
(true), `imported_scope_type`, `math_tick_legacy`, `log_seq` (0), and the
dict fields `config_requested`, `config_effective`, `code_version`, `seeds`,
`input_fingerprints`, `stage_status`.

Statuses: `QUEUED → RUNNING → COMPLETED | FAILED`. Every mutation increments
`version` (optimistic lock; all backend mutations are conditional on the
version they read).

### Latest pointers

`scope` strings are `zid#<zid>#<job_type>` or `rid#<rid>#<job_type>`.
A pointer holds `{scope, job_id, seq, job_type, updated_at}`. `seq` is
**monotonic per scope**, starting at 1, incremented by exactly 1 on every
advance. Advancing to the job the pointer already references is a successful
no-op (`advanced=false`, seq unchanged) — this makes `complete_run`
idempotent and crash-healing.

`advance_latest(..., only_if_absent_or_imported=true)` (the backfill
importer's mode, design §6.2 invariant 1) refuses (`advanced=false`) unless
the current pointer is absent or references an `IMPORTED` run.

### Queue semantics

- `enqueue_run` fails with `already_exists` for a duplicate `job_id`, and with
  `invalid` when the manifest's status is not QUEUED or the job_type↔zid/rid
  coupling is unsatisfiable (FULL_PIPELINE needs `zid`; NARRATIVE_BATCH and
  SERVER_NARRATIVE need `rid`) — a run must never be able to complete and then
  fail to derive its latest scopes.
- `claim_next_run` picks the QUEUED run with the smallest **claim order**
  string `f"{9999 - clamp(priority, 0, 9999):04d}#{enqueued_at}#{job_id}"`
  (i.e. highest priority first, then FIFO, then job_id as tiebreak), flips it
  to RUNNING with `worker_id`, `started_at=now`,
  `lease_expires_at = now + lease_seconds`, and returns the manifest; returns
  null when nothing is claimable. Two claimants can never claim the same run
  (conditional write on `version`; losers move to the next candidate).
- `extend_lease` succeeds only if the run is RUNNING and `worker_id` matches.
- `update_run_status` sets FAILED/RUNNING etc. without touching `latest`.
- `merge_run_fields` shallow-merges manifest dict/provenance fields.
- `complete_run` on a QUEUED/RUNNING run sets COMPLETED (+`completed_at`),
  then advances `latest` for every scope derived from the run
  (FULL_PIPELINE → `zid#<zid>#FULL_PIPELINE`; NARRATIVE_BATCH /
  SERVER_NARRATIVE → `rid#<rid>#<job_type>`; IMPORTED → no automatic flip).
  Latest is written **after** the manifest flips COMPLETED (design §4.2:
  the pointer is the commit point). Calling it again is a no-op returning the
  same state (seq does not advance twice). Completing a FAILED run is
  `invalid`.
- `append_log` appends `artifacts` items `sk = log#<seq zero-padded to 8>`
  with `{ts, message}` attributes, allocating seq atomically per job (1-based).
- `list_runs(zid=… | rid=…)` returns manifests newest-first by
  `enqueued_at` (then job_id descending as tiebreak).

## Case file format

Each `cases/*.json`:

```json
{ "name": "...", "description": "...", "ops": [ <op>, ... ] }
```

Ops execute in order against a fresh, empty store. Every op object has `"op"`
plus arguments; assertions live in `"expect"`. An op with `"expect_error": E`
(op-level, instead of `expect`) MUST fail with that error class
(`already_exists`, `not_found`, `invalid`); any other outcome fails the case.
(`expect.error` inside a manifest expectation is the manifest's `error`
field, e.g. after `update_run_status(FAILED, error=...)`.)

Generic ops (arguments mirror the interface exactly):

- `put`: `{entity, item}` where item = `{pk, sk, attributes, blob_b64?, blob_gen?}`.
  `blob_b64` is base64; `blob_gen` generates deterministic bytes:
  `{"kind": "f64_seq", "n": N}` = the little-endian IEEE-754 float64 packing
  of `[0.0, 0.5, 1.0, ...]` (`i * 0.5` for i in `0..N-1`).
- `put_batch`: `{entity, items: [...]}`
- `get`: `{entity, pk, sk, expect: {found, attributes?, blob_b64?, blob_gen?, blob_len?}}`
- `query_prefix`: `{entity, pk, sk_prefix, expect: {sks: [...]}}` (full result
  list, in order)
- `query_between`: `{entity, pk, sk_from, sk_to, expect: {sks: [...]}}`
  (inclusive bounds)
- `delete_partition`: `{entity, pk, expect: {deleted: N}}` (N = logical items)

Semantic ops:

- `enqueue_run`: `{run: {<manifest fields>}}`
- `get_run`: `{job_id, expect: {found, <manifest field subset>}}`
- `claim_next_run`: `{worker_id, lease_seconds, now, expect: {job_id: J | null, lease_expires_at?}}`
- `extend_lease`: `{job_id, worker_id, lease_seconds, now, expect: {ok}}`
- `update_run_status`: `{job_id, status, error?, now, expect?: {<subset>}}`
- `merge_run_fields`: `{job_id, fields, expect?: {<subset>}}`
- `complete_run`: `{job_id, now, expect: {status, latest: [{scope, job_id, seq}]}}`
  (`latest` lists the expected post-state of every scope the run flips;
  empty list = no flips)
- `append_log`: `{job_id, message, now, expect: {seq}}`
- `get_latest`: `{scope, expect: {found, job_id?, seq?, job_type?}}`
- `advance_latest`: `{scope, job_id, job_type, only_if_absent_or_imported?, now, expect: {advanced, seq}}`
- `list_runs`: `{zid? , rid?, status?, expect: {job_ids: [...]}}`

`expect` subset-matching for manifests: every listed key must equal the
manifest's value (numbers numerically); unlisted keys are unchecked.

## Codec fixtures

`cases/codec_*.json` files carry pre-encoded payload envelopes (see
`codec.py` / `codec.ts`): ops

- `codec_roundtrip`: `{value}` — `decode(encode(value)) == value`, for each
  encoding the implementation would choose.
- `codec_decode_fixture`: `{meta, blob_b64, expect_value}` — a blob encoded by
  the *other* language (committed once, generated by Python) MUST decode to
  `expect_value`. This pins the cross-language wire format: envelope `meta`
  (`enc` ∈ `json`, `json+zstd`, `f64+zstd`), zstd frames, little-endian f64.

Compressed bytes are NEVER compared or hashed (zstd output varies by
implementation/level); only decoded payloads and uncompressed byte streams
are.
