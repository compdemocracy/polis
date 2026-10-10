# Postgres queue substrate (P-024, contract `polis-queue/1`)

This is the first slice of a Postgres-native job queue. It is **noop only** and
**wired to nothing**: no HTTP route calls it, no poller reads it, and no real
Delphi or math work can be routed through it. Installing the migration and
leaving the flag off changes nothing about how the server behaves.

Read this before touching it. The design, its four review rounds and the open
acceptance gates live outside this repository, in the cost-reduction working
notes (`P-024-queue-substrate.md` revision 4 and its review rounds).

## What exists

| Piece | Where |
|---|---|
| The schema: 5 data tables + a `polis_queue_install` provenance table, 21 `pq_` functions, 2 NOLOGIN roles | `server/postgres/migrations/000019_create_polis_queue.sql` |
| The closed `polis-queue/1` wire boundary for Node | `server/src/queue/protocol.ts` |
| Dev/test-only noop enqueue | `server/src/queue/enqueue.ts` |
| `withTransaction` on the read-write pool | `server/src/db/pg-query.ts` |
| The flag | `server/src/config.ts`, `POLIS_QUEUE_SUBSTRATE_ENABLED` |
| 40 ported smoke checks plus 4 adapter checks | `server/__tests__/integration/queue-substrate.test.ts` |
| Transitional Python executor | `delphi/polismath/queue/executor.py` |
| Its Postgres test | `delphi/tests/test_queue_noop_executor.py` |

The protocol is **at-least-once work, fenced publication, idempotent effects**.
A successful function return is provisional until its transaction commits.

Twelve of the twenty-one functions are granted to `polis_queue_executor`:
`pq_enqueue`, `pq_claim`, `pq_heartbeat`, `pq_finalize`, `pq_fail`,
`pq_release`, `pq_park`, `pq_due`, `pq_reap_one`, `pq_cancel`, `pq_job_status`,
`pq_head_status`. The rest, including the page driver `pq_reap` and the
terminalization and policy helpers, are private to `polis_queue_owner`. The
executor role holds **no** direct read or write on any queue table.

## What is not wired

* `server/src/routes/delphi/jobs.ts` is untouched. It still resolves the zid in
  Postgres and writes DynamoDB.
* `delphi/scripts/job_poller.py` and `delphi/polismath/poller/*` are untouched
  and neither import nor are imported by the new executor. Rolling the executor
  back is stopping a process.
* Nothing calls `enqueueNoopJob` outside tests.
* No coordinator, no reaper daemon, no LISTEN loop, no Rust adapter.

## Applying the migration

Both fresh databases and upgrades use [`polis-migrate apply`](migrations.md).
Fresh Docker volumes run it during initialization; deployments run it before
service replacement. Existing pre-runner databases reconcile once first.
Successful files are recorded and skipped on later deploys. Queue activation
remains controlled by the existing flags; applying schema does not enable it.

### What the apply locks, and the window it needs

Both 000019 and 000023 create foreign keys to `public.conversations`
(`polis_queue_runs` and `polis_queue_heads` here; `delphi_jobs` and
`delphi_current` in 000023). Creating a foreign key takes
**`ShareRowExclusiveLock` on the parent table**, and each file holds it on
`conversations` from that statement until its `COMMIT`. While it is held,
every `INSERT`, `UPDATE` and `DELETE` on `conversations` waits (plain `SELECT`
continues), and the apply itself waits, up to its `lock_timeout`, behind any
open transaction that already wrote a `conversations` row; when the timeout
fires the transaction aborts and nothing is applied. The changed queue tables
and the new objects are `ACCESS EXCLUSIVE` for the same span. So "additive and
empty" is not "cannot block users": **apply in an idle or controlled writer
window** (producers paused, no open writer on `conversations`), and account for both
000019 and 000023 in the deployment window; the runner gives each its own transaction.

### The wrapper: preflight and budgets

The former `server/postgres/bin/apply-migration.sh` is retained for historical
rehearsal/reversal tests. It is **not** the deployment entry point and does not
update the migration history. Its former first-install checks are recorded below
for reference. The runner now owns transactional application, bounded waits,
checksums and history; use the [migration guide](migrations.md).

