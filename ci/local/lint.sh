#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 24.22.1

(
  cd "$CHECK_ROOT/client-admin"
  npm ci --ignore-scripts
)

(
  cd "$CHECK_ROOT/client-admin"
  npm run lint
)

(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts
)

(
  cd "$CHECK_ROOT/server"
  npm run lint
)

(
  cd "$CHECK_ROOT/client-report"
  npm ci --ignore-scripts
)

(
  cd "$CHECK_ROOT/client-report"
  npm run lint
)

(
  cd "$CHECK_ROOT/e2e"
  npm ci --ignore-scripts
)

(
  cd "$CHECK_ROOT/e2e"
  npm run lint
)
