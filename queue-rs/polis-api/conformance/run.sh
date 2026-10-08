#!/usr/bin/env bash
# Byte-for-byte replay of every recorded pca2 request against the Node server
# and polis-api, side by side on one sealed, generated-fixture stack.
#
#   COMPOSE_PROJECT_NAME=p027x54pca2-$(openssl rand -hex 3) \
#   P027_PORT_MIN=55479 P027_PORT_MAX=55481 POLIS_RECOVERY_PG_PORT=55479 \
#   P027_HTTP_PORT=55480 P027_CONTROL_PORT=55481 \
#   queue-rs/polis-api/conformance/run.sh [result.json]
#
# Needs the local images the characterization harness uses (p027-server,
# p027-file-server, p027-oidc-simulator, p011-delphi-test), a Postgres image
# built from server/Dockerfile-db (P027_POSTGRES_IMAGE, default
# x54pca2-postgres:local) and the conformance polis-api image:
#   docker build --build-arg FEATURES=fixture-clock \
#     -t x54pca2-polis-api:conformance -f queue-rs/polis-api/Dockerfile queue-rs
# The project and ports must pass server/characterization/isolation.py. The
# stack is always removed on exit, volumes included.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${1:-/dev/stdout}
here="$root/server/characterization"
(cd "$here" && python3 -c 'import os, isolation; isolation.isolated_environment(os.environ)')
export P027_POSTGRES_IMAGE=${P027_POSTGRES_IMAGE:-x54pca2-postgres:local}
compose=(docker compose -f "$here/compose.yml" -f "$root/queue-rs/polis-api/conformance/compose.yml")
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
"${compose[@]}" exec -T driver node characterization/cli.cjs seed
"${compose[@]}" run --rm --no-deps math-seed
# Fresh caches on both sides before the first replayed request.
"${compose[@]}" restart server dynamodb polis-api
ready
"${compose[@]}" exec -T driver node characterization/cli.cjs seed-pages
status=0
"${compose[@]}" exec -T driver node /conformance/replay.cjs >"$out" || status=$?
exit $status
