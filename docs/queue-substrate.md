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
| The schema: 5 tables, 21 `pq_` functions, 2 NOLOGIN roles | `server/postgres/migrations/000019_create_polis_queue.sql` |
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

## The flag

`POLIS_QUEUE_SUBSTRATE_ENABLED` (default off) makes
`server/src/queue/enqueue.ts` usable. It is forced off whenever `NODE_ENV` is
`production`, regardless of the variable. Turning it on does not start a worker,
does not add a route and does not change any served bytes; it only lets
dev/test code call `enqueueNoopJob`.

The env namespace is restricted to `dev` or `test`, optionally suffixed
(`test-p024-3f2a`), so a synthetic job cannot be addressed at another
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
the env is in the dev/test namespace, and the database login is a member of
`polis_queue_executor` **and** holds no direct write on the queue tables. The
last check runs on every connection, not only at startup.

```sh
POLIS_QUEUE_SUBSTRATE_ENABLED=true python -m polismath.queue.executor \
  --dsn "postgresql://queue_executor:...@localhost:5432/polis-dev" \
  --env dev --once
```

It executes nothing. The noop stage's output is exactly its fixed synthetic
input descriptor; the executor never follows the input URI, reads a job-named
file, starts a child process, loads science code or calls a provider. A job
whose descriptor is not the expected synthetic one is failed permanently.

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
