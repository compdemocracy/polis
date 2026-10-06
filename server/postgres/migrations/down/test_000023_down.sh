#!/usr/bin/env bash
#
# Acceptance test for 000023_create_delphi_foundation.sql (the Delphi job
# table, polis-queue/2) and its reversal down/000023_drop_delphi_foundation.sql.
#
# A written, TESTED down script is a precondition for applying a migration to
# production; this is the test. It stands up a throwaway `postgres:17` (docker
# run, removed on exit; port in 56060-56069), applies the REAL migration chain
# with psql -f exactly as initdb does, and checks:
#
#   (seal) both files match down/000023-files.sha256.
#   (a) chain 000000..000022, then 000023: polis_queue_install reads
#       polis-queue/2; the seven job tables and the install table exist, are
#       owned by polis_queue_owner and are empty (the install table holds its
#       one baseline row); the stage CHECK admits exactly noop,
#       delphi_full_pipeline and delphi_narrative; the /2 RPCs (by exact
#       signature) are granted to polis_queue_executor, the /1 internals that
#       share a name are not, and nothing is granted to PUBLIC.
#   (b) a second apply is REFUSED (its /1 fingerprint guard sees the /2 shape:
#       "queue catalog drift") and changes nothing: the schema dump before and
#       after is identical.
#   (c) replaying 000019 over the /2 schema is REFUSED by 000019's own catalog
#       fingerprint ("queue catalog drift") and changes nothing, so no /2
#       function silently reverts to its /1 body.
#   (d) the down script restores the catalog: the schema dump after it is
#       identical to the dump taken before 000023 was applied, and the role
#       set is unchanged.
#   (e) apply -> down -> apply again succeeds.
#   (f) /2 data present: a delphi_jobs row (and separately a non-noop queue
#       row is covered by the row-level checks the script runs) -> the down
#       is REFUSED and every table survives; once the row is deleted it runs.
#   (g) the down on a database that never had 000023 (chain to 000022) fails
#       before changing anything: the dump is identical before and after.
#   (h) the noop /1 path still works on the /2 schema: as the executor,
#       pq_enqueue -> pq_claim (five arguments) -> pq_heartbeat -> pq_finalize
#       on a noop job succeeds, and the delphi_jobs table stays empty.
#   (i) the contended-parent witness, through the checked apply wrapper
#       (server/postgres/bin/apply-migration.sh), for 000019 on a chain to
#       000018 and for 000023 on a chain to 000022: with a concurrent
#       uncommitted UPDATE on public.conversations, the wrapper's preflight
#       refuses once that transaction is older than --max-xact-age; with the
#       age allowed, the apply is seen waiting for ShareRowExclusiveLock on
#       conversations (the foreign-key creation's parent lock), fails on
#       lock_timeout, and the schema dump is unchanged; once the writer is
#       terminated the same command applies and the post-check passes.
#
# Shell rather than a jest or pytest because the checks are schema-diff shaped
# (pg_dump of a full migration chain in an isolated cluster). Needs only docker.
#
# Usage:  bash server/postgres/migrations/down/test_000023_down.sh
# Exit 0 iff every check passes.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/.." && pwd)"          # server/postgres/migrations
UP="000023_create_delphi_foundation.sql"
DOWN="down/000023_drop_delphi_foundation.sql"
CONTAINER="pg000023-test-$$"
PW="test"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pg000023.XXXXXX")"

PORT=""
for p in $(seq 56060 56069); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT="$p"; break; fi
  exec 3>&- 2>/dev/null || true
done
[ -n "$PORT" ] || { echo "FAIL: no free port in 56060-56069"; exit 1; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }

echo "== seal =="
(cd "$MIGRATIONS_DIR" && shasum -a 256 -c down/000023-files.sha256) || fail "seal: a migration file differs from down/000023-files.sha256"

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

psql_su() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres "$@"; }
# A scalar query, trimmed.
scalar() { psql_su -d "$1" -At -c "$2"; }
createdb() { psql_su -d postgres -c "CREATE DATABASE \"$1\"" >/dev/null; }

