
# Database Migrations

When we need to update the Polis database, we use SQL migration files.

During initial provisioning of your Docker containers, all the migrations will be applied in order, and you won't need to think about this.
But if we update the database schema after your initial provisioning of your server via Docker, you'll need to manually apply each new SQL migration.

- Please note: **Backups are your responsibility.** These instructions assume
  the data is disposable, and do not attempt to make backups.
  - Pull requests are welcome if you'd like to see more guidance on this.
  - Please submit an issue if you'd like to work on enabling backups through Docker Compose.
- Your database data is stored on a docker volume, which means that it will
  persist even when you destroy all your docker containers. Be mindful of this.
  - You can remove ALL volumes defined within a `docker-compose` file via: `docker compose --profile postgres down --volumes`
  - You can remove ONE volume via `docker volume ls` and `docker volume rm <name>`
- SQL migrations can be found in [`server/postgres/migrations/`][] of this
  repo.
- The path to the SQL file will be relative to its location in the docker
  container filesystem, not your host system.

For example, if we add the migration file
`server/postgres/migrations/000001_update_pwreset_table.sql`, you'd run on your
host system:

```sh
docker compose --profile postgres exec postgres psql --username postgres --dbname polis-dev --file=/docker-entrypoint-initdb.d/000001_update_pwreset_table.sql
```

You can also run a local .sql file on a postgres container instance with this syntax:

```sh
docker exec -i polis-dev-postgres-1 psql -U postgres -d polis-dev < server/postgres/migrations/000006_update_votes_rule.sql
```

where `polis-dev-postgres-1` is the name of the running container (see the output of `docker ps`), `postgres` is the db username and `polis-dev` is the database.

You'd do this for each new file, in numeric order.

   [`server/postgres/migrations/`]: /server/postgres/migrations

## The migration ledger (`schema_migrations`, from 000025 on)

Migration `000025_vote_convention.sql` adds `public.schema_migrations`: one row
per applied migration file. The rows for 000000–000022 are backfilled with the
checksum `pre-ledger`. **Every migration file from 000025 on inserts its own row
as its last statement**, carrying the sha256 of the file with exactly one line
removed: the line holding the `-- ledger-self-checksum` marker (the INSERT
itself, so the hash can live inside the file it hashes):

```sh
grep -v -e '-- ledger-self-checksum' server/postgres/migrations/0000NN_name.sql | shasum -a 256
```

A copy whose ledger stops early is older than the files it is missing. See
[vote-convention.md](vote-convention.md) for the restore-detection rule that
depends on it.

`server/postgres/check_ledger_checksums.py` recomputes this checksum for every
migration from 000025 on (including `held/`) and fails on a mismatch, a
missing or duplicate marker, or a row naming another file. CI runs it on every
pull request that touches `server/postgres/` (`.github/workflows/migration-ledger.yml`).
Run it before applying a migration by hand.

## Operations are not migrations (`server/postgres/operations/`)

An *operation* is a SQL file an operator runs on purpose, once, through its
own `make` target; the migration runner and the Docker initialisation never
apply it. The first is `vote_convention_declare.sql`
(`make vote-convention-declare AGREE=-1`), which declares the stored vote
sign of a database that already held votes when migration 000025 ran. See
[vote-convention-upgrade.md](vote-convention-upgrade.md). An operation records
itself in `public.vote_convention_history` (not in `schema_migrations`), with
its own ledger checksum computed by the same rule; the checker above verifies
operation files too.

## Migration 000025 and existing databases

000025 writes the `vote_convention` row only when the database holds no
votes. On an existing database it prints `DECLARE_NEEDED`, and every
component of the release that reads the row refuses to start until you run
`make vote-convention-declare AGREE=-1`. Old containers keep working
meanwhile. The guide: [vote-convention-upgrade.md](vote-convention-upgrade.md).
