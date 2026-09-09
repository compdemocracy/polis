#!/usr/bin/env bash
#
# Acceptance test for server/postgres/migrations/down/000019_drop_polis_queue.sql
#
# P-024 queue substrate reversal. Colin's ruling: a written, TESTED down script
# is a precondition for ever applying 000019 to production. This is the test.
#
# It stands up a throwaway `postgres:17` (docker run, ephemeral, removed on
# exit; port in 56040-56049), applies the real migration chain, and checks:
#
#   (a) apply 000000..000019 then the down script -> the catalog is identical to
#       apply 000000..000018 (pg_dump --schema-only, comments stripped; plus the
#       polis_queue_* roles compared via pg_roles).
#   (b) apply -> down -> apply 000019 again succeeds.
#   (c) down on a database that never had 000019 -> no-op with a NOTICE.
#   (d) rows present + no force -> refused (nonzero exit); with -v force=1 ->
#       dropped.
#   (e) provenance: an unrelated same-named pq_* function on a never-installed
#       database SURVIVES -- the down refuses, it is not a silent drop.
#   (f) provenance: an unrelated table owned by polis_queue_owner causes a
#       REFUSAL (and survives), not a blanket DROP OWNED sweep.
#   (g) provenance: a pre-existing polis_queue_executor role SURVIVES.
#   (h) race: a writer that commits a row concurrently is blocked by the
#       ACCESS EXCLUSIVE lock, its row is seen, and the queue is refused, not
#       lost.
#   (i) adopted role: a pre-created executor with an extra schema grant and a
#       role-level statement_timeout that 000019 ADOPTS is PRESERVED with its
#       grant and setting, while the created owner and the queue are dropped.
#   (j) body drift: a body-only rewrite of pq_backoff -> refusal, caught by the
#       prosrc-inclusive function fingerprint.
#   (k..n) coalescing witnesses: an operator pre-creates polis_queue_owner already
#       holding one grant 000019 also adds (conversations SELECT / UPDATE(topic),
#       public CREATE / USAGE WITH GRANT OPTION). The ACL entries coalesce; the
#       recorded provenance lets the reversal preserve the adopted owner and its
#       grant and drop only the created executor.
#   (o) provenance missing: the polis_queue_install record is deleted -> refusal.
#   (p) grant-option upgrade: an operator's plain USAGE that 000019 upgrades to
#       WITH GRANT OPTION is DOWNGRADED on reversal, not revoked.
#   (q) record corruption: an unrelated role in created_roles, an unrelated grant
#       in added_grants, or emptied arrays -- each refused, nothing removed.
#   (r) replay after the record is deleted: the re-apply aborts rather than
#       manufacture history from final state.
#   (s) malformed added-grant fields (NULL-safe validation): a stripped
#       option_only, a missing grantor, or a missing grantable is refused in both
#       force modes with nothing removed.
#
# This is a shell script rather than a delphi/tests pytest because the checks
# are schema-diff shaped (pg_dump of a full migration chain in an isolated
# cluster), which the delphi conftest fixture -- aimed at a possibly-shared
# database and the executor's runtime boundary -- does not host cleanly. It
# needs only docker and is self-contained.
#
# Usage:  bash server/postgres/migrations/down/test_000019_down.sh
# Exit 0 iff all nineteen checks (a..s) pass.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/.." && pwd)"          # server/postgres/migrations
DOWN_REL="down/000019_drop_polis_queue.sql"
CONTAINER="pgdown-test-$$"
PW="test"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgdown.XXXXXX")"   # per-run, no cross-run collisions

PORT=""
for p in $(seq 56040 56049); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT="$p"; break; fi
  exec 3>&- 2>/dev/null || true
done
[ -n "$PORT" ] || { echo "FAIL: no free port in 56040-56049"; exit 1; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== starting throwaway postgres:17 as $CONTAINER on port $PORT =="
docker run --rm -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PW" \
  -p "127.0.0.1:$PORT:5432" \
  -v "$MIGRATIONS_DIR":/mig:ro \
  postgres:17 >/dev/null

# Wait for readiness.
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || fail "postgres did not become ready"

psql_su() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres "$@"; }

