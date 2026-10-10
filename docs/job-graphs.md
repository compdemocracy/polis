# Per-step jobs that keep completed work

Each computation has its own run, recorded inputs and immutable saved result.
Dependants wait for their producers. A failed step retries using the same saved
inputs; completed steps do not rerun. Readers keep seeing the last complete
bundle until a complete replacement is published atomically.

The reference example is embeddings → clusters → narrative. Its local adapters
use token counts, a small deterministic clustering fit and a cluster summary.
These exercise the real daemon and separate child processes. They are not the
production MiniLM, UMAP or provider pipeline; those adapters and report readers
are a separate integration.

## Stored contract

M27 extends M19/M23/M24 without changing those files. The queue contract is
`polis-queue/5`; `/4` remains reserved. Each step has one run and job; each retry
has a new attempt. Inputs record the data snapshot and digest, code digest,
model, runtime, seed, effective configuration and computation mode. This
adapter supports `full` only and refuses unsupported incremental requests.
Reusing embeddings while fully recomputing clusters is supported.

Admission seals the complete graph in one transaction. Edges name producers
before their results exist, then bind once to immutable artifacts. Claims
include exact serialized resolved inputs and their digest; both the Rust daemon
and Python child verify them. Postgres binds results to the job, run and exited
attempt. Finalization checks ownership, lease and process-exit proof and is
idempotent after a lost reply. Failed attempt files are never served results.

Publication uses a generation compare-and-swap to select a completed narrative
and its transitive artifacts. Old bundles are untouched by failures or worker
replacement. Completion of the embedding root alone does not release the graph
scope; durable reconciliation waits for all members and their exit proofs.
Class-depth demand excludes dependency-blocked work.

`delphi/scripts/job_graph_client.py` provides internal admission, status,
publication and result reading. Callers must authorize the namespace before
using it; this is not a public HTTP API. Configure graph workers explicitly with
`POLIS_JOBS_STAGES=graph_embed,graph_cluster,graph_narrative`. Legacy and graph
stages require separate workers. Defaults continue to select legacy stages.
Existing workers without `/5` support must be replaced before applying M27.

## Deliberately outside this core

Scoped durable breakers and half-open probes, provider reconciliation and its
evidence table, and explicit superseding dead-branch redrive are deferred.
The sixth admission argument is retained for wire compatibility but must be
NULL. Retry exhaustion leaves the job dead and its dependants visibly blocked;
it never wipes completed results. The existing queue retry/dead-letter logic
and fail-closed provider-uncertainty checks remain. No paid-provider activation,
spend controls, new placement/scaling system or retention deletion is added.

Limits are 32 nodes, four inputs per node, 100 texts, 1 MiB admission and
512 KiB per artifact. Each job has at most ten attempts. Memory declarations
are checked against class bounds (512 MiB Delphi, 2 GiB large); this is not OS
memory enforcement. Real adapters and larger result storage need their own
contracts. No artifact purge is enabled.

## Apply and verify

Release B restores the migration runner and selects M27 for fresh databases and
existing deployments. The deploy reconciles the supported legacy catalog before
applying pending files; the API checks their receipts before starting.
The earlier unreleased M27
had different bytes: never adopt its old installation under this new checksum.
Rebuild disposable draft databases; released histories require a forward
migration, never a rewritten receipt.

The empty down migration compares the restored catalog with its original `/3`
state. It refuses once graph data exists. A nonempty installation requires
compatible `/5` workers and readers; deleting results is not rollback.

Hosted CI and mm5 use exactly the same entry:

```sh
COMPOSE_PROJECT_NAME=polis-graph-test-local \
POLIS_RECOVERY_PG_PORT=55467 RECOVERY_PG_PORT=55467 \
bash delphi/tests/job_graph/run.sh
```

Run on a build box with Docker, the pinned Rust toolchain, Python 3 and Node 24;
first run `npm ci --no-audit --no-fund` in `server`. Choose an unused project and
port. The entry refuses existing project containers, starts only its own local
Postgres and removes its project on exit. It runs the graph scenarios, SQL
boundaries, empty down/reapply, Rust and existing Node/legacy queue tests.
Receipts go to `graph-proof/` or `GRAPH_PROOF_ROOT`. Fixtures contain generated
texts and zero vote rows. No provider calls are needed.

## Release B integration

The selected migration release now includes M27. After Release A has succeeded
on every host, the deploy hook runs `polis-migrate deploy`: reconcile a supported
pre-runner catalog through M22, then apply M19/M23/M24/M27 and check readiness,
before replacing services. A modern M24 history upgrades by applying M27 only;
existing receipt bytes are preserved. An unledgered or old-draft M27 catalog is
not silently adopted or re-sealed. The API refuses pending or changed receipts.
DynamoDB readers/importers and M28/M29 are outside this release.
