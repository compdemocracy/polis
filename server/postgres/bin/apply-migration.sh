#!/usr/bin/env bash
#
# apply-migration.sh: the checked apply wrapper for the migrations that an
# existing database takes by hand: 000019 (polis-queue/1), 000023
# (polis-queue/2, the Delphi job table) and 000025 (the vote convention).
#
# 000019 and 000023 create a foreign key to public.conversations, so each one holds
# ShareRowExclusiveLock on `conversations` from that statement until its
# COMMIT. That lock blocks every INSERT, UPDATE and DELETE on conversations
# (plain SELECT continues) while it is held, and the apply itself waits behind
# any open transaction that already wrote a conversations row. Apply in an idle
# or controlled writer window. This wrapper makes that window checkable and
# bounds what the apply may do:
#
# 000025 takes no lock on conversations and rewrites nothing: its empty-table
# checks hold AccessShareLock on votes and votes_latest_unique until COMMIT
# (compatible with ordinary reads and writes; an ACCESS EXCLUSIVE holder on
# either table makes it wait up to its own 5 s lock_timeout, then roll back),
# and its other locks are on the objects it creates. It needs the vote tables
# (000000, 000006) and nothing else; it does not need 000019, 000021, 000023
# or 000024.
#
#   PREFLIGHT (refuses, applying nothing, when any check fails)
#     seal        the file matches its recorded sha256 (000023: down/000023-files.sha256;
#                 000025: down/000025-files.sha256;
#                 000019: QUEUE_SQL_SHA256 in server/src/queue/protocol.ts)
#     server      PostgreSQL 17 (the catalog fingerprints and transaction_timeout need it)
#     rights      the applier can do what the file needs (000019: superuser, or
#                 CREATEROLE while a role is absent / SET membership in
#                 polis_queue_owner, plus public and conversations privileges with
#                 grant option; 000023: superuser or SET membership in polis_queue_owner;
#                 000025: superuser, or CREATE on schema public plus ownership of
#                 votes and votes_latest_unique, which its SECURITY DEFINER
#                 functions and views need)
#     chain       000023: 000019 is installed (public.polis_queue_install exists);
#                 000025: the vote tables exist (000000, 000006)
#     rows        000019/000023: every polis_queue_* and delphi_* data table that
#                 exists is empty (a first install; the install/provenance
#                 tables are exempt); 000025: none of the thirteen objects it
#                 creates exists yet (vote_convention, its history, the ledger,
#                 the views and the functions: a first install, not a repair)
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
#   000023 and 000025 pin lock_timeout to 5s inside their own transaction (SET
#   LOCAL), so for them the acquisition wait is 5s whatever --lock-timeout
#   says; the other three budgets apply to every file. A budget that fires
#   aborts the transaction: nothing is applied, and the wrapper exits non-zero.
#
# Usage:
#   server/postgres/bin/apply-migration.sh [options] <000019|000023|000025> -- <psql command...>
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
# same command applies. For 000025, test_000025_down.sh's wrapper case: the
# preflight passes on the real chain and the file applies; a second run is
# refused at preflight (the objects exist); an ACCESS EXCLUSIVE holder on votes
# makes the apply fail on lock_timeout with the catalog unchanged.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/../migrations" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

usage() { sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

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
  000025) FILE="000025_vote_convention.sql";;
  "") echo "apply-migration: a migration number (000019, 000023 or 000025) is required" >&2; usage;;
  *) echo "apply-migration: this wrapper covers 000019, 000023 and 000025 only; $NUMBER has no apply policy here" >&2; exit 2;;
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
  000023|000025)
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
  000023)
    r="$(scalar "SELECT CASE
      WHEN rolsuper THEN 'ok superuser'
      WHEN pg_has_role(current_user,'polis_queue_owner','SET') THEN 'ok ' || rolname || ' can SET ROLE polis_queue_owner'
      ELSE 'FAIL $who cannot SET ROLE polis_queue_owner'
      END FROM pg_roles WHERE rolname=current_user")";;
  000025)
    r="$(scalar "SELECT CASE
      WHEN rolsuper THEN 'ok superuser'
      WHEN NOT has_schema_privilege(current_user,'public','CREATE') THEN 'FAIL $who lacks CREATE on schema public'
      WHEN to_regclass('public.votes') IS NULL OR to_regclass('public.votes_latest_unique') IS NULL THEN 'FAIL the vote tables are missing (see chain)'
      WHEN NOT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.votes')),'USAGE')
        OR NOT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.votes_latest_unique')),'USAGE')
        THEN 'FAIL $who does not own public.votes and public.votes_latest_unique (vote_insert and the semantic views run with the owner''s rights)'
      ELSE 'ok ' || rolname || ' owns the vote tables and can CREATE in public'
      END FROM pg_roles WHERE rolname=current_user")";;
