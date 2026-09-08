#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
# Isolation bounds are configurable so another reviewer or CI can run this under
# its own assigned prefix and port range without editing the tools. The defaults
# are the round-4 values.
export P032_PROJECT_PREFIX=${P032_PROJECT_PREFIX:-rpca2x}
export P032_PORT_MIN=${P032_PORT_MIN:-55720} P032_PORT_MAX=${P032_PORT_MAX:-55739}
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-$P032_PROJECT_PREFIX-$(openssl rand -hex 4)}
[[ "$COMPOSE_PROJECT_NAME" =~ ^${P032_PROJECT_PREFIX}-[a-z0-9]+$ ]] || { echo "isolated $P032_PROJECT_PREFIX project required" >&2; exit 1; }
# Reserve six distinct ports within the user-assigned range. No other project's
# containers, networks, volumes, checkout or env files may be changed.
read -r POLIS_RECOVERY_PG_PORT P027_HTTP_PORT P027_CONTROL_PORT P032_HTTP_PORT P032_DYNAMO_PORT P032_WIRE_PORT < <(python3 - <<'PY'
import os,socket
ports=[]
for p in range(int(os.environ['P032_PORT_MIN']),int(os.environ['P032_PORT_MAX'])+1):
 s=socket.socket()
 try:s.bind(('127.0.0.1',p));ports.append(p)
 except OSError:pass
 s.close()
 if len(ports)==6:break
assert len(ports)==6,'six free test ports required'
print(*ports)
PY
)
export POLIS_RECOVERY_PG_PORT P027_HTTP_PORT P027_CONTROL_PORT
export RECOVERY_PG_PORT=$POLIS_RECOVERY_PG_PORT
export NODE_PATH=${NODE_PATH:-/Users/colinmegill/polis/server/node_modules}
if [[ ! -d "$HOME/.cargo" ]]; then
 export CARGO_HOME=/private/tmp/p026-toolchain/cargo RUSTUP_HOME=/private/tmp/p026-toolchain/rustup
 export PATH="$CARGO_HOME/bin:$PATH"
fi
compose=(docker compose -f "$root/server/characterization/compose.yml")
# Refuse to reuse a nonempty project: this is always a destroyed-stack replay.
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]] || { echo 'project already exists' >&2; exit 1; }
bridge_pid=''
cleanup() {
 if [[ -n "$bridge_pid" ]]; then kill "$bridge_pid" 2>/dev/null || true; wait "$bridge_pid" 2>/dev/null || true; fi
 "${compose[@]}" down -v --remove-orphans
}
trap cleanup EXIT INT TERM
(cd server-rs && cargo build --locked --features characterization)
"${compose[@]}" up -d --pull never
node server-rs/tools/bridge.cjs "$COMPOSE_PROJECT_NAME" "$POLIS_RECOVERY_PG_PORT" "$P027_HTTP_PORT" "$P027_CONTROL_PORT" "$P032_DYNAMO_PORT" &
bridge_pid=$!
export DATABASE_URL="postgres://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/p027"
export P027_BASE_URL="http://127.0.0.1:$P032_HTTP_PORT"
export P027_CONTROL_URL="http://127.0.0.1:$P027_CONTROL_PORT"
export DYNAMODB_ENDPOINT="http://127.0.0.1:$P032_DYNAMO_PORT"
export P032_HTTP_PORT P032_WIRE_PORT
export LISTEN_ADDR="127.0.0.1:$P032_HTTP_PORT" MATH_ENV=p027
# The candidate must run under the same configuration the recording ran under.
# These four are the recorded server service's own values (compose.yml server
# environment); addCorsHeader and the final handler read all of them.
export DEV_MODE=true NODE_ENV=production DOMAIN_OVERRIDE=localhost
export API_PROD_HOSTNAME=pol.is
node - <<'JS'
(async()=>{for(let i=0;i<90;i++){try{const r=await fetch(process.env.P027_CONTROL_URL+'/ready',{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('reference readiness failed');})().catch(e=>{console.error(e.message);process.exitCode=1});
JS
"${compose[@]}" exec -T driver node characterization/cli.cjs seed
"${compose[@]}" run --rm --no-deps math-seed
"${compose[@]}" exec -T driver node characterization/cli.cjs seed-pages
# Record only generated-data provenance and image IDs, never credentials.
P032_DYNAMO_PORT=$P032_DYNAMO_PORT P032_HTTP_PORT=$P032_HTTP_PORT node - <<'JS'
const cp=require('node:child_process'),fs=require('node:fs'),crypto=require('node:crypto');
const project=process.env.COMPOSE_PROJECT_NAME;
const ids=cp.execFileSync('docker',['ps','-q','--filter','label=com.docker.compose.project='+project],{encoding:'utf8'}).trim().split('\n');
const containers=JSON.parse(cp.execFileSync('docker',['inspect',...ids],{encoding:'utf8'}));
const nets=[...new Set(containers.flatMap(c=>Object.values(c.NetworkSettings.Networks).map(n=>n.NetworkID)))];
const network=JSON.parse(cp.execFileSync('docker',['network','inspect',...nets],{encoding:'utf8'}));
if(containers.length!==6||network.length!==1||!network[0].Internal)throw Error('sealed six-service gate');
const images=Object.fromEntries(containers.map(c=>[c.Config.Labels['com.docker.compose.service'],c.Image]));
const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
fs.writeFileSync('server-rs/evidence/run.json',JSON.stringify({project,ports:['POLIS_RECOVERY_PG_PORT','P027_HTTP_PORT','P027_CONTROL_PORT','P032_HTTP_PORT','P032_DYNAMO_PORT','P032_WIRE_PORT'].map(k=>Number(process.env[k])),images,networkInternal:true,generatedOnly:true,sourceCommit:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),archiveSha256:digest('server/characterization/artifacts/baseline.json.gz'),binarySha256:digest('server-rs/target/debug/polis-api'),clock:1700000000000,mathEnv:process.env.MATH_ENV},null,2)+'\n');
JS
node server-rs/tools/replay.cjs
node server-rs/tools/tick-zero.cjs
node server-rs/tools/wire-checks.cjs
