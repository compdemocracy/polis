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
index definitions. Known legacy `json` columns are accepted where the fresh
initial schema uses `jsonb`. The missing queue migration 000019 is a recognized
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
committed history. Each file and its APPLIED row commit in one transaction.
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

000022 retains its special populated-table behavior: when an index is missing
on a large table, application stops with its SQL error. Build the two documented
indexes using `CREATE INDEX CONCURRENTLY` in autocommit, then rerun `apply`;
its exact validity/definition checks run before the history row commits.
Concurrent index operations cannot run inside a migration transaction.

## Release contents and new migrations

Top-level `NNNNNN_name.sql` files are discovered in numeric filename order;
archives, adoption checks and down scripts are not applied. Numbers must be
unique, but a reserved gap such as 000020 is valid. New files should contain
ordinary transactional SQL without their own transaction control.

`held.txt` is a **release-wide** disposition of the dormant 000021 coordinator,
not a per-installation skip list. It is not required by this API release, runs
nowhere through this runner and receives no fake history row. Releasing it
requires removing the hold in a reviewed schema change. Pending vote-convention
work must use this history table and keep explicit convention declaration;
merging a migration never authorizes guessing or flipping stored vote signs.

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
