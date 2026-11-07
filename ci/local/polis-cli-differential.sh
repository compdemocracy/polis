#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT P027_HTTP_PORT P027_CONTROL_PORT P027_PORT_MIN P027_PORT_MAX
 : "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT P027_HTTP_PORT P027_CONTROL_PORT P027_PORT_MIN P027_PORT_MAX
check_project "$COMPOSE_PROJECT_NAME"
export SETUP_ADMISSION_PROJECT="${SETUP_ADMISSION_PROJECT:-setup-admission-${GITHUB_RUN_ID:?choose SETUP_ADMISSION_PROJECT locally}-${GITHUB_RUN_ATTEMPT:-1}}"
check_project "$SETUP_ADMISSION_PROJECT"
export CLI_DIFF_NGINX_IMAGE="${CLI_DIFF_NGINX_IMAGE:-${COMPOSE_PROJECT_NAME}-nginx:local}"
cleanup() {
  local result=$?
  trap - EXIT
  set +e
  (
    cd "$CHECK_ROOT/."
    docker compose -p "$COMPOSE_PROJECT_NAME" -f server/characterization/compose.yml -f polis-cli/tests/differential/compose.yml down -v --remove-orphans --timeout 1
  )
  [ "$?" = 0 ] || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(
  cd "$CHECK_ROOT/."
  bash scripts/prepare-polis-cli-differential.sh
)

(
  cd "$CHECK_ROOT/."
  bash scripts/test-polis-cli-differential.sh --binary ../target/debug/polis --output "${RUNNER_TEMP}/differential-results.json"
)

(
  cd "$CHECK_ROOT/."
  export COMPOSE_PROJECT_NAME="$SETUP_ADMISSION_PROJECT"
  bash scripts/test-setup-admission.sh
)
