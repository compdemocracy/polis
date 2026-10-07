#!/usr/bin/env bash
#
# apply-migration.sh: the checked apply wrapper for the migrations that an
# existing database takes by hand: 000019 (polis-queue/1), 000023
# (polis-queue/2, the Delphi job table), 000024 (polis-queue/3, the large
# worker class), 000025 (the vote convention and the migration ledger) and
# 000026 (queue retention, the parked read and the dead-job breaker). The
# order on an existing database is 000019, 000023, 000024, 000025, 000026;
# the reversals run the other way (000026's down first: 000025's refuses
# while the ledger records 000026, and 000024's refuses the /4 catalog).
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
# 000026 takes no lock on conversations either: it builds three indexes on
# polis_queue_jobs, polis_queue_attempts and polis_queue_requests (SHARE on
# those tables until COMMIT: queue writers wait, readers continue), adds a
# trigger on polis_queue_jobs, two tables and four functions, replaces
# pq_class_depth and pd_enqueue, and inserts its own ledger row. It needs
# 000024 (polis-queue/3, unchanged) and 000025 (the ledger row
# 000025_vote_convention). It may be applied with queue rows present: the
# rows check reports them and does not refuse, and the file seeds the
# dead-job breaker from that history.
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
#     seal        the file matches its recorded sha256, and so does every other
#                 file its seal lists (its reversal): 000023: down/000023-files.sha256;
#                 000024: down/000024-files.sha256; 000025: down/000025-files.sha256;
#                 000026: down/000026-files.sha256; 000019: QUEUE_SQL_SHA256 in
#                 server/src/queue/protocol.ts. For 000025 and 000026 also the
#                 ledger self-checksum: the row the file inserts names the
#                 sha256 of the file without that line
#     server      PostgreSQL 17 (the catalog fingerprints and transaction_timeout need it)
#     rights      the applier can do what the file needs (000019: superuser, or
#                 CREATEROLE while a role is absent / SET membership in
#                 polis_queue_owner, plus public and conversations privileges with
#                 grant option; 000023 and 000024: superuser or SET membership in
#                 polis_queue_owner; 000025: superuser, or CREATE on schema public
#                 plus ownership of votes and votes_latest_unique, which its
#                 SECURITY DEFINER functions and views need; 000026: superuser,
#                 or SET membership in polis_queue_owner plus SELECT and INSERT
#                 on public.schema_migrations)
#     chain       000023: 000019 is installed (public.polis_queue_install exists);
#                 000024: 000023 is installed (public.delphi_foundation_install
#                 exists) and polis_queue_install reads polis-queue/2;
#                 000025: the vote tables exist (000000, 000006);
#                 000026: 000024 is installed (public.polis_queue_large_class_install
#                 exists) and polis_queue_install reads polis-queue/3; the ledger
#                 records 000025_vote_convention; 000026 is not installed (no
#                 public.polis_queue_retention_install, no ledger row for it)
#     rows        000019/000023/000024: every polis_queue_* and delphi_* data
#                 table that exists is empty (for 000019 and 000023 a first
#                 install; for 000024 the queue is empty, nothing queued,
#                 running, parked or kept; the install/provenance tables are
#                 exempt); 000025: none of the thirteen objects it creates
#                 exists yet (vote_convention, its history, the ledger, the
#                 views and the functions: a first install, not a repair);
#                 000026: the counts are reported, never refused
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
#   000023, 000024, 000025 and 000026 pin lock_timeout to 5s inside their own
#   transaction (SET LOCAL), so for them the acquisition wait is 5s whatever
#   --lock-timeout says; the other three budgets apply to every file. A budget
#   that fires aborts the transaction: nothing is applied, and the wrapper
#   exits non-zero.
#
# Usage:
#   server/postgres/bin/apply-migration.sh [options] <000019|000023|000024|000025|000026> -- <psql command...>
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
# For 000024, test_000024_down.sh check (w): the
# preflight refuses a chain without 000023 and a queue holding a row, the
# file applies on the real chain with post-check polis-queue/3, and a second
# run is refused at preflight (the install reads /3, not /2). For 000026,
# test_000026_down.sh check (w): refused without 000024 and without 000025's
# ledger row, reports queue rows without refusing, applies with post-check
# one install row and one ledger row, a second run is refused; and check (p):
# the whole chain 000019 -> 000026 through this wrapper on a populated
# database, each step's lock proven (a writer waits, the apply times out,
# nothing changes), then every down in order, byte for byte.

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
  000025) FILE="000025_vote_convention.sql";;
  000026) FILE="000026_create_polis_queue_retention.sql";;
  "") echo "apply-migration: a migration number (000019, 000023, 000024, 000025 or 000026) is required" >&2; usage;;
  *) echo "apply-migration: this wrapper covers 000019, 000023, 000024, 000025 and 000026 only; $NUMBER has no apply policy here" >&2; exit 2;;
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
  000023|000024|000025|000026)
    pinned="$(grep -E "  $FILE\$" "$MIGRATIONS_DIR/down/$NUMBER-files.sha256" | cut -d' ' -f1 || true)";;
  000019)
    pinned="$(tr -d '\n ' < "$REPO_ROOT/server/src/queue/protocol.ts" | grep -oE 'QUEUE_SQL_SHA256="[0-9a-f]{64}"' | grep -oE '[0-9a-f]{64}' || true)";;
