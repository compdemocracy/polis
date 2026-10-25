#!/usr/bin/env bash
# Record Postgres report exports and
# compare complete Node/Rust HTTP bytes. Uses only the isolated generated stack.
# Usage: report-export-run.sh [result.json], with unique project and P027 ports.
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
compose=(docker compose -f "$here/compose.yml" -f "$root/queue-rs/polis-api/conformance/compose.yml" -f "$root/queue-rs/polis-api/conformance/participant-compose.yml" -f "$root/queue-rs/polis-api/conformance/report-export-compose.yml" -f "$root/queue-rs/polis-api/conformance/metadata-query-compose.yml" -f "$root/queue-rs/polis-api/conformance/perf-stats-compose.yml")
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
"${compose[@]}" exec -T driver node characterization/cli.cjs seed
# The comment fixture requires a foreign owner with a generated conversation.
# Install only that prerequisite; these reads do not need the math engine.
"${compose[@]}" exec -T driver node <<'SEED'
const { Pool } = require("pg");
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== "postgres" || url.pathname !== "/p027" || process.env.P027_NETWORK_INTERNAL !== "1") throw Error("sealed generated database required");
const actor = require("./characterization/comments-cases.cjs").actors.find(a => a.uid === 4);
const fixture = require("./characterization/pca2-fixtures.json").find(f => f.shape === "foreign");
(async () => {
  const pool = new Pool({connectionString: process.env.DATABASE_URL});
  try {
    await pool.query("INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES($1,$2,$3,true,$4,$5)", [actor.uid,"Generated foreign owner","foreign@example.invalid",actor.site,1700000000000]);
    await pool.query("INSERT INTO conversations(zid,owner,topic,is_active,is_draft,is_public,created,modified) VALUES($1,$2,$3,true,false,true,$4,$4)", [fixture.zid,actor.uid,"Generated foreign conversation",1700000000000]);
  } finally { await pool.end(); }
})().catch(e => { console.error(e); process.exitCode=1; });
SEED
"${compose[@]}" exec -T driver node characterization/cli.cjs seed-comments
"${compose[@]}" exec -T driver node -e 'fetch("http://server:5001/public-key").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/participant-public.pem",v.publicKey))'
"${compose[@]}" exec -T driver node -e 'fetch("https://oidc-simulator:3000/.well-known/jwks.json").then(r=>r.json()).then(v=>require("fs").writeFileSync("/artifacts/read-jwks.json",JSON.stringify(v)))'
"${compose[@]}" up -d --pull never polis-api polis-api-off metadata-query-proxy
for service in polis-api polis-api-off; do
  healthy=0
  for _ in $(seq 60); do
    if "${compose[@]}" exec -T driver node -e "fetch('http://$service:5100/health',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then healthy=1; break; fi
    sleep 1
  done
  [[ "$healthy" == 1 ]] || { echo "$service readiness deadline" >&2; exit 1; }
done
"${compose[@]}" exec -T driver node /conformance/report-export-replay.cjs >"$out"

# Issue regression identities at the baseline clock, after the report TTL cases.
"${compose[@]}" exec -T driver node -e 'fetch("http://server:5001/begin?seed=7ac001000001&case=metadata-regression&clock=1700000000000").then(r=>{if(!r.ok)process.exit(1)})'
"${compose[@]}" exec -T driver node /conformance/metadata-query-replay.cjs >"${out%.json}-metadata-regression.json"
"${compose[@]}" exec -T driver node /conformance/perf-stats-replay.cjs >"${out%.json}-perf-regression.json"
