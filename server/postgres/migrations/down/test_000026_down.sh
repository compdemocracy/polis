#!/usr/bin/env bash
#
# Acceptance test for 000026_create_polis_queue_retention.sql (retention by
# reachability, restart-safe reads, the dead-job breaker) and its reversal
# down/000026_drop_polis_queue_retention.sql, and for the composed chain
# 000019 -> 000023 -> 000024 -> 000025 -> 000026 with the checked wrapper.
#
# It stands up a throwaway `postgres:17` (docker run, removed on exit; port in
# 56080-56089), applies the REAL migration chain with psql -f exactly as
# initdb does, and checks:
#
#   (seal) both files match down/000026-files.sha256; the ledger
#       self-checksums (check_ledger_checksums.py).
#   (a) chain to 000025, then 000026: contract_version still polis-queue/3;
#       000026's ledger row carries its checksum; the new tables are owned by
#       polis_queue_owner and closed to the executor; the three indexes and
#       the breaker trigger exist; the executor gets exactly the three RPCs;
#       nothing to PUBLIC; the retention policy ships every kind as dry_run.
#   (b) a second apply is REFUSED and changes nothing.
#   (c) replaying 000019, 000023 or 000024 over it is REFUSED.
#   (h) behaviour as the executor: depth /4, parked rediscovery, usage; then
#       retention by reachability: the shipped dry run reports what it would
#       delete per kind and deletes nothing; an UPDATE of the policy (no
#       migration) turns deletion on; a sweep tombstones and deletes nothing;
#       pinning a tombstoned job and widening a kind's keep_days restore its
#       rows; after the grace the purge removes what is still deletable and
#       keeps what is reached (pinned, a held guard, an unproven exit, an
#       active job, the newest success, a head's run); unpinning lets a later
#       cycle take it; not_due, busy, abandoned and page order hold.
#   (r) reachability through inputs: the inputs of a pinned job survive every
#       cycle; once the consumer is unpinned and purged, its input goes on
#       the next cycle.
#   (k) the breaker (decision #729): three deaths open it; admission answers
#       poisoned naming the latest dead job; sweeps with deletion on keep the
#       counted dead jobs and the breaker stays open; 24 hours later (the
#       clock moved by rewriting opened_at) ONE probe is admitted while a
#       second admission is poisoned; the probe dies -> open again for 24
#       hours; the next probe succeeds -> closed (and the old dead jobs become
#       ordinary history); a new image resets an open breaker; a cancelled
#       probe frees the probe slot.
#   (s) the breaker is seeded at apply from 000024-era history.
#   (f) after a purge the down is REFUSED and nothing changes.
#   (d) after a dry run and a tombstoning sweep (no purge) the down runs: the
#       schema dump is identical to the one before 000026, the tombstoned
#       rows are all still there, 000026's ledger row is gone, roles unchanged.
#   (e) apply -> down -> apply -> down: both states reproduce byte for byte.
#   (g) the down without 000026, 000026 without 000024, and 000026 without
#       000025's ledger all fail before changing anything.
#   (l) the down order: over 000026, 000025's down and 000024's down refuse
#       and change nothing; after 000026's down, 000025's down runs.
#   (i) the full chain on an empty database, one file at a time: up 000019,
#       000021, 000022, 000023, 000024, 000025, 000026 (a dump after each);
#       down in reverse, each dump identical to the one before that file's
#       up; up again, each dump identical to the first.
#   (w) the checked wrapper for 000026: refused without 000024 and without
#       000025; with queue rows --preflight-only passes and reports them; the
#       apply runs (post-check: install, ledger, /3) and seeds the breaker; a
#       second run is refused.
#   (p) the populated chain through the wrapper: a database holding
#       conversations and votes takes 000019, 000023, 000024, 000025 and
#       000026 by the wrapper (000021, 000022 by psql). At each wrapper step a
#       holder of the lock that step needs (a writer on conversations for
#       000019 and 000023; on polis_queue_jobs for 000024 and 000026; ACCESS
#       EXCLUSIVE on votes for 000025) makes the apply wait and time out
#       (exit 5) with the schema unchanged; 000024, 000025 and 000026 then
#       apply while a writer holds a conversations row (none of them locks
#       conversations). The data is unchanged at every step. Then every down
#       in reverse, each dump identical to the one before that step's up.
#
# Usage:  bash server/postgres/migrations/down/test_000026_down.sh
# Exit 0 iff every check passes.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/.." && pwd)"          # server/postgres/migrations
UP="000026_create_polis_queue_retention.sql"
DOWN="down/000026_drop_polis_queue_retention.sql"
UP25="000025_vote_convention.sql"
DOWN25="down/000025_drop_vote_convention.sql"
UP24="000024_create_polis_queue_large_class.sql"
DOWN24="down/000024_drop_polis_queue_large_class.sql"
UP23="000023_create_delphi_foundation.sql"
DOWN23="down/000023_drop_delphi_foundation.sql"
CONTAINER="pg000026-test-$$"
PW="test"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pg000026.XXXXXX")"
ENVN="test-000026"

PORT=""
for p in $(seq 56080 56089); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT="$p"; break; fi
  exec 3>&- 2>/dev/null || true
done
[ -n "$PORT" ] || { echo "FAIL: no free port in 56080-56089"; exit 1; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }

echo "== seal =="
(cd "$MIGRATIONS_DIR" && shasum -a 256 -c down/000026-files.sha256) || fail "seal: a migration file differs from down/000026-files.sha256"
python3 "$MIGRATIONS_DIR/../check_ledger_checksums.py" >/dev/null || fail "seal: a ledger self-checksum is wrong (check_ledger_checksums.py)"

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
sleep 2
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || fail "postgres did not stay ready"

psql_su() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres "$@"; }
scalar() { psql_su -d "$1" -At -c "$2"; }
createdb() { psql_su -d postgres -c "CREATE DATABASE \"$1\"" >/dev/null; }

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
apply_one() { psql_su -d "$1" -f "/mig/$2" >/dev/null 2>>"$WORK/chain.log"; }
refuse_one() {
  local out
  if out="$(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$1" -f "/mig/$2" 2>&1)"; then
    fail "$2 on $1 was accepted; expected refusal"
  fi
  printf '%s' "$out"
}
dump_schema() {
  docker exec "$CONTAINER" pg_dump -U postgres --schema-only -d "$1" \
    | grep -vE '^--' | grep -vE '^[[:space:]]*$' \
    | grep -vE '^\\(restrict|unrestrict) '
}
same() { # label fileA fileB
  if ! cmp -s "$2" "$3"; then diff "$2" "$3" | head -40 >&2; fail "$1"; fi
}
roles() {
  scalar postgres "SELECT string_agg(rolname||':'||rolsuper||rolinherit||rolcreaterole||rolcreatedb||rolcanlogin, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'polis_%'"
}
ex() { psql_su -d "$1" -qAt -c "SET ROLE polis_queue_executor; $2"; }
ex_refused() {
  local out
  if out="$(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$1" -qAt -c "SET ROLE polis_queue_executor; $2" 2>&1)"; then
    fail "$3: accepted ($out); expected refusal"
  fi
  printf '%s' "$out"
}
uuid() { scalar "$1" "SELECT gen_random_uuid()"; }

JOB_TABLES="delphi_jobs delphi_job_aliases delphi_job_inputs delphi_current delphi_job_guards delphi_provider_requests polis_queue_logs polis_queue_jobs polis_queue_runs polis_queue_attempts polis_queue_requests polis_queue_heads polis_queue_sweeps polis_queue_breakers polis_queue_tombstones"
NEW_TABLES="polis_queue_retention_install polis_queue_sweeps polis_queue_breakers polis_queue_retention_policy polis_queue_tombstones"
NEW_RPCS="pq_class_parked(text,text,uuid,integer) pq_queue_usage(text) pq_sweep(text,uuid,integer,integer)"
OWNER_ONLY="pq_breaker_record() pq_retention_reached(text) pq_retention_candidates(text)"
SHA1="$(printf '%064d' 1)"
SHA2="$(printf '%064d' 2)"

