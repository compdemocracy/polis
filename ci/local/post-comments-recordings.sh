#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT P027_HTTP_PORT P027_CONTROL_PORT P027_PORT_MIN P027_PORT_MAX
 : "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT P027_HTTP_PORT P027_CONTROL_PORT P027_PORT_MIN P027_PORT_MAX
check_project "$COMPOSE_PROJECT_NAME"
for name in P027_SERVER_IMAGE P027_POSTGRES_IMAGE P027_OIDC_IMAGE P027_FILE_SERVER_IMAGE; do
  [ -n "${!name:-}" ] || { echo "$name must name an owned image" >&2; exit 2; }
done

cleanup() {
  local result=$?
  trap - EXIT
  set +e
  (
    cd "$CHECK_ROOT/."
    docker compose -f server/characterization/compose.yml -f server/characterization/post-comments/compose.yml down -v --remove-orphans
  )
  [ "$?" = 0 ] || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "${GITHUB_EVENT_NAME:-local}" = pull_request ]; then
  (
    cd "$CHECK_ROOT/."
    sh ci/post_comments_golden_guard.sh "${CHECK_BASE_REF:?set CHECK_BASE_REF}"
  )
fi

(
  cd "$CHECK_ROOT/."
  docker build --target prod --build-arg NODE_ENV=production -t "$P027_SERVER_IMAGE" -f server/Dockerfile .
  docker build --build-context queue-rs=queue-rs -t "$P027_POSTGRES_IMAGE" -f server/Dockerfile-db server
  docker build -t "$P027_OIDC_IMAGE" oidc-simulator
  docker build -t "$P027_FILE_SERVER_IMAGE" --build-arg NODE_ENV=production --build-arg AUTH_AUDIENCE=users --build-arg AUTH_CLIENT_ID=dev-client-id --build-arg AUTH_ISSUER=https://localhost:3000/ --build-arg AUTH_NAMESPACE=https://pol.is/ --build-arg EMBED_SERVICE_HOSTNAME=localhost --build-arg GIT_HASH=characterization -f file-server/Dockerfile .
)

(
  cd "$CHECK_ROOT/."
  bash server/characterization/post-comments/check.sh
)
