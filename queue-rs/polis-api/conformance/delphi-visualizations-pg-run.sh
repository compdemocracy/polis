#!/usr/bin/env bash
# Postgres baseline and native visualization job metadata; all services are disposable fixtures.
# Requires three local images (Node, migration Postgres, fixture-clock polis-api).
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${1:?provide a results JSON path}
: "${COMPOSE_PROJECT_NAME:?set a unique project}"
: "${POLIS_RECOVERY_PG_PORT:?set a unique port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
export DELPHI_VISUALIZATIONS_PG_SOURCE="$root"
export DELPHI_VISUALIZATIONS_PG_SCRATCH=${DELPHI_VISUALIZATIONS_PG_SCRATCH:-$(mktemp -d)}
mkdir -p "$DELPHI_VISUALIZATIONS_PG_SCRATCH"
[[ -z $(ls -A "$DELPHI_VISUALIZATIONS_PG_SCRATCH") ]] || { echo "scratch must be empty" >&2; exit 2; }
compose=(docker compose -f "$root/queue-rs/polis-api/conformance/delphi-visualizations-pg-compose.yml")
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]] || { echo "project already exists" >&2; exit 2; }
cleanup() {
  "${compose[@]}" logs --no-color >"${out%.json}-services.log" 2>&1 || true
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
"${compose[@]}" up -d --pull never postgres dynamodb recorder polis-api
cid=$("${compose[@]}" ps -aq recorder)
result=$(docker wait "$cid")
"${compose[@]}" logs --no-color recorder
docker cp "$cid:/proof/results.json" "$out"
exit "$result"