esac
if [ -z "$pinned" ]; then echo "FAIL  seal: no recorded sha256 found for $FILE" >&2; exit 3; fi
if [ "$actual" != "$pinned" ]; then
  echo "FAIL  seal: $FILE is $actual, recorded $pinned; reseal in a reviewed change before applying" >&2; exit 3
fi
# Every other file the seal lists (the reversal) must match too: an apply
# whose down is not the reviewed one has no proven way back.
if [ "$NUMBER" != 000019 ]; then
  while read -r want rel; do
    [ -n "$rel" ] || continue
    [ -f "$MIGRATIONS_DIR/$rel" ] || { echo "FAIL  seal: $rel (listed in down/$NUMBER-files.sha256) is missing" >&2; exit 3; }
    got="$(sha256_of "$MIGRATIONS_DIR/$rel")"
    [ "$got" = "$want" ] || { echo "FAIL  seal: $rel is $got, recorded $want; reseal in a reviewed change before applying" >&2; exit 3; }
  done < "$MIGRATIONS_DIR/down/$NUMBER-files.sha256"
fi
# The ledger self-checksum (000025 on): the row the file inserts names the
# sha256 of the file without its marker line.
case "$NUMBER" in
  000025|000026)
    marker="-- ledger-""self-checksum"
    [ "$(grep -cF -- "$marker" "$PATH_SQL")" = "1" ] || { echo "FAIL  seal: $FILE carries $(grep -cF -- "$marker" "$PATH_SQL") ledger marker lines (exactly 1 required)" >&2; exit 3; }
    recorded="$(grep -F -- "$marker" "$PATH_SQL" | grep -oE "VALUES \('${FILE%.sql}', '[0-9a-f]{64}'" | grep -oE '[0-9a-f]{64}' || true)"
    computed="$(grep -vF -- "$marker" "$PATH_SQL" | { if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi; } | cut -d' ' -f1)"
    if [ -z "$recorded" ] || [ "$recorded" != "$computed" ]; then
      echo "FAIL  seal: $FILE's ledger row records '${recorded:-nothing}', the file without that line hashes to $computed" >&2; exit 3
    fi
    echo "ok    seal: ledger self-checksum $computed";;
esac
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
  000026)
    r="$(scalar "SELECT CASE
      WHEN rolsuper THEN 'ok superuser'
      WHEN NOT pg_has_role(current_user,'polis_queue_owner','SET') THEN 'FAIL $who cannot SET ROLE polis_queue_owner'
      WHEN to_regclass('public.schema_migrations') IS NULL THEN 'FAIL there is no public.schema_migrations (see chain)'
      WHEN NOT has_table_privilege(current_user,'public.schema_migrations','SELECT,INSERT')
        THEN 'FAIL $who lacks SELECT and INSERT on public.schema_migrations (the file records itself there)'
      ELSE 'ok ' || rolname || ' can SET ROLE polis_queue_owner and write the ledger'
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
if [ "$NUMBER" = 000026 ]; then
  if [ "$(scalar "SELECT to_regclass('public.polis_queue_large_class_install') IS NOT NULL")" != "t" ]; then
    fail chain "000024 is not installed (no public.polis_queue_large_class_install); apply it first"
  elif [ "$(scalar "SELECT to_regclass('public.polis_queue_retention_install') IS NOT NULL")" = "t" ]; then
    fail chain "000026 is already installed (public.polis_queue_retention_install exists)"
  else
    cv="$(scalar "SELECT coalesce(string_agg(contract_version, ','), 'no row') FROM public.polis_queue_install")"
    if [ "$cv" != "polis-queue/3" ]; then fail chain "polis_queue_install reads '$cv', not polis-queue/3"
    elif [ "$(scalar "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" != "t" ]; then
      fail chain "000025 is not applied (no public.schema_migrations); 000026 records itself in its ledger, apply 000025 first"
    else
      led="$(scalar "SELECT (SELECT count(*) FROM public.schema_migrations WHERE name='000025_vote_convention' AND length(checksum)=64) || ' ' || coalesce((SELECT string_agg(name, ',' ORDER BY name) FROM public.schema_migrations WHERE name>='000026' AND length(checksum)=64), '-')")"
      if [ "${led%% *}" != "1" ]; then fail chain "the ledger does not record 000025_vote_convention; apply 000025 first"
      elif [ "${led#* }" != "-" ]; then fail chain "the ledger already records ${led#* }"
      else ok chain "000024 is installed (polis-queue/3) and the ledger records 000025_vote_convention"; fi
    fi
  fi
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
    AND c.relname NOT IN ('polis_queue_install','delphi_foundation_install','polis_queue_large_class_install','polis_queue_retention_install')) t WHERE n > 0")"
