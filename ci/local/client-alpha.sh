#!/usr/bin/env bash
# Client Participation Alpha CI / "verify": formatting check (read-only, unlike
# `npm run verify`, which rewrites), lint, jest with coverage, astro build.
. "$(dirname "$0")/lib.sh"
check_init client-alpha
check_use_node 24
check_npm client-participation-alpha ci
cd "$CHECK_ROOT/client-participation-alpha"
npm run format -- --check
npm run lint
npm run test:coverage
npm run build
