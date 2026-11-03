#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 22.23.4
check_python
 : "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
check_project "$COMPOSE_PROJECT_NAME"


(
  cd "$CHECK_ROOT/queue-rs"
  rustup show active-toolchain
)

(
  cd "$CHECK_ROOT/."
  python -m pip install uv==0.13.4
)

(
  cd "$CHECK_ROOT/."
  bash scripts/test-dynamo-removal.sh
)
