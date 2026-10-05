#!/usr/bin/env bash
# Run one or more checks and print a summary.
#
#   ci/local/check.sh <suite>...      run each in turn (all of them, even after a failure)
#   ci/local/check.sh --gate          every check CI runs (make check)
#   ci/local/check.sh --fast          the agent-loop tier (make check-fast)
#   ci/local/check.sh --ungated       test sets no workflow runs yet (make check-ungated)
#   ci/local/check.sh --changed       the suites whose inputs differ from BASE_REF (make check-changed)
#   ci/local/check.sh --list          list the suites
# Exit status: 0 when every suite passed, 1 otherwise. A per-run summary is kept
# in .check/summary-<time>.txt. CHECK_STOP=1 stops at the first failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/suites.sh"

case "${1:-}" in
  --gate) set -- $CHECK_GATE_SUITES ;;
  --fast) set -- $CHECK_FAST_SUITES ;;
  --ungated) set -- $CHECK_UNGATED_SUITES ;;
  --changed)
    changed="$("$HERE/changed-suites.sh")" || exit 2
    if [ -z "$changed" ]; then echo "check-changed: no suite's inputs changed against ${BASE_REF:-origin/edge}"; exit 0; fi
    echo "check-changed: $changed"
    set -- $changed ;;
  --list)
    echo "gate:    $CHECK_GATE_SUITES"; echo "fast:    $CHECK_FAST_SUITES"; echo "ungated: $CHECK_UNGATED_SUITES"; exit 0 ;;
  '') echo "usage: ci/local/check.sh <suite>... | --gate | --fast | --ungated | --changed | --list" >&2; exit 2 ;;
esac

for s in "$@"; do
  [ -x "$HERE/$s.sh" ] && case " $CHECK_ALL_SUITES " in *" $s "*) ;; *) false ;; esac \
    || { echo "unknown suite: $s (ci/local/check.sh --list)" >&2; exit 2; }
done

# A single suite: run it directly, its exit status is the answer.
if [ $# = 1 ]; then exec "$HERE/$1.sh"; fi

mkdir -p "$ROOT/.check"
summary="$ROOT/.check/summary-$(date -u +%Y%m%dT%H%M%SZ).txt"
start_all=$(date +%s); failed=0; rows=""
for s in "$@"; do
  t0=$(date +%s)
  "$HERE/$s.sh"; rc=$?
  dt=$(( $(date +%s) - t0 ))
  if [ $rc = 0 ]; then verdict=pass; else verdict="FAIL ($rc)"; failed=1; fi
  rows="$rows$(printf '%-26s %-10s %6ss' "$s" "$verdict" "$dt")
"
  if [ $rc != 0 ] && [ -n "${CHECK_STOP:-}" ]; then break; fi
done
total=$(( $(date +%s) - start_all ))
{
  echo "suite                      verdict     wall"
  printf '%s' "$rows"
  printf '%-26s %-10s %6ss\n' "total" "$([ $failed = 0 ] && echo pass || echo FAIL)" "$total"
  echo "($(uname -s)/$(uname -m), $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null))"
} | tee "$summary"
exit $failed
