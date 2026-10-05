#!/usr/bin/env bash
# Lint / "eslint": install and ESLint each package CI lints, in CI's order.
. "$(dirname "$0")/lib.sh"
check_init lint
check_use_node 24
for pkg in client-admin server client-report e2e; do
  check_npm "$pkg" install
  check_group "ESLint: $pkg"
  (cd "$CHECK_ROOT/$pkg" && npm run lint)
  check_endgroup
done
