#!/usr/bin/env bash
# Own disposable public-fixture cluster only. No target connection string accepted.
set -euo pipefail
: "${COMPOSE_PROJECT_NAME:?set a unique project name}"
: "${POLIS_RECOVERY_PG_PORT:?set a unique port}"
case "$COMPOSE_PROJECT_NAME" in p027-m21-*) ;; *) echo 'project must start p027-m21-' >&2; exit 2;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${COORDINATOR_DOWN_EVIDENCE_DIR:-$(mktemp -d /private/tmp/000021-down.XXXXXX)}"
mkdir -p "$WORK"
(cd "$HERE/.." && shasum -a 256 -c down/000021-files.sha256) > "$WORK/pins.log"
COMPOSE=(docker compose -f "$HERE/test_000021.compose.yml")
# Refuse an existing project rather than adopting or removing its resources.
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ] ||
   [ -n "$(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ] ||
   [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]; then
  echo 'existing project refused' >&2; exit 2
fi
cleanup() {
  local result=$?
  "${COMPOSE[@]}" down --volumes --remove-orphans > "$WORK/cleanup.log" 2>&1 || result=1
  docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" > "$WORK/remaining-containers.txt"
  docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" > "$WORK/remaining-networks.txt"
  docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" > "$WORK/remaining-volumes.txt"
  for kind in containers networks volumes; do
    if [ -s "$WORK/remaining-$kind.txt" ]; then result=1; fi
  done
  exit "$result"
}
trap cleanup EXIT
"${COMPOSE[@]}" up -d --wait > "$WORK/startup.log" 2>&1
CONTAINER="$("${COMPOSE[@]}" ps -q postgres)"
python3 -B "$HERE/test_000021_down.py" "$CONTAINER" "$WORK"