createdb() { psql_su -d postgres -c "CREATE DATABASE \"$1\"" >/dev/null; }

# Apply migration files with numeric prefix <= $2 (zero-padded compare) to db $1.
apply_upto() {
  local db="$1" max="$2" f base num
  for f in "$MIGRATIONS_DIR"/0*.sql; do
    base="$(basename "$f")"
    num="${base%%_*}"
    if [ "$num" -le "$max" ]; then
      psql_su -d "$db" -f "/mig/$base" >/dev/null
    fi
  done
}

# Apply a single migration file (only 000019 is replay-safe; the base chain
# 000000..000018 is not).
apply_one() { psql_su -d "$1" -f "/mig/$2" >/dev/null; }

# pg_dump schema, stripped of noise that varies per dump but is not schema:
#   * comment lines (-- dump version, -- timestamp)
#   * blank lines
#   * pg_dump 17's \restrict / \unrestrict lines, which carry a random nonce.
dump_schema() {
  docker exec "$CONTAINER" pg_dump -U postgres --schema-only -d "$1" \
    | grep -vE '^--' | grep -vE '^[[:space:]]*$' \
    | grep -vE '^\\(restrict|unrestrict) '
}

queue_roles() {
  docker exec "$CONTAINER" psql -U postgres -Atc \
    "SELECT rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
       FROM pg_roles WHERE rolname LIKE 'polis\\_queue\\_%' ORDER BY 1"
}

# Count queue objects (tables + pq_ functions) in a database; used for absence checks.
queue_object_count() {
  docker exec "$CONTAINER" psql -U postgres -Atc \
    "SELECT (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'polis\\_queue\\_%' AND relkind IN ('r','i'))
          + (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'pq\\_%')" \
    -d "$1"
}

run_down() {  # run_down <db> [force]
  local db="$1" force="${2:-}"
  if [ "$force" = "force" ]; then
    docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -v force=1 -U postgres -d "$db" -f "/mig/$DOWN_REL" 2>&1
  else
    docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$db" -f "/mig/$DOWN_REL" 2>&1
  fi
}

MAX_BASE=000018
MAX_FULL=000019

# --- Baseline: 000000..000018 on a clean cluster (no queue roles anywhere) ----
echo "== baseline: applying 000000..$MAX_BASE =="
createdb baseline
apply_upto baseline "$MAX_BASE"
dump_schema baseline > "$WORK/baseline_schema.txt"
BASE_ROLES="$(queue_roles)"
[ -z "$BASE_ROLES" ] || fail "baseline unexpectedly has queue roles: $BASE_ROLES"

# --- (c) no-op on a database that never had 000019 (cluster still clean) ------
echo "== check (c): down on a DB without 000019 (expect no-op notice) =="
createdb sc_c
apply_upto sc_c "$MAX_BASE"
OUT_C="$(run_down sc_c || fail "(c) down exited nonzero on a DB without 000019")"
echo "$OUT_C" | grep -q "Nothing to drop" || fail "(c) expected 'Nothing to drop' notice, got: $OUT_C"
[ "$(queue_object_count sc_c)" = "0" ] || fail "(c) queue objects appeared in a DB that never had 000019"
[ -z "$(queue_roles)" ] || fail "(c) queue roles exist after a no-op down"
echo "   (c) PASS"

# --- (g) provenance: pre-existing polis_queue_executor role, never installed ---
# Runs here, on a still-clean cluster (no 000019 applied anywhere yet), so the
# role is genuinely pre-existing and can be dropped cleanly afterward. Roles are
# cluster-global; a later scenario that leaves 000019 installed would pin this
# name, which is why this precedes every apply.
echo "== check (g): pre-existing polis_queue_executor role -> survive =="
createdb sc_g
apply_upto sc_g "$MAX_BASE"
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE ROLE polis_queue_executor NOLOGIN" >/dev/null
set +e
OUT_G="$(run_down sc_g)"; RC_G=$?
set -e
[ "$RC_G" -ne 0 ] || fail "(g) down did NOT refuse with a pre-existing role and no install"
echo "$OUT_G" | grep -qi "refusing" || fail "(g) expected a refusal message, got: $OUT_G"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='polis_queue_executor')")" = "t" ] \
  || fail "(g) pre-existing polis_queue_executor role was dropped"