# --------------------------------------------------------------- fixtures
# Every helper below works on the database named by $D.
D=a
adm() { # zid scope key sha run job image max_attempts product (default: the scope)
  ex "$D" "SELECT public.pd_enqueue('$ENVN',$1,'${9:-$2}','poller','$3','$4','$5'::uuid,'$6'::uuid,'public-fixture-input','$SHA1','$SHA1','${7:-fixture-image}',1::smallint,${8:-3},'math_rebuild',NULL,'$2','{\"need_bytes\":1}'::jsonb)"
}
outcome_of() { printf '%s' "$1" | grep -oE '"outcome": *"[a-z_]+"' | grep -oE '"[a-z_]+"$' | tr -d '"'; }
job_of() { printf '%s' "$1" | grep -oE '"job_id": *"[0-9a-f-]+"' | head -1 | grep -oE '[0-9a-f-]{36}'; }
manifest() { # job attempt
  echo "{\"schema\":\"polis-jobs.output-manifest/1\",\"job_id\":\"$1\",\"attempt_id\":\"$2\",\"stage\":\"math_rebuild\",\"phase\":\"run\",\"outcome\":\"succeeded\",\"inputs\":{\"math_env\":\"python-large\",\"math_tick\":7,\"vote_hwm\":12},\"outputs\":[],\"models\":{},\"cost\":{}}"
}
claim() { ex "$D" "SELECT public.pq_claim('$ENVN',1::smallint,'$1'::uuid,'$2'::uuid,${3:-60},'large')->>'job_id'"; }
depth() { ex "$D" "SELECT public.pq_class_depth('$ENVN','large')"; }
cancel() { ex "$D" "SELECT public.pq_cancel('$ENVN','$1'::uuid,(public.pq_job_status('$ENVN','$1'::uuid)->>'mgmt_version')::bigint)" >/dev/null; }
# Run an admitted job to success: claim, a stdout line and the manifest row,
# exit proof, finalize. Prints the attempt id.
run_ok() { # job label
  local o t m msha
  o="$(uuid "$D")"; t="$(uuid "$D")"
  [ "$(claim "$o" "$t")" = "$1" ] || fail "claim $2"
  m="$(manifest "$1" "$t")"
  ex "$D" "INSERT INTO public.polis_queue_logs(env,attempt_id,seq,stream,line) VALUES('$ENVN','$t'::uuid,0,'stdout','public fixture line'),('$ENVN','$t'::uuid,1,'manifest','$m')" >/dev/null
  msha="$(scalar "$D" "SELECT encode(sha256(convert_to(line,'UTF8')),'hex') FROM public.polis_queue_logs WHERE attempt_id='$t' AND stream='manifest'")"
  [ "$(ex "$D" "SELECT public.pq_end_attempt('$ENVN','$1'::uuid,'$o'::uuid,'$t'::uuid,1,'confirm_exit',NULL,true)->>'outcome'")" = "exit_confirmed" ] || fail "confirm_exit $2"
  [ "$(ex "$D" "SELECT public.pq_finalize('$ENVN','$1'::uuid,'$o'::uuid,'$t'::uuid,1,'file:///work/output-manifest.json','$msha')->>'outcome'")" = "succeeded" ] || fail "finalize $2"
  echo "$t"
}
# Run an admitted job to death: one attempt, a permanent failure with exit
# proof, a stderr line. Prints the attempt id.
run_dead() { # job label
  local o t
  o="$(uuid "$D")"; t="$(uuid "$D")"
  [ "$(claim "$o" "$t")" = "$1" ] || fail "claim $2"
  ex "$D" "INSERT INTO public.polis_queue_logs(env,attempt_id,seq,stream,line) VALUES('$ENVN','$t'::uuid,0,'stderr','public fixture failure')" >/dev/null
  [ "$(ex "$D" "SELECT public.pq_fail('$ENVN','$1'::uuid,'$o'::uuid,'$t'::uuid,1,true,'stage_failed:1',true)->>'state'")" = "dead" ] || fail "death $2"
  echo "$t"
}
release() { [ "$(ex "$D" "SELECT public.pd_release_scope('$ENVN','$1')")" = "t" ] || fail "release $1"; }
finish_ok() { # zid scope key [product]  -> "job attempt"
  local r j out t
  r="$(uuid "$D")"; j="$(uuid "$D")"
  out="$(adm "$1" "$2" "$3" "$SHA1" "$r" "$j" fixture-image 3 "${4:-}")"
  [ "$(outcome_of "$out")" = "enqueued" ] || fail "admission $3: $out"
  t="$(run_ok "$j" "$3")"; release "$2"
  echo "$j $t"
}
finish_dead() { # zid scope key [image]  -> "job attempt"
  local r j out t
  r="$(uuid "$D")"; j="$(uuid "$D")"
  out="$(adm "$1" "$2" "$3" "$SHA1" "$r" "$j" "${4:-fixture-image}" 1)"
  [ "$(outcome_of "$out")" = "enqueued" ] || fail "admission $3: $out"
  t="$(run_dead "$j" "$3")"; release "$2"
  echo "$j $t"
}
age() { # job days (the job's last change and its attempts' end)
  psql_su -d "$D" -qc "UPDATE public.polis_queue_jobs SET updated_at=now()-interval '$2 days' WHERE job_id='$1'; UPDATE public.polis_queue_attempts SET ended_at=now()-interval '$2 days' WHERE job_id='$1'" >/dev/null
}
logs_of() { scalar "$D" "SELECT COALESCE(string_agg(stream,',' ORDER BY seq),'-') FROM public.polis_queue_logs WHERE attempt_id='$1'"; }
exists_job() { scalar "$D" "SELECT count(*) FROM public.polis_queue_jobs WHERE job_id='$1'"; }
sweep() { ex "$D" "SELECT public.pq_sweep('$ENVN',gen_random_uuid(),1,10)"; }
count_in() { printf '%s' "$1" | grep -oE "\"$2\": *[0-9]+" | head -1 | grep -oE '[0-9]+$'; }
# The clock, moved by rewriting stored times: a sweep is due again; the
# tombstones are past their grace.
next_day() { psql_su -d "$D" -qc "UPDATE public.polis_queue_sweeps SET started_at=started_at-interval '25 hours', finished_at=finished_at-interval '25 hours'" >/dev/null; }
past_grace() { psql_su -d "$D" -qc "UPDATE public.polis_queue_tombstones SET tombstoned_at=tombstoned_at-interval '8 days'" >/dev/null; }
policy_all() { psql_su -d "$D" -qc "UPDATE public.polis_queue_retention_policy SET action='$1', updated_at=clock_timestamp()" >/dev/null; }
tombs() { scalar "$D" "SELECT count(*) FROM public.polis_queue_tombstones WHERE kind='$1'"; }
breaker() { # zid -> consecutive|open|probe
  scalar "$D" "SELECT consecutive_dead||'|'||(opened_at IS NOT NULL)||'|'||COALESCE(probe_job_id::text,'-') FROM public.polis_queue_breakers WHERE env='$ENVN' AND zid=$1"
}

# ------------------------------------------------------------------ (a)
echo "== (a) chain to 000025, then 000026 =="
createdb a
apply_upto a 000025
dump_schema a > "$WORK/a.before"
roles > "$WORK/roles.before"
apply_one a "$UP"
[ "$(scalar a "SELECT contract_version FROM public.polis_queue_install")" = "polis-queue/3" ] || fail "(a) contract_version moved"
for t in $JOB_TABLES; do
  [ "$(scalar a "SELECT count(*) FROM public.$t")" = "0" ] || fail "(a) $t is not empty"
