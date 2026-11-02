#!/usr/bin/env bash
# Byte-for-byte replay of every recorded participant request against the Node server
# and polis-api, side by side on one sealed, generated-fixture stack.
#
#   COMPOSE_PROJECT_NAME=p027x54pca2-$(openssl rand -hex 3) \
#   P027_PORT_MIN=55479 P027_PORT_MAX=55481 POLIS_RECOVERY_PG_PORT=55479 \
#   P027_HTTP_PORT=55480 P027_CONTROL_PORT=55481 \
#   queue-rs/polis-api/conformance/participant-run.sh [result.json]
#
# Needs the local images the characterization harness uses (p027-server,
# p027-file-server, p027-oidc-simulator, p011-delphi-test), a Postgres image
# built from server/Dockerfile-db (P027_POSTGRES_IMAGE, default
# x54pca2-postgres:local) and the conformance polis-api image:
#   docker build --build-arg FEATURES=fixture-clock \
#     -t x54pca2-polis-api:conformance -f queue-rs/polis-api/Dockerfile .
# The project and ports must pass server/characterization/isolation.py. The
# stack is always removed on exit, volumes included.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${1:-/dev/stdout}
here="$root/server/characterization"
(cd "$here" && python3 -c 'import os, isolation; isolation.isolated_environment(os.environ)')
export P027_POSTGRES_IMAGE=${P027_POSTGRES_IMAGE:-x54pca2-postgres:local}
compose=(docker compose -f "$here/compose.yml" -f "$root/queue-rs/polis-api/conformance/compose.yml" -f "$root/queue-rs/polis-api/conformance/participant-compose.yml")
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
"${compose[@]}" run --rm --no-deps math-seed
"${compose[@]}" exec -T driver node characterization/cli.cjs seed-comments
# Fresh caches on both sides before the first replayed request.
"${compose[@]}" restart server dynamodb
ready
"${compose[@]}" exec -T driver node -e 'fetch("http://server:5001/public-key").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/participant-public.pem",v.publicKey))'
"${compose[@]}" up -d --pull never polis-api
for _ in $(seq 60); do
  if "${compose[@]}" exec -T driver node -e 'fetch("http://polis-api:5100/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'; then break; fi
  sleep 1
done
"${compose[@]}" exec -T driver node /conformance/participant-replay.cjs >"$out"
