#!/usr/bin/env bash
# Delphi result reads on PostgreSQL versus DynamoDB Local, with the same data.
# The local and hosted CI entry point. Generated data only; no credentials.
#
#   RESULT_READS_PROJECT=<unique name> RESULT_READS_PG_PORT=<free port> \
#   RESULT_READS_DYNAMO_PORT=<free port> scripts/test-delphi-result-reads.sh [jest args]
#
# Starts one PostgreSQL 17 and one DynamoDB Local container, applies the
# release migrations with polis-migrate, runs the parity, snapshot and
# concurrency suites, and removes both containers.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$PWD
: "${RESULT_READS_PROJECT:?set a unique project name}"
: "${RESULT_READS_PG_PORT:?set an unused local port}"
: "${RESULT_READS_DYNAMO_PORT:?set an unused local port}"
pg="${RESULT_READS_PROJECT}-postgres"
dynamo="${RESULT_READS_PROJECT}-dynamo"
for name in "$pg" "$dynamo"; do
  if docker inspect "$name" >/dev/null 2>&1; then echo "container $name exists; choose a new project" >&2; exit 2; fi
done
cleanup() {
  if [[ "${RESULT_READS_KEEP:-0}" != 1 ]]; then docker rm -f -v "$pg" "$dynamo" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
docker run -d --name "$pg" -e POSTGRES_HOST_AUTH_METHOD=trust -p "127.0.0.1:$RESULT_READS_PG_PORT:5432" \
  postgres:17-alpine -c max_connections=200 >/dev/null
docker run -d --name "$dynamo" -p "127.0.0.1:$RESULT_READS_DYNAMO_PORT:8000" \
  amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -sharedDb -inMemory >/dev/null
for _ in $(seq 60); do docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$pg" psql -X -q -U postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE result_reads'
(cd queue-rs && cargo build --locked -q -p polis-migrate)
export DATABASE_URL="postgresql://postgres@127.0.0.1:$RESULT_READS_PG_PORT/result_reads?sslmode=disable"
POLIS_MIGRATIONS_DIR="$repo/server/postgres/migrations" queue-rs/target/debug/polis-migrate apply
POLIS_MIGRATIONS_DIR="$repo/server/postgres/migrations" queue-rs/target/debug/polis-migrate check
cd server
[[ -d node_modules ]] || npm ci --no-audit --no-fund
export DYNAMODB_ENDPOINT="http://127.0.0.1:$RESULT_READS_DYNAMO_PORT"
export AWS_REGION=us-east-1 DATABASE_SSL=false NODE_ENV=test
npx jest --config __tests__/delphi-results-pg/jest.config.json --runInBand "$@"
