#!/usr/bin/env bash
# E2E Tests: the whole test stack (every service in docker-compose.test.yml,
# built from this checkout) and the Cypress specs under e2e/cypress/e2e, run
# headless on this host. The hosted workflow (.github/workflows/cypress-tests.yml)
# calls this script and nothing else, so a run on any Docker host is the same
# check.
#
# Usage:
#   ci/local/e2e.sh                    every spec
#   ci/local/e2e.sh --shard I/N        only shard I of N (hosted CI runs N jobs)
#   ci/local/e2e.sh combine DIR...     merge shard result directories: prove every
#                                      spec ran in exactly one shard and add up
#                                      the counts per suite
#
# The host needs docker (compose v2), node and npm, mkcert, python3 and
# openssl, and ports 80, 443, 3000, 4321, 5432, 8000, 8005 and 9000 free: the
# specs reach the stack as http://localhost and the OIDC simulator as
# https://localhost:3000, and the client images are built with those URLs, so
# one E2E stack runs per host at a time.
#
# Knobs (all optional):
#   POLIS_TEST_IMAGES=T  run the stack from images built by
#                        `ci/local/test-images.sh build --tag T` instead of
#                        building them here
#   E2E_CHECK_PROJECT    compose project name (default: polis-e2e-<shard>)
#   E2E_CHECK_OUT        results directory (default: .ci-out/<project>)
#   E2E_CHECK_KEEP=1     leave the stack running afterwards
#
# Certificates: a CA from mkcert (its default CAROOT) signs one certificate for
# localhost, oidc-simulator and host.docker.internal, written with the CA's
# public certificate into the results directory; the containers mount that
# directory and Node trusts the CA through NODE_EXTRA_CA_CERTS. Nothing is
# installed into a trust store here (hosted CI runs `mkcert -install` first,
# as it always has).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log() { printf '[e2e] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }
group() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else printf '\n=== %s\n' "$*"; fi; }
endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }

# ---------------------------------------------------------------- combine
if [ "${1:-}" = "combine" ]; then
  shift
  [ $# -ge 1 ] || die "combine needs at least one shard result directory"
  OUT="${E2E_CHECK_OUT:-$ROOT/.ci-out/e2e-combined}"
  exec python3 ci/local/e2e_shards.py combine --out "$OUT" "$@"
fi

# ---------------------------------------------------------------- run
SHARD="1/1"
while [ $# -gt 0 ]; do
  case "$1" in
    --shard) [ $# -ge 2 ] || die "--shard needs I/N"; SHARD="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$SHARD" in [0-9]*/[0-9]*) ;; *) die "--shard must look like 2/4" ;; esac
SHARD_I="${SHARD%/*}"; SHARD_N="${SHARD#*/}"
[ "$SHARD_I" -ge 1 ] && [ "$SHARD_I" -le "$SHARD_N" ] || die "--shard out of range: $SHARD"
for tool in docker node npm mkcert python3 openssl curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

PROJECT="${E2E_CHECK_PROJECT:-polis-e2e-${SHARD_I}of${SHARD_N}}"
OUT="${E2E_CHECK_OUT:-$ROOT/.ci-out/$PROJECT}"
rm -rf "$OUT"; mkdir -p "$OUT/stack"
OUT="$(cd "$OUT" && pwd)"
STACK="$OUT/stack"   # compose inputs and certificates, kept apart from the results
log "project $PROJECT; shard $SHARD; results $OUT"

group "select this shard's specs"
python3 ci/local/e2e_shards.py plan --shard "$SHARD" --out "$OUT/manifest.json"
endgroup

group "certificates"
CERTS="$STACK/certs"
mkdir -p "$CERTS"
(cd "$CERTS" && mkcert -cert-file localhost.pem -key-file localhost-key.pem \
  localhost 127.0.0.1 ::1 oidc-simulator host.docker.internal)
cp "$(mkcert -CAROOT)/rootCA.pem" "$CERTS/rootCA.pem"
ls -la "$CERTS"
endgroup

# test.env with the certificate directory this run made. The server service
# still reads the checkout's test.env (env_file); it does not read
# AUTH_CERTS_PATH, which only places the certificate mount.
[ -f test.env ] || die "test.env not found"
sed "s|^AUTH_CERTS_PATH=.*|AUTH_CERTS_PATH=$CERTS|" test.env > "$STACK/test.env"
grep -E "AUTH_|CERT|DATABASE_URL|POSTGRES_" "$STACK/test.env" | grep -vE "SECRET|PASSWORD|KEY=" || true

COMPOSE_ARGS=(-p "$PROJECT" -f docker-compose.test.yml)
if [ -n "${POLIS_TEST_IMAGES:-}" ]; then
  bash ci/local/test-images.sh override "$POLIS_TEST_IMAGES" "$STACK/images.yml"
  COMPOSE_ARGS+=(-f "$STACK/images.yml")
fi
COMPOSE_ARGS+=(--env-file "$STACK/test.env")
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

cleanup() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ]; then
    group "service logs (failure)"
    compose ps
    for svc in nginx-proxy oidc-simulator server math-python postgres; do
      echo "=== $svc"
      compose logs --no-color --tail 300 "$svc" 2>&1
    done
    endgroup
  fi
  if [ -n "${E2E_CHECK_KEEP:-}" ]; then
    log "E2E_CHECK_KEEP set: leaving $PROJECT running"
  else
    compose down -v --remove-orphans >/dev/null 2>&1
  fi
  if [ "$rc" = 0 ]; then log "PASS"; else log "FAIL (exit $rc)"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "${POLIS_TEST_IMAGES:-}" ]; then
  log "using prebuilt images polis-test-*:$POLIS_TEST_IMAGES (not building)"