# Restore the clean cluster role state for the scenarios that follow.
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
echo "   (g) PASS (pre-existing role survives)"

# --- (i) adopted role: pre-created executor with an extra grant + a role-level
#         setting; 000019 ADOPTS it (recording it as adopted). The down PRESERVES
#         the adopted executor, its grant and its setting, revoking only what
#         000019 added and dropping only the created owner + the queue. Runs on
#         the clean role state (g) restored, and cleans up after itself.
echo "== check (i): adopted executor (extra grant + statement_timeout) -> preserved =="
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
createdb sc_i
apply_upto sc_i "$MAX_BASE"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_i >/dev/null <<'SQL'
CREATE ROLE polis_queue_executor NOLOGIN;
GRANT USAGE ON SCHEMA public TO polis_queue_executor;
ALTER ROLE polis_queue_executor SET statement_timeout = '5min';
SQL
apply_one sc_i 000019_create_polis_queue.sql
run_down sc_i >/dev/null || fail "(i) down failed on an adopted-executor install"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='polis_queue_executor')")" = "t" ] \
  || fail "(i) adopted executor role was dropped"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='polis_queue_owner')")" = "t" ] \
  || fail "(i) created owner role was not dropped"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT count(*) FROM pg_db_role_setting WHERE setrole=(SELECT oid FROM pg_roles WHERE rolname='polis_queue_executor')")" = "1" ] \
  || fail "(i) role-level setting was lost"
[ "$(docker exec "$CONTAINER" psql -U postgres -d sc_i -Atc "SELECT has_schema_privilege('polis_queue_executor','public','USAGE')")" = "t" ] \
  || fail "(i) executor's own schema USAGE grant was revoked"
[ "$(queue_object_count sc_i)" = "0" ] || fail "(i) queue objects survived the down"
docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE sc_i WITH (FORCE)" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
echo "   (i) PASS (adopted executor + its grant + its setting preserved; created owner + queue dropped)"

# --- (j) body drift: a body-only rewrite of pq_backoff must be caught by the
#         function fingerprint (which now hashes prosrc) -> refuse, restore.
echo "== check (j): body-drifted pq_backoff -> refuse (function fingerprint) =="
createdb sc_j
apply_upto sc_j "$MAX_FULL"
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_j -c \
  "CREATE OR REPLACE FUNCTION public.pq_backoff(p_attempt uuid,p_count integer) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS 'SELECT 777'" >/dev/null
set +e
OUT_J="$(run_down sc_j)"; RC_J=$?
set -e
[ "$RC_J" -ne 0 ] || fail "(j) down did NOT refuse a body-drifted function"
echo "$OUT_J" | grep -qi "refusing" || fail "(j) expected a refusal, got: $OUT_J"
echo "$OUT_J" | grep -qi "function" || fail "(j) refusal did not name the function-fingerprint drift, got: $OUT_J"
[ "$(queue_object_count sc_j)" -gt 0 ] || fail "(j) refusal did not roll back"
[ "$(docker exec "$CONTAINER" psql -U postgres -d sc_j -Atc "SELECT public.pq_backoff('00000000-0000-0000-0000-000000000000'::uuid, 1)")" = "777" ] \
  || fail "(j) the drifted body was not preserved by the rollback"
docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE sc_j WITH (FORCE)" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
echo "   (j) PASS (body drift caught by the prosrc fingerprint)"

