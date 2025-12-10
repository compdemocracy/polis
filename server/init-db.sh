#!/bin/bash
set -e

DUMP_FILE="/docker-entrypoint-initdb.d/prodclone.dump"

if [ ! -f "$DUMP_FILE" ]; then
    echo "ERROR: USE_PRODCLONE is enabled but $DUMP_FILE not found!"
    echo "Please ensure prodclone.dump exists in the project root directory."
    exit 1
fi

echo "Restoring database from dump..."
pg_restore -j4 --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$DUMP_FILE"

echo "Resetting user sequences to match restored data..."
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT setval('users_uid_seq', (SELECT COALESCE(MAX(uid), 1) FROM users));"