#!/usr/bin/env bash
# Disposable CI stack only. Use the runner baked into the Postgres image on
# fresh AND existing volumes before starting application services. No host
# Rust/psql installation, second history table or startup-check bypass.
# Optional Compose arguments (e.g. -f local-ports.yml) preserve test isolation.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
compose=(docker compose -f docker-compose.test.yml "$@" --env-file "${POLIS_TEST_ENV_FILE:-test.env}")
"${compose[@]}" up -d --wait --wait-timeout 120 postgres
"${compose[@]}" exec -T postgres sh -eu -c '
  export DATABASE_URL="host=/var/run/postgresql user=$POSTGRES_USER dbname=$POSTGRES_DB sslmode=disable"
  export POLIS_MIGRATIONS_DIR=/migrations
  polis-migrate apply
  polis-migrate check
'
