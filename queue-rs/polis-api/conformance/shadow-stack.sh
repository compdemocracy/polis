#!/usr/bin/env bash
# The shadow service as docker-compose.yml defines it, with the override the
# web deploy writes (scripts/after_install.sh), behind the production nginx
# image, beside the real Node server and PostgreSQL built from the
# migrations. Nothing here is a stand-in but the participation client nginx
# resolves at startup.
#
# It runs one fixed series of comments through nginx twice, each time on a
# new database: with nothing selected, then with votesShadow,commentsShadow.
# The second time the shadow service is, in turn, started without the comment
# observer's switch (as it runs before commentsShadow is ever selected),
# started with it, paused, stopped and started again. Node's replies must be
# the same bytes in both runs, whatever the shadow service is doing
# (shadow-stack.py). It also checks, against the real /health:
#   - without the switch the service starts and serves exactly what the vote
#     shadow serves: no postComments, and scripts/validate_service.sh's own
#     predicate accepts it for a route list without commentsShadow and
#     refuses it for one with; a comment copy is answered 404;
#   - with the switch /health has postComments in observe mode, and the
#     predicate accepts it with commentsShadow and refuses it without;
#   - each copy nginx sends is observed under the request id Node logged;
#   - a comment and a vote posted with a query string are copied with it, and
#     observed as handed back for that reason (shape_query), whether Node
#     answered 200 (the conversation also in the body) or 400 (only there);
#   - how many database connections the shadow service holds with both
#     observers at work;
#   - the deploy hook's read-backs of the composed shadow service, run with
#     jq on what Compose composes: the override the hook writes is accepted,
#     and a composition that replaced the service's environment list is not.
#
# Usage, from the repository root:
#   queue-rs/polis-api/conformance/shadow-stack.sh
# Images, each built here when its variable is unset: POLIS_API_TEST_IMAGE
# (polis-api), SHADOW_STACK_SERVER_IMAGE (server/Dockerfile),
# SHADOW_STACK_POSTGRES_IMAGE (server/Dockerfile-db), X54_NGINX_IMAGE
# (file-server/nginx.Dockerfile). SHADOW_STACK_PROJECT names the Compose
# project; SHADOW_STACK_PORT and SHADOW_STACK_TLS_PORT are loopback ports.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
python3 "$root/ci/host_ports.py" env SHADOW_STACK_PORT SHADOW_STACK_TLS_PORT
project=${SHADOW_STACK_PROJECT:-shadow-stack-$$}
port=${SHADOW_STACK_PORT:-25468}
tls_port=${SHADOW_STACK_TLS_PORT:-25469}
commit=${GITHUB_SHA:-$(git -C "$root" rev-parse --verify HEAD)}
api_image=${POLIS_API_TEST_IMAGE:-$project-api:local}
server_image=${SHADOW_STACK_SERVER_IMAGE:-$project-server:local}
postgres_image=${SHADOW_STACK_POSTGRES_IMAGE:-$project-postgres:local}
nginx_image=${X54_NGINX_IMAGE:-$project-nginx:local}
work=$(mktemp -d "${TMPDIR:-/tmp}/shadow-stack.XXXXXX")
compose=(docker compose -p "$project" --env-file "$work/stack.env" -f "$root/docker-compose.yml" -f "$work/override.yml")
cleanup() {
  "${compose[@]}" --profile rust-api down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
if [[ -z ${POLIS_API_TEST_IMAGE:-} ]]; then
  docker build -q --build-arg GIT_HASH="$commit" -t "$api_image" -f "$root/queue-rs/polis-api/Dockerfile" "$root" >/dev/null
fi
if [[ -z ${SHADOW_STACK_SERVER_IMAGE:-} ]]; then
  docker build -q --build-arg GIT_HASH="$commit" -t "$server_image" -f "$root/server/Dockerfile" "$root" >/dev/null
fi
if [[ -z ${SHADOW_STACK_POSTGRES_IMAGE:-} ]]; then
  docker build -q --build-context queue-rs="$root/queue-rs" -t "$postgres_image" -f "$root/server/Dockerfile-db" "$root/server" >/dev/null
fi
if [[ -z ${X54_NGINX_IMAGE:-} ]]; then
  docker build -q -t "$nginx_image" -f "$root/file-server/nginx.Dockerfile" "$root/file-server" >/dev/null
fi
# The repository's test environment, with this stack's database and ports.
# Node and the shadow service read the same document, as on a web box.
grep -vE '^(COMPOSE_PROJECT_NAME|TAG|SERVER_ENV_FILE|SERVER_LOG_LEVEL|TOPICAL_COMMENT_RATIO|POSTGRES_[A-Z]+|DATABASE_URL|RUST_API_ROUTES|HTTP_PORT|HTTPS_PORT)=' \
  "$root/test.env" > "$work/stack.env"
cat >> "$work/stack.env" <<ENV
TAG=$project
SERVER_ENV_FILE=$work/stack.env
SERVER_LOG_LEVEL=info
POSTGRES_DB=polis-test
POSTGRES_USER=postgres
POSTGRES_PASSWORD=shadow-stack
DATABASE_URL=postgres://postgres:shadow-stack@postgres:5432/polis-test
POLIS_API_DB_TRANSPORT=docker-internal
POLIS_API_DB_PLAIN_HOSTS=postgres
HTTP_PORT=127.0.0.1:$port
HTTPS_PORT=127.0.0.1:$tls_port
ENV
export SHADOW_STACK_WORK=$work SHADOW_STACK_API_IMAGE=$api_image SHADOW_STACK_SERVER_IMAGE=$server_image \
  SHADOW_STACK_POSTGRES_IMAGE=$postgres_image SHADOW_STACK_NGINX_IMAGE=$nginx_image \
  SHADOW_STACK_PORT=$port SHADOW_STACK_PROJECT=$project SHADOW_STACK_ROOT=$root
python3 "$root/queue-rs/polis-api/conformance/shadow-stack.py"
