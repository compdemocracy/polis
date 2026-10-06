#!/bin/sh
# Guards the vote-path recordings (server/__tests__/integration/vote-path-recordings.test.ts).
#
# 1. The golden (server/__tests__/fixtures/vote-path-golden.json) is edge's
#    served bytes. It may only be re-recorded on edge itself, so a change that
#    touches it must not also change the server code it characterizes;
#    otherwise a branch could re-record the golden on its own changed server.
# 2. The same holds for the comparison rules: the recordings test (its
#    normalizers, order exemptions and masks) and the expected-differences
#    module must not change together with server code, or a branch could
#    widen a normalizer to hide its own change.
# 3. An intended change ships as named entries in
#    server/__tests__/fixtures/vote-path-expected-differences.json. A golden
#    re-record absorbs them, so it must leave that file empty.
# 4. Every entry needs a ruling: a pull request to edge fails while any entry
#    is still "pending".
#
#   sh ci/vote_path_golden_guard.sh <base-ref>     e.g. origin/edge
set -eu
base="$1"
golden="server/__tests__/fixtures/vote-path-golden.json"
expected="server/__tests__/fixtures/vote-path-expected-differences.json"
rules="server/__tests__/integration/vote-path-recordings.test.ts server/__tests__/setup/vote-path-expected.ts"
changed=$(git diff --name-only "$base"...HEAD)
server=$(printf '%s\n' "$changed" |
  grep -E '^server/(src/|app\.ts$|index\.ts$|package\.json$|package-lock\.json$|postgres/)' || true)
status=0

guarded=""
if printf '%s\n' "$changed" | grep -qx "$golden"; then guarded="$golden"; fi
for f in $rules; do
  if printf '%s\n' "$changed" | grep -qx "$f"; then guarded="$guarded $f"; fi
done
if [ -n "$guarded" ] && [ -n "$server" ]; then
  echo "::error::$guarded change(s) together with server code. Change the vote-path golden or its comparison rules in a PR of their own from edge (see the test header). Server files changed:"
  printf '%s\n' "$server"
  status=1
fi

if printf '%s\n' "$changed" | grep -qx "$golden" && [ -f "$expected" ] &&
  ! python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["entries"] == [] else 1)' "$expected"; then
  echo "::error::$golden is re-recorded while $expected still has entries. A re-record on edge absorbs them: empty the file in the same PR."
  status=1
fi

case "$base" in
  edge | */edge)
    if [ -f "$expected" ]; then
      pending=$(python3 -c 'import json,sys; print("\n".join(e["case"] for e in json.load(open(sys.argv[1]))["entries"] if e.get("ruling") == "pending"))' "$expected")
      if [ -n "$pending" ]; then
        echo "::error::$expected has entries still pending a ruling; a pull request to edge cannot merge until each is ruled (\"ruled:<reference>\"):"
        printf '%s\n' "$pending"
        status=1
      fi
    fi
    ;;
esac

[ "$status" -eq 0 ] && echo "vote-path guard: ok (golden and rules vs server code, re-record vs entries, rulings)."
exit "$status"
