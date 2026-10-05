#!/usr/bin/env bash
# Run Jest Tests - client report / "test": jest.
. "$(dirname "$0")/lib.sh"
check_init client-report
check_use_node 24
check_npm client-report install
cd "$CHECK_ROOT/client-report"
npm test
