#!/usr/bin/env bash
#
# Acceptance test for 000024_create_polis_queue_large_class.sql (the large
# worker class, polis-queue/3) and its reversal
# down/000024_drop_polis_queue_large_class.sql.
#
# A written, TESTED down script is a precondition for applying a migration to
# production; this is the test. It stands up a throwaway `postgres:17` (docker
# run, removed on exit; port in 56070-56079), applies the REAL migration chain
# with psql -f exactly as initdb does, and checks:
#
#   (seal) both files match down/000024-files.sha256.
#   (a) chain 000000..000023, then 000024: polis_queue_install reads
#       polis-queue/3; no new job table; every job table is still empty; the
#       stage CHECK admits exactly noop, the two Delphi stages and
#       math_rebuild; the worker_class CHECK admits exactly noop, delphi and
#       large; pq_stage_large binds the two; delphi_jobs.kind admits
#       math_rebuild; the /2 RPCs and the new pq_class_depth are granted to
#       polis_queue_executor by exact signature, the /1 internals that share a
#       name are not, and nothing is granted to PUBLIC.
#   (b) a second apply is REFUSED ("queue catalog drift") and changes nothing.
#   (c) replaying 000019 or 000023 over the /3 schema is REFUSED by their own
#       guards and changes nothing.
#   (h) behaviour, as the executor: a math_rebuild admission is enqueued as
#       class large, kind math_rebuild, run polis-queue/3; a second admission
#       of the same scope returns the existing job (same digest) or conflict
#       (different digest); a report id on a rebuild is refused; a Delphi
#       admission still works unchanged (class delphi, run /2); pq_class_depth
#       counts per class and refuses other classes; a delphi worker's claim
#       never sees the rebuild and a large worker's claim never sees the
#       Delphi job; a claim or reap with another class is refused; the rebuild
#       completes through exit proof, a manifest row and pq_finalize, its
#       scope releases and can be admitted again; pd_job_view names the scope
#       an active root job holds and null once released; three dead jobs of
#       one scope under one image make a fourth admission `poisoned` (no job,
#       no guard) and a new image admits again; the noop /1 path still runs.
#   (f) /3 data present (a queued rebuild): the down is REFUSED and every
#       object survives; once the rows are deleted it runs.
#   (d) the down restores the catalog: the schema dump after it is identical
#       to the dump taken before 000024 was applied, and the role set is
#       unchanged.
#   (e) apply -> down -> apply -> down: both states reproduce byte for byte.
#   (g) the down on a database that never had 000024 (chain to 000023) and on
#       one without 000023 (chain to 000022) fails before changing anything.
#   (i) after 000024's down, 000023's own down still unwinds the chain to the
#       dump taken before 000023.
#
# Shell rather than a jest or pytest because the checks are schema-diff shaped
# (pg_dump of a full migration chain in an isolated cluster). Needs only docker.
#
# Usage:  bash server/postgres/migrations/down/test_000024_down.sh
# Exit 0 iff every check passes.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/.." && pwd)"          # server/postgres/migrations
UP="000024_create_polis_queue_large_class.sql"
DOWN="down/000024_drop_polis_queue_large_class.sql"
UP23="000023_create_delphi_foundation.sql"
DOWN23="down/000023_drop_delphi_foundation.sql"
CONTAINER="pg000024-test-$$"
PW="test"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pg000024.XXXXXX")"
ENVN="test-000024"

PORT=""
for p in $(seq 56070 56079); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT="$p"; break; fi
  exec 3>&- 2>/dev/null || true
done
[ -n "$PORT" ] || { echo "FAIL: no free port in 56070-56079"; exit 1; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }

echo "== seal =="
(cd "$MIGRATIONS_DIR" && shasum -a 256 -c down/000024-files.sha256) || fail "seal: a migration file differs from down/000024-files.sha256"

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
# A statement as the executor login, scalar reply.
ex() { psql_su -d "$1" -qAt -c "SET ROLE polis_queue_executor; $2"; }
# A statement as the executor that must be refused; prints the error text.
ex_refused() {
  local out
  if out="$(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$1" -qAt -c "SET ROLE polis_queue_executor; $2" 2>&1)"; then
    fail "$3: accepted ($out); expected refusal"
  fi
  printf '%s' "$out"
}
constraint() { scalar "$1" "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.$2'::regclass AND conname='$3'"; }

