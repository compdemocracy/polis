#!/usr/bin/env bash
# Collective statement recordings / "replay": the harness's own rules, a replay
# of every recorded collective-statement case against the current routes (the
# model provider replaced by a local stub at the HTTP boundary), and the
# mutation check (each listed mutation fails exactly its named cases).
# Generated fixtures only; the harness refuses any connection outside loopback
# and its two stack services.
. "$(dirname "$0")/lib.sh"
check_init collective-statement
# The recordings were made on this Node; V8's error wording can change between releases.
check_use_node 22.23.1
cd "$CHECK_ROOT"

# The harness refuses any store not on its own ports (safety.cjs: Postgres 5481,
# DynamoDB 8481), so these stay fixed even with CHECK_PORT_BASE: one run per
# host at a time (the run waits for the ports to be free).
PG_PORT=5481
DDB_PORT=8481
PG="$CHECK_PROJECT-postgres"
DDB="$CHECK_PROJECT-dynamodb"
check_wait_ports "$PG_PORT" "$DDB_PORT"
check_on_exit "docker rm -fv $PG $DDB >/dev/null 2>&1 || true"
docker rm -fv "$PG" "$DDB" >/dev/null 2>&1 || true

check_group "start PostgreSQL 17.11 and DynamoDB Local"
docker run -d --name "$PG" --label "com.polis.check=$CHECK_PROJECT" \
  -e POSTGRES_PASSWORD=generatedlocal -p "127.0.0.1:$PG_PORT:5432" \
  --health-cmd "pg_isready -U postgres" --health-interval 2s --health-timeout 2s --health-retries 30 \
  postgres:17.11@sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232
# -sharedDb: without it DynamoDB Local keys its data by access key.
docker run -d --name "$DDB" --label "com.polis.check=$CHECK_PROJECT" -p "127.0.0.1:$DDB_PORT:8000" \
  amazon/dynamodb-local:3.3.1@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab \
  -jar DynamoDBLocal.jar -sharedDb -inMemory
waited=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG")" = healthy ]; do
  [ "$waited" -ge 120 ] && { docker logs "$PG"; check_die "postgres not healthy"; }
  sleep 1; waited=$((waited + 1))
done
check_wait_port "$DDB_PORT"
check_endgroup

# The server modules, and the reset routine's boto3 at delphi's locked versions.
check_npm server ci --no-audit --no-fund
check_venv collective-statement "$CHECK_LOCAL/requirements-collective-statement.txt"

cd server
check_group "the harness's own rules (expected differences, refusal of foreign stores)"
node --test characterization/collective-statement/expected.test.cjs characterization/collective-statement/safety.test.cjs
check_endgroup

export CSREC_PG_ADMIN_URL="postgres://postgres:generatedlocal@127.0.0.1:$PG_PORT/postgres"
export DYNAMODB_ENDPOINT="http://127.0.0.1:$DDB_PORT"
export CSREC_PYTHON="$CHECK_PY"
export TZ=UTC
check_group "replay every recorded case against the current routes"
node characterization/collective-statement/main.cjs replay
check_endgroup
check_group "every listed mutation of the route fails exactly its named cases"
node characterization/collective-statement/mutations.cjs
check_endgroup
