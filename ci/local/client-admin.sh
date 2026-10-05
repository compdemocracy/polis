#!/usr/bin/env bash
# Run Jest Tests - client admin / "test": jest with coverage.
. "$(dirname "$0")/lib.sh"
check_init client-admin
check_use_node 24
check_npm client-admin ci
cd "$CHECK_ROOT/client-admin"
npm run test:coverage
