#!/usr/bin/env bash
# The Python tests under ci/ (private_cert, probe_box, tests). No workflow runs
# them yet (python-ci only copies some of these modules in for Delphi's tests to
# import): an entry point, not a gate.
. "$(dirname "$0")/lib.sh"
check_init ci-python
cd "$CHECK_ROOT"
check_venv engine coordinator-rs/evidence/python-requirements.txt
"$CHECK_PY" -m pytest -p no:cacheprovider -q ci/private_cert ci/probe_box ci/tests
