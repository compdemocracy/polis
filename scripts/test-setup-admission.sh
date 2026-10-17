#!/usr/bin/env bash
# The setup admission table: polis-contracts predictions for every entry path,
# action and setting combination against live Node (generated fixtures only).
# Fails on any mismatch, so the typed model cannot drift from the server.
# Uses the images scripts/prepare-polis-cli-differential.sh builds.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLI_DIFF_NODE_IMAGE:?}" "${CLI_DIFF_POSTGRES_IMAGE:?}" "${CLI_DIFF_OIDC_IMAGE:?}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-polis-setup-admission}"
export P027_PORT_MIN="${P027_PORT_MIN:-56211}" P027_PORT_MAX="${P027_PORT_MAX:-56213}"
export POLIS_RECOVERY_PG_PORT="${POLIS_RECOVERY_PG_PORT:-56211}" RECOVERY_PG_PORT="${RECOVERY_PG_PORT:-56211}"
export P027_HTTP_PORT="${P027_HTTP_PORT:-56212}" P027_CONTROL_PORT="${P027_CONTROL_PORT:-56213}"
mkdir -p server/characterization/artifacts
(cd polis-cli && cargo run -q --locked -p polis-contracts --example setup_predictions) \
  > server/characterization/artifacts/setup-predictions.json
compose=(docker compose -f server/characterization/compose.yml -f polis-cli/tests/admission/compose.yml)
trap '"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
"${compose[@]}" up -d --pull never postgres dynamodb oidc-simulator server >/dev/null
ready=0
for _ in $(seq 90); do
  if "${compose[@]}" exec -T server node -e \
    "fetch('http://127.0.0.1:5001/ready').then(r=>r.json()).then(j=>process.exit(j.ready?0:1)).catch(()=>process.exit(1))"; then
    ready=1; break
  fi
  sleep 2
done
[ "$ready" = 1 ] || { echo "setup admission: stack never became ready" >&2; exit 1; }
status=0
summary=$("${compose[@]}" exec -T server node -r ts-node/register/transpile-only \
  characterization/setup-admission.cjs) || status=$?
echo "setup admission: $summary"
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); sys.exit(0 if s.get("cases",0)>0 and s.get("mismatches")==0 else 1)' \
  "$summary" && [ "$status" = 0 ]
