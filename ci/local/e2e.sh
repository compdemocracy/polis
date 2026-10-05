#!/usr/bin/env bash
# E2E Tests / "cypress-run": the whole test stack (every service in
# docker-compose.test.yml, built from this checkout) and every Cypress spec
# under e2e/cypress/e2e, run headless on the host.
#
# The specs address the stack as http://localhost and the OIDC simulator as
# https://localhost:3000, so ports 80, 443 and 3000 stay fixed even when
# CHECK_PORT_BASE moves the others: one E2E stack per host at a time (the run
# waits for those ports to be free).
. "$(dirname "$0")/lib.sh"
check_init e2e
check_log "node $(node --version 2>/dev/null || echo none) (CI uses the runner default here)"
"$CHECK_LOCAL/certs.sh"
CERTS="$CHECK_ROOT/.simulacrum/certs"
export CAROOT="${CAROOT:-$CHECK_ROOT/.simulacrum/ca}"
# e2e's npm scripts read the CA through `mkcert -CAROOT`.
command -v mkcert >/dev/null 2>&1 || { PATH="$CHECK_ROOT/.check/bin:$PATH"; export PATH; }

cd "$CHECK_ROOT"
export POLIS_TEST_HTTP_PORT=80 POLIS_TEST_HTTPS_PORT=443 POLIS_TEST_OIDC_PORT=3000
check_stack_env "$CHECK_STATE/test.env" "AUTH_CERTS_PATH=./.simulacrum/certs"
# CI edited test.env in place, so the server container read the edited copy.
export SERVER_ENV_FILE="$CHECK_ENV_FILE"
grep -E "AUTH_|CERT|DATABASE_URL|POSTGRES_" "$CHECK_ENV_FILE" || true

check_wait_ports $(check_stack_ports)
check_stack_down_on_exit

check_group "build images"
# postgres without the layer cache, so the image always holds this checkout's
# migrations; everything else may use the cache.
check_compose build --no-cache postgres
check_compose build
check_endgroup

CHECK_INIT_SERVICES="dynamodb-init minio-init" check_up $(check_long_running_services)

check_group "re-apply every migration (server/bin/run-migrations.sh)"
# CI applied them from the checkout with the runner's psql; the postgres image's
# own psql does the same without a host client.
check_compose run --rm --no-deps -T -v "$CHECK_ROOT/server:/polis-server:ro" \
  -e "DATABASE_URL=postgres://postgres:PdwPNS2mDN73Vfbc@postgres:5432/polis-test" \
  --entrypoint sh postgres /polis-server/bin/run-migrations.sh
check_endgroup

check_wait_url "https://localhost:3000/.well-known/jwks.json"
check_wait_url "http://localhost:$POLIS_TEST_HTTP_PORT/api/v3/testConnection"

check_group "postgres initialization log"
{ check_compose logs postgres 2>&1 || true; } | head -200 || true
check_endgroup

check_npm e2e ci

set +e
(
  cd "$CHECK_ROOT/e2e"
  if [ -f .env ]; then
    check_log "WARNING: e2e/.env exists; keys it has that test.env lacks reach Cypress (CI has none)"
  fi
  # CI copied test.env to e2e/.env (AUTH_CERTS_PATH made relative to e2e/),
  # which cypress.config.js and the auth setup read with dotenv. Exporting the
  # same values is equivalent and leaves any developer e2e/.env alone.
  check_export_env_file "$CHECK_ENV_FILE"
  export AUTH_CERTS_PATH=../.simulacrum/certs
  export CYPRESS_BASE_URL="http://localhost"
  export AUTH_ISSUER=https://localhost:3000/
  check_group "auth setup check"
  node test-auth-setup.js || exit $?
  check_endgroup
  export NODE_EXTRA_CA_CERTS="$CERTS/rootCA.pem"
  export AUTH_CERTS_PATH="$CERTS"
  npm test
)
rc=$?
set -e
if [ "$rc" != 0 ]; then
  check_stack_logs nginx-proxy oidc-simulator server math-python
fi
exit "$rc"
