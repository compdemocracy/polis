# The vote convention in the database (migration 000025, P-078 PR-A)

`votes.vote` and `votes_latest_unique.vote` store **agree as -1, disagree as +1,
pass as 0**. That has been true since 2012 and is the opposite of the CSV
exports (agree = +1). Until 000025 nothing stored said so. 000025 puts the sign
next to the data, and every component refuses to run without it:

- `public.vote_convention`: **at most one row**, `(version, agree_value)`.
  Today's convention is **(0, -1)**. Who writes the row:
  - the migration itself, **only when both vote tables are empty** (a fresh
    install), as operation `seed-empty`;
  - otherwise the operator, once, with `make vote-convention-declare AGREE=-1`
    (`server/postgres/operations/vote_convention_declare.sql`, operation
    `vote_convention_declare`), after the migration printed
    `DECLARE_NEEDED`. `AGREE=+1` writes (1, +1) as the first state, for a
    deployment that reversed its own signs. The data's own evidence never
    decides the sign.
  - later, the flip tool (not in this release), in place, to exactly
    `version + 1` with the opposite sign.
  The monotonic trigger (SQLSTATE P0782) admits two first states, (0, -1) and
  (1, +1), and afterwards only `version + 1` with a sign change; it stamps
  `changed_at` and `changed_by`. The row is permanent: DELETE and TRUNCATE
  refuse (P0790). A row put back after a forced removal must continue the
  history (P0782).
- `public.vote_convention_history`: every state the row has had, with the
  `operation` that wrote it and, for an operation file, its ledger checksum
  (trigger; append-only: UPDATE, DELETE and TRUNCATE refuse with P0781).
