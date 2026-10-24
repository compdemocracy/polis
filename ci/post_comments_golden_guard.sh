#!/bin/sh
# Recordings and their inputs/comparison rules must never change alongside
# serving code. Expected differences are literal changes with a ruling; a
# golden refresh must absorb them and leave the entries empty. Shared recorder
# modules are guarded too, so another profile cannot hide a comment difference.
# Usage: sh ci/post_comments_golden_guard.sh origin/edge
set -eu
base="$1"
dir="server/characterization/post-comments"
expected="$dir/expected-differences.json"
changed=$(git diff --name-only "$base"...HEAD)
status=0

recorded=$(printf '%s\n' "$changed" |
  grep -E '^server/characterization/|^ci/post_comments_golden_guard\.sh$|^\.github/workflows/post-comments-recordings\.yml$' |
  grep -v '^server/characterization/post-comments/expected-differences\.json$' || true)
code=$(printf '%s\n' "$changed" |
  grep -E '^server/(src/|app\.ts$|index\.ts$|package\.json$|package-lock\.json$|postgres/)|^delphi/umap_narrative/reset_conversation\.py$' || true)
if [ -n "$recorded" ] && [ -n "$code" ]; then
  echo "::error::The post-comments recordings, their harness inputs or comparison rules change together with the code they record. Re-record in its own PR from edge, or add a named entry to $expected. Recording-side files changed:"
  printf '%s\n' "$recorded"
  echo "Code changed:"
  printf '%s\n' "$code"
  status=1
fi

if printf '%s\n' "$changed" | grep -Eq "^$dir/(golden/|contract-cases\.json$)" &&
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

[ "$status" -eq 0 ] && echo "post-comments guard: ok (recordings and rules vs code, re-record vs entries, rulings)."
exit "$status"
