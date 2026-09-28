#!/usr/bin/env bash
#
# Acceptance test for 000022_add_poll_timestamp_indexes.sql and its reversal
# down/000022_drop_poll_timestamp_indexes.sql (P-009 poll indexes).
#
# Stands up a throwaway postgres:17 (docker run, removed on exit; port in
# 56050-56059), applies the real migration chain, and checks:
#
#   (a) fresh chain 000000..000022 with psql -f (as initdb and
#       server/bin/run-migrations.sh apply it) -> both indexes exist, are valid
#       and ready, and have exactly the expected definitions.
#   (b) replaying 000022 is a no-op.
#   (c) 000022 also applies when a harness sends it as ONE transaction
#       (psql --single-transaction) and as ONE multi-statement query string
#       (psql -c, the same shape as psycopg2 cursor.execute(file_text)).
#   (d) populated tables (300,000 votes / 120,000 comments) without the indexes:
#       000022 REFUSES (it would block writes) and creates nothing; the poller's
#       vote and comment poll statements use no poll index (sequential scans).
#   (e) the operator path: CREATE INDEX CONCURRENTLY IF NOT EXISTS, one
#       statement per autocommit call, builds valid indexes; 000022 then applies
#       as a no-op check.
#   (f) EXPLAIN of the exact poll statements from
#       delphi/polismath/database/postgres.py (poll_votes_since,
#       poll_moderation_since), with an empty tail and a 100-row tail: votes uses
#       an Index Scan / Index Only Scan on votes_created_idx; comments uses
#       comments_modified_idx (Index Scan / Index Only Scan for the empty tail).
#   (g) a failed CONCURRENTLY build leaves an INVALID index: the runbook's
#       invalid-index query reports it, CREATE INDEX CONCURRENTLY IF NOT EXISTS
#       silently skips it, 000022 refuses it, DROP INDEX CONCURRENTLY IF EXISTS
#       removes it and the retry builds a valid index.
#   (h) the down file (psql -f, autocommit) drops both indexes; a second run is
#       a no-op; the poll statements go back to not using the indexes.
#   (i) replay on a database that already has both indexes takes no lock that
#       conflicts with writers: with an open writer transaction holding
#       ROW EXCLUSIVE on votes and comments, the replay completes, and a second
#       writer that arrives while the replay runs is not queued behind it.
#
# Needs docker and python3 (standard library only). Self-contained; touches
# no other database.
#
# Usage:  bash server/postgres/migrations/down/test_000022.sh
# Exit 0 iff all checks pass.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/.." && pwd)"                 # server/postgres/migrations
REPO_ROOT="$(cd "$MIGRATIONS_DIR/../../.." && pwd)"
POSTGRES_PY="$REPO_ROOT/delphi/polismath/database/postgres.py"
UP="000022_add_poll_timestamp_indexes.sql"
DOWN="down/000022_drop_poll_timestamp_indexes.sql"
CONTAINER="pg000022-test-$$"
PW="test"

[ -f "$POSTGRES_PY" ] || { echo "FAIL: $POSTGRES_PY not found"; exit 1; }

PORT=""
for p in $(seq 56050 56059); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT="$p"; break; fi
  exec 3>&- 2>/dev/null || true