| check | what it requires |
|---|---|
| seal | the file's sha256 matches its recorded value (000019: `QUEUE_SQL_SHA256` in `server/src/queue/protocol.ts`; 000023: `down/000023-files.sha256`) |
| server | PostgreSQL 17 (the catalog fingerprints and `transaction_timeout` need it) |
| rights | the login can do what the file needs (000019: superuser, or `CREATEROLE` while a queue role is absent / SET membership in `polis_queue_owner`, plus the `public` and `conversations` privileges with grant option listed below; 000023: superuser or SET membership in `polis_queue_owner`) |
| chain | 000023 only: 000019 is installed |
| rows | every `polis_queue_*` and `delphi_*` data table that exists is empty; the wrapper is for a first install (the two install/provenance tables are exempt) |
| xacts | no other transaction on the database is older than `--max-xact-age` (default 30 s); the login must be able to see other sessions (superuser or `pg_read_all_stats`), otherwise the check refuses rather than passing blind |
| disk | `--free-bytes`, the free disk on the database host measured by the operator (RDS `FreeStorageSpace`; `df` on the data directory for a self-hosted server), is at or above `--disk-floor-bytes` (default 5 GiB) |

It then sends four session settings ahead of the file, each printed and
overridable: `lock_timeout` 5 s (`--lock-timeout`), `statement_timeout` 60 s
(`--statement-timeout`), `transaction_timeout` 120 s
(`--transaction-timeout`) and `idle_in_transaction_session_timeout` 30 s
(`--idle-timeout`). `lock_timeout` bounds each lock acquisition wait, not how
long an acquired lock is held; the transaction and statement budgets bound
that. 000019 sets no timeout itself; 000023 pins `lock_timeout` to 5 s inside
its own transaction (`SET LOCAL`), so for it the acquisition budget is 5 s
whatever the flag says. A budget that fires aborts the transaction, nothing is
applied, and the wrapper exits non-zero. After the file it checks the result
(000019: the `polis_queue_install` record exists; 000023: `contract_version`
reads `polis-queue/2`). `--preflight-only` runs the checks and stops.

The contended-parent witness, check (i) of `test_000023_down.sh`, proves the
lock claim and the budgets for both files: with a concurrent uncommitted
`UPDATE` on `conversations`, the apply is seen waiting for
`ShareRowExclusiveLock` on `conversations`, fails on `lock_timeout`, and the
schema dump is unchanged; with that transaction older than `--max-xact-age`,
the preflight refuses first; once the writer is gone, the same command applies.

The applying login must be able to `SET ROLE` to the object owner. On a first
apply that creates the roles it needs `CREATEROLE` (or superuser); on every
apply it needs SET-capable membership in `polis_queue_owner`, `CREATE` and
`USAGE` on `public` with grant option, and `SELECT`, `UPDATE(topic)`,
`REFERENCES(zid)` on `public.conversations` with grant option. Owning
`conversations` satisfies the last of those. An applier that is a member of
`polis_queue_owner` *without* SET fails with a readable precondition rather
than half-applying: PostgreSQL 17 lets a role creator hold ADMIN without SET.

Re-applying is safe against the schema the file created. It is **not** safe
against a drifted one, and that is deliberate: the file fingerprints the
enumerated catalog before and after the DDL and aborts the transaction if
anything differs, so `CREATE ... IF NOT EXISTS` can never quietly bless an
incompatible object. A drift abort names the table or the check that failed and
carries the observed catalog in the error DETAIL. Repairing drift is a human
decision; the migration will not do it for you.

If you change the schema, regenerate the fingerprints in the same reviewed
change: apply the new DDL to a disposable PostgreSQL 17, recompute the three
`md5(...)` values the guard functions compare, and update the signature array.
Then update `QUEUE_SQL_SHA256` in **both** adapters
(`server/src/queue/protocol.ts` and `delphi/polismath/queue/executor.py`); two
tests fail until you do.

## Reversal

