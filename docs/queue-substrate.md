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

A **fresh** container applies it automatically: the postgres image copies
`server/postgres/migrations/*.sql` into `/docker-entrypoint-initdb.d`, so
`make start` on a new volume comes up with the schema present and the flag off.

An **existing** database needs the file applied by hand, exactly as
[docs/migrations.md](migrations.md) describes. Apply this file alone; never
replay the migrations directory as an upgrade mechanism.

```sh
docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
  < server/postgres/migrations/000019_create_polis_queue.sql
```

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