done
[ -n "$PORT" ] || { echo "FAIL: no free port in 56050-56059"; exit 1; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== starting throwaway postgres:17 as $CONTAINER on port $PORT =="
docker run --rm -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PW" \
  -p "127.0.0.1:$PORT:5432" \
  -v "$MIGRATIONS_DIR":/mig:ro \
  postgres:17 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || fail "postgres did not become ready"
# pg_isready can pass during the image's init restart; wait for a real query.
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" psql -U postgres -Atc "SELECT 1" >/dev/null 2>&1; then break; fi
  sleep 1
done

psql_su() { docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres "$@"; }
q() { docker exec "$CONTAINER" psql -X -U postgres -Atc "$2" -d "$1"; }
createdb() { psql_su -d postgres -c "CREATE DATABASE \"$1\"" >/dev/null; }

# Apply migration files with numeric prefix <= $2 to db $1 (psql -f, autocommit).
apply_upto() {
  local db="$1" max="$2" f base num
  for f in "$MIGRATIONS_DIR"/0*.sql; do
    base="$(basename "$f")"
    num="${base%%_*}"
    if [ "$((10#$num))" -le "$((10#$max))" ]; then
      psql_su -d "$db" -f "/mig/$base" >/dev/null 2>&1 || fail "applying $base to $db"
    fi
  done
}

# name|indisvalid|indisready|definition for the two poll indexes, sorted.
index_state() {
  q "$1" "SELECT c.relname||'|'||x.indisvalid||'|'||x.indisready||'|'||pg_get_indexdef(x.indexrelid)
            FROM pg_index x JOIN pg_class c ON c.oid=x.indexrelid
           WHERE c.relnamespace='public'::regnamespace
             AND c.relname IN ('votes_created_idx','comments_modified_idx') ORDER BY 1"
}
EXPECTED_STATE="comments_modified_idx|true|true|CREATE INDEX comments_modified_idx ON public.comments USING btree (modified)
votes_created_idx|true|true|CREATE INDEX votes_created_idx ON public.votes USING btree (created)"

# The runbook's invalid-index check (names only).
invalid_indexes() {
  q "$1" "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_index x JOIN pg_class c ON c.oid=x.indexrelid
           WHERE c.relname IN ('votes_created_idx','comments_modified_idx') AND NOT (x.indisvalid AND x.indisready)"
}

# The two poll statements, extracted from the source with python's ast so the
# test follows the code, with :since replaced by a literal.
poll_sql() {  # poll_sql <function name> <since>
  python3 - "$POSTGRES_PY" "$1" "$2" <<'PY'
import ast, sys
path, fn, since = sys.argv[1], sys.argv[2], sys.argv[3]
tree = ast.parse(open(path).read())
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == fn:
        for call in ast.walk(node):
            if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                    and call.func.attr == "query" and call.args
                    and isinstance(call.args[0], ast.Constant)):
                sql = " ".join(call.args[0].value.split())
                assert sql.count(":since") == 1, sql
                print(sql.replace(":since", since))
                sys.exit(0)
sys.exit("no self.query(...) literal found in " + fn)
PY
}

# Print "NodeType:IndexName" for every plan node that uses an index.
plan_index_nodes() {  # plan_index_nodes <db> <sql>
  q "$1" "EXPLAIN (FORMAT JSON) $2" | python3 -c '
import json, sys
def walk(n):
    if "Index Name" in n:
        print(n["Node Type"] + ":" + n["Index Name"])
    for c in n.get("Plans", []):
        walk(c)
walk(json.load(sys.stdin)[0]["Plan"])'
}

VOTES_FN=poll_votes_since
COMMENTS_FN=poll_moderation_since
poll_sql "$VOTES_FN" 0 >/dev/null || fail "could not extract $VOTES_FN SQL"
poll_sql "$COMMENTS_FN" 0 >/dev/null || fail "could not extract $COMMENTS_FN SQL"

# ---------------------------------------------------------------------------
echo "== (a) fresh chain 000000..000022 =="
createdb t_a
apply_upto t_a 22
[ "$(index_state t_a)" = "$EXPECTED_STATE" ] || fail "(a) index state: $(index_state t_a)"
echo "   (a) PASS"

echo "== (b) replay 000022 =="
psql_su -d t_a -f "/mig/$UP" >/dev/null 2>&1 || fail "(b) replay failed"
[ "$(index_state t_a)" = "$EXPECTED_STATE" ] || fail "(b) index state changed"
echo "   (b) PASS"

