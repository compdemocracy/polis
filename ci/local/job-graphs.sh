#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT
check_node 22.23.4
 : "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT
check_project "$COMPOSE_PROJECT_NAME"


(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts --no-audit --no-fund
)

(
  cd "$CHECK_ROOT/."
  bash delphi/tests/job_graph/run.sh
)