# --- (k..n) coalescing witnesses: an operator pre-creates polis_queue_owner
#     already holding one grant 000019 also adds (same grantee, grantor,
#     privilege). The ACL entries coalesce; only the recorded provenance can tell
#     the reversal not to revoke it. Down must PRESERVE the adopted owner and its
#     grant, and drop only the created executor. Each runs on a clean role state.
coalescing_witness() {  # <tag> <db> <grant-sql> <verify-sql> <desc>
  local tag="$1" db="$2" grant="$3" verify="$4" desc="$5"
  echo "== check ($tag): coalescing witness -- $desc =="
  docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
  docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
  createdb "$db"
  apply_upto "$db" "$MAX_BASE"
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$db" >/dev/null <<SQL
CREATE ROLE polis_queue_owner NOLOGIN;
$grant
SQL
  apply_one "$db" 000019_create_polis_queue.sql
  run_down "$db" >/dev/null || fail "($tag) down failed on an adopted-owner install"
  [ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='polis_queue_owner')")" = "t" ] \
    || fail "($tag) the adopted owner role was dropped"
  [ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='polis_queue_executor')")" = "t" ] \
    || fail "($tag) the created executor role was not dropped"
  [ "$(docker exec "$CONTAINER" psql -U postgres -d "$db" -Atc "$verify")" = "t" ] \
    || fail "($tag) the pre-existing (coalescing) grant was revoked"
  [ "$(queue_object_count "$db")" = "0" ] || fail "($tag) queue objects survived the down"
  docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE $db WITH (FORCE)" >/dev/null
  docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
  docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
  echo "   ($tag) PASS ($desc preserved; owner adopted, executor dropped)"
}
coalescing_witness k sc_k "GRANT SELECT ON public.conversations TO polis_queue_owner;" \
  "SELECT has_table_privilege('polis_queue_owner','public.conversations','SELECT')" "conversations SELECT"
coalescing_witness l sc_l "GRANT UPDATE(topic) ON public.conversations TO polis_queue_owner;" \
  "SELECT has_column_privilege('polis_queue_owner','public.conversations','topic','UPDATE')" "conversations UPDATE(topic)"
coalescing_witness m sc_m "GRANT CREATE ON SCHEMA public TO polis_queue_owner;" \
  "SELECT has_schema_privilege('polis_queue_owner','public','CREATE')" "public CREATE"
coalescing_witness n sc_n "GRANT USAGE ON SCHEMA public TO polis_queue_owner WITH GRANT OPTION;" \
  "SELECT has_schema_privilege('polis_queue_owner','public','USAGE WITH GRANT OPTION')" "public USAGE WITH GRANT OPTION"

# --- (o) provenance record missing -> refuse (never guess) --------------------
echo "== check (o): provenance record deleted -> refuse =="
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
createdb sc_o
apply_upto sc_o "$MAX_FULL"
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_o -c "DELETE FROM public.polis_queue_install" >/dev/null
set +e
OUT_O="$(run_down sc_o)"; RC_O=$?
set -e
[ "$RC_O" -ne 0 ] || fail "(o) down did NOT refuse with the provenance record missing"
echo "$OUT_O" | grep -qi "provenance is missing" || fail "(o) expected a provenance-missing refusal, got: $OUT_O"
[ "$(queue_object_count sc_o)" -gt 0 ] || fail "(o) refusal did not roll back"
docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE sc_o WITH (FORCE)" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
echo "   (o) PASS (missing provenance is refused, queue intact)"

# --- (p) grant-option upgrade: an operator's PLAIN USAGE that 000019 upgrades to
#     WITH GRANT OPTION must be DOWNGRADED on reversal, not revoked. PUBLIC's
#     default USAGE is revoked first so the direct grant is what is observed.
echo "== check (p): grant-option upgrade -> downgrade, original USAGE preserved =="
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
createdb sc_p
apply_upto sc_p "$MAX_BASE"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_p >/dev/null <<'SQL'
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
CREATE ROLE polis_queue_owner NOLOGIN;
GRANT USAGE ON SCHEMA public TO polis_queue_owner;
SQL
apply_one sc_p 000019_create_polis_queue.sql
run_down sc_p >/dev/null || fail "(p) down failed on a grant-option-upgrade install"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='polis_queue_owner')")" = "t" ] \
  || fail "(p) adopted owner was dropped"
