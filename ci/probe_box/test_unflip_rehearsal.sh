#!/usr/bin/env bash
# The un-flip rehearsal's step machine on a throwaway PostgreSQL 17 (tmpfs, loopback
# port only), removed on exit. Unit cases run without it; these need it:
#   ci/probe_box/test_unflip_rehearsal.sh            # PYTHON=... to pick an interpreter with psycopg2
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-p078h}
export POLIS_RECOVERY_PG_PORT=${POLIS_RECOVERY_PG_PORT:-5474}
compose=(docker compose -f "$here/test.compose.yml")
trap '"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
"${compose[@]}" up -d --wait >/dev/null
cd "$here"
POLIS_UNFLIP_REHEARSAL_PG="postgresql://postgres@127.0.0.1:${POLIS_RECOVERY_PG_PORT}/probe_test" \
  "${PYTHON:-python3}" -m unittest -v test_unflip_rehearsal "$@"