done
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_retention_install WHERE rows_purged=0")" = "1" ] || fail "(a) install baseline row missing"
want="$(python3 "$MIGRATIONS_DIR/../check_ledger_checksums.py" --print "$MIGRATIONS_DIR/$UP")"
[ "$(scalar a "SELECT checksum FROM public.schema_migrations WHERE name='000026_create_polis_queue_retention'")" = "$want" ] || fail "(a) 000026's ledger row does not carry its self-checksum $want"
for t in $NEW_TABLES; do
  [ "$(scalar a "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.$t'::regclass")" = "polis_queue_owner" ] || fail "(a) $t not owned by polis_queue_owner"
  [ "$(scalar a "SELECT has_table_privilege('polis_queue_executor','public.$t','SELECT,INSERT,UPDATE,DELETE')")" = "f" ] || fail "(a) the executor can reach $t"
done
for i in "polis_queue_jobs_terminal_age|(env, updated_at, job_id) WHERE (state = ANY (ARRAY['succeeded'::text, 'dead'::text, 'cancelled'::text]))" \
         "polis_queue_attempts_ended|(env, ended_at, attempt_id) WHERE (ended_at IS NOT NULL)" \
         "polis_queue_requests_expiry|(env, binding_expires_at) WHERE (binding_expires_at IS NOT NULL)"; do
  name="${i%%|*}"; want="${i#*|}"
  got="$(scalar a "SELECT pg_get_indexdef('public.$name'::regclass)")"
  printf '%s' "$got" | grep -qF "$want" || fail "(a) index $name is: $got"
done
[ "$(scalar a "SELECT count(*) FROM pg_trigger WHERE tgrelid='public.polis_queue_jobs'::regclass AND tgname='pq_breaker_record' AND NOT tgisinternal")" = "1" ] || fail "(a) the breaker trigger is missing"
for f in $NEW_RPCS; do
  [ "$(scalar a "SELECT has_function_privilege('polis_queue_executor','public.$f','EXECUTE')")" = "t" ] || fail "(a) $f not granted to the executor"
  [ "$(scalar a "SELECT prosecdef AND pg_get_userbyid(proowner)='polis_queue_owner' FROM pg_proc WHERE oid='public.$f'::regprocedure")" = "t" ] || fail "(a) $f is not SECURITY DEFINER owned by polis_queue_owner"
done
for f in $OWNER_ONLY; do
  [ "$(scalar a "SELECT has_function_privilege('polis_queue_executor','public.$f','EXECUTE')")" = "f" ] || fail "(a) the executor can call $f"
done
[ "$(scalar a "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'pq\\_%' OR p.proname LIKE 'pd\\_%') AND x.grantee=0")" = "0" ] || fail "(a) a queue function is granted to PUBLIC"
[ "$(scalar a "SELECT count(*) FROM pg_class c, aclexplode(c.relacl) x WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (c.relname LIKE 'delphi\\_%' OR c.relname LIKE 'polis\\_queue\\_%') AND x.grantee=0")" = "0" ] || fail "(a) a queue table is granted to PUBLIC"
[ "$(scalar a "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'pq\\_%'")" = "35" ] || fail "(a) expected 35 pq_ functions (29 at /3 + six)"
POLICY="$(scalar a "SELECT string_agg(kind||':'||keep_days||'/'||keep_last||'/'||action, ',' ORDER BY kind) FROM public.polis_queue_retention_policy")"
[ "$POLICY" = "binding:1/0/dry_run,job_cancelled:30/0/dry_run,job_dead:90/0/dry_run,job_succeeded:30/1/dry_run,logs_failed:30/0/dry_run,logs_succeeded:7/0/dry_run,sweep_history:90/0/dry_run,tombstone:7/0/dry_run" ] \
  || fail "(a) the shipped policy: $POLICY"
dump_schema a > "$WORK/a.after"
pass "(a) applied: contract /3, ledger row with its checksum, owner-only tables, trigger, three executor RPCs, policy all dry_run"

# ------------------------------------------------------------------ (b)
echo "== (b) second apply refused, nothing changes =="
msg="$(refuse_one a "$UP")"
printf '%s' "$msg" | grep -q "ledger already records 000026_create_polis_queue_retention" || fail "(b) second apply refused for another reason: $msg"
dump_schema a > "$WORK/a.after2"
same "(b) a refused second apply changed the catalog" "$WORK/a.after" "$WORK/a.after2"
pass "(b) second apply refused (the ledger records 000026); catalog unchanged"

# ------------------------------------------------------------------ (c)
echo "== (c) 000019, 000023 and 000024 replays refused =="
msg="$(refuse_one a 000019_create_polis_queue.sql)"
printf '%s' "$msg" | grep -q "queue catalog drift" || fail "(c) 000019 replay refused for another reason: $msg"
msg="$(refuse_one a "$UP23")"
printf '%s' "$msg" | grep -q -E "queue catalog drift|foundation object collision" || fail "(c) 000023 replay refused for another reason: $msg"
msg="$(refuse_one a "$UP24")"
printf '%s' "$msg" | grep -q -E "queue catalog drift|large class object collision" || fail "(c) 000024 replay refused for another reason: $msg"
dump_schema a > "$WORK/a.after3"
same "(c) a refused replay changed the catalog" "$WORK/a.after" "$WORK/a.after3"
pass "(c) replays refused; nothing reverted"

# ------------------------------------------------------------------ (h)
echo "== (h) behaviour as the executor; retention by reachability =="
D=a
psql_su -d a -c "INSERT INTO public.conversations(zid,topic) VALUES (1,'fixture'),(2,'fixture two'),(3,'fixture three'),(4,'fixture four'),(5,'fixture five')" >/dev/null
need() { [ -n "$2" ] || fail "(h) fixture $1 was not made"; }

out="$(depth)"
printf '%s' "$out" | grep -q '"schema_version": *"polis-queue/4"' || fail "(h) depth version: $out"
printf '%s' "$out" | grep -q '"oldest_eligible_at": *null' || fail "(h) empty depth oldest_eligible_at: $out"
out="$(ex a "SELECT public.pq_queue_usage('$ENVN')")"
printf '%s' "$out" | grep -q '"last_sweep_finished_at": *null' || fail "(h) usage before any sweep: $out"
[ "$(ex a "SELECT (public.pq_queue_usage('$ENVN')->>'queue_bytes')::bigint > 0")" = "t" ] || fail "(h) queue_bytes not positive"
msg="$(ex_refused a "SELECT public.pq_queue_usage('')" "(h) usage without an env")"; printf '%s' "$msg" | grep -q "invalid usage read" || fail "(h) usage refusal text: $msg"
msg="$(ex_refused a "SELECT public.pq_class_parked('$ENVN','noop',NULL,10)" "(h) parked of class noop")"; printf '%s' "$msg" | grep -q "invalid parked read" || fail "(h) parked refusal text: $msg"
msg="$(ex_refused a "SELECT public.pq_class_parked('$ENVN','large',NULL,101)" "(h) parked page over 100")"; printf '%s' "$msg" | grep -q "invalid parked read" || fail "(h) parked bound text: $msg"
msg="$(ex_refused a "SELECT * FROM public.pq_retention_reached('$ENVN')" "(h) the executor reading the mark")"; printf '%s' "$msg" | grep -q "permission denied" || fail "(h) mark refusal text: $msg"

# Parked rediscovery.
rp="$(uuid a)"; jp="$(uuid a)"; op="$(uuid a)"; tp="$(uuid a)"
adm 4 'math:python-large:4' kpark "$SHA1" "$rp" "$jp" >/dev/null
out="$(depth)"
printf '%s' "$out" | grep -q '"oldest_eligible_at": *"' || fail "(h) depth with a queued job has no oldest_eligible_at: $out"
[ "$(scalar a "SELECT (public.pq_class_depth('$ENVN','large')->>'oldest_eligible_at')::timestamptz = (SELECT eligible_at FROM public.polis_queue_jobs WHERE job_id='$jp')")" = "t" ] || fail "(h) oldest_eligible_at is not the queued job's eligible_at"
[ "$(claim "$op" "$tp" 10)" = "$jp" ] || fail "(h) parking claim"
psql_su -d a -qc "UPDATE public.polis_queue_jobs SET locked_until=now()-interval '1 second' WHERE job_id='$jp'" >/dev/null
ex a "SELECT public.pq_reap('$ENVN',NULL,10,'large')" >/dev/null
[ "$(scalar a "SELECT state||'/'||last_error_code FROM public.polis_queue_jobs WHERE job_id='$jp'")" = "parked/exit_unconfirmed" ] || fail "(h) lapsed lease did not park"
out="$(ex a "SELECT public.pq_class_parked('$ENVN','large',NULL,10)")"
printf '%s' "$out" | grep -q "\"job_id\": *\"$jp\"" || fail "(h) parked read misses the parked job: $out"
printf '%s' "$out" | grep -q "\"attempt_id\": *\"$tp\"" || fail "(h) parked read misses the unproven attempt: $out"
printf '%s' "$out" | grep -q '"next_after_job_id": *null' || fail "(h) parked read paging: $out"
[ "$(ex a "SELECT jsonb_array_length(public.pq_class_parked('$ENVN','delphi',NULL,10)->'parked')")" = "0" ] || fail "(h) the delphi class sees a large parked job"
[ "$(ex a "SELECT jsonb_array_length(public.pq_class_parked('$ENVN','large','$jp'::uuid,10)->'parked')")" = "0" ] || fail "(h) paging after the last job is not empty"
[ "$(ex a "SELECT public.pq_end_attempt('$ENVN','$jp'::uuid,'$op'::uuid,'$tp'::uuid,1,'confirm_exit',NULL,true)->>'outcome'")" = "exit_confirmed" ] || fail "(h) confirm_exit of the parked attempt"
[ "$(ex a "SELECT jsonb_array_length(public.pq_class_parked('$ENVN','large',NULL,10)->'parked'->0->'unconfirmed')")" = "0" ] || fail "(h) a proven attempt is still listed as unconfirmed"
cancel "$jp"
[ "$(scalar a "SELECT state FROM public.polis_queue_jobs WHERE job_id='$jp'")" = "cancelled" ] || fail "(h) cancel of the parked job"
release 'math:python-large:4'

