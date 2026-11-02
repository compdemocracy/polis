#!/bin/sh
set -eu
umask 077
# Only the self-hosted overlay sets this. Never accept a remote database host.
[ "${SELFHOST_BACKUP:-}" = 1 ] && [ "${PGHOST:-}" = postgres ] || {
    echo >&2 'Nightly backups require the local self-hosted postgres service.'
    exit 1
}
run_dump() (
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    dest="/backups/${BACKUP_PROJECT:?}-$stamp.sql.gz"
    test ! -e "$dest"
    raw="$dest.sql.partial"
    zipped="$dest.partial"
    trap 'rm -f "$raw" "$zipped"' EXIT HUP INT TERM
    # Separate commands preserve pg_dumpall's status without relying on pipefail.
    pg_dumpall --lock-wait-timeout=5s > "$raw"
    test -s "$raw"
    grep -q '^CREATE DATABASE ' "$raw"
    gzip -c "$raw" > "$zipped"
    gzip -t "$zipped"
    mv "$zipped" "$dest"
    # Only prune completed dumps belonging to this project, after success.
    ls -1t /backups/"$BACKUP_PROJECT"-*.sql.gz | tail -n +15 | while IFS= read -r old; do rm "$old"; done
    echo "$(date -u +%FT%TZ) backup saved $dest"
)
if [ "${1:-}" = --dump ]; then
    run_dump
    exit
fi
trap 'exit 0' TERM INT
# Run once at startup, then every night at 02:00 UTC. No connection during sleep.
while :; do
    if ! sh "$0" --dump 2>/tmp/backup-error; then
        echo "$(date -u +%FT%TZ) backup FAILED: $(tr '\n' ' ' < /tmp/backup-error)" >&2
    fi
    [ "${BACKUP_ONCE:-0}" = 1 ] && break
    now=$(date -u +%s)
    midnight=$((now - now % 86400))
    next=$((midnight + 7200))
    [ "$next" -gt "$now" ] || next=$((next + 86400))
    sleep "$((next - now))" &
    wait $!
done
