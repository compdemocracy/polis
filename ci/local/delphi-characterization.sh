#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 22.23.4
check_python
export CHECK_DYNAMODB_NAME="${CHECK_DYNAMODB_NAME:-p2zero-dynamodb}"
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
  docker run -d --name "$CHECK_DYNAMODB_NAME" --network "$CHECK_DYNAMODB_NETWORK" amazon/dynamodb-local:3.3.1@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab -jar DynamoDBLocal.jar -sharedDb -inMemory -port 8472
  else
  docker run -d --name "$CHECK_DYNAMODB_NAME" -p 127.0.0.1:8472:8000 amazon/dynamodb-local:3.3.1@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab -jar DynamoDBLocal.jar -sharedDb -inMemory
  fi
)

(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts --no-audit --no-fund
)

(
  cd "$CHECK_ROOT/delphi"
  python -m pip install --quiet pyyaml
  python -m unittest tests.test_delphi_storage_codec -v
  python -m unittest tests.test_delphi_postgres_results -v
  python -m unittest tests.test_delphi_result_resource -v
)

(
  cd "$CHECK_ROOT/server"
  npx jest --config characterization/delphi/jest.codec.config.json
)

(
  cd "$CHECK_ROOT/."
  python3 server/characterization/delphi/generate.py --check
)

(
  cd "$CHECK_ROOT/server"
  export P2ZERO_PG_ADMIN_URL="${P2ZERO_PG_ADMIN_URL:-postgres://postgres:generatedlocal@127.0.0.1:5472/postgres}"
  export DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://127.0.0.1:8472}"
  export TZ=UTC
  node characterization/delphi/main.cjs replay
)

(
  cd "$CHECK_ROOT/server"
  export P2ZERO_PG_ADMIN_URL="${P2ZERO_PG_ADMIN_URL:-postgres://postgres:generatedlocal@127.0.0.1:5472/postgres}"
  export DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://127.0.0.1:8472}"
  export DELPHI_RESULT_BACKEND=postgres
  export TZ=UTC
  node characterization/delphi/main.cjs replay
)
