#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 22.23.4

(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts --no-audit --no-fund
)

if [ "${GITHUB_EVENT_NAME:-local}" = pull_request ]; then
  (
    cd "$CHECK_ROOT/."
    node server/characterization/routing/guard.cjs 'HEAD^1'
  )
fi

(
  cd "$CHECK_ROOT/."
  sh server/characterization/routing/check.sh
)