esac
case "$r" in ok\ *) ok rights "${r#ok }";; *) fail rights "${r#FAIL }";; esac

# ---------------------------------------------------------------- chain
if [ "$NUMBER" = 000023 ]; then
  if [ "$(scalar "SELECT to_regclass('public.polis_queue_install') IS NOT NULL")" = "t" ]; then ok chain "000019 is installed"
  else fail chain "000019 is not installed (no public.polis_queue_install); apply it first"; fi
fi
if [ "$NUMBER" = 000025 ]; then
  if [ "$(scalar "SELECT to_regclass('public.votes') IS NOT NULL AND to_regclass('public.votes_latest_unique') IS NOT NULL")" = "t" ]; then
    ok chain "the vote tables exist (000000, 000006); nothing later is required"
  else fail chain "public.votes or public.votes_latest_unique is missing (000000, 000006); apply the earlier migrations first"; fi
fi

# ---------------------------------------------------------------- rows
if [ "$NUMBER" = 000025 ]; then
  present="$(scalar "SELECT (to_regclass('public.vote_convention') IS NOT NULL)::int
       + (to_regclass('public.vote_convention_history') IS NOT NULL)::int
       + (to_regclass('public.schema_migrations') IS NOT NULL)::int
       + (to_regclass('public.votes_semantic') IS NOT NULL)::int
       + (to_regclass('public.votes_latest_unique_semantic') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_current()') IS NOT NULL)::int
       + (to_regprocedure('public.vote_semantic(smallint,smallint)') IS NOT NULL)::int
       + (to_regprocedure('public.vote_storage(smallint,smallint)') IS NOT NULL)::int
       + (to_regprocedure('public.vote_insert(integer,integer,integer,smallint,smallint,boolean,integer)') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_record_history()') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_history_immutable()') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_monotonic()') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_permanent()') IS NOT NULL)::int")"
  if [ "$present" = "0" ]; then ok rows "no vote convention object exists yet (a first install)"
  else fail rows "$present of the 13 vote convention objects already exist; 000025 is applied or partially applied (inspect: SELECT * FROM public.schema_migrations ORDER BY name)"; fi
else
rows="$(scalar "SELECT string_agg(relname || '=' || n, ', ' ORDER BY relname) FROM (
  SELECT c.relname,
    (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', c.oid::regclass), false, true, '')))[1]::text::bigint AS n
  FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
    AND (c.relname LIKE 'polis\\_queue\\_%' OR c.relname LIKE 'delphi\\_%')
    AND c.relname NOT IN ('polis_queue_install','delphi_foundation_install')) t WHERE n > 0")"
if [ -z "$rows" ]; then ok rows "every existing queue and job table is empty"
else fail rows "queue or job tables hold rows ($rows); this wrapper applies a first install only"; fi
fi

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
case "$NUMBER" in 000023|000025) echo "note: $NUMBER sets lock_timeout to 5s inside its transaction; that is its acquisition budget";; esac
if [ "$NUMBER" = 000025 ]; then
  echo "lock: this file holds AccessShareLock on public.votes and public.votes_latest_unique until COMMIT (its empty-table checks); no vote table is rewritten"
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
  000025) post="$(scalar "SELECT count(*) FROM public.schema_migrations WHERE name='000025_vote_convention' AND length(checksum)=64")"; want="1";;
esac
if [ "$post" = "$want" ]; then echo "applied: $FILE (post-check $post)"
else echo "FAILED: $FILE post-check expected '$want', found '$post'" >&2; exit 6; fi
if [ "$NUMBER" = 000025 ]; then
  # What the operator does next depends on whether the file seeded the row.
  state="$(scalar "SELECT coalesce((SELECT 'GUARDED v' || version || ' agree ' || agree_value FROM public.vote_convention_current()), 'DECLARE_NEEDED')")"
  ledger="$(scalar "SELECT count(*) FILTER (WHERE checksum='verified') || ' verified, ' || count(*) FILTER (WHERE checksum='unverified') || ' unverified' FROM public.schema_migrations WHERE length(checksum)<>64")"
  echo "convention: $state (earlier files in the ledger: $ledger)"
  [ "$state" != DECLARE_NEEDED ] || echo "next: the database holds votes; declare its sign once with server/bin/vote-convention-declare.sh (the command and the sign: docs/vote-convention-upgrade.md#declare)"
fi
