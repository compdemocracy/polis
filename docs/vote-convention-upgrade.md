# Upgrading to the vote convention guard (migration 000025)

This page is for anyone who runs their own Polis: what changes when you take
this release, what you will see, and the two commands that get you through it.

## What the convention is

Polis stores every vote as a number in two tables, `votes` and
`votes_latest_unique`. Since 2012 the number for **agree has been -1** in the
database (disagree +1, pass 0). The CSV exports have always shown agree as +1,
and the clients send -1 for agree; those do not change. Until this release
nothing in the database said which stored number means agree; every program
that read votes assumed it.

From this release the database records it itself, in one table with at most
one row:

```
public.vote_convention (version, agree_value, ...)
```

`agree_value` is the stored number that means agree. Today that is -1, called
**version 0**. Every Polis component (the API server, the import worker, the
math poller, the Delphi job poller and its jobs, the coordinator) reads this
row when it starts and **refuses to start** when the row is missing, or when
it names a convention the component was not built for. Nothing assumes the
sign any more.

**No vote value changes.** Your database can stay at version 0 forever;
nothing in this release, and nothing planned, requires you to change it.

## What you will see on upgrade

A **fresh install** (an empty database) needs nothing: the migration writes
the row itself (version 0, agree -1).

An **existing deployment** (a database that already holds votes) sees two
things, in this order:

1. The migration `000025_vote_convention.sql` creates the table and leaves it
   **empty**, printing:

   ```
   NOTICE:  vote convention: DECLARE_NEEDED. This database holds votes and records no sign. Polis components will not start until you declare it. Next: "make vote-convention-declare AGREE=-1" (the original convention) or AGREE=+1 only if your deployment reversed its vote signs itself. Guide: docs/vote-convention-upgrade.md#declare
   ```

   The migration never guesses the sign from the data; the operator declares
   it.

2. Until the declaration is made, every new component refuses to start and
   exits with this message (the component's name varies):

   ```
   Polis cannot start (server): this database does not record which stored vote value means "agree". Older Polis databases store agree as -1; this release no longer assumes it. Nothing has been changed. Next: back up the database, then declare its convention with "make vote-convention-declare AGREE=-1" (AGREE=+1 only if your deployment reversed its vote signs itself). Guide: docs/vote-convention-upgrade.md#declare
   ```

   Old containers keep working next to the undeclared database (they never
   read the row), so a rolling upgrade is safe **as long as the declaration
   comes before the new containers**.

If you start the new containers before applying the migration at all, the
message names that instead:

```
Polis cannot start (server): this database has no vote_convention table, so it does not record which stored vote value means "agree". Migration 000025 has not been applied. Nothing has been changed. Next: back up the database, apply server/postgres/migrations/000025_vote_convention.sql (see docs/migrations.md), then, if the database already holds votes, run "make vote-convention-declare AGREE=-1". Guide: docs/vote-convention-upgrade.md#guard
```

## The procedure

Every step checks its own state first and is safe to re-run.

### Status

```sh
make vote-convention-status
```

prints one of `GUARD_NEEDED` (apply the migration), `DECLARE_NEEDED`
(declare the sign), or `GUARDED v0 agree -1 ...` (done). With a database
outside Docker Compose, set `DATABASE_URL` in your environment file; with
`POSTGRES_DOCKER=true` the command runs inside the compose `postgres`
container.

### Guard

Back up the database (`pg_dump -Fc`, schema and data). Then apply the
migration through the checked wrapper, which refuses before sending anything
unless its preflight passes (the file matches its seal, PostgreSQL 17, the
login owns the vote tables, the vote tables exist, no vote convention object
exists yet, no other transaction older than 30 s, and the free disk you
measured is above the floor) and sends statement, transaction and idle
budgets ahead of the file:

```sh
server/postgres/bin/apply-migration.sh --free-bytes <bytes free on the database host> 000025 -- \
  docker exec -i polis-dev-postgres-1 psql -U postgres -d polis-dev
```

or, outside Docker, with `psql "$DATABASE_URL"` after the `--`. The wrapper
prints each check, the budgets, the lock the file takes, and after the apply
the convention state (`DECLARE_NEEDED` or `GUARDED`) and what the ledger
recorded for the earlier migrations. Applying it a second time is refused at
the preflight (and by the file itself, `P0780`): nothing changes.

**What it locks.** The migration reads no vote and rewrites nothing, but its
two "is the table empty" checks hold `AccessShareLock` on `votes` and
`votes_latest_unique` until it commits. Ordinary reads and writes are
compatible with that lock; a concurrent `ACCESS EXCLUSIVE` holder on either
table (a rewrite, `VACUUM FULL`, a schema change) makes the migration wait up
to its 5-second lock budget and then roll back with nothing applied. The
budget is per lock acquisition; the wrapper's transaction budget (120 s by
default) bounds the whole apply.