else
  group "build images (every service in docker-compose.test.yml)"
  compose build
  endgroup
fi

group "apply and check migrations"
# test-migrations.sh puts its own -f docker-compose.test.yml first; it reads the
# env file from POLIS_TEST_ENV_FILE.
extra=(-p "$PROJECT")
[ -z "${POLIS_TEST_IMAGES:-}" ] || extra+=(-f "$STACK/images.yml")
POLIS_TEST_ENV_FILE="$STACK/test.env" bash ci/test-migrations.sh "${extra[@]}"
endgroup

group "start the stack"
compose up -d
# The e2e dependencies install while the services start.
(cd e2e && npm ci --no-audit --no-fund) > "$OUT/npm-ci.log" 2>&1 &
npm_pid=$!
# Ready when the database, the OIDC simulator, the API through nginx and the
# participation client through nginx all answer.
ready() {
  compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1 &&
    curl -ksf -o /dev/null https://localhost:3000/.well-known/jwks.json &&
    curl -sf -o /dev/null http://localhost/api/v3/participationInit &&
    case "$(curl -s -o /dev/null -w '%{http_code}' http://localhost/alpha/)" in 2*|3*|4*) true ;; *) false ;; esac
}
waited=0
until ready; do
  [ "$waited" -lt 240 ] || { compose ps; die "the stack did not become ready in 240 s"; }
  sleep 2; waited=$((waited + 2))
done
log "stack ready after ${waited} s"
compose ps
wait "$npm_pid" || { cat "$OUT/npm-ci.log"; die "npm ci in e2e/ failed"; }
endgroup

group "postgres initialization log"
compose logs --no-color postgres 2>&1 | head -200 || true
endgroup

set +e
(
  cd e2e
  if [ -f .env ]; then
    log "WARNING: e2e/.env exists; keys it has that test.env lacks reach Cypress (CI has none)"
  fi
  # cypress.config.js and the auth setup check read test.env's values (CI used
  # to copy test.env to e2e/.env for dotenv; exported values take precedence
  # over a .env file, so a developer's e2e/.env is left alone). Read as dotenv
  # reads it: KEY=VALUE taken literally, no shell expansion.
  while IFS= read -r line; do
    case "$line" in [A-Za-z_]*=*) export "${line%%=*}=${line#*=}" ;; esac
  done < "$STACK/test.env"
  export AUTH_CERTS_PATH="$CERTS"
  export CYPRESS_BASE_URL=http://localhost
  export AUTH_ISSUER=https://localhost:3000/
  export NODE_EXTRA_CA_CERTS="$CERTS/rootCA.pem"
  group "auth setup check"
  node test-auth-setup.js || exit $?
  endgroup
  group "cypress (shard $SHARD)"
  node ../ci/local/e2e_run.cjs "$OUT/manifest.json" "$OUT"
  rc=$?
  endgroup
  exit $rc
)
rc=$?
set -e

if [ -f "$OUT/results.json" ]; then
  python3 ci/local/e2e_shards.py summary "$OUT" || rc=1
fi
exit "$rc"
