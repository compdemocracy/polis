#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 24.22.1

# The package has no dependencies: Node's own test runner runs its tests.
node --test client-topic-map/test/*.test.js