There is a down script, and having a tested one is a precondition for ever
applying 000019 to production. It is
`server/postgres/migrations/down/000019_drop_polis_queue.sql`. It removes only
what 000019 **provably** created — the up migration accepts a *pre-existing*
NOLOGIN owner/executor role and does not require it to be otherwise empty, so
the down script must not trust names. In one transaction it:

1. Locks the five queue tables `ACCESS EXCLUSIVE`, in a fixed order, **before**
   counting rows, and holds the locks through `COMMIT`.
2. Verifies the installed schema against 000019's **own** catalog fingerprint
   (the table-md5 map, the 21-signature array, and a per-function digest that
   hashes each `prosrc` **body** along with its result, argument types,
   volatility, security-definer flag, config, owner and ACL). If anything
   queue-shaped exists but does not match — an unrelated `pq_*` function, an
   added overload, a drifted table, or a **body-only rewrite** of a function —
   it **refuses** and names the mismatch, rather than dropping it.
3. Reads the **installation provenance** 000019 recorded (see below) — refusing
   if that record is missing/multiple, if its fingerprint no longer matches the
   live catalog, or if its contents name a role/grant outside 000019's closed
   inventory (the roles must be a disjoint complete partition of the two role
   names; every added grant must be one 000019 itself adds). This content
   validation is a separate trust boundary from the schema fingerprint.
4. Drops its inventory in dependency order: the trigger, the 21 functions **by
   full argument signature**, the 9 explicit indexes, the 5 data tables.
5. Revokes **only the grants 000019 recorded as added**, leaving anything a
   pre-existing (adopted) role brought with it — including a grant identical to
   one 000019 also added, which coalesces into a single catalog entry and is
   otherwise impossible to attribute. An add that only upgraded an existing
   privilege to `WITH GRANT OPTION` is **downgraded** with `REVOKE GRANT OPTION
   FOR`, never removing the operator's original privilege. Grants 000019 made
   *as* the owner role are revoked under `SET ROLE`; the rest as the current
   login. Then drops the provenance table.
6. Drops **only the roles 000019 recorded as created**, and preserves every
   adopted role untouched. A second belt still checks that each created role,
   once its added grants are revoked and its objects dropped, is a bare default
   NOLOGIN owning/holding nothing — otherwise it refuses rather than drop. It
   never uses `DROP OWNED BY`, which would sweep away unrelated objects.

`public.conversations` and the `public` schema themselves are never touched. A
reversal that preserved an adopted role leaves that role behind, so re-running
the down then refuses (a queue role without the schema) rather than being a
no-op; the operator drops the role by hand if they want it gone.

**Why a recorded provenance.** 000019 *adopts* a pre-existing NOLOGIN
owner/executor role (it `CREATE`s each only when absent) and does not require it
to be empty. When such a role already holds a grant 000019 also adds — same
grantee, grantor and privilege — the two ACL entries **coalesce** into one (and a
plain grant it upgrades to `WITH GRANT OPTION` is a single entry that only
changed its grantable flag), so no after-the-fact comparison of the final
catalog can tell who created the grant or the role. So 000019 itself records the
truth at install time: immediately after `BEGIN`, before it creates or grants
anything, it snapshots which of its roles already exist and which of the exact
grants it is about to add already exist, and at the end writes one row to
`public.polis_queue_install` (`created_roles[]`, `adopted_roles[]`,
`added_grants` — each `{object,grantee,grantor,privilege,grantable,option_only}`,
computed as the end-state grants minus the snapshot, with `option_only` marking
an add that only introduced the grant option — `applied_at`, and a catalog
fingerprint). The table is part of 000019's own catalog fingerprint, so drift
detection covers it. The record is written once and preserved on re-apply
(`ON CONFLICT DO NOTHING`); a re-apply over an installed queue whose record has
been **deleted** is **aborted** rather than allowed to reconstruct false
"everything adopted" history from the final state. The reversal trusts this
record — after validating its contents — rather than guessing. (000019 has not
been applied to any persistent environment; every apply gets the recorded
provenance. Any persistent old install would need a separately reviewed
preservation path, not this amendment replayed over it.)

Run it alone, as a superuser (`postgres`), exactly as
[docs/migrations.md](migrations.md) applies a file:

```sh
docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
  < server/postgres/migrations/down/000019_drop_polis_queue.sql
```

It **refuses** to run if any `polis_queue_*` table holds rows, so a live queue
is never dropped by accident. `force` overrides **only** this live-queue guard —
never a drift or provenance refusal. Override deliberately, and only then, with
`-v force=1`:

```sh
docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -v force=1 -U postgres \
  -d polis-dev < server/postgres/migrations/down/000019_drop_polis_queue.sql
```

The `ACCESS EXCLUSIVE` lock is a guard, not a substitute for operations: stop or
drain the queue's writers before reversing in production. `lock_timeout`
(default `5s`, override `-v lock_timeout=...`) bounds the wait, so a busy table
fails and rolls back rather than blocking indefinitely. The script is one
transaction and idempotent: when no queue table, `pq_*` function or queue role
exists it is a no-op that emits a `NOTICE`, and re-running after a successful
down is the same no-op.

Every refusal — live queue, drift/collision, or an un-clean role — rolls the
whole transaction back and drops nothing; the operator resolves what the message
names and re-runs.

The reversal is proven by
`server/postgres/migrations/down/test_000019_down.sh`, which stands up a
throwaway `postgres:17` and asserts, on isolated databases: (a) applying
000000..000019 then the down script leaves a catalog identical to
000000..000018 (`pg_dump --schema-only`, plus the `polis_queue_*` roles via
`pg_roles`); (b) apply → down → apply again succeeds; (c) a no-op notice on a
database that never had 000019; (d) a non-empty queue is refused without `force`
and dropped with it; (e) an unrelated same-named `pq_*` function on an
un-installed database survives (refusal, not a silent drop); (f) an unrelated
table owned by `polis_queue_owner` causes a refusal and survives; (g) a
pre-existing `polis_queue_executor` role survives; (h) a writer that commits
a row concurrently is blocked by the lock and its row is seen and refused, never
lost; (i) an *adopted* executor role — pre-created with an extra schema grant
and a role-level `statement_timeout` that 000019 then adopts — is preserved with
its grant and setting intact while the created owner and the queue are dropped;
(j) a body-only rewrite of `pq_backoff` is caught by the `prosrc` fingerprint
and refused; (k–n) the four coalescing witnesses — an owner pre-holding
`conversations` SELECT / `UPDATE(topic)`, or `public` CREATE / USAGE WITH GRANT
OPTION, one 000019 also adds — are preserved on the adopted owner while the
created executor is dropped; (o) a deleted provenance record is refused;
(p) a plain USAGE that 000019 upgrades to WITH GRANT OPTION is downgraded on
reversal, not revoked; (q) a record whose contents name an unrelated role or
grant, or whose arrays are emptied, is refused with nothing removed; and (r) a
re-apply over an installed queue whose provenance record was deleted is aborted.

```sh
bash server/postgres/migrations/down/test_000019_down.sh
```

## The flag

`POLIS_QUEUE_SUBSTRATE_ENABLED` (default off) makes
`server/src/queue/enqueue.ts` usable. It is forced off whenever `NODE_ENV` is
`production`, regardless of the variable. Turning it on does not start a worker,
does not add a route and does not change any served bytes; it only lets
dev/test code call `enqueueNoopJob`.

The env namespace is restricted to `dev` or `test`, optionally suffixed
(`test-p024-3f2a`), so a public-fixture job cannot be addressed at another
environment's product heads.

The Node enqueuer runs on the server's existing broad read-write login. The
grant boundary in the migration is real in the database, but it is not what
constrains this caller today. A dedicated service login with
`polis_queue_executor` membership is separate, separately reviewed provisioning
work.

## The executor

`delphi/polismath/queue/executor.py` is a standalone process: claim, heartbeat,
finalize, plus one bounded reaper opportunity per cycle. It refuses to start
unless `POLIS_QUEUE_SUBSTRATE_ENABLED` is set, `NODE_ENV` is not `production`,
and the env is in the dev/test namespace.

