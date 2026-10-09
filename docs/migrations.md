# Database migrations

Deploy the schema before replacing application services. Every deployment uses
`polis-migrate apply`; the API refuses startup if a required file is pending,
history is missing, or a recorded checksum disagrees with the release.
PostgreSQL 17 or newer is required. Keep a tested backup/restore procedure.

Build once from the repository root (or use the release's migration image):

```sh
cargo build --locked --release --manifest-path queue-rs/Cargo.toml -p polis-migrate
export PATH="$PWD/queue-rs/target/release:$PATH"
# Set DATABASE_URL through your usual secret environment; never put it in argv.
polis-migrate apply
polis-migrate check
```

The image requires no local Rust installation:

```sh
docker build -t polis-migrate:local -f queue-rs/polis-migrate/Dockerfile .
docker run --rm --network host --env-file .env polis-migrate:local apply
```

Use the database's actual network when it is inside Compose instead of the host
network. `POLIS_MIGRATIONS_DIR` or `--dir` selects the release's SQL directory.
TLS validates the certificate and hostname. The runner and API images include
a checksum-pinned public RDS CA bundle (official global truststore, retrieved
2026-10-09; SHA-256 `fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c`). `POLIS_MIGRATE_CA_FILE` supplies a
private PEM CA bundle (mount it into the container). Standalone Node startup
uses `NODE_EXTRA_CA_CERTS` for a private/RDS CA; standalone Rust uses
`POLIS_MIGRATE_CA_FILE`. For a disposable local
network only, a URL with `sslmode=disable` plus
`POLIS_MIGRATE_ALLOW_PLAINTEXT=local` permits Docker service DNS; loopback and
local sockets can use `sslmode=disable` without that variable. Never use this
local setting for a remote production database.

New Docker volumes run the same binary from `server/Dockerfile-db`. Existing
volumes do not rerun initialization: invoke `apply` before starting the new app.
The CodeDeploy hook invokes it before its container cleanup/start operations.
`server/bin/run-migrations.sh` delegates to the binary; the old Clojure entry
point delegates to that shell command. Neither replays every file anymore.

## One-time adoption of an existing database

An existing database without history is deliberately refused by `apply`.
Never replay `000000_initial.sql` on it. Use the known migration records and
inspect its schema to choose an explicit upper bound, then reconcile:

```sh
# Example: the legacy schema through 000022, without the dormant queue.
polis-migrate reconcile --through 000022
polis-migrate apply
polis-migrate check
```

The bound is not evidence of application. Every selected file must pass its
catalog postconditions in `server/postgres/migrations/adoption/`: enduring
initial tables/columns, renamed columns, unique and foreign-key constraints,
new columns/types/defaults, removed objects, the vote-update rule, and valid
index definitions. The exact [legacy variants](migration-legacy-contract.md) include six named
math `json` payloads and bounded type/column alternatives; unrelated types are refused. The missing queue migration 000019 is a recognized
hole **only when no queue/foundation tables or functions exist and no old
history row claims it**. The example adopts 000000–000018 and 000022 as ADOPTED;
`apply` then installs only 000019, 000023 and 000024. No vote data is inspected
or changed by reconciliation.

Adoption is atomic: any failed postcondition leaves the old history untouched.
It records observation time and the checksum of the source being reconciled,
not a fictional historical execution date. If the 2021 `migrations(name,
completed_at)` table exists, its timestamps (including duplicates) are retained
in each row's `legacy_completed_at` array after all catalog checks pass. Unknown
or renamed legacy filenames stop for review; they are never silently replayed.
Already installed queues use their existing /1, /2 or /3 catalog verifiers,
including definitions/privileges and recorded installed catalogs. A matching
install row alone is insufficient. Select the actual upper version (for example
`--through 000024` for a previously initialized /3 Docker database). A partial
queue, later bound without a contract, unknown historical filename, or the
unreleased `schema_migrations` ledger stops for review. Never mark those by hand.

## History and failure behavior

`public.migrations` is the sole applied-history table. It records filename,
SHA-256 of the unmodified SQL source, APPLIED or ADOPTED, observation time/actor,
and any preserved legacy timestamps. Runtime roles need SELECT only, granted
on this metadata table; the deployment role needs the privileges required by
the actual migrations (including role administration for the queue).

A database advisory lock serializes runners on the same connection across
per-file commits. A second runner waits up to five minutes, then reads the
committed history. Each ordinary file and its APPLIED row commit in one transaction. The two
000022 index builds are the explicit autocommit exception described below.
An optional historical outer BEGIN/COMMIT pair is removed; any other top-level
transaction control is rejected. Dollar-quoted function bodies stay intact.
SQL errors abort the file. Earlier successfully committed files stay applied.
Lock waits are bounded (five seconds for DDL), with five-minute statement and
transaction ceilings and a thirty-second idle-transaction limit. Existing SQL
may set tighter timeouts. No automatic destructive down migration runs.

If the connection is lost at commit, the result can be unknown. Reconnect and
run `check`/`apply`: committed history is authoritative. Do not infer rollback
from a transport error. Restore changed historical files instead of editing
history to bypass checksum failures.

For the exact released 000022 source, `apply` preflights both index identities,
then builds each missing watermark index with `CREATE INDEX CONCURRENTLY` in
autocommit, while retaining the same migration advisory lock. This is the normal
path on fresh and large populated databases. Valid existing indexes are checked
and preserved without rebuilding. The original SQL then rechecks both exact
index definitions in the transaction that records APPLIED. Its raw SQL checksum
is unchanged; changing that source requires review of this execution contract.

An interruption can leave a valid first index, or an invalid index from a failed
concurrent build, without a migration history row. Rerunning `apply` reuses valid
indexes and builds only missing ones. It refuses invalid or conflicting objects
before building either index. Inspect an invalid index first; if it is the exact
interrupted watermark index, explicitly drop that index with `DROP INDEX
CONCURRENTLY public.<the_named_index>` in autocommit, then rerun `apply`. The
runner never drops a preexisting index automatically. A differently defined
same-name object requires a reviewed resolution, not that drop instruction.
If history recording fails after both builds, both valid indexes remain; retry
records their checked state without rebuilding. Concurrent builds have the
same bounded statement/lock timeouts; a timeout is not a success receipt.

## Release contents and new migrations

`server/postgres/migrations/release.txt` explicitly selects every required file.
The Rust runner and Node startup gate use the same manifest; Docker initialization
uses that runner. A new top-level numbered SQL file must be selected or held,
otherwise startup/apply refuses it. Missing files, duplicate numbers or entries,
symlinks, and release/hold overlap refuse. Adding a file cannot silently extend
the release. Numbered source checksums remain unchanged.

This release contains M0–M19 plus M22/M23/M24. M4/M5/M7 are deprecated
observation-only entries. They never execute through `apply`: their named
removed objects must already be absent, then an ADOPTED receipt is recorded.
Any retained target stops before apply mutates schema/history; arrange a separate
reviewed upgrade for that deployment. Existing valid APPLIED receipts are kept.
Fresh bootstrap already omits their targets and gets three ADOPTED receipts;
it executes 20 files. No historical execution date is invented.

M20 (draft journal), M21 (held coordinator), M25 (vote convention) and M26
(retention) are excluded from the forward path. M21 stays in `held.txt`; the
other files are not shipped by this branch. An added unclassified copy refuses.
The selected legacy upgrade adopts M0–M18/M22 and applies **M19 → M23 → M24**.
A deployment missing M22 instead builds its indexes concurrently between M19
and M23. Archives, down scripts and unflip files never enter this manifest.

Read [the release map](migration-release-map.md) for historical source/release
provenance and [upgrade notes](migration-upgrade-notes.md) for each supported
deployment shape. Semantic versions that were never assigned remain explicitly
unassigned; source shipment does not establish database execution.

Merging a required migration means it runs at the next deployment. Review its
compatibility with the still-running previous application, locking, privileges,
data effects and reversal/restore plan at merge time. Update these public
upgrade records in that change. The manual sitting and client stage/unstage
steps are retired; no separate staging ceremony is required.

## CI and local test stacks

After building `docker-compose.test.yml`, run `bash ci/test-migrations.sh`
before starting application services. It waits for Postgres initialization,
then runs `apply` and `check` using the binary and SQL packaged in that image.
It works on fresh and existing test volumes; it never creates history by hand
or bypasses the API startup check. Cypress, server integration and Delphi CI
all use this entrypoint. Server integration also runs the Node startup check
before loading its in-process test app.

Set a unique `COMPOSE_PROJECT_NAME` and `POLIS_RECOVERY_PG_PORT` for a shared
local machine. `POLIS_TEST_ENV_FILE` chooses a test env file (default `test.env`);
optional Compose arguments such as `-f local-ports.yml` support isolated test
stacks. Use the same options when starting and removing your stack.


## Deployment reconciliation records

Use [the reconciliation record](migration-reconciliation.md) for each deployment.
A catalog match is an observation, not proof that a historical file ran. A failed
predicate must lead to a reviewed forward repair or a documented compatible
variant, never to manually inserting a migration row. Unknown historical variants remain review cases; this document does not authorize
a deployment that fails reconciliation. Run the [read-only first-deploy report](migration-upgrade-notes.md)
before the first transition; it does not replace application-health verification.
