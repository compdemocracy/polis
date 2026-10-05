#!/usr/bin/env bash
# Verify that every repository input read by a suite reaches that suite through
# changed-suites.sh. This check needs Python and git, but no containers.
. "$(dirname "$0")/lib.sh"
check_init selector-test
python3 "$CHECK_LOCAL/test_changed_suites.py"
