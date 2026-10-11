#!/usr/bin/env bash
# Checks the nginx-proxy routing switch against stub upstreams that answer
# with their own name: `server` (Node), `polis-api`, and the participation
# client, which the config also names.
#   1. RUST_API_ROUTES unset: both include files are empty; pca2 goes to Node.
#   2. pca2 on, polis-api container absent when nginx starts: nginx starts and
#      pca2 goes to Node.
#   3. polis-api appears later: pca2 goes to polis-api, everything else to Node.
#   4. polis-api answers 502 (its database is unreachable): pca2 goes to Node.
#   5. polis-api container dies: pca2 goes to Node.
#   6. An unknown route name: nginx starts, logs an error, everything goes to Node.
#   7. A route named twice is rendered once; pca2 goes to polis-api.
#   8. Only GET and HEAD without a body reach polis-api: OPTIONS, POST and a
#      GET with a body go to Node.
#   9. A bad RUST_API_UPSTREAM or RUST_API_RESOLVER: nginx starts, logs an
#      error, everything goes to Node.
#  10. The fallback's limit: a polis-api reply cut short after its headers
#      reaches the client truncated; Node does not take over mid-response.
# Usage, from the repository root: queue-rs/polis-api/conformance/nginx-routing.sh
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
stub() { # container alias port status body
  docker run -d --name "$1" --network "$net" --network-alias "$2" --entrypoint sh nginx:1.21.5-alpine -c \
    "printf 'server { listen $3; location / { add_header X-Upstream $2 always; return $4 \"$5\\\\n\"; } }' > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'" >/dev/null
}
stub "$p-node" server 5000 200 node
stub "$p-alpha" client-participation-alpha 4321 200 alpha
get() { docker exec "$p-proxy" wget -qO- "http://127.0.0.1$1" 2>/dev/null || echo "(no answer)"; }
# BusyBox nc can exit on stdin EOF before the HTTP response arrives (nginx
# logs 499). Use a bounded TCP client on an ephemeral loopback-only proxy port.
expect_upstream() { # expected upstream method path [extra header lines] [body]
  local want=$1 response got
  shift
  response=$(python3 - "$p-proxy" "$@" <<'PYTHON'
import socket
import subprocess
import sys

proxy, method, path, *rest = sys.argv[1:]
headers, body = (rest + ["", ""])[:2]
request = f"{method} {path} HTTP/1.0\r\nHost: localhost\r\n{headers}\r\n{body}".encode()
address = subprocess.check_output(["docker", "port", proxy, "80/tcp"], text=True).strip()
host, port = address.rsplit(":", 1)
assert host == "127.0.0.1", f"test proxy must bind loopback only: {address}"
with socket.create_connection((host, int(port)), timeout=5) as client:
    client.sendall(request)
    while True:
        chunk = client.recv(65536)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()

PYTHON
  ) || { printf '%s\n' "$response" >&2; fail "raw HTTP transport failed: $1 $2"; }

  got=$(printf '%s\n' "$response" | tr -d '\r' | sed -n 's/^X-Upstream: //p')
  if [[ $got != "$want" ]]; then
    printf 'Raw response for %s %s (expected X-Upstream: %s):\n%s\n' "$1" "$2" "$want" "$response" >&2
    docker logs "$p-proxy" >&2 2>&1 || true
    docker logs "$p-node" >&2 2>&1 || true
    fail "$1 $2 answered X-Upstream='$got', expected '$want'"
  fi
}

start() { # routes [docker run args...]
  local routes=${1:-}
  shift || true
  docker rm -f "$p-proxy" >/dev/null 2>&1 || true
  docker run -d --name "$p-proxy" --network "$net" -p 127.0.0.1::80 -e RUST_API_ROUTES="$routes" "$@" "$image" >/dev/null
  for _ in $(seq 20); do
    docker exec "$p-proxy" wget -qO- http://127.0.0.1/ >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  docker logs "$p-proxy" >&2
  fail "nginx did not start with RUST_API_ROUTES=$routes $*"
}
# The whole log, captured before matching: under pipefail, `docker logs | grep
# -q` can fail when grep exits at the first match and docker logs gets SIGPIPE.
logged() { # pattern label
  local logs
  logs=$(docker logs "$p-proxy" 2>&1)
  grep -qF -- "$1" <<<"$logs" || { printf '%s\n' "$logs" >&2; fail "$2"; }
}
included() { docker exec "$p-proxy" cat /etc/nginx/rust-api/upstreams.conf /etc/nginx/rust-api/locations.conf; }
fail() { echo "FAIL: $*" >&2; exit 1; }
expect() { # path want label
  local got
  got=$(get "$1")
  [[ $got == "$2" ]] || fail "$3: $1 answered '$got', expected '$2'"
}

