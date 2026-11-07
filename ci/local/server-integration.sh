#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT
python3 "$CHECK_ROOT/ci/host_ports.py" env DATABASE_URL
check_node 22.23.4
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free PostgreSQL port}"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT
: "${RUNNER_TEMP:?choose an owned temporary directory}"
export POLIS_TEST_IMAGE_TAG="${POLIS_TEST_IMAGE_TAG:-ci}"
# Validate resolved publications too, including fixed ports and ranges.
docker compose -f docker-compose.test.yml --env-file test.env config --format json | \
  python3 "$CHECK_ROOT/ci/host_ports.py" compose
check_project "$COMPOSE_PROJECT_NAME"
mkdir -p .simulacrum/certs
(cd .simulacrum/certs && mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1 oidc-simulator host.docker.internal)
cp "$(mkcert -CAROOT)/rootCA.pem" .simulacrum/certs/rootCA.pem
python3 - <<'ENV'
from pathlib import Path
import os,re
p=Path('test.env');s=p.read_text()
for key,value in {'AUTH_CERTS_PATH':'./.simulacrum/certs','JWKS_URI':'https://localhost:3000/.well-known/jwks.json'}.items():
    s=re.sub(r'^'+key+r'=.*$',key+'='+value,s,flags=re.M)
p.write_text(s)
Path('.env').write_text(s)
Path('server/.env').write_text(s)
ENV

cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if [ "$result" != 0 ]; then docker compose -f docker-compose.test.yml logs --tail 100 oidc-simulator postgres dynamodb; fi
  (
    cd "$CHECK_ROOT/."
    docker compose -f docker-compose.test.yml down -v
  )
  [ "$?" = 0 ] || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(
  cd "$CHECK_ROOT/."
  # Build only the services these tests need (tests run on host); ses-local
  # and dynamodb are pulled, not built.
  # The math engine (math-python) is intentionally excluded: the server
  # integration tests insert math_* rows directly and gate all live-math
  # assertions behind a hasMathData flag, so they pass with or without it.
  bash ci/local/test-images.sh build --tag "$POLIS_TEST_IMAGE_TAG" --only postgres,file-server,oidc-simulator
  bash ci/local/test-images.sh override "$POLIS_TEST_IMAGE_TAG" "$RUNNER_TEMP/images.yml" postgres file-server oidc-simulator
)

(
  cd "$CHECK_ROOT/."
  bash ci/test-migrations.sh -f "$RUNNER_TEMP/images.yml"
)

(
  cd "$CHECK_ROOT/."
  # Start only required services in detached mode (exclude server + math-python).
  # They come up while the server dependencies install; the health step waits for them.
  docker compose -f docker-compose.test.yml -f "$RUNNER_TEMP/images.yml" --env-file test.env up -d \
    postgres file-server ses-local oidc-simulator dynamodb minio minio-init
)

(
  cd "$CHECK_ROOT/."
  cd server
  npm ci --ignore-scripts
)

(
  cd "$CHECK_ROOT/."
  # Wait (up to 120 s) until postgres, the OIDC simulator, DynamoDB and MinIO answer.
  for i in $(seq 1 60); do
    docker compose -f docker-compose.test.yml exec -T postgres pg_isready -U postgres >/dev/null 2>&1 \
      && curl -ksf -o /dev/null https://localhost:3000/.well-known/jwks.json \
      && curl -s -o /dev/null http://localhost:8000 \
      && curl -s -o /dev/null http://localhost:9000 \
      && break
    sleep 2
  done
  docker compose -f docker-compose.test.yml ps

  # Check if key services are responding
  echo "Checking postgres..."
  docker compose -f docker-compose.test.yml exec -T postgres pg_isready -U postgres || true

  echo "Checking oidc-simulator..."
  curl -k -f https://localhost:3000/.well-known/jwks.json || true

  echo "Checking DynamoDB..."
  curl -f http://localhost:8000 || true
)

(
  cd "$CHECK_ROOT/."
  # Fails when a committed generated file (server, client-participation-alpha,
  # client-report) differs from what server/src/contracts would generate.
  # Fix with `npm run contract:generate` in server/ and commit the result.
  cd server
  npm run contract:check
)

(
  cd "$CHECK_ROOT/server"
  python3 "$CHECK_ROOT/ci/host_ports.py" env DATABASE_URL
  export DATABASE_URL="${DATABASE_URL:-postgres://postgres:PdwPNS2mDN73Vfbc@127.0.0.1:${POLIS_RECOVERY_PG_PORT}/polis-test}"
  export DATABASE_SSL="${DATABASE_SSL:-false}"
  node src/db/migrations.cjs
)

(
  cd "$CHECK_ROOT/."
  cd server

  NODE_EXTRA_CA_CERTS=$(pwd)/../.simulacrum/certs/rootCA.pem \
  CI=true \
  NODE_ENV=test \
  DATABASE_URL=postgres://postgres:PdwPNS2mDN73Vfbc@127.0.0.1:${POLIS_RECOVERY_PG_PORT}/polis-test \
  STATIC_FILES_HOST=localhost \
  DYNAMODB_ENDPOINT=http://localhost:8000 \
  SES_ENDPOINT=http://localhost:8005 \
  AWS_S3_ENDPOINT=http://localhost:9000 \
  AWS_S3_BUCKET_NAME=polis-delphi \
  AWS_ACCESS_KEY_ID=DUMMYIDEXAMPLE \
  AWS_SECRET_ACCESS_KEY=DUMMYEXAMPLEKEY \
  AWS_REGION=us-east-1 \
  npm test -- --ci --coverage --maxWorkers=2
)