# Retention fixtures.
read -r jA tA < <(finish_ok 1 'math:python-large:1' kA)      # older success of product 1
read -r jB tB < <(finish_ok 1 'math:python-large:1' kB)      # newest success of product 1; the head's run
read -r jD tD < <(finish_dead 2 'math:python-large:2' kD)    # dead 91 days
read -r jC tC < <(finish_dead 2 'math:python-large:2' kC)    # dead 31 days; the head's run
read -r jE tE < <(finish_ok 3 'math:python-large:3' kE)      # older success, pinned
read -r jF tF < <(finish_ok 3 'math:python-large:3' kF)      # older success, an unproven exit
read -r jG tG < <(finish_ok 3 'math:python-large:3' kG)      # newest success of product 3
for v in jA:$tA jB:$tB jC:$tC jD:$tD jE:$tE jF:$tF jG:$tG; do need "${v%%:*}" "${v#*:}"; done
age "$jA" 31; age "$jB" 31; age "$jC" 31; age "$jD" 91; age "$jE" 31; age "$jF" 31; age "$jG" 1
psql_su -d a -qc "UPDATE public.polis_queue_attempts SET ended_at=now()-interval '8 days' WHERE job_id='$jB'" >/dev/null
psql_su -d a -qc "UPDATE public.delphi_jobs SET pinned=true WHERE job_id='$jE'" >/dev/null
psql_su -d a -qc "UPDATE public.polis_queue_attempts SET process_exit_confirmed_at=NULL WHERE job_id='$jF'" >/dev/null
# H1: an older success of product 5 whose scope guard is still held (H2 is
# a newer success of the same product under another scope).
rH="$(uuid a)"; jH="$(uuid a)"
adm 5 'hold:5a' kH "$SHA1" "$rH" "$jH" fixture-image 3 'math:python-large:5' >/dev/null
run_ok "$jH" H1 >/dev/null
rH2="$(uuid a)"; jH2="$(uuid a)"
adm 5 'hold:5b' kH2 "$SHA1" "$rH2" "$jH2" fixture-image 3 'math:python-large:5' >/dev/null
run_ok "$jH2" H2 >/dev/null
age "$jH" 31; age "$jH2" 1
# Q: an active (queued) job, its row aged.
rQ="$(uuid a)"; jQ="$(uuid a)"
adm 4 'math:python-large:4' kQ "$SHA2" "$rQ" "$jQ" >/dev/null
psql_su -d a -qc "UPDATE public.polis_queue_jobs SET updated_at=now()-interval '200 days', created_at=now()-interval '200 days' WHERE job_id='$jQ'" >/dev/null
# Bindings: one expired two days ago, one twelve hours ago.
psql_su -d a -qc "UPDATE public.polis_queue_requests SET binding_expires_at=now()-interval '2 days' WHERE request_key='kC'; UPDATE public.polis_queue_requests SET binding_expires_at=now()-interval '12 hours' WHERE request_key='kG'" >/dev/null
snapshot() { scalar a "SELECT (SELECT count(*) FROM public.polis_queue_jobs)||'/'||(SELECT count(*) FROM public.polis_queue_attempts)||'/'||(SELECT count(*) FROM public.polis_queue_logs)||'/'||(SELECT count(*) FROM public.polis_queue_requests)||'/'||(SELECT count(*) FROM public.polis_queue_runs)"; }
before="$(snapshot)"

# The mark, as the owner sees it.
reached="$(scalar a "SELECT string_agg(reason, ',' ORDER BY reason) FROM public.pq_retention_reached('$ENVN') r WHERE r.job_id IN ('$jE','$jF','$jH','$jQ','$jB','$jC')")"
for r in pinned unproven_exit guard active head; do printf '%s' "$reached" | grep -q "$r" || fail "(h) the mark misses reason $r: $reached"; done
[ "$(scalar a "SELECT count(*) FROM public.pq_retention_reached('$ENVN') WHERE job_id IN ('$jA','$jD')")" = "0" ] || fail "(h) A or D is reached"

# Page order is enforced.
s1="$(uuid a)"
msg="$(ex_refused a "SELECT public.pq_sweep('$ENVN','$s1'::uuid,2,10)" "(h) page 2 first")"; printf '%s' "$msg" | grep -q "sweep sequence" || fail "(h) out-of-order page refusal text: $msg"
msg="$(ex_refused a "SELECT public.pq_sweep('$ENVN','$s1'::uuid,11,10)" "(h) page over budget")"; printf '%s' "$msg" | grep -q "invalid sweep page" || fail "(h) page bound text: $msg"

# Sweep 1, as shipped: a dry run. It says what it would delete; nothing changes.
out="$(ex a "SELECT public.pq_sweep('$ENVN','$s1'::uuid,1,10)")"
[ "$(outcome_of "$out")" = "sweep_done" ] || fail "(h) dry run outcome: $out"
for kv in would_job_succeeded:1 would_job_dead:1 would_job_cancelled:0 would_logs_succeeded:3 would_logs_failed:2 would_binding:1 would_purge:0 \
          jobs_deleted:0 log_rows_deleted:0 bindings_deleted:0 jobs_tombstoned:0 logs_tombstoned:0; do
  [ "$(count_in "$out" "${kv%%:*}")" = "${kv#*:}" ] || fail "(h) dry run ${kv%%:*} is $(count_in "$out" "${kv%%:*}"), want ${kv#*:}: $out"
done
[ "$(snapshot)" = "$before" ] || fail "(h) the dry run changed rows: $(snapshot) vs $before"
[ "$(tombs job)$(tombs logs)$(tombs binding)" = "000" ] || fail "(h) the dry run tombstoned"
[ "$(ex a "SELECT public.pq_queue_usage('$ENVN')->>'last_sweep_finished_at' IS NOT NULL")" = "t" ] || fail "(h) usage does not see the finished dry run"
out="$(sweep)"; [ "$(outcome_of "$out")" = "not_due" ] || fail "(h) a second sweep inside 24 hours: $out"

# A policy change is an UPDATE, not a migration: deletion on for every kind.
policy_all delete
next_day
out="$(sweep)"
[ "$(outcome_of "$out")" = "sweep_done" ] || fail "(h) sweep 2: $out"
for kv in jobs_tombstoned:2 logs_tombstoned:5 bindings_tombstoned:1 jobs_deleted:0 log_rows_deleted:0 bindings_deleted:0; do
  [ "$(count_in "$out" "${kv%%:*}")" = "${kv#*:}" ] || fail "(h) sweep 2 ${kv%%:*} is $(count_in "$out" "${kv%%:*}"), want ${kv#*:}: $out"
