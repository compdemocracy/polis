# Self-hosted database backups, upgrades and restore

Use Docker Compose 2.24.4 or newer, Bash, Python 3, gzip and OpenSSL on the host.
Run these commands from the repository root with your usual `.env`. Keep
`COMPOSE_PROJECT_NAME`, `POSTGRES_USER`, `POSTGRES_DB` and `POSTGRES_VOLUME`
consistent across commands. `ENV_FILE=custom.env` selects another configuration.
The current database image is PostgreSQL 17; `POSTGRES_VOLUME` defaults to
`postgres_data` (`prodclone_data` when explicitly using a clone).

## Before an upgrade

1. Keep the old release, configuration, credentials and signing keys available.
2. Stop application writes for the final backup. `make stop` preserves volumes.
3. Save a dump outside Docker and copy it to another machine or protected disk.
4. Use a fresh Compose project to rehearse restoring that file, then check the
   conversation, comment and vote counts before changing the live installation.

```sh
make stop
make db-dump
# Prints: Verified backup: ./backups/<project>-<UTC timestamp>.sql.gz
```

`db-dump` uses `pg_dumpall`, including roles and every database. Files are private
(mode 0600), gzip-tested, nonempty and must contain `CREATE DATABASE`. They include
personal data and password hashes; keep them out of source control. Host dumps
are not automatically pruned. Make a second copy off the Docker host: a Docker
volume alone does not protect against loss of the host or disk.

The helper resolves volume names through Compose, including a custom
`POSTGRES_VOLUME` when its volume key is declared in your Compose configuration.
The existing `postgres_data`, `prodclone_data` and historical `postgres` keys
and volume labels are preserved. For inspection it briefly pauses containers mounting that
volume, copies the data directory into a temporary volume, resumes the containers,
and runs a matching PostgreSQL image on the copy, without networking. Row counts
and manual dumps never query the running stack. Copying needs space for another
cluster and pauses the database for the duration of the copy; use a maintenance
window for a large database. Only self-contained named volumes using PostgreSQL
13 or 17 are supported; external tablespaces, bind-mounted data and remote
clusters need their own backup process. Errors stop the operation.

## Upgrade within PostgreSQL 17

After the backup, install the desired release while retaining the same project
and volume names. Rebuild the database image, start only PostgreSQL, and run the
release's migration runner before starting application services:

```sh
# In the new release directory, with the existing .env and signing keys:
docker compose -f docker-compose.yml -f docker-compose.self-hosted.yml \
  --profile postgres build postgres
docker compose -f docker-compose.yml -f docker-compose.self-hosted.yml \
  --profile postgres up -d --wait postgres
docker compose -f docker-compose.yml -f docker-compose.self-hosted.yml \
  --profile postgres exec postgres sh -ec '
    export DATABASE_URL="host=/var/run/postgresql user=$POSTGRES_USER dbname=$POSTGRES_DB sslmode=disable"
    export POLIS_MIGRATIONS_DIR=/migrations
    polis-migrate apply
    polis-migrate check'
make DETACH=true start
```