### Declare

If the migration printed `DECLARE_NEEDED`:

```sh
make vote-convention-declare AGREE=-1
```

That is the whole step for almost everyone. It writes the one row
(version 0, agree -1) in one transaction, records who declared it, why, and
the checksum of the declaration script, and prints the status line. It refuses
(and changes nothing) when the migration is not applied, when the sign is not
-1 or +1, or when the database already declares a convention: a declaration is
made once, and only the (future, optional) flip tool changes it.

`AGREE=+1` is **only** for a deployment that reversed its own stored vote
signs by hand. See [mismatch](#mismatch) before using it. A reason can be
recorded with `REASON="..."`.

### Start the new containers

In any order. Each one refuses on its own until the row exists, and none of
them needs any other.

The checks are made **at startup** (and, for a Delphi job, at the start of
each job before it removes anything). A process that is already running when
the row changes is not stopped by this release; stop the components before
any later change of the declaration.

Exit codes on a refusal: the server, the import worker, the Delphi job poller
and a Delphi job exit 1; the math poller exits 2 (its "refusing to start"
code); the commentgraph CLI's `test-postgres` exits 1. The refusal is logged
at error level, so it shows at the server's default log level; the success
line `vote convention: version 0, agree stored as -1` is logged at info level
and shows only with `SERVER_LOG_LEVEL=info` (the Python processes print it at
their default level).

## Mismatch

A component built for one sign refuses a database that declares the other:

```
Polis cannot start (server): this database declares vote convention version 1 (agree = +1), but this release of the server is built for agree = -1. Running it would read and write every vote inverted. Nothing has been changed. Next: run a Polis release built for the declared convention, or restore the database this release was built for. Guide: docs/vote-convention-upgrade.md#mismatch
```

This release's components are built for agree = -1. If you declared `+1`
because your deployment reversed its stored signs itself, this release will
not serve that database: that is the point of the declaration. Your votes are
not read inverted and nothing is written. Stay on the release you were running
until a Polis release that serves a +1 database exists, or restore your
database to the original convention.

## A newer database

```
Polis cannot start (server): this database uses vote convention contract 2; this release understands 1. A newer Polis release changed the database. Nothing has been changed. Next: run that newer release, or restore the backup taken before it. Guide: docs/vote-convention-upgrade.md#a-newer-database
```

The row carries a `contract_version` naming the installed surface (tables,
functions, views). Older code refuses a database a newer release changed.

## Inconsistent

`public.vote_convention_current()` returned something other than one row of
integers. The table was changed by hand. Inspect it:

```sql
SELECT * FROM public.vote_convention;
SELECT * FROM public.vote_convention_history ORDER BY version;
```

The row is permanent (`DELETE` and `TRUNCATE` refuse, `P0790`), and a new
state must be exactly the previous version + 1 with the opposite sign
(`P0782`); the history is append-only (`P0781`). Do not serve the database
until the status reads `GUARDED`.

## Replicas

The server checks `DATABASE_URL` and, when it differs, `READ_ONLY_DATABASE_URL`
too; both must declare the same version. The import worker, the pollers and
the job stages check the one database they read (`DATABASE_URL`). A physical
replica replays the migration and the declaration on its own; until it has,
the server refuses to start (start it again when the replica has caught up).

## Restores

A dump taken **before** this release has no `vote_convention` table. Restore
it, apply the migration, declare the sign, then start the components. A dump
taken after the declaration carries the row and restores as declared. See
[vote-convention.md](vote-convention.md#restore-detection) for the query that
classifies a restored copy.

## Reversal

`server/postgres/migrations/down/000025_drop_vote_convention.sql` drops
everything the migration created and touches no vote. It refuses once the
convention has moved past version 0 / agree -1, when a later migration is in
the ledger, or on a partial copy (`P0789`). Stop the new containers first; the
old ones never needed the row.

## For forks

If you maintain a fork, the one change you must take is the vote convention
migration (or its equivalent) **before** you take any code that reads the row,
and then declare your database's sign. If you have reversed your vote signs
yourself, declare `AGREE=+1`: the declaration records that fact, and this
release's components then refuse to run against your database rather than
read it inverted. **This release does not serve a +1 database**; a fork that
declares +1 keeps running the code it runs today until a release built for
that convention exists. If you never take any later optional flip, nothing
changes for you: a database at the original convention is supported
indefinitely. Never copy rows from a vote table into another deployment's
database by hand.

## Not in this release

The optional tool that stores agree as +1 (the "flip"), its rehearsal, the
read-only preflight that shows the evidence a database's own data carries,
and the renamed tables and write fence that protect a flipped database from
old code are later, separate releases. Nothing here applies any of them.
