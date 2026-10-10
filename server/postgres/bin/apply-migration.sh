#!/usr/bin/env bash
#
# HISTORICAL REHEARSAL HELPER ONLY. Deployments must use polis-migrate apply
# (docs/migrations.md). This script does not record applied migration history.
#
# apply-migration.sh: the checked apply wrapper for the queue migrations
# 000019 (polis-queue/1), 000023 (polis-queue/2, the Delphi job table) and
# 000024 (polis-queue/3, the large worker class).
#
# 000019 and 000023 create a foreign key to public.conversations, so each one holds
# ShareRowExclusiveLock on `conversations` from that statement until its
# COMMIT. That lock blocks every INSERT, UPDATE and DELETE on conversations
# (plain SELECT continues) while it is held, and the apply itself waits behind
# any open transaction that already wrote a conversations row. Apply in an idle
# or controlled writer window. This wrapper makes that window checkable and
# bounds what the apply may do:
#
# 000024 takes no lock on conversations: it alters CHECK constraints on
# polis_queue_install, polis_queue_runs, polis_queue_jobs and delphi_jobs
# (ACCESS EXCLUSIVE on those four queue tables until COMMIT, which blocks
# queue readers and writers, hence the empty-queue preflight) and replaces
# the queue functions. It needs 000023 installed and unchanged (contract
# polis-queue/2); its own guard refuses a drifted /2 catalog and a second
# apply.
#
#   PREFLIGHT (refuses, applying nothing, when any check fails)
#     seal        the file matches its recorded sha256 (000023: down/000023-files.sha256;
#                 000024: down/000024-files.sha256;
#                 000019: QUEUE_SQL_SHA256 in server/src/queue/protocol.ts)
#     server      PostgreSQL 17 (the catalog fingerprints and transaction_timeout need it)
#     rights      the applier can do what the file needs (000019: superuser, or
#                 CREATEROLE while a role is absent / SET membership in
#                 polis_queue_owner, plus public and conversations privileges with
#                 grant option; 000023 and 000024: superuser or SET membership in
#                 polis_queue_owner)
#     chain       000023: 000019 is installed (public.polis_queue_install exists);
#                 000024: 000023 is installed (public.delphi_foundation_install
#                 exists) and polis_queue_install reads polis-queue/2
#     rows        every polis_queue_* and delphi_* data table that exists is empty
#                 (for 000019 and 000023 a first install; for 000024 the queue
#                 is empty, nothing queued, running, parked or kept; the
#                 install/provenance tables are exempt)
#     xacts       no other transaction on this database is older than
#                 --max-xact-age seconds; the applier must be able to see other
#                 sessions (superuser or pg_read_all_stats), otherwise this check
#                 refuses rather than passing blind
#     disk        --free-bytes (free disk on the database host, measured by the
#                 operator: RDS FreeStorageSpace, or df on the data directory) is
#                 at or above --disk-floor-bytes
#
#   BUDGETS (session settings sent before the file; every value is printed)
#     lock_timeout                        --lock-timeout        default 5s
#     statement_timeout                   --statement-timeout   default 60s
#     transaction_timeout                 --transaction-timeout default 120s
#     idle_in_transaction_session_timeout --idle-timeout        default 30s
#   000023 and 000024 pin lock_timeout to 5s inside their own transaction
#   (SET LOCAL), so for them the acquisition wait is 5s whatever --lock-timeout
#   says; the other three budgets apply to every file. A budget that fires aborts the
#   transaction: nothing is applied, and the wrapper exits non-zero.
#
# Usage:
#   server/postgres/bin/apply-migration.sh [options] <000019|000023|000024> -- <psql command...>
#
#   server/postgres/bin/apply-migration.sh --free-bytes 12000000000 000023 -- \
#     docker exec -i polis-dev-postgres-1 psql -U postgres -d polis-dev
#
# The psql command is run exactly as given with the SQL on its stdin (so
# `docker exec -i ... psql` and a plain `psql` both work); the wrapper adds
# -X -v ON_ERROR_STOP=1. Exit codes: 0 applied; 2 usage; 3 seal; 4 preflight
# refused; 5 the apply failed (the transaction rolled back); 6 the post-apply
# check failed.
#
# Proven by server/postgres/migrations/down/test_000023_down.sh, check (i):
# with a concurrent uncommitted UPDATE on conversations the apply waits, fails
# on lock_timeout and leaves the catalog unchanged; with that transaction older
# than --max-xact-age the preflight refuses first; once the writer is gone the
# same command applies. For 000024, test_000024_down.sh check (w): the
# preflight refuses a chain without 000023 and a queue holding a row, the
# file applies on the real chain with post-check polis-queue/3, and a second
# run is refused at preflight (the install reads /3, not /2).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/../migrations" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