An existing database without modern migration history requires catalog review
and explicit adoption first. Follow [the migration upgrade paths](migration-upgrade-notes.md)
and [the runner commands](migrations.md#one-time-adoption-of-an-existing-database);
do not initialize schema over a restored database or manufacture migration
receipts. Keep application services stopped if any migration check refuses.

## Restore into a fresh stack

Use a different `COMPOSE_PROJECT_NAME` in a new configuration, with the same
`POSTGRES_USER` and `POSTGRES_DB` as the source. Other roles retain the passwords
in the dump; the configured administrator
uses `POSTGRES_PASSWORD` from the destination configuration. Keep application
credentials consistent with that configuration. Keep the old installation
stopped when restoring its final backup. A database volume may be absent or may
contain fresh initialized schema, but it must have **no rows in any table named
`conversations`, `votes` or `comments`, in any database/schema**.

```sh
# restore.env is a copy of your configuration with a new COMPOSE_PROJECT_NAME.
make ENV_FILE=restore.env db-restore DUMP=./backups/<project>-<timestamp>.sql.gz
```

Restore first imports into a temporary PostgreSQL 17 cluster with error checking.
It then stops the destination stack, repeats the emptiness check, and installs
the imported cluster into the selected volume. An import failure leaves the
original destination untouched. The source administrator is reused: only its
duplicate `CREATE ROLE` is skipped;
its attributes and all other roles come from the dump. The configured administrator
password is then set from the destination environment using SCRAM, so old
PostgreSQL 13 MD5 hashes do not prevent connections to PostgreSQL 17. Reset any
other login roles with old MD5 hashes before using them over the network. This
replaces an empty destination's schema and
configuration. Do not run another maintenance command or independently start
writers while it runs. After installation the stack stays stopped. Start only
PostgreSQL and apply/check migrations using the commands above (add
`--env-file restore.env` to each Compose command), verify counts, then start the
application with `make ENV_FILE=restore.env DETACH=true start`.

```sh
docker compose --env-file restore.env -f docker-compose.yml \
  -f docker-compose.self-hosted.yml --profile postgres exec postgres sh -ec '
    psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
      SELECT (SELECT count(*) FROM conversations) AS conversations,
             (SELECT count(*) FROM votes) AS votes,
             (SELECT count(*) FROM comments) AS comments;"'
```

Only restore trusted dumps: SQL dumps can execute SQL and client commands. A
rollback across a PostgreSQL major version also uses a tested logical dump and
a fresh compatible cluster, never the newer data directory with the older image.

## The PostgreSQL 13 to 17 change

On **2025-10-10**, the image changed from PostgreSQL 13 to 17 and the Compose data
volume changed from `postgres` to `postgres_data`. An installation created before
that change can have its database in `<project>_postgres`. Starting the newer
release without a restore can otherwise appear to lose the data by initializing
a different, empty volume. The self-hosted startup hook refuses startup
whenever that legacy volume contains `PG_VERSION`, even if an earlier start has
already initialized the newly named volume. This is conservative: even an empty
legacy cluster must be reviewed. The hook does not delete or upgrade it. Restore
into a new project as described below, preserving the old project as a fallback.

Never start PostgreSQL 17 on a PostgreSQL 13 data directory. Dump with
`postgres:13-alpine` and restore the SQL into PostgreSQL 17. The following is a
Bash recipe; set the project and database administrator to their old values.
Stop the old stack from its original release directory first. Do not run the
old database and the dump container on the same volume at the same time.

```bash
set -euo pipefail
umask 077
PROJECT=polis-dev                  # the OLD COMPOSE_PROJECT_NAME
DB_USER=postgres                   # the OLD POSTGRES_USER
OLD_VOLUME="${PROJECT}_postgres"
DUMP="./backups/${PROJECT}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

# From the old release directory and its configuration:
docker compose -p "$PROJECT" stop
# Must print no running containers before continuing:
test -z "$(docker ps -q --filter "volume=$OLD_VOLUME")"
docker volume inspect "$OLD_VOLUME" >/dev/null
mkdir -p ./backups

# Socket-only temporary server; no published port or network connectivity.
docker run -d --name "${PROJECT}-legacy-dump" --network none --user postgres \
  --mount "type=volume,src=$OLD_VOLUME,dst=/var/lib/postgresql/data" \
  --entrypoint sh postgres:13-alpine -ec '
    printf "local all all trust\n" > /tmp/dump-hba
    exec postgres -D /var/lib/postgresql/data -c listen_addresses="" \
      -c unix_socket_directories=/tmp -c hba_file=/tmp/dump-hba'
trap 'docker stop "${PROJECT}-legacy-dump" >/dev/null; docker rm "${PROJECT}-legacy-dump" >/dev/null' EXIT
for i in {1..60}; do
  docker exec "${PROJECT}-legacy-dump" pg_isready -h /tmp -U "$DB_USER" -d postgres && break
  sleep 1
done
docker exec "${PROJECT}-legacy-dump" pg_dumpall -h /tmp -U "$DB_USER" > "$DUMP.sql.partial"
test -s "$DUMP.sql.partial"
grep -q '^CREATE DATABASE ' "$DUMP.sql.partial"
gzip -c "$DUMP.sql.partial" > "$DUMP.partial"
gzip -t "$DUMP.partial"
mv "$DUMP.partial" "$DUMP"
rm "$DUMP.sql.partial"
printf 'Verified backup: %s\n' "$DUMP"
docker stop "${PROJECT}-legacy-dump"
docker rm "${PROJECT}-legacy-dump"
trap - EXIT
```

Copy that file to the current release directory and use `make db-restore DUMP=...`
with the old `POSTGRES_USER`/`POSTGRES_DB` and a **new project name** in its env file.
Then follow the migration adoption/check and count-verification steps above. The
old volume remains intact as a fallback; do not remove it until the restored
installation and an independent backup have been verified. Merely changing
`POSTGRES_VOLUME=postgres` does not perform an upgrade.

## Rebuild and removal safeguards

`make start-FULL-REBUILD`, `make rm-ALL`, `make rm-volumes` and `make refresh-db`
first inspect the selected database volume. Any conversation, vote or comment
causes refusal with the volume name, all three counts and the override flag:

```sh
make CONFIRM_DATA_LOSS=1 refresh-db
```

With that explicit flag, the target stops writers, inspects again, writes and
verifies `./backups/<project>-<UTC timestamp>.sql.gz`, prints the path, and only
then removes the selected volume. If any check or dump fails, no volume is
removed; the stack may remain stopped. Without the flag, a populated database
refuses before the stack is stopped. An empty cluster needs no flag. The scope is
the selected Compose project, not every installation sharing `TAG=dev`. Backup
and legacy volumes survive these Make targets. Images are retained as shared
caches; the full rebuild still rebuilds with `--no-cache`.

Raw `docker volume rm`, `docker compose down -v` and Docker pruning bypass these
Make safeguards and can also remove nightly backups. Use `make stop` for a normal
shutdown and `make start-rebuild` to rebuild without resetting data.

## Nightly dumps

The default `make start` includes `docker-compose.self-hosted.yml`. Its `db-backup`
service uses `postgres:17-alpine`, matching the current database major version.
It dumps once after database startup, then at **02:00 UTC nightly**, keeping the
last **14 successful files** for the project in the `backups` volume. That volume
is also mounted at `/backups` on the database container. Each run logs one success
or failure line. A failed dump publishes no file and prunes nothing. It connects
only to the local Compose `postgres` service, holds connections only during
`pg_dumpall`, and sleeps without a database connection. The dump's read locks
permit ordinary conversation, vote and comment writes; lock acquisition waits
are capped at five seconds.

```sh
make db-backups
# Copy a listed nightly dump outside Docker before a restore or host migration:
docker compose -f docker-compose.yml -f docker-compose.self-hosted.yml \
  --profile postgres cp db-backup:/backups/<filename>.sql.gz ./backups/<filename>.sql.gz
```

For direct Compose use, include the overlay explicitly:

```sh
docker compose -f docker-compose.yml -f docker-compose.self-hosted.yml \
  --profile postgres up -d
```

`make PROD` uses only `docker-compose.yml` with `prod.env`: it does **not** include
the self-hosted overlay, the legacy mount or `db-backup`. Production deployment
configuration is unchanged. Self-hosting maintenance commands refuse a composition
without the local backup service. `POSTGRES_DOCKER=false` also excludes the
`postgres` profile and its backup service. Remote databases need their own
backup policy.

## Rehearsal

On a disposable Docker host, build the database image and run the shell check.
It uses a unique project name, a loopback-only port and real application schema.
Choose another unused port if necessary. It leaves verified host dumps in
`./backups` and removes only its own test containers and volumes.

```sh
docker build --build-context queue-rs=queue-rs -f server/Dockerfile-db \
  -t selfhost-test-db:local server
SELFHOST_TEST_DB_IMAGE=selfhost-test-db:local SELFHOST_TEST_PORT=56439 \
  bash scripts/test-selfhost-db.sh
```
