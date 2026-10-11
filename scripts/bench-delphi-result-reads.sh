#!/usr/bin/env bash
# Read cost of Delphi results on PostgreSQL at production size: seeds the same
# generated dataset (server/bench/delphi-result-reads/seed.sql) into one
# database migrated by this release and, optionally, one migrated by a previous
# release's checkout, then prints EXPLAIN ANALYZE for each reader's SQL and the
# per-request time of each reader through the server adapter.
#
#   RESULT_READS_PROJECT=<unique> RESULT_READS_PG_PORT=<free port> \
#   [RESULT_READS_BEFORE=<checkout of the previous release>] scripts/bench-delphi-result-reads.sh
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$PWD
: "${RESULT_READS_PROJECT:?set a unique project name}"
: "${RESULT_READS_PG_PORT:?set an unused local port}"
out=${RESULT_READS_OUT:-${TMPDIR:-/tmp}/$RESULT_READS_PROJECT}
mkdir -p "$out"
pg="${RESULT_READS_PROJECT}-bench-postgres"
if docker inspect "$pg" >/dev/null 2>&1; then echo "container $pg exists; choose a new project" >&2; exit 2; fi
cleanup() { if [[ "${RESULT_READS_KEEP:-0}" != 1 ]]; then docker rm -f -v "$pg" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
docker run -d --name "$pg" -e POSTGRES_HOST_AUTH_METHOD=trust -p "127.0.0.1:$RESULT_READS_PG_PORT:5432" --shm-size=1g \
  postgres:17-alpine -c shared_buffers=1GB -c work_mem=16MB -c max_connections=200 >/dev/null
for _ in $(seq 60); do docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
(cd queue-rs && cargo build --locked -q -p polis-migrate)
psql_in() { docker exec -i "$pg" psql -X -q -U postgres -d "$1" "${@:2}"; }
prepare() { # database, checkout
  docker exec "$pg" psql -X -q -U postgres -c "CREATE DATABASE $1"
  DATABASE_URL="postgresql://postgres@127.0.0.1:$RESULT_READS_PG_PORT/$1?sslmode=disable" \
    POLIS_MIGRATIONS_DIR="$2/server/postgres/migrations" queue-rs/target/debug/polis-migrate apply > "$out/$1-migrate.log"
  psql_in "$1" < server/bench/delphi-result-reads/seed.sql | tee "$out/$1-seed.txt"
}
timing() { # database, checkout
  (cd "$2/server" && DATABASE_URL="postgresql://postgres@127.0.0.1:$RESULT_READS_PG_PORT/$1?sslmode=disable" \
    DELPHI_RESULT_BACKEND=postgres DELPHI_RESULT_ENV=bench DELPHI_RESULT_SCOPE=delphi DATABASE_SSL=false \
    npx ts-node --transpile-only "$repo/server/bench/delphi-result-reads/timing.ts") > "$out/$1-timing.jsonl"
  cat "$out/$1-timing.jsonl"
}
prepare bench_after "$repo"
for zid in 100001 100100; do
  psql_in bench_after -v zid=$zid < server/bench/delphi-result-reads/explain-after.sql > "$out/explain-after-$zid.txt" 2>&1
done
timing bench_after "$repo"
if [[ -n "${RESULT_READS_BEFORE:-}" ]]; then
  prepare bench_before "$RESULT_READS_BEFORE"
  for zid in 100001 100100; do
    psql_in bench_before -v zid=$zid < server/bench/delphi-result-reads/explain-before.sql > "$out/explain-before-$zid.txt" 2>&1
  done
  timing bench_before "$RESULT_READS_BEFORE"
fi
echo "results in $out"
