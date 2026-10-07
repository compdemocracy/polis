#!/usr/bin/env bash
# Declare the stored vote sign of a Polis database that already holds votes,
# or show what it declares.
#
#   server/bin/vote-convention-declare.sh AGREE [REASON]    AGREE is -1 or +1
#   server/bin/vote-convention-declare.sh --status
#
# Where it runs: against $DATABASE_URL when set; otherwise through $PSQL, a
# psql command prefix (the Makefile sets it to the compose postgres container:
#   make vote-convention-declare AGREE=-1 [REASON="..."]
#   make vote-convention-status).
# It runs server/postgres/operations/vote_convention_declare.sql once, in one
# transaction; the operation refuses (and changes nothing) when migration
# 000025 is not applied, when the database already declares a convention, or
# when AGREE is not -1 or +1. docs/vote-convention-upgrade.md explains the
# upgrade an operator sees.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPERATION="$HERE/../postgres/operations/vote_convention_declare.sql"
GUIDE="docs/vote-convention-upgrade.md"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# psql runner: argv are psql flags; the file (if any) comes on stdin, which
# works both for a local psql and for `docker compose exec -T postgres psql`.
run_psql() {
  if [ -n "${DATABASE_URL:-}" ]; then
    psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"
  elif [ -n "${PSQL:-}" ]; then
    # shellcheck disable=SC2086
    $PSQL -X -q -v ON_ERROR_STOP=1 "$@"
  else
    echo "vote-convention-declare: set DATABASE_URL, or run through \"make vote-convention-declare\" (POSTGRES_DOCKER=true)." >&2
    exit 2
  fi
}

status() {
  local present row
  present="$(run_psql -At -c "SELECT to_regclass('public.vote_convention') IS NOT NULL" </dev/null)"
  if [ "$present" != "t" ]; then
    echo "GUARD_NEEDED: this database has no vote_convention table (migration 000025 is not applied). Next: apply server/postgres/migrations/000025_vote_convention.sql, then \"make vote-convention-declare AGREE=-1\" if the database already holds votes. Guide: $GUIDE#guard"
    return 1
  fi
  row="$(run_psql -At -c "SELECT c.version || '|' || c.agree_value || '|' || c.contract_version || '|' || c.operation || '|' || c.changed_by || '|' || c.reason FROM public.vote_convention c WHERE c.singleton" </dev/null)"
  if [ -z "$row" ]; then
    echo "DECLARE_NEEDED: this database records no vote convention. Polis components will not start until you declare it. Next: \"make vote-convention-declare AGREE=-1\" (the original convention) or AGREE=+1 only if your deployment reversed its vote signs itself. Guide: $GUIDE#declare"
    return 1
  fi
  IFS='|' read -r version agree contract operation by reason <<<"$row"
  echo "GUARDED v$version agree $agree (contract $contract; written by $operation as $by: $reason)"
}

[ $# -ge 1 ] || usage
case "$1" in
  --status) status; exit $? ;;
  -h|--help) usage ;;
esac
AGREE="$1"
case "$AGREE" in
  -1|+1|1) ;;
  *) echo "vote-convention-declare: AGREE must be -1 or +1 (got '$AGREE')" >&2; usage ;;
esac
[ "$AGREE" = "+1" ] && AGREE=1
REASON="${2:-}"
if [ -z "$REASON" ]; then
  if [ "$AGREE" = "-1" ]; then
    REASON="declared by the operator: the original Polis convention (agree stored as -1)"
  else
    REASON="declared by the operator: this deployment reversed its own stored vote signs (agree stored as +1)"
  fi
fi
[ -f "$OPERATION" ] || { echo "vote-convention-declare: $OPERATION not found" >&2; exit 2; }
run_psql -v "agree=$AGREE" -v "reason=$REASON" -f - <"$OPERATION"
status