FREE_BYTES=""
DISK_FLOOR_BYTES=$((5 * 1024 * 1024 * 1024))
MAX_XACT_AGE=30
LOCK_TIMEOUT="5s"
STATEMENT_TIMEOUT="60s"
TRANSACTION_TIMEOUT="120s"
IDLE_TIMEOUT="30s"
PREFLIGHT_ONLY=0
NUMBER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --free-bytes) FREE_BYTES="$2"; shift 2;;
    --disk-floor-bytes) DISK_FLOOR_BYTES="$2"; shift 2;;
    --max-xact-age) MAX_XACT_AGE="$2"; shift 2;;
    --lock-timeout) LOCK_TIMEOUT="$2"; shift 2;;
    --statement-timeout) STATEMENT_TIMEOUT="$2"; shift 2;;
    --transaction-timeout) TRANSACTION_TIMEOUT="$2"; shift 2;;
    --idle-timeout) IDLE_TIMEOUT="$2"; shift 2;;
    --preflight-only) PREFLIGHT_ONLY=1; shift;;
    --) shift; break;;
    -h|--help) usage;;
    -*) echo "apply-migration: unknown option $1" >&2; usage;;
    *) [ -z "$NUMBER" ] || { echo "apply-migration: one migration number only" >&2; usage; }; NUMBER="$1"; shift;;
  esac
done
[ $# -gt 0 ] || { echo "apply-migration: the psql command after -- is required" >&2; usage; }
PSQL=("$@")

case "$NUMBER" in
  000019) FILE="000019_create_polis_queue.sql";;
  000023) FILE="000023_create_delphi_foundation.sql";;
  000024) FILE="000024_create_polis_queue_large_class.sql";;
  "") echo "apply-migration: a migration number (000019, 000023 or 000024) is required" >&2; usage;;
  *) echo "apply-migration: this wrapper covers 000019, 000023 and 000024 only; $NUMBER has no apply policy here" >&2; exit 2;;
esac
PATH_SQL="$MIGRATIONS_DIR/$FILE"
[ -f "$PATH_SQL" ] || { echo "apply-migration: $PATH_SQL is missing" >&2; exit 2; }

for v in FREE_BYTES DISK_FLOOR_BYTES MAX_XACT_AGE; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { echo "apply-migration: --$(echo "$v" | tr '_' '-' | tr 'A-Z' 'a-z') must be a whole number (got '${!v:-nothing}'; --free-bytes is required)" >&2; exit 2; }
done
for v in LOCK_TIMEOUT STATEMENT_TIMEOUT TRANSACTION_TIMEOUT IDLE_TIMEOUT; do
  [[ "${!v}" =~ ^[0-9]+(ms|s|min)$ ]] || { echo "apply-migration: $v must look like 5s, 500ms or 2min (got '${!v}')" >&2; exit 2; }
done

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

# One psql round trip: SQL on stdin, trimmed scalar/tuples out.
run_sql() { "${PSQL[@]}" -X -v ON_ERROR_STOP=1 -At; }
scalar() { printf '%s\n' "$1" | run_sql; }

refused=0
ok()   { echo "ok    $1: $2"; }
fail() { echo "FAIL  $1: $2"; refused=1; }

echo "== apply-migration: $FILE =="
echo "psql: ${PSQL[*]}"

# ---------------------------------------------------------------- seal
actual="$(sha256_of "$PATH_SQL")"
case "$NUMBER" in
  000023|000024)
    pinned="$(grep -E "  $FILE\$" "$MIGRATIONS_DIR/down/$NUMBER-files.sha256" | cut -d' ' -f1 || true)";;
  000019)
    pinned="$(tr -d '\n ' < "$REPO_ROOT/server/src/queue/protocol.ts" | grep -oE 'QUEUE_SQL_SHA256="[0-9a-f]{64}"' | grep -oE '[0-9a-f]{64}' || true)";;