done
[ "$(snapshot)" = "$before" ] || fail "(h) tombstoning deleted rows"
[ "$(scalar a "SELECT string_agg(ref, ',' ORDER BY ref) FROM public.polis_queue_tombstones WHERE kind='job'")" = "$(printf '%s\n%s\n' "$jA" "$jD" | sort | paste -sd, -)" ] || fail "(h) the tombstoned jobs are not A and D"

# Restore: pinning A reaches it again; widening job_dead's keep_days keeps D.
psql_su -d a -qc "UPDATE public.delphi_jobs SET pinned=true WHERE job_id='$jA'; UPDATE public.polis_queue_retention_policy SET keep_days=120 WHERE kind='job_dead'" >/dev/null
next_day; past_grace
out="$(sweep)"
[ "$(outcome_of "$out")" = "sweep_done" ] || fail "(h) sweep 3: $out"
[ "$(count_in "$out" tombstones_restored)" = "3" ] || fail "(h) sweep 3 restored $(count_in "$out" tombstones_restored), want 3 (A's job, A's logs, D's job): $out"
[ "$(count_in "$out" jobs_deleted)" = "0" ] || fail "(h) sweep 3 deleted a job: $out"
[ "$(exists_job "$jA")" = "1" ] || fail "(h) the pinned (restored) A went"
[ "$(logs_of "$tA")" = "stdout,manifest" ] || fail "(h) the pinned A's logs: $(logs_of "$tA")"
[ "$(exists_job "$jD")" = "1" ] || fail "(h) D went although job_dead now keeps 120 days"
[ "$(logs_of "$tD")" = "-" ] || fail "(h) D's 91-day failed output survived its tombstone: $(logs_of "$tD")"
[ "$(logs_of "$tB")" = "manifest" ] || fail "(h) B's logs after 8 days: $(logs_of "$tB") (want the manifest only)"
[ "$(logs_of "$tC")" = "-" ] || fail "(h) the 31-day failed attempt's logs survived: $(logs_of "$tC")"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_requests WHERE request_key='kC'")" = "0" ] || fail "(h) the binding expired two days ago survived"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_requests WHERE request_key='kG'")" = "1" ] || fail "(h) the binding expired twelve hours ago went"
[ "$(scalar a "SELECT rows_purged>0 FROM public.polis_queue_retention_install")" = "t" ] || fail "(h) rows_purged did not count the purge"

