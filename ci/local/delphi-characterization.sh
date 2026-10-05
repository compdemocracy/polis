#!/usr/bin/env bash
# Delphi characterization / "replay": the frozen Delphi storage codec in both
# languages, the generated fixtures regenerating byte for byte, and a replay of
# every recorded Delphi read-route case against the current server routes.
# Generated fixtures only; no cloud credentials, no provider calls.
. "$(dirname "$0")/lib.sh"
check_init delphi-characterization
check_use_node 22
check_use_python 3.12
cd "$CHECK_ROOT"

PG_PORT="$(check_port 11 5472)"
DDB_PORT="$(check_port 12 8472)"
PG="$CHECK_PROJECT-postgres"
DDB="$CHECK_PROJECT-dynamodb"
check_wait_ports "$PG_PORT" "$DDB_PORT"
check_on_exit "docker rm -fv $PG $DDB >/dev/null 2>&1 || true"
docker rm -fv "$PG" "$DDB" >/dev/null 2>&1 || true

check_group "start PostgreSQL 17.11 and DynamoDB Local"
docker run -d --name "$PG" --label "com.polis.check=$CHECK_PROJECT" \
  -e POSTGRES_PASSWORD=generatedlocal -p "127.0.0.1:$PG_PORT:5432" \
  --health-cmd "pg_isready -U postgres" --health-interval 2s --health-timeout 2s --health-retries 30 \
  postgres:17.11
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

check_npm server ci --no-audit --no-fund
check_venv delphi-characterization "$CHECK_LOCAL/requirements-pyyaml.txt"

check_group "codec golden test (Python writes, reads the file Node wrote)"
(cd delphi && "$CHECK_PY" -m unittest tests.test_delphi_storage_codec -v)
check_endgroup

check_group "codec golden test (Node reads the files Python wrote, writes the cross file)"
(cd server && npx jest --config characterization/delphi/jest.codec.config.json)
check_endgroup

check_group "fixtures regenerate byte for byte"
"$CHECK_PY" server/characterization/delphi/generate.py --check
check_endgroup

check_group "replay every recorded case against the current routes"
(cd server && P2ZERO_PG_ADMIN_URL="postgres://postgres:generatedlocal@127.0.0.1:$PG_PORT/postgres" \
  DYNAMODB_ENDPOINT="http://127.0.0.1:$DDB_PORT" TZ=UTC node characterization/delphi/main.cjs replay)
check_endgroup
