#!/usr/bin/env bash
# Record Node and compare complete connection-probe HTTP responses on the sealed
# generated-fixture stack. Uses the base conformance images and an explicit
# COMPOSE_PROJECT_NAME plus isolated P027 ports; always removes its own stack.
# Usage: queue-rs/polis-api/conformance/connection-run.sh [result.json]
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${1:-/dev/stdout}
here="$root/server/characterization"
(cd "$here" && python3 -c 'import os, isolation; isolation.isolated_environment(os.environ)')
export P027_POSTGRES_IMAGE=${P027_POSTGRES_IMAGE:-x54pca2-postgres:local}
compose=(docker compose -f "$here/compose.yml" -f "$root/queue-rs/polis-api/conformance/compose.yml" -f "$root/queue-rs/polis-api/conformance/connection-compose.yml")
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then
  echo "project $COMPOSE_PROJECT_NAME already has containers" >&2
  exit 1
fi
cleanup() { "${compose[@]}" --profile seed down -v --remove-orphans >/dev/null 2>&1 || true; }
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
"${compose[@]}" up -d --pull never
"${compose[@]}" restart server
ready
# Fresh caches on both sides before the first replayed request.
"${compose[@]}" restart server dynamodb polis-api
ready
status=0
"${compose[@]}" exec -T driver node /conformance/connection-replay.cjs >"$out" || status=$?
exit $status
