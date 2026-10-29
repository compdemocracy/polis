#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
here="$root/server/characterization"
(cd "$here" && python3 -c 'import os,isolation; isolation.isolated_environment(os.environ)')
compose=(docker compose -f "$here/compose.yml" -f "$here/treevite/compose.yml" -f "$root/queue-rs/polis-api/conformance/post-treevite-waves-compose.yml")
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then echo 'project already exists' >&2; exit 1; fi
mkdir -p "$here/artifacts"
cleanup() { "${compose[@]}" logs --no-color > "$here/artifacts/treevite-wave-services.log" 2>&1 || true; "${compose[@]}" down -t 1 -v --remove-orphans; }
trap cleanup EXIT
ready() {
  for _ in $(seq 60); do
    if "${compose[@]}" exec -T driver node -e 'fetch("http://server:5001/ready",{signal:AbortSignal.timeout(1500)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  exit 1
}
"${compose[@]}" up -d --pull never postgres dynamodb file-server oidc-simulator server driver
"${compose[@]}" restart -t 1 server
ready
python3 "$here/treevite/provenance.py"
"${compose[@]}" exec -T driver node characterization/cli.cjs seed
"${compose[@]}" restart -t 1 server dynamodb
ready
"${compose[@]}" exec -T driver node -e 'fetch("http://server:5001/votes-tokens").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/participant-public.pem",v.publicKey))'
"${compose[@]}" exec -T driver node -e 'fetch("https://oidc-simulator:3000/.well-known/jwks.json").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/read-jwks.json",JSON.stringify(v)))'
"${compose[@]}" up -d --pull never polis-api
for _ in $(seq 60); do
  if "${compose[@]}" exec -T driver node -e 'fetch("http://polis-api:5100/health",{signal:AbortSignal.timeout(1500)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then break; fi
  sleep 1
done
"${compose[@]}" exec -T -e P027_SOURCE_COMMIT="$P027_SOURCE_COMMIT" driver node --require /conformance/post-treevite-waves-replay.cjs characterization/treevite/run.cjs /artifacts/treevite-wave-rust
"${compose[@]}" exec -T driver cat /artifacts/treevite-wave-rust-replay.json