# Apply migration files with numeric prefix <= $2 to db $1, in file-name order,
# one psql -f each with ON_ERROR_STOP (what docker-entrypoint-initdb.d does).
apply_upto() {
  local db="$1" max="$2" f base num
  for f in "$MIGRATIONS_DIR"/0*.sql; do
    base="$(basename "$f")"
    num="${base%%_*}"
    if [ "$num" -le "$max" ]; then
      psql_su -d "$db" -f "/mig/$base" >/dev/null 2>>"$WORK/chain.log"
    fi
  done
}
apply_one() { psql_su -d "$1" -f "/mig/$2" >/dev/null; }
# Same, expecting a refusal; prints the server's error text.
refuse_one() {
  local out
  if out="$(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$1" -f "/mig/$2" 2>&1)"; then
    fail "$2 on $1 was accepted; expected refusal"
  fi
  printf '%s' "$out"
}

# pg_dump schema, stripped of what varies per dump but is not schema.
dump_schema() {
  docker exec "$CONTAINER" pg_dump -U postgres --schema-only -d "$1" \
    | grep -vE '^--' | grep -vE '^[[:space:]]*$' \
    | grep -vE '^\\(restrict|unrestrict) '
}
roles() {
  scalar postgres "SELECT string_agg(rolname||':'||rolsuper||rolinherit||rolcreaterole||rolcreatedb||rolcanlogin, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'polis_%'"
}

JOB_TABLES="delphi_jobs delphi_job_aliases delphi_job_inputs delphi_current delphi_job_guards delphi_provider_requests polis_queue_logs"
# The /2 RPCs by exact signature (several names also have a /1 overload).
RPCS="pd_enqueue(text,integer,text,text,text,text,uuid,uuid,text,text,text,text,smallint,integer,text,text,text,jsonb)
pd_release_scope(text,text)
pd_job_view(text,uuid)
pd_provider_intent(text,uuid,uuid,uuid,bigint,uuid,text,bytea)
pd_provider_update(text,uuid,uuid,uuid,bigint,uuid,text,text)
pq_attempt_logs(text,uuid,bigint,integer)
pq_claim(text,smallint,uuid,uuid,integer,text)
pq_end_attempt(text,uuid,uuid,uuid,bigint,text,text,boolean,timestamptz)
pq_reap(text,uuid,integer,text)"
# /1 internals that stay ungranted, as in /1.
NOT_RPCS="pq_reap(text,uuid,integer) pq_end_attempt(text,uuid,uuid,uuid,bigint,text,text)"

# ------------------------------------------------------------------ (a)
echo "== (a) chain 000000..000022, then 000023 =="
createdb a
apply_upto a 000022
dump_schema a > "$WORK/a.before"
roles > "$WORK/roles.before"
apply_one a "$UP"
[ "$(scalar a "SELECT contract_version FROM public.polis_queue_install")" = "polis-queue/2" ] || fail "(a) contract_version is not polis-queue/2"
for t in $JOB_TABLES delphi_foundation_install; do
  [ "$(scalar a "SELECT to_regclass('public.$t')::text")" = "$t" ] || fail "(a) $t missing"
  [ "$(scalar a "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('public.$t')")" = "polis_queue_owner" ] || fail "(a) $t not owned by polis_queue_owner"
done
for t in $JOB_TABLES; do
  [ "$(scalar a "SELECT count(*) FROM public.$t")" = "0" ] || fail "(a) $t is not empty"
done
[ "$(scalar a "SELECT count(*) FROM public.delphi_foundation_install")" = "1" ] || fail "(a) install baseline row missing"
want="CHECK ((stage = ANY (ARRAY['noop'::text, 'delphi_full_pipeline'::text, 'delphi_narrative'::text])))"
got="$(scalar a "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.polis_queue_jobs'::regclass AND conname='polis_queue_jobs_stage_check'")"
[ "$got" = "$want" ] || fail "(a) stage CHECK is: $got"
for f in $RPCS; do
  [ "$(scalar a "SELECT has_function_privilege('polis_queue_executor','public.$f','EXECUTE')")" = "t" ] || fail "(a) $f not granted to the executor"