# Unpin A and E, put job_dead back to 90 days: one cycle tombstones, the next purges.
psql_su -d a -qc "UPDATE public.delphi_jobs SET pinned=false WHERE job_id IN ('$jA','$jE'); UPDATE public.polis_queue_retention_policy SET keep_days=90 WHERE kind='job_dead'" >/dev/null
next_day
out="$(sweep)"; [ "$(count_in "$out" jobs_tombstoned)" = "3" ] || fail "(h) sweep 4 tombstoned $(count_in "$out" jobs_tombstoned) jobs, want 3 (A, D, E): $out"
next_day; past_grace
out="$(sweep)"
[ "$(count_in "$out" jobs_deleted)" = "3" ] || fail "(h) sweep 5 deleted $(count_in "$out" jobs_deleted) jobs, want 3: $out"
for j in "$jA" "$jD" "$jE"; do [ "$(exists_job "$j")" = "0" ] || fail "(h) $j survived its purge"; done
[ "$(scalar a "SELECT count(*) FROM public.delphi_jobs WHERE job_id='$jA'")" = "0" ] || fail "(h) A's logical row survived"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_attempts WHERE job_id='$jA'")" = "0" ] || fail "(h) A's attempts survived"
[ "$(logs_of "$tA")" = "-" ] || fail "(h) A's logs survived"
for v in "B:$jB" "C:$jC" "F:$jF" "G:$jG" "H1:$jH" "H2:$jH2" "Q:$jQ"; do
  [ "$(exists_job "${v#*:}")" = "1" ] || fail "(h) ${v%%:*} went (it is reached or kept by policy)"
done
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_tombstones")" = "0" ] || fail "(h) tombstones left after the purge"
# Busy and abandoned.
next_day
s2="$(uuid a)"
psql_su -d a -qc "INSERT INTO public.polis_queue_sweeps(env,sweep_id) VALUES('$ENVN','$s2')" >/dev/null
out="$(sweep)"; [ "$(outcome_of "$out")" = "busy" ] || fail "(h) a sweep during another: $out"
psql_su -d a -qc "UPDATE public.polis_queue_sweeps SET started_at=now()-interval '2 hours' WHERE sweep_id='$s2'" >/dev/null
out="$(sweep)"; [ "$(outcome_of "$out")" = "sweep_done" ] || fail "(h) the sweep after an abandoned one: $out"
[ "$(scalar a "SELECT stopped_by FROM public.polis_queue_sweeps WHERE sweep_id='$s2'")" = "abandoned" ] || fail "(h) the stale sweep was not closed as abandoned"
pass "(h) depth /4, parked, usage; dry run deletes nothing; policy UPDATE turns deletion on; tombstone -> restore (pin, keep_days) -> purge after the grace; reached rows kept"

# ------------------------------------------------------------------ (r)
echo "== (r) reachability through inputs =="
createdb r
apply_upto r 000026
D=r
psql_su -d r -c "INSERT INTO public.conversations(zid,topic) VALUES (6,'fixture six')" >/dev/null
policy_all delete
read -r jP _ < <(finish_ok 6 'math:python-large:6' kP)      # the input, superseded below
read -r jP2 _ < <(finish_ok 6 'math:python-large:6' kP2)    # newer success of the input's product
# The consumer, pinned: its input edge is recorded while it is queued.
jN="$(uuid r)"
out="$(adm 6 'cons:6' kN "$SHA1" "$(uuid r)" "$jN")"; [ "$(outcome_of "$out")" = "enqueued" ] || fail "(r) consumer admission: $out"
psql_su -d r -qc "INSERT INTO public.delphi_job_inputs(zid,consumer_job_id,input_role,ordinal,producer_job_id,producer_output_digest) SELECT 6,'$jN'::uuid,'math',0,'$jP'::uuid,output_manifest_digest FROM public.delphi_jobs WHERE job_id='$jP'" >/dev/null
run_ok "$jN" consumer >/dev/null; release 'cons:6'
psql_su -d r -qc "UPDATE public.delphi_jobs SET pinned=true WHERE job_id='$jN'" >/dev/null
read -r jN2 _ < <(finish_ok 6 'cons:6' kN2)                 # newer success of the consumer's product
age "$jP" 40; age "$jN" 35; age "$jP2" 1; age "$jN2" 1
[ "$(scalar r "SELECT string_agg(reason, ',') FROM public.pq_retention_reached('$ENVN') WHERE job_id='$jP'")" = "input" ] || fail "(r) the pinned job's input is not reached as an input"
sweep >/dev/null; next_day; past_grace; sweep >/dev/null
[ "$(exists_job "$jP")$(exists_job "$jN")" = "11" ] || fail "(r) the pinned consumer or its input went"
[ "$(tombs job)" = "0" ] || fail "(r) a reached job was tombstoned"
psql_su -d r -qc "UPDATE public.delphi_jobs SET pinned=false WHERE job_id='$jN'" >/dev/null
next_day; out="$(sweep)"; [ "$(count_in "$out" jobs_tombstoned)" = "1" ] || fail "(r) only the consumer is deletable first: $out"
next_day; past_grace; sweep >/dev/null; [ "$(exists_job "$jN")" = "0" ] || fail "(r) the unpinned consumer survived"
[ "$(exists_job "$jP")" = "1" ] || fail "(r) the input was purged in the same cycle as its consumer"
[ "$(scalar r "SELECT count(*) FROM public.polis_queue_tombstones WHERE kind='job' AND ref='$jP'")" = "1" ] || fail "(r) the input was not tombstoned in the cycle its consumer went"
next_day; past_grace; sweep >/dev/null; [ "$(exists_job "$jP")" = "0" ] || fail "(r) the unreferenced input survived"
[ "$(exists_job "$jP2")$(exists_job "$jN2")" = "11" ] || fail "(r) a newest success went"
pass "(r) a pinned job's inputs are reached and survive; unpinned, the consumer goes, then its input"

# ------------------------------------------------------------------ (k)
echo "== (k) the dead-job breaker =="
createdb k
apply_upto k 000026
D=k
psql_su -d k -c "INSERT INTO public.conversations(zid,topic) VALUES (7,'fixture seven'),(8,'fixture eight'),(9,'fixture nine')" >/dev/null
S7='math:python-large:7'
read -r d1 _ < <(finish_dead 7 "$S7" k1 img-1)
read -r d2 _ < <(finish_dead 7 "$S7" k2 img-1)
[ "$(breaker 7)" = "2|false|-" ] || fail "(k) after two deaths: $(breaker 7)"
read -r d3 _ < <(finish_dead 7 "$S7" k3 img-1)
[ "$(breaker 7)" = "3|true|-" ] || fail "(k) after three deaths: $(breaker 7)"
out="$(adm 7 "$S7" k4 "$SHA1" "$(uuid k)" "$(uuid k)" img-1 1)"
[ "$(outcome_of "$out")" = "poisoned" ] || fail "(k) admission with the breaker open: $out"
[ "$(job_of "$out")" = "$d3" ] || fail "(k) poisoned names $(job_of "$out"), not the latest dead job $d3"
# Sweeps with deletion on: the counted dead jobs are reached and stay.
policy_all delete
age "$d1" 91; age "$d2" 91; age "$d3" 91
sweep >/dev/null; next_day; past_grace; sweep >/dev/null
[ "$(scalar k "SELECT count(*) FROM public.polis_queue_jobs WHERE job_id IN ('$d1','$d2','$d3')")" = "3" ] || fail "(k) the sweep deleted dead jobs the breaker counts"
[ "$(tombs job)" = "0" ] || fail "(k) the sweep tombstoned dead jobs of an open breaker"
[ "$(breaker 7)" = "3|true|-" ] || fail "(k) the breaker after the sweep: $(breaker 7)"
out="$(adm 7 "$S7" k5 "$SHA1" "$(uuid k)" "$(uuid k)" img-1 1)"
[ "$(outcome_of "$out")" = "poisoned" ] || fail "(k) admission after the sweep: $out"
# 24 hours later: half-open, one probe.
clock24() { psql_su -d k -qc "UPDATE public.polis_queue_breakers SET opened_at=opened_at-interval '24 hours 1 minute' WHERE zid=$1" >/dev/null; }
clock24 7
pj="$(uuid k)"
out="$(adm 7 "$S7" k6 "$SHA1" "$(uuid k)" "$pj" img-1 1)"
[ "$(outcome_of "$out")" = "enqueued" ] || fail "(k) the probe after 24 hours: $out"
[ "$(breaker 7)" = "3|true|$pj" ] || fail "(k) the probe is not recorded: $(breaker 7)"
out="$(adm 7 'other:7' k7 "$SHA1" "$(uuid k)" "$(uuid k)" img-1 1 "$S7")"
[ "$(outcome_of "$out")" = "poisoned" ] || fail "(k) a second admission while the probe runs: $out"
# The probe dies: open again for 24 hours.
run_dead "$pj" probe >/dev/null; release "$S7"
[ "$(breaker 7)" = "4|true|-" ] || fail "(k) after the probe died: $(breaker 7)"
[ "$(scalar k "SELECT opened_at>now()-interval '1 minute' FROM public.polis_queue_breakers WHERE zid=7")" = "t" ] || fail "(k) the probe's death did not re-open the breaker for 24 hours"
out="$(adm 7 "$S7" k8 "$SHA1" "$(uuid k)" "$(uuid k)" img-1 1)"
[ "$(outcome_of "$out")" = "poisoned" ] || fail "(k) admission after the probe died: $out"
# 24 hours later again: the probe succeeds and closes it.
clock24 7
pj2="$(uuid k)"
out="$(adm 7 "$S7" k9 "$SHA1" "$(uuid k)" "$pj2" img-1 1)"
[ "$(outcome_of "$out")" = "enqueued" ] || fail "(k) the second probe: $out"
run_ok "$pj2" probe2 >/dev/null; release "$S7"
[ "$(breaker 7)" = "0|false|-" ] || fail "(k) after the probe succeeded: $(breaker 7)"
j10="$(uuid k)"
out="$(adm 7 "$S7" k10 "$SHA1" "$(uuid k)" "$j10" img-1 1)"
[ "$(outcome_of "$out")" = "enqueued" ] || fail "(k) admission with the breaker closed: $out"
cancel "$j10"; release "$S7"
# Closed, the old dead jobs are ordinary history: the next cycles take them.
next_day; sweep >/dev/null; next_day; past_grace; sweep >/dev/null
[ "$(scalar k "SELECT count(*) FROM public.polis_queue_jobs WHERE job_id IN ('$d1','$d2','$d3')")" = "0" ] || fail "(k) dead jobs of a closed breaker were kept"
# A new image resets an open breaker.
S8='math:python-large:8'
for n in 1 2 3; do finish_dead 8 "$S8" "e$n" img-1 >/dev/null; done
[ "$(breaker 8)" = "3|true|-" ] || fail "(k) zid 8 after three deaths: $(breaker 8)"
j8="$(uuid k)"
out="$(adm 8 "$S8" e4 "$SHA1" "$(uuid k)" "$j8" img-2 1)"
[ "$(outcome_of "$out")" = "enqueued" ] || fail "(k) a new image with the breaker open: $out"
[ "$(breaker 8)" = "0|false|-" ] || fail "(k) the new image did not reset: $(breaker 8)"
[ "$(scalar k "SELECT code_image_digest FROM public.polis_queue_breakers WHERE zid=8")" = "img-2" ] || fail "(k) the breaker does not name the new image"
cancel "$j8"; release "$S8"
# A cancelled probe frees the slot; the breaker stays half-open.
S9='math:python-large:9'
for n in 1 2 3; do finish_dead 9 "$S9" "c$n" img-1 >/dev/null; done
clock24 9
cj="$(uuid k)"
out="$(adm 9 "$S9" c4 "$SHA1" "$(uuid k)" "$cj" img-1 1)"
[ "$(outcome_of "$out")" = "enqueued" ] || fail "(k) zid 9 probe: $out"
cancel "$cj"; release "$S9"
[ "$(breaker 9)" = "3|true|-" ] || fail "(k) after the probe was cancelled: $(breaker 9)"
out="$(adm 9 "$S9" c5 "$SHA1" "$(uuid k)" "$(uuid k)" img-1 1)"
[ "$(outcome_of "$out")" = "enqueued" ] || fail "(k) the next probe after a cancelled one: $out"
pass "(k) three deaths open; poisoned names the latest; sweeps keep its dead jobs; 24 h -> one probe; probe death re-opens; probe success closes; new image resets; cancelled probe frees the slot"

# ------------------------------------------------------------------ (s)
echo "== (s) the breaker is seeded from 000024-era history =="
createdb s
apply_upto s 000024
D=s
psql_su -d s -c "INSERT INTO public.conversations(zid,topic) VALUES (7,'fixture seven')" >/dev/null
for n in 1 2 3; do read -r sd _ < <(finish_dead 7 "$S7" "s$n" img-1); done
out="$(adm 7 "$S7" s4 "$SHA1" "$(uuid s)" "$(uuid s)" img-1 1)"
[ "$(outcome_of "$out")" = "poisoned" ] || fail "(s) 000024's latch: $out"
apply_one s "$UP25"
apply_one s "$UP"
[ "$(breaker 7)" = "3|true|-" ] || fail "(s) the seeded breaker: $(breaker 7)"
[ "$(scalar s "SELECT last_dead_job_id FROM public.polis_queue_breakers WHERE zid=7")" = "$sd" ] || fail "(s) the seed does not name the latest dead job"
out="$(adm 7 "$S7" s5 "$SHA1" "$(uuid s)" "$(uuid s)" img-1 1)"
[ "$(outcome_of "$out")" = "poisoned" ] || fail "(s) admission over the seeded breaker: $out"
pass "(s) three 000024-era deaths seed an open breaker at apply"

# ------------------------------------------------------------------ (f)
echo "== (f) after a purge the down is refused; nothing changes =="
dump_schema a > "$WORK/a.f.before"
msg="$(refuse_one a "$DOWN")"
printf '%s' "$msg" | grep -q "refusing reversal: a sweep has purged" || fail "(f) down refused for another reason: $msg"
dump_schema a > "$WORK/a.f.after"
same "(f) a refused down changed the catalog" "$WORK/a.f.before" "$WORK/a.f.after"
pass "(f) down refused after a purge; nothing changed"

# ------------------------------------------------------------------ (d)
echo "== (d) after a dry run and tombstones (no purge) the down restores the catalog =="
createdb d
apply_upto d 000025
dump_schema d > "$WORK/d.before"
apply_one d "$UP"
dump_schema d > "$WORK/d.after"
D=d
psql_su -d d -c "INSERT INTO public.conversations(zid,topic) VALUES (1,'fixture')" >/dev/null
read -r dA _ < <(finish_ok 1 'math:python-large:1' dA)
finish_ok 1 'math:python-large:1' dB >/dev/null
age "$dA" 31
out="$(sweep)"; [ "$(count_in "$out" would_job_succeeded)" = "1" ] || fail "(d) dry run: $out"
policy_all delete; next_day
out="$(sweep)"; [ "$(count_in "$out" jobs_tombstoned)" = "1" ] || fail "(d) tombstone: $out"
rows="$(scalar d "SELECT count(*) FROM public.polis_queue_jobs")"
apply_one d "$DOWN"
dump_schema d > "$WORK/d.down"
same "(d) catalog after down differs from before 000026" "$WORK/d.before" "$WORK/d.down"
[ "$(scalar d "SELECT count(*) FROM public.polis_queue_jobs")" = "$rows" ] || fail "(d) a tombstoned row did not survive the down"
[ "$(scalar d "SELECT count(*) FROM public.schema_migrations WHERE name='000026_create_polis_queue_retention'")" = "0" ] || fail "(d) 000026's ledger row survived the down"
[ "$(roles)" = "$(cat "$WORK/roles.before")" ] || fail "(d) the role set changed"
[ "$(scalar d "SELECT public.pq_class_depth('x','large')->>'schema_version'")" = "polis-queue/3" ] || fail "(d) the /3 depth reply is not back"
pass "(d) down after dry run + tombstones: schema identical to before 000026, tombstoned rows kept, ledger row gone, roles unchanged"

# ------------------------------------------------------------------ (e)
echo "== (e) apply again after the down =="
createdb e
apply_upto e 000025
dump_schema e > "$WORK/e.before"
apply_one e "$UP"; dump_schema e > "$WORK/e.up1"
apply_one e "$DOWN"; dump_schema e > "$WORK/e.down1"
apply_one e "$UP"; dump_schema e > "$WORK/e.up2"
apply_one e "$DOWN"; dump_schema e > "$WORK/e.down2"
same "(e) the first down differs from before 000026" "$WORK/e.before" "$WORK/e.down1"
same "(e) re-apply after down differs from the first apply" "$WORK/e.up1" "$WORK/e.up2"
same "(e) second down differs from before 000026" "$WORK/e.before" "$WORK/e.down2"
same "(e) the apply differs from (a)'s" "$WORK/a.after" "$WORK/e.up1"
pass "(e) apply -> down -> apply -> down: both states reproduce byte for byte"

# ------------------------------------------------------------------ (g)
echo "== (g) down without 000026; 000026 without 000024; 000026 without 000025 =="
createdb g
apply_upto g 000025
dump_schema g > "$WORK/g.before"
msg="$(refuse_one g "$DOWN")"
printf '%s' "$msg" | grep -q "the ledger does not record 000026" || fail "(g) down without 000026 refused for another reason: $msg"
dump_schema g > "$WORK/g.after"
same "(g) the failed down changed a database without 000026" "$WORK/g.before" "$WORK/g.after"
createdb g2
apply_upto g2 000023
apply_one g2 "$UP25"
dump_schema g2 > "$WORK/g2.before"
msg="$(refuse_one g2 "$UP")"
printf '%s' "$msg" | grep -q "large class missing" || fail "(g) 000026 without 000024 refused for another reason: $msg"
dump_schema g2 > "$WORK/g2.after"
same "(g) the refused 000026 changed a database without 000024" "$WORK/g2.before" "$WORK/g2.after"
createdb g3
apply_upto g3 000024
dump_schema g3 > "$WORK/g3.before"
msg="$(refuse_one g3 "$UP")"
printf '%s' "$msg" | grep -q "migration ledger missing" || fail "(g) 000026 without 000025 refused for another reason: $msg"
dump_schema g3 > "$WORK/g3.after"
same "(g) the refused 000026 changed a database without 000025" "$WORK/g3.before" "$WORK/g3.after"
pass "(g) down without 000026, 000026 without 000024 and without 000025 fail before changing anything"

# ------------------------------------------------------------------ (l)
echo "== (l) the down order: 000026 first =="
createdb l
apply_upto l 000026
dump_schema l > "$WORK/l.26"
msg="$(refuse_one l "$DOWN25")"
printf '%s' "$msg" | grep -q "the ledger records later migrations (000026_create_polis_queue_retention)" || fail "(l) 000025's down over 000026 refused for another reason: $msg"
msg="$(refuse_one l "$DOWN24")"
printf '%s' "$msg" | grep -q "large class catalog drift" || fail "(l) 000024's down over 000026 refused for another reason: $msg"
dump_schema l > "$WORK/l.26b"
same "(l) a refused down changed the catalog" "$WORK/l.26" "$WORK/l.26b"
apply_one l "$DOWN"
apply_one l "$DOWN25"
[ "$(scalar l "SELECT to_regclass('public.schema_migrations') IS NULL")" = "t" ] || fail "(l) 000025's down did not run after 000026's"
pass "(l) over 000026 the downs of 000025 and 000024 refuse; 000026's down, then 000025's"

# ------------------------------------------------------------------ (i)
echo "== (i) the full chain, one file at a time, up / down / up byte for byte =="
STEPS="000019 000021 000022 000023 000024 000025 000026"
REV="000026 000025 000024 000023 000022 000021 000019"
down_of() {
  case "$1" in
    000019) echo down/000019_drop_polis_queue.sql;; 000021) echo down/000021_drop_polis_coordinator.sql;;
    000022) echo down/000022_drop_poll_timestamp_indexes.sql;; 000023) echo "$DOWN23";; 000024) echo "$DOWN24";;
    000025) echo "$DOWN25";; 000026) echo "$DOWN";;
  esac
}
up_of() { (cd "$MIGRATIONS_DIR" && ls "$1"_*.sql); }
prev_of() { echo "000018 $STEPS" | tr ' ' '\n' | grep -B1 "^$1\$" | head -1; }
createdb i
apply_upto i 000018
dump_schema i > "$WORK/i.000018"
for n in $STEPS; do apply_one i "$(up_of "$n")"; dump_schema i > "$WORK/i.$n"; done
for n in $REV; do
  apply_one i "$(down_of "$n")"
  dump_schema i > "$WORK/i.$n.down"
  same "(i) after $n's down the schema differs from before its up ($(prev_of "$n"))" "$WORK/i.$(prev_of "$n")" "$WORK/i.$n.down"
