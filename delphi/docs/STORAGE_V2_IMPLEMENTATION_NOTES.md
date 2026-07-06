# Storage V2 — Implementation Notes (decisions, invariants, traps)

**Audience:** whoever continues this work — human or AI, including sessions
with less context than the one that built Stack 1 + P5/P6. Read this BEFORE
touching any `delphi_storage/` or seam code. The design itself is in
`STORAGE_V2_DESIGN.md` (what to build and why); this file records HOW it was
built: the decisions taken during implementation, the invariants that hold
the system together, and the traps that were discovered the hard way.

**State as of 2026-07-06** (session "Fable-JobId-implement"):

| Phase | PR | Contents |
|---|---|---|
| P1 | #2597 | Design doc (merged via the parity stack; until it lands on edge, read it with `git show d029f8aca:delphi/docs/STORAGE_V2_DESIGN.md`) |
| P2 | #2598 | Python `delphi_storage/` — interface, codec, memory/DynamoDB/PG backends, conformance cases |
| P3 | #2599 | TypeScript twin `server/src/storage/delphi/` + jest on the SAME case files |
| P4 | #2600 | DDL: `Delphi2_*` inlined in `create_dynamodb_tables.py`, PG migration `000019`, CI wiring |
| P5 | #2601 | `--job-id` threading through every pipeline entry point |
| P6a | #2602 | Input snapshots (capture) + per-job purge |
| P6b | (this PR) | `--input-source=store://<job_id>` read seam |

PRs are stacked (each based on the previous; bottom targets `edge`). Every
phase was TDD (failing tests first) and self-reviewed by a subagent; each
review's findings and fixes are recorded as a comment on the respective PR —
**read those comments**, they document real bugs and why the fixes look the
way they do.

---

## 1. Hard constraints (never relax these)

1. **Golden invariance.** Math outputs must not change in ANY phase. The
   golden suite (`tests/test_regression.py`) runs in the standard test
   command and is the gate. If a change would alter a golden value, it is
   wrong (or it needs the propose-then-wait path below).
2. **Propose-then-wait** (from `CLAUDE.local.md`): anything touching
   `polismath/` math logic requires an explicit proposal to Julien and an
   explicit "go" BEFORE applying. P6b's seam got an explicit go; the seam
   deliberately changes only *where rows come from*, never what happens to
   them.
3. **Quirk parity over correctness.** Stage 1's
   `fetch_comments`/`fetch_moderation` compare the INTEGER `mod` column to
   STRINGS (`'-1'`/`'1'`) — those Python-side filters NEVER fire in
   production. Do not "fix" this: it would change math inputs. The snapshot
   path routes through the SAME transformation functions
   (`_comment_rows_to_dicts`, `_moderation_rows_to_dict` in
   `polismath/run_math_pipeline.py`) so the quirk reproduces identically.
   Any future fix is a separate, Julien-approved change with golden
   re-recording.
4. **Vote-encounter order is load-bearing.** The math KMeans init depends on
   the order votes are fed (`conversation.py` `update_votes`; see
   `docs/INVESTIGATION_K_DIVERGENCE.md`). Stage 1 reads
   `ORDER BY v.created` with **no tiebreaker** (the votes table has no
   serial/PK column). Never add a tiebreaker to `VOTES_BATCH_SQL` — it
   could reorder tied rows vs today's live reads and change outputs.
5. **The production vote read does NOT flip signs.** `fetch_votes()` in
   `run_math_pipeline.py` (which flips) is DEAD CODE; the batch loop in
   `main()` feeds raw PG signs. Snapshots therefore store raw signs. The
   flip (vote * -1, PG AGREE=-1 → Delphi AGREE=+1) happens only in the
   umap-side `votes_latest_unique` reads.

## 2. Cross-language contract (P2/P3)

- **The conformance cases are the spec.** `delphi_storage/conformance/`
  (normative `README.md` + `cases/*.json`) is executed by BOTH pytest
  (`tests/test_delphi_storage_conformance.py`, parametrized over
  memory/moto/real-DynamoDB/real-PG) and jest
  (`server/__tests__/unit|integration/delphiStorage.*`). **Any semantic
  change must be expressed as a case file change first** — that is the only
  mechanism keeping the two implementations honest.