if [ -z "$rows" ]; then ok rows "every existing queue and job table is empty"
elif [ "$NUMBER" = 000026 ]; then ok rows "queue rows present ($rows); 000026 adds indexes, a trigger and functions over them, seeds the dead-job breaker from them, and is not refused for rows"
elif [ "$NUMBER" = 000024 ]; then fail rows "queue or job tables hold rows ($rows); 000024 alters the queue tables and is applied only while the queue is empty"
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
case "$NUMBER" in 000023|000024|000025|000026) echo "note: $NUMBER sets lock_timeout to 5s inside its transaction; that is its acquisition budget";; esac
if [ "$NUMBER" = 000026 ]; then
  echo "lock: this file holds SHARE on polis_queue_jobs, polis_queue_attempts and polis_queue_requests (index builds) and SHARE ROW EXCLUSIVE on polis_queue_jobs (the trigger) until COMMIT; none on public.conversations"
elif [ "$NUMBER" = 000025 ]; then
  echo "lock: this file holds AccessShareLock on public.votes and public.votes_latest_unique until COMMIT (its empty-table checks); no vote table is rewritten"
elif [ "$NUMBER" = 000024 ]; then
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
  000025) post="$(scalar "SELECT count(*) FROM public.schema_migrations WHERE name='000025_vote_convention' AND length(checksum)=64")"; want="1";;
  000024) post="$(scalar "SELECT contract_version FROM public.polis_queue_install")"; want="polis-queue/3";;
  000026) post="$(scalar "SELECT (SELECT count(*) FROM public.polis_queue_retention_install) || ' install, ' || (SELECT count(*) FROM public.schema_migrations WHERE name='000026_create_polis_queue_retention' AND length(checksum)=64) || ' ledger, ' || (SELECT contract_version FROM public.polis_queue_install)")"; want="1 install, 1 ledger, polis-queue/3";;
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
if [ "$NUMBER" = 000026 ]; then
  echo "breaker: $(scalar "SELECT count(*) || ' scopes seeded, ' || count(*) FILTER (WHERE opened_at IS NOT NULL) || ' open' FROM public.polis_queue_breakers")"
fi
