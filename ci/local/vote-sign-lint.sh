#!/usr/bin/env bash
# Vote convention gate / "vote-sign literal lint": the gate's unit tests and the
# lint that fails on a new hand-written vote-sign literal.
. "$(dirname "$0")/lib.sh"
check_init vote-sign-lint
cd "$CHECK_ROOT"
python3 -m unittest ci/vote_convention/test_gate.py
python3 ci/vote_convention/sign_lint.py