- `public.schema_migrations`: the migration ledger (see
  [migrations.md](migrations.md#the-migration-ledger-schema_migrations-from-000025-on)).

**What refuses without the row.** The server (`server/index.ts`), the import
worker, the math poller (`delphi/scripts/math_poller.py`), the Delphi job
poller and its job stages (`run_math_pipeline.py`, the UMAP stage), and the
coordinator (`coordinator-rs`, at startup and at every source snapshot) read
`vote_convention_current()` before their first vote read and exit with an
operator message when the table is missing, the row is missing, the
`contract_version` is one they do not know, or the sign is not the one they
were built for (`STORAGE_AGREE_VALUE` in each language's chokepoint). The
messages and the procedure are in
[vote-convention-upgrade.md](vote-convention-upgrade.md).

**No data change.** No vote is read for writing, updated or deleted. A reader
that consults the row at version 0 computes exactly what it computes today.

## Functions and views

| object | kind | what it does |
|---|---|---|
| `vote_convention_current() → TABLE(version int, agree_value smallint, contract_version int)` | SQL, STABLE, SECURITY DEFINER | the row (no row: undeclared), in the caller's statement snapshot; never waits on the un-flip's lock |
| `vote_semantic(raw smallint, agree_value smallint) → smallint` | SQL, IMMUTABLE, STRICT | stored → semantic (+1 agree, -1 disagree, 0 pass); NULL → NULL |
| `vote_storage(semantic smallint, agree_value smallint) → smallint` | SQL, IMMUTABLE, STRICT | semantic → stored; the inverse |
| `vote_insert(p_zid, p_pid, p_tid, p_semantic smallint, p_weight_x_32767 smallint = 0, p_high_priority boolean = false, p_expected_version int = NULL) → TABLE(zid, pid, tid, vote smallint, created bigint, convention_version int)` | plpgsql, VOLATILE, SECURITY DEFINER, `lock_timeout = 2s` | takes the row `FOR SHARE`, refuses P0784 on a version mismatch and P0783 on a semantic value outside {-1, 0, 1}, inserts `vote_storage(p_semantic, agree_value)`; the 000006 rule copies the vote into `votes_latest_unique` |
| `votes_semantic`, `votes_latest_unique_semantic` | views | the table `CROSS JOIN vote_convention`, adding `semantic_vote`, `reaction` ('agree' / 'disagree' / 'pass') and `convention_version` |

`vote_convention_current()` and `vote_insert()` are SECURITY DEFINER. All functions run with `search_path = pg_catalog, pg_temp` and name every
object by schema. `lock_timeout` on `vote_insert` is a function `SET` clause:
the caller's own setting is restored when the function returns.

Named SQLSTATEs: P0780 (000025 refuses: already applied, partial copy, or
PostgreSQL < 13), P0781, P0782, P0783, P0784 as above, P0790 (DELETE or
TRUNCATE of the convention row), P0791 (`vote_insert` found no convention
row; nothing is written), P0785–P0788 (the held un-flip), P0789 (the down file
refuses), P0796–P0798 (the declare operation refuses: no table; a bad sign or
empty reason; already declared). 55P03: `vote_insert` waited 2 s for a lock. Almost always that is
the convention row held by the un-flip; rarely it is a contended
`votes_latest_unique` row (the same vote submitted twice inside a long caller
transaction). It is retryable either way.

Call `vote_insert` in READ COMMITTED (the default). A REPEATABLE READ or
SERIALIZABLE caller whose `FOR SHARE` meets a committed un-flip gets 40001
instead of re-reading the row.

## Grants

| object | server / math / Delphi login | `polis_probe_reader` | read-replica login | coordinator roles (000021) |
|---|---|---|---|---|
| `vote_convention` SELECT | owner | — (allowlist follow-up) | owner (same role) | observer, control, publisher |
| `vote_convention_history` SELECT | owner | — (allowlist follow-up) | owner | observer |
| `schema_migrations` SELECT | owner | — (allowlist follow-up) | owner | — |
| `vote_convention_current()` EXECUTE | PUBLIC | PUBLIC | PUBLIC | PUBLIC + explicit to observer, control, publisher |
| `vote_semantic`, `vote_storage` EXECUTE | PUBLIC | PUBLIC | PUBLIC | PUBLIC |
| `vote_insert()` EXECUTE | owner only (revoked from PUBLIC) | no | no | no |
| `votes_semantic`, `votes_latest_unique_semantic` SELECT | owner | — (allowlist follow-up) | owner | — |
| `vote_convention` UPDATE | owner only (the un-flip) | no | no | no |

- Every deployment in this repository connects the server, math and Delphi as
  the role that runs the migrations (the RDS master user of `cdk/db.ts`;
  `postgres` in the Docker stacks). That role owns every object, so it needs no
  grant. A deployment that connects the server as a different login grants it
  by hand: `GRANT EXECUTE ON FUNCTION public.vote_insert(integer, integer, integer, smallint, smallint, boolean, integer) TO <login>;`
  plus SELECT on the tables and views above. `vote_insert` is SECURITY
  DEFINER because its `FOR SHARE` on `vote_convention` needs UPDATE privilege
  on that table, which no role but the owner holds; so EXECUTE is the only
  write grant such a login needs, and it needs no INSERT on `votes`. Granting
  EXECUTE on `vote_insert` is therefore the same as granting INSERT on `votes`.
- `polis_probe_reader` gets no direct grant from 000025:
  `ci/probe_box/provision_login.py` refuses a reader holding a direct grant on
  any object outside its fixed table list. It reads the convention through
  PUBLIC EXECUTE on `vote_convention_current()`. Its table and view grants land
  together with the change to that allowlist.
- The coordinator grants are made only when the roles exist and are recorded
  in the ledger row's `note`. They are all on objects 000025 creates, so the
  down file's DROPs remove exactly them. Run the 000025 down before the 000021
  down: 000021's down refuses to drop a role that still holds a grant.
- Views run with their owner's rights: SELECT on `votes_semantic` reads vote
  rows even without SELECT on `votes`. That is why no coordinator role gets
  SELECT on the views: the observer has no read of `votes` today, and a grant
  on the views would give it one.

## Restore detection

A restored copy is **pre-flip** iff `vote_convention.version = 0` and the ledger
has no `%_vote_sign_unflip` row. First check the table exists:

```sql
SELECT to_regclass('public.vote_convention') IS NOT NULL AS has_convention;
```

`false`: the copy is older than 000025. Apply 000025, declare the sign (the
copy holds votes, so the migration seeds nothing), then classify. `true`:

<!-- restore-rule -->
```sql
SELECT CASE
         WHEN c.version IS NULL THEN 'undeclared'
         WHEN c.version = 0 AND c.agree_value = -1 AND NOT u.unflipped THEN 'pre-flip'
         WHEN c.version = 1 AND c.agree_value = 1 AND u.unflipped THEN 'post-flip'
         WHEN c.version = 1 AND c.agree_value = 1 AND NOT u.unflipped
              AND NOT EXISTS (SELECT 1 FROM public.vote_convention_history h WHERE h.version = 0) THEN 'declared-agree-plus'
         ELSE 'corrupt'
       END AS restore_state
  FROM (SELECT 1) AS one
  LEFT JOIN public.vote_convention c ON c.singleton
 CROSS JOIN (SELECT EXISTS (SELECT 1 FROM public.schema_migrations m
                             WHERE m.name LIKE '%\_vote\_sign\_unflip') AS unflipped) u;
```
<!-- /restore-rule -->

`undeclared`: no row; every component refuses until `make
vote-convention-declare AGREE=-1` is run. `pre-flip`: serve as is at version 0
(the un-flip is optional). `post-flip`: serve as is. `declared-agree-plus`: a
deployment that reversed its own signs and declared +1 as its first state (no
version-0 era in the history); this release's components refuse it.
`corrupt` (the un-flip row with version 0, or version 1 without it and not a
declaration): **stop**.

The rule knows these states only. Before anyone makes a second change
(version 2), this rule (and the down file's guard) must be extended first.

The `pre-ledger` rows for 000000–000022 are asserted by 000025, not observed:
000025 cannot tell whether a copy that predates, say, 000021 really ran it.
The ledger's evidence starts at 000025.

## Production runbook (ruling R-A, 2026-10-05)

Applying this migration to production is a separate, explicit step by the
owner, before the release that reads the row is deployed (the new images
refuse to start until the row exists; the running images never read it).

1. Check the files before applying them. The checksum each will write must
   match its own bytes:
   ```sh
   python3 server/postgres/check_ledger_checksums.py      # every ledger-bearing file: ok
   ```
   As the migration (owner) role, from inside the VPC, in one session:
   ```sh
   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f server/postgres/migrations/000025_vote_convention.sql
   ```
   Production holds votes, so this prints `DECLARE_NEEDED` and writes no row.
2. Declare the sign (one row, one transaction, no vote touched):
   ```sh
   DATABASE_URL=... server/bin/vote-convention-declare.sh -1 "pol.is: the storage convention since 2012"
   ```
   (or `make vote-convention-declare AGREE=-1 REASON="..."` with
   `DATABASE_URL` in the environment file). It prints `GUARDED v0 agree -1`.
3. Verify:
   ```sql
   SELECT * FROM public.vote_convention;                 -- (true, 0, -1, ..., contract_version 1, 'vote_convention_declare', <checksum>)
   SELECT * FROM public.vote_convention_current();       -- (0, -1, 1)
   SELECT count(*) FROM public.vote_convention_history;  -- 1
   SELECT name, checksum, note FROM public.schema_migrations ORDER BY name;  -- 22 pre-ledger + 000025
   BEGIN;                                                -- a vote_insert dry run, rolled back
   SELECT * FROM public.vote_insert(<zid>, <pid>, <tid>, 1::smallint);   -- vote = -1, convention_version 0
   ROLLBACK;
   ```
   Then deploy the release.
4. Rollback: stop the components that read the row, then
   `psql -X -v ON_ERROR_STOP=1 -f server/postgres/migrations/down/000025_drop_vote_convention.sql`.
   It drops the objects and touches no vote; it refuses (P0789) once the
   convention has moved past (0, -1) or a later migration is in the ledger.

## The un-flip's precondition: every writer goes through `vote_insert`

`vote_insert` is the chokepoint only for writers that use it. The owner role
can still INSERT into `votes` directly; the server's current vote route, the
import processor and the fixture generators all do. A raw INSERT carries no
convention. If it commits after the un-flip's `UPDATE votes SET vote = -vote`
took its snapshot, it keeps the old sign under the new convention, and that
vote's meaning is silently inverted. So the un-flip is safe only when:

1. the server release that writes through `vote_insert` is deployed, and the
   import path is switched to it (checked as a runbook precondition); and
2. the un-flip fences the tables itself. Proposed preamble for the held
   un-flip file, right after `BEGIN;` and its `SET LOCAL` lines:
   ```sql
   -- Table locks queue fairly. A row-level FOR UPDATE alone can be starved by a
   -- steady stream of vote_insert FOR SHARE lockers. EXCLUSIVE conflicts with
   -- their ROW SHARE but not with vote_convention_current()'s ACCESS SHARE,
   -- so reads continue.
   LOCK TABLE public.vote_convention IN EXCLUSIVE MODE;
   -- Blocks raw INSERT/UPDATE/DELETE on the vote tables for the flip's window
   -- (reads continue), so no writer outside vote_insert can commit an
   -- old-sign vote after the UPDATEs below took their snapshot.
   LOCK TABLE public.votes, public.votes_latest_unique IN SHARE ROW EXCLUSIVE MODE;
   ```
   The rehearsal must run under write load to measure how long writers wait.

## How the readers and writers bind to it

### The startup checks (this PR)

`server/src/votes/dbConvention.ts`, `delphi/polismath/utils/vote_convention_boot.py`
and `coordinator-rs/src/vote_convention.rs` each read
`SELECT to_regclass('public.vote_convention') IS NOT NULL AND to_regprocedure('public.vote_convention_current()') IS NOT NULL`
then `SELECT version, agree_value, contract_version FROM public.vote_convention_current()`
and refuse to start on no table, no row, an unknown contract, or a sign other
than their own `STORAGE_AGREE_VALUE`. The per-cycle reads below are unchanged.

### PR-C (the Python engine, PR #2927): nothing to change

Each vote-poll cycle:

```sql
SELECT to_regprocedure('public.vote_convention_current()') IS NOT NULL AS present;
-- present:
SELECT version, agree_value FROM public.vote_convention_current();
-- and every vote read:
SELECT v.zid, v.pid, v.tid, v.vote, v.created,
       vc.version AS convention_version, vc.agree_value AS convention_agree_value
  FROM votes v LEFT JOIN public.vote_convention_current() AS vc ON true
 WHERE ...;
```

At 000025 the probe starts finding the function, reads (0, -1) and computes
the same values as before. (The per-cycle source still treats a database
whose function is absent as version 0; the startup check above is what
refuses such a database before the first cycle.) The math and Delphi logins read it through PUBLIC
EXECUTE (or ownership).

### PR-B (the server, PR #2931) and its follow-up PR-B.2

PR-B's `ConventionSource.current()` stays synchronous. PR-B.2 adds a
database-backed source that refreshes once per request or pool checkout and
falls back to the constant while the function is absent:

```ts
// server/src/votes/dbConventionSource.ts (PR-B.2; not in this PR)
const PRESENT = "SELECT to_regprocedure('public.vote_convention_current()') IS NOT NULL AS present";
const ROW = "SELECT version, agree_value FROM public.vote_convention_current()";

export async function refreshConvention(query: QueryP): Promise<StorageConvention> {
  const [{ present }] = await query(PRESENT);
  if (!present) return CONSTANT_CONVENTION_SOURCE.current();
  const rows = await query(ROW);
  if (rows.length !== 1) throw new VoteConventionError("vote_convention_current() rows", rows.length);
  return Object.freeze({ agreeValue: rows[0].agree_value, version: rows[0].version });
}
```

`insertVote()` switches from its raw `INSERT INTO votes ... RETURNING *` to the
function, passing the **semantic** vote (the server maps wire to semantic with
its fixed `WIRE_AGREE_VALUE = -1` first and never sees the storage sign):

```ts
const sql = "SELECT * FROM public.vote_insert($1, $2, $3, $4, $5, $6, $7)";
// [zid, pid, tid, semantic, weight_x_32767, high_priority, expectedVersion]
// SQLSTATE 55P03 -> 503 polis_err_votes_paused_retry
// SQLSTATE P0784 -> refresh the convention, retry once
// SQLSTATE P0783 -> 400 (the route already validates)
// SQLSTATE P0791 -> 500 (the convention row is missing; nothing was written)
```

Semantic reads move to `votes_semantic` / `votes_latest_unique_semantic`. The
import processor's direct write to `votes_latest_unique` is replaced by
`vote_insert`, so the 000006 rule does the copy.

### Rust coordinator (P-077 R-2)

`StorageConvention` is built from `SELECT version, agree_value FROM
public.vote_convention_current()` inside the snapshot transaction. The
`STORAGE_AGREE_VALUE` environment value becomes a startup assertion against
the row, then goes away.

### Probe extractor and ops pages

Read `vote_convention_current()` in the same snapshot as the votes and record
`convention_version` in receipts and page payloads.

### The two-convention CI gate

The gate's provisioner leaves the seed (0, -1) for the v0 leg. For the v1 leg
it runs, before loading fixtures,
`UPDATE public.vote_convention SET version = 1, agree_value = 1, reason = 'gate v1' WHERE singleton;`
and loads votes through `vote_storage`, so both legs mirror each other with
the row present. It never flips data.

## Tests

`server/postgres/migrations/down/test_000025_down.sh` runs
`test_000025_down.py` against a disposable PostgreSQL 17 container of its own:

```sh
COMPOSE_PROJECT_NAME=p078a POLIS_RECOVERY_PG_PORT=5476 \
  server/postgres/migrations/down/test_000025_down.sh
```

It pins the seed rule (empty database only), the undeclared state, the declare
operation at both signs and its refusals, the shell entry point, the guards,
the functions at both signs, the write path's lock behaviour, the ledger and
the checksum checker, the restore rule above verbatim, and the down file from
seeded, undeclared and declared databases.

The startup checks have their own unit tests:
`server/__tests__/unit/dbConvention.test.ts`,
`delphi/tests/test_vote_convention_boot.py`,
`coordinator-rs/tests/vote_convention.rs`.
