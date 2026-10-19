#!/usr/bin/env bash
# Isolated HTTP contract proof for a Rust-only public aggregate.
set -euo pipefail
: "${COMPOSE_PROJECT_NAME:?Set a unique project}"
: "${POLIS_RECOVERY_PG_PORT:?Set a unique loopback port}"
: "${IMPORTANCE_API_PORT:?Set a unique loopback port}"
: "${IMPORTANCE_OFF_PORT:?Set a unique loopback port}"
here=$(cd "$(dirname "$0")" && pwd)
compose=(docker compose -f "$here/statement-importance-compose.yml")
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then
  echo "project already exists; refusing to touch it" >&2; exit 1
fi
cleanup() { "${compose[@]}" down -v --remove-orphans >&2; }
trap cleanup EXIT
"${compose[@]}" up -d --wait >&2
python3 "$here/statement-importance-replay.py" "${1:-/dev/stdout}"
