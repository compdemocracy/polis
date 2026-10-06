#!/usr/bin/env bash
#
# Acceptance test for 000026_create_polis_queue_retention.sql (queue retention
# and restart-safe reads) and its reversal
# down/000026_drop_polis_queue_retention.sql.
#
# It stands up a throwaway `postgres:17` (docker run, removed on exit; port in
# 56080-56089), applies the REAL migration chain with psql -f exactly as
# initdb does (000025 is not in this tree's chain unless it is present), and
# checks:
#
#   (seal) both files match down/000026-files.sha256.
#   (a) chain to 000024, then 000026: contract_version still polis-queue/3;
#       the sweep ledger and the install row exist, owned by
#       polis_queue_owner; the three indexes exist with their predicates;
#       pq_class_parked, pq_queue_usage and pq_sweep are granted to the
#       executor by exact signature and to nobody else; no queue table or
#       function is granted to PUBLIC; every job table is still empty.
#   (b) a second apply is REFUSED and changes nothing.
#   (c) replaying 000019, 000023 or 000024 over it is REFUSED by their own
#       guards and changes nothing.
#   (h) behaviour, as the executor: the depth reply is polis-queue/4 with
#       oldest_eligible_at (null without a claimable job, the job's
#       eligible_at with one); a lease that lapses parks the job and
#       pq_class_parked lists it with its unproven attempt, which leaves the
#       list once its exit is proven; pq_queue_usage reports bytes and no
#       sweep; pq_sweep applies P-083's bounds exactly (an older succeeded job
#       of a product goes, the latest stays; a succeeded attempt's output goes
#       after 7 days, a failed one's after 30, the manifest row stays; dead
#       stays 90 days; pinned, a held guard, an unproven exit and an active
#       job stay; a binding goes one day after it expired); a second sweep
#       inside 24 hours is not_due; an unfinished sweep makes another busy and
#       is closed as abandoned after an hour; pages must follow in order.
#   (f) sweep ledger rows present: the down is REFUSED and everything
#       survives; once they are deleted it runs.
#   (d) the down restores the catalog: the schema dump after it is identical
#       to the dump taken before 000026, and the role set is unchanged.
#   (e) apply -> down -> apply -> down: both states reproduce byte for byte.
#   (g) the down on a database without 000026 fails before changing anything;
#       000026 on a database without 000024 is refused ("large class
#       missing") and changes nothing.
#   (i) the chain unwinds: 000024's down refuses over /4; 000026 down, 000024
#       down and 000023 down give the dump taken before 000023.
#
# Usage:  bash server/postgres/migrations/down/test_000026_down.sh
# Exit 0 iff every check passes.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/.." && pwd)"          # server/postgres/migrations
UP="000026_create_polis_queue_retention.sql"
DOWN="down/000026_drop_polis_queue_retention.sql"
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
apply_one() { psql_su -d "$1" -f "/mig/$2" >/dev/null; }
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

JOB_TABLES="delphi_jobs delphi_job_aliases delphi_job_inputs delphi_current delphi_job_guards delphi_provider_requests polis_queue_logs polis_queue_jobs polis_queue_runs polis_queue_attempts polis_queue_requests polis_queue_heads polis_queue_sweeps"
NEW_RPCS="pq_class_parked(text,text,uuid,integer) pq_queue_usage(text) pq_sweep(text,uuid,integer,integer)"
SHA1="$(printf '%064d' 1)"
SHA2="$(printf '%064d' 2)"

# ------------------------------------------------------------------ (a)
echo "== (a) chain to 000024, then 000026 =="
createdb a
apply_upto a 000024
dump_schema a > "$WORK/a.before"
roles > "$WORK/roles.before"
apply_one a "$UP"
[ "$(scalar a "SELECT contract_version FROM public.polis_queue_install")" = "polis-queue/3" ] || fail "(a) contract_version moved"
for t in $JOB_TABLES; do
  [ "$(scalar a "SELECT count(*) FROM public.$t")" = "0" ] || fail "(a) $t is not empty"
