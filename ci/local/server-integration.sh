#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 22.23.4
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free PostgreSQL port}"
: "${RUNNER_TEMP:?choose an owned temporary directory}"
export POLIS_TEST_IMAGE_TAG="${POLIS_TEST_IMAGE_TAG:-ci}"
# Published ports must stay outside the host's ephemeral allocation range.
# On macOS, IPv6 sockets can receive ports already held by IPv4 forwarders.
python3 - <<'PORTS'
import json
import os
import re
import subprocess
import sys


def check_port(label, value):
    text = str(value)
    if not re.fullmatch(r"[0-9]+(?:-[0-9]+)?", text):
        sys.exit(f"{label}: choose a published port from 1 through 49151")
    bounds = [int(part) for part in text.split("-")]
    if min(bounds) < 1 or max(bounds) >= 49152 or bounds[0] > bounds[-1]:
        sys.exit(
            f"{label}: published port {text} must be from 1 through 49151. "
            "macOS allocates ephemeral ports from 49152 through 65535; "
            "IPv6 test sockets can take a port held by an IPv4 container "
            "forwarder, misdirecting PostgreSQL connections or hanging them."
        )


check_port("POLIS_RECOVERY_PG_PORT", os.environ["POLIS_RECOVERY_PG_PORT"])
config = subprocess.run(
    ["docker", "compose", "-f", "docker-compose.test.yml", "--env-file", "test.env",
     "config", "--format", "json"],
    check=True, capture_output=True, text=True,
)
for name, service in json.loads(config.stdout)["services"].items():
    for port in service.get("ports", []):
        check_port(f"{name} published port", port.get("published", 0))
PORTS
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
