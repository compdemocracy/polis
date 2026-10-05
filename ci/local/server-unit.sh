#!/usr/bin/env bash
# The server's unit tests alone (server/__tests__/unit), no containers. CI runs
# them inside check-server-integration; this is the seconds-long agent-loop tier.
. "$(dirname "$0")/lib.sh"
check_init server-unit
check_use_node 24
check_npm server ci
check_stack_env "$CHECK_STATE/test.env"
cd "$CHECK_ROOT/server"
# The same environment the integration job gives jest (test.env, NODE_ENV=test),
# with no containers behind it: unit tests must not need them.
check_export_env_file "$CHECK_ENV_FILE"
export NODE_ENV=test
export DATABASE_URL="postgres://postgres:PdwPNS2mDN73Vfbc@localhost:$POLIS_TEST_PG_PORT/polis-test"
npx jest --ci /__tests__/unit/