[ "$(docker exec "$CONTAINER" psql -U postgres -d sc_p -Atc "SELECT has_schema_privilege('polis_queue_owner','public','USAGE')")" = "t" ] \
  || fail "(p) owner's ORIGINAL plain USAGE was revoked (not just the grant option)"
[ "$(docker exec "$CONTAINER" psql -U postgres -d sc_p -Atc "SELECT has_schema_privilege('polis_queue_owner','public','USAGE WITH GRANT OPTION')")" = "f" ] \
  || fail "(p) the added grant option was not downgraded"
[ "$(queue_object_count sc_p)" = "0" ] || fail "(p) queue objects survived"
docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE sc_p WITH (FORCE)" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
echo "   (p) PASS (grant option downgraded; original plain USAGE preserved)"

# --- (q) record-content corruption: the schema fingerprint is unchanged, but the
#     down validates the record against 000019's closed inventory. Three controls,
#     each must be refused with nothing removed.
echo "== check (q): corrupt provenance record contents -> refuse (3 controls) =="
q_setup() {  # q_setup <db>; leaves a fresh installed db + the unrelated role
  docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
  docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
  createdb "$1"; apply_upto "$1" "$MAX_FULL"
}
q_teardown() {
  docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE $1 WITH (FORCE)" >/dev/null
  docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
  docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
}
# q1: an unrelated role appended to created_roles
q_setup sc_q
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS q_unrelated" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "CREATE ROLE q_unrelated NOLOGIN" >/dev/null
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_q -c \
  "UPDATE public.polis_queue_install SET created_roles = array_append(created_roles,'q_unrelated')" >/dev/null
set +e; OUT_Q="$(run_down sc_q)"; RC_Q=$?; set -e
[ "$RC_Q" -ne 0 ] && echo "$OUT_Q" | grep -qi "partition" || fail "(q1) unrelated role in created_roles was not refused"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='q_unrelated')")" = "t" ] \
  || fail "(q1) the unrelated role was dropped"
[ "$(queue_object_count sc_q)" -gt 0 ] || fail "(q1) refusal did not roll back"
q_teardown sc_q
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS q_unrelated" >/dev/null
# q2: an unrelated grantee's grant appended to added_grants
q_setup sc_q
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_q -c \
  "UPDATE public.polis_queue_install SET added_grants = added_grants || '[{\"object\":\"conversations\",\"grantee\":\"postgres\",\"grantor\":\"postgres\",\"privilege\":\"SELECT\",\"grantable\":false,\"option_only\":false}]'::jsonb" >/dev/null
set +e; OUT_Q="$(run_down sc_q)"; RC_Q=$?; set -e
[ "$RC_Q" -ne 0 ] && echo "$OUT_Q" | grep -qi "out-of-inventory" || fail "(q2) unrelated grant in added_grants was not refused"
[ "$(queue_object_count sc_q)" -gt 0 ] || fail "(q2) refusal did not roll back"
q_teardown sc_q
# q3: both role arrays and the grant array emptied
q_setup sc_q
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_q -c \
  "UPDATE public.polis_queue_install SET created_roles='{}', adopted_roles='{}', added_grants='[]'" >/dev/null
set +e; OUT_Q="$(run_down sc_q)"; RC_Q=$?; set -e
[ "$RC_Q" -ne 0 ] && echo "$OUT_Q" | grep -qi "partition" || fail "(q3) emptied provenance arrays were not refused"
[ "$(queue_object_count sc_q)" -gt 0 ] || fail "(q3) refusal did not roll back"
[ "$(queue_roles)" != "" ] || fail "(q3) roles were dropped despite refusal"
q_teardown sc_q
echo "   (q) PASS (unrelated role, unrelated grant, and emptied arrays each refused)"