Every connection then re-checks the grant boundary, not only the first one. The
login must be a member of `polis_queue_executor`, must hold **no** table-level
or column-level privilege on **any** of the five queue tables, and must not be
able to reach `polis_queue_owner` by inheritance or `SET ROLE`. A single denied
`UPDATE` on one table would not be proof of the boundary: a login with executor
membership plus `UPDATE` on `polis_queue_heads` passes that and can still move a
published pointer behind the functions' backs.

```sh
POLIS_QUEUE_SUBSTRATE_ENABLED=true python -m polismath.queue.executor \
  --dsn "postgresql://queue_executor:...@localhost:5432/polis-dev" \
  --env dev --once
```

It executes nothing. The noop stage's output is exactly its fixed public-fixture
input descriptor; the executor never follows the input URI, reads a job-named
file, starts a child process, loads science code or calls a provider. A job
whose descriptor is not the expected public-fixture one is failed permanently.

Two behaviours are worth knowing because they are not obvious:

* A `pq_claim` whose COMMIT outcome is unknown is **never repeated**. The first
  COMMIT may already have taken ownership, and a second claim would take a
  second job while the first lease ran unattended. The executor renews the exact
  token the uncertain reply named instead.
* The reaper cursor is in memory, so a restart begins a pass again. That is safe
  because every mutation rechecks current state, but it is not a recovery
  certificate.

## Running the tests

Server (needs the test stack from `docker-compose.test.yml`; the queue suite
applies the migration itself in setup):

```sh
cd server && npm run test:integration
```

If your test database login cannot create roles or databases, set
`POLIS_QUEUE_TEST_SKIP_ROLE_PROVISIONING=true`; the apply/replay and
plans-at-scale suites then report as skipped with the reason in the suite name,
and the protocol suite still runs.

Delphi (skips cleanly when neither `POLIS_TEST_POSTGRES_URL` nor docker is
available, in which case it starts a throwaway `postgres:17`):

```sh
cd delphi && pytest tests/test_queue_noop_executor.py
```

The migration is located by walking up from the test file for a directory that
holds `server/postgres/migrations`, so it works from any checkout depth. The
Delphi Python CI job copies only `delphi/tests` into `/app/tests` inside the
delphi image, where no checkout exists above the tests; there the migration-
dependent cases skip with that reason rather than failing the SQL pin for a
packaging reason. `POLIS_MIGRATIONS_DIR` overrides the location and makes them
run in that image too - and an override that does not resolve fails, because
that is operator error rather than an absent prerequisite.

The language-neutral specification harness stays outside the repository, in the
cost-reduction notes (`scripts/p024-queue-sql-smoke.py`). This repository's
regression test is the server integration suite.

## polis-queue/2: the Delphi job table (migration 000023)

`server/postgres/migrations/000023_create_delphi_foundation.sql` is the second
contract on the same substrate, the one the `polis-jobs` daemon
(`queue-rs/`, `POLIS_JOBS_ENABLED`) runs on. Its header lists every object it
creates. In short: `delphi_jobs` (one row per Delphi job, with its parent for
sub-jobs, its run, its status kept in step with `polis_queue_jobs` by trigger),
`delphi_job_aliases`, `delphi_job_inputs`, `delphi_current` (created empty;
nothing in /2 moves it), `delphi_job_guards`, `delphi_provider_requests` (a
paid provider batch is recorded *before* it is submitted), `polis_queue_logs`,
and `delphi_foundation_install` (the catalog baseline the down script
restores). On 000019's tables it adds `contract_version`, admits the two Delphi
stages beside `noop`, and adds `worker_class`, `process_exit_confirmed_at` and
`binding_expires_at`. The `/1` noop path is untouched. Results stay in
DynamoDB: there is no result table and no result-writing function.

Two of those tables deserve plain words:

* `delphi_job_guards` holds **one guard row per scope, held until safe
  explicit release**. `pd_enqueue` creates it with the root job and the
  request digest; while it exists, an identical request returns the existing
  job and a different one is a `conflict`. Only `pd_release_scope` removes it,
  and it refuses (returns `false`) while any job in the root's tree is not
  terminal, any of their attempts lacks exit proof, or any provider request of
  theirs is open. Nothing releases a guard automatically, a terminal root
  included; a scope whose guard is never released stays closed to new
  admissions until an operator or the daemon calls `pd_release_scope`.
