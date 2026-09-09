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
#
# This is a shell script rather than a delphi/tests pytest because the checks
# are schema-diff shaped (pg_dump of a full migration chain in an isolated
# cluster), which the delphi conftest fixture -- aimed at a possibly-shared
# database and the executor's runtime boundary -- does not host cleanly. It
# needs only docker and is self-contained.
#
# Usage:  bash server/postgres/migrations/down/test_000019_down.sh
# Exit 0 iff all four checks pass.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/.." && pwd)"          # server/postgres/migrations
DOWN_REL="down/000019_drop_polis_queue.sql"
CONTAINER="pgdown-test-$$"
PW="test"

PORT=""
for p in $(seq 56040 56049); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT="$p"; break; fi
  exec 3>&- 2>/dev/null || true
done
[ -n "$PORT" ] || { echo "FAIL: no free port in 56040-56049"; exit 1; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
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
dump_schema baseline > /tmp/down_baseline_schema.txt
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

# --- (a) apply 000019 then down; catalog must equal the 000018 baseline -------
echo "== check (a): apply 000000..$MAX_FULL, down, compare to baseline =="
createdb sc_a
apply_upto sc_a "$MAX_FULL"
[ "$(queue_object_count sc_a)" -gt 0 ] || fail "(a) 000019 apply produced no queue objects"
[ -n "$(queue_roles)" ] || fail "(a) 000019 apply produced no queue roles"
run_down sc_a >/dev/null || fail "(a) down exited nonzero"
dump_schema sc_a > /tmp/down_sc_a_schema.txt
if ! diff -u /tmp/down_baseline_schema.txt /tmp/down_sc_a_schema.txt > /tmp/down_a_diff.txt; then
  echo "---- schema diff (baseline vs apply+down) ----"; cat /tmp/down_a_diff.txt
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

echo
echo "ALL CHECKS PASSED (a, b, c, d)"
