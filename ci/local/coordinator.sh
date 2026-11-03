#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 24.22.1
check_python
# The source snapshot and historical attribution require a real Git checkout.
git rev-parse --verify HEAD >/dev/null
git ls-files --error-unmatch coordinator-rs/ci/run.py >/dev/null
: "${COMPOSE_PROJECT_NAME:?choose a unique Compose project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free port >= 55432}"
: "${COORDINATOR_TLS_PROJECT:?choose a unique coordinator-tls- project}"
: "${COORDINATOR_TLS_PORT:?choose a different free port >= 55432}"
: "${COORDINATOR_OUT:?choose a new output directory outside the checkout}"
case "$COMPOSE_PROJECT_NAME" in
  ''|*[!a-z0-9-]*) echo 'Invalid Compose project' >&2; exit 2 ;;
esac
case "$COORDINATOR_TLS_PROJECT" in
  coordinator-tls-*) ;;
  *) echo 'TLS project must start with coordinator-tls-' >&2; exit 2 ;;
esac
case "$COORDINATOR_TLS_PROJECT" in
  *[!a-z0-9-]*) echo 'Invalid TLS project' >&2; exit 2 ;;
esac
for port in "$POLIS_RECOVERY_PG_PORT" "$COORDINATOR_TLS_PORT"; do
  case "$port" in ''|*[!0-9]*) echo 'Invalid test port' >&2; exit 2 ;; esac
  [ "$port" -ge 55432 ] && [ "$port" -le 65535 ] || exit 2
done
[ "$POLIS_RECOVERY_PG_PORT" != "$COORDINATOR_TLS_PORT" ] || exit 2
[ "$COMPOSE_PROJECT_NAME" != "$COORDINATOR_TLS_PROJECT" ] || exit 2
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
export COMPOSE_PROJECT_NAME POLIS_RECOVERY_PG_PORT PYTHONDONTWRITEBYTECODE=1
# Refuse an occupied project before registering teardown; never adopt a stack.
for project in "$COMPOSE_PROJECT_NAME" "$COORDINATOR_TLS_PROJECT"; do
  [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] || exit 2
  [ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ] || exit 2
  [ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ] || exit 2
done
cleanup() {
  local result=$?
  trap - EXIT
  docker compose -f coordinator-rs/ci/compose.yml down -v --remove-orphans || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python -m pip install -r coordinator-rs/evidence/python-requirements.txt
npm ci --prefix server --ignore-scripts
(cd coordinator-rs && rustup show active-toolchain)
(
  cd coordinator-rs
  export COMPOSE_PROJECT_NAME="$COORDINATOR_TLS_PROJECT"
  export POLIS_RECOVERY_PG_PORT="$COORDINATOR_TLS_PORT" RECOVERY_PG_PORT="$COORDINATOR_TLS_PORT"
  cargo test --locked --features tls-tests --test database
  python tools/d07/test_tls.py
)
python coordinator-rs/ci/run.py --output "$COORDINATOR_OUT"
