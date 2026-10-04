#!/usr/bin/env bash
# Checks the nginx-proxy routing switch with two stub upstreams named `server`
# (Node) and `polis-api`, each answering with its own name (plus a stub for
# the participation client, which the config also names):
#   1. RUST_API_ROUTES unset: the rendered include files are empty and pca2 goes to Node.
#   2. RUST_API_ROUTES=pca2: pca2 goes to polis-api, every other path to Node.
#   3. polis-api stopped: pca2 falls back to Node (the backup server).
#   4. RUST_API_ROUTES=bogus: the container refuses to start.
# Usage: queue-rs/polis-api/conformance/nginx-routing.sh   (from the repo root)
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
p=${X54_NGINX_PREFIX:-x54pca2-nginx}
net="$p-net"
image="$p:local"
cleanup() {
  docker rm -f "$p-proxy" "$p-node" "$p-rust" "$p-alpha" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker build -q -t "$image" -f "$root/file-server/nginx.Dockerfile" "$root/file-server" >/dev/null
docker network create "$net" >/dev/null
stub() { # name alias port body
  docker run -d --name "$1" --network "$net" --network-alias "$2" --entrypoint sh nginx:1.21.5-alpine -c \
    "printf 'server { listen $3; location / { return 200 \"$4\\\\n\"; } }' > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'" >/dev/null
}
stub "$p-node" server 5000 node
stub "$p-rust" polis-api 5100 rust
# The participation client upstream must resolve for nginx to start at all.
stub "$p-alpha" client-participation-alpha 4321 alpha
get() { docker exec "$p-proxy" wget -qO- "http://127.0.0.1$1"; }
start() {
  docker rm -f "$p-proxy" >/dev/null 2>&1 || true
  docker run -d --name "$p-proxy" --network "$net" -e RUST_API_ROUTES="${1:-}" "$image" >/dev/null
  sleep 1
}
fail() { echo "FAIL: $*" >&2; exit 1; }

start ""
[[ $(get /api/v3/math/pca2) == node ]] || fail "flag off: pca2 should reach Node"
[[ -z $(docker exec "$p-proxy" cat /etc/nginx/rust-api/upstreams.conf /etc/nginx/rust-api/locations.conf) ]] \
  || fail "flag off: include files should be empty"
echo "ok 1 flag off: pca2 -> node, include files empty"

start pca2
[[ $(get '/api/v3/math/pca2?conversation_id=x') == rust ]] || fail "flag on: pca2 should reach polis-api"
[[ $(get /api/v3/math/pca2/) == node ]] || fail "flag on: other paths stay on Node"
[[ $(get /api/v3/comments) == node ]] || fail "flag on: other routes stay on Node"
echo "ok 2 flag on: pca2 -> polis-api, other paths -> node"

docker stop "$p-rust" >/dev/null
[[ $(get /api/v3/math/pca2) == node ]] || fail "polis-api down: pca2 should fall back to Node"
echo "ok 3 polis-api down: pca2 -> node (backup)"

docker rm -f "$p-proxy" >/dev/null
if docker run --rm --network "$net" -e RUST_API_ROUTES=bogus "$image" nginx -t >/dev/null 2>&1; then
  fail "unknown route accepted"
fi
echo "ok 4 unknown route refused"
