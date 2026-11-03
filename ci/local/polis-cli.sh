#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_python

(
  cd "$CHECK_ROOT/."
  scripts/test-polis-cli.sh
)
