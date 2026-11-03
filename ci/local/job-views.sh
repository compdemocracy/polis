#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 22.23.4
export TZ=UTC

(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts --no-audit --no-fund
)

(
  cd "$CHECK_ROOT/client-report"
  npm ci --ignore-scripts --no-audit --no-fund
)

if [ "${GITHUB_EVENT_NAME:-local}" = pull_request ]; then
  (
    cd "$CHECK_ROOT/."
    node server/characterization/jobviews/view-guard.cjs 'HEAD^1'
  )
fi

(
  cd "$CHECK_ROOT/client-report"
  npm run test:jobviews
)