esac
if [ -z "$pinned" ]; then echo "FAIL  seal: no recorded sha256 found for $FILE" >&2; exit 3; fi
if [ "$actual" != "$pinned" ]; then
  echo "FAIL  seal: $FILE is $actual, recorded $pinned; reseal in a reviewed change before applying" >&2; exit 3
fi
echo "ok    seal: $actual"

# ---------------------------------------------------------------- server
vnum="$(scalar "SELECT current_setting('server_version_num')")"
if [ "${vnum:-0}" -ge 170000 ] && [ "${vnum:-0}" -lt 180000 ]; then ok server "PostgreSQL $(scalar "SELECT current_setting('server_version')")"
else fail server "PostgreSQL 17 required (server_version_num=$vnum)"; fi

# ---------------------------------------------------------------- rights
who="$(scalar "SELECT current_user")"
case "$NUMBER" in
  000019)
    r="$(scalar "SELECT CASE
      WHEN rolsuper THEN 'ok superuser'
      WHEN (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='polis_queue_owner')
            OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='polis_queue_executor')) AND NOT rolcreaterole
        THEN 'FAIL a queue role is absent and $who lacks CREATEROLE'
      WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='polis_queue_owner')
           AND NOT pg_has_role(current_user,'polis_queue_owner','SET') AND NOT rolcreaterole
        THEN 'FAIL $who is not a SET-capable member of polis_queue_owner'
      WHEN NOT has_schema_privilege(current_user,'public','USAGE WITH GRANT OPTION')
        OR NOT has_schema_privilege(current_user,'public','CREATE WITH GRANT OPTION')
        OR NOT has_table_privilege(current_user,'public.conversations','SELECT WITH GRANT OPTION')
        OR NOT has_column_privilege(current_user,'public.conversations','topic','UPDATE WITH GRANT OPTION')
        OR NOT has_column_privilege(current_user,'public.conversations','zid','REFERENCES WITH GRANT OPTION')
        THEN 'FAIL $who lacks public USAGE/CREATE or conversations SELECT/UPDATE(topic)/REFERENCES(zid) with grant option'
      ELSE 'ok ' || rolname || ' (createrole=' || rolcreaterole || ', owner member=' || pg_has_role(current_user,'polis_queue_owner','SET') || ')'
      END FROM pg_roles WHERE rolname=current_user")";;
  000023|000024)
    r="$(scalar "SELECT CASE
      WHEN rolsuper THEN 'ok superuser'
      WHEN pg_has_role(current_user,'polis_queue_owner','SET') THEN 'ok ' || rolname || ' can SET ROLE polis_queue_owner'
      ELSE 'FAIL $who cannot SET ROLE polis_queue_owner'
      END FROM pg_roles WHERE rolname=current_user")";;
esac
case "$r" in ok\ *) ok rights "${r#ok }";; *) fail rights "${r#FAIL }";; esac

# ---------------------------------------------------------------- chain
if [ "$NUMBER" = 000023 ]; then
  if [ "$(scalar "SELECT to_regclass('public.polis_queue_install') IS NOT NULL")" = "t" ]; then ok chain "000019 is installed"
  else fail chain "000019 is not installed (no public.polis_queue_install); apply it first"; fi
fi
if [ "$NUMBER" = 000024 ]; then
  if [ "$(scalar "SELECT to_regclass('public.delphi_foundation_install') IS NOT NULL")" != "t" ]; then
    fail chain "000023 is not installed (no public.delphi_foundation_install); apply it first"
  else
    cv="$(scalar "SELECT coalesce(string_agg(contract_version, ','), 'no row') FROM public.polis_queue_install")"
    if [ "$cv" = "polis-queue/2" ]; then ok chain "000023 is installed; polis_queue_install reads polis-queue/2"
    else fail chain "polis_queue_install reads '$cv', not polis-queue/2; 000024 applies once, on top of 000023"; fi
  fi
fi

