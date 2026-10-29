#!/usr/bin/env bash
# Host-side database maintenance. No SQL is sent through the running stack.
set -Eeuo pipefail
umask 077
action=${1:?expected remove, remove-all, refresh, dump, restore or list}
shift
compose=(docker compose "$@")
fail() { echo "Database safety check: $*" >&2; exit 1; }
work=$(mktemp -d)
helper= snapshot= paused= partial= saved_helper= saved_snapshot= lock=
cleanup() {
    local rc=$?
    trap - EXIT
    if [[ -n $paused ]]; then docker unpause $paused >/dev/null || true; fi
    if [[ -n $helper ]]; then docker rm -f "$helper" >/dev/null 2>&1 || true; fi
    if [[ -n $snapshot ]]; then docker volume rm "$snapshot" >/dev/null 2>&1 || true; fi
    if [[ -n $saved_helper ]]; then docker rm -f "$saved_helper" >/dev/null 2>&1 || true; fi
    if [[ -n $saved_snapshot ]]; then docker volume rm "$saved_snapshot" >/dev/null 2>&1 || true; fi
    if [[ -n $lock ]]; then docker rm "$lock" >/dev/null 2>&1 || true; fi
    [[ -z $partial ]] || rm -f "$partial"
    rm -rf "$work"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Compose handles .env interpolation and project/name precedence. Do not source
# an env file as shell code or infer a project from TAG. Never print credentials.
"${compose[@]}" config --format json > "$work/config.json"
python3 - "$work/config.json" > "$work/config.sh" <<'PY'
import json, shlex, sys
c = json.load(open(sys.argv[1]))
p = c['services'].get('postgres')
if not p:
    sys.exit('No local postgres service in this Compose configuration.')
v = next((v for v in p.get('volumes', []) if v['target'] == '/var/lib/postgresql/data'), None)
if not v or v['type'] != 'volume':
    sys.exit('Database maintenance requires a named PostgreSQL volume.')
volumes = c.get('volumes', {})
selected = volumes[v['source']]
if selected.get('external'):
    sys.exit('Refusing maintenance of an external database volume.')
env = p.get('environment', {})
values = dict(project=c['name'], volume=selected['name'],
              dbuser=env.get('POSTGRES_USER') or 'postgres',
              dbpassword=env.get('POSTGRES_PASSWORD') or '',
              backup_volume=volumes.get('backups', {}).get('name', ''),
              legacy_volume=volumes.get('postgres', {}).get('name', c['name'] + '_postgres'))
for k, v in values.items():
    print(k + '=' + shlex.quote(v))
# Keep backup and legacy clusters, and any unselected postgres/prodclone volume.
with open(sys.argv[1] + '.remove', 'w') as f:
    for key, v in volumes.items():
        if v.get('external') or v['name'] == selected['name'] or key in ('backups', 'postgres', 'postgres_data', 'prodclone_data'):
            continue
        # Only this project's resources; never someone else's explicit name.
        if v['name'].startswith(c['name'] + '_'):
            f.write(v['name'] + '\n')
PY
source "$work/config.sh"
# These commands are intentionally unavailable on production-only composition.
python3 - "$work/config.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
if 'db-backup' not in c['services']:
    sys.exit('Use the self-hosted Compose overlay with the postgres profile; production maintenance is not supported.')
PY
exists() {
    # A daemon failure must never be mistaken for a missing volume.
    docker volume ls --format '{{.Name}}' > "$work/volumes" || fail 'Cannot list Docker volumes.'
    grep -Fxq "$1" "$work/volumes"
}
if [[ $action == list ]]; then
    exists "$backup_volume" || fail "No backups volume exists yet: $backup_volume"
    docker run --rm --network none --mount "type=volume,src=$backup_volume,dst=/backups,readonly" \
        postgres:17-alpine sh -c 'ls -lh /backups/*.sql.gz 2>/dev/null || true'
    exit
fi
# A named container is an atomic Docker-daemon-wide maintenance lock. Do not
# steal a stale lock: inspect the interrupted operation before removing it.
lock_name="${project}-db-maintenance-lock"
lock=$(docker create --name "$lock_name" --network none --tmpfs /var/lib/postgresql/data postgres:17-alpine true) ||
    fail "Another maintenance operation holds $lock_name."
# Refuse operations which would hide the old volume behind a new cluster.
old_version=
if [[ $volume != "$legacy_volume" ]] && exists "$legacy_volume"; then
    old_version=$(docker run --rm --network none --mount "type=volume,src=$legacy_volume,dst=/legacy,readonly" \
        postgres:17-alpine sh -c 'cat /legacy/PG_VERSION 2>/dev/null || true')

fi
reset_helper() {
    if [[ -n $helper ]]; then docker rm -f "$helper" >/dev/null; helper=; fi
    if [[ -n $snapshot ]]; then docker volume rm "$snapshot" >/dev/null; snapshot=; fi
}
start_helper() {
    helper="${project}-db-inspect-$(date -u +%s)-$$"
    docker run -d --name "$helper" --network none --user postgres \
        --mount "type=volume,src=$snapshot,dst=/var/lib/postgresql/data" \
        --entrypoint sh "$pgimage" -c '
            printf "local all all trust\n" > /tmp/inspect-hba
            exec postgres -D /var/lib/postgresql/data -c listen_addresses="" \
                -c unix_socket_directories=/tmp -c hba_file=/tmp/inspect-hba' >/dev/null
    local ready=0
    for ((i=0; i<60; i++)); do
        if docker exec "$helper" pg_isready -h /tmp -U "$dbuser" -d postgres >/dev/null 2>&1; then ready=1; break; fi
        sleep 1
    done
    if [[ $ready != 1 ]]; then docker logs "$helper" >&2; fail "Could not inspect $volume; no volumes removed."; fi
}
inspect_cluster() {
    reset_helper
    conversations=0 votes=0 comments=0 initialized=0
    exists "$volume" || return 0
    local version
    version=$(docker run --rm --network none --mount "type=volume,src=$volume,dst=/source,readonly" \
        postgres:17-alpine sh -c 'if [ -s /source/PG_VERSION ]; then cat /source/PG_VERSION; elif [ -n "$(ls -A /source)" ]; then exit 1; fi')
    [[ -n $version ]] || return 0
    case "$version" in 13|17) pgimage="postgres:$version-alpine";; *) fail "Unsupported PostgreSQL version $version in $volume; no volumes removed.";; esac
    initialized=1
    snapshot="${project}-db-snapshot-$(date -u +%s)-$$"
    docker volume create "$snapshot" >/dev/null
    # Freeze only containers mounting this volume while making a crash-consistent
    # copy. Never launch two postmasters on the source. Resume before querying.
    local cid state
    docker ps -q --filter "volume=$volume" > "$work/containers"
    while IFS= read -r cid; do
        [[ -n $cid ]] || continue
        state=$(docker inspect -f '{{.State.Paused}}' "$cid")
        if [[ $state == false ]]; then
            docker pause "$cid" >/dev/null
            paused="$paused $cid"
        fi
    done < "$work/containers"
    docker run --rm --network none --mount "type=volume,src=$volume,dst=/source,readonly" \
        --mount "type=volume,src=$snapshot,dst=/copy" "$pgimage" \
        sh -ec 'cp -a /source/. /copy/; rm -f /copy/postmaster.pid'
    if [[ -n $paused ]]; then docker unpause $paused >/dev/null; paused=; fi
    start_helper
    # Check every connectable database and every schema, not only POSTGRES_DB.
    docker exec "$helper" psql -XAt -h /tmp -U "$dbuser" -d postgres -v ON_ERROR_STOP=1 \
        -c "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate" > "$work/databases"
    local db table count
    while IFS= read -r db; do
        docker exec -i "$helper" psql -XAt -h /tmp -U "$dbuser" --dbname "$db" -v ON_ERROR_STOP=1 > "$work/counts" <<'SQL'
