# Delphi writers on PostgreSQL

`DELPHI_RESULT_BACKEND=postgres` now selects PostgreSQL for job admission and
result writes as well as reads. The default remains `dynamodb`. This change does
not activate a deployment or remove a DynamoDB table.

Apply the release migration chain through the migration runner, including M30.
Set `DELPHI_RESULT_ENV`, `DELPHI_RESULT_SCOPE`, and `DELPHI_WRITER_CODE_SHA` on the
server. The code pin must identify the deployed writer release (40 or 64 lower
case hex characters). Both Delphi submission routes use the same atomic queue
admission function, retaining request binding and scope exclusion. Narrative
batch route IDs become queue UUIDs; the response supplies the authoritative ID.
The existing moderation pin remains true. A checker is a reclaimed attempt of
its original narrative job; submitting an unrelated `AWAITING_NARRATIVE_BATCH`
request is refused.

Workers use the existing `polis-jobs` daemon, a restricted `polis_queue_executor`
login, and the normal verified TLS configuration (`QUEUE_DATABASE_URL`,
`QUEUE_ENV`, `POLIS_JOBS_TRANSPORT=tls`, `POLIS_JOBS_CA_FILE`, and
`POLIS_JOBS_HOST_ALLOWLIST`). Mount the CA and persistent journal/work directories
according to the worker deployment contract. The Compose Delphi service forwards
the switch and queue settings and retains its journal/work directory in
`delphi-queue-state`. The Postgres image startup selects the daemon and skips the
legacy Dynamo bootstrap/poller. Standalone legacy writers without a bound queue
attempt refuse rather than writing to Dynamo or mutating a publication.

The daemon hydrates the immutable publication captured at admission. Pipeline
subprocesses share a private SQLite working copy in their attempt directory.
The reset clears computed families in that copy, preserving narrative history,
collective statements and agenda selections. It never deletes served artifacts.
The existing numerical and provider scripts still run; no local narrative model
or fixture is selected in production. The existing provider intent, ambiguous
submission and submit/recheck lifecycle remains the authority for paid work.

After the process group exits, the daemon imports canonical family files using
its fenced queue token. The v2 manifest binds the sealed batch. Finalization
stores the artifact, completes the job and advances the served generation in one
transaction. Lease loss, failed stages, unresolved provider work or a publication
conflict cannot expose the partial working copy. Limits remain 64 MiB per family
and 256 MiB per result batch; oversize fails without truncation.

HTTP statement/narrative puts and deletes create a durable producer job, attempt
and immutable artifact within one SQL transaction. Canonical keys bind each edit
to its conversation/report. Concurrent edits preserve unrelated keys. An active
pipeline retains its publication scope; synchronous edits report failure while
that scope is busy. The existing HTTP authorization remains in the routes.
Unknown families still return `ResourceNotFoundException`: the two never-built
topic moderation stores retain their existing unavailable behavior. Building
that separate feature is not part of migrating the live writers.

Changing the switch back to Dynamo after new Postgres writes is **not a lossless
rollback**. There is no dual write. Stop new admissions and drain/fence workers
before changing writer deployments; retain the Postgres artifacts and publication
pointers. Moving newly written results back to another backend needs an explicit
migration. M30 does not rewrite historical migrations or offer destructive down
migration over result history.

## Verification

Hosted CI and workboxes run `bash scripts/test-dynamo-writers.sh` with an isolated
Compose project and port. It runs the Rust library checks, server build/adapter
checks, Python writer/protocol checks, release migrations and real Postgres/daemon
scenarios with the owned DynamoDB container stopped. The process fixture produces
generated results and a fixed provider response: it proves storage and lifecycle,
not numerical equivalence, narrative quality or a live provider call. The real
pipeline orchestration also has a private-reset/manifest test with computation
subprocesses stubbed. Existing numerical suites remain separate.