done
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_retention_install")" = "1" ] || fail "(a) install baseline row missing"
for t in polis_queue_retention_install polis_queue_sweeps; do
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
for f in $NEW_RPCS; do
  [ "$(scalar a "SELECT has_function_privilege('polis_queue_executor','public.$f','EXECUTE')")" = "t" ] || fail "(a) $f not granted to the executor"
  [ "$(scalar a "SELECT prosecdef AND pg_get_userbyid(proowner)='polis_queue_owner' FROM pg_proc WHERE oid='public.$f'::regprocedure")" = "t" ] || fail "(a) $f is not SECURITY DEFINER owned by polis_queue_owner"
done
[ "$(scalar a "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'pq\\_%' OR p.proname LIKE 'pd\\_%') AND x.grantee=0")" = "0" ] || fail "(a) a queue function is granted to PUBLIC"
[ "$(scalar a "SELECT count(*) FROM pg_class c, aclexplode(c.relacl) x WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (c.relname LIKE 'delphi\\_%' OR c.relname LIKE 'polis\\_queue\\_%') AND x.grantee=0")" = "0" ] || fail "(a) a queue table is granted to PUBLIC"
[ "$(scalar a "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'pq\\_%'")" = "32" ] || fail "(a) expected 32 pq_ functions (29 at /3 + three)"
dump_schema a > "$WORK/a.after"
pass "(a) applied: contract unchanged, ledger, three indexes, three executor reads/writes, nothing to PUBLIC"

# ------------------------------------------------------------------ (b)
echo "== (b) second apply refused, nothing changes =="
msg="$(refuse_one a "$UP")"
printf '%s' "$msg" | grep -q -E "retention object collision|queue catalog drift" || fail "(b) second apply refused for another reason: $msg"
dump_schema a > "$WORK/a.after2"
cmp -s "$WORK/a.after" "$WORK/a.after2" || fail "(b) a refused second apply changed the catalog"
pass "(b) second apply refused; catalog unchanged"

# ------------------------------------------------------------------ (c)
echo "== (c) 000019, 000023 and 000024 replays refused =="
msg="$(refuse_one a 000019_create_polis_queue.sql)"
printf '%s' "$msg" | grep -q "queue catalog drift" || fail "(c) 000019 replay refused for another reason: $msg"
msg="$(refuse_one a "$UP23")"
printf '%s' "$msg" | grep -q -E "queue catalog drift|foundation object collision" || fail "(c) 000023 replay refused for another reason: $msg"
msg="$(refuse_one a "$UP24")"
printf '%s' "$msg" | grep -q -E "queue catalog drift|large class object collision" || fail "(c) 000024 replay refused for another reason: $msg"
dump_schema a > "$WORK/a.after3"
cmp -s "$WORK/a.after" "$WORK/a.after3" || fail "(c) a refused replay changed the catalog"
pass "(c) replays refused; nothing reverted"

