#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 24.22.1

(
  cd "$CHECK_ROOT/client-participation-alpha"
  npm ci --ignore-scripts
)

(
  cd "$CHECK_ROOT/client-participation-alpha"
  npm run format -- --check
)

(
  cd "$CHECK_ROOT/client-participation-alpha"
  npm run lint
)

(
  cd "$CHECK_ROOT/client-participation-alpha"
  npm run test:coverage
)

(
  cd "$CHECK_ROOT/client-participation-alpha"
  npm run build
)