JOB_TABLES="delphi_jobs delphi_job_aliases delphi_job_inputs delphi_current delphi_job_guards delphi_provider_requests polis_queue_logs"
RPCS="pd_enqueue(text,integer,text,text,text,text,uuid,uuid,text,text,text,text,smallint,integer,text,text,text,jsonb)
pd_release_scope(text,text)
pd_job_view(text,uuid)
pd_provider_intent(text,uuid,uuid,uuid,bigint,uuid,text,bytea)
pd_provider_update(text,uuid,uuid,uuid,bigint,uuid,text,text)
pq_attempt_logs(text,uuid,bigint,integer)
pq_claim(text,smallint,uuid,uuid,integer,text)
pq_end_attempt(text,uuid,uuid,uuid,bigint,text,text,boolean,timestamptz)
pq_reap(text,uuid,integer,text)
pq_class_depth(text,text)"
NOT_RPCS="pq_reap(text,uuid,integer) pq_end_attempt(text,uuid,uuid,uuid,bigint,text,text)"
SHA1="$(printf '%064d' 1)"
SHA2="$(printf '%064d' 2)"

# ------------------------------------------------------------------ (a)
echo "== (a) chain 000000..000023, then 000024 =="
createdb a
apply_upto a 000023
dump_schema a > "$WORK/a.before"
roles > "$WORK/roles.before"
apply_one a "$UP"
[ "$(scalar a "SELECT contract_version FROM public.polis_queue_install")" = "polis-queue/3" ] || fail "(a) contract_version is not polis-queue/3"
[ "$(scalar a "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND (relname LIKE 'delphi\\_%' OR relname LIKE 'polis\\_queue\\_%')")" = "15" ] || fail "(a) unexpected queue/job table count (expected 14 + the install table)"
for t in $JOB_TABLES; do
  [ "$(scalar a "SELECT count(*) FROM public.$t")" = "0" ] || fail "(a) $t is not empty"
done
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_large_class_install")" = "1" ] || fail "(a) install baseline row missing"
[ "$(scalar a "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.polis_queue_large_class_install'::regclass")" = "polis_queue_owner" ] || fail "(a) install table not owned by polis_queue_owner"
want="CHECK ((stage = ANY (ARRAY['noop'::text, 'delphi_full_pipeline'::text, 'delphi_narrative'::text, 'math_rebuild'::text])))"
got="$(constraint a polis_queue_jobs polis_queue_jobs_stage_check)"
[ "$got" = "$want" ] || fail "(a) stage CHECK is: $got"
want="CHECK ((worker_class = ANY (ARRAY['noop'::text, 'delphi'::text, 'large'::text])))"
got="$(constraint a polis_queue_jobs polis_queue_jobs_worker_class_check)"
[ "$got" = "$want" ] || fail "(a) worker_class CHECK is: $got"
want="CHECK (((stage = 'math_rebuild'::text) = (worker_class = 'large'::text)))"
got="$(constraint a polis_queue_jobs pq_stage_large)"
[ "$got" = "$want" ] || fail "(a) pq_stage_large is: $got"
got="$(constraint a delphi_jobs delphi_jobs_kind_check)"
printf '%s' "$got" | grep -q "'math_rebuild'::text" || fail "(a) delphi_jobs.kind does not admit math_rebuild: $got"
want="CHECK ((contract_version = ANY (ARRAY['polis-queue/1'::text, 'polis-queue/2'::text, 'polis-queue/3'::text])))"
got="$(constraint a polis_queue_runs polis_queue_runs_contract_version_check)"
[ "$got" = "$want" ] || fail "(a) runs contract CHECK is: $got"
for f in $RPCS; do
  [ "$(scalar a "SELECT has_function_privilege('polis_queue_executor','public.$f','EXECUTE')")" = "t" ] || fail "(a) $f not granted to the executor"
done
for f in $NOT_RPCS; do
  [ "$(scalar a "SELECT has_function_privilege('polis_queue_executor','public.$f','EXECUTE')")" = "f" ] || fail "(a) $f is granted to the executor"
done
[ "$(scalar a "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'pq\\_%' OR p.proname LIKE 'pd\\_%') AND x.grantee=0")" = "0" ] || fail "(a) a queue function is granted to PUBLIC"
[ "$(scalar a "SELECT count(*) FROM pg_class c, aclexplode(c.relacl) x WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (c.relname LIKE 'delphi\\_%' OR c.relname LIKE 'polis\\_queue\\_%') AND x.grantee=0")" = "0" ] || fail "(a) a queue table is granted to PUBLIC"
[ "$(scalar a "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'pq\\_%'")" = "29" ] || fail "(a) expected 29 pq_ functions (21 /1 + 7 /2 + pq_class_depth)"
dump_schema a > "$WORK/a.after"
pass "(a) applied: contract /3, no new job table, CHECKs, executor grants, pq_class_depth"