# ------------------------------------------------------------------ (h)
echo "== (h) behaviour as the executor =="
psql_su -d a -c "INSERT INTO public.conversations(zid,topic) VALUES (1,'fixture'),(2,'fixture two'),(3,'fixture three'),(4,'fixture four')" >/dev/null
adm() { # db zid scope key sha run job image max_attempts product (default: the scope)
  ex "$1" "SELECT public.pd_enqueue('$ENVN',$2,'${10:-$3}','poller','$4','$5','$6'::uuid,'$7'::uuid,'public-fixture-input','$SHA1','$SHA1','${8:-fixture-image}',1::smallint,${9:-3},'math_rebuild',NULL,'$3','{\"need_bytes\":1}'::jsonb)"
}
need() { [ -n "$2" ] || fail "(h) fixture $1 was not made"; }
manifest() { # job attempt
  echo "{\"schema\":\"polis-jobs.output-manifest/1\",\"job_id\":\"$1\",\"attempt_id\":\"$2\",\"stage\":\"math_rebuild\",\"phase\":\"run\",\"outcome\":\"succeeded\",\"inputs\":{\"math_env\":\"python-large\",\"math_tick\":7,\"vote_hwm\":12},\"outputs\":[],\"models\":{},\"cost\":{}}"
}
claim() { ex "$1" "SELECT public.pq_claim('$ENVN',1::smallint,'$2'::uuid,'$3'::uuid,${4:-60},'large')->>'job_id'"; }
depth() { ex a "SELECT public.pq_class_depth('$ENVN','large')"; }
# A finished rebuild: admit, claim, a stdout line and the manifest row, exit
# proof, finalize, release. Prints the job id and attempt id.
finish_ok() { # zid scope key
  local r j o t m msha out
  r="$(uuid a)"; j="$(uuid a)"; o="$(uuid a)"; t="$(uuid a)"
  out="$(adm a "$1" "$2" "$3" "$SHA1" "$r" "$j")"
  printf '%s' "$out" | grep -q '"outcome": *"enqueued"' || fail "(h) admission $3: $out"
  [ "$(claim a "$o" "$t")" = "$j" ] || fail "(h) claim $3"
  m="$(manifest "$j" "$t")"
  ex a "INSERT INTO public.polis_queue_logs(env,attempt_id,seq,stream,line) VALUES('$ENVN','$t'::uuid,0,'stdout','public fixture line'),('$ENVN','$t'::uuid,1,'manifest','$m')" >/dev/null
  msha="$(scalar a "SELECT encode(sha256(convert_to(line,'UTF8')),'hex') FROM public.polis_queue_logs WHERE attempt_id='$t' AND stream='manifest'")"
  [ "$(ex a "SELECT public.pq_end_attempt('$ENVN','$j'::uuid,'$o'::uuid,'$t'::uuid,1,'confirm_exit',NULL,true)->>'outcome'")" = "exit_confirmed" ] || fail "(h) confirm_exit $3"
  [ "$(ex a "SELECT public.pq_finalize('$ENVN','$j'::uuid,'$o'::uuid,'$t'::uuid,1,'file:///work/output-manifest.json','$msha')->>'outcome'")" = "succeeded" ] || fail "(h) finalize $3"
  [ "$(ex a "SELECT public.pd_release_scope('$ENVN','$2')")" = "t" ] || fail "(h) release $3"
  echo "$j $t"
}
# A dead rebuild: one attempt, a permanent failure with exit proof, a stderr line.
finish_dead() { # zid scope key
  local r j o t out
  r="$(uuid a)"; j="$(uuid a)"; o="$(uuid a)"; t="$(uuid a)"
  out="$(adm a "$1" "$2" "$3" "$SHA1" "$r" "$j" fixture-image 1)"
  printf '%s' "$out" | grep -q '"outcome": *"enqueued"' || fail "(h) admission $3: $out"
  [ "$(claim a "$o" "$t")" = "$j" ] || fail "(h) claim $3"
  ex a "INSERT INTO public.polis_queue_logs(env,attempt_id,seq,stream,line) VALUES('$ENVN','$t'::uuid,0,'stderr','public fixture failure')" >/dev/null
  [ "$(ex a "SELECT public.pq_fail('$ENVN','$j'::uuid,'$o'::uuid,'$t'::uuid,1,true,'stage_failed:1',true)->>'state'")" = "dead" ] || fail "(h) death $3"
  [ "$(ex a "SELECT public.pd_release_scope('$ENVN','$2')")" = "t" ] || fail "(h) release $3"
  echo "$j $t"
}
age() { # job days (the job's last change and its attempts' end)
  psql_su -d a -qc "UPDATE public.polis_queue_jobs SET updated_at=now()-interval '$2 days' WHERE job_id='$1'; UPDATE public.polis_queue_attempts SET ended_at=now()-interval '$2 days' WHERE job_id='$1'" >/dev/null
}
logs_of() { scalar a "SELECT COALESCE(string_agg(stream,',' ORDER BY seq),'-') FROM public.polis_queue_logs WHERE attempt_id='$1'"; }
exists_job() { scalar a "SELECT count(*) FROM public.polis_queue_jobs WHERE job_id='$1'"; }

# Depth: oldest_eligible_at is null with nothing claimable.
out="$(depth)"
printf '%s' "$out" | grep -q '"schema_version": *"polis-queue/4"' || fail "(h) depth version: $out"
printf '%s' "$out" | grep -q '"oldest_eligible_at": *null' || fail "(h) empty depth oldest_eligible_at: $out"
# Usage: bytes, no sweep yet.
out="$(ex a "SELECT public.pq_queue_usage('$ENVN')")"
printf '%s' "$out" | grep -q '"last_sweep_finished_at": *null' || fail "(h) usage before any sweep: $out"
[ "$(ex a "SELECT (public.pq_queue_usage('$ENVN')->>'queue_bytes')::bigint > 0")" = "t" ] || fail "(h) queue_bytes not positive"
ex_refused a "SELECT public.pq_queue_usage('')" "(h) usage without an env" | grep -q "invalid usage read" || fail "(h) usage refusal text"
ex_refused a "SELECT public.pq_class_parked('$ENVN','noop',NULL,10)" "(h) parked of class noop" | grep -q "invalid parked read" || fail "(h) parked refusal text"
ex_refused a "SELECT public.pq_class_parked('$ENVN','large',NULL,101)" "(h) parked page over 100" | grep -q "invalid parked read" || fail "(h) parked bound text"

