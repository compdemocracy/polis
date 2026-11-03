#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"


(
  cd "$CHECK_ROOT/."
  python3 -m unittest ci/vote_convention/test_gate.py
  python3 ci/vote_convention/sign_lint.py
)