SELECT format('SELECT %L, count(*) FROM %I.%I;', c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p') AND c.relname IN ('conversations','votes','comments')
\gexec
SQL
        while IFS='|' read -r table count; do
            [[ $count =~ ^[0-9]+$ ]] || fail "Unreadable row counts in $volume."
            case "$table" in
                conversations) conversations=$((conversations + count));;
                votes) votes=$((votes + count));;
                comments) comments=$((comments + count));;
                *) fail "Unexpected row count output.";;
            esac
        done < "$work/counts"
    done < "$work/databases"
    echo "Volume $volume: conversations=$conversations votes=$votes comments=$comments"
}
has_rows() { ((conversations + votes + comments > 0)); }
dump_cluster() {
    [[ $initialized == 1 ]] || fail "No initialized cluster in $volume."
    mkdir -p ./backups
    local dest="./backups/${project}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
    [[ ! -e $dest ]] || fail "Backup already exists: $dest; retry in a second."
    partial="$dest.partial"
    docker exec "$helper" pg_dumpall -h /tmp -U "$dbuser" > "$work/dump.sql"
    test -s "$work/dump.sql" && grep -q '^CREATE DATABASE ' "$work/dump.sql" || fail 'Dump is empty or has no CREATE DATABASE; no volumes removed.'
    gzip -c "$work/dump.sql" > "$partial"
    gzip -t "$partial"
    test -s "$partial" || fail 'Compressed dump is empty.'
    mv "$partial" "$dest"
    partial=
    python3 - "$dest" <<'PYCODE'
import os, sys
with open(sys.argv[1], 'rb') as f:
    os.fsync(f.fileno())
fd = os.open('./backups', os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PYCODE
    echo "Verified backup: $dest"
}
inspect_cluster
if [[ -n $old_version && $action != restore ]] && ! has_rows; then
    fail "Legacy cluster in $legacy_volume (PostgreSQL $old_version) and no current rows. See docs/self-hosting-upgrades.md; preserve it until restore is verified."
fi
case "$action" in
    dump) dump_cluster; exit;;
    restore)
        has_rows && fail "Restore refused: $volume already holds rows. Use a fresh stack."
        [[ -n $dbpassword ]] || fail 'Restore requires POSTGRES_PASSWORD in the destination configuration.'
        [[ -f ${DUMP:-} ]] || fail 'Pass DUMP=path/to/file.sql.gz.'
        gzip -t "$DUMP"
        gzip -dc "$DUMP" > "$work/restore.sql"
        grep -q '^CREATE DATABASE ' "$work/restore.sql" || fail 'Dump has no CREATE DATABASE.'
        # Import into a separate fresh cluster first. A failed import cannot
        # damage the destination, even if that destination only holds schema.
        reset_helper
        snapshot="${project}-db-restore-$(date -u +%s)-$$"
        docker volume create "$snapshot" >/dev/null
        helper="${snapshot}-server"
        docker run -d --name "$helper" --network none \
            --mount "type=volume,src=$snapshot,dst=/var/lib/postgresql/data" \
            -e "POSTGRES_USER=$dbuser" -e POSTGRES_DB=postgres \
            -e "POSTGRES_PASSWORD=$(openssl rand -hex 32)" \
            postgres:17-alpine -c listen_addresses='' >/dev/null
        for ((i=0; i<60; i++)); do
            docker exec "$helper" pg_isready -U "$dbuser" -d postgres >/dev/null 2>&1 && break
            sleep 1
        done
        # initdb's bootstrap role owns system objects and cannot be dropped.
        # Reuse the source administrator; skip exactly its CREATE ROLE statement,
        # retaining its ALTER ROLE (attributes/password) and every other command.
        docker exec -i "$helper" psql -XAt -U "$dbuser" -d postgres -v ON_ERROR_STOP=1 \
            -v owner="$dbuser" > "$work/bootstrap.sql" <<'SQL'
