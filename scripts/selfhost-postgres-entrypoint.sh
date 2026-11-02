#!/bin/sh
set -eu
# An old volume must not silently disappear behind a newly named empty cluster.
if [ -s /legacy-postgres/PG_VERSION ]; then
    echo >&2 'Refusing to start: the legacy postgres volume contains a cluster.'
    echo >&2 'Dump it with its matching PostgreSQL image and restore into a new project; see docs/self-hosting-upgrades.md.'
    exit 1
fi
[ "$#" -gt 0 ] || set -- postgres
exec /usr/local/bin/docker-entrypoint.sh "$@"
