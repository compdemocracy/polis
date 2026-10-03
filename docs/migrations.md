
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

## The migration ledger (`schema_migrations`, from 000023 on)

Migration `000023_vote_convention.sql` adds `public.schema_migrations`: one row
per applied migration file. The rows for 000000–000022 are backfilled with the
checksum `pre-ledger`. **Every migration file from 000023 on inserts its own row
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
migration from 000023 on (including `held/`) and fails on a mismatch, a
missing or duplicate marker, or a row naming another file. CI runs it on every
pull request that touches `server/postgres/` (`.github/workflows/migration-ledger.yml`).
Run it before applying a migration by hand.
