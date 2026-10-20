#!/usr/bin/env bash
# Usage: bash scripts/rust-api-switch.sh ROUTES [docker compose global options...]
# Pass '' to move every route to Node, drain nginx, then stop only polis-api.
# Requires the reload-capable nginx image. Never recreates nginx or Node.
set -euo pipefail
[[ $# -ge 1 ]] || { echo "Usage: $0 ROUTES [compose options...]" >&2; exit 2; }
routes=$1
shift
if [[ -n "${POLIS_COMPOSE_BIN:-}" ]]; then
  compose=("$POLIS_COMPOSE_BIN" "$@")
else
  compose=(docker compose "$@")
fi
proxy=$("${compose[@]}" ps -q nginx-proxy)
[[ -n "$proxy" ]] || { echo 'nginx-proxy is not running' >&2; exit 1; }
# Lock the entire lifecycle, not only each individual render/reload. A crashed
# caller leaves a visible lock and requires an operator to inspect before retry.
docker exec "$proxy" mkdir /var/lib/polis-routing/switch.lock
cleanup() { docker exec "$proxy" rmdir /var/lib/polis-routing/switch.lock >/dev/null; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
apply() {
  docker exec -e "RUST_API_ROUTES=$1" "$proxy" /usr/local/bin/polis-rust-routes "$2"
}
# Reject unknown routes before changing the current selection or any service.
apply "$routes" --check
# Old workers may have a Rust response in flight; do not stop Rust under them.
apply '' --reload
if [[ -z "${routes//[,$' \t\r\n']/}" ]]; then
  "${compose[@]}" stop polis-api
else
  RUST_API_ROUTES="$routes" "${compose[@]}" up -d --no-deps --no-build polis-api
  # Probe from nginx's own network namespace. The diagnostic host is the same
  # host:port its validated map uses, and the response must be HTTP success.
  ready=0
  for ((attempt=0; attempt<30; attempt++)); do
    if docker exec "$proxy" sh -c 'wget -q -T 2 -O /dev/null "http://${RUST_API_UPSTREAM:-polis-api:5100}/health"'; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" = 1 ]] || { echo 'Rust health failed; selection remains on Node' >&2; exit 1; }
  apply "$routes" --reload
fi
[[ "$proxy" = "$("${compose[@]}" ps -q nginx-proxy)" ]] || { echo 'nginx identity changed unexpectedly' >&2; exit 1; }
echo 'Route switch complete; nginx container retained'