# ------------------------------------------------------------------ (b)
echo "== (b) second apply refused, nothing changes =="
msg="$(refuse_one a "$UP")"
printf '%s' "$msg" | grep -q -E "queue catalog drift|large class object collision" || fail "(b) second apply refused for another reason: $msg"
dump_schema a > "$WORK/a.after2"
cmp -s "$WORK/a.after" "$WORK/a.after2" || fail "(b) a refused second apply changed the catalog"
pass "(b) second apply refused; catalog unchanged"

# ------------------------------------------------------------------ (c)
echo "== (c) 000019 and 000023 replays over /3 refused by their own guards =="
msg="$(refuse_one a 000019_create_polis_queue.sql)"
printf '%s' "$msg" | grep -q "queue catalog drift" || fail "(c) 000019 replay refused for another reason: $msg"
msg="$(refuse_one a "$UP23")"
printf '%s' "$msg" | grep -q -E "queue catalog drift|foundation object collision" || fail "(c) 000023 replay refused for another reason: $msg"
dump_schema a > "$WORK/a.after3"
cmp -s "$WORK/a.after" "$WORK/a.after3" || fail "(c) a refused replay changed the catalog"
pass "(c) 000019 and 000023 replays refused; nothing reverted"

# ------------------------------------------------------------------ (h)
echo "== (h) behaviour as the executor =="
psql_su -d a -c "INSERT INTO public.conversations(zid,topic) VALUES (1,'fixture'),(2,'fixture two')" >/dev/null
r1="$(scalar a "SELECT gen_random_uuid()")"; j1="$(scalar a "SELECT gen_random_uuid()")"
r2="$(scalar a "SELECT gen_random_uuid()")"; j2="$(scalar a "SELECT gen_random_uuid()")"
r3="$(scalar a "SELECT gen_random_uuid()")"; j3="$(scalar a "SELECT gen_random_uuid()")"
rd="$(scalar a "SELECT gen_random_uuid()")"; jd="$(scalar a "SELECT gen_random_uuid()")"
adm() { # db stage zid product key sha run job report scope
  local report="$9"; [ "$report" = NULL ] || report="'$report'"
  ex "$1" "SELECT public.pd_enqueue('$ENVN',$3,'$4','poller','$5','$6','$7'::uuid,'$8'::uuid,'public-fixture-input','$SHA1','$SHA1','fixture-image',0::smallint,3,'$2',$report,'${10}','{\"need_bytes\":1}'::jsonb)"
}
out="$(adm a math_rebuild 1 'math:rebuild:1' k1 "$SHA1" "$r1" "$j1" NULL 'math:python-large:1')"
printf '%s' "$out" | grep -q '"outcome": *"enqueued"' || fail "(h) math_rebuild admission: $out"
printf '%s' "$out" | grep -q '"schema_version": *"polis-queue/3"' || fail "(h) the rebuild reply does not say polis-queue/3: $out"
[ "$(scalar a "SELECT stage||'/'||worker_class||'/'||state FROM public.polis_queue_jobs WHERE job_id='$j1'")" = "math_rebuild/large/queued" ] || fail "(h) rebuild row shape"
[ "$(scalar a "SELECT kind||'/'||status||'/'||COALESCE(report_id,'-') FROM public.delphi_jobs WHERE job_id='$j1'")" = "math_rebuild/queued/-" ] || fail "(h) rebuild delphi_jobs row"
[ "$(scalar a "SELECT contract_version FROM public.polis_queue_runs WHERE run_id='$r1'")" = "polis-queue/3" ] || fail "(h) rebuild run not stamped /3"
[ "$(scalar a "SELECT root_job_id::text FROM public.delphi_job_guards WHERE env='$ENVN' AND scope_key='math:python-large:1'")" = "$j1" ] || fail "(h) scope guard missing"
# One active job per scope: same digest -> existing (same job); other digest -> conflict.
out="$(adm a math_rebuild 1 'math:rebuild:1' k2 "$SHA1" "$r2" "$j2" NULL 'math:python-large:1')"
printf '%s' "$out" | grep -q '"outcome": *"existing"' || fail "(h) second admission of the scope: $out"
printf '%s' "$out" | grep -q "\"job_id\": *\"$j1\"" || fail "(h) existing reply names another job: $out"
out="$(adm a math_rebuild 1 'math:rebuild:1' k3 "$SHA2" "$r3" "$j3" NULL 'math:python-large:1')"
printf '%s' "$out" | grep -q '"outcome": *"conflict"' || fail "(h) conflicting admission of the scope: $out"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_jobs WHERE worker_class='large'")" = "1" ] || fail "(h) more than one large job after repeated admissions"
# A report id on a rebuild is refused; a rebuild scope bound to another zid is refused.
msg="$(ex_refused a "SELECT public.pd_enqueue('$ENVN',2,'math:rebuild:2','poller','k4','$SHA1','$r3'::uuid,'$j3'::uuid,'public-fixture-input','$SHA1','$SHA1','fixture-image',0::smallint,3,'math_rebuild','r-x','math:python-large:2','{}'::jsonb)" "(h) rebuild with a report id")"
printf '%s' "$msg" | grep -q "invalid admission" || fail "(h) report id refused for another reason: $msg"
msg="$(ex_refused a "SELECT public.pd_enqueue('$ENVN',2,'math:rebuild:1','poller','k5','$SHA1','$r3'::uuid,'$j3'::uuid,'public-fixture-input','$SHA1','$SHA1','fixture-image',0::smallint,3,'math_rebuild',NULL,'math:python-large:1','{}'::jsonb)" "(h) rebuild scope on another zid")"
printf '%s' "$msg" | grep -q "scope binding mismatch" || fail "(h) other-zid scope refused for another reason: $msg"
# The Delphi path is unchanged: class delphi, run /2.
out="$(adm a delphi_full_pipeline 2 'delphi:full:2:rd' kd "$SHA1" "$rd" "$jd" rd 'scope-delphi-2')"
printf '%s' "$out" | grep -q '"outcome": *"enqueued"' || fail "(h) Delphi admission: $out"
printf '%s' "$out" | grep -q '"schema_version": *"polis-queue/2"' || fail "(h) the Delphi reply does not say polis-queue/2: $out"
[ "$(scalar a "SELECT stage||'/'||worker_class FROM public.polis_queue_jobs WHERE job_id='$jd'")" = "delphi_full_pipeline/delphi" ] || fail "(h) Delphi row shape"
[ "$(scalar a "SELECT contract_version FROM public.polis_queue_runs WHERE run_id='$rd'")" = "polis-queue/2" ] || fail "(h) Delphi run not /2"
# Class depth, per class; other classes refused.
depth() { ex "$1" "SELECT d->>'queued'||'/'||(d->>'leased')||'/'||(d->>'parked')||'/'||(d->>'dead')||'/'||COALESCE((d->>'oldest_unresolved_created_at') IS NOT NULL,false)::text FROM public.pq_class_depth('$ENVN','$2') d"; }
[ "$(depth a large)" = "1/0/0/0/true" ] || fail "(h) large depth after admission: $(depth a large)"
[ "$(depth a delphi)" = "1/0/0/0/true" ] || fail "(h) delphi depth after admission: $(depth a delphi)"
[ "$(ex a "SELECT public.pq_class_depth('$ENVN','large')->>'schema_version'")" = "polis-queue/3" ] || fail "(h) depth schema_version"
msg="$(ex_refused a "SELECT public.pq_class_depth('$ENVN','noop')" "(h) depth of class noop")"
printf '%s' "$msg" | grep -q "invalid class depth read" || fail "(h) noop depth refused for another reason: $msg"
# Claims see only their class; other classes are refused.
own_d="$(scalar a "SELECT gen_random_uuid()")"; att_d="$(scalar a "SELECT gen_random_uuid()")"
own_l="$(scalar a "SELECT gen_random_uuid()")"; att_l="$(scalar a "SELECT gen_random_uuid()")"
out="$(ex a "SELECT public.pq_claim('$ENVN',0::smallint,'$own_d'::uuid,'$att_d'::uuid,60,'delphi')")"
printf '%s' "$out" | grep -q "\"job_id\": *\"$jd\"" || fail "(h) the delphi claim did not take the Delphi job: $out"
out="$(ex a "SELECT public.pq_claim('$ENVN',0::smallint,'$own_l'::uuid,'$att_l'::uuid,60,'delphi')")"
printf '%s' "$out" | grep -q '"outcome": *"none"' || fail "(h) a second delphi claim saw the rebuild: $out"
printf '%s' "$out" | grep -q '"schema_version": *"polis-queue/2"' || fail "(h) delphi none reply version: $out"
out="$(ex a "SELECT public.pq_claim('$ENVN',0::smallint,'$own_l'::uuid,'$att_l'::uuid,60,'large')")"
printf '%s' "$out" | grep -q "\"job_id\": *\"$j1\"" || fail "(h) the large claim did not take the rebuild: $out"
printf '%s' "$out" | grep -q '"stage": *"math_rebuild"' || fail "(h) large claim stage: $out"
out="$(ex a "SELECT public.pq_claim('$ENVN',0::smallint,'$own_l'::uuid,'$att_l'::uuid,60,'large')")"
printf '%s' "$out" | grep -q '"outcome": *"none"' || fail "(h) a second large claim found a job: $out"
printf '%s' "$out" | grep -q '"schema_version": *"polis-queue/3"' || fail "(h) large none reply version: $out"
for cls in noop other; do
  msg="$(ex_refused a "SELECT public.pq_claim('$ENVN',0::smallint,'$own_l'::uuid,'$att_l'::uuid,60,'$cls')" "(h) claim as class $cls")"
  printf '%s' "$msg" | grep -q "invalid claim" || fail "(h) class $cls claim refused for another reason: $msg"