# --- (r) replay after the provenance record is deleted: the RE-APPLY must abort,
#     rather than manufacture adopted/zero-grant history from final state.
echo "== check (r): re-apply after record deletion -> up aborts =="
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
createdb sc_r
apply_upto sc_r "$MAX_FULL"
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_r -c "DELETE FROM public.polis_queue_install" >/dev/null
set +e
OUT_R="$(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_r -f /mig/000019_create_polis_queue.sql 2>&1)"; RC_R=$?
set -e
[ "$RC_R" -ne 0 ] || fail "(r) re-apply did NOT abort over an installed queue with a missing record"
echo "$OUT_R" | grep -qi "refusing to re-apply" || fail "(r) expected a re-apply admission refusal, got: $OUT_R"
[ "$(queue_object_count sc_r)" -gt 0 ] || fail "(r) the aborted re-apply damaged the queue"
docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE sc_r WITH (FORCE)" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
# --- (s) malformed added-grant fields (NULL-safe validation): a stripped
#     option_only, a missing grantor, or a missing grantable must be refused --
#     in BOTH force modes -- with nothing removed. Without the NULL-safe check
#     these slip past validation and mis-handle the revoke.
echo "== check (s): malformed added-grant fields -> refuse (both force modes) =="
s_refuses_both() {  # s_refuses_both <db> <label>; the record is already tampered
  local db="$1" label="$2" out rc
  set +e; out="$(run_down "$db")"; rc=$?; set -e
  { [ "$rc" -ne 0 ] && echo "$out" | grep -qi "malformed or out-of-inventory"; } \
    || fail "($label) not refused without force"
  set +e; out="$(run_down "$db" force)"; rc=$?; set -e
  { [ "$rc" -ne 0 ] && echo "$out" | grep -qi "malformed or out-of-inventory"; } \
    || fail "($label) not refused with -v force=1"
  [ "$(queue_object_count "$db")" -gt 0 ] || fail "($label) refusal did not preserve the queue"
}
# (s-a) strip option_only from the grant-option-upgrade entry: the down must not
#       silently full-revoke and erase the operator's original USAGE.
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
createdb sc_s
apply_upto sc_s "$MAX_BASE"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_s >/dev/null <<'SQL'
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
CREATE ROLE polis_queue_owner NOLOGIN;
GRANT USAGE ON SCHEMA public TO polis_queue_owner;
SQL
apply_one sc_s 000019_create_polis_queue.sql
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_s -c \
  "UPDATE public.polis_queue_install SET added_grants=(SELECT jsonb_agg(CASE WHEN (e->>'option_only')::boolean THEN e-'option_only' ELSE e END) FROM jsonb_array_elements(added_grants) e)" >/dev/null
s_refuses_both sc_s "s-a stripped option_only"
[ "$(docker exec "$CONTAINER" psql -U postgres -d sc_s -Atc "SELECT has_schema_privilege('polis_queue_owner','public','USAGE')")" = "t" ] \
  || fail "(s-a) the operator's original USAGE was erased"
docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE sc_s WITH (FORCE)" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
# (s-b) a missing grantor field.
createdb sc_s
apply_upto sc_s "$MAX_FULL"
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_s -c \
  "UPDATE public.polis_queue_install SET added_grants=(SELECT jsonb_agg(CASE WHEN ord=1 THEN e-'grantor' ELSE e END) FROM jsonb_array_elements(added_grants) WITH ORDINALITY t(e,ord))" >/dev/null
s_refuses_both sc_s "s-b missing grantor"
docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE sc_s WITH (FORCE)" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
# (s-c) a missing grantable field.
createdb sc_s
apply_upto sc_s "$MAX_FULL"
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_s -c \
  "UPDATE public.polis_queue_install SET added_grants=(SELECT jsonb_agg(CASE WHEN ord=1 THEN e-'grantable' ELSE e END) FROM jsonb_array_elements(added_grants) WITH ORDINALITY t(e,ord))" >/dev/null
s_refuses_both sc_s "s-c missing grantable"
docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE sc_s WITH (FORCE)" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_owner" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "DROP ROLE IF EXISTS polis_queue_executor" >/dev/null
echo "   (s) PASS (stripped option_only, missing grantor, missing grantable each refused in both force modes)"