done
for f in $NOT_RPCS; do
  [ "$(scalar a "SELECT has_function_privilege('polis_queue_executor','public.$f','EXECUTE')")" = "f" ] || fail "(a) $f is granted to the executor"
done
[ "$(scalar a "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'pq\\_%' OR p.proname LIKE 'pd\\_%') AND x.grantee=0")" = "0" ] || fail "(a) a queue function is granted to PUBLIC"
[ "$(scalar a "SELECT count(*) FROM pg_class c, aclexplode(c.relacl) x WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (c.relname LIKE 'delphi\\_%' OR c.relname='polis_queue_logs') AND x.grantee=0")" = "0" ] || fail "(a) a job table is granted to PUBLIC"
dump_schema a > "$WORK/a.after"
pass "(a) applied: contract /2, 7 empty job tables + baseline, stage CHECK, executor grants"

# ------------------------------------------------------------------ (b)
echo "== (b) second apply refused, nothing changes =="
msg="$(refuse_one a "$UP")"
# The guard that fires first is 000023's copy of the /1 catalog fingerprint: the
# tables it expects in /1 shape are already /2. The collision check is behind it.
printf '%s' "$msg" | grep -q -E "queue catalog drift|foundation object collision" || fail "(b) second apply refused for another reason: $msg"
dump_schema a > "$WORK/a.after2"
cmp -s "$WORK/a.after" "$WORK/a.after2" || fail "(b) a refused second apply changed the catalog"
pass "(b) second apply refused; catalog unchanged"

# ------------------------------------------------------------------ (c)
echo "== (c) 000019 replay over /2 refused by its own fingerprint =="
msg="$(refuse_one a 000019_create_polis_queue.sql)"
printf '%s' "$msg" | grep -q "queue catalog drift" || fail "(c) 000019 replay refused for another reason: $msg"
dump_schema a > "$WORK/a.after3"
cmp -s "$WORK/a.after" "$WORK/a.after3" || fail "(c) the refused 000019 replay changed the catalog"
pass "(c) 000019 replay refused: queue catalog drift; nothing reverted"

# ------------------------------------------------------------------ (h)
echo "== (h) the noop /1 path still works on the /2 schema =="
psql_su -d a -c "INSERT INTO public.conversations(zid,topic) VALUES (1,'fixture')" >/dev/null
run="$(scalar a "SELECT gen_random_uuid()")"; job="$(scalar a "SELECT gen_random_uuid()")"
own="$(scalar a "SELECT gen_random_uuid()")"; att="$(scalar a "SELECT gen_random_uuid()")"
sha="$(printf '%064d' 1)"
noop() { psql_su -d a -qAt -c "SET ROLE polis_queue_executor; $1"; }
out="$(noop "SELECT public.pq_enqueue('test-000023',1,'product','actor','key','$sha','$run'::uuid,'$job'::uuid,'public-fixture-input','$sha','$sha','$sha',1::smallint,3)->>'outcome'")"
[ "$out" = "enqueued" ] || fail "(h) noop enqueue: $out"
out="$(noop "SELECT public.pq_claim('test-000023',1::smallint,'$own'::uuid,'$att'::uuid,60)->>'outcome'")"
[ "$out" = "owned" ] || fail "(h) noop claim: $out"
out="$(noop "SELECT public.pq_heartbeat('test-000023','$job'::uuid,'$own'::uuid,'$att'::uuid,1,60)->>'outcome'")"
[ "$out" = "owned" ] || fail "(h) noop heartbeat: $out"
uri="$(scalar a "SELECT expected_output_uri FROM public.polis_queue_runs WHERE run_id='$run'")"
osha="$(scalar a "SELECT expected_output_sha256 FROM public.polis_queue_runs WHERE run_id='$run'")"
out="$(noop "SELECT public.pq_finalize('test-000023','$job'::uuid,'$own'::uuid,'$att'::uuid,1,'$uri','$osha')->>'outcome'")"
[ "$out" = "succeeded" ] || fail "(h) noop finalize: $out"
[ "$(scalar a "SELECT count(*) FROM public.delphi_jobs")" = "0" ] || fail "(h) a noop job reached delphi_jobs"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_logs")" = "0" ] || fail "(h) a noop job wrote logs"
pass "(h) noop enqueue/claim/heartbeat/finalize succeed; delphi_jobs stays empty"
# A noop row is /1 data the down script allows; remove it so (d) compares a clean catalog on a clean database.
psql_su -d a -c "DELETE FROM public.polis_queue_requests; DELETE FROM public.polis_queue_attempts; DELETE FROM public.polis_queue_jobs; DELETE FROM public.polis_queue_heads; DELETE FROM public.polis_queue_runs; DELETE FROM public.conversations WHERE zid=1" >/dev/null