SELECT format('CREATE ROLE %I;', :'owner');
SQL
        python3 - "$work/restore.sql" "$work/bootstrap.sql" "$work/import.sql" <<'PYCODE'
import sys
source, role, target = sys.argv[1:]
statement = open(role).read().strip()
found = 0
with open(source) as src, open(target, 'w') as dst:
    for line in src:
        if line.rstrip('\n') == statement:
            found += 1
        else:
            dst.write(line)
if found != 1:
    sys.exit('Dump must contain exactly one CREATE ROLE for POSTGRES_USER; check source credentials.')
PYCODE
        docker exec -i "$helper" psql -X -U "$dbuser" -d postgres -v ON_ERROR_STOP=1 < "$work/import.sql" > "$work/restore.log" 2>&1 || {
            cat "$work/restore.log" >&2; fail 'Restore failed; destination unchanged.';
        }
        # Old PostgreSQL 13 dumps can carry MD5 password hashes. Re-encode the
        # configured administrator password for PostgreSQL 17's SCRAM host auth;
        # other roles retain their dumped credentials. Keep the secret out of SQL
        # command arguments and stdout.
        docker exec -i -e "PGPASSWORD=$dbpassword" "$helper" \
            psql -X -U "$dbuser" -d postgres -v ON_ERROR_STOP=1 -v owner="$dbuser" >/dev/null <<'SQL'
