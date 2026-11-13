#!/usr/bin/env bash
# Checks the nginx-proxy routing switch against stub upstreams that answer
# with their own name: `server` (Node), `polis-api`, and the participation
# client, which the config also names.
#   1. RUST_API_ROUTES unset: both include files are empty; pca2 goes to Node.
#   2. pca2 on, polis-api container absent when nginx starts: nginx starts and
#      pca2 goes to Node.
#   3. polis-api appears later: pca2 goes to polis-api, other API paths to Node.
#   4. polis-api answers 502 (its database is unreachable): pca2 goes to Node.
#   5. polis-api container dies: pca2 goes to Node.
#   6. An unknown route name: nginx starts, logs an error, switchable routes go to Node.
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
python3 "$root/ci/host_ports.py" env X54_NGINX_PORT X54_FILES_PORT
p=${X54_NGINX_PREFIX:-nginx-routing-$$-${RANDOM}}
net="$p-net"
image=${X54_NGINX_IMAGE:-$p:local}
cleanup() {
  docker rm -f "$p-proxy" "$p-node" "$p-rust" "$p-alpha" "$p-files" "$p-shadow" "$p-reads" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
if [[ -z ${X54_NGINX_IMAGE:-} ]]; then
  docker build -q -t "$image" -f "$root/file-server/nginx.Dockerfile" "$root/file-server" >/dev/null
fi
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
  docker run -d --name "$p-proxy" --network "$net" -p "127.0.0.1:${X54_NGINX_PORT:-25466}:80" -e RUST_API_ROUTES="$routes" "$@" "$image" >/dev/null
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

# A near miss outside an API or registered page is now answered at the edge.
expect_not_found() {
  python3 - "$p-proxy" "$p-node" "$1" <<'PYTHON'
import http.client, subprocess, sys
proxy, node, path = sys.argv[1:]
def logs():
    return subprocess.check_output(['docker', 'logs', node], stderr=subprocess.STDOUT)
before = logs()
address = subprocess.check_output(['docker', 'port', proxy, '80/tcp'], text=True).strip()
host, port = address.rsplit(':', 1)
assert host == '127.0.0.1'
c = http.client.HTTPConnection(host, int(port), timeout=5)
c.request('GET', path)
r = c.getresponse()
assert r.status == 404 and ('Cannot GET ' + path).encode() in r.read(), path
c.close()
assert logs() == before, 'unregistered page reached Node: ' + path
PYTHON
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
echo "ok 6 unknown route name: nginx serves, error logged, switchable routes -> node"

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
echo "ok 9 bad upstream or resolver: nginx serves, error logged, switchable routes -> node"

docker rm -f "$p-rust" >/dev/null
docker run -d --name "$p-rust" --network "$net" --network-alias polis-api --entrypoint sh nginx:1.21.5-alpine -c \
  'while true; do printf "HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nX-Upstream: polis-api\r\n\r\n1234567" | nc -l -p 5100 -w 1; done' >/dev/null
start pca2
sleep 1
partial=$(docker exec "$p-proxy" sh -c 'wget -qO- http://127.0.0.1/api/v3/math/pca2 2>/dev/null; echo " exit=$?"')
[[ $partial == "1234567 exit=1" ]] || fail "partial response: got '$partial'"
echo "ok 10 documented limit: a reply cut short after its headers reaches the client truncated (wget fails), not node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/owner/conversations node "owner list off"
start owner-conversations,owner-conversations
expect /api/v3/owner/conversations rust "owner list on"
expect /api/v3/math/pca2 node "owner switch leaves pca2 alone"
expect /api/v3/comments node "owner switch leaves participation alone"
[[ $(included | grep -c 'location = /api/v3/owner/conversations') == 1 ]] || fail "owner route duplicated"
expect_upstream polis-api GET /api/v3/owner/conversations
expect_upstream polis-api HEAD /api/v3/owner/conversations
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 503 busy
sleep 6
[[ $(get /api/v3/owner/conversations) != node ]] || fail "owner unavailable fell back to Node"
echo "ok 11 owner contract off/on/deduplicated; unrelated routes unchanged; unavailable never falls back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/comments node "comments off"
expect "/api/v3/comments?conversation_id=fixture&moderation=true" node "moderation off"
start comments,comments
expect /api/v3/comments rust "comments on"
expect_upstream polis-api GET "/api/v3/comments?conversation_id=fixture&moderation=true"
expect_upstream polis-api GET "/api/v3/comments?conversation_id=fixture&moderation=true&include_voting_patterns=true" $'Authorization: Bearer fixture\r\n'
expect /api/v3/math/pca2 node "comments leaves pca2 alone"
expect /api/v3/owner/conversations node "comments leaves owner list alone"
[[ $(included | grep -c 'location = /api/v3/comments') == 1 ]] || fail "comments route duplicated"
expect_upstream polis-api GET /api/v3/comments
expect_upstream polis-api HEAD /api/v3/comments
expect_upstream server OPTIONS /api/v3/comments
expect_upstream server POST /api/v3/comments $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/comments $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 unavailable
sleep 6
expect /api/v3/comments node "comments boundary or unavailable"
expect "/api/v3/comments?conversation_id=fixture&moderation=true" node "moderation boundary or unavailable"
echo "ok 12 public comments off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/nextComment node "next comment off"
start nextComment,nextComment
expect /api/v3/nextComment rust "next comment on"
expect /api/v3/comments node "next comment leaves comments alone"
expect /api/v3/votes node "next comment leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/nextComment') == 1 ]] || fail "next comment duplicated"
expect_upstream polis-api GET /api/v3/nextComment
expect_upstream polis-api HEAD /api/v3/nextComment
expect_upstream server OPTIONS /api/v3/nextComment
expect_upstream server POST /api/v3/nextComment $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/nextComment $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/nextComment node "next comment handoff"
echo "ok 13 next comment off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/version node "version off"
start version,version
expect /api/v3/version rust "version on"
expect /api/v3/comments node "version leaves comments alone"
expect /api/v3/votes node "version leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/version') == 1 ]] || fail "version duplicated"
expect_upstream polis-api GET /api/v3/version
expect_upstream polis-api HEAD /api/v3/version
expect_upstream server OPTIONS /api/v3/version
expect_upstream server POST /api/v3/version $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/version $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/version node "version handoff"
echo "ok version version off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/testConnection node "connection probe off"
start testConnection,testConnection
expect /api/v3/testConnection rust "connection probe on"
expect /api/v3/comments node "connection probe leaves comments alone"
expect /api/v3/votes node "connection probe leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/testConnection') == 1 ]] || fail "connection probe duplicated"
expect_upstream polis-api GET /api/v3/testConnection
expect_upstream polis-api HEAD /api/v3/testConnection
expect_upstream server OPTIONS /api/v3/testConnection
expect_upstream server POST /api/v3/testConnection $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/testConnection $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/testConnection node "connection probe handoff"
echo "ok 14 connection probe off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /robots.txt node "robots off"
start robots,robots
expect /robots.txt rust "robots on"
expect /api/v3/comments node "robots leaves comments alone"
expect /api/v3/votes node "robots leaves voting alone"
[[ $(included | grep -c 'location = /robots.txt') == 1 ]] || fail "robots duplicated"
expect_upstream polis-api GET /robots.txt
expect_upstream polis-api HEAD /robots.txt
expect_upstream server OPTIONS /robots.txt
expect_upstream server POST /robots.txt $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /robots.txt $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /robots.txt node "robots handoff"
echo "ok 15 robots off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/testDatabase node "database probe off"
start testDatabase,testDatabase
expect /api/v3/testDatabase rust "database probe on"
expect /api/v3/comments node "database probe leaves comments alone"
expect /api/v3/votes node "database probe leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/testDatabase') == 1 ]] || fail "database probe duplicated"
expect_upstream polis-api GET /api/v3/testDatabase
expect_upstream polis-api HEAD /api/v3/testDatabase
expect_upstream server OPTIONS /api/v3/testDatabase
expect_upstream server POST /api/v3/testDatabase $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/testDatabase $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/testDatabase node "database probe handoff"
echo "ok 17 database probe off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/contexts node "contexts off"
start contexts,contexts
expect /api/v3/contexts rust "contexts on"
expect /api/v3/comments node "contexts leaves comments alone"
expect /api/v3/votes node "contexts leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/contexts') == 1 ]] || fail "contexts duplicated"
expect_upstream polis-api GET /api/v3/contexts
expect_upstream polis-api HEAD /api/v3/contexts
expect_upstream server OPTIONS /api/v3/contexts
expect_upstream server POST /api/v3/contexts $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/contexts $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/contexts node "contexts handoff"
echo "ok 18 contexts off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/domainWhitelist node "domainWhitelist off"
start domainWhitelist,domainWhitelist
expect /api/v3/domainWhitelist rust "domainWhitelist on"
expect /api/v3/comments node "domainWhitelist leaves comments alone"
expect /api/v3/votes node "domainWhitelist leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/domainWhitelist') == 1 ]] || fail "domainWhitelist duplicated"
expect_upstream polis-api GET /api/v3/domainWhitelist
expect_upstream polis-api HEAD /api/v3/domainWhitelist
expect_upstream server OPTIONS /api/v3/domainWhitelist
expect_upstream server POST /api/v3/domainWhitelist $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/domainWhitelist $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/domainWhitelist node "domainWhitelist handoff"
echo "ok 19 domainWhitelist off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/metadata/questions node "metadataQuestions off"
start metadataQuestions,metadataQuestions
expect /api/v3/metadata/questions rust "metadataQuestions on"
expect /api/v3/comments node "metadataQuestions leaves comments alone"
expect /api/v3/votes node "metadataQuestions leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/metadata/questions') == 1 ]] || fail "metadataQuestions duplicated"
expect_upstream polis-api GET /api/v3/metadata/questions
expect_upstream polis-api HEAD /api/v3/metadata/questions
expect_upstream server OPTIONS /api/v3/metadata/questions
expect_upstream server POST /api/v3/metadata/questions $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/metadata/questions $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/metadata/questions node "metadataQuestions handoff"
echo "ok 20 metadataQuestions off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/metadata/answers node "metadataAnswers off"
start metadataAnswers,metadataAnswers
expect /api/v3/metadata/answers rust "metadataAnswers on"
expect /api/v3/comments node "metadataAnswers leaves comments alone"
expect /api/v3/votes node "metadataAnswers leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/metadata/answers') == 1 ]] || fail "metadataAnswers duplicated"
expect_upstream polis-api GET /api/v3/metadata/answers
expect_upstream polis-api HEAD /api/v3/metadata/answers
expect_upstream server OPTIONS /api/v3/metadata/answers
expect_upstream server POST /api/v3/metadata/answers $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/metadata/answers $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/metadata/answers node "metadataAnswers handoff"
echo "ok 21 metadataAnswers off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/metadata node "metadataRead off"
start metadataRead,metadataRead
expect /api/v3/metadata rust "metadataRead on"
expect /api/v3/comments node "metadataRead leaves comments alone"
expect /api/v3/votes node "metadataRead leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/metadata') == 1 ]] || fail "metadataRead duplicated"
expect_upstream polis-api GET /api/v3/metadata
expect_upstream polis-api HEAD /api/v3/metadata
expect_upstream server OPTIONS /api/v3/metadata
expect_upstream server POST /api/v3/metadata $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/metadata $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/metadata node "metadataRead handoff"
echo "ok 22 metadataRead off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/metadata/choices node "metadataChoices off"
start metadataChoices,metadataChoices
expect /api/v3/metadata/choices rust "metadataChoices on"
expect /api/v3/comments node "metadataChoices leaves comments alone"
expect /api/v3/votes node "metadataChoices leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/metadata/choices') == 1 ]] || fail "metadataChoices duplicated"
expect_upstream polis-api GET /api/v3/metadata/choices
expect_upstream polis-api HEAD /api/v3/metadata/choices
expect_upstream server OPTIONS /api/v3/metadata/choices
expect_upstream server POST /api/v3/metadata/choices $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/metadata/choices $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/metadata/choices node "metadataChoices handoff"
echo "ok 23 metadataChoices off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/conversations/recently_started node "recentStarted off"
start recentStarted,recentStarted
expect /api/v3/conversations/recently_started rust "recentStarted on"
expect /api/v3/comments node "recentStarted leaves comments alone"
expect /api/v3/votes node "recentStarted leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/conversations/recently_started') == 1 ]] || fail "recentStarted duplicated"
expect_upstream polis-api GET /api/v3/conversations/recently_started
expect_upstream polis-api HEAD /api/v3/conversations/recently_started
expect_upstream server OPTIONS /api/v3/conversations/recently_started
expect_upstream server POST /api/v3/conversations/recently_started $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/conversations/recently_started $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/conversations/recently_started node "recentStarted handoff"
echo "ok 24 recentStarted off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/conversations/recent_activity node "recentActivity off"
start recentActivity,recentActivity
expect /api/v3/conversations/recent_activity rust "recentActivity on"
expect /api/v3/comments node "recentActivity leaves comments alone"
expect /api/v3/votes node "recentActivity leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/conversations/recent_activity') == 1 ]] || fail "recentActivity duplicated"
expect_upstream polis-api GET /api/v3/conversations/recent_activity
expect_upstream polis-api HEAD /api/v3/conversations/recent_activity
expect_upstream server OPTIONS /api/v3/conversations/recent_activity
expect_upstream server POST /api/v3/conversations/recent_activity $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/conversations/recent_activity $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/conversations/recent_activity node "recentActivity handoff"
echo "ok 25 recentActivity off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/treevite/waves node "treeviteWaves off"
start treeviteWaves,treeviteWaves
expect /api/v3/treevite/waves rust "treeviteWaves on"
expect /api/v3/comments node "treeviteWaves leaves comments alone"
expect /api/v3/votes node "treeviteWaves leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/treevite/waves') == 1 ]] || fail "treeviteWaves duplicated"
expect_upstream polis-api GET /api/v3/treevite/waves
expect_upstream polis-api HEAD /api/v3/treevite/waves
expect_upstream server OPTIONS /api/v3/treevite/waves
expect_upstream server POST /api/v3/treevite/waves $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/treevite/waves $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/treevite/waves node "treeviteWaves handoff"
echo "ok 27 treeviteWaves off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/treevite/invites node "treeviteInvites off"
start treeviteInvites,treeviteInvites
expect /api/v3/treevite/invites rust "treeviteInvites on"
expect /api/v3/comments node "treeviteInvites leaves comments alone"
expect /api/v3/votes node "treeviteInvites leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/treevite/invites') == 1 ]] || fail "treeviteInvites duplicated"
expect_upstream polis-api GET /api/v3/treevite/invites
expect_upstream polis-api HEAD /api/v3/treevite/invites
expect_upstream server OPTIONS /api/v3/treevite/invites
expect_upstream server POST /api/v3/treevite/invites $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/treevite/invites $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/treevite/invites node "treeviteInvites handoff"
echo "ok 28 treeviteInvites off/on/deduplicated; method/body guards; 502 hands back to Node"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/treevite/invites/csv node "treeviteCsv off"
start treeviteCsv,treeviteCsv
expect /api/v3/treevite/invites/csv rust "treeviteCsv on"
expect /api/v3/comments node "treeviteCsv leaves comments alone"
expect /api/v3/votes node "treeviteCsv leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/treevite/invites/csv') == 1 ]] || fail "treeviteCsv duplicated"
expect_upstream polis-api GET /api/v3/treevite/invites/csv
expect_upstream polis-api HEAD /api/v3/treevite/invites/csv
expect_upstream server OPTIONS /api/v3/treevite/invites/csv
expect_upstream server POST /api/v3/treevite/invites/csv $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/treevite/invites/csv $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/treevite/invites/csv node "treeviteCsv handoff"
echo "ok 29 treeviteCsv off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/conversations/preload node "conversationPreload off"
start conversationPreload,conversationPreload
expect /api/v3/conversations/preload rust "conversationPreload on"
expect /api/v3/comments node "conversationPreload leaves comments alone"
expect /api/v3/votes node "conversationPreload leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/conversations/preload') == 1 ]] || fail "conversationPreload duplicated"
expect_upstream polis-api GET /api/v3/conversations/preload
expect_upstream polis-api HEAD /api/v3/conversations/preload
expect_upstream server OPTIONS /api/v3/conversations/preload
expect_upstream server POST /api/v3/conversations/preload $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/conversations/preload $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/conversations/preload node "conversationPreload handoff"
echo "ok 30 conversationPreload off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/participation node "participationRead off"
start participationRead,participationRead
expect /api/v3/participation rust "participationRead on"
expect /api/v3/comments node "participationRead leaves comments alone"
expect /api/v3/votes node "participationRead leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/participation') == 1 ]] || fail "participationRead duplicated"
expect_upstream polis-api GET /api/v3/participation
expect_upstream polis-api HEAD /api/v3/participation
expect_upstream server OPTIONS /api/v3/participation
expect_upstream server POST /api/v3/participation $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/participation $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/participation node "participationRead handoff"
echo "ok 31 participationRead off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/all_conversations node "allConversations off"
start allConversations,allConversations
expect /api/v3/all_conversations rust "allConversations on"
expect /api/v3/comments node "allConversations leaves comments alone"
expect /api/v3/votes node "allConversations leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/all_conversations') == 1 ]] || fail "allConversations duplicated"
expect_upstream polis-api GET /api/v3/all_conversations
expect_upstream polis-api HEAD /api/v3/all_conversations
expect_upstream server OPTIONS /api/v3/all_conversations
expect_upstream server POST /api/v3/all_conversations $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/all_conversations $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/all_conversations node "allConversations handoff"
echo "ok 32 allConversations off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/reports node "reportsRead off"
start reportsRead,reportsRead
expect /api/v3/reports rust "reportsRead on"
expect /api/v3/comments node "reportsRead leaves comments alone"
expect /api/v3/votes node "reportsRead leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/reports') == 1 ]] || fail "reportsRead duplicated"
expect_upstream polis-api GET /api/v3/reports
expect_upstream polis-api HEAD /api/v3/reports
expect_upstream server OPTIONS /api/v3/reports
expect_upstream server POST /api/v3/reports $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/reports $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/reports node "reportsRead handoff"
echo "ok 33 reportsRead off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/bidToPid node "bidToPid off"
start bidToPid,bidToPid
expect /api/v3/bidToPid rust "bidToPid on"
expect /api/v3/comments node "bidToPid leaves comments alone"
expect /api/v3/votes node "bidToPid leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/bidToPid') == 1 ]] || fail "bidToPid duplicated"
expect_upstream polis-api GET /api/v3/bidToPid
expect_upstream polis-api HEAD /api/v3/bidToPid
expect_upstream server OPTIONS /api/v3/bidToPid
expect_upstream server POST /api/v3/bidToPid $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/bidToPid $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/bidToPid node "bidToPid handoff"
echo "ok 34 bidToPid off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/conversationStats node "conversationStats off"
start conversationStats,conversationStats
expect /api/v3/conversationStats rust "conversationStats on"
expect /api/v3/comments node "conversationStats leaves comments alone"
expect /api/v3/votes node "conversationStats leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/conversationStats') == 1 ]] || fail "conversationStats duplicated"
expect_upstream polis-api GET /api/v3/conversationStats
expect_upstream polis-api HEAD /api/v3/conversationStats
expect_upstream server OPTIONS /api/v3/conversationStats
expect_upstream server POST /api/v3/conversationStats $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/conversationStats $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/conversationStats node "conversationStats handoff"
echo "ok 35 conversationStats off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/topicAgenda/selections node "topicSelections off"
start topicSelections,topicSelections
expect /api/v3/topicAgenda/selections rust "topicSelections on"
expect /api/v3/comments node "topicSelections leaves comments alone"
expect /api/v3/votes node "topicSelections leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/topicAgenda/selections') == 1 ]] || fail "topicSelections duplicated"
expect_upstream polis-api GET /api/v3/topicAgenda/selections
expect_upstream polis-api HEAD /api/v3/topicAgenda/selections
expect_upstream server OPTIONS /api/v3/topicAgenda/selections
expect_upstream server POST /api/v3/topicAgenda/selections $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/topicAgenda/selections $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/topicAgenda/selections node "topicSelections handoff"
echo "ok 36 topicSelections off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/treevite/myInvites node "treeviteMyInvites off"
start treeviteMyInvites,treeviteMyInvites
expect /api/v3/treevite/myInvites rust "treeviteMyInvites on"
expect /api/v3/comments node "treeviteMyInvites leaves comments alone"
expect /api/v3/votes node "treeviteMyInvites leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/treevite/myInvites') == 1 ]] || fail "treeviteMyInvites duplicated"
expect_upstream polis-api GET /api/v3/treevite/myInvites
expect_upstream polis-api HEAD /api/v3/treevite/myInvites
expect_upstream server OPTIONS /api/v3/treevite/myInvites
expect_upstream server POST /api/v3/treevite/myInvites $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/treevite/myInvites $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/treevite/myInvites node "treeviteMyInvites handoff"
echo "ok 37 treeviteMyInvites off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/participation/topicPrioritize node "topicPrioritize off"
start topicPrioritize,topicPrioritize
expect /api/v3/participation/topicPrioritize rust "topicPrioritize on"
expect /api/v3/comments node "topicPrioritize leaves comments alone"
expect /api/v3/votes node "topicPrioritize leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/participation/topicPrioritize') == 1 ]] || fail "topicPrioritize duplicated"
expect_upstream polis-api GET /api/v3/participation/topicPrioritize
expect_upstream polis-api HEAD /api/v3/participation/topicPrioritize
expect_upstream server OPTIONS /api/v3/participation/topicPrioritize
expect_upstream server POST /api/v3/participation/topicPrioritize $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/participation/topicPrioritize $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/participation/topicPrioritize node "topicPrioritize handoff"
echo "ok 38 topicPrioritize off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/conversations node "legacyConversations off"
start legacyConversations,legacyConversations
expect /api/v3/conversations rust "legacyConversations on"
expect /api/v3/comments node "legacyConversations leaves comments alone"
expect /api/v3/votes node "legacyConversations leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/conversations') == 1 ]] || fail "legacyConversations duplicated"
expect_upstream polis-api GET /api/v3/conversations
expect_upstream polis-api HEAD /api/v3/conversations
expect_upstream server OPTIONS /api/v3/conversations
expect_upstream server POST /api/v3/conversations $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/conversations $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/conversations node "legacyConversations handoff"
echo "ok 39 legacyConversations off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/treevite/me node "treeviteMe off"
start treeviteMe,treeviteMe
expect /api/v3/treevite/me rust "treeviteMe on"
expect /api/v3/comments node "treeviteMe leaves comments alone"
expect /api/v3/votes node "treeviteMe leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/treevite/me') == 1 ]] || fail "treeviteMe duplicated"
expect_upstream polis-api GET /api/v3/treevite/me
expect_upstream polis-api HEAD /api/v3/treevite/me
expect_upstream server OPTIONS /api/v3/treevite/me
expect_upstream server POST /api/v3/treevite/me $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/treevite/me $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/treevite/me node "treeviteMe handoff"
echo "ok 40 treeviteMe off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv node "xidReport off"
start xidReport,xidReport
expect /api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv rust "xidReport on"
expect /api/v3/comments node "xidReport leaves comments alone"
expect /api/v3/xids node "xidReport leaves plural route alone"
expect /api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv/extra node "xidReport regex is anchored"
expect /api/v3/votes node "xidReport leaves voting alone"
[[ $(included | grep -F -c 'location ~ ^/api/v3/xid/[^/]+$') == 1 ]] || fail "xidReport duplicated"
expect_upstream polis-api GET /api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv
expect_upstream polis-api HEAD /api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv
expect_upstream server OPTIONS /api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv
expect_upstream server POST /api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv node "xidReport handoff"
echo "ok 41 xidReport off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/einvites node "einvitesRead off"
start einvitesRead,einvitesRead
expect /api/v3/einvites rust "einvitesRead on"
expect /api/v3/comments node "einvitesRead leaves comments alone"
expect /api/v3/votes node "einvitesRead leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/einvites') == 1 ]] || fail "einvitesRead duplicated"
expect_upstream polis-api GET /api/v3/einvites
expect_upstream polis-api HEAD /api/v3/einvites
expect_upstream server OPTIONS /api/v3/einvites
expect_upstream server POST /api/v3/einvites $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/einvites $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/einvites node "einvitesRead handoff"
echo "ok 42 einvitesRead off/on/deduplicated; method/body guards; 502 hands back to Node"
























docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /m/2fixture node "adminPage off"
start adminPage,adminPage
expect /m/2fixture rust "adminPage on"
expect /m/2fixture/step rust "adminPage nested path"
expect /m/2fixtureSuffix rust "adminPage prefix suffix"
expect_not_found /m/2 "adminPage neighbor"
expect /api/v3/comments node "adminPage leaves comments alone"
expect /api/v3/votes node "adminPage leaves voting alone"
[[ $(included | grep -Fc 'location ~ ^/m/[0-9]') == 1 ]] || fail "adminPage duplicated"
expect_upstream polis-api GET /m/2fixture
expect_upstream polis-api HEAD /m/2fixture
expect_upstream server OPTIONS /m/2fixture
expect_upstream server POST /m/2fixture $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /m/2fixture $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /m/2fixture node "adminPage handoff"
echo "ok 48 adminPage off/on/deduplicated; method/body guards; 502 hands back to Node"



docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /integrate node "integratePage off"
start integratePage,integratePage
expect /integrate rust "integratePage on"
expect /integrate/step rust "integratePage nested path"
expect /integrateSuffix rust "integratePage prefix suffix"
expect_not_found /integrat "integratePage neighbor"
expect /api/v3/comments node "integratePage leaves comments alone"
expect /api/v3/votes node "integratePage leaves voting alone"
[[ $(included | grep -Fc 'location ~ ^/integrate') == 1 ]] || fail "integratePage duplicated"
expect_upstream polis-api GET /integrate
expect_upstream polis-api HEAD /integrate
expect_upstream server OPTIONS /integrate
expect_upstream server POST /integrate $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /integrate $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /integrate node "integratePage handoff"
echo "ok 49 integratePage off/on/deduplicated; method/body guards; 502 hands back to Node"







docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/delphi node "Delphi report validation off"
start delphiRead,delphiRead
expect /api/v3/delphi rust "Delphi report validation on"
expect /api/v3/comments node "Delphi report validation leaves comments alone"
expect /api/v3/votes node "Delphi report validation leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/delphi') == 1 ]] || fail "Delphi report validation duplicated"
expect_upstream polis-api GET /api/v3/delphi
expect_upstream polis-api GET "/api/v3/delphi?report_id=generated-report" $'Authorization: Bearer ignored\r\n'
expect_upstream polis-api HEAD /api/v3/delphi
expect_upstream server OPTIONS /api/v3/delphi
expect_upstream server POST /api/v3/delphi $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/delphi $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/delphi node "Delphi report validation handoff"
echo "ok 51 Delphi report validation off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/delphi/reports node "Delphi narrative report validation off"
start delphiReports,delphiReports
expect /api/v3/delphi/reports rust "Delphi narrative report validation on"
expect /api/v3/comments node "Delphi narrative report validation leaves comments alone"
expect /api/v3/votes node "Delphi narrative report validation leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/delphi/reports') == 1 ]] || fail "Delphi narrative report validation duplicated"
expect_upstream polis-api GET /api/v3/delphi/reports
expect_upstream polis-api GET '/api/v3/delphi/reports?report_id=generated&job_id=old&section=global&topic_key=report_data' $'Authorization: Bearer generated\r\n'
expect_upstream polis-api HEAD /api/v3/delphi/reports
expect_upstream server OPTIONS /api/v3/delphi/reports
expect_upstream server POST /api/v3/delphi/reports $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/delphi/reports $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/delphi/reports node "Delphi narrative report validation handoff"
echo "ok 52 Delphi narrative report validation off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/delphi/visualizations node "Delphi visualization validation off"
start delphiVisualizations,delphiVisualizations
expect /api/v3/delphi/visualizations rust "Delphi visualization validation on"
expect /api/v3/comments node "Delphi visualization validation leaves comments alone"
expect /api/v3/votes node "Delphi visualization validation leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/delphi/visualizations') == 1 ]] || fail "Delphi visualization validation duplicated"
expect_upstream polis-api GET /api/v3/delphi/visualizations
expect_upstream polis-api HEAD /api/v3/delphi/visualizations
expect_upstream server OPTIONS /api/v3/delphi/visualizations
expect_upstream server POST /api/v3/delphi/visualizations $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/delphi/visualizations $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/delphi/visualizations node "Delphi visualization validation handoff"
# Query filters and arbitrary Authorization stay intact on this public route.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start delphiVisualizations
expect_upstream polis-api GET '/api/v3/delphi/visualizations?report_id=r&job_id=generated-job' $'Authorization: Bearer generated\r\n'
echo "ok 53 Delphi visualization validation off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/topicStats node "Topic statistics validation off"
start topicStats,topicStats
expect /api/v3/topicStats rust "Topic statistics validation on"
expect /api/v3/comments node "Topic statistics validation leaves comments alone"
expect /api/v3/votes node "Topic statistics validation leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/topicStats') == 1 ]] || fail "Topic statistics validation duplicated"
expect_upstream polis-api GET /api/v3/topicStats
expect_upstream polis-api HEAD /api/v3/topicStats
expect_upstream server OPTIONS /api/v3/topicStats
expect_upstream server POST /api/v3/topicStats $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/topicStats $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/topicStats node "Topic statistics validation handoff"
echo "ok 54 Topic statistics validation off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/collectiveStatement node "Collective statement validation off"
start collectiveStatement,collectiveStatement
expect /api/v3/collectiveStatement rust "Collective statement validation on"
expect /api/v3/comments node "Collective statement validation leaves comments alone"
expect /api/v3/votes node "Collective statement validation leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/collectiveStatement') == 1 ]] || fail "Collective statement validation duplicated"
expect_upstream polis-api GET /api/v3/collectiveStatement
expect_upstream polis-api HEAD /api/v3/collectiveStatement
expect_upstream server OPTIONS /api/v3/collectiveStatement
expect_upstream server POST /api/v3/collectiveStatement $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/collectiveStatement $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/collectiveStatement node "Collective statement validation handoff"
echo "ok 55 Collective statement validation off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/ops/whoami node "Disabled operations identity off"
start opsWhoami,opsWhoami
expect /api/v3/ops/whoami rust "Disabled operations identity on"
expect /api/v3/comments node "Disabled operations identity leaves comments alone"
expect /api/v3/votes node "Disabled operations identity leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/ops/whoami') == 1 ]] || fail "Disabled operations identity duplicated"
expect_upstream polis-api GET /api/v3/ops/whoami
expect_upstream polis-api HEAD /api/v3/ops/whoami
expect_upstream server OPTIONS /api/v3/ops/whoami
expect_upstream server POST /api/v3/ops/whoami $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/ops/whoami $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/ops/whoami node "Disabled operations identity handoff"
echo "ok 56 Disabled operations identity off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/ops/page/fixture node "Disabled operations page off"
start opsPage,opsPage
expect /api/v3/ops/page/fixture rust
expect /api/v3/ops/page/overview rust "Disabled operations page on"
expect /api/v3/comments node "Disabled operations page leaves comments alone"
expect /api/v3/votes node "Disabled operations page leaves voting alone"
[[ $(included | grep -Fc 'location ^~ /api/v3/ops/page/ {') == 1 ]] || fail "Disabled operations page duplicated"
expect_upstream polis-api GET /api/v3/ops/page/fixture
expect_upstream polis-api HEAD /api/v3/ops/page/fixture
expect_upstream server OPTIONS /api/v3/ops/page/fixture
expect_upstream server POST /api/v3/ops/page/fixture $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/ops/page/fixture $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/ops/page/fixture node "Disabled operations page handoff"
echo "ok 57 Disabled operations page off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/ops/unknown node "Operations catch-all off"
start opsCatchall,opsCatchall
expect /api/v3/ops/unknown rust
expect /api/v3/ops rust "Operations catch-all root"
expect /api/v3/ops/ rust "Operations catch-all slash"
expect /api/v3/ops/a/child rust "Operations catch-all nested"
expect /api/v3/ops/whoami node "Catch-all preserves identity switch"
expect /api/v3/ops/page/overview node "Catch-all preserves page switch"
expect /api/v3/opsOther node "Catch-all prefix boundary"
expect /api/v3/comments node "Operations catch-all leaves comments alone"
expect /api/v3/votes node "Operations catch-all leaves voting alone"
[[ $(included | grep -Fc 'location ~ ^/api/v3/ops(?:$|/(?!whoami(?:/|$)|page(?:/|$))) {') == 1 ]] || fail "Operations catch-all duplicated"
expect_upstream polis-api GET /api/v3/ops/unknown
expect_upstream polis-api HEAD /api/v3/ops/unknown
expect_upstream server OPTIONS /api/v3/ops/unknown
expect_upstream server POST /api/v3/ops/unknown $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/ops/unknown $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/ops/unknown node "Operations catch-all handoff"
echo "ok 58 Operations catch-all off/on/deduplicated; method/body guards; 502 hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/delphi/run node "Run record off"
start delphiRun,delphiRun
expect '/api/v3/delphi/run?job_id=x' rust "Run record on"
expect /api/v3/delphi node "Run record leaves the Delphi topics route alone"
expect /api/v3/delphi/logs node "Run record leaves job logs alone"
expect /api/v3/delphi/runs node "Run record path is exact"
expect /api/v3/comments node "Run record leaves comments alone"
expect /api/v3/votes node "Run record leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/delphi/run') == 1 ]] || fail "Run record duplicated"
expect_upstream polis-api GET /api/v3/delphi/run
expect_upstream polis-api HEAD /api/v3/delphi/run
expect_upstream server OPTIONS /api/v3/delphi/run
expect_upstream server POST /api/v3/delphi/run $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/delphi/run $'Content-Length: 2\r\n' '{}'
# Node has no handler for this path, so a hand-back reaches Node's 404.
docker rm -f "$p-rust" "$p-node" >/dev/null
stub "$p-node" server 5000 404 "Cannot GET /api/v3/delphi/run"
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect_upstream server GET '/api/v3/delphi/run?job_id=x'
handback=$(docker exec "$p-proxy" wget -S -qO- 'http://127.0.0.1/api/v3/delphi/run?job_id=x' 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | head -1 || true)
[[ $handback == "HTTP/1.1 404" ]] || fail "Run record handoff answered '$handback', expected Node's 404"
docker rm -f "$p-node" >/dev/null
stub "$p-node" server 5000 200 node
echo "ok 59 Run record off/on/deduplicated; method/body guards; 502 hands back to Node, whose 404 answers (no Node handler)"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/delphi/runs/x node "Typed result off"
start delphiResult,delphiResult
expect '/api/v3/delphi/runs/x?families=assignments' rust "Typed result on"
expect /api/v3/delphi node "Typed result leaves the Delphi topics route alone"
expect /api/v3/delphi/logs node "Typed result leaves job logs alone"
expect /api/v3/delphi/run node "Typed result path is exact"
expect /api/v3/comments node "Typed result leaves comments alone"
expect /api/v3/votes node "Typed result leaves voting alone"
[[ $(included | grep -c 'location ~.*delphi/runs/') == 1 ]] || fail "Typed result duplicated"
expect_upstream polis-api GET /api/v3/delphi/runs/x
expect_upstream polis-api HEAD /api/v3/delphi/runs/x
expect_upstream server OPTIONS /api/v3/delphi/runs/x
expect_upstream server POST /api/v3/delphi/runs/x $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/delphi/runs/x $'Content-Length: 2\r\n' '{}'
# Node has no handler for this path, so a hand-back reaches Node's 404.
docker rm -f "$p-rust" "$p-node" >/dev/null
stub "$p-node" server 5000 404 "Cannot GET /api/v3/delphi/runs/x"
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect_upstream server GET '/api/v3/delphi/runs/x?families=assignments'
handback=$(docker exec "$p-proxy" wget -S -qO- 'http://127.0.0.1/api/v3/delphi/runs/x?families=assignments' 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | head -1 || true)
[[ $handback == "HTTP/1.1 404" ]] || fail "Typed result handoff answered '$handback', expected Node's 404"
docker rm -f "$p-node" >/dev/null
stub "$p-node" server 5000 200 node
echo "ok 60 Typed result off/on/deduplicated; method/body guards; 502 hands back to Node, whose 404 answers (no Node handler)"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/statements/importance node "Statement importance off"
start statementImportance,statementImportance
expect '/api/v3/statements/importance?conversation_id=fixture' rust "Statement importance on"
expect /api/v3/delphi node "Statement importance leaves the Delphi topics route alone"
expect /api/v3/delphi/logs node "Statement importance leaves job logs alone"
expect /api/v3/delphi/run node "Statement importance path is exact"
expect /api/v3/comments node "Statement importance leaves comments alone"
expect /api/v3/votes node "Statement importance leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/statements/importance') == 1 ]] || fail "Statement importance duplicated"
expect_upstream polis-api GET /api/v3/statements/importance
expect_upstream polis-api HEAD /api/v3/statements/importance
expect_upstream server OPTIONS /api/v3/statements/importance
expect_upstream server POST /api/v3/statements/importance $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/statements/importance $'Content-Length: 2\r\n' '{}'
# Node has no handler for this path, so a hand-back reaches Node's 404.
docker rm -f "$p-rust" "$p-node" >/dev/null
stub "$p-node" server 5000 404 "Cannot GET /api/v3/statements/importance"
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect_upstream server GET '/api/v3/statements/importance?conversation_id=fixture'
handback=$(docker exec "$p-proxy" wget -S -qO- 'http://127.0.0.1/api/v3/statements/importance?conversation_id=fixture' 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | head -1 || true)
[[ $handback == "HTTP/1.1 404" ]] || fail "Statement importance handoff answered '$handback', expected Node's 404"
docker rm -f "$p-node" >/dev/null
stub "$p-node" server 5000 200 node
echo "ok 61 Statement importance off/on/deduplicated; method/body guards; 502 hands back to Node, whose 404 answers (no Node handler)"


docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/delphi/logs node "Logs off"
start delphiLogs,delphiLogs
expect '/api/v3/delphi/logs?job_id=x' rust "Logs on"
expect /api/v3/delphi/run node "Logs leave run record alone"
expect /api/v3/delphi/logs/ node "Logs path is exact"
expect /api/v3/comments node "Logs leave comments alone"
expect /api/v3/votes node "Logs leave votes alone"
[[ $(included | grep -c 'location = /api/v3/delphi/logs') == 1 ]] || fail "Logs duplicated"
expect_upstream polis-api GET /api/v3/delphi/logs $'Authorization: Bearer generated\r\n'
expect_upstream polis-api HEAD /api/v3/delphi/logs
expect_upstream server OPTIONS /api/v3/delphi/logs
expect_upstream server POST /api/v3/delphi/logs $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/delphi/logs $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/delphi/logs node "Logs handoff"
echo "ok 62 Logs off/on/deduplicated; method/body guards; 502 hands back to Node"

# Both vote read paths share a selector; POST remains entirely on Node.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/votes node "vote reads off"
expect /api/v3/votes/me node "personal reads off"
start votesRead,votesRead
for path in /api/v3/votes /api/v3/votes/me; do
  expect "$path" rust "vote reads on"
  expect_upstream polis-api HEAD "$path"
  expect_upstream server OPTIONS "$path"
  expect_upstream server POST "$path" $'Content-Length: 2\r\n' '{}'
  expect_upstream server GET "$path" $'Content-Length: 2\r\n' '{}'
done
[[ $(included | grep -c 'location = /api/v3/votes {') == 1 ]] || fail "vote reads duplicated"
[[ $(included | grep -c 'location = /api/v3/votes/me {') == 1 ]] || fail "personal reads duplicated"
expect /api/v3/nextComment node "vote reads leave participation alone"
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/votes node "vote reads handoff"
expect /api/v3/votes/me node "personal reads handoff"
echo "ok vote read routes: off/on/deduplicated, methods/body, fallback"

# The vote write has its own default-off selector, postVotes. Only a POST with
# a small body of known length reaches polis-api; GET and HEAD keep the
# votesRead selection. Node takes a POST back, with its whole body, only when
# the vote cannot have been written: polis-api marked its 502 (it does so only
# before dispatch) or no byte of the request reached polis-api. Any other
# failure may follow a written vote, so nginx answers it and Node is not
# called. Here Node answers with the method and the body it received, and the
# polis-api stand-in picks its reply from the request's X-Stub header.
echo_node() {
  docker rm -f "$p-node" >/dev/null 2>&1 || true
  docker run -d --name "$p-node" --network "$net" --network-alias server --entrypoint sh nginx:1.21.5-alpine -c '
    sed -i "1i load_module /usr/lib/nginx/modules/ngx_http_js_module.so;" /etc/nginx/nginx.conf
    printf "%s\n" "function echo(r) { r.return(200, r.method + \" \" + (r.requestText || \"\")); }" "export default {echo};" >/etc/nginx/echo.js
    printf "%s\n" "js_import echo from /etc/nginx/echo.js;" "server { listen 5000; client_body_buffer_size 64k; client_body_in_single_buffer on; location / { add_header X-Upstream server always; js_content echo.echo; } }" >/etc/nginx/conf.d/default.conf
    exec nginx -g "daemon off;"' >/dev/null
}
vote_rust() { # reads the whole body, as polis-api does, before it answers
  docker rm -f "$p-rust" >/dev/null 2>&1 || true
  docker run -d --name "$p-rust" --network "$net" --network-alias polis-api --entrypoint sh nginx:1.21.5-alpine -c '
    sed -i "1i load_module /usr/lib/nginx/modules/ngx_http_js_module.so;" /etc/nginx/nginx.conf
    printf "%s\n" "function reply(r) {" \
      "  var stub = r.headersIn[\"X-Stub\"] || \"\";" \
      "  if (stub === \"marked\") r.headersOut[\"X-Polis-Vote-Dispatch\"] = \"not-started\";" \
      "  var status = {marked: 502, unmarked: 502, \"202\": 202, \"403\": 403, \"500\": 500}[stub] || 200;" \
      "  r.return(status, stub ? stub : \"writer\");" \
      "}" "export default {reply};" >/etc/nginx/reply.js
    printf "%s\n" "js_import reply from /etc/nginx/reply.js;" "server { listen 5100; client_body_buffer_size 64k; client_body_in_single_buffer on; location / { add_header X-Upstream polis-api always; if (\$http_x_stub = closed) { return 444; } js_content reply.reply; } }" >/etc/nginx/conf.d/default.conf
    exec nginx -g "daemon off;"' >/dev/null
}
node_posts() { # POSTs to the vote path that reached Node
  local logs
  logs=$(docker logs "$p-node" 2>&1)
  grep -c '"POST /api/v3/votes HTTP' <<<"$logs" || true
}
vote_request() { # method [header lines] [body]: one HTTP/1.1 request; prints status, X-Upstream, body
  # With vote_split=1 the body is sent in two parts, 0.5 s apart.
  python3 - "$p-proxy" "${vote_split:-0}" "$@" <<'PYTHON'
import http.client
import socket
import subprocess
import sys
import time

proxy, split, method, *rest = sys.argv[1:]
headers, body = (rest + ["", ""])[:2]
request = (f"{method} /api/v3/votes HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
           f"{headers}\r\n").encode()
body = body.encode()
address = subprocess.check_output(["docker", "port", proxy, "80/tcp"], text=True).strip()
host, port = address.rsplit(":", 1)
assert host == "127.0.0.1", f"test proxy must bind loopback only: {address}"
with socket.create_connection((host, int(port)), timeout=15) as client:
    if split == "1":
        client.sendall(request + body[:len(body) // 2])
        time.sleep(0.5)
        client.sendall(body[len(body) // 2:])
    else:
        client.sendall(request + body)
    response = http.client.HTTPResponse(client, method=method)
    response.begin()
    payload = response.read()
print(response.status)
print(response.getheader("X-Upstream") or "")
sys.stdout.write(payload.decode())
PYTHON
}
expect_vote() { # label status upstream body|'*' method [header lines] [body]
  local label=$1 status=$2 upstream=$3 body=$4 response
  shift 4
  response=$(vote_request "$@") || fail "$label: transport failed"
  if [[ $(sed -n 1p <<<"$response") != "$status" || $(sed -n 2p <<<"$response") != "$upstream" ||
        ( $body != '*' && $(sed -n '3,$p' <<<"$response") != "$body" ) ]]; then
    printf 'Response for %s (expected %s from %s):\n%s\n' "$label" "$status" "${upstream:-nginx}" "${response:0:300}" >&2
    docker logs "$p-proxy" 2>&1 | tail -20 >&2 || true
    fail "$label"
  fi
}
# No stand-in reads the vote, so it is a pass: no sign is restated here.
vote_body='{"conversation_id":"2fixture","tid":0,"vote":0,"agid":1,"pid":"mypid","lang":"en"}'
vote_json=$'Content-Type: application/json\r\nContent-Length: '"${#vote_body}"$'\r\n'
largest=$(printf '%09999d' 0)

docker rm -f "$p-rust" >/dev/null
vote_rust
echo_node
start ""
expect_vote "vote write off" 200 server "POST $vote_body" POST "$vote_json" "$vote_body"
start postVotes,postVotes
[[ $(included | grep -c 'location = /api/v3/votes {') == 1 ]] || fail "vote write duplicated"
[[ $(included | grep -c 'location = /api/v3/votes/me {') == 0 ]] || fail "vote write alone selected the personal vote read"
expect_vote "vote write on" 200 polis-api writer POST "$vote_json" "$vote_body"
expect_vote "largest admitted body" 200 polis-api writer POST $'Content-Length: 9999\r\n' "$largest"
expect_vote "body of unknown length" 200 server "POST $vote_body" POST $'Transfer-Encoding: chunked\r\n' \
  "$(printf '%x' "${#vote_body}")"$'\r\n'"$vote_body"$'\r\n0\r\n\r\n'
expect_vote "larger body" 200 server "POST ${largest}0" POST $'Content-Length: 10000\r\n' "${largest}0"
expect_vote "empty body" 200 server "POST " POST $'Content-Length: 0\r\n'
expect_upstream server GET /api/v3/votes
expect_upstream server HEAD /api/v3/votes
expect_upstream server OPTIONS /api/v3/votes
expect_upstream server PUT /api/v3/votes $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/votes/me
expect_upstream server POST /api/v3/votes/me $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/nextComment
expect_upstream server POST /api/v3/comments $'Content-Length: 2\r\n' '{}'
for status in 202 403 500; do
  expect_vote "writer $status passes through" "$status" polis-api '*' POST "$vote_json"$'X-Stub: '"$status"$'\r\n' "$vote_body"
done
before=$(node_posts)
expect_vote "marked hand-back" 200 server "POST $vote_body" POST "$vote_json"$'X-Stub: marked\r\n' "$vote_body"
expect_vote "marked hand-back of the largest body" 200 server "POST $largest" POST $'Content-Length: 9999\r\nX-Stub: marked\r\n' "$largest"
vote_split=1
expect_vote "marked hand-back of a body that arrives in two parts" 200 server "POST $vote_body" POST "$vote_json"$'X-Stub: marked\r\n' "$vote_body"
vote_split=0
[[ $(node_posts) == $((before + 3)) ]] || fail "marked hand-back: Node saw $(( $(node_posts) - before )) of 3 POSTs"
before=$(node_posts)
expect_vote "unmarked 502" 502 "" '*' POST "$vote_json"$'X-Stub: unmarked\r\n' "$vote_body"
expect_vote "closed without a reply" 502 "" '*' POST "$vote_json"$'X-Stub: closed\r\n' "$vote_body"
[[ $(node_posts) == "$before" ]] || fail "a possibly written vote was replayed to Node"
echo "ok vote write alone: off/on/deduplicated, body and method checks, writer replies pass through, marked hand-back replays the whole body, other failures are not replayed"

for routes in votesRead,postVotes postVotes,votesRead; do
  start "$routes"
  [[ $(included | grep -c 'location = /api/v3/votes {') == 1 ]] || fail "$routes: vote path rendered more than once"
  [[ $(included | grep -c 'location = /api/v3/votes/me {') == 1 ]] || fail "$routes: personal vote read not rendered once"
  # The shared location's GET and HEAD branch keeps every vote read directive.
  reads=$(docker exec "$p-proxy" sed -n '/^location = \/api\/v3\/votes {$/,/^}$/p' /etc/nginx/rust-api-templates/votesRead.location.conf.template)
  shared=$(included | sed -n '/^location = \/api\/v3\/votes {$/,/^}$/p')
  [[ -n $reads ]] || fail "$routes: no vote read location in its template"
  while IFS= read -r line; do
    grep -qxF -- "$line" <<<"$shared" || fail "$routes: shared vote location lacks the read directive '$line'"
  done <<<"$reads"
  expect_vote "$routes: write" 200 polis-api writer POST "$vote_json" "$vote_body"
  expect_upstream polis-api GET /api/v3/votes
  expect_upstream polis-api HEAD /api/v3/votes
  expect_upstream polis-api GET /api/v3/votes/me
  expect_upstream server OPTIONS /api/v3/votes
  expect_upstream server GET /api/v3/votes $'Content-Length: 2\r\n' '{}'
  expect_upstream server GET /api/v3/votes $'X-Stub: unmarked\r\n'
  expect_upstream server GET /api/v3/votes/me $'X-Stub: unmarked\r\n'
  expect_vote "$routes: marked hand-back" 200 server "POST $vote_body" POST "$vote_json"$'X-Stub: marked\r\n' "$vote_body"
  before=$(node_posts)
  expect_vote "$routes: unmarked 502" 502 "" '*' POST "$vote_json"$'X-Stub: unmarked\r\n' "$vote_body"
  [[ $(node_posts) == "$before" ]] || fail "$routes: a possibly written vote was replayed to Node"
done
echo "ok vote read and write together: one vote location, reads keep their directives and hand-back, the write keeps its own"

# polis-api received the vote and has not answered by the 5 s read timeout.
docker rm -f "$p-rust" >/dev/null
docker run -d --name "$p-rust" --network "$net" --network-alias polis-api --entrypoint sh nginx:1.21.5-alpine -c \
  'sleep 3600 | nc -l -p 5100 >/dev/null' >/dev/null
start postVotes
before=$(node_posts)
expect_vote "no reply within the read timeout" 504 "" '*' POST "$vote_json" "$vote_body"
[[ $(node_posts) == "$before" ]] || fail "a vote without a reply was replayed to Node"
# Nothing reached polis-api: refused, then no such host.
docker rm -f "$p-rust" >/dev/null
docker run -d --name "$p-rust" --network "$net" --network-alias polis-api --entrypoint sleep nginx:1.21.5-alpine 3600 >/dev/null
start postVotes
expect_vote "connection refused" 200 server "POST $vote_body" POST "$vote_json" "$vote_body"
docker rm -f "$p-rust" >/dev/null
start postVotes
expect_vote "polis-api absent" 200 server "POST $vote_body" POST "$vote_json" "$vote_body"
echo "ok vote write hand-back: no reply is answered 504 without Node; refused and absent polis-api hand the whole vote to Node"
docker rm -f "$p-node" >/dev/null
stub "$p-node" server 5000 200 node
stub "$p-rust" polis-api 5100 200 rust

# The vote shadow (votesShadow): POST /api/v3/votes stays Node's, and nginx's
# mirror sends a copy to polis-api-shadow. Here only the rendered locations and
# the routing are checked, with a shadow stand-in that answers 204;
# nginx-shadow.sh checks what Node and the shadow receive in every failure
# mode, and the copy's cost under load.
stub "$p-shadow" polis-api-shadow 5101 204 shadow
block() { # header: one rendered location, from its header line to its closing brace
  included | sed -n "/^location $1 {\$/,/^}\$/p"
}
vote_post() { expect_upstream server POST /api/v3/votes $'Content-Type: application/json\r\nContent-Length: 2\r\n' '{}'; }
start votesShadow,votesShadow
shadow_conf=$(included)
[[ $(grep -c '^location = /api/v3/votes {$' <<<"$shadow_conf") == 1 ]] || fail "shadow: vote path not rendered once"
[[ $(grep -c '^location @polis_shadow_votesShadow {$' <<<"$shadow_conf") == 1 ]] || fail "shadow: named location not rendered once"
[[ $(grep -c '^location = /_polis_shadow/votesShadow {$' <<<"$shadow_conf") == 1 ]] || fail "shadow: copy location not rendered once"
[[ $(grep -c '^log_format polis_shadow_edge ' <<<"$shadow_conf") == 1 ]] || fail "shadow: edge log format missing"
[[ $(grep -c '^log_format polis_shadow_mirror ' <<<"$shadow_conf") == 1 ]] || fail "shadow: copy log format missing"
[[ $(grep -c '^log_format polis_shadow_access ' <<<"$shadow_conf") == 1 ]] || fail "shadow: access log format missing"
! grep '^log_format ' <<<"$shadow_conf" | grep -q 'forwarded_for' || fail "shadow: a log format reads X-Forwarded-For"
! grep '^log_format ' <<<"$shadow_conf" | grep -q 'remote_addr' || fail "shadow: a log format reads the peer address"
! grep '^log_format ' <<<"$shadow_conf" | grep -qE '\$request"|\$request_uri|\$args|\$query_string|\$http_referer' || fail "shadow: a log format reads a query string, a whole request line or a whole Referer"
grep -q "^log_format polis_shadow_access .* \"\$request_method \$polis_log_path \$server_protocol\" .* \"\$polis_log_referer\" " <<<"$shadow_conf" || fail "shadow: the access format does not write the path alone and the Referer without its query string"
grep -q "^log_format polis_shadow_access '- - \$remote_user \[\$time_local\] " <<<"$shadow_conf" || fail "shadow: the access format does not keep the peer field's place"
mirror=$(block '= \/_polis_shadow\/votesShadow')
named=$(block '@polis_shadow_votesShadow')
diversion=$(block '= \/api\/v3\/votes')
# The copy's four timeouts bound how long the next request on a participant's
# connection can wait for it: each is asserted exactly, and no other is set.
for line in '    internal;' '    log_subrequest on;' '    access_log /var/log/nginx/access.log polis_shadow_mirror;' \
    '    if ($request_method != POST) {' '    if ($http_content_length !~ "^[1-9][0-9]{0,3}$") {' \
    '    set $polis_shadow_target polis-api-shadow:5101;' '    proxy_pass http://$polis_shadow_target/api/v3/votes$is_args$args;' \
    '    proxy_set_header X-Request-Id $request_id;' '    proxy_set_header X-Polis-Shadow votesShadow;' \
    '    proxy_next_upstream off;' '    resolver_timeout 30ms;' '    proxy_connect_timeout 20ms;' \
    '    proxy_send_timeout 20ms;' '    proxy_read_timeout 30ms;'; do
  grep -qxF -- "$line" <<<"$mirror" || fail "shadow: the copy location lacks '$line'"
done
[[ $(grep -c '_timeout ' <<<"$mirror") == 4 ]] || fail "shadow: the copy location sets other timeouts"
for line in '    mirror /_polis_shadow/votesShadow;' '    mirror_request_body on;' \
    '    access_log /var/log/nginx/access.log polis_shadow_access;' '    access_log /var/log/nginx/access.log polis_shadow_edge;' \
    '    include /etc/nginx/node-proxy.conf;' '    proxy_set_header X-Request-Id $request_id;'; do
  grep -qxF -- "$line" <<<"$named" || fail "shadow: the named location lacks '$line'"
done
# The shadowed location writes its access line without the peer address and
# X-Forwarded-For, and never in the ordinary format beside it.
[[ $(grep -c 'access_log ' <<<"$named") == 2 ]] || fail "shadow: the named location writes other access lines"
for line in '    error_page 420 = @polis_shadow_votesShadow;' '    if ($polis_shadow_copyable = 1) {' \
    '        return 420;' '    include /etc/nginx/node-proxy.conf;'; do
  grep -qxF -- "$line" <<<"$diversion" || fail "shadow: the vote location lacks '$line'"
done
# Only a request the shadow is sent a copy of is handed to the location that
# reads the whole body: a POST with a declared body of 1 to 9999 bytes, not
# chunked. One map says which, in the three lines asserted here; its bound is
# the one the copy's own location applies; the path's location hands over on
# that map and on nothing else; and no other location reads a body for the
# mirror.
copyable=$(sed -n '/^map .* \$polis_shadow_copyable {$/,/^}$/p' <<<"$shadow_conf")
[[ $copyable == 'map "$request_method:$http_content_length:$http_transfer_encoding" $polis_shadow_copyable {
    default 0;
    "~^POST:[1-9][0-9]{0,3}:$" 1;
}' ]] || fail "shadow: the map of copied requests is not the three lines expected: $copyable"
[[ $(grep -c 'polis_shadow_copyable {$' <<<"$shadow_conf") == 1 ]] || fail "shadow: the map of copied requests is not rendered once"
grep -qxF -- '    if ($http_content_length !~ "^[1-9][0-9]{0,3}$") {' <<<"$mirror" || fail "shadow: the copy location's bound is not the map's"
[[ $(grep -c '^    if ' <<<"$diversion") == 1 ]] || fail "shadow: the vote location hands over on another condition"
! grep -q 'request_method' <<<"$diversion" || fail "shadow: the vote location hands over by method alone"
[[ $(grep -v '^[[:space:]]*#' <<<"$shadow_conf" | grep -c 'mirror_request_body\|mirror /') == 2 ]] || fail "shadow: a mirror directive outside the named location"
[[ $(grep -v '^[[:space:]]*#' <<<"$shadow_conf" | grep -c '\$polis_shadow_copyable') == 2 ]] || fail "shadow: the map of copied requests is used outside the vote location"
# Nothing on the copy's side can reach Node: no error_page, no named Node
# location and no retry, in the copy's location or the one that starts it.
for part in "$mirror" "$named"; do
  ! grep -qE 'error_page|@polis_node_api|recursive_error_pages|server:|proxy_next_upstream (error|timeout|on)' <<<"$part" \
    || fail "shadow: a copy could reach Node: $part"
done
# The shadow host appears in one directive, as a literal; no setting reaches it.
[[ $(grep -v '^[[:space:]]*#' <<<"$shadow_conf" | grep -c 'polis-api-shadow') == 1 ]] || fail "shadow: the copy target is not one literal"
# The copy's path is the literal path and the request's own query string;
# nothing else of the request reaches the copy's request line.
[[ $(grep -c 'proxy_pass ' <<<"$mirror") == 1 ]] || fail "shadow: the copy location has another proxy_pass"
! grep 'proxy_pass ' <<<"$mirror" | grep -q 'request_uri\|\$uri' || fail "shadow: the copy's path is taken from the request"
vote_post
expect_upstream server GET /api/v3/votes
expect_upstream server HEAD /api/v3/votes
expect_upstream server PUT /api/v3/votes $'Content-Length: 2\r\n' '{}'
expect_upstream server OPTIONS /api/v3/votes
expect_upstream server POST /api/v3/votes/ $'Content-Length: 2\r\n' '{}'
# A POST that is not copied is still Node's: no body, and a body over the bound.
expect_upstream server POST /api/v3/votes $'Content-Length: 0\r\n'
expect_upstream server POST /api/v3/votes $'Content-Type: application/json\r\nContent-Length: 10000\r\n' "$(printf '%010000d' 0)"
python3 - "$p-proxy" "$p-node" <<'PYTHON'
import http.client, subprocess, sys
proxy, node = sys.argv[1:]
def logs():
    return subprocess.check_output(['docker', 'logs', node], stderr=subprocess.STDOUT)
before = logs()
host, port = subprocess.check_output(['docker', 'port', proxy, '80/tcp'], text=True).strip().rsplit(':', 1)
for method in ('GET', 'POST'):
    c = http.client.HTTPConnection(host, int(port), timeout=5)
    c.request(method, '/_polis_shadow/votesShadow', body=b'{}' if method == 'POST' else None)
    assert c.getresponse().status == 404, method
    c.close()
assert logs() == before, 'a direct request to the copy location reached Node'
PYTHON
echo "ok vote shadow alone: one vote location and one copy location; only a POST with a declared body of 1 to 9999 bytes is handed to the mirroring location (one map, with the copy location's own bound); literal target, body bound and the four timeouts exactly; no route from the copy to Node; votes and the copy location's direct requests answered as before"

for routes in votesRead,votesShadow votesShadow,votesRead; do
  start "$routes"
  shadow_conf=$(included)
  [[ $(grep -c '^location = /api/v3/votes {$' <<<"$shadow_conf") == 1 ]] || fail "$routes: vote path not rendered once"
  [[ $(grep -c '^location = /api/v3/votes/me {$' <<<"$shadow_conf") == 1 ]] || fail "$routes: personal vote read not rendered once"
  shared=$(block '= \/api\/v3\/votes')
  # The POST diversion precedes the read's own checks.
  [[ $(grep -nxF '    error_page 420 = @polis_shadow_votesShadow;' <<<"$shared" | cut -d: -f1) -lt \
     $(grep -nxF '    if ($polis_api_plain = 0) {' <<<"$shared" | cut -d: -f1) ]] || fail "$routes: diversion after the read check"
  # Exactly the read route's location, with the diversion first.
  expected=$(docker exec "$p-proxy" sed -n '/^location = \/api\/v3\/votes {$/,/^}$/p' /etc/nginx/rust-api-templates/votesRead.location.conf.template \
    | awk '{ print } NR == 1 { print "    error_page 420 = @polis_shadow_votesShadow;"; print "    if ($polis_shadow_copyable = 1) {"; print "        return 420;"; print "    }" }')
  [[ $shared == "$expected" ]] || fail "$routes: the shared vote location is not the read route's plus the diversion"
  vote_post
  expect_upstream polis-api GET /api/v3/votes
  expect_upstream polis-api HEAD /api/v3/votes
  expect_upstream polis-api GET /api/v3/votes/me
  expect_upstream server OPTIONS /api/v3/votes
  # A POST that is not copied falls through to the read route's own checks.
  expect_upstream server POST /api/v3/votes $'Content-Length: 0\r\n'
  expect_upstream server POST /api/v3/votes $'Content-Type: application/json\r\nContent-Length: 10000\r\n' "$(printf '%010000d' 0)"
done
echo "ok vote shadow with the vote reads: one vote location, the POST diversion first, reads keep their directives"

start pca2,votesShadow
expect '/api/v3/math/pca2?conversation_id=x' rust "shadow beside pca2"
vote_post
# Unselected, the read route renders exactly its template.
start votesRead
! included | grep -q 'polis_shadow' || fail "votesRead alone: shadow text rendered"
reads=$(docker exec "$p-proxy" sed -n '/^location = \/api\/v3\/votes {$/,/^}$/p' /etc/nginx/rust-api-templates/votesRead.location.conf.template)
[[ $(block '= \/api\/v3\/votes') == "$reads" ]] || fail "votesRead alone: rendered location differs from its template"
# The live vote writer and its shadow are refused together: every route stays on Node.
for routes in postVotes,votesShadow 'votesShadow postVotes'; do
  start "$routes"
  logged 'votesShadow and postVotes' "$routes: refusal not logged"
  [[ -z $(included) ]] || fail "$routes: refused selection rendered"
  vote_post
done
docker rm -f "$p-shadow" >/dev/null
echo "ok vote shadow beside pca2; votesRead alone unchanged; votesShadow with postVotes refused, every route on Node"

# The comment shadow (commentsShadow): POST /api/v3/comments stays Node's, and
# nginx's mirror sends a copy to polis-api-shadow, at most 2 a second on this
# box and 4 more at once. Rendered from the vote shadow's own templates: each
# of its three locations is the vote shadow's with the name and the path
# replaced, and the copy's location has three more lines, the rate. Here the
# rendered text and the routing are checked; nginx-shadow.sh checks what Node
# and the shadow receive, the rate and every failure mode.
stub "$p-shadow" polis-api-shadow 5101 204 shadow
comment_post() { expect_upstream server POST /api/v3/comments $'Content-Type: application/json\r\nContent-Length: 2\r\n' '{}'; }
as_comments() { sed -e 's/votesShadow/commentsShadow/g' -e 's#/api/v3/votes#/api/v3/comments#g'; }
rate_lines='    # A copy over the rate of this shadow ends here with 429 (the zone is in upstreams.conf).
    limit_req zone=polis_shadow_commentsShadow burst=4 nodelay;
    limit_req_status 429;
    limit_req_log_level info;'
zone_line='limit_req_zone $polis_shadow_name zone=polis_shadow_commentsShadow:1m rate=2r/s;'
start votesShadow
vote_conf=$(included)
vote_mirror=$(block '= \/_polis_shadow\/votesShadow')
vote_named=$(block '@polis_shadow_votesShadow')
vote_diversion=$(block '= \/api\/v3\/votes')
! grep -q 'limit_req' <<<"$vote_conf" || fail "vote shadow alone: a rate limit was rendered"
start commentsShadow,commentsShadow
shadow_conf=$(included)
[[ $(grep -c '^location = /api/v3/comments {$' <<<"$shadow_conf") == 1 ]] || fail "comment shadow: comment path not rendered once"
[[ $(grep -c '^location @polis_shadow_commentsShadow {$' <<<"$shadow_conf") == 1 ]] || fail "comment shadow: named location not rendered once"
[[ $(grep -c '^location = /_polis_shadow/commentsShadow {$' <<<"$shadow_conf") == 1 ]] || fail "comment shadow: copy location not rendered once"
! grep -q 'votesShadow\|/api/v3/votes' <<<"$(grep -v '^[[:space:]]*#' <<<"$shadow_conf")" || fail "comment shadow alone: a vote location was rendered"
for format in polis_shadow_edge polis_shadow_mirror polis_shadow_access; do
  [[ $(grep -c "^log_format $format " <<<"$shadow_conf") == 1 ]] || fail "comment shadow: log format $format not rendered once"
done
# The three log formats are the vote shadow's, to the byte: a copied comment's
# lines carry what a copied vote's carry and nothing more.
[[ $(grep '^log_format ' <<<"$shadow_conf") == "$(grep '^log_format ' <<<"$vote_conf")" ]] || fail "comment shadow: a log format differs from the vote shadow's"
mirror=$(block '= \/_polis_shadow\/commentsShadow')
named=$(block '@polis_shadow_commentsShadow')
diversion=$(block '= \/api\/v3\/comments')
# The named location and the path's location: the vote shadow's, renamed.
[[ $named == "$(as_comments <<<"$vote_named")" ]] || fail "comment shadow: the named location is not the vote shadow's with the name and path replaced"
[[ $diversion == "$(as_comments <<<"$vote_diversion")" ]] || fail "comment shadow: the path's location is not the vote shadow's with the name and path replaced"
# The copy's location: the vote shadow's, renamed, plus the rate lines, which
# come directly after the line that names the shadow.
[[ $(grep -vxF -- "$rate_lines" <<<"$mirror") == "$(as_comments <<<"$vote_mirror")" ]] || fail "comment shadow: the copy location is not the vote shadow's plus the rate lines"
expected=$(as_comments <<<"$vote_mirror" | rate="$rate_lines" awk '{ print } $0 == "    set $polis_shadow_name commentsShadow;" { print ENVIRON["rate"] }')
[[ $mirror == "$expected" ]] || fail "comment shadow: the rate lines are not directly after the shadow's name"
# Each line the copy depends on, exactly; the four timeouts and no other.
for line in '    internal;' '    log_subrequest on;' '    access_log /var/log/nginx/access.log polis_shadow_mirror;' \
    '    set $polis_shadow_name commentsShadow;' '    limit_req zone=polis_shadow_commentsShadow burst=4 nodelay;' \
    '    limit_req_status 429;' '    limit_req_log_level info;' \
    '    if ($request_method != POST) {' '    if ($http_content_length !~ "^[1-9][0-9]{0,3}$") {' \
    '    set $polis_shadow_target polis-api-shadow:5101;' '    proxy_pass http://$polis_shadow_target/api/v3/comments$is_args$args;' \
    '    proxy_set_header X-Request-Id $request_id;' '    proxy_set_header X-Polis-Shadow commentsShadow;' \
    '    proxy_next_upstream off;' '    resolver_timeout 30ms;' '    proxy_connect_timeout 20ms;' \
    '    proxy_send_timeout 20ms;' '    proxy_read_timeout 30ms;'; do
  grep -qxF -- "$line" <<<"$mirror" || fail "comment shadow: the copy location lacks '$line'"
done
[[ $(grep -c '_timeout ' <<<"$mirror") == 4 ]] || fail "comment shadow: the copy location sets other timeouts"
for line in '    mirror /_polis_shadow/commentsShadow;' '    mirror_request_body on;' \
    '    access_log /var/log/nginx/access.log polis_shadow_access;' '    access_log /var/log/nginx/access.log polis_shadow_edge;' \
    '    include /etc/nginx/node-proxy.conf;' '    proxy_set_header X-Request-Id $request_id;'; do
  grep -qxF -- "$line" <<<"$named" || fail "comment shadow: the named location lacks '$line'"
done
[[ $(grep -c 'access_log ' <<<"$named") == 2 ]] || fail "comment shadow: the named location writes other access lines"
# The map of copied requests is the vote shadow's, to the byte.
[[ $(sed -n '/^map .* \$polis_shadow_copyable {$/,/^}$/p' <<<"$shadow_conf") == "$copyable" ]] || fail "comment shadow: the map of copied requests differs from the vote shadow's"
for line in '    error_page 420 = @polis_shadow_commentsShadow;' '    if ($polis_shadow_copyable = 1) {' \
    '        return 420;' '    include /etc/nginx/node-proxy.conf;'; do
  grep -qxF -- "$line" <<<"$diversion" || fail "comment shadow: the comment location lacks '$line'"
done
# The rate: one zone, keyed by the shadow's name, used in the copy's location
# and nowhere else. The location that answers the person has no limit at all.
[[ $(grep -c '^limit_req_zone ' <<<"$shadow_conf") == 1 ]] || fail "comment shadow: not exactly one rate zone"
grep -qxF -- "$zone_line" <<<"$shadow_conf" || fail "comment shadow: the rate zone is not '$zone_line'"
[[ $(grep -v '^[[:space:]]*#' <<<"$shadow_conf" | grep -c 'limit_req') == 4 ]] || fail "comment shadow: a rate directive outside the zone and the copy location"
for part in "$named" "$diversion"; do
  ! grep -q 'limit_' <<<"$part" || fail "comment shadow: a limit on the request Node answers: $part"
done
! grep -v '^[[:space:]]*#' <<<"$shadow_conf" | grep -q 'limit_conn\|limit_rate' || fail "comment shadow: another kind of limit was rendered"
for part in "$mirror" "$named"; do
  ! grep -qE 'error_page|@polis_node_api|recursive_error_pages|server:|proxy_next_upstream (error|timeout|on)' <<<"$part" \
    || fail "comment shadow: a copy could reach Node: $part"
done
[[ $(grep -v '^[[:space:]]*#' <<<"$shadow_conf" | grep -c 'polis-api-shadow') == 1 ]] || fail "comment shadow: the copy target is not one literal"
comment_post
expect_upstream server GET /api/v3/comments
expect_upstream server GET '/api/v3/comments?conversation_id=2fixture&moderation=true'
expect_upstream server HEAD /api/v3/comments
expect_upstream server PUT /api/v3/comments $'Content-Length: 2\r\n' '{}'
expect_upstream server OPTIONS /api/v3/comments
expect_upstream server POST /api/v3/comments/ $'Content-Length: 2\r\n' '{}'
expect_upstream server POST /api/v3/comments $'Content-Length: 0\r\n'
expect_upstream server POST /api/v3/comments $'Content-Type: application/json\r\nContent-Length: 10000\r\n' "$(printf '%010000d' 0)"
expect_upstream server POST /api/v3/comments-bulk $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/comments/translations
expect_upstream server GET /api/v3/nextComment
expect_upstream server POST /api/v3/votes $'Content-Type: application/json\r\nContent-Length: 2\r\n' '{}'
python3 - "$p-proxy" "$p-node" <<'PYTHON'
import http.client, subprocess, sys
proxy, node = sys.argv[1:]
def logs():
    return subprocess.check_output(['docker', 'logs', node], stderr=subprocess.STDOUT)
before = logs()
host, port = subprocess.check_output(['docker', 'port', proxy, '80/tcp'], text=True).strip().rsplit(':', 1)
for method in ('GET', 'POST'):
    c = http.client.HTTPConnection(host, int(port), timeout=5)
    c.request(method, '/_polis_shadow/commentsShadow', body=b'{}' if method == 'POST' else None)
    assert c.getresponse().status == 404, method
    c.close()
assert logs() == before, 'a direct request to the copy location reached Node'
PYTHON
echo "ok comment shadow alone: the vote shadow's three locations with the name and path replaced, plus the rate (one zone, 2 a second and 4 more at once, in the copy's location only); the three log formats to the byte; literal target, body bound and the four timeouts exactly; no route from the copy to Node; comments and the copy location's direct requests answered as before"

# With the comment read route: its own location answers the path, with the
# POST diversion first, exactly as the vote read route's does.
for routes in comments,commentsShadow commentsShadow,comments; do
  start "$routes"
  shadow_conf=$(included)
  [[ $(grep -c '^location = /api/v3/comments {$' <<<"$shadow_conf") == 1 ]] || fail "$routes: comment path not rendered once"
  shared=$(block '= \/api\/v3\/comments')
  [[ $(grep -nxF '    error_page 420 = @polis_shadow_commentsShadow;' <<<"$shared" | cut -d: -f1) -lt \
     $(grep -nxF '    if ($polis_api_plain = 0) {' <<<"$shared" | cut -d: -f1) ]] || fail "$routes: diversion after the read check"
  expected=$(docker exec "$p-proxy" sed -n '/^location = \/api\/v3\/comments {$/,/^}$/p' /etc/nginx/rust-api-templates/comments.location.conf.template \
    | awk '{ print } NR == 1 { print "    error_page 420 = @polis_shadow_commentsShadow;"; print "    if ($polis_shadow_copyable = 1) {"; print "        return 420;"; print "    }" }')
  [[ $shared == "$expected" ]] || fail "$routes: the shared comment location is not the read route's plus the diversion"
  [[ $(block '= \/_polis_shadow\/commentsShadow') == "$mirror" ]] || fail "$routes: the copy location differs from the comment shadow's alone"
  [[ $(block '@polis_shadow_commentsShadow') == "$named" ]] || fail "$routes: the named location differs from the comment shadow's alone"
  comment_post
  expect_upstream polis-api GET /api/v3/comments
  expect_upstream polis-api GET '/api/v3/comments?conversation_id=2fixture&moderation=true'
  expect_upstream polis-api HEAD /api/v3/comments
  expect_upstream server OPTIONS /api/v3/comments
  expect_upstream server PUT /api/v3/comments $'Content-Length: 2\r\n' '{}'
  expect_upstream server GET /api/v3/comments $'Content-Length: 2\r\n' '{}'
done
start comments
! included | grep -q 'polis_shadow\|limit_req' || fail "comments alone: shadow text rendered"
reads=$(docker exec "$p-proxy" sed -n '/^location = \/api\/v3\/comments {$/,/^}$/p' /etc/nginx/rust-api-templates/comments.location.conf.template)
[[ $(block '= \/api\/v3\/comments') == "$reads" ]] || fail "comments alone: rendered location differs from its template"
echo "ok comment shadow with the comment reads: one comment location, the POST diversion first, reads keep their directives; comments alone unchanged"

# Both shadows together, the ordinary selection: each shadow's locations are
# exactly what it renders alone, the log formats are rendered once, and each
# copy has its own literal line for the one target.
for routes in pca2,votesShadow,commentsShadow commentsShadow,votesShadow,pca2 'pca2 votesShadow commentsShadow'; do
  start "$routes"
  shadow_conf=$(included)
  [[ $(block '= \/_polis_shadow\/votesShadow') == "$vote_mirror" ]] || fail "$routes: the vote copy location differs from the vote shadow's alone"
  [[ $(block '@polis_shadow_votesShadow') == "$vote_named" ]] || fail "$routes: the vote named location differs from the vote shadow's alone"
  [[ $(block '= \/api\/v3\/votes') == "$vote_diversion" ]] || fail "$routes: the vote location differs from the vote shadow's alone"
  [[ $(block '= \/_polis_shadow\/commentsShadow') == "$mirror" ]] || fail "$routes: the comment copy location differs from the comment shadow's alone"
  [[ $(block '@polis_shadow_commentsShadow') == "$named" ]] || fail "$routes: the comment named location differs from the comment shadow's alone"
  [[ $(block '= \/api\/v3\/comments') == "$diversion" ]] || fail "$routes: the comment location differs from the comment shadow's alone"
  for format in polis_shadow_edge polis_shadow_mirror polis_shadow_access; do
    [[ $(grep -c "^log_format $format " <<<"$shadow_conf") == 1 ]] || fail "$routes: log format $format not rendered once"
  done
  [[ $(grep -c '^limit_req_zone ' <<<"$shadow_conf") == 1 ]] || fail "$routes: not exactly one rate zone"
  [[ $(grep -c 'polis_shadow_copyable {$' <<<"$shadow_conf") == 1 ]] || fail "$routes: the map of copied requests is not rendered once"
  [[ $(sed -n '/^map .* \$polis_shadow_copyable {$/,/^}$/p' <<<"$shadow_conf") == "$copyable" ]] || fail "$routes: the map of copied requests differs from the vote shadow's"
  ! grep -q 'limit_' <<<"$(block '= \/_polis_shadow\/votesShadow')" || fail "$routes: the vote copy has a rate"
  [[ $(grep -v '^[[:space:]]*#' <<<"$shadow_conf" | grep -c 'polis-api-shadow') == 2 ]] || fail "$routes: not one literal target line for each shadow"
  expect '/api/v3/math/pca2?conversation_id=x' rust "$routes: pca2 beside both shadows"
  vote_post
  comment_post
  expect_upstream server GET /api/v3/votes
  expect_upstream server GET /api/v3/comments
done
start votesRead,comments,votesShadow,commentsShadow
vote_post
comment_post
expect_upstream polis-api GET /api/v3/votes
expect_upstream polis-api GET /api/v3/comments
# Refused: the comment shadow with the vote writer's own conflict still
# applies beside it, and a name that would write comments is not a route
# this renderer has. Either way every route stays on Node.
for routes in commentsShadow,postVotes,votesShadow 'commentsShadow,postComments' 'pca2,commentsShadow,postComments'; do
  start "$routes"
  logged 'ERROR RUST_API_ROUTES' "$routes: refusal not logged"
  [[ -z $(included) ]] || fail "$routes: refused selection rendered"
  comment_post
  vote_post
  expect /api/v3/math/pca2 node "$routes: refused selection leaves pca2 on Node"
done
start commentsShadow,postVotes
[[ -n $(included) ]] || fail "commentsShadow beside the vote writer was refused"
docker rm -f "$p-shadow" >/dev/null
echo "ok both shadows together in three spellings: each exactly as alone, formats once, one rate zone, pca2 unaffected; with both read routes; refusals leave every route on Node"

# The read shadows (votesReadShadow, commentsReadShadow, nextCommentShadow):
# GET /api/v3/votes, GET /api/v3/comments and GET /api/v3/nextComment stay
# Node's, and nginx's mirror sends a copy of a GET with no body to
# polis-api-shadow-reads, at most 4 a second on this box for each. Here the
# rendered text and the routing are checked, with a read shadow stand-in that
# answers 204; nginx-shadow.sh checks what Node and the read shadow receive,
# the rate and every failure mode.
comment_mirror=$mirror comment_named=$named comment_diversion=$diversion
stub "$p-shadow" polis-api-shadow 5101 204 shadow
stub "$p-reads" polis-api-shadow-reads 5102 204 reads
read_path() {
  case "$1" in
    votesReadShadow) echo /api/v3/votes ;;
    commentsReadShadow) echo /api/v3/comments ;;
    nextCommentShadow) echo /api/v3/nextComment ;;
  esac
}
read_rate_lines() { printf '%s\n' '    # A copy over the rate of this shadow ends here with 429 (the zone is in upstreams.conf).' \
  "    limit_req zone=polis_shadow_$1 nodelay;" '    limit_req_status 429;' '    limit_req_log_level info;'; }
read_map='map "$request_method:$http_content_length:$http_transfer_encoding" $polis_shadow_read_copyable {
    default 0;
    "GET::" 1;
}'
# The GET diversion a location answering a read shadow's path carries first.
read_diversion_lines() { printf '%s\n' "    error_page 421 = @polis_shadow_$1;" '    if ($polis_shadow_read_copyable = 1) {' \
  '        return 421;' '    }'; }
# What each read shadow renders alone (bash 3.2 has no associative arrays):
# alone NAME KIND reads it back.
alone() { local var="alone_$2_$1"; printf '%s' "${!var}"; }
# A location with lines inserted directly after its first line.
with_first() { first="$1" awk 'NR == 1 { print; print ENVIRON["first"]; next } { print }'; }
for shadow in votesReadShadow commentsReadShadow nextCommentShadow; do
  path=$(read_path "$shadow")
  epath=${path//\//\\/}
  start "$shadow,$shadow"
  conf=$(included)
  [[ $(grep -c "^location = $path {\$" <<<"$conf") == 1 ]] || fail "$shadow: its path not rendered once"
  [[ $(grep -c "^location @polis_shadow_$shadow {\$" <<<"$conf") == 1 ]] || fail "$shadow: named location not rendered once"
  [[ $(grep -c "^location = /_polis_shadow/$shadow {\$" <<<"$conf") == 1 ]] || fail "$shadow: copy location not rendered once"
  # No other shadow, and nothing of the write shadows' copying, is rendered.
  ! grep -v '^[[:space:]]*#' <<<"$conf" | grep -qE 'votesShadow|commentsShadow|polis-api-shadow:|mirror_request_body on|polis_shadow_copyable = ' \
    || fail "$shadow alone: a write shadow's copying was rendered"
  for other in votesReadShadow commentsReadShadow nextCommentShadow; do
    [[ $other == "$shadow" ]] || ! grep -v '^[[:space:]]*#' <<<"$conf" | grep -q "$other" || fail "$shadow alone: $other was rendered"
  done
  # The three log formats are the vote shadow's, to the byte.
  [[ $(grep '^log_format ' <<<"$conf") == "$(grep '^log_format ' <<<"$vote_conf")" ]] || fail "$shadow: a log format differs from the vote shadow's"
  # One map says which requests are copied: a GET with no body, in the three
  # lines asserted here, used in the path's location and the copy's location.
  [[ $(sed -n '/^map .* \$polis_shadow_read_copyable {$/,/^}$/p' <<<"$conf") == "$read_map" ]] || fail "$shadow: the map of copied reads is not the lines expected"
  [[ $(grep -v '^[[:space:]]*#' <<<"$conf" | grep -c '\$polis_shadow_read_copyable') == 3 ]] || fail "$shadow: the map of copied reads is used elsewhere"
  mirror=$(block "= \\/_polis_shadow\\/$shadow")
  named=$(block "@polis_shadow_$shadow")
  diversion=$(block "= $epath")
  # The path's location: the read diversion, then Node exactly as the API
  # location sends it; nothing else.
  [[ $diversion == "location = $path {
$(read_diversion_lines "$shadow")
    include /etc/nginx/node-proxy.conf;
}" ]] || fail "$shadow: the path's location is not the diversion and Node: $diversion"
  # The named location: the mirror without a body, the shadowed access line
  # and edge line, Node, and the request id.
  [[ $named == "location @polis_shadow_$shadow {
    mirror /_polis_shadow/$shadow;
    mirror_request_body off;
    access_log /var/log/nginx/access.log polis_shadow_access;
    access_log /var/log/nginx/access.log polis_shadow_edge;
    include /etc/nginx/node-proxy.conf;
    proxy_set_header X-Request-Id \$request_id;
}" ]] || fail "$shadow: the named location is not the one expected: $named"
  # The copy's location, line by line: internal, its own line, the rate, the
  # map again, the literal target, the path and the request's query string,
  # no body, the four timeouts and no other.
  for line in '    internal;' '    log_subrequest on;' '    access_log /var/log/nginx/access.log polis_shadow_mirror;' \
      "    set \$polis_shadow_name $shadow;" '    if ($polis_shadow_read_copyable = 0) {' '        return 204;' \
      '    set $polis_shadow_target polis-api-shadow-reads:5102;' "    proxy_pass http://\$polis_shadow_target$path\$is_args\$args;" \
      '    proxy_pass_request_headers on;' '    proxy_pass_request_body off;' \
      '    proxy_set_header X-Forwarded-Proto $scheme;' '    proxy_set_header Host $host;' \
      '    proxy_set_header X-Request-Id $request_id;' "    proxy_set_header X-Polis-Shadow $shadow;" \
      '    proxy_next_upstream off;' '    resolver_timeout 30ms;' '    proxy_connect_timeout 20ms;' \
      '    proxy_send_timeout 20ms;' '    proxy_read_timeout 30ms;'; do
    grep -qxF -- "$line" <<<"$mirror" || fail "$shadow: the copy location lacks '$line'"
  done
  [[ $(grep -c '_timeout ' <<<"$mirror") == 4 ]] || fail "$shadow: the copy location sets other timeouts"
  # The rate lines come directly after the line that names the shadow.
  [[ $(grep -A4 -xF "    set \$polis_shadow_name $shadow;" <<<"$mirror" | tail -n 4) == "$(read_rate_lines "$shadow")" ]] \
    || fail "$shadow: the rate lines are not directly after the shadow's name"
  [[ $(grep -c '^limit_req_zone ' <<<"$conf") == 1 ]] || fail "$shadow: not exactly one rate zone"
  grep -qxF -- "limit_req_zone \$polis_shadow_name zone=polis_shadow_$shadow:1m rate=4r/s;" <<<"$conf" || fail "$shadow: the rate zone is not 4 a second"
  for part in "$named" "$diversion"; do
    ! grep -q 'limit_' <<<"$part" || fail "$shadow: a limit on the request Node answers: $part"
  done
  # Nothing on the copy's side can reach Node.
  for part in "$mirror" "$named"; do
    ! grep -qE 'error_page|@polis_node_api|recursive_error_pages|server:|proxy_next_upstream (error|timeout|on)' <<<"$part" \
      || fail "$shadow: a copy could reach Node: $part"
  done
  [[ $(grep -v '^[[:space:]]*#' <<<"$conf" | grep -c 'polis-api-shadow-reads') == 1 ]] || fail "$shadow: the copy target is not one literal"
  ! grep 'proxy_pass ' <<<"$mirror" | grep -q 'request_uri\|\$uri' || fail "$shadow: the copy's path is taken from the request"
  printf -v "alone_mirror_$shadow" '%s' "$mirror"
  printf -v "alone_named_$shadow" '%s' "$named"
  printf -v "alone_path_$shadow" '%s' "$diversion"
  # Routing: every request on the path still reaches Node.
  expect_upstream server GET "$path"
  expect_upstream server GET "$path?conversation_id=2fixture&pid=1"
  expect_upstream server HEAD "$path"
  expect_upstream server POST "$path" $'Content-Type: application/json\r\nContent-Length: 2\r\n' '{}'
  expect_upstream server PUT "$path" $'Content-Length: 2\r\n' '{}'
  expect_upstream server OPTIONS "$path"
  expect_upstream server GET "$path" $'Content-Length: 0\r\n'
  expect_upstream server GET "$path" $'Content-Length: 2\r\n' '{}'
  expect_upstream server GET "$path/"
  python3 - "$p-proxy" "$p-node" "$shadow" <<'PYTHON'
import http.client, subprocess, sys
proxy, node, shadow = sys.argv[1:]
def logs():
    return subprocess.check_output(['docker', 'logs', node], stderr=subprocess.STDOUT)
before = logs()
host, port = subprocess.check_output(['docker', 'port', proxy, '80/tcp'], text=True).strip().rsplit(':', 1)
for method in ('GET', 'POST'):
    c = http.client.HTTPConnection(host, int(port), timeout=5)
    c.request(method, '/_polis_shadow/' + shadow, body=b'{}' if method == 'POST' else None)
    assert c.getresponse().status == 404, method
    c.close()
assert logs() == before, 'a direct request to the copy location reached Node'
PYTHON
done
expect '/api/v3/math/pca2?conversation_id=x' node "read shadows leave pca2 on Node"
echo "ok read shadows alone: each renders its path's location (the GET diversion, then Node), its named location (no body read) and its copy location (one map of bodyless GETs, used twice; literal target, the path and query string, no body, the rate of 4 a second and no more at once, the four timeouts exactly), the vote shadow's log formats to the byte, nothing of the write shadows; every method on the path reaches Node; the copy location answers direct requests 404"

# Beside the write shadows and the vote writer: the location that already
# answers the path carries the GET diversion first, and is otherwise exactly
# what it is without the read shadow; the read shadow's own locations are
# exactly what it renders alone.
for routes in votesShadow,votesReadShadow votesReadShadow,votesShadow; do
  start "$routes"
  [[ $(included | grep -c '^location = /api/v3/votes {$') == 1 ]] || fail "$routes: vote path not rendered once"
  [[ $(block '= \/api\/v3\/votes') == "$(with_first "$(read_diversion_lines votesReadShadow)" <<<"$vote_diversion")" ]] \
    || fail "$routes: the vote location is not the vote shadow's with the GET diversion first"
  [[ $(block '= \/_polis_shadow\/votesShadow') == "$vote_mirror" ]] || fail "$routes: the vote copy location changed"
  [[ $(block '@polis_shadow_votesShadow') == "$vote_named" ]] || fail "$routes: the vote named location changed"
  [[ $(block '= \/_polis_shadow\/votesReadShadow') == "$(alone votesReadShadow mirror)" ]] || fail "$routes: the read copy location changed"
  [[ $(block '@polis_shadow_votesReadShadow') == "$(alone votesReadShadow named)" ]] || fail "$routes: the read named location changed"
  vote_post
  expect_upstream server GET /api/v3/votes
  expect_upstream server HEAD /api/v3/votes
done
for routes in commentsShadow,commentsReadShadow commentsReadShadow,commentsShadow; do
  start "$routes"
  [[ $(included | grep -c '^location = /api/v3/comments {$') == 1 ]] || fail "$routes: comment path not rendered once"
  [[ $(block '= \/api\/v3\/comments') == "$(with_first "$(read_diversion_lines commentsReadShadow)" <<<"$comment_diversion")" ]] \
    || fail "$routes: the comment location is not the comment shadow's with the GET diversion first"
  [[ $(block '= \/_polis_shadow\/commentsShadow') == "$comment_mirror" ]] || fail "$routes: the comment copy location changed"
  [[ $(block '@polis_shadow_commentsShadow') == "$comment_named" ]] || fail "$routes: the comment named location changed"
  [[ $(block '= \/_polis_shadow\/commentsReadShadow') == "$(alone commentsReadShadow mirror)" ]] || fail "$routes: the read copy location changed"
  comment_post
  expect_upstream server GET /api/v3/comments
done
start postVotes
vote_writer=$(block '= \/api\/v3\/votes')
vote_writer_all=$(included)
for routes in postVotes,votesReadShadow votesReadShadow,postVotes; do
  start "$routes"
  [[ $(included | grep -c '^location = /api/v3/votes {$') == 1 ]] || fail "$routes: vote path not rendered once"
  [[ $(block '= \/api\/v3\/votes') == "$(with_first "$(read_diversion_lines votesReadShadow)" <<<"$vote_writer")" ]] \
    || fail "$routes: the vote writer's location is not its own with the GET diversion first"
  for name in '@polis_api_vote_write' '@polis_api_vote_handback'; do
    [[ $(block "$name") == "$(sed -n "/^location $name {\$/,/^}\$/p" <<<"$vote_writer_all")" ]] || fail "$routes: $name changed"
  done
  [[ $(block '= \/_polis_shadow\/votesReadShadow') == "$(alone votesReadShadow mirror)" ]] || fail "$routes: the read copy location changed"
  expect_upstream polis-api POST /api/v3/votes $'Content-Type: application/json\r\nContent-Length: 2\r\n' '{}'
  expect_upstream server GET /api/v3/votes
  expect_upstream server HEAD /api/v3/votes
done
echo "ok read shadows beside the write shadows and the vote writer: the location already on the path carries the GET diversion first and is otherwise unchanged; every other location as alone; POSTs keep their routes, GETs reach Node"

# Every shadow together, the selection a box would run: each location exactly
# as alone, formats and maps once, one rate zone a shadow with a rate, one
# literal target line for each copy.
all=pca2,votesShadow,commentsShadow,votesReadShadow,commentsReadShadow,nextCommentShadow
for routes in "$all" 'nextCommentShadow commentsReadShadow votesReadShadow commentsShadow votesShadow pca2'; do
  start "$routes"
  conf=$(included)
  [[ $(block '= \/_polis_shadow\/votesShadow') == "$vote_mirror" && $(block '@polis_shadow_votesShadow') == "$vote_named" ]] \
    || fail "$routes: the vote shadow's locations differ from alone"
  [[ $(block '= \/_polis_shadow\/commentsShadow') == "$comment_mirror" && $(block '@polis_shadow_commentsShadow') == "$comment_named" ]] \
    || fail "$routes: the comment shadow's locations differ from alone"
  for shadow in votesReadShadow commentsReadShadow nextCommentShadow; do
    [[ $(block "= \\/_polis_shadow\\/$shadow") == "$(alone "$shadow" mirror)" ]] || fail "$routes: $shadow's copy location differs from alone"
    [[ $(block "@polis_shadow_$shadow") == "$(alone "$shadow" named)" ]] || fail "$routes: $shadow's named location differs from alone"
  done
  [[ $(block '= \/api\/v3\/nextComment') == "$(alone nextCommentShadow path)" ]] || fail "$routes: the next comment's location differs from alone"
  for format in polis_shadow_edge polis_shadow_mirror polis_shadow_access; do
    [[ $(grep -c "^log_format $format " <<<"$conf") == 1 ]] || fail "$routes: log format $format not rendered once"
  done
  [[ $(grep -c 'polis_shadow_copyable {$' <<<"$conf") == 1 && $(grep -c 'polis_shadow_read_copyable {$' <<<"$conf") == 1 ]] \
    || fail "$routes: a map of copied requests is not rendered once"
  [[ $(grep -c '^limit_req_zone ' <<<"$conf") == 4 ]] || fail "$routes: not one rate zone for each shadow with a rate"
  [[ $(grep -v '^[[:space:]]*#' <<<"$conf" | grep -c 'polis-api-shadow:5101') == 2 ]] || fail "$routes: not one write target line for each write shadow"
  [[ $(grep -v '^[[:space:]]*#' <<<"$conf" | grep -c 'polis-api-shadow-reads:5102') == 3 ]] || fail "$routes: not one read target line for each read shadow"
  expect '/api/v3/math/pca2?conversation_id=x' rust "$routes: pca2 beside every shadow"
  vote_post
  comment_post
  for path in /api/v3/votes /api/v3/comments /api/v3/nextComment; do
    expect_upstream server GET "$path"
  done
done
echo "ok every shadow together in two spellings: each location exactly as alone, formats and maps once, four rate zones, one literal target line for each copy, pca2 unaffected"

# Refused: a read shadow beside the read route that has Rust answer the read.
# Every route stays on Node.
for routes in votesRead,votesReadShadow 'votesReadShadow votesRead' comments,commentsReadShadow \
    'pca2,commentsReadShadow,comments' nextComment,nextCommentShadow 'pca2,nextCommentShadow , nextComment' \
    votesReadShadow,commentsReadShadow,nextCommentShadow,nextComment; do
  start "$routes"
  logged 'cannot be selected together (a read shadow observes the reads Node answers)' "$routes: refusal not logged"
  [[ -z $(included) ]] || fail "$routes: refused selection rendered"
  expect /api/v3/math/pca2 node "$routes: refused selection leaves pca2 on Node"
  expect_upstream server GET /api/v3/votes
done
# Every selection without a read shadow renders nothing of them.
for routes in pca2,votesShadow,commentsShadow votesRead,comments,nextComment,votesShadow,commentsShadow postVotes,votesRead; do
  start "$routes"
  ! included | grep -v '^[[:space:]]*#' | grep -qE 'polis_shadow_read_copyable|polis-api-shadow-reads|error_page 421|ReadShadow|nextCommentShadow|mirror_request_body off' \
    || fail "$routes: read shadow text rendered with no read shadow named"
done
docker rm -f "$p-shadow" "$p-reads" >/dev/null
echo "ok read shadows refused beside their read routes, every route on Node; no selection without a read shadow renders any of it"

# Independent metrics selector; disabled by default and unrelated to participation.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /perfStats_9182738127 node "metrics off"
start perfStats,perfStats
expect /perfStats_9182738127 rust "metrics on"
expect /api/v3/nextComment node "metrics leaves participation alone"
[[ $(included | grep -c 'location = /perfStats_9182738127') == 1 ]] || fail "metrics duplicated"
expect_upstream polis-api HEAD /perfStats_9182738127
expect_upstream server POST /perfStats_9182738127 $'Content-Length: 0\r\n'
expect_upstream server GET /perfStats_9182738127 $'Content-Length: 2\r\n' '{}'
echo "ok metrics off/on/deduplicated and method/body gate"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /perfStats_9182738127 node "metrics handoff"
echo "ok metrics unavailable hands back to Node"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect_upstream server POST /api/v3/query_participants_by_metadata $'Content-Length: 2\r\n' '{}'
start metadataQuery,metadataQuery
expect_upstream polis-api POST /api/v3/query_participants_by_metadata $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/query_participants_by_metadata
expect_upstream server OPTIONS /api/v3/query_participants_by_metadata
expect /api/v3/nextComment node "metadata query leaves participation alone"
[[ $(included | grep -c 'location = /api/v3/query_participants_by_metadata') == 1 ]] || fail "metadata query duplicated"
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect_upstream server POST /api/v3/query_participants_by_metadata $'Content-Length: 2\r\n' '{}'
echo "ok metadata query off/on/deduplicated, POST read admission, fallback"

docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/reportExport/generated/format.json node "report export off"
start reportExportPg,reportExportPg
for subtype in format.json summary.csv comments.csv votes.csv participant-votes.csv participant-importance.csv comment-groups.csv; do
    expect "/api/v3/reportExport/generated/$subtype" rust "Postgres report on"
    expect_upstream polis-api HEAD "/api/v3/reportExport/generated/$subtype"
    expect_upstream server POST "/api/v3/reportExport/generated/$subtype" $'Content-Length: 2\r\n' '{}'
done
expect /api/v3/reportExport/generated/comment-clusters.csv node "external subtype stays on Node"
expect /api/v3/dataExport/results node "S3 path stays on Node"
expect /api/v3/nextComment node "report selector leaves participation alone"
[[ $(included | grep -c 'location ~ \^/api/v3/reportExport/') == 1 ]] || fail "report selector duplicated"
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/reportExport/generated/format.json node "report export handoff"
echo "ok Postgres report export subtypes off/on/deduplicated, excluded external routes, methods and fallback"

# Current participant rows have their own default-off selector.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/participants node "participants off"
start participantsRead,participantsRead
expect /api/v3/participants rust "participants on"
[[ $(included | grep -c 'location = /api/v3/participants {') == 1 ]] || fail "participants duplicated"
expect_upstream polis-api HEAD /api/v3/participants
expect_upstream server OPTIONS /api/v3/participants
expect_upstream server POST /api/v3/participants $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/participants $'Content-Length: 2\r\n' '{}'
expect /api/v3/votes node "participants leave votes alone"
expect /api/v3/nextComment node "participants leave next statement alone"
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 handoff
sleep 6
expect /api/v3/participants node "participants fallback"
echo "ok current participant: off/on/deduplicated, methods/body, fallback"

# Social participant rows have their own default-off selector.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/ptptois node "social off"
start ptptois,ptptois
expect /api/v3/ptptois rust "social on"
[[ $(included | grep -c 'location = /api/v3/ptptois {') == 1 ]] || fail "social duplicated"
expect_upstream polis-api HEAD /api/v3/ptptois
expect_upstream server OPTIONS /api/v3/ptptois
expect_upstream server PUT /api/v3/ptptois
expect_upstream server POST /api/v3/ptptois $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/ptptois $'Content-Length: 2\r\n' '{}'
expect /api/v3/votes node "social leave votes alone"
expect /api/v3/nextComment node "social leave next statement alone"
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 handoff
sleep 6
expect /api/v3/ptptois node "social fallback"
echo "ok social participant: off/on/deduplicated, methods/body, fallback"

# The featured-participants read has its own default-off selector. Unselected,
# nothing of it is rendered beside the other vote routes; selected, its
# location is its template and the other vote paths are not touched.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/votes/famous node "featured participants off"
start votesRead,postVotes,ptptois
expect /api/v3/votes/famous node "featured participants unselected beside the other vote routes"
! included | grep -q 'votes/famous' || fail "featured participants: rendered without its selector"
start votesFamous,votesFamous
expect /api/v3/votes/famous rust "featured participants on"
[[ $(included | grep -c 'location = /api/v3/votes/famous {') == 1 ]] || fail "featured participants duplicated"
featured=$(docker exec "$p-proxy" sed -n '/^location = \/api\/v3\/votes\/famous {$/,/^}$/p' /etc/nginx/rust-api-templates/votesFamous.location.conf.template)
[[ -n $featured && $(included | sed -n '/^location = \/api\/v3\/votes\/famous {$/,/^}$/p') == "$featured" ]] || fail "featured participants: rendered location differs from its template"
expect_upstream polis-api HEAD /api/v3/votes/famous
expect_upstream polis-api GET '/api/v3/votes/famous?conversation_id=2fixture&math_tick=5'
expect_upstream server OPTIONS /api/v3/votes/famous
expect_upstream server POST /api/v3/votes/famous $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/votes/famous $'Content-Length: 2\r\n' '{}'
expect /api/v3/votes node "featured participants leave the vote list alone"
expect /api/v3/votes/me node "featured participants leave the personal vote list alone"
expect /api/v3/comments node "featured participants leave comments alone"
expect /api/v3/nextComment node "featured participants leave the next comment alone"
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 handoff
# nginx resolves the replaced container again within its resolver's validity.
for _ in $(seq 40); do
  [[ $(get /api/v3/votes/famous) == node ]] && break
  sleep 0.5
done
expect /api/v3/votes/famous node "featured participants fallback"
echo "ok featured participants: off, unselected beside the vote routes, on/deduplicated, its template to the byte, methods/body, fallback"

# Participant-owned CSV have their own default-off selector.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/treevite/myInvites/csv node "invitation CSV off"
start myInvitesCsv,myInvitesCsv
expect /api/v3/treevite/myInvites/csv rust "invitation CSV on"
[[ $(included | grep -c 'location = /api/v3/treevite/myInvites/csv {') == 1 ]] || fail "invitation CSV duplicated"
expect_upstream polis-api HEAD /api/v3/treevite/myInvites/csv
expect_upstream server OPTIONS /api/v3/treevite/myInvites/csv
expect_upstream server POST /api/v3/treevite/myInvites/csv $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/treevite/myInvites/csv $'Content-Length: 2\r\n' '{}'
expect /api/v3/votes node "invitation CSV leave votes alone"
expect /api/v3/nextComment node "invitation CSV leave next statement alone"
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 handoff
sleep 6
expect /api/v3/treevite/myInvites/csv node "invitation CSV fallback"
echo "ok participant invitation CSV: off/on/deduplicated, methods/body, fallback"

# Bid rows have their own default-off selector.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/bid node "bid off"
start bid,bid
expect /api/v3/bid rust "bid on"
expect /api/v3/locations node "other math selector remains off"
[[ $(included | grep -c 'location = /api/v3/bid {') == 1 ]] || fail "bid duplicated"
expect_upstream polis-api HEAD /api/v3/bid
expect_upstream server OPTIONS /api/v3/bid
expect_upstream server POST /api/v3/bid $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/bid $'Content-Length: 2\r\n' '{}'
expect /api/v3/votes node "bid leave votes alone"
expect /api/v3/nextComment node "bid leave next statement alone"
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 handoff
sleep 6
expect /api/v3/bid node "bid fallback"
echo "ok bid: off/on/deduplicated, methods/body, fallback"

# Locations rows have their own default-off selector.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/locations node "locations off"
start locations,locations
expect /api/v3/locations rust "locations on"
expect /api/v3/bid node "other math selector remains off"
[[ $(included | grep -c 'location = /api/v3/locations {') == 1 ]] || fail "locations duplicated"
expect_upstream polis-api HEAD /api/v3/locations
expect_upstream server OPTIONS /api/v3/locations
expect_upstream server POST /api/v3/locations $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/locations $'Content-Length: 2\r\n' '{}'
expect /api/v3/votes node "locations leave votes alone"
expect /api/v3/nextComment node "locations leave next statement alone"
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 handoff
sleep 6
expect /api/v3/locations node "locations fallback"
echo "ok locations: off/on/deduplicated, methods/body, fallback"

# The conversation HTML route retains its default-off selector.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
for prefix in /; do expect "${prefix}4fixture" node "conversation page off"; done
for selector in conversationPage; do
 prefix=/
 start "$selector,$selector"
 expect "${prefix}4fixture" rust "conversation page on"
 expect "${prefix}4fixture/suffix" rust "conversation page prefix suffix"
 expect_upstream polis-api HEAD "${prefix}4fixture"
 expect_upstream server OPTIONS "${prefix}4fixture"
 expect_upstream server POST "${prefix}4fixture" $'Content-Length: 2\r\n' '{}'
 expect_upstream server GET "${prefix}4fixture" $'Content-Length: 2\r\n' '{}'
 expect /api/v3/votes node "page leaves votes alone"
 expect /api/v3/nextComment node "page leaves next statement alone"
done
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 handoff
sleep 6
start conversationPage
for prefix in /; do expect "${prefix}4fixture" node "conversation page handback"; done
echo "ok conversation HTML: default-off switch, suffix, methods/body, fallback"

# The real file-server checks emitted assets and the old 404 bytes. A prebuilt
# image permits offline runs; CI builds the current clients when unset.
files_image=${NGINX_FILE_SERVER_IMAGE:-$p-files:local}
if [[ -z ${NGINX_FILE_SERVER_IMAGE:-} ]]; then
  docker build -q -t "$files_image" -f "$root/file-server/Dockerfile" "$root" >/dev/null
fi
docker run -d --name "$p-files" --network "$net" --network-alias file-server \
  -p "127.0.0.1:${X54_FILES_PORT:-25467}:8080" -e PORT=8080 "$files_image" >/dev/null
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
for routes in '' pca2,conversationPage,robots,adminPage; do
  start "$routes"
  python3 "$root/file-server/nginx/test-edge-routing.py" "$p" "$routes" "$root"
done
# Local 404s must still work with both HTTP application upstreams stopped.
docker stop "$p-files" "$p-node" >/dev/null
python3 "$root/file-server/nginx/test-edge-routing.py" "$p" offline "$root"
echo "ok edge routing: local 404s, emitted assets, API and page destinations in both selections"

# Report route selection is independent of the overloaded statement list.
docker rm -f "$p-node" "$p-rust" >/dev/null
stub "$p-node" server 5000 200 node
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /api/v3/comments/report node "report list off"
start reportComments,reportComments
expect /api/v3/comments/report rust "report list on"
expect /api/v3/comments node "report list leaves legacy comments alone"
expect /api/v3/nextComment node "report list leaves participation alone"
[[ $(included | grep -c 'location = /api/v3/comments/report') == 1 ]] || fail "report list duplicated"
expect_upstream polis-api GET /api/v3/comments/report
expect_upstream polis-api HEAD /api/v3/comments/report
expect_upstream server POST /api/v3/comments/report $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/comments/report $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 fallback
expect /api/v3/comments/report node "report list handback"
echo "ok report list off/on/deduplicated, methods/body, handback"

# The ordinary access line, with nothing selected and with read routes
# selected: the path without its query string, the Referer without its query
# string and fragment, both address fields as before
# (file-server/nginx/test-access-log.py).
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
for routes in '' pca2,conversationPage,votesRead,comments,nextComment; do
  start "$routes"
  python3 "$root/file-server/nginx/test-access-log.py" "$p"
done
echo "ok access line: no query string and no Referer query string or fragment, with nothing selected and with read routes selected"
