#!/usr/bin/env bash
# Server Integration Tests / "server-integration-tests": every server jest suite
# (unit + integration, with coverage) against the test stack's Postgres, OIDC
# simulator, DynamoDB, SES and MinIO. The tests themselves run on the host.
# Coverage lands in server/coverage (CI uploads it).
. "$(dirname "$0")/lib.sh"
check_init server-integration
check_use_node 24
"$CHECK_LOCAL/certs.sh"

cd "$CHECK_ROOT"
OIDC="$(check_port 4 3000)"
check_stack_env "$CHECK_STATE/test.env" \
  "AUTH_CERTS_PATH=./.simulacrum/certs" \
  "JWKS_URI=https://localhost:$OIDC/.well-known/jwks.json" \
  "AUTH_ISSUER=https://localhost:$OIDC/" \
  "AUTH_DOMAIN=localhost:$OIDC"
grep -E "AUTH_|CERT|DATABASE_URL|POSTGRES_|JWT_|JWKS_URI" "$CHECK_ENV_FILE" | grep -v '^JWT_PRIVATE_KEY' || true

check_wait_ports $POLIS_TEST_PG_PORT $POLIS_TEST_DYNAMODB_PORT $POLIS_TEST_SES_PORT $POLIS_TEST_MINIO_PORT $POLIS_TEST_OIDC_PORT
check_stack_down_on_exit

check_group "build images"
# Only the services these tests need (the tests run on the host). The math
# engine is excluded: the tests insert math_* rows directly and gate live-math
# assertions behind a hasMathData flag.
check_compose build postgres file-server ses-local oidc-simulator dynamodb
check_endgroup

CHECK_INIT_SERVICES="minio-init" check_up postgres file-server ses-local oidc-simulator dynamodb minio
check_wait_url "https://localhost:$POLIS_TEST_OIDC_PORT/.well-known/jwks.json"
check_wait_port "$POLIS_TEST_DYNAMODB_PORT"
check_wait_port "$POLIS_TEST_SES_PORT"

check_npm server ci
(cd server && node "$CHECK_LOCAL/clock-skew.cjs" "postgres://postgres:PdwPNS2mDN73Vfbc@localhost:$POLIS_TEST_PG_PORT/polis-test") || true

set +e
(
  cd "$CHECK_ROOT/server"
  if [ -f .env ]; then
    check_log "WARNING: server/.env exists; keys it has that test.env lacks reach the tests (CI has none)"
  fi
  # CI copied the edited test.env to server/.env, which the jest setup reads
  # with dotenv (override: false). Exporting the same values is equivalent and
  # leaves any developer server/.env alone.
  check_export_env_file "$CHECK_ENV_FILE"
  export NODE_EXTRA_CA_CERTS="$CHECK_ROOT/.simulacrum/certs/rootCA.pem"
  export NODE_ENV=test
  export DATABASE_URL="postgres://postgres:PdwPNS2mDN73Vfbc@localhost:$POLIS_TEST_PG_PORT/polis-test"
  export STATIC_FILES_HOST=localhost
  export DYNAMODB_ENDPOINT="http://localhost:$POLIS_TEST_DYNAMODB_PORT"
  export SES_ENDPOINT="http://localhost:$POLIS_TEST_SES_PORT"
  export SES_LOCAL_PORT="$POLIS_TEST_SES_PORT"
  export AWS_S3_ENDPOINT="http://localhost:$POLIS_TEST_MINIO_PORT"
  export AWS_S3_BUCKET_NAME=polis-delphi
  export AWS_ACCESS_KEY_ID=DUMMYIDEXAMPLE
  export AWS_SECRET_ACCESS_KEY=DUMMYEXAMPLEKEY
  export AWS_REGION=us-east-1
  npm test -- --ci --coverage --maxWorkers="${CHECK_JEST_WORKERS:-2}"
)
rc=$?
set -e
if [ "$rc" != 0 ]; then check_stack_logs oidc-simulator postgres dynamodb; fi
exit "$rc"
