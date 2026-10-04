#!/usr/bin/env bash
# The two-convention gate (P-078 PR-F), end to end, locally or in CI.
#
#   ci/vote_convention/run.sh [OUT]          # default OUT: .vote-gate (git-ignored)
#
# Starts one throwaway Postgres (the server migrations as its template), loads the
# same semantic fixture set at v0 (agree = -1) and at v1 (agree = +1), runs the
# Python engine leg and the server leg under each, then:
#   compare.py v0  -> required: today's convention reproduces its recordings
#   compare.py v1  -> v0 against v1, byte for byte; expected red until PR-A/B/C
# Exit status: non-zero when v0 is red or v1 has an unexpected red (the ratchet);
# set VOTE_GATE_STRICT=1 to also fail on an expected v1 red,
# VOTE_GATE_V1=separate to leave the v1 verdict to the caller (the CI workflow).
#
# Needs: docker, Python with delphi's requirements (PYTHON, default python3),
# server/node_modules (npm ci in server/). Nothing reaches a cloud service.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$(mkdir -p "${1:-$ROOT/.vote-gate}" && cd "${1:-$ROOT/.vote-gate}" && pwd)"
PY="${PYTHON:-python3}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-p078f}"
export VOTE_GATE_PG_PORT="${VOTE_GATE_PG_PORT:-5470}"
export PYTHONPATH="$ROOT/delphi${PYTHONPATH:+:$PYTHONPATH}"
export TZ=UTC OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}" OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-1}"
COMPOSE=(docker compose -f "$HERE/compose.yml")

cleanup() { [ -n "${VOTE_GATE_KEEP_DB:-}" ] || "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1; }
trap cleanup EXIT

"${COMPOSE[@]}" up -d --wait || exit 2
rm -rf "$OUT/v0" "$OUT/v1"
for leg in v0 v1; do
  echo "::group::provision + legs at $leg"
  "$PY" "$HERE/provision.py" --convention "$leg" --database "gate_$leg" || exit 2
  "$PY" "$HERE/engine_leg.py" --database "gate_$leg" --convention "$leg" --out "$OUT/$leg" || exit 2
  node "$HERE/server_leg.cjs" --database "gate_$leg" --out "$OUT/$leg" 2>"$OUT/server-$leg.log" || { tail -40 "$OUT/server-$leg.log"; exit 2; }
  echo "::endgroup::"
done

"$PY" "$HERE/compare.py" v0 "$OUT"; v0=$?
if [ "${VOTE_GATE_V1:-}" = separate ]; then exit $v0; fi  # CI runs the v1 verdict as its own step
"$PY" "$HERE/compare.py" v1 "$OUT"; v1=$?
case $v1 in
  0) v1_text=green ;;
  3) v1_text="red, every red family expected (until PR-A/B/C)" ;;
  *) v1_text="UNEXPECTED red (the ratchet fails)" ;;
esac
echo "two-convention gate: v0 $([ $v0 = 0 ] && echo green || echo RED); v1 $v1_text"
[ $v0 != 0 ] && exit $v0
[ $v1 != 0 ] && [ $v1 != 3 ] && exit 1
[ -n "${VOTE_GATE_STRICT:-}" ] && [ $v1 != 0 ] && exit 1
exit 0