- **Wire format decisions** (`codec.py` / `codec.ts`):
  - canonical JSON = keys sorted by UTF-8 byte order, compact separators, no
    NaN/Infinity. JS must NOT use default `Array.sort` or `<` on strings
    (UTF-16 vs code-point order differs for astral-plane chars — there is a
    conformance case with 😀 vs U+FFFD that catches this).
  - packed floats = little-endian IEEE-754 float64, bit-exact.
  - compression = zstd. Python: `zstandard` package. TS: **Node's built-in**
    `node:zlib` zstd (Node ≥ 22.15) — deliberately no new npm dependency.
  - Envelope `meta.sha256`/`meta.bytes` describe the UNCOMPRESSED payload.
    **Never compare or hash compressed bytes** — zstd output differs across
    implementations/levels. Cross-language pinning works by committing
    Python-encoded blobs as fixtures (`cases/codec_fixtures.json`) that TS
    must decode.
  - Numbers round-trip **by value**, not type: DynamoDB returns `2` for a
    stored `2.0` (Decimal normalization); the conformance comparators are
    numeric-tolerant for numbers, strict for booleans. Keep ints ≤ 2^53 in
    shared cases (JS precision).
- **snake_case data fields in TS.** Manifests/pointers are shared wire
  objects (`job_id`, `enqueued_at`, ...). TS method names are camelCase, but
  the DATA is snake_case on both sides. Do not "clean this up".
- **Timestamps** are strings, exactly `YYYY-MM-DDTHH:MM:SS.mmmZ` (24 chars),
  so lexicographic order = time order. Semantic ops accept an explicit `now`
  (used by conformance cases); production omits it.

## 3. Store semantics decisions (P2)

- **`runs` and `latest` are NOT reachable via generic ops** — semantic ops
  only, so the optimistic lock and monotonic seq can't be bypassed.
- **Optimistic locking:** every run mutation is a conditional write on the
  `version` that was read (DynamoDB `ConditionExpression`; PG
  `FOR UPDATE SKIP LOCKED` / `WHERE version =`). Queue claims: candidates
  from the sparse `claim-index` GSI (eventually consistent — that's fine,
  staleness only wastes an attempt), the claim itself conditions on the base
  table.
- **Claim order** = `f"{9999-priority:04d}#{enqueued_at}#{job_id}"` —
  priority desc, then FIFO, then job_id tiebreak. Same string on both
  backends (PG `COLLATE "C"` = byte order = DynamoDB range-key order).
- **`complete_run`**: scopes derived BEFORE the status flip (a run that
  can't publish must fail cleanly, not end up COMPLETED-but-unpublished —
  found in review); pointer written LAST (the commit point); idempotent and
  crash-healing (re-completing re-attempts the pointer advance without
  double-incrementing seq). `enqueue_run` validates the job_type↔zid/rid
  coupling for the same reason (`validate_enqueueable`).
- **`advance_latest(only_if_absent_or_imported=True)`** is the backfill
  importer's no-clobber mode (design §6.2 invariant 1) — implemented and
  conformance-tested NOW, consumed in P9.
