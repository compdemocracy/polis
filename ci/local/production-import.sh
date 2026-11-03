#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
check_project "$COMPOSE_PROJECT_NAME"
# Proof logs go with the other check results.
IMPORT_PROOF_ROOT="$(check_out_dir "$COMPOSE_PROJECT_NAME")"
export IMPORT_PROOF_ROOT

(
  cd "$CHECK_ROOT/."
  bash scripts/test-production-import.sh
)