# Parked rediscovery: a lapsed lease parks the job; the read lists its
# unproven attempt; exit proof takes it off the list.
rp="$(uuid a)"; jp="$(uuid a)"; op="$(uuid a)"; tp="$(uuid a)"
adm a 4 'math:python-large:4' kpark "$SHA1" "$rp" "$jp" >/dev/null
out="$(depth)"
printf '%s' "$out" | grep -q '"oldest_eligible_at": *"' || fail "(h) depth with a queued job has no oldest_eligible_at: $out"
[ "$(scalar a "SELECT (public.pq_class_depth('$ENVN','large')->>'oldest_eligible_at')::timestamptz = (SELECT eligible_at FROM public.polis_queue_jobs WHERE job_id='$jp')")" = "t" ] || fail "(h) oldest_eligible_at is not the queued job's eligible_at"
[ "$(claim a "$op" "$tp" 10)" = "$jp" ] || fail "(h) parking claim"
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
ex a "SELECT public.pq_cancel('$ENVN','$jp'::uuid,(public.pq_job_status('$ENVN','$jp'::uuid)->>'mgmt_version')::bigint)" >/dev/null
[ "$(scalar a "SELECT state FROM public.polis_queue_jobs WHERE job_id='$jp'")" = "cancelled" ] || fail "(h) cancel of the parked job"
ex a "SELECT public.pd_release_scope('$ENVN','math:python-large:4')" >/dev/null

