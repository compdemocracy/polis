#!/usr/bin/env bash
# Vote convention gate / "two storage conventions": the fixture declarations and
# writers, then the same fixtures loaded at storage convention v0 (today's stored sign)
# and v1 (the opposite stored sign) with every vote-reading suite run under each.
#   v0 verdict       required
#   v1 against v0    reported, not required (expected red until PR-A/B/C land)
#   v1 ratchet       required: no red outside the expected list
# Outputs and verdicts land in OUT (default .vote-gate, which CI uploads).
. "$(dirname "$0")/lib.sh"
check_init vote-gate
check_use_node 24
cd "$CHECK_ROOT"
check_venv engine coordinator-rs/evidence/python-requirements.txt
check_npm server ci
OUT="${OUT:-$CHECK_ROOT/.vote-gate}"
export COMPOSE_PROJECT_NAME="$CHECK_PROJECT"
export VOTE_GATE_PG_PORT="$(check_port 10 5470)"
check_wait_ports "$VOTE_GATE_PG_PORT"

check_group "fixture declarations, fixture writers, fold adapter, +1 pins"
PYTHONPATH=delphi "$CHECK_PY" -m unittest ci/vote_convention/test_fixtures_declared.py
node --test server/characterization/stored-votes.test.cjs
"$CHECK_PY" coordinator-rs/ci/replay_pins_convention.py --check
check_endgroup

check_group "v0 (today's stored sign): provision both conventions, run every leg, verdict on v0"
VOTE_GATE_V1=separate PYTHON="$CHECK_PY" ci/vote_convention/run.sh "$OUT"
check_endgroup

check_group "v1 (the opposite stored sign) against v0: informational, expected red until PR-A/B/C"
set +e
"$CHECK_PY" ci/vote_convention/compare.py v1 "$OUT"
v1=$?
set -e
case "$v1" in
  0) check_log "v1 against v0: green" ;;
  3) check_log "v1 against v0: red, every red family expected (exit 3; not required)" ;;
  *) check_log "v1 against v0: exit $v1 (not required; the ratchet below decides)" ;;
esac
check_endgroup

check_group "v1 ratchet: no unexpected red (required)"
"$CHECK_PY" ci/vote_convention/compare.py v1 "$OUT" --ratchet
check_endgroup
