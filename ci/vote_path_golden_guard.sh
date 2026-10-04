#!/bin/sh
# The vote-path recordings' golden (server/__tests__/fixtures/vote-path-golden.json)
# is edge's served bytes. It may only be re-recorded on edge itself, so a change
# that touches it must not also change the server code it characterizes:
# otherwise a branch could re-record the golden on its own changed server and
# pass. Re-record procedure: see the header of
# server/__tests__/integration/vote-path-recordings.test.ts.
#
#   sh ci/vote_path_golden_guard.sh <base-ref>     e.g. origin/edge
set -eu
base="$1"
golden="server/__tests__/fixtures/vote-path-golden.json"
changed=$(git diff --name-only "$base"...HEAD)
if printf '%s\n' "$changed" | grep -qx "$golden"; then
  server=$(printf '%s\n' "$changed" |
    grep -E '^server/(src/|app\.ts$|index\.ts$|package\.json$|package-lock\.json$|postgres/)' || true)
  if [ -n "$server" ]; then
    echo "::error::$golden changes together with server code. Re-record the golden in its own PR from edge (see the test header). Server files changed:"
    printf '%s\n' "$server"
    exit 1
  fi
  echo "vote-path golden changed; no server code changed alongside it."
else
  echo "vote-path golden unchanged."
fi