done
[ "$(depth a large)" = "0/1/0/0/true" ] || fail "(h) large depth after claim: $(depth a large)"
[ "$(depth a delphi)" = "0/1/0/0/true" ] || fail "(h) delphi depth after claim: $(depth a delphi)"
# Reap per class; other classes refused.
out="$(ex a "SELECT public.pq_reap('$ENVN',NULL,10,'large')")"
printf '%s' "$out" | grep -q '"outcome": *"reap_page"' || fail "(h) large reap: $out"
printf '%s' "$out" | grep -q '"schema_version": *"polis-queue/3"' || fail "(h) large reap version: $out"
msg="$(ex_refused a "SELECT public.pq_reap('$ENVN',NULL,10,'noop')" "(h) reap as class noop")"
printf '%s' "$msg" | grep -q "invalid reap bound or worker class" || fail "(h) noop reap refused for another reason: $msg"
# The rebuild completes: exit proof, the manifest row, pq_finalize.
manifest="{\"schema\":\"polis-jobs.output-manifest/1\",\"job_id\":\"$j1\",\"attempt_id\":\"$att_l\",\"stage\":\"math_rebuild\",\"phase\":\"run\",\"outcome\":\"succeeded\",\"inputs\":{\"math_env\":\"python-large\",\"math_tick\":7,\"math_caching_tick\":7,\"comment_set_sha256\":null,\"vote_hwm\":12},\"outputs\":[],\"models\":{\"embed\":null,\"topic\":null,\"narrative\":null},\"cost\":{\"llm_tokens_in\":null,\"llm_tokens_out\":null,\"provider_batches\":null},\"recheck_after\":null,\"duration_ms\":1}"
ex a "INSERT INTO public.polis_queue_logs(env,attempt_id,seq,stream,line) VALUES('$ENVN','$att_l'::uuid,0,'manifest','$manifest')" >/dev/null
msha="$(scalar a "SELECT encode(sha256(convert_to(line,'UTF8')),'hex') FROM public.polis_queue_logs WHERE attempt_id='$att_l'")"
out="$(ex a "SELECT public.pq_end_attempt('$ENVN','$j1'::uuid,'$own_l'::uuid,'$att_l'::uuid,1,'confirm_exit',NULL,true)->>'outcome'")"
[ "$out" = "exit_confirmed" ] || fail "(h) rebuild confirm_exit: $out"
out="$(ex a "SELECT public.pq_finalize('$ENVN','$j1'::uuid,'$own_l'::uuid,'$att_l'::uuid,1,'file:///work/output-manifest.json','$msha')->>'outcome'")"
[ "$out" = "succeeded" ] || fail "(h) rebuild finalize: $out"
[ "$(scalar a "SELECT status||'/'||encode(output_manifest_digest,'hex') FROM public.delphi_jobs WHERE job_id='$j1'")" = "succeeded/$msha" ] || fail "(h) rebuild delphi_jobs after finalize"
[ "$(depth a large)" = "0/0/0/0/false" ] || fail "(h) large depth after finalize: $(depth a large)"
[ "$(ex a "SELECT public.pd_release_scope('$ENVN','math:python-large:1')")" = "t" ] || fail "(h) the finished rebuild's scope did not release"
out="$(adm a math_rebuild 1 'math:rebuild:1' k6 "$SHA2" "$r3" "$j3" NULL 'math:python-large:1')"
printf '%s' "$out" | grep -q '"outcome": *"enqueued"' || fail "(h) re-admission after release: $out"
[ "$(depth a large)" = "1/0/0/0/true" ] || fail "(h) large depth after re-admission: $(depth a large)"
# The job view names the scope its root job holds, and null once released.
[ "$(ex a "SELECT public.pd_job_view('$ENVN','$j3'::uuid)->>'scope_key'")" = "math:python-large:1" ] || fail "(h) pd_job_view scope_key of the active rebuild"
[ -z "$(ex a "SELECT public.pd_job_view('$ENVN','$j1'::uuid)->>'scope_key'")" ] || fail "(h) pd_job_view scope_key of the released rebuild is not null"
# The poison latch: three dead jobs of one scope under one image refuse a
# fourth admission (outcome poisoned, naming the latest dead job); a new
# image admits again. Each death: claim as large, permanent failure with exit
# proof (max_attempts 1), then the safe release.
adm1() { # db zid product key sha run job scope image
  ex "$1" "SELECT public.pd_enqueue('$ENVN',$2,'$3','poller','$4','$5','$6'::uuid,'$7'::uuid,'public-fixture-input','$SHA1','$SHA1','$9',0::smallint,1,'math_rebuild',NULL,'$8','{\"need_bytes\":1}'::jsonb)"
}
last_dead=""
for n in 1 2 3; do
  rp="$(scalar a "SELECT gen_random_uuid()")"; jp="$(scalar a "SELECT gen_random_uuid()")"
  own_p="$(scalar a "SELECT gen_random_uuid()")"; att_p="$(scalar a "SELECT gen_random_uuid()")"
  out="$(adm1 a 2 'math:rebuild:2' "kp$n" "$SHA1" "$rp" "$jp" 'math:python-large:2' 'fixture-image')"
  printf '%s' "$out" | grep -q '"outcome": *"enqueued"' || fail "(h) poison witness admission $n: $out"
  out="$(ex a "SELECT public.pq_claim('$ENVN',0::smallint,'$own_p'::uuid,'$att_p'::uuid,60,'large')->>'job_id'")"
  [ "$out" = "$jp" ] || fail "(h) poison witness claim $n took $out"
  out="$(ex a "SELECT public.pq_fail('$ENVN','$jp'::uuid,'$own_p'::uuid,'$att_p'::uuid,1,true,'stage_failed:1',true)->>'state'")"
  [ "$out" = "dead" ] || fail "(h) poison witness death $n: $out"
  [ "$(ex a "SELECT public.pd_release_scope('$ENVN','math:python-large:2')")" = "t" ] || fail "(h) poison witness release $n"
  last_dead="$jp"
