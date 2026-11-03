#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 24.22.1
export POLIS_RECOVERY_PG_PORT="${POLIS_RECOVERY_PG_PORT:-${MIXED_PG_PORT:?}}"
 : "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
check_project "$COMPOSE_PROJECT_NAME"


(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts --no-audit --no-fund
)

(
  cd "$CHECK_ROOT/."
  docker pull postgres:17-alpine && docker pull amazon/dynamodb-local:3.3.1
)

(
  cd "$CHECK_ROOT/."
  bash queue-rs/polis-api/conformance/mixed-identity-run.sh
)
