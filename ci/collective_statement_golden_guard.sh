#!/bin/sh
# The collective-statement recordings (server/characterization/collective-statement/)
# are edge's behaviour. They, and the harness inputs that decide what is recorded,
# may only be re-recorded on edge itself, so a change that touches them must not
# also change the code they characterize: otherwise a branch could re-record on
# its own changed server and pass. An intended behaviour change goes through a
# named entry in expected-differences.json (with a ruling state) instead, which
# may change together with server code. Re-record procedure: see the header of
# server/characterization/collective-statement/main.cjs.
#
#   sh ci/collective_statement_golden_guard.sh <base-ref>     e.g. origin/edge
set -eu
base="$1"
dir="server/characterization/collective-statement"
changed=$(git diff --name-only "$base"...HEAD)
recorded=$(printf '%s\n' "$changed" |
  grep -E "^$dir/(recordings/|cases\.cjs$|fixtures\.cjs$|main\.cjs$|stub\.cjs$|egress\.cjs$|reset_step\.py$)" || true)
if [ -n "$recorded" ]; then
  code=$(printf '%s\n' "$changed" |
    grep -E '^server/(src/|app\.ts$|index\.ts$|package\.json$|package-lock\.json$|postgres/)|^delphi/umap_narrative/reset_conversation\.py$' || true)
  if [ -n "$code" ]; then
    echo "::error::The collective-statement recordings or their harness change together with the code they record. Re-record in its own PR from edge, or add a named entry to $dir/expected-differences.json. Recording files changed:"
    printf '%s\n' "$recorded"
    echo "Code changed:"
    printf '%s\n' "$code"
    exit 1
  fi
  echo "collective-statement recordings changed; no recorded code changed alongside them."
else
  echo "collective-statement recordings unchanged."
fi
