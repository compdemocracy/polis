#!/bin/sh
# Guards the collective-statement recordings (server/characterization/collective-statement/).
#
# 1. The recordings are edge's behaviour. They, the harness inputs that decide
#    what is recorded (cases, fixtures, the stub, the egress guard, the reset
#    step, the shared fixture vote writer and Delphi table definitions) and the
#    comparison rules (main.cjs's normalizers and order exemptions,
#    expected.cjs) must not change together with the code they record:
#    otherwise a branch could re-record, or widen a rule, on its own changed
#    server and pass.
# 2. An intended change ships as named entries in expected-differences.json
#    (literal find/replace, one per case, with a ruling), which may change
#    together with server code. A re-record on edge absorbs them, so a
#    recordings change must leave that file empty.
# 3. A pull request to edge fails while any entry is still "pending" (the
#    replay also fails on it).
# Re-record procedure: see the header of main.cjs.
#
#   sh ci/collective_statement_golden_guard.sh <base-ref>     e.g. origin/edge
set -eu
base="$1"
dir="server/characterization/collective-statement"
expected="$dir/expected-differences.json"
changed=$(git diff --name-only "$base"...HEAD)
status=0

recorded=$(printf '%s\n' "$changed" |
  grep -E "^$dir/(recordings/|cases\.cjs$|fixtures\.cjs$|main\.cjs$|expected\.cjs$|stub\.cjs$|egress\.cjs$|reset_step\.py$)|^server/characterization/seed-vote\.cjs$|^server/characterization/delphi/tables\.cjs$|^server/characterization/dynamo-schema\.json$" || true)
code=$(printf '%s\n' "$changed" |
  grep -E '^server/(src/|app\.ts$|index\.ts$|package\.json$|package-lock\.json$|postgres/)|^delphi/umap_narrative/reset_conversation\.py$' || true)
if [ -n "$recorded" ] && [ -n "$code" ]; then
  echo "::error::The collective-statement recordings, their harness inputs or comparison rules change together with the code they record. Re-record in its own PR from edge, or add a named entry to $expected. Recording-side files changed:"
  printf '%s\n' "$recorded"
  echo "Code changed:"
  printf '%s\n' "$code"
  status=1
fi

if printf '%s\n' "$changed" | grep -q "^$dir/recordings/" &&
  ! python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["entries"] == [] else 1)' "$expected"; then
  echo "::error::The recordings are re-recorded while $expected still has entries. A re-record on edge absorbs them: empty the file in the same PR."
  status=1
fi

case "$base" in
  edge | */edge)
    pending=$(python3 -c 'import json,sys; print("\n".join(e.get("case","?") for e in json.load(open(sys.argv[1]))["entries"] if e.get("ruling") == "pending"))' "$expected")
    if [ -n "$pending" ]; then
      echo "::error::$expected has entries still pending a ruling; a pull request to edge cannot merge until each is ruled (\"ruled:<reference>\"):"
      printf '%s\n' "$pending"
      status=1
    fi
    ;;
esac

[ "$status" -eq 0 ] && echo "collective-statement guard: ok (recordings and rules vs code, re-record vs entries, rulings)."
exit "$status"
