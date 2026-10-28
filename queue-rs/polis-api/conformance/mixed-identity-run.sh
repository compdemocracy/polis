#!/usr/bin/env bash
# Disposable local stack. Small by default; MIXED_FULL=1 offers 200 callers,
# three rounds per case. No automatic retry of a failed campaign.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
: "${COMPOSE_PROJECT_NAME:?unique project required}"
: "${MIXED_PG_PORT:?}" "${MIXED_DYNAMO_PORT:?}" "${MIXED_NODE_PORT:?}"
: "${MIXED_API_PORT:?}" "${POLIS_MIXED_WORKER_PORT:?}" "${MIXED_PROVIDER_PORT:?}"
export MIXED_ARTIFACTS=${MIXED_ARTIFACTS:-"$root/mixed-identity-artifacts"}
if [[ -d "$MIXED_ARTIFACTS" && -n $(ls -A "$MIXED_ARTIFACTS") ]]; then
  echo 'Choose an empty artifact directory; previous evidence is never overwritten'; exit 2
fi
mkdir -p "$MIXED_ARTIFACTS"
compose=(docker compose -p "$COMPOSE_PROJECT_NAME" -f "$root/queue-rs/polis-api/conformance/mixed-identity-compose.yml")
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then
  echo 'Project already exists; refusing to reuse it'; exit 2
fi
pids=()
cleanup() {
  if (( ${#pids[@]} )); then
    for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  fi
  wait || true
  "${compose[@]}" down -v --remove-orphans
  rm -rf "$MIXED_ARTIFACTS/bin"
  rm -f "$MIXED_ARTIFACTS/private.pem" "$MIXED_ARTIFACTS/provider-private.pem"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ulimit -n 8192
"${compose[@]}" up -d --pull never
for _ in $(seq 60); do "${compose[@]}" exec -T postgres pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
for db in mixed guard_control; do "${compose[@]}" exec -T postgres createdb -U postgres "$db"; done
export DATABASE_URL="postgresql://postgres@127.0.0.1:$MIXED_PG_PORT/mixed?sslmode=disable&application_name=mixed-node"
export MIXED_GUARD_DATABASE_URL="postgresql://postgres@127.0.0.1:$MIXED_PG_PORT/guard_control?sslmode=disable"
export CARGO_NET_OFFLINE=${CARGO_NET_OFFLINE:-false}
(cd "$root/queue-rs" && cargo build --locked -p polis-api -p polis-migrate)
bin=${CARGO_TARGET_DIR:-"$root/queue-rs/target"}/debug
mkdir "$MIXED_ARTIFACTS/bin"
cp "$bin/polis-api" "$MIXED_ARTIFACTS/bin/polis-api"
DATABASE_URL="$DATABASE_URL" "$bin/polis-migrate" apply --dir "$root/server/postgres/migrations"
DATABASE_URL="$MIXED_GUARD_DATABASE_URL" "$bin/polis-migrate" apply --dir "$root/server/postgres/migrations"
export JWT_PRIVATE_KEY_PATH="$MIXED_ARTIFACTS/private.pem" JWT_PUBLIC_KEY_PATH="$MIXED_ARTIFACTS/public.pem"
export POLIS_MIXED_JWKS="$MIXED_ARTIFACTS/jwks.json"
export POLIS_JWT_ISSUER=https://pol.is/ POLIS_JWT_AUDIENCE=participants
export AUTH_ISSUER="http://127.0.0.1:$MIXED_PROVIDER_PORT/" AUTH_AUDIENCE=users AUTH_NAMESPACE=https://pol.is/
export JWKS_URI="${AUTH_ISSUER}.well-known/jwks.json"
export DYNAMODB_ENDPOINT="http://127.0.0.1:$MIXED_DYNAMO_PORT" DATABASE_SSL=false NODE_ENV=test TESTING=true DEV_MODE=false MATH_ENV=mixed
export AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=generated AWS_SECRET_ACCESS_KEY=generated AWS_EC2_METADATA_DISABLED=true
export DOMAIN_OVERRIDE=localhost SERVICE_URL="http://127.0.0.1:$MIXED_NODE_PORT" STATIC_FILES_HOST=127.0.0.1 STATIC_FILES_PORT=9
export LOGIN_CODE_PEPPER=generated-mixed-pepper ENCRYPTION_PASSWORD_00001=generated-mixed-fingerprint SERVER_LOG_LEVEL=error
export TS_NODE_PROJECT="$root/server/tsconfig.json"
node "$root/queue-rs/polis-api/conformance/mixed-identity-driver.cjs" prepare
(cd "$root/server" && exec node ../queue-rs/polis-api/conformance/mixed-identity-driver.cjs provider) >"$MIXED_ARTIFACTS/provider.log" 2>&1 & pids+=("$!")
(cd "$root/server" && exec node ../queue-rs/polis-api/conformance/mixed-identity-node.cjs) >"$MIXED_ARTIFACTS/node.log" 2>&1 & pids+=("$!")
# This worker calls the actual staged library. No product route is added.
worker=$(cd "$root/queue-rs" && cargo test --locked -p polis-auth --features db-tests --test mixed_writer --no-run --message-format=json | python3 -c 'import json,sys; print(next(x["executable"] for line in sys.stdin if (x:=json.loads(line)).get("executable")))')
cp "$worker" "$MIXED_ARTIFACTS/bin/admission-worker"
("$MIXED_ARTIFACTS/bin/admission-worker" --nocapture) >"$MIXED_ARTIFACTS/rust.log" 2>&1 & pids+=("$!")
POLIS_API_LISTEN="127.0.0.1:$MIXED_API_PORT" POLIS_API_DB_TRANSPORT=loopback POLIS_API_PARTICIPANT_READS=1 POLIS_API_VOTES_READS=1 POLIS_API_VOTES_READ_DATABASE_URL="$DATABASE_URL" "$MIXED_ARTIFACTS/bin/polis-api" >"$MIXED_ARTIFACTS/api.log" 2>&1 & pids+=("$!")
(cd "$root/server" && exec node ../queue-rs/polis-api/conformance/mixed-identity-driver.cjs run)