done
rp="$(scalar a "SELECT gen_random_uuid()")"; jp="$(scalar a "SELECT gen_random_uuid()")"
out="$(adm1 a 2 'math:rebuild:2' kp4 "$SHA1" "$rp" "$jp" 'math:python-large:2' 'fixture-image')"
printf '%s' "$out" | grep -q '"outcome": *"poisoned"' || fail "(h) fourth admission after three deaths was not poisoned: $out"
printf '%s' "$out" | grep -q "\"job_id\": *\"$last_dead\"" || fail "(h) poisoned reply does not name the latest dead job: $out"
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_jobs WHERE worker_class='large' AND state='dead'")" = "3" ] || fail "(h) a poisoned admission made a job"
[ -z "$(scalar a "SELECT root_job_id FROM public.delphi_job_guards WHERE env='$ENVN' AND scope_key='math:python-large:2'")" ] || fail "(h) a poisoned admission left a guard"
out="$(adm1 a 2 'math:rebuild:2' kp5 "$SHA1" "$rp" "$jp" 'math:python-large:2' 'fixture-image-next')"
printf '%s' "$out" | grep -q '"outcome": *"enqueued"' || fail "(h) a new image did not reset the poison latch: $out"
[ "$(depth a large)" = "2/0/0/3/true" ] || fail "(h) large depth after the poison witness: $(depth a large)"
# The noop /1 path still works on /3.
rn="$(scalar a "SELECT gen_random_uuid()")"; jn="$(scalar a "SELECT gen_random_uuid()")"
own_n="$(scalar a "SELECT gen_random_uuid()")"; att_n="$(scalar a "SELECT gen_random_uuid()")"
out="$(ex a "SELECT public.pq_enqueue('$ENVN',1,'product','actor','key','$SHA1','$rn'::uuid,'$jn'::uuid,'public-fixture-input','$SHA1','$SHA1','$SHA1',1::smallint,3)->>'outcome'")"
[ "$out" = "enqueued" ] || fail "(h) noop enqueue: $out"
out="$(ex a "SELECT public.pq_claim('$ENVN',1::smallint,'$own_n'::uuid,'$att_n'::uuid,60)->>'outcome'")"
[ "$out" = "owned" ] || fail "(h) noop claim: $out"
out="$(ex a "SELECT public.pq_heartbeat('$ENVN','$jn'::uuid,'$own_n'::uuid,'$att_n'::uuid,1,60)->>'outcome'")"
[ "$out" = "owned" ] || fail "(h) noop heartbeat: $out"
uri="$(scalar a "SELECT expected_output_uri FROM public.polis_queue_runs WHERE run_id='$rn'")"
osha="$(scalar a "SELECT expected_output_sha256 FROM public.polis_queue_runs WHERE run_id='$rn'")"
out="$(ex a "SELECT public.pq_finalize('$ENVN','$jn'::uuid,'$own_n'::uuid,'$att_n'::uuid,1,'$uri','$osha')->>'outcome'")"
[ "$out" = "succeeded" ] || fail "(h) noop finalize: $out"
[ "$(scalar a "SELECT count(*) FROM public.delphi_jobs WHERE kind NOT IN ('math_rebuild','full_pipeline')")" = "0" ] || fail "(h) a noop job reached delphi_jobs"
pass "(h) rebuild admitted, guarded, claimed by its class only, finalized and released; Delphi and noop paths unchanged"

