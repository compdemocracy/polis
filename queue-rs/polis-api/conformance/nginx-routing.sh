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
expect /about node "about off"
start about,about
expect /about rust "about on"
expect /api/v3/comments node "about leaves comments alone"
expect /api/v3/votes node "about leaves voting alone"
[[ $(included | grep -c 'location = /about') == 1 ]] || fail "about duplicated"
expect_upstream polis-api GET /about
expect_upstream polis-api HEAD /about
expect_upstream server OPTIONS /about
expect_upstream server POST /about $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /about $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /about node "about handoff"
echo "ok 16 about off/on/deduplicated; method/body guards; 502 hands back to Node"

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
expect /api/v3/math/pca node "legacyPca off"
start legacyPca,legacyPca
expect /api/v3/math/pca rust "legacyPca on"
expect /api/v3/comments node "legacyPca leaves comments alone"
expect /api/v3/votes node "legacyPca leaves voting alone"
[[ $(included | grep -c 'location = /api/v3/math/pca') == 1 ]] || fail "legacyPca duplicated"
expect_upstream polis-api GET /api/v3/math/pca
expect_upstream polis-api HEAD /api/v3/math/pca
expect_upstream server OPTIONS /api/v3/math/pca
expect_upstream server POST /api/v3/math/pca $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /api/v3/math/pca $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /api/v3/math/pca node "legacyPca handoff"
echo "ok 26 legacyPca off/on/deduplicated; method/body guards; 502 hands back to Node"


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
expect /conversation/create node "createPage off"
start createPage,createPage
expect /conversation/create rust "createPage on"
expect /conversation/create/step rust "createPage nested path"
expect /conversation/createSuffix rust "createPage prefix semantics"
expect /conversation/creat node "createPage neighbor"
expect /api/v3/comments node "createPage leaves comments alone"
expect /api/v3/votes node "createPage leaves voting alone"
[[ $(included | grep -c 'location ~ ^/conversation/create') == 1 ]] || fail "createPage duplicated"
expect_upstream polis-api GET /conversation/create
expect_upstream polis-api HEAD /conversation/create
expect_upstream server OPTIONS /conversation/create
expect_upstream server POST /conversation/create $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /conversation/create $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /conversation/create node "createPage handoff"
echo "ok 43 createPage off/on/deduplicated; method/body guards; 502 hands back to Node"




docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /user/create node "userCreatePage off"
start userCreatePage,userCreatePage
expect /user/create rust "userCreatePage on"
expect /user/create/step rust "userCreatePage nested path"
expect /user/createSuffix node "userCreatePage anchored neighbor"
expect /user/creat node "userCreatePage neighbor"
expect /api/v3/comments node "userCreatePage leaves comments alone"
expect /api/v3/votes node "userCreatePage leaves voting alone"
[[ $(included | grep -c 'location ~ ^/user/create') == 1 ]] || fail "userCreatePage duplicated"
expect_upstream polis-api GET /user/create
expect_upstream polis-api HEAD /user/create
expect_upstream server OPTIONS /user/create
expect_upstream server POST /user/create $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /user/create $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /user/create node "userCreatePage handoff"
echo "ok 44 userCreatePage off/on/deduplicated; method/body guards; 502 hands back to Node"




docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /user/login node "userLoginPage off"
start userLoginPage,userLoginPage
expect /user/login rust "userLoginPage on"
expect /user/login/step rust "userLoginPage nested path"
expect /user/loginSuffix node "userLoginPage anchored neighbor"
expect /user/logi node "userLoginPage neighbor"
expect /api/v3/comments node "userLoginPage leaves comments alone"
expect /api/v3/votes node "userLoginPage leaves voting alone"
[[ $(included | grep -c 'location ~ ^/user/login') == 1 ]] || fail "userLoginPage duplicated"
expect_upstream polis-api GET /user/login
expect_upstream polis-api HEAD /user/login
expect_upstream server OPTIONS /user/login
expect_upstream server POST /user/login $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /user/login $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /user/login node "userLoginPage handoff"
echo "ok 45 userLoginPage off/on/deduplicated; method/body guards; 502 hands back to Node"




docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /settings node "settingsPage off"
start settingsPage,settingsPage
expect /settings rust "settingsPage on"
expect /settings/step rust "settingsPage nested path"
expect /settingsSuffix node "settingsPage anchored neighbor"
expect /setting node "settingsPage neighbor"
expect /api/v3/comments node "settingsPage leaves comments alone"
expect /api/v3/votes node "settingsPage leaves voting alone"
[[ $(included | grep -c 'location ~ ^/settings') == 1 ]] || fail "settingsPage duplicated"
expect_upstream polis-api GET /settings
expect_upstream polis-api HEAD /settings
expect_upstream server OPTIONS /settings
expect_upstream server POST /settings $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /settings $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /settings node "settingsPage handoff"
echo "ok 46 settingsPage off/on/deduplicated; method/body guards; 502 hands back to Node"




docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /user/logout node "userLogoutPage off"
start userLogoutPage,userLogoutPage
expect /user/logout rust "userLogoutPage on"
expect /user/logout/step rust "userLogoutPage nested path"
expect /user/logoutSuffix node "userLogoutPage anchored neighbor"
expect /user/logou node "userLogoutPage neighbor"
expect /api/v3/comments node "userLogoutPage leaves comments alone"
expect /api/v3/votes node "userLogoutPage leaves voting alone"
[[ $(included | grep -c 'location ~ ^/user/logout') == 1 ]] || fail "userLogoutPage duplicated"
expect_upstream polis-api GET /user/logout
expect_upstream polis-api HEAD /user/logout
expect_upstream server OPTIONS /user/logout
expect_upstream server POST /user/logout $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /user/logout $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /user/logout node "userLogoutPage handoff"
echo "ok 47 userLogoutPage off/on/deduplicated; method/body guards; 502 hands back to Node"




docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /m/2fixture node "adminPage off"
start adminPage,adminPage
expect /m/2fixture rust "adminPage on"
expect /m/2fixture/step rust "adminPage nested path"
expect /m/2fixtureSuffix rust "adminPage prefix suffix"
expect /m/2 node "adminPage neighbor"
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
expect /integrat node "integratePage neighbor"
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
expect /other-conversations node "otherConversationsPage off"
start otherConversationsPage,otherConversationsPage
expect /other-conversations rust "otherConversationsPage on"
expect /other-conversations/step rust "otherConversationsPage nested path"
expect /other-conversationsSuffix rust "otherConversationsPage prefix suffix"
expect /other-conversation node "otherConversationsPage neighbor"
expect /api/v3/comments node "otherConversationsPage leaves comments alone"
expect /api/v3/votes node "otherConversationsPage leaves voting alone"
[[ $(included | grep -Fc 'location ~ ^/other-conversations') == 1 ]] || fail "otherConversationsPage duplicated"
expect_upstream polis-api GET /other-conversations
expect_upstream polis-api HEAD /other-conversations
expect_upstream server OPTIONS /other-conversations
expect_upstream server POST /other-conversations $'Content-Length: 2\r\n' '{}'
expect_upstream server GET /other-conversations $'Content-Length: 2\r\n' '{}'
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 "handoff"
sleep 6
expect /other-conversations node "otherConversationsPage handoff"
echo "ok 50 otherConversationsPage off/on/deduplicated; method/body guards; 502 hands back to Node"




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

# Each conversation link page has an independent switch.
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 200 rust
start ""
expect /iip/4fixture node "participation link off"
expect /iim/4fixture node "moderation link off"
for route in iip iim; do
  start "$route,$route"
  expect "/$route/4fixture" rust "link page on"
  expect "/$route/4fixture/" rust "link page trailing slash"
  expect_upstream polis-api HEAD "/$route/4fixture"
  expect_upstream server POST "/$route/4fixture" $'Content-Length: 2\r\n' '{}'
  expect_upstream server OPTIONS "/$route/4fixture"
  expect_upstream server GET "/$route/4fixture" $'Content-Length: 2\r\n' '{}'
  expect /api/v3/votes node "link leaves votes alone"
  expect /api/v3/nextComment node "link leaves next statement alone"
  if [[ $route == iip ]]; then expect /iim/4fixture node "moderation switch independent"; else expect /iip/4fixture node "participation switch independent"; fi
done
docker rm -f "$p-rust" >/dev/null
stub "$p-rust" polis-api 5100 502 handoff
sleep 6
start iip,iim
expect /iip/4fixture node "participation link fallback"
expect /iim/4fixture node "moderation link fallback"
echo "ok conversation links: independent off/on, methods/body, fallback"

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