* `polis_queue_logs` holds the attempt logs, and the daemon writes them with
  **direct `INSERT`s** under the executor role's table-level `INSERT` grant,
  not through an RPC. The database enforces **one limit per row** (`line` at
  most 1 MiB, the table's `CHECK`) and nothing per attempt: the daemon's own
  buffer caps an attempt at `POLIS_JOBS_LOG_MAX_LINES` / `_BYTES` (20,000
  lines, 8 MiB by default) and writes one `truncated` marker row, but any
  login holding the executor grant can insert without limit. **There is no
  retention**: nothing deletes, rotates or sweeps log rows, no index exists
  beyond the primary key, and the down script refuses while any row exists.

Schema ruling S1 (2026-10-05) approved it as direction: one datastore and typed
contracts, flag off, DynamoDB running every job family until each is moved one
at a time. **Required migrations now apply during deployment**, in numeric order through
`polis-migrate apply`; review and authorize their schema effects at merge time.
Both 000019 and 000023 still hold `ShareRowExclusiveLock` on conversations, bounded
by the runner's lock and transaction limits. See [migration operations](migrations.md).

The applier must be able to `SET ROLE polis_queue_owner`; the file creates no
role. It refuses, changing nothing, when 000019 is absent, when any
`public.delphi_*` table or `pd_*` function already exists (so a second apply is
refused, not a no-op), or when the installed /1 catalog differs from what
000019 recorded. 000019 in turn refuses to replay over a /2 database, so no /2
function reverts to its /1 body by accident. A fresh container applies both at
initdb, so `make start` on a new volume has the tables, empty, and the flags
off.

Reversal: `server/postgres/migrations/down/000023_drop_delphi_foundation.sql`
restores the /1 catalog from the recorded baseline and refuses if any /2 row
exists (no force override). Both files are sealed in
`down/000023-files.sha256`. The proof is
`bash server/postgres/migrations/down/test_000023_down.sh` (docker only):
forward against the real chain, a refused second apply, a refused 000019
replay, the noop /1 path still working on /2, a refused down with data, the
down restoring a byte-identical schema dump, apply again after the down, the
down failing cleanly where 000023 was never applied, and (i) the
contended-parent witness through the wrapper for both 000019 and 000023: an
uncommitted writer on `conversations` makes the apply wait for
`ShareRowExclusiveLock`, fail on `lock_timeout` and change nothing; an older
writer is refused by the preflight; the same command applies once the writer
is gone.

## polis-queue/3: the large worker class (migration 000024)

`server/postgres/migrations/000024_create_polis_queue_large_class.sql` is the
third contract on the same substrate, on top of 000023. It creates no job
table. It admits a second worker class, `large`, and one stage for it,
`math_rebuild` (an oversized conversation's cold rebuild, run on the large box
as a job instead of through an S3 manifest; design
`P-073-r2-queue.md`, decision #350). In short, on 000023's objects: the
`worker_class` CHECK admits `large`, the `stage` CHECK admits `math_rebuild`,
a new CHECK (`pq_stage_large`) binds the two to each other, `delphi_jobs.kind`
admits `math_rebuild` (so the one-active-job-per-scope guard covers a rebuild
unchanged), `polis_queue_runs.contract_version` admits `polis-queue/3`, and
`polis_queue_install.contract_version` reads `polis-queue/3`. The six-argument
`pq_claim` and four-argument `pq_reap` take the class as given (`delphi` or
`large`) instead of being pinned to `delphi`; `pd_enqueue` admits
`math_rebuild` (no report id; scope `math:<label>:<zid>` by convention) under
the guards it already applies; `pd_queue_binding` binds the rebuild row to its
kind, class and contract; `pq_result` reports `polis-queue/3` for a rebuild.
One new read, `pq_class_depth(env, worker_class)`, returns the counts of
queued (queued + retry_wait), leased (running), parked and dead jobs of a
class and the oldest unresolved `created_at`: the small poller's capacity line
is made of it, so no table grant is needed. `pd_enqueue` gains the poison
latch: when a scope's last three jobs all died under the code image being
admitted now, the reply is outcome `poisoned` naming the latest dead job and
no job is made; a different image (a deploy), or a succeeded or cancelled job
among the last three, admits again. `pd_job_view` gains `scope_key`, the guard
the job's root holds (null once released). Who releases a scope, and when: the
`polis-jobs` daemon, after a terminal reply (succeeded, dead, cancelled) whose
attempt exit it proved, through `pd_release_scope`, which still refuses while
any job of the root's tree is not terminal, lacks exit proof or has an open
provider request; the small poller as a fallback, through the same function,
when an admission hands it a terminal job still holding its guard. Terminal
status alone never releases anything. `polis_queue_large_class_install`
holds the catalog baseline the down script restores. The `/1` noop path and
the `/2` Delphi path are unchanged; a class-`delphi` worker never sees a
rebuild and a class-`large` worker never sees a Delphi job.

**Applying it to production is a separate, explicit step by the owner**, after
000019 and 000023:

```sh
docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev   < server/postgres/migrations/000024_create_polis_queue_large_class.sql
```

The applier must be able to `SET ROLE polis_queue_owner`; the file creates no
role. It refuses, changing nothing, when 000023 is absent, when the installed
/2 catalog differs from what 000023 recorded (so a second apply is refused,
not a no-op), or when its install table or `pq_class_depth` already exists.
000019 and 000023 in turn refuse to replay over a /3 database.

Reversal: `server/postgres/migrations/down/000024_drop_polis_queue_large_class.sql`
restores the /2 catalog from the recorded baseline and refuses if any /3 row
exists (a rebuild or class-large job, a `math_rebuild` kind, a /3 run; no
force override). After it, 000023's own down applies as if 000024 had never
been. Both files are sealed in `down/000024-files.sha256`. The proof is
`bash server/postgres/migrations/down/test_000024_down.sh` (docker only):
forward against the real chain, refused replays, the rebuild admitted, guarded,
claimed by its class only, finalized and released, the job view naming the
scope, three deaths making the fourth admission `poisoned` and a new image
admitting again, a refused down with /3 data,
the down restoring a byte-identical schema dump, apply again after the down,
the down failing cleanly where 000024 (or 000023) was never applied, and
000023's down unwinding the chain after it.

## Gates still open

None of the eight acceptance gates has been earned. They must run from both
psycopg and a Rust adapter against a pinned PostgreSQL 17 and shared
fixture/SQL/contract hashes, each with its named failing negative control,
before any real work is routed here.

| Gate | What it must show |
|---|---|
| A1 concurrent claims and progress | N claimers over M jobs: no duplicate live ownership, fair progress while a row is locked. A read-then-unconditional-update claim must double-claim. |
| A2 query plan | Real inner claim plan and rows examined over seeded terminal history and all priority lanes, without forcing `enable_seqscan=off`. |
| A3 lease transfer | Suspend the owner, expire, reap, reclaim; every stale-token seam fenced and the new owner succeeding. |
| A4 lost commit acknowledgement | Kill the process after the finalize COMMIT and before its reply; restart must obtain `already_succeeded` with the exact attempt and digest and publish nothing twice. **No COMMIT has ever been severed here.** |
| A5 enqueue and rollback | Same key repeats the original, changed digest conflicts, a kill leaves a complete request+run+job+head or none. |
| A6 publication policy | Older completes after newer, desired run fails, repeated finalization: no regression and the prior pointer persists. |
| A7 HOT and vacuum | 10,000 heartbeats with stats flushed and vacuum observed, against an admitted HOT ratio and dead-tuple bound. |
| A8 budgets and quiet recovery | Exhausted rows leave the ready index and become dead; parked and expired work reconciles without a new enqueue, across cursor pages. |

Beyond the gates, and before any real job: durable input capture, the provider
`custom_id` and request-map repair, per-conversation routing exclusivity and
drain, a consistent backup and a restore rehearsal, and the two open product
questions (Q20 reaper/policy placement, Q21 admitted output descriptor). Both
questions were built for as small deltas; neither is answered here.

Two claims this slice does **not** make: that anything has been tested against
the deployed `conversations` schema, and that A4 has been earned.
