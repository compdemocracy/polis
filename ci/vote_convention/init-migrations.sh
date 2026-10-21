#!/usr/bin/env bash
set -eu
# Keep the gate's historical full inventory, including held files. Only the
# marked index files need the deployment runner's autocommit and verification.
export DATABASE_URL="host=/var/run/postgresql user=$POSTGRES_USER dbname=$POSTGRES_DB sslmode=disable"
for file in /migrations/*.sql; do
  if awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*--/ {
      line=$0
      sub(/^[[:space:]]*/, "", line)
      sub(/[[:space:]]*$/, "", line)
      if (line == "-- polis-migrate: concurrent-indexes") marked=1
      next
    }
    { exit }
    END { exit !marked }
  ' "$file"; then
    polis-migrate prepare-indexes --file "$file"
  else
    psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$file"
  fi
done
