#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT
check_project "$COMPOSE_PROJECT_NAME"
# The launcher creates these with plain `docker run` and removes the two
# containers when it exits, whoever created them: refuse any that already
# exist, so everything it removes is its own. It never removes its cargo
# registry volume; this run created it, so remove it here.
check_absent container "$COMPOSE_PROJECT_NAME-proof" "$COMPOSE_PROJECT_NAME-dynamo" "$COMPOSE_PROJECT_NAME-build"
check_absent volume "$COMPOSE_PROJECT_NAME-cargo"
# Proof logs go with the other check results, in a new empty directory.
# The launcher runs queue-rs/target/debug/polis-migrate, so cargo must
# build there.
WRITER_PROOF_ROOT="$(check_out_dir "$COMPOSE_PROJECT_NAME" fresh)"
export WRITER_PROOF_ROOT
unset CARGO_TARGET_DIR
# Only a volume listing that Docker answered can show the volume is gone;
# when Docker cannot answer, the run fails rather than leave it unreported.
cleanup() {
  local result=$? volumes
  trap - EXIT
  set +e
  if volumes="$(docker volume ls --format '{{.Name}}')"; then
    if grep -qxF -- "$COMPOSE_PROJECT_NAME-cargo" <<< "$volumes"; then
      docker volume rm "$COMPOSE_PROJECT_NAME-cargo" >/dev/null || { echo "Could not remove the volume $COMPOSE_PROJECT_NAME-cargo" >&2; result=1; }
    fi
  else
    echo "Cannot list volumes; $COMPOSE_PROJECT_NAME-cargo may remain" >&2
    result=1
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
