#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 22.23.4
check_python
export CHECK_DYNAMODB_NAME="${CHECK_DYNAMODB_NAME:-csrec-dynamodb}"
if docker inspect "$CHECK_DYNAMODB_NAME" >/dev/null 2>&1; then echo "Dynamo container already exists" >&2; exit 2; fi
cleanup() {
  local result=$?
  trap - EXIT
  set +e
  (
    cd "$CHECK_ROOT/."
    docker rm -f "$CHECK_DYNAMODB_NAME"
  )
  [ "$?" = 0 ] || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(
  cd "$CHECK_ROOT/."
  if [ -n "${CHECK_DYNAMODB_NETWORK:-}" ]; then
  docker run -d --name "$CHECK_DYNAMODB_NAME" --network "$CHECK_DYNAMODB_NETWORK" amazon/dynamodb-local:3.3.1@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab -jar DynamoDBLocal.jar -sharedDb -inMemory -port 8481
  else
  docker run -d --name "$CHECK_DYNAMODB_NAME" -p 127.0.0.1:8481:8000 amazon/dynamodb-local:3.3.1@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab -jar DynamoDBLocal.jar -sharedDb -inMemory
  fi
)

(
  cd "$CHECK_ROOT/."
  npm ci --ignore-scripts --prefix server --no-audit --no-fund
  python -m pip install --quiet certifi==2026.10.19 boto3==1.34.70 botocore==1.34.162 s3transfer==0.10.4
)

(
  cd "$CHECK_ROOT/server"
  export CSREC_PG_ADMIN_URL="${CSREC_PG_ADMIN_URL:-postgres://postgres:generatedlocal@127.0.0.1:5481/postgres}"
  node --test characterization/collective-statement/expected.test.cjs characterization/collective-statement/safety.test.cjs characterization/collective-statement/schema.test.cjs
)

(
  cd "$CHECK_ROOT/server"
  export CSREC_PG_ADMIN_URL="${CSREC_PG_ADMIN_URL:-postgres://postgres:generatedlocal@127.0.0.1:5481/postgres}"
  export DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://127.0.0.1:8481}"
  export CSREC_PYTHON="${CSREC_PYTHON:-python}"
  export TZ=UTC
  node characterization/collective-statement/main.cjs replay
)

(
  cd "$CHECK_ROOT/server"
  export CSREC_PG_ADMIN_URL="${CSREC_PG_ADMIN_URL:-postgres://postgres:generatedlocal@127.0.0.1:5481/postgres}"
  export DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://127.0.0.1:8481}"
  export CSREC_PYTHON="${CSREC_PYTHON:-python}"
  export TZ=UTC
  node characterization/collective-statement/mutations.cjs
)