echo "== (c) harness shapes: one transaction, one query string =="
createdb t_c1; apply_upto t_c1 21
psql_su -d t_c1 --single-transaction -f "/mig/$UP" >/dev/null 2>&1 || fail "(c) --single-transaction apply failed"
[ "$(index_state t_c1)" = "$EXPECTED_STATE" ] || fail "(c) single-transaction index state"
createdb t_c2; apply_upto t_c2 21
psql_su -d t_c2 -c "$(cat "$MIGRATIONS_DIR/$UP")" >/dev/null 2>&1 || fail "(c) single query-string apply failed"
[ "$(index_state t_c2)" = "$EXPECTED_STATE" ] || fail "(c) query-string index state"
echo "   (c) PASS"

# ---------------------------------------------------------------------------
echo "== (d) populated tables without the indexes: 000022 refuses =="
createdb t_d; apply_upto t_d 21
# session_replication_role=replica skips FK triggers and the votes rule, so the
# fixture needs no users/participants; tid is given explicitly (no tid_auto).
psql_su -d t_d >/dev/null <<'SQL'
SET session_replication_role = replica;
INSERT INTO votes (zid, pid, tid, vote, created)
  SELECT 1 + g % 300, g % 5000, g % 400, (g % 3) - 1, 1700000000000 + g * 10
  FROM generate_series(1, 300000) g;
INSERT INTO comments (tid, zid, pid, uid, txt, created, modified, mod)
  SELECT g, 1 + g % 500, g % 5000, 1, 'fixture comment ' || g,
         1700000000000 + g * 10, 1700000000000 + ((g * 7919) % 120000) * 10, 0
  FROM generate_series(1, 120000) g;
RESET session_replication_role;
ANALYZE votes; ANALYZE comments;
SQL
set +e
OUT_D=$(psql_su -d t_d -f "/mig/$UP" 2>&1); RC_D=$?
set -e
[ "$RC_D" -ne 0 ] || fail "(d) 000022 did not refuse a populated votes table"
echo "$OUT_D" | grep -q "votes has more than 100000 rows" || fail "(d) unexpected refusal: $OUT_D"
[ -z "$(index_state t_d)" ] || fail "(d) an index was created: $(index_state t_d)"

VMAX=$(q t_d "SELECT max(created) FROM votes")
CMAX=$(q t_d "SELECT max(modified) FROM comments")
VOTES_EMPTY=$(poll_sql "$VOTES_FN" "$VMAX")
VOTES_TAIL=$(poll_sql "$VOTES_FN" "$((VMAX - 1000))")
COMMENTS_EMPTY=$(poll_sql "$COMMENTS_FN" "$CMAX")
COMMENTS_TAIL=$(poll_sql "$COMMENTS_FN" "$((CMAX - 1000))")
[ "$(q t_d "SELECT count(*) FROM ($VOTES_TAIL) s")" = "100" ] || fail "(d) vote tail fixture is not 100 rows"
[ "$(q t_d "SELECT count(*) FROM ($COMMENTS_TAIL) s")" = "100" ] || fail "(d) comment tail fixture is not 100 rows"
for s in "$VOTES_EMPTY" "$VOTES_TAIL" "$COMMENTS_EMPTY" "$COMMENTS_TAIL"; do
  if plan_index_nodes t_d "$s" | grep -qE ':(votes_created_idx|comments_modified_idx)$'; then
    fail "(d) a poll index appears in a plan before it exists"
  fi
done
echo "   (d) PASS (refused, nothing created; polls do not use a poll index)"

# ---------------------------------------------------------------------------
echo "== (e) operator path: CREATE INDEX CONCURRENTLY, then 000022 is a no-op check =="
psql_su -d t_d -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS votes_created_idx ON public.votes USING btree (created)" >/dev/null 2>&1 \
  || fail "(e) concurrent votes build"
psql_su -d t_d -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_modified_idx ON public.comments USING btree (modified)" >/dev/null 2>&1 \
  || fail "(e) concurrent comments build"
