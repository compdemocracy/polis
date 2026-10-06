# Local Rust queue adapter, shared acceptance cases, and the `polis-jobs` daemon

This crate holds two binaries. `polis-queue-adapter` (below, "Local Rust queue
adapter") is the one-shot `polis-queue/1` transport. `polis-jobs` (the last
section) is a daemon that runs Delphi jobs on the `polis-queue/2` contract. It
is off by default and nothing in compose, the deploy hooks or CI starts it.

This independent crate exercises `polis-queue/1` without changing the coordinator
or Python science package. It is a local, opt-in transport for the twelve public
queue RPCs on migration 000019. It runs no daemon, follows no artifact URI and
executes no science or provider request. The actual math bridge still polls
outside the queue. No stage, descriptor policy, schema, grant or deployment is
changed by this crate.

Every call validates its name, argument count and types before connecting, then
uses a fresh READ COMMITTED transaction under the restricted queue executor
login. UUIDs bind as UUIDs, priority as i16, counts as i32 and epochs as i64.
Replies retain decimal-string counters and the closed wire field sets. Direct
table/column grants or membership permitting entry to the owner role refuse the
connection. `NoTls` is restricted to literal loopback IPs. The same dev/test
namespace rule as the Python executor and an explicit flag exclude production.
The SQL hash is a repository compatibility pin, not live-catalog attestation.

`Completion::Unknown` carries a provisional reply when COMMIT does not report
success. There is no automatic retry, including no reissue of an uncertain claim.
Renew the exact claim token on a fresh connection, or retain it as unresolved.
An exact finalize token/digest can reconcile to `already_succeeded`. Another
attempt's success is not borrowed. The JSONL executable returns either `reply`,
`uncertain`, or a fixed `error` with optional SQLSTATE; it suppresses database
diagnostics and connection strings. Input lines are limited to 64 KiB. The DSN
and queue environment come from `QUEUE_DATABASE_URL` and `QUEUE_ENV`.

## Local campaign

Use a dedicated project and unused local port, and a Python environment with the
Delphi test dependencies. Keep the evidence directory fresh and outside the repo:

```sh
COMPOSE_PROJECT_NAME=p027-queue-example \
POLIS_RECOVERY_PG_PORT=56160 RECOVERY_PG_PORT=56160 \
QUEUE_PYTHON=/path/to/venv/bin/python \
QUEUE_EVIDENCE_DIR=/private/tmp/queue-example \
bash queue-rs/run-acceptance.sh
```

The script builds/tests/lints Rust, starts the isolated PostgreSQL 17 fixture,
runs the exact case inventory, rejects failures/errors/skips/omissions/duplicates,
and removes only its own Compose project, including volumes. Normal Delphi CI
does not collect this directory without `QUEUE_ACCEPTANCE_URL`; an explicit
campaign with missing prerequisites fails. The runner does not mutate the existing
coordinator CI's historical inventory or evidence. It is not wired to hosted CI.

The shared Python tests drive the unchanged psycopg consumer and this Rust
transport against the same installed SQL and fixture recipe. Python enqueue is
a test-only producer calling the same fixed SQL and grant boundary; enqueue is
not added to the Python consumer. Both adapters use real PostgreSQL transactions.

| Contract seam | Local witnesses and negative controls |
|---|---|
| A1 | Four claimers, three lanes, 24 distinct live tokens; progress past a locked first row. Removing SKIP LOCKED blocks; barrier-controlled read/unconditional-update returns duplicate ownership. The weighted caller schedule is explicit in the test. |
| A2 | Actual nested PL/pgSQL claim plan via auto_explain, 10,000 terminal + 10,000 ready rows across lanes, no forced planner settings. Empty-lane equality-prefix probe; removing priority causes 10,000 unrelated rows to be examined. |
| A3 | Actual DB-time lease expiry, reap/reclaim, every stale heartbeat/release/fail/park/finalize seam, new owner succeeds. Removing ownership checks permits stale renewal. |
| A4 | Wire-level disconnect before and after actual claim/finalize COMMIT; independent durable-state observation; exact-token reconciliation. Real SIGKILL after finalize COMMIT and restart, wrong identity/digest denied. Reclaiming with a fresh attempt strands ownership; unconditional fencing loses exact-success recovery. |
| A5 | Enqueue COMMIT disconnects leave four complete records or none; key replay/conflict. A shared deliberately split producer algorithm leaves a durable partial run. |
| A6 | Older completion after newer, desired-run failure, exact repeat; prior pointer retained. Removing desired-generation policy incorrectly publishes a suppressed run. |
| A7 | Each language/profile performs 10,000 real heartbeat RPC transactions. Local profile: PG17, fillfactor80, one owner, autovacuum disabled, HOT ratio >=0.90 and <=100 dead tuples after observed explicit vacuum. Adding an expiry index produces zero HOT updates. These are local profile bounds, not production admission. |
| A8 | Exhausted budgets, 105-row parked cursor pass with a busy low ID and held heads, separate committed reaps, FK lookup plans over 10,000 retained runs/heads and referenced/unreferenced DELETE checks. Budget/index/reaper/per-job-commit controls expose their respective broken invariants. |

Faults alter only individual disposable databases. They never alter a migration
file or its recorded fingerprint. Bulk history fixture rows are generated locally;
they are not conversation data. The original descriptors are imported from the
existing frozen Python contract, including its compatibility spellings.