# ---------------------------------------------------------------- rows
rows="$(scalar "SELECT string_agg(relname || '=' || n, ', ' ORDER BY relname) FROM (
  SELECT c.relname,
    (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', c.oid::regclass), false, true, '')))[1]::text::bigint AS n
  FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
    AND (c.relname LIKE 'polis\\_queue\\_%' OR c.relname LIKE 'delphi\\_%')
    AND c.relname NOT IN ('polis_queue_install','delphi_foundation_install','polis_queue_large_class_install')) t WHERE n > 0")"
if [ -z "$rows" ]; then ok rows "every existing queue and job table is empty"
elif [ "$NUMBER" = 000024 ]; then fail rows "queue or job tables hold rows ($rows); 000024 alters the queue tables and is applied only while the queue is empty"
else fail rows "queue or job tables hold rows ($rows); this wrapper applies a first install only"; fi

# ---------------------------------------------------------------- xacts
sees="$(scalar "SELECT rolsuper OR pg_has_role(current_user,'pg_read_all_stats','MEMBER') FROM pg_roles WHERE rolname=current_user")"
if [ "$sees" != "t" ]; then
  fail xacts "$who cannot see other sessions' transactions (needs superuser or pg_read_all_stats); refusing rather than passing blind"
else
  x="$(scalar "SELECT count(*) || ' ' || coalesce(max(extract(epoch FROM clock_timestamp()-xact_start))::bigint, 0)
    FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL
      AND xact_start < clock_timestamp() - make_interval(secs=>$MAX_XACT_AGE)")"
  n="${x%% *}"; oldest="${x##* }"
  if [ "$n" = "0" ]; then ok xacts "no other transaction older than ${MAX_XACT_AGE}s on $(scalar 'SELECT current_database()')"
  else fail xacts "$n transaction(s) older than ${MAX_XACT_AGE}s (oldest ${oldest}s); wait for an idle writer window"; fi
fi

# ---------------------------------------------------------------- disk
dbsize="$(scalar "SELECT pg_size_pretty(pg_database_size(current_database()))")"
if [ "$FREE_BYTES" -ge "$DISK_FLOOR_BYTES" ]; then ok disk "$FREE_BYTES free bytes reported, floor $DISK_FLOOR_BYTES (database is $dbsize)"
else fail disk "$FREE_BYTES free bytes reported is below the floor $DISK_FLOOR_BYTES (database is $dbsize)"; fi

if [ "$refused" -ne 0 ]; then echo "REFUSED: preflight failed; nothing was applied" >&2; exit 4; fi
if [ "$PREFLIGHT_ONLY" -eq 1 ]; then echo "preflight passed (--preflight-only); nothing applied"; exit 0; fi

# ---------------------------------------------------------------- apply
echo "budgets: lock_timeout=$LOCK_TIMEOUT statement_timeout=$STATEMENT_TIMEOUT transaction_timeout=$TRANSACTION_TIMEOUT idle_in_transaction_session_timeout=$IDLE_TIMEOUT"
case "$NUMBER" in 000023|000024) echo "note: $NUMBER sets lock_timeout to 5s inside its transaction; that is its acquisition budget";; esac
if [ "$NUMBER" = 000024 ]; then
  echo "lock: this file holds ACCESS EXCLUSIVE on polis_queue_install, polis_queue_runs, polis_queue_jobs and delphi_jobs until COMMIT; none on public.conversations"
else
  echo "lock: this file holds ShareRowExclusiveLock on public.conversations from its foreign-key creation until COMMIT"
fi
if ! {
  printf "SET lock_timeout = '%s';\nSET statement_timeout = '%s';\nSET transaction_timeout = '%s';\nSET idle_in_transaction_session_timeout = '%s';\n" \
    "$LOCK_TIMEOUT" "$STATEMENT_TIMEOUT" "$TRANSACTION_TIMEOUT" "$IDLE_TIMEOUT"
  cat "$PATH_SQL"
} | "${PSQL[@]}" -X -v ON_ERROR_STOP=1 -q; then
  echo "FAILED: $FILE did not apply; its transaction rolled back and nothing is installed" >&2; exit 5
fi

# ---------------------------------------------------------------- post
case "$NUMBER" in
  000019) post="$(scalar "SELECT count(*) FROM public.polis_queue_install")"; want="1";;
  000023) post="$(scalar "SELECT contract_version FROM public.polis_queue_install")"; want="polis-queue/2";;
  000024) post="$(scalar "SELECT contract_version FROM public.polis_queue_install")"; want="polis-queue/3";;
esac
if [ "$post" = "$want" ]; then echo "applied: $FILE (post-check $post)"
else echo "FAILED: $FILE post-check expected '$want', found '$post'" >&2; exit 6; fi