psql_su -d t_d -c "ANALYZE votes" -c "ANALYZE comments" >/dev/null
[ "$(index_state t_d)" = "$EXPECTED_STATE" ] || fail "(e) index state after concurrent build: $(index_state t_d)"
psql_su -d t_d -f "/mig/$UP" >/dev/null 2>&1 || fail "(e) 000022 after the concurrent build failed"
[ "$(index_state t_d)" = "$EXPECTED_STATE" ] || fail "(e) index state after 000022"
echo "   (e) PASS"

# ---------------------------------------------------------------------------
echo "== (f) poll statements use the indexes =="
check_plan() {  # check_plan <label> <sql> <index> <allowed node regex>
  local nodes; nodes="$(plan_index_nodes t_d "$2")"
  echo "$nodes" | grep -qE "^($4):$3\$" || fail "(f) $1: expected $4 on $3, plan index nodes: [$nodes]"
  echo "   (f) $1: $(echo "$nodes" | grep ":$3\$" | head -1)"
}
check_plan "votes, empty tail"    "$VOTES_EMPTY"    votes_created_idx     "Index Scan|Index Only Scan"
check_plan "votes, 100-row tail"  "$VOTES_TAIL"     votes_created_idx     "Index Scan|Index Only Scan"
check_plan "comments, empty tail" "$COMMENTS_EMPTY" comments_modified_idx "Index Scan|Index Only Scan"
check_plan "comments, 100-row tail" "$COMMENTS_TAIL" comments_modified_idx "Index Scan|Index Only Scan|Bitmap Index Scan"
echo "   (f) PASS"

