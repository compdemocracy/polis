#!/usr/bin/env bash
# Called between each freshly seeded Node recording/replay by the wrapper.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
artifacts="$root/server/characterization/artifacts"
if [[ -f "$artifacts/treevite-rust.pid" ]]; then
  kill "$(cat "$artifacts/treevite-rust.pid")" 2>/dev/null || true
  rm "$artifacts/treevite-rust.pid"
fi
compose=(docker compose -f "$root/server/characterization/compose.yml" -f "$root/server/characterization/treevite/compose.yml")
"${compose[@]}" exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS p027_rust WITH (FORCE)' -c 'CREATE DATABASE p027_rust'
"${compose[@]}" exec -T postgres pg_dump -U postgres -d p027 --schema-only | "${compose[@]}" exec -T postgres psql -U postgres -d p027_rust -v ON_ERROR_STOP=1 >/dev/null
"${compose[@]}" exec -T driver node -e 'fetch("https://oidc-simulator:3000/.well-known/jwks.json").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/treevite-rust-jwks.json",JSON.stringify(v)))'
if [[ ${P027_TREEVITE_HOST_BRIDGE:-0} == 1 ]]; then
  : "${P027_TREEVITE_HOST_PG_PORT:?unique host-adapter database port required}"
  # Docker's internal networks do not publish ports on a VM host. Only this
  # fixed-destination adapter has a second network; no application gains egress.
  docker rm -f "$COMPOSE_PROJECT_NAME-rust-bridge" >/dev/null 2>&1 || true
  docker run -d --pull never --name "$COMPOSE_PROJECT_NAME-rust-bridge" \
    --network bridge -p "127.0.0.1:$P027_TREEVITE_HOST_PG_PORT:5432" \
    -e P027_TREEVITE_RUST_PORT \
    -v "$root/queue-rs/polis-api/conformance/treevite-write-bridge.cjs:/bridge.cjs:ro" \
    "${P027_SERVER_IMAGE:-p027-server}" node /bridge.cjs >/dev/null
  docker network connect --alias treevite-rust-bridge "$COMPOSE_PROJECT_NAME"_sealed "$COMPOSE_PROJECT_NAME-rust-bridge"
fi
export DATABASE_URL="postgres://postgres@127.0.0.1:${P027_TREEVITE_HOST_PG_PORT:-$POLIS_RECOVERY_PG_PORT}/p027_rust?sslmode=disable"
export POLIS_API_TREEVITE_WRITE_DATABASE_URL="$DATABASE_URL" POLIS_API_TREEVITE_WRITE=1
export POLIS_API_LISTEN="0.0.0.0:$P027_TREEVITE_RUST_PORT" POLIS_API_DB_TRANSPORT=loopback
export JWT_PRIVATE_KEY_PATH="$artifacts/treevite-rust-private.pem" JWT_PUBLIC_KEY_PATH="$artifacts/treevite-rust-public.pem"
export POLIS_JWT_ISSUER=https://pol.is/ POLIS_JWT_AUDIENCE=participants
export POLIS_API_READ_JWKS_FILE="$artifacts/treevite-rust-jwks.json" AUTH_ISSUER=https://oidc-simulator:3000/ AUTH_AUDIENCE=users AUTH_NAMESPACE=https://pol.is/
export LOGIN_CODE_PEPPER=generated-treevite-pepper ENCRYPTION_PASSWORD_00001=generated-treevite-fingerprint
export POLIS_API_FIXTURE_CLOCK=1700000000000 NODE_ENV=production DEV_MODE=false MATH_ENV=p027 DOMAIN_OVERRIDE=localhost
"$P027_TREEVITE_RUST_BINARY" >"$artifacts/treevite-rust-service.log" 2>&1 &
echo "$!" > "$artifacts/treevite-rust.pid"
for _ in $(seq 60); do
  if curl -fsS "http://127.0.0.1:$P027_TREEVITE_RUST_PORT/health" >/dev/null; then exit 0; fi
  sleep 1
done
exit 1
