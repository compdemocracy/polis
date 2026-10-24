# Database migrations

Deploy the schema before replacing application services. Every deployment uses
`polis-migrate deploy`; the API refuses startup if a required file is pending,
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
2026-10-14; SHA-256 `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`). `POLIS_MIGRATE_CA_FILE` supplies a
private PEM CA bundle (mount it into the container). Standalone Node startup
uses `NODE_EXTRA_CA_CERTS` for a private/RDS CA; standalone Rust uses
`POLIS_MIGRATE_CA_FILE`. For a disposable local
network only, a URL with `sslmode=disable` plus
`POLIS_MIGRATE_ALLOW_PLAINTEXT=local` permits Docker service DNS; loopback and
local sockets can use `sslmode=disable` without that variable. Never use this
local setting for a remote production database.

New Docker volumes run the same binary from `server/Dockerfile-db`. Existing
volumes do not rerun initialization: invoke `apply` before starting the new app.
The CodeDeploy hook invokes `deploy` (catalog-checked first adoption, apply, check)
before replacing containers. See the mandatory two-release transition in
[the upgrade guide](upgrading.md). Direct `apply` still refuses unadopted databases.
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
`apply` then installs only 000019, 000023, 000024 and 000027. No vote data is inspected
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
committed history. Each ordinary file and its APPLIED row commit in one transaction.
Concurrent index files and the two
000022 index builds are the explicit autocommit exceptions described below.
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

### Concurrent index file header

New files containing only concurrent index builds opt out of the ordinary file
transaction with `-- polis-migrate: concurrent-indexes` in the leading line-comment
header. The runner accepts only `CREATE INDEX CONCURRENTLY IF NOT EXISTS name ON
[public.]table (column, ...)` statements: simple lowercase identifiers, ordinary
btree columns, no expressions, predicates, options, transaction control or other
SQL. Each build is a separate autocommit statement, on the same connection under
the migration advisory lock. The runner restores the session's 5 s lock wait and
5 min statement and transaction budgets before the file, even if a previous file
changed them. These apply to each build; there is no aggregate file timeout.

All named objects are checked before building any index. Exact valid definitions
are reused; a conflicting or invalid object refuses the file. As with 000022,
inspect a failed build, explicitly `DROP INDEX CONCURRENTLY public.<name>` only
if it is the expected interrupted index, and rerun. `IF NOT EXISTS` alone would
silently accept an invalid index and is not the validity check. The runner never
drops an index automatically. After all builds, catalog validity is checked again
in the transaction that records APPLIED. A failed history write leaves the valid
indexes for the next run. Ordinary files retain atomic SQL/history semantics.

Migration 000043 adds `votes(zid, created)`, `comments(zid, created)` and
`comments(zid, modified)` for derived activity reads. Existing `votes(zid, pid)`
already serves participant vote counts. The three builds take SHARE UPDATE
EXCLUSIVE on their tables, compatible with ordinary INSERT/UPDATE/DELETE and
SELECT; competing schema work and long snapshots can delay a build until its
budget fires. No stored value, function or application SQL changes. It applies
at the next deployment and is additive beside the previous application.
Reversal, if required, is an explicit concurrent drop of those three indexes;
it removes only the read acceleration and never restores or changes data.

## Release contents and new migrations

`server/postgres/migrations/release.txt` explicitly selects every required file.
The Rust runner and Node startup gate use the same manifest; Docker initialization
uses that runner. A new top-level numbered SQL file must be selected or held,
otherwise startup/apply refuses it. Missing files, duplicate numbers or entries,
symlinks, and release/hold overlap refuse. Adding a file cannot silently extend
the release. Numbered source checksums remain unchanged.

This release contains M0–M19 plus M22/M23/M24/M27. M4/M5/M7 are deprecated
observation-only entries. They never execute through `apply`: their named
removed objects must already be absent, then an ADOPTED receipt is recorded.
Any retained target stops before apply mutates schema/history; arrange a separate
reviewed upgrade for that deployment. Existing valid APPLIED receipts are kept.
Fresh bootstrap already omits their targets and gets three ADOPTED receipts;
it executes 21 files. No historical execution date is invented.

M20 (draft journal), M21 (held coordinator), M25 (vote convention) and M26
(retention) are excluded from the forward path. M21 stays in `held.txt`; the
other files are not shipped by this branch. An added unclassified copy refuses.
The selected legacy upgrade adopts M0–M18/M22 and applies **M19 → M23 → M24 → M27**.
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

## Forward compatibility

A release may run beside migrations it does not list: after a rollback to an
earlier release, or on a box still on the previous release while a rolling
deployment of a migration release reaches the other boxes. Whether that is safe
is declared once, per migration, in `server/postgres/migrations/compat.txt`:

```text
<migration file> <additive|breaking>
```

