#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
check_project "$COMPOSE_PROJECT_NAME"
# The launcher creates these with plain `docker run` and removes the two
# containers when it exits, whoever created them: refuse any that already
# exist, so everything it removes is its own. It never removes its cargo
# registry volume; this run created it, so remove it here.
check_absent container "$COMPOSE_PROJECT_NAME-proof" "$COMPOSE_PROJECT_NAME-dynamo" "$COMPOSE_PROJECT_NAME-build"
check_absent volume "$COMPOSE_PROJECT_NAME-cargo"
# Proof logs go with the other check results. The launcher runs
# queue-rs/target/debug/polis-migrate, so cargo must build there.
WRITER_PROOF_ROOT="$(check_out_dir "$COMPOSE_PROJECT_NAME")"
export WRITER_PROOF_ROOT
unset CARGO_TARGET_DIR
cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if docker volume inspect "$COMPOSE_PROJECT_NAME-cargo" >/dev/null 2>&1; then
    docker volume rm "$COMPOSE_PROJECT_NAME-cargo" >/dev/null || result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(
  cd "$CHECK_ROOT/."
  bash scripts/test-dynamo-writers.sh
)
