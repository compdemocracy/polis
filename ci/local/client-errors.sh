#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 24.22.1
(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts
)
node --test ci/local/client-errors.test.cjs \
  client-participation/js/util/__tests__/clientErrorReporter.test.cjs \
  client-participation/js/util/__tests__/clientErrorHooks.test.cjs \
  client-participation/js/util/__tests__/clientErrorReads.test.cjs