One line per migration, one space, `#` comments, numbers in order. `additive`
means a release that does not list the migration still runs correctly once it
is applied; `breaking` means it does not. Every name must be in `release.txt`
or `held.txt`. A new migration adds its own line beside its `release.txt` line,
with its evidence in the pull request; every later release keeps every line.

An earlier release cannot read a later release's files, so the declaration
travels in the database. `polis-migrate apply`/`deploy` records it in the
nullable `compat` column of `public.migrations` when it applies a migration,
and fills it for already-applied migrations of its own release on every deploy.
A history table made by an earlier runner gains the column on the first deploy
of a release with this rule (one `ALTER TABLE`, under the migration lock, only
when the column is missing). Recorded declarations only tighten: `additive` can
become `breaking`, never the reverse; a release that says `additive` for a row
recorded `breaking` logs `declaration kept`.

Both the runner (`check`, `apply`, `deploy`) and the API startup gate apply one
rule to a history row the release does not select:

- same file as a held migration: the checksum must still match;
- same number as one of this release's migrations under another name: refuse;
- recorded `additive`: tolerated and logged
  (`tolerating <name>: applied by a release that declared it additive`);
- recorded `breaking`, or no declaration (an earlier runner, or a line missing
  from `compat.txt`): refuse (`history names migration absent from this release`).

This release's own migrations are still required, and checksum-verified, as
before. `apply` never runs this release's pending SQL after a tolerated newer
migration; that order is refused before any change. The rule only helps
releases that contain it: a release built before it refuses every newer row.

Declarations for 000019–000044 (the older code is the release just before each
migration, as recorded in `release.txt` history):

