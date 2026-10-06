#!/usr/bin/env bash
# 000025 (vote convention) up/down/up and behaviour tests on a disposable
# PostgreSQL 17 of its own. No target connection string is accepted.
#   COMPOSE_PROJECT_NAME=p078a-local POLIS_RECOVERY_PG_PORT=5476 \
#     server/postgres/migrations/down/test_000025_down.sh
set -euo pipefail
: "${COMPOSE_PROJECT_NAME:?set a unique project name}"
: "${POLIS_RECOVERY_PG_PORT:?set a unique port}"
case "$COMPOSE_PROJECT_NAME" in p078a|p078a-*) ;; *) echo 'project must be p078a or start p078a-' >&2; exit 2;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${VOTE_CONVENTION_DOWN_EVIDENCE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/000025-down.XXXXXX")}"
mkdir -p "$WORK"
COMPOSE=(docker compose -f "$HERE/test_000025.compose.yml")
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
python3 -B "$HERE/test_000025_down.py" "$CONTAINER" "$WORK"