# ------------------------------------------------------------------ (f)
echo "== (f) /2 data present: down refused, tables survive =="
psql_su -d a -c "INSERT INTO public.conversations(zid,topic) VALUES (2,'fixture')" >/dev/null
psql_su -d a -c "INSERT INTO public.delphi_jobs(job_id,env,zid,kind,origin,status) VALUES (gen_random_uuid(),'test-000023',2,'full_pipeline','legacy_import','succeeded')" >/dev/null
msg="$(refuse_one a "$DOWN")"
printf '%s' "$msg" | grep -q "refusing reversal: foundation data in public.delphi_jobs" || fail "(f) down refused for another reason: $msg"
for t in $JOB_TABLES delphi_foundation_install; do
  [ "$(scalar a "SELECT to_regclass('public.$t')::text")" = "$t" ] || fail "(f) $t did not survive a refused down"
done
[ "$(scalar a "SELECT count(*) FROM public.delphi_jobs")" = "1" ] || fail "(f) the row did not survive a refused down"
psql_su -d a -c "DELETE FROM public.delphi_jobs; DELETE FROM public.conversations WHERE zid=2" >/dev/null
pass "(f) down refused with data; everything survived"

# ------------------------------------------------------------------ (d)
echo "== (d) down restores the catalog =="
apply_one a "$DOWN"
dump_schema a > "$WORK/a.down"
if ! cmp -s "$WORK/a.before" "$WORK/a.down"; then
  diff "$WORK/a.before" "$WORK/a.down" | head -40 >&2
  fail "(d) catalog after down differs from before 000023"
fi
[ "$(roles)" = "$(cat "$WORK/roles.before")" ] || fail "(d) the role set changed"
[ -z "$(scalar a "SELECT to_regclass('public.delphi_foundation_install')")" ] || fail "(d) install table survived"
[ "$(scalar a "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'pd\\_%'")" = "0" ] || fail "(d) a pd_ function survived"
pass "(d) down: schema dump identical to before 000023; roles unchanged"

# ------------------------------------------------------------------ (e)
echo "== (e) apply again after the down =="
apply_one a "$UP"
dump_schema a > "$WORK/a.again"
cmp -s "$WORK/a.after" "$WORK/a.again" || fail "(e) re-apply after down differs from the first apply"
apply_one a "$DOWN"
dump_schema a > "$WORK/a.down2"
cmp -s "$WORK/a.before" "$WORK/a.down2" || fail "(e) second down differs from before 000023"
pass "(e) apply -> down -> apply -> down: both states reproduce byte for byte"

# ------------------------------------------------------------------ (g)
echo "== (g) down on a database that never had 000023 =="
createdb g
apply_upto g 000022
dump_schema g > "$WORK/g.before"
msg="$(refuse_one g "$DOWN")"
dump_schema g > "$WORK/g.after"
cmp -s "$WORK/g.before" "$WORK/g.after" || fail "(g) the failed down changed a database without 000023"
pass "(g) down without 000023 fails before changing anything"

