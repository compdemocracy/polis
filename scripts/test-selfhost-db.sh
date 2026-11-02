#!/usr/bin/env bash
# Run on a disposable Docker host, from the repository root. Requires a locally
# built database image (server/Dockerfile-db) and postgres:17-alpine in the cache.
set -Eeuo pipefail
set -x
: "${SELFHOST_TEST_DB_IMAGE:?Set to a local build of server/Dockerfile-db}"
export COMPOSE_PROJECT_NAME="selfhost-check-$(date -u +%s)-$$"
export POSTGRES_VOLUME=custom_data
export POSTGRES_PORT=${SELFHOST_TEST_PORT:-56439}
export POSTGRES_USER=postgres POSTGRES_PASSWORD=selfhost-test-password POSTGRES_DB=polis
fixture=".selfhost-test-$$"
mkdir "$fixture"
cat > "$fixture/env" <<EOF
TAG=dev
POSTGRES_DOCKER=true
LOCAL_SERVICES_DOCKER=false
USE_PRODCLONE=false
COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME
POSTGRES_VOLUME=$POSTGRES_VOLUME
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=$POSTGRES_DB
EOF
cat > "$fixture/Dockerfile" <<EOF
FROM $SELFHOST_TEST_DB_IMAGE
EOF
cat > "$fixture/compose.yml" <<EOF
services:
  postgres:
    image: $COMPOSE_PROJECT_NAME-postgres
    pull_policy: never
    build:
      context: ./$fixture
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    ports: ["127.0.0.1:\${POSTGRES_PORT}:5432"]
    networks: [polis-net]
networks:
  polis-net:
volumes:
  custom_data:
EOF
args="--project-directory $PWD -f $fixture/compose.yml -f docker-compose.self-hosted.yml --profile postgres"
# Add the current migration files to the cached database image at build time.
cp -R server/postgres/migrations "$fixture/migrations"
printf 'COPY migrations /migrations\n' >> "$fixture/Dockerfile"
compose=(docker compose --project-directory "$PWD" -f "$fixture/compose.yml" -f docker-compose.self-hosted.yml --profile postgres)
mk() { make --no-print-directory ENV_FILE="$fixture/env" COMPOSE_FILE_ARGS="$args" "$@"; }
psql_db() { "${compose[@]}" exec -T postgres psql -XAt -U postgres -d polis -v ON_ERROR_STOP=1 "$@"; }
cleanup() {
    local rc=$?
    if [[ $rc != 0 ]]; then "${compose[@]}" logs --tail 100 || true; fi
    "${compose[@]}" down -v --remove-orphans || true
    docker volume rm "${COMPOSE_PROJECT_NAME}-other-data" >/dev/null 2>&1 || true
    docker image rm "$COMPOSE_PROJECT_NAME-postgres" >/dev/null 2>&1 || true
    rm -rf "$fixture"
    exit "$rc"
}
trap cleanup EXIT
# Retain the volume keys/labels used by existing Compose installations.
docker volume create --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --label com.docker.compose.volume=custom_data "${COMPOSE_PROJECT_NAME}_custom_data"
docker volume create --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --label com.docker.compose.volume=postgres "${COMPOSE_PROJECT_NAME}_postgres"
"${compose[@]}" build postgres
"${compose[@]}" up -d --wait postgres db-backup
# Obtain the storage value through the project's convention module; no sign
# literal is introduced in this fixture. This is native storage, not CSV input.
agree=$(python3 - <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location('vote_convention', 'delphi/polismath/utils/vote_convention.py')
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
print(m.storage_vote(m.SEMANTIC_AGREE))
PY
)
psql_db -v agree="$agree" <<'SQL'
INSERT INTO users (uid, email) VALUES (900001, 'backup-fixture@example.invalid'), (900002, 'backup-fixture-two@example.invalid'), (900003, 'backup-fixture-three@example.invalid');
INSERT INTO conversations (zid, owner, topic) VALUES (900001, 900001, 'Backup fixture');
INSERT INTO participants (zid, uid) SELECT 900001, uid FROM users WHERE uid BETWEEN 900001 AND 900003;
INSERT INTO comments (zid, pid, uid, txt) SELECT 900001, pid, 900001, 'Keep this statement' FROM participants WHERE zid=900001 AND uid=900001;
INSERT INTO votes (zid, pid, tid, vote) SELECT c.zid, p.pid, c.tid, :agree FROM comments c JOIN participants p ON p.zid=c.zid WHERE c.zid=900001;
SELECT (SELECT count(*) FROM conversations), (SELECT count(*) FROM votes), (SELECT count(*) FROM comments);
SQL
[[ $(psql_db -c 'SELECT count(*) FROM votes') == 3 ]]
docker volume create --label polis_tag=dev "${COMPOSE_PROJECT_NAME}-other-data"
before=$("${compose[@]}" ps -q postgres)
started=$(docker inspect -f '{{.State.StartedAt}}' "$before")
for target in start-FULL-REBUILD rm-ALL rm-volumes refresh-db; do
    if mk -j8 "$target" > "$fixture/refusal" 2>&1; then cat "$fixture/refusal"; exit 1; fi
    cat "$fixture/refusal"
    grep -F "Volume ${COMPOSE_PROJECT_NAME}_custom_data: conversations=1 votes=3 comments=1" "$fixture/refusal"
    grep -F 'CONFIRM_DATA_LOSS=1' "$fixture/refusal"
    [[ $(docker inspect -f '{{.State.StartedAt}}' "$before") == "$started" ]]
    [[ $(docker inspect -f '{{.State.Running}}/{{.State.Paused}}' "$before") == true/false ]]