| Migration | Declared | Evidence |
|---|---|---|
| 000000–000018 | breaking | Predate the runner; no release without them is deployed. Not evaluated, so fail closed. |
| 000019 queue | additive | Only new queue tables, roles, functions and grants; the code before it has no queue. |
| 000021 coordinator (held) | additive | Only new `polis_coordinator_*` objects with policies on its own tables; never applied by this release. |
| 000022 poll indexes | additive | Two btree indexes. |
| 000023 Delphi foundation | additive | Replaced queue functions and CHECKs only widen; the noop `/1` path and existing grants are unchanged; new columns are nullable or defaulted. |
| 000024 large class | breaking | Rewrites `polis_queue_install.contract_version` to `polis-queue/3` and narrows its CHECK; the earlier `polis-jobs` daemon starts only on `polis-queue/2` and exits. |
| 000027 job graphs | breaking | Rewrites the installed contract to `polis-queue/5`; the earlier daemon admits only `/2` and `/3` and exits. |
| 000028 Delphi results | additive | New result tables and functions; its trigger on `delphi_artifacts` acts only on payload keys the earlier release never writes. |
| 000029 graph stages | additive | Stage and kind CHECKs are strict supersets of 000027's; `pd_graph_admit` keeps its signature and only accepts more. |
| 000030 Delphi writers | additive | New writer tables and functions; `pd_finalize` keeps its signature and its earlier path unless a writer run exists, which only the new admission creates. |
| 000031 scoped result reads | additive | `delphi_result_current_rows` is redefined with the same columns, types, owner, options, grants and rows (compared row for row at 1.6 million rows and on adversarial bundle shapes); the new page functions and indexes are unused by the earlier release. The runner's `forward.py` tolerates it as additive. |
| 000038 comment embeddings | additive | New tables (`delphi_embedding_models`, `delphi_comment_embeddings`, `delphi_embedding_sets`) and `pd_embedding_*` functions only (rows and sets are deleted only through the owner-only `pd_embedding_prune`); no existing object is redefined and no current reader or writer calls them. Numbers 000032–000037 are reserved for other drafts, so 000038 depends on none of them and may apply before them. Reversal (only while no embedding is stored): `down/000038_drop_delphi_comment_embeddings.sql`. The runner's `forward.py` tolerates it as additive. |
| 000039 clear conversation download keys | additive | Data-only: `UPDATE public.zinvites SET uuid = NULL WHERE uuid IS NOT NULL`. No object is redefined; the `uuid` column stays nullable (000009). Every reader tolerates NULL — `conversationUuid` mints on demand, `getZidForUuid` returns not-found for a cleared key, and new conversations still receive a fresh uuid at creation — and no reader in server, queue-rs, delphi or math expects a non-NULL uuid, so an earlier release runs correctly beside it. The UPDATE takes ROW EXCLUSIVE and per-row locks only, which do not block the participant path's `SELECT`s on `zinvites` (resolved by zinvite code, never uuid). Reversal is impossible: the keys are not stored; `down/000039_restore_zinvites_uuid.sql` is a documented no-op and owners re-mint through the owner-gated route. |
| 000041 Delphi run record | additive | One new read function, `pd_run_record(env, job)`: STABLE, SECURITY DEFINER with a pinned `search_path`, owned by `polis_queue_owner`, EXECUTE granted to `polis_queue_executor` only. No table, row, column or existing function changes and no table grant; nothing in the earlier release calls it, and its one reader (the polis-api run-record route) is off by default and hands back to Node when the function is missing. It takes no table lock. Number 000040 is reserved for another draft. Reversal: `down/000041_drop_delphi_run_record.sql` drops the function (it stores nothing). The runner's `forward.py` tolerates it as additive. |
| 000042 statement-number lock to commit | additive | `tid_auto` (BEFORE INSERT on `comments`) takes `pg_advisory_xact_lock` instead of the session lock `pg_advisory_lock`, on the same key, so a conversation's statement-number lock is held until the inserting transaction ends rather than released before it commits; `tid_auto_unlock` and its AFTER INSERT trigger are dropped. Numbering is unchanged (MAX(tid) + 1 per conversation, from 0, no gaps); no table, column, index, constraint or row changes. No code in the earlier release calls `tid_auto_unlock` or takes the lock; every writer lets the trigger assign `tid` and reads it back, so an earlier release inserts and numbers statements as before. Locks: `DROP TRIGGER` takes ACCESS EXCLUSIVE on `comments` until the file commits, waiting at most the 5 s `lock_timeout` for transactions already using `comments`; comment reads and writes queue behind it for that wait, once; on timeout nothing changes and the deploy can be retried. Reversal: `down/000042_restore_tid_auto_session_lock.sql` restores both functions and the trigger exactly as `000000_initial.sql` defines them (SHARE ROW EXCLUSIVE on `comments`, bounded at 5 s), and brings back the race this migration removes. The runner's `forward.py` tolerates it as additive. |
| 000043 activity indexes | additive | Three ordinary btree indexes only; no table, function, row or application SQL changes. Concurrent builds preserve ordinary participation writes. |
| 000044 participant-number lock to commit | additive | `pid_auto` (BEFORE INSERT on `participants`) takes `pg_advisory_xact_lock` instead of the session lock `pg_advisory_lock`, on the same key, so a conversation's participant-number lock is held until the inserting transaction ends rather than released before it commits; `pid_auto_unlock` and its AFTER INSERT trigger are dropped. Numbering is unchanged (MAX(pid) + 1 per conversation, from 0, no gaps), as is the `conversations.participant_count` update, whose row lock was already held to commit, so no join waits longer; no table, column, index, constraint or row changes. No code in the earlier release calls `pid_auto_unlock` or takes the lock; every writer lets the trigger assign `pid` and reads it back, so an earlier release joins and numbers participants as before. Locks: `DROP TRIGGER` takes ACCESS EXCLUSIVE on `participants` until the file commits, waiting at most the 5 s `lock_timeout` for transactions already using `participants`; participant reads and writes (votes, comments, nextComment, participationInit) queue behind it for that wait, once; on timeout nothing changes and the deploy can be retried. Reversal: `down/000044_restore_pid_auto_session_lock.sql` restores both functions and the trigger exactly as `000000_initial.sql` defines them (SHARE ROW EXCLUSIVE on `participants`, bounded at 5 s), and brings back the race and the held lock this migration removes. The runner's `forward.py` tolerates it as additive. |

So a rollback to a release with this rule that lists 000027 starts beside
000028–000031, 000038, 000039, 000041–000044; a rollback past 000027 (or 000024) refuses, as it must: the
earlier queue daemon would exit on the newer contract.

## CI and local test stacks

The migration-runner CI fresh-image step and the mm2/mm5 proof use exactly:

```sh
COMPOSE_PROJECT_NAME=polis-migrate-test-my-owned-run \
POLIS_RECOVERY_PG_PORT=55851 \
bash queue-rs/polis-migrate/tests/fresh-image.sh
```

Choose a unique project and unused port on each shared machine. This entrypoint
builds `server/Dockerfile-db`, initializes a fresh database, checks exact receipt
names/checksums/statuses against `release.txt` and the M4/M5/M7 retirement policy,
then restarts and checks that the complete history is unchanged. Both the ready
count and expected receipt set derive from the selection. It removes only its
project volumes/containers and project-specific image tag, including on failure.
It does not replay production rows or prove a production deployment.

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

Historical schema tests that intentionally replay an older inventory use
`polis-migrate prepare-indexes --file PATH` only for header-marked index files.
It shares the deployment parser, advisory lock, budgets, preflight and final
validity checks, but does not write migration history. The harness must commit
earlier DDL and release its transaction before invoking it. The Python helper
`server/bin/apply-test-migration.py` and Node helper
`server/characterization/migrations.cjs` enforce this boundary; both accept
`POLIS_MIGRATE_BIN` or build the locked runner with Cargo. Normal installations,
including database resets, continue to use `apply`/`deploy`.
