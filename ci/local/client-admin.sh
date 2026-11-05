#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 24.22.1

(
  cd "$CHECK_ROOT/client-admin"
  npm ci --ignore-scripts
)

(
  cd "$CHECK_ROOT/client-admin"
  npm run test:coverage
)
