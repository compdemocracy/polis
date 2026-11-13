#!/usr/bin/env bash
# The vote shadow (RUST_API_ROUTES=votesShadow) behind the production nginx
# image, against a recording Node stand-in and a shadow stand-in in every mode
# (file-server/nginx/shadow-stubs.py): answer, refuse, absent from DNS, close
# at once, silent, 40 ms, 5 s. In every mode the participant gets Node's exact
# status and bytes; Node gets each vote once, with the same headers as without
# the shadow except X-Request-Id; the shadow gets the same body and id, and
# the same query string, byte for byte; a
# client-sent id is replaced; other methods, bodies outside 1 to 9999 bytes,
# chunked bodies, bodies of undeclared length and other paths are not copied
# and never enter the shadow's locations: each reaches Node exactly as with
# nothing selected (the same headers, no request id, its body streamed, the
# same reply to the byte, the ordinary access line, no shadow line); the copy's
# location answers direct requests 404; nginx writes one shadow_mirror and one shadow_edge
# line per copy; and the access line of a shadowed vote is the ordinary one
# (the image's `main` with the request line written without its query string
# and the Referer without its query string and fragment) with the peer
# address and the X-Forwarded-For field written "-", so no access line of the
# vote holds the address the request came from, an address it carried, its
# query string or what its Referer carried after the path, while Node and the
# shadow receive those headers and the query string exactly as sent
# (file-server/nginx/test-shadow-mirror.py).
#
# With --load it also runs the participation-path test: 16 keepalive
# connections of votes, each vote followed by a request on the same
# connection, with a silent shadow against a control with nothing selected.
# The vote's p99 stays within 5 ms of the control's, the next request's p99 is
# at most 60 ms, and no client request fails. It measures latency, so run it
# on a quiet box.
#
# The comment shadow (RUST_API_ROUTES=commentsShadow) is then run through the
# same checks on POST /api/v3/comments, in the same seven modes and two more:
# a shadow service that answers 404 (its comment route is not switched on)
# and one that answers 500. After that, with both shadows selected: each
# route's checks again; GET and HEAD on the comment path, which every client
# polls, answered and logged exactly as with nothing selected; the comment
# copies' rate (a run of comments faster than the rate is answered by Node,
# every one, while the copies over the rate end with 429 in the copy's own
# location and every vote copy still arrives); the same on one keepalive
# connection, where a refused copy costs the next request nothing and a copy
# sent to a silent shadow holds the next request for at most its timeouts;
# and comment bodies from 180
# bytes to the largest nginx and Node accept, whole, in parts and chunked,
# answered with the same bytes with and without the shadow, only those of 1
# to 9999 declared bytes passing through the shadow's location, and no body
# written to a temporary file that is not written to one with nothing
# selected.
#
# With --measure it prints what the mirror costs a comment: the time until
# Node has the request's first byte, until Node has the whole body, and the
# client's total, for each body size, with and without the shadow. Run it on
# a quiet box.
#
# Usage, from the repository root:
#   queue-rs/polis-api/conformance/nginx-shadow.sh [--load] [--measure]
# X54_NGINX_PORT (loopback port), X54_NGINX_IMAGE (a built nginx-proxy image)
# and NGINX_SHADOW_PYTHON_IMAGE (default python:3.11-slim) may be set.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
python3 "$root/ci/host_ports.py" env X54_NGINX_PORT
load=0
measure=0
for flag in "$@"; do
  case "$flag" in
    --load) load=1 ;;
    --measure) measure=1 ;;
    *) echo "usage: $0 [--load] [--measure]" >&2; exit 2 ;;
  esac
done
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
      local shadow
      for shadow in ${1//,/ }; do
        docker exec "$p-proxy" grep -q "location @polis_shadow_$shadow" /etc/nginx/rust-api/locations.conf \
          || { docker logs "$p-proxy" >&2; fail "the shadow selection was not rendered"; }
      done
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

# The comment shadow: the same checks on POST /api/v3/comments, and a shadow
# service that answers 404 or 500.
start ""
"${driver[@]}" baseline "$p" "$work/baseline-comments.json" commentsShadow
for mode in answer refuse absent close silent delay40 delay5s status404 status500; do
  shadow "$mode"
  start commentsShadow
  "${driver[@]}" behaviour "$p" "$mode" "$work/baseline-comments.json" commentsShadow
done
echo "ok comment shadow behaviour in every mode: answer, refuse, absent, close, silent, 40 ms, 5 s, 404, 500"

# Both shadows selected, the ordinary selection.
for mode in answer silent; do
  shadow "$mode"
  start votesShadow,commentsShadow
  "${driver[@]}" behaviour "$p" "$mode" "$work/baseline.json"
  "${driver[@]}" behaviour "$p" "$mode" "$work/baseline-comments.json" commentsShadow
  "${driver[@]}" read "$p" "$work/baseline-comments.json"
done
echo "ok both shadows selected: each route's checks with a shadow that answers and one that is silent; comment reads unchanged"
shadow answer
start votesShadow,commentsShadow
"${driver[@]}" rate "$p"
# The same rate on one keepalive connection, as a load balancer reuses one:
# with the shadow answering, with it silent, and with nothing selected.
"${driver[@]}" keepalive "$p" answering
shadow silent
start votesShadow,commentsShadow
"${driver[@]}" keepalive "$p" silent
shadow answer
start ""
"${driver[@]}" keepalive "$p" unselected
"${driver[@]}" bodies "$p" "$work/bodies-control.json" unselected
start votesShadow,commentsShadow
"${driver[@]}" bodies "$p" "$work/bodies-shadow.json" answering
"${driver[@]}" same-bodies "$work/bodies-control.json" "$work/bodies-shadow.json"
for mode in absent silent status404 status500; do
  shadow "$mode"
  start votesShadow,commentsShadow
  "${driver[@]}" bodies "$p" "$work/bodies-$mode.json" "$mode"
  "${driver[@]}" same-bodies "$work/bodies-control.json" "$work/bodies-$mode.json"
done
echo "ok comment bodies of every size are answered alike with nothing selected and with the shadow answering, absent, silent, answering 404 and answering 500"

if [[ $load == 1 ]]; then
  shadow silent
  start ""
  "${driver[@]}" load "$p" "$work/control.json"
  start votesShadow
  "${driver[@]}" load "$p" "$work/shadow.json"
  "${driver[@]}" compare "$work/control.json" "$work/shadow.json"
fi

if [[ $measure == 1 ]]; then
  shadow answer
  start ""
  "${driver[@]}" measure "$p" "$net" "$python_image" "$work/measure-control.json"
  start votesShadow,commentsShadow
  "${driver[@]}" measure "$p" "$net" "$python_image" "$work/measure-shadow.json"
  "${driver[@]}" measured "$work/measure-control.json" "$work/measure-shadow.json"
fi
