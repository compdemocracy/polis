#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT VOTE_GATE_PG_PORT
check_node 22.23.4
check_python
export POLIS_RECOVERY_PG_PORT="${POLIS_RECOVERY_PG_PORT:-${VOTE_GATE_PG_PORT:?}}"
 : "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT VOTE_GATE_PG_PORT
check_project "$COMPOSE_PROJECT_NAME"
: "${OUT:?choose an owned output directory}"
: "${VOTE_GATE_PG_PORT:?choose a free test port}"

(
  cd "$CHECK_ROOT/."
  python -m pip install -r coordinator-rs/evidence/python-requirements.txt
  npm ci --ignore-scripts --prefix server
)

(
  cd "$CHECK_ROOT/."
  PYTHONPATH=delphi python -m unittest ci/vote_convention/test_fixtures_declared.py
  node --test server/characterization/stored-votes.test.cjs
  python coordinator-rs/ci/replay_pins_convention.py --check
)

(
  cd "$CHECK_ROOT/."
  export VOTE_GATE_V1=separate
  export PYTHON=python
  ci/vote_convention/run.sh "$OUT"
)

(
  cd "$CHECK_ROOT/."
  python ci/vote_convention/compare.py v1 "$OUT"
) || true # This comparison is advisory; the ratchet below is required.

(
  cd "$CHECK_ROOT/."
  python ci/vote_convention/compare.py v1 "$OUT" --ratchet
)