done
for n in $STEPS; do
  apply_one i "$(up_of "$n")"; dump_schema i > "$WORK/i.$n.again"
  same "(i) $n's second up differs from its first" "$WORK/i.$n" "$WORK/i.$n.again"
done
pass "(i) 000019 -> 000021 -> 000022 -> 000023 -> 000024 -> 000025 -> 000026: every down restores the previous dump, every re-up reproduces its dump"

# ------------------------------------------------------------------ (w)
echo "== (w) the apply wrapper: 000026 =="
WRAP="$MIGRATIONS_DIR/../bin/apply-migration.sh"
wrap() { local db="$1" num="$2"; shift 2; bash "$WRAP" --free-bytes 12000000000 "$@" "$num" -- docker exec -i "$CONTAINER" psql -U postgres -d "$db"; }
wrap_rc() { # db num expected_rc label [options]
  local db="$1" num="$2" want="$3" label="$4" out rc; shift 4
  set +e; out="$(wrap "$db" "$num" "$@" 2>&1)"; rc=$?; set -e
  [ "$rc" -eq "$want" ] || fail "$label: exit $rc, expected $want: $out"
  printf '%s' "$out"
}
createdb w0
apply_upto w0 000023
apply_one w0 "$UP25"
dump_schema w0 > "$WORK/w0.before"
out="$(wrap_rc w0 000026 4 "(w) chain to 000023")"
grep -q '^FAIL  chain: 000024 is not installed' <<<"$out" || fail "(w) chain to 000023 refused for another reason: $out"
dump_schema w0 > "$WORK/w0.after"
same "(w) the refused wrapper changed a database without 000024" "$WORK/w0.before" "$WORK/w0.after"
createdb w1
apply_upto w1 000024
out="$(wrap_rc w1 000026 4 "(w) chain without 000025")"
grep -q '^FAIL  chain: 000025 is not applied' <<<"$out" || fail "(w) chain without 000025 refused for another reason: $out"
createdb w
apply_upto w 000025
D=w
psql_su -d w -c "INSERT INTO public.conversations(zid,topic) VALUES (1,'fixture'),(2,'fixture two')" >/dev/null
for n in 1 2 3; do finish_dead 1 'math:python-large:1' "w$n" img-1 >/dev/null; done
out="$(adm 2 'math:python-large:2' kw "$SHA1" "$(uuid w)" "$(uuid w)" img-1 3)"
[ "$(outcome_of "$out")" = "enqueued" ] || fail "(w) rebuild enqueue: $out"
dump_schema w > "$WORK/w.before"
out="$(wrap_rc w 000026 0 "(w) preflight only" --preflight-only)"
grep -q '^ok    seal: ledger self-checksum ' <<<"$out" || fail "(w) no ledger seal line: $out"
grep -qE '^ok    seal: [0-9a-f]{64}$' <<<"$out" || fail "(w) no seal line: $out"
grep -q '^ok    chain: 000024 is installed (polis-queue/3) and the ledger records 000025_vote_convention' <<<"$out" || fail "(w) the chain was not recognised: $out"
grep -q '^ok    rows: queue rows present (.*polis_queue_jobs=4' <<<"$out" || fail "(w) the queue rows were not reported: $out"
dump_schema w > "$WORK/w.after_preflight"
same "(w) --preflight-only changed the catalog" "$WORK/w.before" "$WORK/w.after_preflight"
out="$(wrap_rc w 000026 0 "(w) apply")"
grep -q '^applied: 000026_create_polis_queue_retention.sql (post-check 1 install, 1 ledger, polis-queue/3)' <<<"$out" || fail "(w) no post-check line: $out"
grep -q 'none on public.conversations' <<<"$out" || fail "(w) the lock line does not describe 000026: $out"
grep -q '^breaker: 1 scopes seeded, 1 open' <<<"$out" || fail "(w) the breaker seed line: $out"
[ "$(scalar w "SELECT count(*) FROM public.polis_queue_jobs")" = "4" ] || fail "(w) the queue rows did not survive the apply"
out="$(wrap_rc w 000026 4 "(w) second run")"
grep -q '^FAIL  chain: 000026 is already installed' <<<"$out" || fail "(w) the second run was refused for another reason: $out"
pass "(w) wrapper: refused without 000024 and without 000025; reports rows; applies with post-check install+ledger+/3; seeds the breaker; second run refused"