\getenv desired_password PGPASSWORD
SET password_encryption = 'scram-sha-256';
ALTER ROLE :"owner" WITH PASSWORD :'desired_password';
SQL
        docker stop "$helper" >/dev/null
        # Stop all writers and repeat the target check to close the preflight race.
        saved_snapshot=$snapshot
        saved_helper=$helper
        snapshot= helper=
        "${compose[@]}" stop
        inspect_cluster
        has_rows && fail "Restore refused: $volume acquired rows. Stack remains stopped."
        reset_helper
        snapshot=$saved_snapshot helper=$saved_helper
        saved_snapshot= saved_helper=
        docker ps -q --filter "volume=$volume" > "$work/active"
        [[ ! -s "$work/active" ]] || fail "A container outside the stopped stack still uses $volume."
        docker volume create "$volume" >/dev/null
        docker run --rm --network none --mount "type=volume,src=$snapshot,dst=/source,readonly" \
            --mount "type=volume,src=$volume,dst=/target" postgres:17-alpine \
            sh -ec 'find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +; cp -a /source/. /target/'
        echo "Restored $DUMP into $volume. Stack remains stopped; apply/check migrations before make start."
        exit;;
    remove|remove-all|refresh) ;;
    *) fail "Unknown action: $action";;
esac
if has_rows && [[ ${CONFIRM_DATA_LOSS:-} != 1 ]]; then
    fail "Refusing to remove $volume (conversations=$conversations votes=$votes comments=$comments). Pass CONFIRM_DATA_LOSS=1 to write a verified dump before removal. Nothing removed."
fi
# Stop writers before the final check and dump; new rows must not slip between
# the safety snapshot and deletion. Any failure below leaves the stack stopped.
"${compose[@]}" stop
inspect_cluster
if has_rows && [[ ${CONFIRM_DATA_LOSS:-} != 1 ]]; then
    fail "New rows appeared in $volume. Pass CONFIRM_DATA_LOSS=1; stack remains stopped, nothing removed."
fi
# Even an empty initialized cluster is dumped when explicitly confirmed.
if [[ ${CONFIRM_DATA_LOSS:-} == 1 && $initialized == 1 ]]; then dump_cluster; fi
reset_helper
"${compose[@]}" down --remove-orphans
if exists "$volume"; then docker volume rm "$volume"; fi
if [[ $action != refresh ]]; then
    while IFS= read -r candidate; do
        if exists "$candidate"; then docker volume rm "$candidate"; fi
    done < "$work/config.json.remove"
fi
# Images are shared caches; retaining them cannot lose operator data. The full
# rebuild still uses --no-cache. Never remove unrelated projects by a TAG label.
