#!/usr/bin/env bash
# The CDK stack's jest tests. No workflow runs them yet: an entry point, not a gate.
. "$(dirname "$0")/lib.sh"
check_init cdk
check_use_node 24
check_npm cdk ci
cd "$CHECK_ROOT/cdk"
npx jest --ci