These transport/SQL cases do not certify an operational Rust scheduler, daemon
restart journal, measured production capacity or full A1–A8 admission. Native
weighted scheduling/reaper lifecycle remains a caller obligation; the existing
Python executor is unchanged. The D04 durable pending-operation catalog,
count/byte admission, protected-reference retention/cleanup and eventual real
math-stage admission require their separately reviewed schema/authority work.
No queue finalize occurs in the math bridge, so a restart between math COMMIT
and queue finalize cannot yet be a live queue integration witness.

## `polis-jobs`: the Delphi job daemon (off by default)

What it does, in plain terms: it takes one Delphi job at a time from the
Postgres queue, holds a lease on it (120 s, renewed every 30 s), runs the
unchanged Delphi script as a child process in its own process group, copies
the child's output lines into `polis_queue_logs`, and records how the attempt
ended. A job succeeds only when the child exits 0 *and* writes a valid output
manifest; the manifest's exact bytes are stored as the attempt's `manifest` log
row and its sha256 is what the queue records. If the job is cancelled, or the
lease is lost, the daemon kills the child's whole process group, waits until
the group is empty, and only then tells the database the process has exited.
The database never treats an expired lease as proof that a process stopped: a
job whose worker vanished stays parked until its exit is confirmed, either by
the daemon's restart journal or by an operator (who reads the identity from
`pd_job_view.last_attempt`).

What it needs to run: a database with migration 000019 and the `polis-queue/2`
migration 000023 applied (`polis_queue_install.contract_version` reads
`polis-queue/2`; otherwise the daemon exits 3), and a login that is a plain
member of `polis_queue_executor`. Neither is applied to any shared database by
this crate. 000023 is `server/postgres/migrations/000023_create_delphi_foundation.sql`,
sealed with its down script in `server/postgres/migrations/down/000023-files.sha256`;
`tests/foundation_migration.rs` checks the seal and the stage list without a
database, and a fresh container applies it at initdb like every migration.
Applying it to an existing database, production included, is the operator's
explicit step through `server/postgres/bin/apply-migration.sh`
(`docs/queue-substrate.md`): 000019 and then 000023, each in its own idle or
controlled writer window, because each creates foreign keys to
`conversations` and so holds `ShareRowExclusiveLock` on that table until it
commits, blocking every insert, update and delete of a conversation meanwhile.
The wrapper refuses unless the file matches its seal, the server is
PostgreSQL 17, the login has the rights, the queue tables are empty, no other
transaction is older than 30 s and the operator-measured free disk is above
5 GiB; it then sends `lock_timeout` 5 s, `statement_timeout` 60 s,
`transaction_timeout` 120 s and `idle_in_transaction_session_timeout` 30 s.

Two things the schema does not do: the per-scope guard row in
`delphi_job_guards` is held until safe explicit release (`pd_release_scope`,
which refuses while any job in the root's tree is unfinished, lacks exit proof
or has an open provider request; no guard is released automatically); and the
attempt logs this daemon writes to `polis_queue_logs` are direct `INSERT`s
under the executor's table grant, limited by the database per row only (1 MiB
a line; the per-attempt cap, `POLIS_JOBS_LOG_MAX_LINES` / `_BYTES`, is this
daemon's own buffer, not a database rule), with no retention
yet: nothing deletes or sweeps them.

Configuration is by environment; `POLIS_JOBS_ENABLED` must be exactly `1` or
the daemon exits 0 at once. Transports: `tls` (default; CA file and exact host
allowlist required), `local` (Unix socket, must be chosen explicitly) and
`loopback` (literal 127.0.0.1/::1 only). `POLIS_JOBS_JOURNAL_DIR` must be a
writable directory that survives container re-creation (exit 2 otherwise).
Exit codes: 0 disabled or clean shutdown, 2 configuration refused, 3 contract
missing.

The child sees `DELPHI_JOB_ID`, `DELPHI_RUN_ID`, `DELPHI_ATTEMPT_ID`,
`DELPHI_LEASE_EPOCH`, `DELPHI_STAGE`, `DELPHI_PHASE`, `DELPHI_OUTPUT_MANIFEST`
and `DELPHI_FRAME`, never the queue DSN. Before a provider batch is submitted
the child writes `provider_intent.json`; the daemon records it with
`pd_provider_intent`, and only after that commits writes `provider_intent.ack`
(`{schema, request_id, intent_sha256}`). Schemas: `schemas/`.

Lines on stderr: one bare-JSON `polis_jobs.transition/1` per state change, and
every `POLIS_JOBS_READINESS_SECONDS` a readiness line
`polis_jobs readiness/1 role=worker progress=<idle|running|draining|degraded> {json}`
with claimed/finalized/failed/parked/fenced/poison/exit_unconfirmed totals.

Tests: `cargo test` runs the unit tests. The integration tests need a
throwaway PostgreSQL 17 on a loopback port and the feature flag:

```sh
COMPOSE_PROJECT_NAME=p077-jobs-example POLIS_RECOVERY_PG_PORT=56170 \
  docker compose -f queue-rs/compose.yml up -d --wait
POLIS_JOBS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:56170/queue_acceptance \
POLIS_JOBS_TEST_PYTHON=$(command -v python3) \
  cargo test --manifest-path queue-rs/Cargo.toml --features jobs-integration -- --test-threads 4
COMPOSE_PROJECT_NAME=p077-jobs-example POLIS_RECOVERY_PG_PORT=56170 \
  docker compose -f queue-rs/compose.yml down -v
```

They apply the repository's 000000–000022 chain to one template database
(`jobs_base`, the "contract missing" shape) and the repository's 000023 on top
of it to another (`jobs_v2`), then run real daemon processes against copies of
`jobs_v2` with a generated fixture child (`tests/fixtures/fake_delphi`) in
place of the Delphi scripts.
