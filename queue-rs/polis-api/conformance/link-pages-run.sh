#!/usr/bin/env bash
# Record conversation link pages and
# compare complete Node/Rust HTTP bytes. Uses only the isolated generated stack.
# Usage: link-pages-run.sh [result.json], with unique project and P027 ports.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${1:-/dev/stdout}
here="$root/server/characterization"
# Require an explicitly named disposable project and three distinct loopback ports.
python3 - <<'CHECK'
import os,re
project=os.environ.get("COMPOSE_PROJECT_NAME", "")
assert re.fullmatch(r"[a-z][a-z0-9_-]{5,63}",project), "unique project required"
ports=[int(os.environ[k]) for k in ["POLIS_RECOVERY_PG_PORT","P027_HTTP_PORT","P027_CONTROL_PORT"]]
assert len(set(ports))==3 and all(55432<=p<=65535 for p in ports)
CHECK
export P027_POSTGRES_IMAGE=${P027_POSTGRES_IMAGE:-x54pca2-postgres:local}
compose=(docker compose -f "$here/compose.yml" -f "$root/queue-rs/polis-api/conformance/compose.yml" -f "$root/queue-rs/polis-api/conformance/link-pages-compose.yml")
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
"${compose[@]}" up -d --pull never postgres dynamodb oidc-simulator server driver
"${compose[@]}" restart server
ready
"${compose[@]}" up -d --pull never polis-api polis-api-off
for service in polis-api polis-api-off; do
  for _ in $(seq 60); do
    if "${compose[@]}" exec -T driver node -e "fetch('http://$service:5100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then break; fi
    sleep 1
  done
done
"${compose[@]}" exec -T driver node /conformance/link-pages-replay.cjs >"$out"
