#!/usr/bin/env bash
# CI and work boxes run this same build/bootstrap/restart proof.
set -euo pipefail
cd "$(dirname "$0")/../../.."
case "${COMPOSE_PROJECT_NAME:-}" in
  polis-migrate-test-?*) ;;
  *) echo 'Set an owned COMPOSE_PROJECT_NAME starting polis-migrate-test-' >&2; exit 2 ;;
esac
: "${POLIS_RECOVERY_PG_PORT:?set an owned port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
export POLIS_MIGRATE_TEST_IMAGE="${COMPOSE_PROJECT_NAME}:fresh-image"
compose=(docker compose -f queue-rs/polis-migrate/tests/compose.yml -f queue-rs/polis-migrate/tests/image.yml)
cleanup() {
  local status=$?
  trap - EXIT
  "${compose[@]}" down -v || status=1
  if docker image inspect "$POLIS_MIGRATE_TEST_IMAGE" >/dev/null 2>&1; then
    docker image rm "$POLIS_MIGRATE_TEST_IMAGE" || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
python3 queue-rs/polis-migrate/tests/image-proof-test.py
"${compose[@]}" down -v
docker build --build-context queue-rs=queue-rs -t "$POLIS_MIGRATE_TEST_IMAGE" -f server/Dockerfile-db server
"${compose[@]}" up -d --wait --wait-timeout 120
python3 queue-rs/polis-migrate/tests/image-proof.py
