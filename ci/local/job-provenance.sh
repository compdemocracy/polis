#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 22.23.4

(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts --no-audit --no-fund
)

(
  cd "$CHECK_ROOT/."
  sh server/characterization/jobviews/check-provenance.sh
)