- **Chunked blobs (DynamoDB only)** use *generation-tagged* chunk rows:
  write new-generation chunks (invisible) → flip the main item (atomic
  commit point) → sweep stale generations. Reads fetch exactly the
  committed generation's deterministic keys. This replaced a
  delete-then-write order that could permanently corrupt a value on a
  mid-write crash (found in review — see PR #2598 comments). Chunk rows
  live in the same table with sort keys prefixed U+007F (forbidden in user
  keys); every read op filters them out.
- **Enum coercion:** `update_run_status`/`advance_latest`/`list_runs`
  validate status/job_type strings and raise `invalid` — a typo'd status
  silently persisted would make a run permanently unclaimable (found in
  review; both languages).
- **Errors** carry cross-language codes: `already_exists`, `not_found`,
  `invalid`. Case files assert them via op-level `expect_error` (NOT inside
  `expect` — `expect.error` is the manifest's error FIELD).

## 4. DDL decisions (P4)

- `create_dynamodb_tables.py` runs STANDALONE in the `dynamodb-init`
  container (bare python + boto3) — it cannot import `delphi_storage`, so
  `DELPHI2_TABLE_SCHEMAS` is an **inlined copy**, drift-tested against
  `delphi_storage.backends.dynamodb.table_schemas("Delphi2_")` by
  `tests/test_delphi_storage_ddl.py`. Edit the backend first; the test tells
  you to update the copy.
- `create_delphi2_tables()` honors `DELPHI_STORAGE_TABLE_PREFIX` (as the
  runtime store does) — provisioning and the app must never diverge on
  table names.
- Migration `000019` mirrors `schema_ddl("delphi")` statement for statement
  (same drift test), and the DDL tests prove the DEPLOYED artifacts pass the
  full conformance suite *without* the `ensure_*` helpers.
- **CI trap fixed in P4:** the delphi test container never received
  `DATABASE_URL`, and `docker compose exec` does not forward
  `GITHUB_ACTIONS` — so all PG-gated tests silently SKIPPED in CI. Both are
  wired now (`docker-compose.test.yml` delphi env + `-e GITHUB_ACTIONS=true`
  in `python-ci.yml`). The convention everywhere: service-gated tests
  **skip locally when unreachable, `pytest.fail` when
  `GITHUB_ACTIONS=true`** — if you add service-gated tests, follow it, and
  make sure CI actually delivers the env.

## 5. job_id threading decisions (P5)

- Resolution precedence (`delphi_storage/job_id.py::resolve_job_id`):
  explicit CLI > `DELPHI_JOB_ID` env (TRANSITION fallback — scheduled for
  removal once all callers pass the flag; grep before removing) > auto
  `local-<uuid4>`.
- `run_delphi.py` resolves ONCE, exports `DELPHI_JOB_ID` (so any un-migrated
  env reader sees the SAME id as the command lines), and appends
  `--job-id=<id>` to all six stage subprocesses.
- The poller's command construction lives in the module-level
  `build_job_command()` (extracted for testability). FULL_PIPELINE and
  CREATE_NARRATIVE_BATCH carry the queue `job_id`.
- **803's `--job-id` is a different concept** — it is the Anthropic
  batch-tracking id (`batch_job_id`), pre-existing. Do not unify it with the
  pipeline job id without renaming carefully.
- 801 gets `--job-id` but **no auto-generation** — narrative section keys
  embed the id; a missing one must keep failing loudly downstream.
- `reset_conversation.py`'s CLI moved to `cli()`; `main(zid, rid)` remains
  the worker function (existing tests call it directly). Known pre-existing
  bug (not fixed, out of scope): the `reset-conversation` console-script
  entry in `pyproject.toml` points at `main`, which needs args.

## 6. Snapshot decisions (P6a)

- Six kinds under `run_inputs` (pk=job_id, sk=kind): `votes`, `comments`,
  `participants`, `conversation_meta`, `report_comment_selections`,
  `clojure_math_main`. Payload shape: `{"columns": [...], "rows": [[...]]}`
  in codec envelopes; votes always `json+zstd`.
- **Votes = the raw stream stage 1 consumes**: `ORDER BY created`, raw
  signs, superseded votes included, order preserved. The SQL is shared *by
  import*: `run_math_pipeline.py` imports `VOTES_COUNT_SQL`/`VOTES_BATCH_SQL`
  from `delphi_storage.inputs` — capture and stage 1 physically cannot
  drift. (Direction of dependency: polismath → delphi_storage. Never import
  polismath from delphi_storage.)
- **Comments/participants captured in FULL** (moderated-out rows, banned
  participants included). Filtering is pipeline behavior, not snapshot
  behavior — a replay must be able to reproduce whatever filtering the
  code-at-replay-time does.
- **`clojure_math_main` captured for ALL `math_env` rows** because consumers
  disagree: 501/group_data reads the env-less latest; 801 filters by
  `MATH_ENV` with default `'prod'`; `polismath/database/postgres.py`
  defaults `'dev'`. Snapshotting every env keeps all replayable.
- **`derive_votes_latest_unique` tie caveat** (documented in its docstring,
  pinned by a test): PG's `votes_latest_unique` is maintained by an
  INSERT-order RULE, our stream is created-order with no tiebreaker; for
  same-millisecond re-votes on one (pid, tid) the winners can differ. The
  derivation is deterministic w.r.t. the snapshot — which is what replay
  requires.
- Every snapshot item's attributes carry `zid`/`rid` (provenance) plus the
  fingerprint (`sha256` of the canonical uncompressed payload, `row_count`,
  `max_created` for votes) — exactly what P7's manifest records.
- `--snapshot-inputs` (or `DELPHI_SNAPSHOT_INPUTS=1`) on `run_delphi.py`
  captures BEFORE any stage and **aborts the run on capture failure**.
  Off by default; P7's `DELPHI_WRITE_MODE` is expected to subsume it
  (capture-on = M1 dual-write behavior).
- `purge_job()` (`delphi_storage/purge.py`) is per-JOB only. The per-zid
  GDPR tool needs run manifests → follows in P7 via `list_runs(zid=…)`.

## 7. Read-seam decisions (P6b)

- `--input-source=store://<job_id>` on: `run_math_pipeline.py`,
  `run_pipeline.py`, `501`, `801`; `run_delphi.py` forwards it to the three
  PG-reading stages it spawns (502/700 read DynamoDB, reset has no inputs).
  `--snapshot-inputs` and `--input-source` are mutually exclusive (exit 2).
- **The seam substitutes data sources, never transformations.** Three
  mechanisms, in order of preference — use the same ones if you extend the
  seam:
  1. *Shared transformation functions* (stage 1): the SQL fetch and the
     row→dict transformation were split; the snapshot path feeds
     stage-shaped rows (`SnapshotReader.stage1_comment_rows()` etc.) through
     the SAME transformation. Quirks reproduce by construction.
  2. *Duck-typed client* (`SnapshotPostgresClient` in
     `delphi_storage/inputs.py`): drop-in for the umap `PostgresClient`
     READ methods (`get_conversation_by_id`, `get_comments_by_conversation`,
     `get_report_comment_selections`, `get_votes_by_conversation` — the
     latter derives votes_latest_unique from the stream and applies the
     PG-boundary sign flip). run_pipeline/501/801 run UNCHANGED against it.
     It validates the requested zid against the snapshot's stamped zid.
  3. *Method-level override* where a class uses raw `.query()` SQL:
     `GroupDataProcessor(math_main_override=..., using_snapshot=True)` and
     801's `_get_math_main_data` branch. Both preserve the exact env
     semantics of the SQL they replace.
- **Guard on MODE, not data presence** (found in review — see PR #2603
  comments): a snapshot can legitimately contain zero rows for a kind. If a
  seam branch checks "is the override data present" instead of "are we in
  snapshot mode", the no-data case falls through to live-only code (raw
  `.query()` the snapshot client doesn't implement) and a broad `except`
  can silently degrade the result. `GroupDataProcessor` shims the query
  RESULT (`[]` when the snapshot has no math_main), so the live no-data
  fallback (votes-based heuristic) runs identically in both modes. Apply
  the same pattern when extending the seam.
- **Proof style: feed equality, not output comparison.**
  `tests/test_input_source_seam.py` asserts live-vs-snapshot EXACT equality
  of every feed (comments dicts, moderation dict, each vote batch, stage-2
  client structures, math_main per env). Downstream code is untouched and
  seeded, so feed equality ⟹ output equality. (A full pipeline-run
  comparison would add DynamoDB/EVōC noise without adding proof.)
- Ordering normalization in the reader (deliberate, documented in
  `SnapshotReader`): stage-1 comments sorted by created (stable over the
  snapshot's tid order — matches live whenever created values are distinct;
  live tie order is arbitrary anyway); unordered live reads (moderation
  rows, votes_latest_unique) get deterministic tid/pid order — their
  consumers are order-insensitive.

## 8. Process / tooling traps (this workspace)

- **jj workspace, not colocated.** `/Users/julien/polis/github/polis-storage-v2`
  is a jj workspace on a chain off `edge`. There is NO `.git` there: use
  `jj --repository /Users/julien/polis/github/polis-storage-v2 …` and
  `gh -R compdemocracy/polis …` (plain `gh` fails). NEVER touch the parity
  `spr-stack` bookmark from this chain.
- **The working copy IS a commit.** Everything you edit lands in `@`
  immediately. When starting a new phase, `jj new` FIRST — twice this
  session, new-phase files silently accumulated in the previous phase's
  commit and had to be `jj split` out (filesets select what STAYS in the
  parent; the bookmark then sits on the child and must be reset with
  `jj bookmark set <name> -r <rev> --allow-backwards`).
- To amend an earlier PR in the stack: edit in the working copy, then
  `jj squash --into <change-id> -u 'root:"<path>"'` (descendants auto-rebase
  — safe in a single workspace), then push all moved bookmarks.
- **pmg-wrapped `uv` breaks network resolution** (stale index, "only
  anthropic<=0.115.0 is available"). Use `/opt/homebrew/bin/uv` directly for
  sync/add. `requirements.lock` feeds the Docker build — new runtime deps
  must be added there too (hand-add in pip-compile format; a full re-resolve
  churns every pin).
- **Local test services**: DynamoDB local on **8002** (8000 is taken by oMLX
  on this machine), dockerized PG 16 on **5433**:
  `docker run --rm -d --name delphi-test-dynamo -p 8002:8000 amazon/dynamodb-local`
  `docker run --rm -d --name delphi-test-pg -e POSTGRES_PASSWORD=confpass -e POSTGRES_DB=delphi_conf -p 5433:5432 postgres:16-alpine`
  Run tests with `DYNAMODB_ENDPOINT=http://localhost:8002
  DELPHI_STORAGE_PG_URL=postgresql://postgres:confpass@localhost:5433/delphi_conf`.
- **Known baseline noise** (do not chase): 5 delphi errors without DynamoDB
  (`test_batch_id.py` ×4, `test_math_pipeline_runs_e2e.py`); 12 server jest
  failures without local JWT keys. Both pre-date this work and reproduce on
  clean edge.
- DynamoDB expression names: `version`, `scope`, `seq` are RESERVED words —
  always alias (`#version`) in expressions.
- `run_delphi.py` writes `DELPHI_JOB_ID` to the real `os.environ` — tests
  that invoke its `main()` need the autouse restore fixture pattern
  (`test_job_id_threading.py::_isolate_delphi_job_id_env`); `monkeypatch`
  cannot undo out-of-band writes.

## 9. Continuation checklist (P7 and beyond)

Per design §7. In order:

- **P7 — manifests + dual-write** (per stage group: math; umap 500s;
  501/502+700s; 801/803):
  - introduce `DELPHI_WRITE_MODE=old|both|v2` (fail-loud if unset while old
    tables exist — design §4.3) and fold `DELPHI_SNAPSHOT_INPUTS` into it;
  - runs enqueued/claimed via the store's queue ops; stages
    `merge_run_fields` their fingerprints (capture already returns them) and
    `append_log`; `complete_run` flips `latest`;
  - `scripts/verify_dual_write.py` parity test per stage group (old-table
    rows vs v2 artifacts);
  - per-zid purge tool (`list_runs(zid=…)` + `purge_job`) — promised in
    P6a's PR comment;
  - artifact keys: use `keys.artifact_key(...)` with the design §4.2 naming
    (`math#pca`, `umap#assignments#<chunk>`, `priorities`, …).
- **P8 — LLM recorder + EVōC seeding + config_effective**: seeding EVōC
  changes UMAP-side outputs (documented in design §4.4) — math goldens
  unaffected, but announce it; record prompts+responses as `llm#<stage>#<seq>`
  artifacts.
- **Stacks 3–4** (P9-P14): backfill importer (use
  `advance_latest(only_if_absent_or_imported=True)`), server read paths
  behind `DELPHI_READ_V2`, bidirectional server writes, dual-queue poller,
  replay CLI (`--input-source` is its seam; extract
  `polismath/regression/comparer.py` tolerance core into
  `artifact_diff.py`), flip, contract.
- **Always**: TDD with a RED run first; full suite + goldens after; PR per
  phase stacked on the previous; launch a review subagent on every PR and
  fix its findings; record findings + fixes as a PR comment; update this
  file when a decision or trap is discovered.
