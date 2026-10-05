#!/usr/bin/env bash
# The legacy participation client's tests (`node --test`). No workflow runs
# them yet: an entry point, not a gate.
. "$(dirname "$0")/lib.sh"
check_init client-participation
check_use_node 24
check_npm client-participation ci
cd "$CHECK_ROOT/client-participation"
npm test
