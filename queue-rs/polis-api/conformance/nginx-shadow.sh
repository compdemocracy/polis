#!/usr/bin/env bash
# The vote shadow (RUST_API_ROUTES=votesShadow) behind the production nginx
# image, against a recording Node stand-in and a shadow stand-in in every mode
# (file-server/nginx/shadow-stubs.py): answer, refuse, absent from DNS, close
# at once, silent, 40 ms, 5 s. In every mode the participant gets Node's exact
# status and bytes; Node gets each vote once, with the same headers as without
# the shadow except X-Request-Id; the shadow gets the same body and id; a
# client-sent id is replaced; other methods, bodies outside 1 to 9999 bytes,
# chunked bodies and other paths are not copied; the copy's location answers
# direct requests 404; and nginx writes one shadow_mirror and one shadow_edge
# line per copy (file-server/nginx/test-shadow-mirror.py).
#
# With --load it also runs the participation-path test: 16 keepalive
# connections of votes, each vote followed by a request on the same
# connection, with a silent shadow against a control with nothing selected.
# The vote's p99 stays within 5 ms of the control's, the next request's p99 is
# at most 60 ms, and no client request fails. It measures latency, so run it
# on a quiet box.
#
# Usage, from the repository root:
#   queue-rs/polis-api/conformance/nginx-shadow.sh [--load]
# X54_NGINX_PORT (loopback port), X54_NGINX_IMAGE (a built nginx-proxy image)
# and NGINX_SHADOW_PYTHON_IMAGE (default python:3.11-slim) may be set.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
python3 "$root/ci/host_ports.py" env X54_NGINX_PORT
load=0
[[ ${1:-} != --load ]] || load=1
p=${X54_NGINX_PREFIX:-nginx-shadow-$$-${RANDOM}}
net="$p-net"
image=${X54_NGINX_IMAGE:-$p:local}
python_image=${NGINX_SHADOW_PYTHON_IMAGE:-python:3.11-slim}
work=""
cleanup() {
  docker rm -f "$p-proxy" "$p-node" "$p-shadow" "$p-alpha" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  [[ -z $work ]] || rm -rf "$work"
}
trap cleanup EXIT
cleanup
work=$(mktemp -d "${TMPDIR:-/tmp}/nginx-shadow.XXXXXX")
fail() { echo "FAIL: $*" >&2; exit 1; }
if [[ -z ${X54_NGINX_IMAGE:-} ]]; then
  docker build -q -t "$image" -f "$root/file-server/nginx.Dockerfile" "$root/file-server" >/dev/null
fi
docker network create "$net" >/dev/null
stubs="$root/file-server/nginx/shadow-stubs.py"
driver=(python3 "$root/file-server/nginx/test-shadow-mirror.py")
docker run -d --name "$p-node" --network "$net" --network-alias server \
  -v "$stubs:/stubs.py:ro" "$python_image" python3 -u /stubs.py node 5000 >/dev/null
# nginx resolves the participation client's static upstream at startup.
docker run -d --name "$p-alpha" --network "$net" --network-alias client-participation-alpha --entrypoint sh \
  nginx:1.21.5-alpine -c "printf 'server { listen 4321; location / { return 200 alpha; } }' > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'" >/dev/null

shadow() { # mode: the shadow stand-in, or none (absent) or a container with no listener (refuse)
  docker rm -f "$p-shadow" >/dev/null 2>&1 || true
  case "$1" in
    absent) ;;
    refuse) docker run -d --name "$p-shadow" --network "$net" --network-alias polis-api-shadow \
              "$python_image" sleep 3600 >/dev/null ;;
    *) docker run -d --name "$p-shadow" --network "$net" --network-alias polis-api-shadow \
         -v "$stubs:/stubs.py:ro" "$python_image" python3 -u /stubs.py shadow 5101 "$1" >/dev/null ;;
  esac
}

start() { # routes
  docker rm -f "$p-proxy" >/dev/null 2>&1 || true
  docker run -d --name "$p-proxy" --network "$net" -p "127.0.0.1:${X54_NGINX_PORT:-25466}:80" \
    -e RUST_API_ROUTES="$1" "$image" >/dev/null
  for _ in $(seq 40); do
    if docker exec "$p-proxy" wget -qO- http://127.0.0.1/api/v3/testConnection >/dev/null 2>&1; then
      if [[ -n $1 ]]; then
        docker exec "$p-proxy" grep -q 'location @polis_shadow_votesShadow' /etc/nginx/rust-api/locations.conf \
          || { docker logs "$p-proxy" >&2; fail "the shadow selection was not rendered"; }
      fi
      return 0
    fi
    sleep 0.25
  done
  docker logs "$p-proxy" >&2
  fail "nginx did not start with RUST_API_ROUTES=$1"
}

start ""
"${driver[@]}" baseline "$p" "$work/baseline.json"
for mode in answer refuse absent close silent delay40 delay5s; do
  shadow "$mode"
  start votesShadow
  "${driver[@]}" behaviour "$p" "$mode" "$work/baseline.json"
done
echo "ok vote shadow behaviour in every mode: answer, refuse, absent, close, silent, 40 ms, 5 s"

if [[ $load == 1 ]]; then
  shadow silent
  start ""
  "${driver[@]}" load "$p" "$work/control.json"
  start votesShadow
  "${driver[@]}" load "$p" "$work/shadow.json"
  "${driver[@]}" compare "$work/control.json" "$work/shadow.json"
fi
