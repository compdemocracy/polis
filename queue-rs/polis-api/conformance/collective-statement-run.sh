#!/usr/bin/env bash
# Record collective statements validation responses and
# compare complete Node/Rust HTTP bytes. Uses only the isolated generated stack.
# Usage: collective-statement-run.sh [result.json], with unique project and P027 ports.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${1:-/dev/stdout}
here="$root/server/characterization"
(cd "$here" && python3 -c 'import os, isolation; isolation.isolated_environment(os.environ)')
export P027_POSTGRES_IMAGE=${P027_POSTGRES_IMAGE:-x54pca2-postgres:local}
compose=(docker compose -f "$here/compose.yml" -f "$root/queue-rs/polis-api/conformance/compose.yml" -f "$root/queue-rs/polis-api/conformance/participant-compose.yml" -f "$root/queue-rs/polis-api/conformance/collective-statement-compose.yml")
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
"${compose[@]}" exec -T driver node -e 'fetch("https://oidc-simulator:3000/.well-known/jwks.json").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/read-jwks.json",JSON.stringify(v)))'
"${compose[@]}" up -d --pull never polis-api
for _ in $(seq 60); do
  if "${compose[@]}" exec -T driver node -e 'fetch("http://polis-api:5100/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'; then break; fi
  sleep 1
done
"${compose[@]}" exec -T driver node /conformance/treevite-me-replay.cjs >"${out%.json}-treevite-me-regression.json"
"${compose[@]}" exec -T driver node /conformance/treevite-my-invites-replay.cjs >"${out%.json}-treevite-my-invites-regression.json"
"${compose[@]}" exec -T driver node /conformance/legacy-conversations-replay.cjs >"${out%.json}-legacy-conversations-regression.json"
"${compose[@]}" exec -T driver node /conformance/topic-prioritize-replay.cjs >"${out%.json}-topic-prioritize-regression.json"
"${compose[@]}" exec -T driver node /conformance/topic-selections-replay.cjs >"${out%.json}-topic-selections-regression.json"
"${compose[@]}" exec -T driver node /conformance/conversation-stats-replay.cjs >"${out%.json}-conversation-stats-regression.json"
"${compose[@]}" exec -T driver node /conformance/bid-to-pid-replay.cjs >"${out%.json}-bid-to-pid-regression.json"
"${compose[@]}" exec -T driver node /conformance/reports-read-replay.cjs >"${out%.json}-reports-read-regression.json"
"${compose[@]}" exec -T driver node /conformance/all-conversations-replay.cjs >"${out%.json}-all-conversations-regression.json"
"${compose[@]}" exec -T driver node /conformance/participation-read-replay.cjs >"${out%.json}-participation-read-regression.json"
"${compose[@]}" exec -T driver node /conformance/conversation-preload-replay.cjs >"${out%.json}-conversation-preload-regression.json"
"${compose[@]}" exec -T driver node /conformance/treevite-csv-replay.cjs >"${out%.json}-treevite-csv-regression.json"
"${compose[@]}" exec -T driver node /conformance/treevite-invites-replay.cjs >"${out%.json}-treevite-invites-regression.json"
"${compose[@]}" exec -T driver node /conformance/treevite-waves-replay.cjs >"${out%.json}-treevite-waves-regression.json"
"${compose[@]}" exec -T driver node /conformance/legacy-pca-replay.cjs >"${out%.json}-legacy-pca-regression.json"
"${compose[@]}" exec -T driver node /conformance/recent-activity-replay.cjs >"${out%.json}-recent-activity-regression.json"
"${compose[@]}" exec -T driver node /conformance/recent-started-replay.cjs >"${out%.json}-recent-started-regression.json"
"${compose[@]}" exec -T driver node /conformance/metadata-choices-replay.cjs >"${out%.json}-metadata-choices-regression.json"
"${compose[@]}" exec -T driver node /conformance/metadata-read-replay.cjs >"${out%.json}-metadata-read-regression.json"

"${compose[@]}" exec -T driver node /conformance/database-replay.cjs >"${out%.json}-database-regression.json"
"${compose[@]}" exec -T driver node /conformance/about-replay.cjs >"${out%.json}-about-regression.json"

"${compose[@]}" exec -T driver node /conformance/contexts-replay.cjs >"${out%.json}-contexts-regression.json"
"${compose[@]}" exec -T driver node /conformance/domain-whitelist-replay.cjs >"${out%.json}-domain-whitelist-regression.json"

"${compose[@]}" exec -T driver node /conformance/metadata-questions-replay.cjs >"${out%.json}-metadata-questions-regression.json"

"${compose[@]}" exec -T driver node /conformance/metadata-answers-replay.cjs >"${out%.json}-metadata-answers-regression.json"

# This cross-route matrix follows the existing route-specific proofs on a fresh
# API process so their per-route counter expectations remain independent.
"${compose[@]}" restart polis-api
for _ in $(seq 60); do
  if "${compose[@]}" exec -T driver node -e 'fetch("http://polis-api:5100/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'; then break; fi
  sleep 1
done
"${compose[@]}" exec -T driver node /conformance/cid-boundaries-replay.cjs >"${out%.json}-cid-boundaries-regression.json"
"${compose[@]}" exec -T driver node /conformance/xid-report-replay.cjs >"${out%.json}-xid-report-regression.json"
"${compose[@]}" exec -T driver node /conformance/einvites-read-replay.cjs >"${out%.json}-einvites-read-regression.json"
"${compose[@]}" exec -T driver node /conformance/create-page-replay.cjs >"${out%.json}-create-page-regression.json"
"${compose[@]}" exec -T driver node /conformance/user-create-page-replay.cjs >"${out%.json}-user-create-page-regression.json"
"${compose[@]}" exec -T driver node /conformance/user-login-page-replay.cjs >"${out%.json}-user-login-page-regression.json"
"${compose[@]}" exec -T driver node /conformance/settings-page-replay.cjs >"${out%.json}-settings-page-regression.json"
"${compose[@]}" exec -T driver node /conformance/user-logout-page-replay.cjs >"${out%.json}-user-logout-page-regression.json"
"${compose[@]}" exec -T driver node /conformance/admin-page-replay.cjs >"${out%.json}-admin-page-regression.json"
"${compose[@]}" exec -T driver node /conformance/integrate-page-replay.cjs >"${out%.json}-integrate-page-regression.json"
"${compose[@]}" exec -T driver node /conformance/other-conversations-page-replay.cjs >"${out%.json}-other-conversations-page-regression.json"
"${compose[@]}" exec -T driver node /conformance/delphi-read-replay.cjs >"${out%.json}-delphi-read-regression.json"
"${compose[@]}" exec -T driver node /conformance/delphi-reports-replay.cjs >"${out%.json}-delphi-reports-regression.json"
"${compose[@]}" exec -T driver node /conformance/delphi-visualizations-replay.cjs >"${out%.json}-delphi-visualizations-regression.json"
"${compose[@]}" exec -T driver node /conformance/topic-stats-replay.cjs >"${out%.json}-topic-stats-regression.json"
"${compose[@]}" exec -T driver node /conformance/collective-statement-replay.cjs >"$out"