done
# A host-side compression failure must leave the data volume intact.
mkdir "$fixture/failbin"
printf '#!/bin/sh\necho "injected gzip failure" >&2\nexit 74\n' > "$fixture/failbin/gzip"
chmod +x "$fixture/failbin/gzip"
if PATH="$PWD/$fixture/failbin:$PATH" mk CONFIRM_DATA_LOSS=1 rm-volumes > "$fixture/dump-failed" 2>&1; then exit 1; fi
cat "$fixture/dump-failed"
grep 'injected gzip failure' "$fixture/dump-failed"
docker volume inspect "${COMPOSE_PROJECT_NAME}_custom_data" >/dev/null
"${compose[@]}" up -d --wait postgres db-backup
[[ $(psql_db -c 'SELECT count(*) FROM votes') == 3 ]]
# Model the MD5 administrator password carried by older PostgreSQL dumps.
psql_db -v password="$POSTGRES_PASSWORD" <<'SQL'
SET password_encryption = 'md5';
ALTER ROLE postgres WITH PASSWORD :'password';
SQL
mk CONFIRM_DATA_LOSS=1 rm-volumes
if docker volume inspect "${COMPOSE_PROJECT_NAME}_custom_data" >/dev/null 2>&1; then
  echo "FAIL: the custom Postgres volume survived the confirmed removal" >&2
  exit 1
fi
docker volume inspect "${COMPOSE_PROJECT_NAME}_backups" >/dev/null
docker volume inspect "${COMPOSE_PROJECT_NAME}-other-data" >/dev/null
dump=$(ls -t backups/"$COMPOSE_PROJECT_NAME"-*.sql.gz | head -1)
gzip -t "$dump"
gzip -dc "$dump" > "$fixture/dump.sql"
grep '^CREATE DATABASE ' "$fixture/dump.sql"
# Fresh stack initializes real schema; restore replaces it only after a fully
# successful import into a scratch cluster, so schema/role conflicts are fatal.
"${compose[@]}" up -d --wait postgres
# Invalid SQL fails in the scratch cluster before changing the empty target.
{ cat "$fixture/dump.sql"; printf '\nSELECT deliberately_missing_function();\n'; } | gzip > "$fixture/bad.sql.gz"
if mk DUMP="$fixture/bad.sql.gz" db-restore > "$fixture/bad-restore" 2>&1; then exit 1; fi
tail -8 "$fixture/bad-restore"
grep 'Restore failed; destination unchanged.' "$fixture/bad-restore"
[[ $(psql_db -c 'SELECT count(*) FROM conversations') == 0 ]]
mk DUMP="$dump" db-restore
"${compose[@]}" up -d --wait postgres db-backup
[[ $(psql_db -c 'SELECT (SELECT count(*) FROM conversations), (SELECT count(*) FROM votes), (SELECT count(*) FROM comments)') == '1|3|1' ]]
[[ $(psql_db -c 'SELECT DISTINCT vote FROM votes') == "$agree" ]]
[[ $(psql_db -c "SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname='postgres'") == t ]]
if mk DUMP="$dump" db-restore > "$fixture/refusal" 2>&1; then exit 1; fi
cat "$fixture/refusal"
grep 'Restore refused:' "$fixture/refusal"
mk db-dump
# Repeated successful nightly runs keep only fourteen; force one failed dump
# and verify it neither publishes a partial file nor prunes good backups.
for ((n=0; n<16; n++)); do
    "${compose[@]}" exec -T -e BACKUP_ONCE=1 db-backup sh /opt/selfhost/db-backup.sh
    sleep 1
