#!/usr/bin/env bash
# Node-only Treevite recording and two freshly seeded replays.
set -euo pipefail
mode=${1:-verify}
if [[ "$mode" != verify && "$mode" != --update ]]; then echo "usage: $0 [--update]" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../../.." && pwd)
here="$root/server/characterization"
(cd "$here" && python3 -c 'import os, isolation; isolation.isolated_environment(os.environ)')
export P027_SOURCE_COMMIT=${P027_SOURCE_COMMIT:-$(git -C "$root" rev-parse HEAD)}
compose=(docker compose -f "$here/compose.yml" -f "$here/treevite/compose.yml")
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then echo "project already has containers" >&2; exit 1; fi
mkdir -p "$here/artifacts"
cleanup() {
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
python3 "$here/treevite/provenance.py"
runs=(record replay-one replay-two)
if [[ "$mode" == --update ]]; then runs=(update); fi
for run in "${runs[@]}"; do
  echo "Treevite $run"
  "${compose[@]}" exec -T driver node characterization/cli.cjs seed
  "${compose[@]}" restart -t 1 server dynamodb
  ready
  args=("/artifacts/treevite-$run")
  if [[ "$mode" == --update ]]; then args+=(--update); fi
  "${compose[@]}" exec -T -e P027_SOURCE_COMMIT="$P027_SOURCE_COMMIT" driver node characterization/treevite/run.cjs "${args[@]}"
done
if [[ "$mode" == --update ]]; then
  cp "$here/artifacts/treevite-update/fixture.json" "$here/treevite/recordings.json"
  echo "Updated Treevite fixture; review the diff, then run verification."
else
  "${compose[@]}" exec -T driver node --test characterization/treevite/compare.test.cjs
  echo "Treevite record and both replays match the committed fixture."
fi