# ------------------------------------------------------------------ (f)
echo "== (f) /3 data present: down refused, everything survives =="
msg="$(refuse_one a "$DOWN")"
printf '%s' "$msg" | grep -q "refusing reversal: /3 data" || fail "(f) down refused for another reason: $msg"
for t in $JOB_TABLES polis_queue_large_class_install delphi_foundation_install; do
  [ "$(scalar a "SELECT to_regclass('public.$t')::text")" = "$t" ] || fail "(f) $t did not survive a refused down"
done
[ "$(scalar a "SELECT count(*) FROM public.polis_queue_jobs WHERE worker_class='large'")" = "6" ] || fail "(f) the rebuild rows did not survive a refused down"
[ "$(scalar a "SELECT contract_version FROM public.polis_queue_install")" = "polis-queue/3" ] || fail "(f) contract changed by a refused down"
psql_su -d a -c "DELETE FROM public.delphi_job_guards; DELETE FROM public.polis_queue_logs; DELETE FROM public.delphi_jobs; DELETE FROM public.polis_queue_requests; DELETE FROM public.polis_queue_attempts; DELETE FROM public.polis_queue_jobs; DELETE FROM public.polis_queue_heads; DELETE FROM public.polis_queue_runs; DELETE FROM public.conversations WHERE zid IN (1,2)" >/dev/null
pass "(f) down refused with /3 data; everything survived"

