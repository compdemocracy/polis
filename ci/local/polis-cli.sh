#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
# The launcher runs python3, and its crates build into their own target
# directories, as on the hosted runner.
check_python python3
unset CARGO_TARGET_DIR

(
  cd "$CHECK_ROOT/."
  scripts/test-polis-cli.sh
)
