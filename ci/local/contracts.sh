#!/usr/bin/env bash
# Server Integration Tests / "Generated contract files match the TypeBox source":
# fails when a committed generated contract file (server, client-participation-alpha,
# client-report) differs from what server/src/contracts generates.
# Fix with `npm run contract:generate` in server/ and commit the result.
. "$(dirname "$0")/lib.sh"
check_init contracts
check_use_node 24
check_npm server ci
cd "$CHECK_ROOT/server"
npm run contract:check