# ------------------------------------------------------------------ (d)
echo "== (d) down restores the catalog =="
apply_one a "$DOWN"
dump_schema a > "$WORK/a.down"
if ! cmp -s "$WORK/a.before" "$WORK/a.down"; then
  diff "$WORK/a.before" "$WORK/a.down" | head -40 >&2
  fail "(d) catalog after down differs from before 000024"
fi
[ "$(roles)" = "$(cat "$WORK/roles.before")" ] || fail "(d) the role set changed"
[ -z "$(scalar a "SELECT to_regclass('public.polis_queue_large_class_install')")" ] || fail "(d) install table survived"
[ "$(scalar a "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='pq_class_depth'")" = "0" ] || fail "(d) pq_class_depth survived"
[ "$(scalar a "SELECT contract_version FROM public.polis_queue_install")" = "polis-queue/2" ] || fail "(d) contract_version is not back to polis-queue/2"
# 000023's own drift check accepts the restored catalog: the /2 install row still matches it.
[ "$(scalar a "SELECT count(*) FROM public.delphi_foundation_install")" = "1" ] || fail "(d) the /2 install row is gone"
pass "(d) down: schema dump identical to before 000024; roles unchanged"

# ------------------------------------------------------------------ (e)
echo "== (e) apply again after the down =="
apply_one a "$UP"
dump_schema a > "$WORK/a.again"
cmp -s "$WORK/a.after" "$WORK/a.again" || fail "(e) re-apply after down differs from the first apply"
apply_one a "$DOWN"
dump_schema a > "$WORK/a.down2"
cmp -s "$WORK/a.before" "$WORK/a.down2" || fail "(e) second down differs from before 000024"
pass "(e) apply -> down -> apply -> down: both states reproduce byte for byte"