# ------------------------------------------------------------------ (i)
echo "== (i) contended parent: the wrapper refuses an old writer, waits behind a young one, fails on lock_timeout, applies nothing =="
WRAP="$MIGRATIONS_DIR/../bin/apply-migration.sh"
# The wrapper reads the migration from this checkout and streams it to the
# container's psql on stdin, the production shape with a different psql command.
wrap() { local db="$1" num="$2"; shift 2; bash "$WRAP" --free-bytes 12000000000 "$@" "$num" -- docker exec -i "$CONTAINER" psql -U postgres -d "$db"; }
# A serving write: one conversations row updated, the transaction left open.
hold_writer() {
  docker exec -i "$CONTAINER" psql -X -q -U postgres -d "$1" \
    -c "BEGIN; UPDATE public.conversations SET topic='held' WHERE zid=$2; SELECT pg_sleep(120); COMMIT;" >/dev/null 2>&1 &
  echo $!
}
conversations_locks() { # db granted(t|f): the lock modes held/awaited on conversations by other sessions
  scalar "$1" "SELECT coalesce(string_agg(l.mode, ',' ORDER BY l.mode), '') FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND l.relation='public.conversations'::regclass AND l.granted=$2"
}
witness() { # label db num chain_max
  local label="$1" db="$2" num="$3" upto="$4" wpid apid out rc mode=""
  createdb "$db"
  apply_upto "$db" "$upto"
  psql_su -d "$db" -c "INSERT INTO public.conversations(zid,topic) VALUES (7,'fixture')" >/dev/null
  dump_schema "$db" > "$WORK/$db.before"
  wpid="$(hold_writer "$db" 7)"
  for _ in $(seq 1 50); do
    case "$(conversations_locks "$db" true)" in *RowExclusiveLock*) break;; esac
    sleep 0.2
  done
  case "$(conversations_locks "$db" true)" in *RowExclusiveLock*) ;; *) fail "(i $label) the writer never took its lock on conversations";; esac
  sleep 2
  # (i.1) the writer's transaction is older than --max-xact-age: refused before anything is sent.
  set +e; out="$(wrap "$db" "$num" --max-xact-age 1 2>&1)"; rc=$?; set -e
  [ "$rc" -eq 4 ] || fail "(i $label) preflight did not refuse the old transaction (exit $rc): $out"
  printf '%s' "$out" | grep -q '^FAIL  xacts' || fail "(i $label) refused for another reason: $out"
  # (i.2) the age allowed: the apply waits for the parent lock and fails on lock_timeout.
  wrap "$db" "$num" --max-xact-age 600 --lock-timeout 3s > "$WORK/$db.apply" 2>&1 & apid=$!
  for _ in $(seq 1 150); do
    mode="$(conversations_locks "$db" false)"
    [ -n "$mode" ] && break
    sleep 0.1
  done
  set +e; wait "$apid"; rc=$?; set -e
  [ "$mode" = "ShareRowExclusiveLock" ] || fail "(i $label) the apply was not seen waiting for ShareRowExclusiveLock on conversations (saw '$mode'): $(cat "$WORK/$db.apply")"
  [ "$rc" -eq 5 ] || fail "(i $label) the contended apply did not fail as an apply failure (exit $rc): $(cat "$WORK/$db.apply")"
  grep -q 'lock timeout' "$WORK/$db.apply" || fail "(i $label) the apply failed for another reason: $(cat "$WORK/$db.apply")"
  dump_schema "$db" > "$WORK/$db.after_fail"
  cmp -s "$WORK/$db.before" "$WORK/$db.after_fail" || fail "(i $label) the failed apply changed the catalog"
  [ "$(scalar "$db" "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND (relname LIKE 'delphi\\_%' OR relname='polis_queue_logs')")" = "0" ] || fail "(i $label) a job table survived the failed apply"
  # (i.3) the writer is gone: the same command applies.
  psql_su -d "$db" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND query LIKE '%pg_sleep(120)%'" >/dev/null
  wait "$wpid" 2>/dev/null || true
  wrap "$db" "$num" --max-xact-age 600 > "$WORK/$db.apply2" 2>&1 || fail "(i $label) the apply after the writer left failed: $(cat "$WORK/$db.apply2")"
  grep -q '^applied: ' "$WORK/$db.apply2" || fail "(i $label) no post-check line: $(cat "$WORK/$db.apply2")"
  pass "(i $label) old writer refused by preflight; young writer: waited for ShareRowExclusiveLock on conversations, failed on lock_timeout, catalog unchanged; applied once the writer left"
}
witness 000019 i19 000019 000018
witness 000023 i23 000023 000022

echo "ALL CHECKS PASSED (seal, a-i)"
