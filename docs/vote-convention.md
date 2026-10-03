# The vote convention in the database (migration 000023, P-078 PR-A)

`votes.vote` and `votes_latest_unique.vote` store **agree as -1, disagree as +1,
pass as 0**. That has been true since 2012 and is the opposite of the CSV
exports (agree = +1). Until 000023 nothing stored said so. 000023 puts the sign
next to the data:

- `public.vote_convention`: one row, `(version, agree_value)`, seeded at
  **(0, -1)**, today's convention. It is updated in place, only by the
  un-flip migration, and only to exactly `version + 1` with the opposite sign
  (trigger, SQLSTATE P0782; the trigger also stamps `changed_at` and
  `changed_by`). The row is permanent: DELETE and TRUNCATE refuse (P0790). A
  row put back after a forced removal must continue the history (version + 1,
  opposite sign; P0782).
- `public.vote_convention_history`: every state the row has had (trigger;
  append-only: UPDATE, DELETE and TRUNCATE refuse with P0781).
- `public.schema_migrations`: the migration ledger (see
  [migrations.md](migrations.md#the-migration-ledger-schema_migrations-from-000023-on)).

**No data change.** No vote is read for writing, updated or deleted. A reader
that consults the row at version 0 computes exactly what it computes today.

## Functions and views

| object | kind | what it does |
|---|---|---|
| `vote_convention_current() → TABLE(version int, agree_value smallint)` | SQL, STABLE, SECURITY DEFINER | the row, in the caller's statement snapshot; never waits on the un-flip's lock |
| `vote_semantic(raw smallint, agree_value smallint) → smallint` | SQL, IMMUTABLE, STRICT | stored → semantic (+1 agree, -1 disagree, 0 pass); NULL → NULL |
| `vote_storage(semantic smallint, agree_value smallint) → smallint` | SQL, IMMUTABLE, STRICT | semantic → stored; the inverse |
| `vote_insert(p_zid, p_pid, p_tid, p_semantic smallint, p_weight_x_32767 smallint = 0, p_high_priority boolean = false, p_expected_version int = NULL) → TABLE(zid, pid, tid, vote smallint, created bigint, convention_version int)` | plpgsql, VOLATILE, SECURITY DEFINER, `lock_timeout = 2s` | takes the row `FOR SHARE`, refuses P0784 on a version mismatch and P0783 on a semantic value outside {-1, 0, 1}, inserts `vote_storage(p_semantic, agree_value)`; the 000006 rule copies the vote into `votes_latest_unique` |
| `votes_semantic`, `votes_latest_unique_semantic` | views | the table `CROSS JOIN vote_convention`, adding `semantic_vote`, `reaction` ('agree' / 'disagree' / 'pass') and `convention_version` |

`vote_convention_current()` and `vote_insert()` are SECURITY DEFINER. All functions run with `search_path = pg_catalog, pg_temp` and name every
object by schema. `lock_timeout` on `vote_insert` is a function `SET` clause:
the caller's own setting is restored when the function returns.

Named SQLSTATEs: P0780 (000023 refuses: already applied, partial copy, or
PostgreSQL < 13), P0781, P0782, P0783, P0784 as above, P0790 (DELETE or
TRUNCATE of the convention row), P0791 (`vote_insert` found no convention
row; nothing is written), P0785–P0788 (the held un-flip), P0789 (the down file
refuses). 55P03: `vote_insert` waited 2 s for a lock. Almost always that is
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
- `polis_probe_reader` gets no direct grant from 000023:
  `ci/probe_box/provision_login.py` refuses a reader holding a direct grant on
  any object outside its fixed table list. It reads the convention through
  PUBLIC EXECUTE on `vote_convention_current()`. Its table and view grants land
  together with the change to that allowlist.
- The coordinator grants are made only when the roles exist and are recorded
  in the ledger row's `note`. They are all on objects 000023 creates, so the
  down file's DROPs remove exactly them. Run the 000023 down before the 000021
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

`false`: the copy is older than 000023. Apply 000023 (it seeds 0/-1), then
classify. `true`:

<!-- restore-rule -->
```sql
SELECT CASE
         WHEN c.version = 0 AND c.agree_value = -1 AND NOT u.unflipped THEN 'pre-flip'
         WHEN c.version = 1 AND c.agree_value = 1 AND u.unflipped THEN 'post-flip'
         ELSE 'corrupt'
       END AS restore_state
  FROM (SELECT 1) AS one
  LEFT JOIN public.vote_convention c ON c.singleton
 CROSS JOIN (SELECT EXISTS (SELECT 1 FROM public.schema_migrations m
                             WHERE m.name LIKE '%\_vote\_sign\_unflip') AS unflipped) u;
```
<!-- /restore-rule -->

`pre-flip`: serve after the un-flip, or as is before it. `post-flip`: serve as
is. `corrupt` (the un-flip row with version 0, version 1 without the row, or
no row at all): **stop**.

The rule knows two states, (0, -1) and (1, +1). The guard would allow a
second change (version 2), but before anyone makes one this rule (and the
down file's guard) must be extended first.

The `pre-ledger` rows for 000000–000022 are asserted by 000023, not observed:
000023 cannot tell whether a copy that predates, say, 000021 really ran it.
The ledger's evidence starts at 000023.

## Production runbook (after ruling R-A)

1. Check the file before applying it. The checksum it will write must match
   its own bytes:
   ```sh
   python3 server/postgres/check_ledger_checksums.py      # every ledger-bearing file: ok
   grep -v -e '-- ledger-self-checksum' server/postgres/migrations/000023_vote_convention.sql | sha256sum
   grep -o "'000023_vote_convention', '[0-9a-f]*'" server/postgres/migrations/000023_vote_convention.sql
   ```
   The two hashes must be equal. After applying, the same hash must be in
   `SELECT checksum FROM public.schema_migrations WHERE name = '000023_vote_convention';`.
   As the migration (owner) role, from inside the VPC, in one session:
   `psql -X -v ON_ERROR_STOP=1 -f server/postgres/migrations/000023_vote_convention.sql`
2. Verify:
   ```sql
   SELECT * FROM public.vote_convention;                 -- (true, 0, -1, ..., contract_version 1)
   SELECT * FROM public.vote_convention_current();       -- (0, -1)
   SELECT count(*) FROM public.vote_convention_history;  -- 1
   SELECT name, checksum, note FROM public.schema_migrations ORDER BY name;  -- 22 pre-ledger + 000023
   BEGIN;                                                -- a vote_insert dry run, rolled back
   SELECT * FROM public.vote_insert(<zid>, <pid>, <tid>, 1::smallint);   -- vote = -1, convention_version 0
   ROLLBACK;
   ```
3. Rollback: `psql -X -v ON_ERROR_STOP=1 -f server/postgres/migrations/down/000023_drop_vote_convention.sql`.
   It drops the objects and touches no vote; it refuses (P0789) once the
   convention has moved or a later migration is in the ledger. Before you run
   it, roll back any server release that calls `vote_insert`, because this
   file drops the function.

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

At 000023 the probe starts finding the function, reads (0, -1) and computes
the same values as before. The math and Delphi logins read it through PUBLIC
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

`server/postgres/migrations/down/test_000023_down.sh` runs
`test_000023_down.py` against a disposable PostgreSQL 17 container of its own:

```sh
COMPOSE_PROJECT_NAME=p078a POLIS_RECOVERY_PG_PORT=5476 \
  server/postgres/migrations/down/test_000023_down.sh
```
