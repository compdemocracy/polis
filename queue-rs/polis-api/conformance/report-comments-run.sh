#!/usr/bin/env bash
# Record the report page's moderation-level calls and compare projected bytes.
# Usage: report-comments-run.sh [result.json], with unique project and P027 ports.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
python3 "$root/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT P027_HTTP_PORT P027_CONTROL_PORT P027_PORT_MIN P027_PORT_MAX
out=${1:-/dev/stdout}
here="$root/server/characterization"
# Dedicated loopback ports must stay below the host ephemeral range.
PYTHONPATH="$root/ci${PYTHONPATH:+:$PYTHONPATH}" python3 - <<'PORTS'
import os, re, socket
from host_ports import port as host_port
assert re.fullmatch(r'p027[a-z0-9_-]+', os.environ['COMPOSE_PROJECT_NAME'])
ports = [host_port(os.environ[k], k) for k in ('POLIS_RECOVERY_PG_PORT', 'P027_HTTP_PORT', 'P027_CONTROL_PORT')]
assert len(set(ports)) == 3
for port in ports:
    for family, host in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.bind((host, port))
PORTS
export P027_POSTGRES_IMAGE=${P027_POSTGRES_IMAGE:-x54pca2-postgres:local}
compose=(docker compose -f "$here/compose.yml" -f "$root/queue-rs/polis-api/conformance/compose.yml" -f "$root/queue-rs/polis-api/conformance/participant-compose.yml" -f "$root/queue-rs/polis-api/conformance/report-comments-compose.yml")
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then
  echo "project $COMPOSE_PROJECT_NAME already has containers" >&2
  exit 1
fi
cleanup() { "${compose[@]}" logs --no-color server polis-api postgres >"${out%.json}-services.log" 2>&1 || true; "${compose[@]}" --profile seed down -v --remove-orphans >/dev/null 2>&1 || true; }
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
"${compose[@]}" exec -T driver node /conformance/report-comments-seed.cjs
"${compose[@]}" exec -T driver node characterization/cli.cjs seed-comments
"${compose[@]}" exec -T driver node /conformance/report-comments-seed.cjs analyze
# Fresh caches on both sides before the first replayed request.
"${compose[@]}" restart server dynamodb
ready
"${compose[@]}" exec -T driver node -e 'fetch("http://server:5001/public-key").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/participant-public.pem",v.publicKey))'
"${compose[@]}" exec -T driver node -e 'fetch("https://oidc-simulator:3000/.well-known/jwks.json").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/read-jwks.json",JSON.stringify(v)))'
"${compose[@]}" up -d --pull never polis-api
for _ in $(seq 60); do
  if "${compose[@]}" exec -T driver node -e 'fetch("http://polis-api:5100/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'; then break; fi
  sleep 1
done
"${compose[@]}" exec -T driver node /conformance/report-comments-replay.cjs >"$out"