# ------------------------------------------------------------------ (p)
echo "== (p) the populated chain through the wrapper, each step's lock, then every down =="
createdb p
apply_upto p 000018
psql_su -d p -qc "INSERT INTO public.conversations(zid,topic) SELECT g,'populated '||g FROM generate_series(1,40) g; INSERT INTO votes (zid,pid,tid,vote) SELECT 1+(g%40),g%97,g%13,(g%3)-1 FROM generate_series(1,2000) g" >/dev/null
data() { scalar p "SELECT md5(coalesce((SELECT string_agg(zid||':'||topic,',' ORDER BY zid) FROM public.conversations),'')||'|'||coalesce((SELECT string_agg(zid||':'||pid||':'||tid||':'||vote,',' ORDER BY zid,pid,tid,vote) FROM public.votes),''))"; }
DATA0="$(data)"
dump_schema p > "$WORK/p.000018"
holder() { # sql -> held in the background for 10 s; its pid in HOLDER
  printf 'BEGIN; %s; SELECT pg_sleep(10); COMMIT;\n' "$1" | docker exec -i "$CONTAINER" psql -X -q -U postgres -d p >/dev/null 2>&1 &
  HOLDER=$!
}
holding() { scalar p "SELECT count(*) FROM pg_stat_activity WHERE datname='p' AND query LIKE '%pg_sleep(10)%' AND state='active' AND pid<>pg_backend_pid()"; }
await_holder() {
  local _
  for _ in $(seq 1 100); do [ "$(holding)" = "1" ] && return 0; sleep 0.1; done
  fail "(p) the lock holder did not start"
}
step() { # num blocker_sql free(0/1)
  local n="$1" blocker="$2" free="$3" pid t0 waited out
  dump_schema p > "$WORK/p.pre.$n"
  holder "$blocker"; pid=$HOLDER; await_holder
  t0=$SECONDS
  out="$(wrap_rc p "$n" 5 "(p) $n behind its lock holder")"
  waited=$((SECONDS - t0))
  wait "$pid" || true
  grep -q "FAILED: .* did not apply" <<<"$out" || fail "(p) $n's failure line: $out"
  grep -qE "lock_timeout|lock timeout|canceling statement|55P03" <<<"$out" || fail "(p) $n did not fail on the lock budget: $out"
  { [ "$waited" -ge 4 ] && [ "$waited" -le 12 ]; } || fail "(p) $n rolled back after ${waited}s (want the 5 s budget)"
  dump_schema p > "$WORK/p.post.$n"
  same "(p) $n's timed-out apply changed the schema" "$WORK/p.pre.$n" "$WORK/p.post.$n"
  echo "     $n waited ${waited}s behind [$blocker] and rolled back; schema unchanged"
  if [ "$free" = 1 ]; then
    holder "UPDATE public.conversations SET topic=topic WHERE zid=1"; pid=$HOLDER; await_holder
    wrap_rc p "$n" 0 "(p) $n beside a conversations writer" >/dev/null
    [ "$(holding)" = "1" ] || fail "(p) $n waited for the conversations writer"
    wait "$pid" || true
    echo "     $n applied while a writer held a conversations row"
  else
    wrap_rc p "$n" 0 "(p) $n after its holder" >/dev/null
  fi
  [ "$(data)" = "$DATA0" ] || fail "(p) $n changed conversations or votes"
  dump_schema p > "$WORK/p.$n"
}
step 000019 "UPDATE public.conversations SET topic=topic WHERE zid=1" 0
apply_one p 000021_create_polis_coordinator.sql; dump_schema p > "$WORK/p.000021"
apply_one p 000022_add_poll_timestamp_indexes.sql; dump_schema p > "$WORK/p.000022"
step 000023 "UPDATE public.conversations SET topic=topic WHERE zid=1" 0
step 000024 "LOCK TABLE public.polis_queue_jobs IN ROW EXCLUSIVE MODE" 1
step 000025 "LOCK TABLE public.votes IN ACCESS EXCLUSIVE MODE" 1
step 000026 "LOCK TABLE public.polis_queue_jobs IN ROW EXCLUSIVE MODE" 1
[ "$(scalar p "SELECT string_agg(name, ',' ORDER BY name) FROM public.schema_migrations WHERE length(checksum)=64")" = "000025_vote_convention,000026_create_polis_queue_retention" ] || fail "(p) the ledger does not record 000025 and 000026"
for n in $REV; do
  apply_one p "$(down_of "$n")"
  dump_schema p > "$WORK/p.$n.down"
  same "(p) after $n's down the populated schema differs from before its up ($(prev_of "$n"))" "$WORK/p.$(prev_of "$n")" "$WORK/p.$n.down"
  [ "$(data)" = "$DATA0" ] || fail "(p) $n's down changed conversations or votes"
done
pass "(p) populated: each wrapper step waits behind its lock holder and times out with nothing applied; 000024-000026 apply beside a conversations writer; data unchanged; every down restores the previous dump"

echo "ALL CHECKS PASSED (seal, a-h, r, k, s, f, d, e, g, l, i, w, p)"