# Retention fixtures.
read -r jA tA < <(finish_ok 1 'math:python-large:1' kA)      # older success of product 1: goes
read -r jB tB < <(finish_ok 1 'math:python-large:1' kB)      # latest success of product 1: stays
read -r jD tD < <(finish_dead 2 'math:python-large:2' kD)    # dead 91 days: goes
read -r jC tC < <(finish_dead 2 'math:python-large:2' kC)    # dead 31 days: stays (90); the head's run
read -r jE tE < <(finish_ok 3 'math:python-large:3' kE)      # older success, pinned: stays
read -r jF tF < <(finish_ok 3 'math:python-large:3' kF)      # latest success of product 3
read -r jG tG < <(finish_ok 3 'math:python-large:3' kG)      # newest; F becomes older
for v in jA:$tA jB:$tB jC:$tC jD:$tD jE:$tE jF:$tF jG:$tG; do need "${v%%:*}" "${v#*:}"; done
age "$jA" 31; age "$jB" 31; age "$jC" 31; age "$jD" 91; age "$jE" 31; age "$jF" 31; age "$jG" 1
# B: a fresh success of product 1 changes nothing for A (A is older); age B's
# attempt only 8 days so its output goes (7) and the job stays (latest).
psql_su -d a -qc "UPDATE public.polis_queue_attempts SET ended_at=now()-interval '8 days' WHERE job_id='$jB'" >/dev/null
psql_su -d a -qc "UPDATE public.delphi_jobs SET pinned=true WHERE job_id='$jE'" >/dev/null
# F: an attempt without exit proof keeps it.
psql_su -d a -qc "UPDATE public.polis_queue_attempts SET process_exit_confirmed_at=NULL WHERE job_id='$jF'" >/dev/null
# H1: an older success of product 5 whose scope guard is still held stays
# (H2, a newer success of the same product under another scope, would
# otherwise make it deletable).
psql_su -d a -qc "INSERT INTO public.conversations(zid,topic) VALUES (5,'fixture five')" >/dev/null
rH="$(uuid a)"; jH="$(uuid a)"; oH="$(uuid a)"; tH="$(uuid a)"
adm a 5 'hold:5a' kH "$SHA1" "$rH" "$jH" fixture-image 3 'math:python-large:5' >/dev/null
[ "$(claim a "$oH" "$tH")" = "$jH" ] || fail "(h) claim H1"
ex a "SELECT public.pq_end_attempt('$ENVN','$jH'::uuid,'$oH'::uuid,'$tH'::uuid,1,'confirm_exit',NULL,true)" >/dev/null
mH="$(manifest "$jH" "$tH")"
ex a "INSERT INTO public.polis_queue_logs(env,attempt_id,seq,stream,line) VALUES('$ENVN','$tH'::uuid,0,'manifest','$mH')" >/dev/null
shaH="$(scalar a "SELECT encode(sha256(convert_to(line,'UTF8')),'hex') FROM public.polis_queue_logs WHERE attempt_id='$tH'")"
[ "$(ex a "SELECT public.pq_finalize('$ENVN','$jH'::uuid,'$oH'::uuid,'$tH'::uuid,1,'file:///work/output-manifest.json','$shaH')->>'outcome'")" = "succeeded" ] || fail "(h) finalize H1"
rH2="$(uuid a)"; jH2="$(uuid a)"; oH2="$(uuid a)"; tH2="$(uuid a)"
adm a 5 'hold:5b' kH2 "$SHA1" "$rH2" "$jH2" fixture-image 3 'math:python-large:5' >/dev/null
[ "$(claim a "$oH2" "$tH2")" = "$jH2" ] || fail "(h) claim H2"
ex a "SELECT public.pq_end_attempt('$ENVN','$jH2'::uuid,'$oH2'::uuid,'$tH2'::uuid,1,'confirm_exit',NULL,true)" >/dev/null
mH2="$(manifest "$jH2" "$tH2")"
ex a "INSERT INTO public.polis_queue_logs(env,attempt_id,seq,stream,line) VALUES('$ENVN','$tH2'::uuid,0,'manifest','$mH2')" >/dev/null
shaH2="$(scalar a "SELECT encode(sha256(convert_to(line,'UTF8')),'hex') FROM public.polis_queue_logs WHERE attempt_id='$tH2'")"
[ "$(ex a "SELECT public.pq_finalize('$ENVN','$jH2'::uuid,'$oH2'::uuid,'$tH2'::uuid,1,'file:///work/output-manifest.json','$shaH2')->>'outcome'")" = "succeeded" ] || fail "(h) finalize H2"
age "$jH" 31; age "$jH2" 1
# Q: an active (queued) job, its row aged: never touched.
rQ="$(uuid a)"; jQ="$(uuid a)"
adm a 4 'math:python-large:4' kQ "$SHA2" "$rQ" "$jQ" >/dev/null
psql_su -d a -qc "UPDATE public.polis_queue_jobs SET updated_at=now()-interval '200 days', created_at=now()-interval '200 days' WHERE job_id='$jQ'" >/dev/null
# Bindings: one expired two days ago (goes), one expired twelve hours ago (stays).
psql_su -d a -qc "UPDATE public.polis_queue_requests SET binding_expires_at=now()-interval '2 days' WHERE request_key='kC'; UPDATE public.polis_queue_requests SET binding_expires_at=now()-interval '12 hours' WHERE request_key='kG'" >/dev/null
before_jobs="$(scalar a "SELECT count(*) FROM public.polis_queue_jobs")"

