#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 22.23.4

(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts --no-audit --no-fund
)
node --test server/characterization/check-inventory.test.cjs
node server/characterization/check-inventory.cjs

: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
: "${P027_HTTP_PORT:?choose a free HTTP port}"
: "${P027_CONTROL_PORT:?choose a free control port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
for name in POLIS_RECOVERY_PG_PORT P027_HTTP_PORT P027_CONTROL_PORT; do
  value="${!name}"
  if [[ ! "$value" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$value >= 49152 )); then
    echo "$name must be an integer from 1 to 49151 on every platform; this shared test-port policy avoids macOS ephemeral IPv6 collisions with IPv4 Docker publications (Linux ephemeral ranges can differ)" >&2
    exit 2
  fi
done
if [ "$POLIS_RECOVERY_PG_PORT" = "$P027_HTTP_PORT" ] ||
   [ "$POLIS_RECOVERY_PG_PORT" = "$P027_CONTROL_PORT" ] ||
   [ "$P027_HTTP_PORT" = "$P027_CONTROL_PORT" ]; then
  echo 'Choose three distinct ports' >&2
  exit 2
fi
check_project "$COMPOSE_PROJECT_NAME"
for name in P027_SERVER_IMAGE P027_POSTGRES_IMAGE P027_OIDC_IMAGE; do
  [ -n "${!name:-}" ] || { echo "$name must name an owned image" >&2; exit 2; }
done

compose() { docker compose -f server/characterization/compose.yml "$@"; }
cleanup() {
  local result=$?
  trap - EXIT
  set +e
  compose logs --no-color > server/characterization/artifacts/route-census-services.log 2>&1
  compose down -v --remove-orphans
  [ "$?" = 0 ] || result=1
  exit "$result"
}
mkdir -p server/characterization/artifacts
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build --target prod --build-arg NODE_ENV=production -t "$P027_SERVER_IMAGE" -f server/Dockerfile .
docker build --build-context queue-rs=queue-rs -t "$P027_POSTGRES_IMAGE" -f server/Dockerfile-db server
docker build -t "$P027_OIDC_IMAGE" oidc-simulator
# Coverage reads the registered routes; it needs no request corpus or seeded votes.
compose up -d postgres oidc-simulator server driver
ready=0
for ((attempt = 0; attempt < 60; attempt++)); do
  if compose exec -T driver node -e '
    fetch(process.env.P027_CONTROL_URL + "/ready", { signal: AbortSignal.timeout(1000) })
      .then(async r => { if (!r.ok || !(await r.json()).ready) process.exitCode = 1; })
      .catch(() => { process.exitCode = 1; });
  '; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo 'Route census server did not become ready' >&2; exit 1; }
compose exec -T driver node characterization/cli.cjs coverage