start ""
expect /api/v3/math/pca2 node "flag off"
[[ -z $(docker exec "$p-proxy" cat /etc/nginx/rust-api/upstreams.conf /etc/nginx/rust-api/locations.conf) ]] \
  || fail "flag off: include files should be empty"
echo "ok 1 flag off: include files empty, pca2 -> node"

start pca2
expect /api/v3/math/pca2 node "polis-api absent at start"
echo "ok 2 flag on, polis-api absent at nginx start: nginx serves, pca2 -> node"

stub "$p-rust" polis-api 5100 200 rust
sleep 6 # past the resolver's 5 s cache of the earlier miss
expect '/api/v3/math/pca2?conversation_id=x' rust "polis-api up"
expect /api/v3/math/pca2/ node "polis-api up, other path"
expect /api/v3/comments node "polis-api up, other route"
echo "ok 3 polis-api up: pca2 -> polis-api, other paths -> node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "database unavailable"
sleep 6
expect /api/v3/math/pca2 node "polis-api 502"
echo "ok 4 polis-api answers 502: pca2 -> node"

docker rm -f "$p-rust" >/dev/null
expect /api/v3/math/pca2 node "polis-api died"
sleep 6
expect /api/v3/math/pca2 node "polis-api gone"
echo "ok 5 polis-api dies: pca2 -> node"

start pca2,bogus
expect /api/v3/math/pca2 node "unknown route name"
logged "ERROR RUST_API_ROUTES: unknown route" "unknown route not reported"
[[ -z $(included) ]] || fail "unknown route: include files should be empty"
echo "ok 6 unknown route name: nginx serves, error logged, everything -> node"

stub "$p-rust" polis-api 5100 200 rust
start pca2,pca2
expect '/api/v3/math/pca2?conversation_id=x' rust "route named twice"
[[ $(included | grep -c 'location = /api/v3/math/pca2') == 1 ]] || fail "route named twice: rendered more than once"
echo "ok 7 route named twice: rendered once, nginx serves, pca2 -> polis-api"

expect_upstream polis-api GET /api/v3/math/pca2
expect_upstream polis-api HEAD /api/v3/math/pca2
expect_upstream server OPTIONS /api/v3/math/pca2
expect_upstream server POST /api/v3/math/pca2 $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/math/pca2 $'Content-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n' '{}'

echo "ok 8 only GET/HEAD without a body reach polis-api; OPTIONS, POST, GET with a body -> node"

for bad in "RUST_API_UPSTREAM=bad host;" "RUST_API_RESOLVER=bad resolver" "RUST_API_RESOLVER=1.2.3.4; }"; do
  start pca2 -e "$bad"
  expect /api/v3/math/pca2 node "$bad"
  logged "ERROR RUST_API_" "$bad: not reported"
  [[ -z $(included) ]] || fail "$bad: include files should be empty"
done
echo "ok 9 bad upstream or resolver: nginx serves, error logged, everything -> node"

docker rm -f "$p-rust" >/dev/null
docker run -d --name "$p-rust" --network "$net" --network-alias polis-api --entrypoint sh nginx:1.21.5-alpine -c \
  'while true; do printf "HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nX-Upstream: polis-api\r\n\r\n1234567" | nc -l -p 5100 -w 1; done' >/dev/null
start pca2
sleep 1
partial=$(docker exec "$p-proxy" sh -c 'wget -qO- http://127.0.0.1/api/v3/math/pca2 2>/dev/null; echo " exit=$?"')
[[ $partial == "1234567 exit=1" ]] || fail "partial response: got '$partial'"
echo "ok 10 documented limit: a reply cut short after its headers reaches the client truncated (wget fails), not node"