done
count=$("${compose[@]}" exec -T db-backup sh -c 'ls /backups/*.sql.gz | wc -l' | tr -d ' ')
[[ $count == 14 ]]
"${compose[@]}" exec -T -e BACKUP_ONCE=1 -e PGPASSWORD=wrong db-backup sh /opt/selfhost/db-backup.sh > "$fixture/failed" 2>&1
cat "$fixture/failed"
grep 'backup FAILED:' "$fixture/failed"
[[ $("${compose[@]}" exec -T db-backup sh -c 'ls /backups/*.sql.gz | wc -l' | tr -d ' ') == 14 ]]
[[ $("${compose[@]}" exec -T db-backup sh -c 'find /backups -name "*.partial" | wc -l' | tr -d ' ') == 0 ]]
[[ $(psql_db -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='selfhost-nightly-backup'") == 0 ]]
mk db-backups
# A concurrent writer must continue during a dump (backup takes ACCESS SHARE,
# which is compatible with ordinary participation writes).
psql_db -c 'CREATE TABLE backup_write_probe (n bigint)'
printf 'INSERT INTO backup_write_probe VALUES (1);\n' | "${compose[@]}" exec -T postgres sh -c 'cat > /tmp/backup-write.sql'
"${compose[@]}" exec -T postgres pgbench -U postgres -d polis -n -c 2 -T 10 -f /tmp/backup-write.sql > "$fixture/writer" 2>&1 &
writer=$!
"${compose[@]}" exec -T -e BACKUP_ONCE=1 db-backup sh /opt/selfhost/db-backup.sh
wait "$writer"
cat "$fixture/writer"
[[ $(psql_db -c 'SELECT count(*) FROM backup_write_probe') -gt 0 ]]
# Empty/uninitialized volumes are removable, and the backup volume survives.
mk CONFIRM_DATA_LOSS=1 rm-ALL
mk rm-volumes
# Exercise the successful full rebuild and refresh recipes as well as refusal.
mk DETACH=true start-FULL-REBUILD
"${compose[@]}" up -d --wait postgres db-backup
psql_db -c "INSERT INTO conversations(topic) VALUES ('Refresh fixture')"
mk DETACH=true CONFIRM_DATA_LOSS=1 refresh-db
"${compose[@]}" up -d --wait postgres db-backup
[[ $(psql_db -c 'SELECT count(*) FROM conversations') == 0 ]]
psql_db -c "INSERT INTO conversations(topic) VALUES ('Rebuild fixture')"
mk DETACH=true CONFIRM_DATA_LOSS=1 start-FULL-REBUILD
"${compose[@]}" up -d --wait postgres db-backup
[[ $(psql_db -c 'SELECT count(*) FROM conversations') == 0 ]]
mk rm-ALL
# Startup must refuse a legacy cluster instead of initializing the new volume.
docker run --rm --network none --mount "type=volume,src=${COMPOSE_PROJECT_NAME}_postgres,dst=/legacy" postgres:17-alpine sh -c 'echo 13 > /legacy/PG_VERSION'
if "${compose[@]}" run --rm --no-deps postgres > "$fixture/legacy" 2>&1; then exit 1; fi
cat "$fixture/legacy"
grep 'Refusing to start: the legacy postgres volume contains a cluster.' "$fixture/legacy"
# The refusal also applies if the new volume was initialized by an older release.
docker run --rm --network none --mount "type=volume,src=${COMPOSE_PROJECT_NAME}_custom_data,dst=/current" postgres:17-alpine sh -c 'echo 17 > /current/PG_VERSION'
if "${compose[@]}" run --rm --no-deps postgres > "$fixture/legacy-existing" 2>&1; then exit 1; fi
cat "$fixture/legacy-existing"
grep 'Refusing to start: the legacy postgres volume contains a cluster.' "$fixture/legacy-existing"
# Production composition has neither the backup service nor the legacy mount.
POSTGRES_VOLUME=postgres_data docker compose -f docker-compose.yml --env-file "$fixture/env" --profile postgres config --services > "$fixture/prod-services"
if grep -Fx db-backup "$fixture/prod-services"; then
  echo "FAIL: the production composition includes the db-backup service" >&2
  exit 1
fi
make -n ENV_FILE="$fixture/env" POSTGRES_VOLUME=postgres_data PROD start > "$fixture/prod-make"
cat "$fixture/prod-make"
if grep -E 'self-hosted|db-backup' "$fixture/prod-make"; then
  echo "FAIL: PROD start references the self-hosted overlay or the backup service" >&2
  exit 1
fi
grep 'docker compose -f docker-compose.yml ' "$fixture/prod-make"
echo 'PASS: refusals, confirmed dump/removal/restore, restore refusal, nightly retention/failure/connections, concurrent writes, legacy refusal, production exclusion'