# The sweep: page order is enforced; one page does it all here.
s1="$(uuid a)"
ex_refused a "SELECT public.pq_sweep('$ENVN','$s1'::uuid,2,10)" "(h) page 2 first" | grep -q "sweep sequence" || fail "(h) out-of-order page refusal text"
ex_refused a "SELECT public.pq_sweep('$ENVN','$s1'::uuid,11,10)" "(h) page over budget" | grep -q "invalid sweep page" || fail "(h) page bound text"
out="$(ex a "SELECT public.pq_sweep('$ENVN','$s1'::uuid,1,10)")"
printf '%s' "$out" | grep -q '"outcome": *"sweep_done"' || fail "(h) sweep outcome: $out"
printf '%s' "$out" | grep -q '"stopped_by": *""' || fail "(h) sweep stopped_by: $out"
[ "$(exists_job "$jA")" = "0" ] || fail "(h) the older success of product 1 survived"
[ "$(scalar a "SELECT count(*) FROM public.delphi_jobs WHERE job_id='$jA'")" = "0" ] || fail "(h) A's logical row survived"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_attempts WHERE job_id='$jA'")" = "0" ] || fail "(h) A's attempts survived"
[ "$(logs_of "$tA")" = "-" ] || fail "(h) A's logs survived"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_runs r JOIN public.delphi_jobs d USING (env,run_id) WHERE d.job_id='$jB'")" = "1" ] || fail "(h) B's run went"
[ "$(exists_job "$jB")" = "1" ] || fail "(h) the latest success of product 1 went"
[ "$(logs_of "$tB")" = "manifest" ] || fail "(h) B's logs after 8 days: $(logs_of "$tB") (want the manifest only)"
[ "$(exists_job "$jC")" = "1" ] || fail "(h) a 31-day dead job went"
[ "$(logs_of "$tC")" = "-" ] || fail "(h) the 31-day failed attempt's logs survived: $(logs_of "$tC")"
[ "$(exists_job "$jD")" = "0" ] || fail "(h) a 91-day dead job survived"
[ "$(exists_job "$jE")" = "1" ] || fail "(h) a pinned job went"
[ "$(exists_job "$jF")" = "1" ] || fail "(h) a job with an unproven exit went"
[ "$(exists_job "$jG")" = "1" ] || fail "(h) the newest success went"
[ "$(exists_job "$jH")" = "1" ] || fail "(h) the root of a held guard went"
[ "$(exists_job "$jH2")" = "1" ] || fail "(h) the newest success of product 5 went"
[ "$(exists_job "$jQ")" = "1" ] || fail "(h) an active job went"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_requests WHERE request_key='kC'")" = "0" ] || fail "(h) the binding expired two days ago survived"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_requests WHERE request_key='kG'")" = "1" ] || fail "(h) the binding expired twelve hours ago went"
after_jobs="$(scalar a "SELECT count(*) FROM public.polis_queue_jobs")"
[ "$((before_jobs - after_jobs))" = "2" ] || fail "(h) the sweep deleted $((before_jobs - after_jobs)) jobs, want 2 (A and D)"
printf '%s' "$out" | grep -q '"jobs_deleted": *2' || fail "(h) jobs_deleted in the reply: $out"
[ "$(scalar a "SELECT pages||'/'||stopped_by||'/'||(counts->>'jobs_deleted') FROM public.polis_queue_sweeps WHERE sweep_id='$s1'")" = "1//2" ] || fail "(h) ledger row"
[ "$(ex a "SELECT public.pq_queue_usage('$ENVN')->>'last_sweep_finished_at' IS NOT NULL")" = "t" ] || fail "(h) usage does not see the finished sweep"
# Unpinning E lets the next sweep take it; first it is not due.
psql_su -d a -qc "UPDATE public.delphi_jobs SET pinned=false WHERE job_id='$jE'" >/dev/null
out="$(ex a "SELECT public.pq_sweep('$ENVN',gen_random_uuid(),1,10)")"
printf '%s' "$out" | grep -q '"outcome": *"not_due"' || fail "(h) a second sweep inside 24 hours: $out"
psql_su -d a -qc "UPDATE public.polis_queue_sweeps SET started_at=started_at-interval '25 hours', finished_at=finished_at-interval '25 hours'" >/dev/null
# An unfinished sweep makes another busy; after an hour it is abandoned.
s2="$(uuid a)"
psql_su -d a -qc "INSERT INTO public.polis_queue_sweeps(env,sweep_id) VALUES('$ENVN','$s2')" >/dev/null
out="$(ex a "SELECT public.pq_sweep('$ENVN',gen_random_uuid(),1,10)")"
printf '%s' "$out" | grep -q '"outcome": *"busy"' || fail "(h) a sweep during another: $out"
psql_su -d a -qc "UPDATE public.polis_queue_sweeps SET started_at=now()-interval '2 hours' WHERE sweep_id='$s2'" >/dev/null
out="$(ex a "SELECT public.pq_sweep('$ENVN',gen_random_uuid(),1,10)")"
printf '%s' "$out" | grep -q '"outcome": *"sweep_done"' || fail "(h) the sweep after an abandoned one: $out"
[ "$(scalar a "SELECT stopped_by FROM public.polis_queue_sweeps WHERE sweep_id='$s2'")" = "abandoned" ] || fail "(h) the stale sweep was not closed as abandoned"
[ "$(exists_job "$jE")" = "0" ] || fail "(h) the unpinned older success survived"
[ "$(exists_job "$jF")" = "1" ] || fail "(h) F (unproven exit) went on the second sweep"
pass "(h) depth /4, parked rediscovery, usage, and the sweep's bounds, cadence, busy/abandoned and page order"

