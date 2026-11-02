#!/usr/bin/env bash
# Identity recording and two fresh replays on the sealed participant topology.
set -euo pipefail
mode=${1:-verify}
if [[ "$mode" != verify && "$mode" != --update ]]; then
  echo "usage: $0 [--update]" >&2; exit 2
fi
root=$(cd "$(dirname "$0")/../../.." && pwd)
here="$root/server/characterization"
(cd "$here" && python3 -c 'import os, isolation; isolation.isolated_environment(os.environ)')
export P027_SOURCE_COMMIT=${P027_SOURCE_COMMIT:-$(git -C "$root" rev-parse HEAD)}
compose=(docker compose -f "$here/compose.yml" -f "$here/identity/compose.yml")
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then
  echo "project already has containers" >&2; exit 1
fi
mkdir -p "$here/artifacts"
cleanup() {
  rm -f "$here/artifacts/identity-provider-tokens.json"
  "${compose[@]}" logs --no-color server >"$here/artifacts/identity-services.log" 2>&1 || true
  "${compose[@]}" --profile seed down -t 1 -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ready() {
  for _ in $(seq 60); do
    if "${compose[@]}" exec -T driver node -e 'fetch("http://server:5001/ready",{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo "Node readiness deadline" >&2; exit 1
}
"${compose[@]}" up -d --pull never postgres dynamodb file-server oidc-simulator server driver
"${compose[@]}" restart -t 1 server
ready
python3 "$here/identity/provenance.py"
runs=(record replay-one replay-two)
if [[ "$mode" == --update ]]; then runs=(update); fi
for run in "${runs[@]}"; do
  "${compose[@]}" exec -T driver node characterization/cli.cjs seed
  "${compose[@]}" restart -t 1 server dynamodb
  ready
  "${compose[@]}" exec -T oidc-simulator node <"$here/identity/provider-tokens.cjs" >"$here/artifacts/identity-provider-tokens.json"
  "${compose[@]}" exec -T driver node characterization/votes/install-tokens.cjs <"$here/artifacts/identity-provider-tokens.json"
  args=("/artifacts/identity-$run")
  if [[ "$mode" == --update ]]; then args+=(--update); fi
  "${compose[@]}" exec -T -e P027_SOURCE_COMMIT="$P027_SOURCE_COMMIT" driver node characterization/identity/run.cjs "${args[@]}"
done
if [[ "$mode" == --update ]]; then
  cp "$here/artifacts/identity-update/fixture.json" "$root/server/__tests__/fixtures/identity/recordings.json"
  echo "Updated identity fixture; review the diff, then run verification."
  exit 0
fi
# The live Jest test starts its own Node process in the driver namespace.
"${compose[@]}" stop -t 1 server
"${compose[@]}" restart -t 1 dynamodb
# Use the default setup/teardown; explicitly include the live file outside __tests__.
"${compose[@]}" exec -T -e P027_SOURCE_COMMIT="$P027_SOURCE_COMMIT" driver npx jest --runInBand --runTestsByPath __tests__/unit/identity-recordings.test.ts __tests__/unit/participant-jwt-interop.test.ts characterization/identity/live.test.ts --testMatch '**/__tests__/**/*.test.ts' '**/characterization/identity/live.test.ts' --coverage=false