# --- (a) apply 000019 then down; catalog must equal the 000018 baseline -------
echo "== check (a): apply 000000..$MAX_FULL, down, compare to baseline =="
createdb sc_a
apply_upto sc_a "$MAX_FULL"
[ "$(queue_object_count sc_a)" -gt 0 ] || fail "(a) 000019 apply produced no queue objects"
[ -n "$(queue_roles)" ] || fail "(a) 000019 apply produced no queue roles"
run_down sc_a >/dev/null || fail "(a) down exited nonzero"
dump_schema sc_a > "$WORK/sc_a_schema.txt"
if ! diff -u "$WORK/baseline_schema.txt" "$WORK/sc_a_schema.txt" > "$WORK/a_diff.txt"; then
  echo "---- schema diff (baseline vs apply+down) ----"; cat "$WORK/a_diff.txt"
  fail "(a) post-down schema differs from the 000018 baseline"
fi
AFTER_ROLES="$(queue_roles)"
[ "$AFTER_ROLES" = "$BASE_ROLES" ] || fail "(a) roles differ after down (baseline='$BASE_ROLES' after='$AFTER_ROLES')"
echo "   (a) PASS (schema and roles identical to 000018 baseline)"

# --- (b) apply 000019 again on the reverted DB succeeds ------------------------
echo "== check (b): re-apply 000019 after down =="
apply_one sc_a 000019_create_polis_queue.sql || fail "(b) re-apply of 000019 failed"
[ "$(queue_object_count sc_a)" -gt 0 ] || fail "(b) re-apply produced no queue objects"
# Return the cluster to a clean role state for check (d).
run_down sc_a >/dev/null || fail "(b) cleanup down after re-apply failed"
[ -z "$(queue_roles)" ] || fail "(b) roles still present after cleanup down"
echo "   (b) PASS"

# --- (d) rows present: refuse without force, drop with force -------------------
echo "== check (d): rows present -> refuse without force, drop with force =="
createdb sc_d
apply_upto sc_d "$MAX_FULL"
ZID="$(docker exec "$CONTAINER" psql -U postgres -Atc \
  "WITH ins AS (INSERT INTO conversations (topic) VALUES ('p024 down-test') RETURNING zid) SELECT zid FROM ins" -d sc_d)"
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_d -c \
  "INSERT INTO public.polis_queue_heads(env,product_key,zid) VALUES ('t','p',$ZID)" >/dev/null
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT count(*) FROM public.polis_queue_heads" -d sc_d)" = "1" ] \
  || fail "(d) failed to seed a row"

set +e
OUT_D_REFUSE="$(run_down sc_d)"; RC_REFUSE=$?
set -e
[ "$RC_REFUSE" -ne 0 ] || fail "(d) down did NOT refuse a non-empty queue without force"
echo "$OUT_D_REFUSE" | grep -qi "refusing to drop a live queue" \
  || fail "(d) refusal message missing, got: $OUT_D_REFUSE"
[ "$(queue_object_count sc_d)" -gt 0 ] || fail "(d) objects were dropped despite refusal"
echo "   (d) refusal PASS"

run_down sc_d force >/dev/null || fail "(d) forced down exited nonzero"
[ "$(queue_object_count sc_d)" = "0" ] || fail "(d) forced down left queue objects"
[ -z "$(queue_roles)" ] || fail "(d) forced down left queue roles"
echo "   (d) forced-drop PASS"

# --- (e) provenance: unrelated same-named pq_* function, never installed -------
echo "== check (e): unrelated same-named pq_* function on a never-installed DB =="
createdb sc_e
apply_upto sc_e "$MAX_BASE"
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_e -c \
  "CREATE FUNCTION public.pq_claim(integer) RETURNS integer LANGUAGE sql AS 'SELECT \$1'" >/dev/null
set +e
OUT_E="$(run_down sc_e)"; RC_E=$?
set -e
[ "$RC_E" -ne 0 ] || fail "(e) down did NOT refuse on an unrelated pq_* function"
echo "$OUT_E" | grep -qi "refusing" || fail "(e) expected a refusal message, got: $OUT_E"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT to_regprocedure('public.pq_claim(integer)') IS NOT NULL" -d sc_e)" = "t" ] \
  || fail "(e) unrelated same-named function was dropped"
