#!/usr/bin/env bash
# Which suites can a change reach? Prints their names, one line, gate order.
#
#   ci/local/changed-suites.sh                     working tree (committed + uncommitted + untracked) vs BASE_REF
#   ci/local/changed-suites.sh --base B --head H   commits only: git diff B...H (what a pull request holds)
#   ci/local/changed-suites.sh --is <suite> [...]  exit 0 when that suite is reached, 1 when not
#   ci/local/changed-suites.sh --path P [...]       select for explicit paths (selector tests)
#
# Suites whose workflow has a path filter include that filter plus every input
# the shared entry point reads. The coordinator campaign's in-job gate keeps
# its exact hosted rule. Suites CI runs on every pull request use their inputs
# here, and run when unsure: a change to
# ci/local/lib.sh, suites.sh, docker-compose.test.yml or test.env reaches every
# suite that uses them.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/suites.sh"
BASE="${BASE_REF:-origin/edge}"; HEAD_REF=""; IS=""; CHANGED_PATHS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --head) HEAD_REF="$2"; shift 2 ;;
    --is) IS="$2"; shift 2 ;;
    --path) CHANGED_PATHS="${CHANGED_PATHS}${CHANGED_PATHS:+
}$2"; shift 2 ;;
    *) echo "changed-suites: unknown argument $1" >&2; exit 2 ;;
  esac
done
cd "$ROOT"
if [ -n "$CHANGED_PATHS" ]; then
  changed="$CHANGED_PATHS"
elif [ -n "$HEAD_REF" ]; then
  git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || { echo "changed-suites: $BASE is not a commit here" >&2; exit 2; }
  # --no-renames: a rename lists the removed and the added path, so moving a
  # file out of a directory still counts as touching it.
  changed="$(git diff --name-only --no-renames "$BASE...$HEAD_REF")"
else
  git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || { echo "changed-suites: $BASE is not a commit here" >&2; exit 2; }
  mb="$(git merge-base "$BASE" HEAD)"
  changed="$( { git diff --name-only --no-renames "$mb"; git ls-files -o --exclude-standard; } | sort -u)"
fi

# The paths (extended regex, whole path) that reach a suite.
STACK='docker-compose\.test\.yml$|test\.env$|ci/local/(lib|certs)\.sh$'
pattern() {
  case "$1" in
    vote-sign-lint)          echo '.' ;;
    vote-path-guard)         echo '^(server/|ci/vote_path_golden_guard\.sh$|\.github/workflows/jest-server-test\.yml$)' ;;
    contracts)               echo '^(server/|client-participation-alpha/|client-report/|\.github/workflows/jest-server-test\.yml$)' ;;
    server-unit)             echo '^(server/|test\.env$)' ;;
    server-integration)      echo "^(server/|oidc-simulator/|file-server/|client-admin/|client-report/|delphi/create_dynamodb_tables\.py$|ci/local/clock-skew\.cjs$|\.github/workflows/jest-server-test\.yml$|$STACK)" ;;
    e2e)                     echo "^(server/|oidc-simulator/|file-server/|client-[a-z-]+/|delphi/|e2e/|\.github/workflows/cypress-tests\.yml$|$STACK)" ;;
    coordinator)             echo '^(coordinator-rs/|delphi/|math/|server/|\.github/workflows/coordinator-ci\.yml$)' ;;
    vote-gate)               echo '^(server/|delphi/|ci/vote_convention/|coordinator-rs/|\.github/workflows/vote-convention-gate\.yml$)' ;;
    delphi-characterization) echo '^(server/|delphi/|ci/local/requirements-pyyaml\.txt$|\.github/workflows/delphi-characterization\.yml$)' ;;
    collective-statement-guard) echo '^(server/|ci/collective_statement_golden_guard\.sh$|delphi/create_dynamodb_tables\.py$|\.github/workflows/collective-statement-recordings\.yml$)' ;;
    collective-statement)    echo '^(server/|delphi/create_dynamodb_tables\.py$|ci/local/requirements-collective-statement\.txt$|\.github/workflows/collective-statement-recordings\.yml$)' ;;
    lint)                    echo '^(client-admin/|server/|client-report/|e2e/|\.github/workflows/lint\.yml$)' ;;
    delphi-python)           echo "^(delphi/.*\.py$|delphi/(tests|real_data|polismath|umap_narrative|scripts)/|delphi/requirements[^/]*\.txt$|delphi/Dockerfile$|docker-compose\.yml$|scripts/(after_install|before_install|application_stop)\.sh$|ci/p022_(recordings_manifest|battery_digest)\.py$|\.github/workflows/python-ci\.yml$|server/src/|ci/private_cert/|ci/probe_box/|$STACK)" ;;
    routing-recordings)      echo '^(server/|\.github/workflows/routing-recordings\.yml$)' ;;
    queue-rs)                echo '^(queue-rs/|server/postgres/migrations/|\.github/workflows/queue-rs-ci\.yml$)' ;;
    client-alpha)            echo '^(client-participation-alpha/)' ;;
    client-admin)            echo '^(client-admin/)' ;;
    client-report)           echo '^(client-report/)' ;;
    math)                    echo '^(math/|\.github/workflows/test-clojure\.yml$)' ;;
    client-participation)    echo '^(client-participation/)' ;;
    cdk)                     echo '^(cdk/)' ;;
    ci-python)               echo '^(ci/private_cert/|ci/probe_box/|ci/tests/|coordinator-rs/evidence/python-requirements\.txt$)' ;;
    selector-test)           echo '^(ci/local/(changed-suites|test_changed_suites|selector-test)\.(sh|py)$)' ;;
    *) echo "changed-suites: unknown suite $1" >&2; return 2 ;;
  esac
}

reached() {
  [ -n "$changed" ] || return 1
  local p
  p="$(pattern "$1")" || exit 2
  # The shared harness reaches every suite that uses it.
  printf '%s\n' "$changed" | grep -Eq "$p|^ci/local/$1\.sh$|^ci/local/(lib|check|suites|changed-suites)\.sh$|^Makefile$"
}

if [ -n "$IS" ]; then
  printf '%s\n' "$changed" | sed 's/^/changed: /' >&2
  # The coordinator campaign's required check keeps its own exact rule, so the
  # shared harness files above do not widen it.
  if [ "$IS" = coordinator ]; then
    printf '%s\n' "$changed" | grep -Eq "$(pattern coordinator)"
  else
    reached "$IS"
  fi
  exit $?
fi
out=""
for s in $CHECK_GATE_SUITES $CHECK_UNGATED_SUITES $CHECK_TOOLING_SUITES; do
  if reached "$s"; then out="$out $s"; fi
done
echo "${out# }"