# ------------------------------------------------------------------ (g)
echo "== (g) down on databases that never had 000024 =="
createdb g
apply_upto g 000023
dump_schema g > "$WORK/g.before"
msg="$(refuse_one g "$DOWN")"
dump_schema g > "$WORK/g.after"
cmp -s "$WORK/g.before" "$WORK/g.after" || fail "(g) the failed down changed a database without 000024"
createdb g2
apply_upto g2 000022
dump_schema g2 > "$WORK/g2.before"
msg="$(refuse_one g2 "$DOWN")"
dump_schema g2 > "$WORK/g2.after"
cmp -s "$WORK/g2.before" "$WORK/g2.after" || fail "(g) the failed down changed a database without 000023"
msg="$(refuse_one g2 "$UP")"
printf '%s' "$msg" | grep -q "foundation missing" || fail "(g) 000024 without 000023 refused for another reason: $msg"
dump_schema g2 > "$WORK/g2.after2"
cmp -s "$WORK/g2.before" "$WORK/g2.after2" || fail "(g) the refused 000024 changed a database without 000023"
pass "(g) down without 000024, down without 000023, and 000024 without 000023 all fail before changing anything"

# ------------------------------------------------------------------ (i)
echo "== (i) the chain unwinds: 000024 down, then 000023 down =="
createdb i
apply_upto i 000022
dump_schema i > "$WORK/i.before23"
apply_one i "$UP23"
apply_one i "$UP"
msg="$(refuse_one i "$DOWN23")"
printf '%s' "$msg" | grep -q "foundation catalog drift" || fail "(i) 000023's down over /3 refused for another reason: $msg"
apply_one i "$DOWN"
apply_one i "$DOWN23"
dump_schema i > "$WORK/i.after"
cmp -s "$WORK/i.before23" "$WORK/i.after" || fail "(i) after both downs the catalog differs from before 000023"
pass "(i) 000023's down refuses over /3 and unwinds after 000024's down; dump identical to before 000023"

echo "ALL CHECKS PASSED (seal, a-i)"