# ---------------------------------------------------------------------------
echo "== (g) failed CONCURRENTLY build leaves an INVALID index =="
psql_su -d t_d -c "DROP INDEX CONCURRENTLY IF EXISTS public.comments_modified_idx" >/dev/null 2>&1 || fail "(g) drop"
# A UNIQUE build over duplicate zids fails after the catalog entry exists,
# which is exactly how an interrupted or failed concurrent build ends.
set +e
psql_su -d t_d -c "CREATE UNIQUE INDEX CONCURRENTLY comments_modified_idx ON public.comments USING btree (zid)" >/dev/null 2>&1; RC_G=$?
set -e
[ "$RC_G" -ne 0 ] || fail "(g) the deliberately failing build succeeded"
[ "$(invalid_indexes t_d)" = "comments_modified_idx" ] || fail "(g) invalid-index check did not report it: [$(invalid_indexes t_d)]"
OUT_G=$(psql_su -d t_d -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_modified_idx ON public.comments USING btree (modified)" 2>&1) \
  || fail "(g) IF NOT EXISTS errored instead of skipping"
echo "$OUT_G" | grep -qi "already exists, skipping" || fail "(g) expected a skip NOTICE, got: $OUT_G"
[ "$(invalid_indexes t_d)" = "comments_modified_idx" ] || fail "(g) IF NOT EXISTS changed the invalid index"
set +e
OUT_G2=$(psql_su -d t_d -f "/mig/$UP" 2>&1); RC_G2=$?
set -e
[ "$RC_G2" -ne 0 ] || fail "(g) 000022 accepted an INVALID index"
echo "$OUT_G2" | grep -q "comments_modified_idx exists but is not valid" || fail "(g) unexpected 000022 output: $OUT_G2"
psql_su -d t_d -c "DROP INDEX CONCURRENTLY IF EXISTS public.comments_modified_idx" >/dev/null 2>&1 || fail "(g) drop of invalid index"
psql_su -d t_d -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_modified_idx ON public.comments USING btree (modified)" >/dev/null 2>&1 \
  || fail "(g) retry build"
[ -z "$(invalid_indexes t_d)" ] || fail "(g) still invalid after retry"
[ "$(index_state t_d)" = "$EXPECTED_STATE" ] || fail "(g) index state after retry"
echo "   (g) PASS"

# ---------------------------------------------------------------------------
echo "== (h) reversal =="
psql_su -d t_d -f "/mig/$DOWN" >/dev/null 2>&1 || fail "(h) down failed"
[ -z "$(index_state t_d)" ] || fail "(h) indexes remain: $(index_state t_d)"
OUT_H=$(psql_su -d t_d -f "/mig/$DOWN" 2>&1) || fail "(h) second down failed"
echo "$OUT_H" | grep -qi "does not exist, skipping" || fail "(h) expected skip NOTICEs, got: $OUT_H"
for s in "$VOTES_EMPTY" "$VOTES_TAIL" "$COMMENTS_EMPTY" "$COMMENTS_TAIL"; do
  if plan_index_nodes t_d "$s" | grep -qE ':(votes_created_idx|comments_modified_idx)$'; then
    fail "(h) a poll index still appears in a plan after the reversal"
  fi
done
# The reversal cannot run inside a transaction block (documented in the file).
set +e
psql_su -d t_a --single-transaction -f "/mig/$DOWN" >/dev/null 2>&1; RC_H=$?
set -e
[ "$RC_H" -ne 0 ] || fail "(h) down unexpectedly ran inside a transaction block"
[ "$(index_state t_a)" = "$EXPECTED_STATE" ] || fail "(h) failed transactional down changed t_a"
echo "   (h) PASS"

echo
# ---------------------------------------------------------------------------
echo "== (i) replay with the indexes present does not block writers =="
# t_a has both valid indexes (from (a)). Hold ROW EXCLUSIVE on both tables, the
# lock every INSERT/UPDATE takes, in an open transaction.
docker exec "$CONTAINER" psql -X -U postgres -d t_a -c \
  "BEGIN; LOCK TABLE votes, comments IN ROW EXCLUSIVE MODE; SELECT pg_sleep(20); COMMIT;" >/dev/null 2>&1 &
HOLDER=$!
for _ in $(seq 1 50); do
  [ "$(q t_a "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE c.relname IN ('votes','comments') AND l.mode='RowExclusiveLock' AND l.granted")" = "2" ] && break
  sleep 0.1
done
[ "$(q t_a "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE c.relname IN ('votes','comments') AND l.mode='RowExclusiveLock' AND l.granted")" = "2" ] \
  || fail "(i) writer locks not held"
# Replay 000022 in the background with NO lock timeout, exactly as a runner would.
START_I=$(date +%s)
docker exec "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d t_a -f "/mig/$UP" >/dev/null 2>&1 &
REPLAY=$!
sleep 1   # let the replay reach (or finish) its first lock request
# A second writer arriving while the replay runs must not wait (5 s lock_timeout
# turns any queueing into a failure).
docker exec -e PGOPTIONS="-c lock_timeout=5000" "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d t_a -c \
  "INSERT INTO votes (zid, pid, tid, vote, created) SELECT zid, pid, tid, vote, created FROM votes WHERE false;
   UPDATE comments SET mod = mod WHERE false;" >/dev/null 2>&1 \
  || fail "(i) a writer was blocked during the replay"
set +e
wait "$REPLAY"; RC_I=$?
set -e
END_I=$(date +%s)
[ "$RC_I" -eq 0 ] || fail "(i) replay failed with writers present"
[ $((END_I - START_I)) -lt 15 ] || fail "(i) replay waited for the writer transaction ($((END_I - START_I)) s)"
# No lock on either table was ever requested in a mode that conflicts with writers.
[ "$(q t_a "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE c.relname IN ('votes','comments') AND NOT l.granted")" = "0" ] \
  || fail "(i) a lock request is still waiting"
[ "$(index_state t_a)" = "$EXPECTED_STATE" ] || fail "(i) index state changed"
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true
echo "   (i) PASS (replay finished in $((END_I - START_I)) s while writers held ROW EXCLUSIVE; a new writer was not queued)"

echo
echo "ALL CHECKS PASSED (a, b, c, d, e, f, g, h, i)"