# ------------------------------------------------------------------ (f)
echo "== (f) sweep ledger rows: down refused, everything survives =="
msg="$(refuse_one a "$DOWN")"
printf '%s' "$msg" | grep -q "refusing reversal: sweep ledger rows" || fail "(f) down refused for another reason: $msg"
for t in polis_queue_sweeps polis_queue_retention_install; do
  [ "$(scalar a "SELECT to_regclass('public.$t')::text")" = "$t" ] || fail "(f) $t did not survive a refused down"
done
psql_su -d a -c "DELETE FROM public.polis_queue_sweeps; DELETE FROM public.delphi_job_guards; DELETE FROM public.polis_queue_logs; DELETE FROM public.delphi_jobs; DELETE FROM public.polis_queue_requests; DELETE FROM public.polis_queue_attempts; DELETE FROM public.polis_queue_jobs; DELETE FROM public.polis_queue_heads; DELETE FROM public.polis_queue_runs; DELETE FROM public.conversations WHERE zid IN (1,2,3,4,5)" >/dev/null
pass "(f) down refused with ledger rows; everything survived"

# ------------------------------------------------------------------ (d)
echo "== (d) down restores the catalog =="
apply_one a "$DOWN"
dump_schema a > "$WORK/a.down"
if ! cmp -s "$WORK/a.before" "$WORK/a.down"; then
  diff "$WORK/a.before" "$WORK/a.down" | head -40 >&2
  fail "(d) catalog after down differs from before 000026"
fi
[ "$(roles)" = "$(cat "$WORK/roles.before")" ] || fail "(d) the role set changed"
[ "$(scalar a "SELECT public.pq_class_depth('x','large')->>'schema_version'")" = "polis-queue/3" ] || fail "(d) the /3 depth reply is not back"
pass "(d) down: schema dump identical to before 000026; roles unchanged; /3 depth reply back"

# ------------------------------------------------------------------ (e)
echo "== (e) apply again after the down =="
apply_one a "$UP"
dump_schema a > "$WORK/a.again"
cmp -s "$WORK/a.after" "$WORK/a.again" || fail "(e) re-apply after down differs from the first apply"
apply_one a "$DOWN"
dump_schema a > "$WORK/a.down2"
cmp -s "$WORK/a.before" "$WORK/a.down2" || fail "(e) second down differs from before 000026"
pass "(e) apply -> down -> apply -> down: both states reproduce byte for byte"

# ------------------------------------------------------------------ (g)
echo "== (g) down without 000026; 000026 without 000024 =="
createdb g
apply_upto g 000024
dump_schema g > "$WORK/g.before"
refuse_one g "$DOWN" >/dev/null
dump_schema g > "$WORK/g.after"
cmp -s "$WORK/g.before" "$WORK/g.after" || fail "(g) the failed down changed a database without 000026"
createdb g2
apply_upto g2 000023
dump_schema g2 > "$WORK/g2.before"
msg="$(refuse_one g2 "$UP")"
printf '%s' "$msg" | grep -q "large class missing" || fail "(g) 000026 without 000024 refused for another reason: $msg"
dump_schema g2 > "$WORK/g2.after"
cmp -s "$WORK/g2.before" "$WORK/g2.after" || fail "(g) the refused 000026 changed a database without 000024"
pass "(g) down without 000026 and 000026 without 000024 fail before changing anything"

# ------------------------------------------------------------------ (i)
echo "== (i) the chain unwinds: 000026, 000024, 000023 downs =="
createdb i
apply_upto i 000022
dump_schema i > "$WORK/i.before23"
apply_one i "$UP23"
apply_one i "$UP24"
apply_one i "$UP"
msg="$(refuse_one i "$DOWN24")"
printf '%s' "$msg" | grep -q "large class catalog drift" || fail "(i) 000024's down over /4 refused for another reason: $msg"
apply_one i "$DOWN"
apply_one i "$DOWN24"
apply_one i "$DOWN23"
dump_schema i > "$WORK/i.after"
cmp -s "$WORK/i.before23" "$WORK/i.after" || fail "(i) after three downs the catalog differs from before 000023"
pass "(i) 000024's down refuses over /4; the three downs unwind to the dump before 000023"

echo "ALL CHECKS PASSED (seal, a-i)"
