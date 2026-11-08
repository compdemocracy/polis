#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT
check_project "$COMPOSE_PROJECT_NAME"
# Proof logs go with the other check results, in a new empty directory.
IMPORT_PROOF_ROOT="$(check_out_dir "$COMPOSE_PROJECT_NAME" fresh)"
export IMPORT_PROOF_ROOT

(
  cd "$CHECK_ROOT/."
  bash scripts/test-production-import.sh
)