echo "   (e) PASS (unrelated pq_claim(integer) survives; refusal, not silent drop)"

# --- (f) provenance: unrelated table owned by polis_queue_owner ----------------
echo "== check (f): unrelated table owned by polis_queue_owner -> refuse, survive =="
createdb sc_f
apply_upto sc_f "$MAX_FULL"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_f >/dev/null <<'SQL'
CREATE TABLE public.unrelated_f(value text);
INSERT INTO public.unrelated_f VALUES ('synthetic unrelated data');
ALTER TABLE public.unrelated_f OWNER TO polis_queue_owner;
SQL
set +e
OUT_F="$(run_down sc_f)"; RC_F=$?
set -e
[ "$RC_F" -ne 0 ] || fail "(f) down did NOT refuse with an unrelated owner-owned table"
echo "$OUT_F" | grep -qi "refusing to drop role" || fail "(f) expected a role-provenance refusal, got: $OUT_F"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT to_regclass('public.unrelated_f') IS NOT NULL" -d sc_f)" = "t" ] \
  || fail "(f) unrelated owner-owned table was dropped"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT count(*) FROM public.unrelated_f" -d sc_f)" = "1" ] \
  || fail "(f) unrelated table data was lost"
[ "$(queue_object_count sc_f)" -gt 0 ] || fail "(f) refusal did not roll the inventory drops back"
[ -n "$(queue_roles)" ] || fail "(f) roles were dropped despite the refusal"
echo "   (f) PASS (unrelated table + data + roles survive; whole tx rolled back)"

# --- (h) race: concurrent committed row is seen and refused, not lost ----------
echo "== check (h): concurrent writer blocked by the lock; row seen, not lost =="
createdb sc_h
apply_upto sc_h "$MAX_FULL"
ZIDH="$(docker exec "$CONTAINER" psql -U postgres -Atc \
  "WITH ins AS (INSERT INTO conversations (topic) VALUES ('p024 race') RETURNING zid) SELECT zid FROM ins" -d sc_h)"
# Background writer: take a row lock on heads, hold it, commit a row after a delay.
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d sc_h >/dev/null 2>&1 <<SQL &
BEGIN;
INSERT INTO public.polis_queue_heads(env,product_key,zid) VALUES ('race','p',$ZIDH);
SELECT pg_sleep(3);
COMMIT;
SQL
HOLDER=$!
# Wait until the writer actually holds its RowExclusive lock (deterministic).
for _ in $(seq 1 50); do
  HELD="$(docker exec "$CONTAINER" psql -U postgres -Atc \
    "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
       WHERE c.relname='polis_queue_heads' AND l.mode='RowExclusiveLock' AND l.granted" -d sc_h)"
  [ "${HELD:-0}" -ge 1 ] && break
  sleep 0.2
done
[ "${HELD:-0}" -ge 1 ] || fail "(h) background writer never took its lock"
# down blocks on ACCESS EXCLUSIVE until the writer commits (~3s), then sees 1 row.
# A generous lock_timeout ensures down waits the writer out rather than timing
# out; the fixed children-first lock order keeps it deadlock-free.
set +e
OUT_H="$(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -v lock_timeout=30s \
  -U postgres -d sc_h -f "/mig/$DOWN_REL" 2>&1)"; RC_H=$?
set -e
wait "$HOLDER" 2>/dev/null || true
[ "$RC_H" -ne 0 ] || fail "(h) down did NOT refuse the concurrently-committed row"
echo "$OUT_H" | grep -qi "refusing to drop a live queue" || fail "(h) expected live-queue refusal, got: $OUT_H"
[ "$(docker exec "$CONTAINER" psql -U postgres -Atc "SELECT count(*) FROM public.polis_queue_heads WHERE env='race'" -d sc_h)" = "1" ] \
  || fail "(h) concurrently committed row was lost"
echo "   (h) PASS (row committed under the lock is seen and refused, not lost)"

echo
echo "ALL CHECKS PASSED (a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s)"
