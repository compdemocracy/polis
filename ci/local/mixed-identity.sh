#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env MIXED_PG_PORT MIXED_DYNAMO_PORT MIXED_NODE_PORT MIXED_API_PORT POLIS_MIXED_WORKER_PORT MIXED_PROVIDER_PORT
check_node 24.22.1
export POLIS_RECOVERY_PG_PORT="${POLIS_RECOVERY_PG_PORT:-${MIXED_PG_PORT:?}}"
 : "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
python3 "$CHECK_ROOT/ci/host_ports.py" env MIXED_PG_PORT MIXED_DYNAMO_PORT MIXED_NODE_PORT MIXED_API_PORT POLIS_MIXED_WORKER_PORT MIXED_PROVIDER_PORT
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
