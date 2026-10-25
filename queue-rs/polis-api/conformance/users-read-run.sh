#!/usr/bin/env bash
# Record user profile responses and
# compare complete Node/Rust HTTP bytes. Uses only the isolated generated stack.
# Usage: users-read-run.sh [result.json], with unique project and P027 ports.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${1:-/dev/stdout}
here="$root/server/characterization"
(cd "$here" && python3 -c 'import os, isolation; isolation.isolated_environment(os.environ)')
export P027_POSTGRES_IMAGE=${P027_POSTGRES_IMAGE:-x54pca2-postgres:local}
compose=(docker compose -f "$here/compose.yml" -f "$root/queue-rs/polis-api/conformance/compose.yml" -f "$root/queue-rs/polis-api/conformance/participant-compose.yml" -f "$root/queue-rs/polis-api/conformance/users-read-compose.yml")
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then
  echo "project $COMPOSE_PROJECT_NAME already has containers" >&2
  exit 1
fi
cleanup() { "${compose[@]}" logs --no-color server polis-api >"${out%.json}-services.log" 2>&1 || true; "${compose[@]}" --profile seed down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
ready() {
  for _ in $(seq 60); do
    if "${compose[@]}" exec -T server node -e "fetch('http://localhost:5001/ready',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Node readiness deadline" >&2
  return 1
}
"${compose[@]}" up -d --pull never postgres dynamodb file-server oidc-simulator server driver
"${compose[@]}" restart server
ready
"${compose[@]}" exec -T driver node characterization/cli.cjs seed
"${compose[@]}" exec -T driver node /conformance/users-read-seed.cjs
"${compose[@]}" exec -T driver node characterization/cli.cjs seed-comments
# Fresh caches on both sides before the first replayed request.
"${compose[@]}" restart server dynamodb
ready
"${compose[@]}" exec -T driver node -e 'fetch("http://server:5001/public-key").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/participant-public.pem",v.publicKey))'
"${compose[@]}" exec -T driver node -e 'fetch("https://oidc-simulator:3000/.well-known/jwks.json").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/read-jwks.json",JSON.stringify(v)))'
"${compose[@]}" -f "$root/queue-rs/polis-api/conformance/users-read-off-compose.yml" up -d --pull never polis-api
for _ in $(seq 60); do
  if "${compose[@]}" exec -T driver node -e 'fetch("http://polis-api:5100/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'; then break; fi
  sleep 1
done
"${compose[@]}" exec -T -e USERS_READ_EXPECT_OFF=1 driver node /conformance/users-read-replay.cjs >"${out%.json}-off.json"
"${compose[@]}" up -d --pull never polis-api
for _ in $(seq 60); do
  if "${compose[@]}" exec -T driver node -e 'fetch("http://polis-api:5100/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'; then break; fi
  sleep 1
done
"${compose[@]}" exec -T driver node /conformance/users-read-replay.cjs >"$out"
