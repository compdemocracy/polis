-- 000023_create_delphi_foundation.sql
--
-- The Delphi job table: contract polis-queue/2 on top of 000019's polis-queue/1
-- substrate. Design: cost-reduction/04-plans/P-077-delphi-job-model.md (P1, the
-- job table under a Rust daemon running the unchanged pipeline); schema ruling
-- S1 approved as direction on 2026-10-05. The polis-jobs daemon (queue-rs)
-- runs on exactly this contract; until this file was placed here it lived only
-- as the daemon's test fixture, byte for byte the DDL below.
--
-- WHAT IT CREATES (all owned by polis_queue_owner, all empty on apply)
-- -------------------------------------------------------------------
--   delphi_jobs              one row per Delphi job: id, env, conversation,
--                            kind, parent (sub-jobs), run, status, digests,
--                            cost, timestamps, error. Status is kept in step
--                            with polis_queue_jobs by trigger.
--   delphi_job_aliases       closed table of public ids for imported jobs.
--   delphi_job_inputs        producer -> consumer edges with the producer's
--                            output digest; a consumer is claimable only once
--                            every producer succeeded with that digest.
--   delphi_current           the per-conversation pointer rows. Created empty;
--                            nothing in /2 moves them (P1 publishes no result).
--   delphi_job_guards        one guard row per scope, bound to its root job and
--                            request digest, held until safe explicit release
--                            (pd_release_scope, which refuses while any job in
--                            the root's tree is not terminal, lacks exit proof
--                            or has an open provider request; nothing releases
--                            a guard automatically). While it is held, an
--                            identical request returns the existing job and a
--                            different one is a conflict.
--   delphi_provider_requests intent/submission/completion of each paid provider
--                            batch, written BEFORE submission so a lost ACK or a
--                            fenced attempt is reconciled, never paid twice.
--   polis_queue_logs         the child's stdout/stderr and its manifest row.
--                            The daemon writes it with direct INSERTs under the
--                            executor's table grant (no RPC); the database
--                            limits one row (line <= 1 MiB), not the rows per
--                            attempt (the daemon's own buffer caps those); there
--                            is no retention: nothing deletes or sweeps log rows.
--   delphi_foundation_install the catalog baseline this apply recorded, read
--                            by the down script.
-- Plus, on 000019's tables: contract_version on polis_queue_install (reads
-- 'polis-queue/2'); the stage CHECK admits delphi_full_pipeline and
-- delphi_narrative beside noop; worker_class; process_exit_confirmed_at on
-- attempts; binding_expires_at on requests. The /1 noop path is untouched.
-- Results stay where they are (DynamoDB): no result table, no result function.
--
-- HOW TO APPLY
-- ------------
-- A fresh container applies it once from /docker-entrypoint-initdb.d in
-- file-name order, after 000019. An existing database needs THIS FILE ALONE,
-- by hand, as docs/migrations.md describes; 000019 must already be applied:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
--     < server/postgres/migrations/000023_create_delphi_foundation.sql
--
-- Applying it to production is a separate, explicit step by the owner, through
-- the checked wrapper, which runs the preflight below and sends the budgets:
--
--   server/postgres/bin/apply-migration.sh --free-bytes <bytes free on the db host> 000023 -- \
--     docker exec -i polis-dev-postgres-1 psql -U postgres -d polis-dev
--
-- WHAT IT LOCKS
-- -------------
-- The foreign keys from delphi_jobs and delphi_current to public.conversations
-- take ShareRowExclusiveLock on conversations, held from that statement until
-- COMMIT. While it is held, every INSERT, UPDATE and DELETE on conversations
-- waits (plain SELECT continues), and the apply itself waits, up to its
-- lock_timeout, behind any open transaction that already wrote a conversations
-- row; lock_timeout then aborts it with nothing applied. The changed /1 tables
-- and the new objects are AccessExclusive for the same span. "Additive and
-- empty" is therefore not "cannot block users": apply in an idle or controlled
-- writer window (producers paused, no open writer on conversations), the
-- window the wrapper's preflight checks. 000019 holds the same parent lock for
-- the same reason. Witnessed by down/test_000023_down.sh check (i).
--
-- APPLIER REQUIREMENTS AND BUDGETS
-- --------------------------------
-- The applying login must be able to SET ROLE polis_queue_owner (the roles and
-- grants come from 000019; this file creates no role and stores no password).
-- The wrapper refuses before sending the file unless: the file matches its
-- seal; the server is PostgreSQL 17; the login can SET ROLE polis_queue_owner;
-- 000019 is installed; every polis_queue_* and delphi_* data table is empty (a
-- first install); no other transaction on the database is older than
-- --max-xact-age (30 s), which the login must be able to see; and the free
-- disk the operator measured (--free-bytes) is at or above the floor (5 GiB).
-- It then sends the budgets lock_timeout 5s, statement_timeout 60s,
-- transaction_timeout 120s and idle_in_transaction_session_timeout 30s
-- (defaults, each printed and overridable). This file pins lock_timeout to 5s
-- inside its transaction itself. A budget that fires aborts the transaction.
-- The file refuses, changing nothing, when: 000019 is absent; the installed /1
-- catalog differs from what
-- 000019 recorded ("queue catalog drift", which is also what a second apply
-- says, since the tables are then already in /2 shape); or any public.delphi_*
-- table or pd_* function already exists ("foundation object collision").
-- Re-applying is therefore NOT a no-op: it is refused. 000019 itself refuses to
-- replay over this schema for the same reason, so nothing reverts to /1 by
-- accident.
--
-- SCOPE
-- -----
-- Installing this schema wires nothing. No route calls it; the server's queue
-- helper is behind POLIS_QUEUE_SUBSTRATE_ENABLED (default off) and admits only
-- the noop stage; the polis-jobs daemon starts only with POLIS_JOBS_ENABLED=1
-- and is started by no compose service. DynamoDB keeps running every Delphi
-- job family until each is moved, one at a time, in its own reviewed change.
--
-- REVERSAL
-- --------
-- down/000023_drop_delphi_foundation.sql restores the /1 catalog exactly as
-- recorded at apply time; it refuses if any /2 row exists. Proven by
-- down/test_000023_down.sh against the real chain (forward, backward,
-- re-apply, refusals). Both files are sealed in down/000023-files.sha256;
-- a change to either reseals in the same reviewed change.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
CREATE OR REPLACE FUNCTION pg_temp.pq_catalog(p_table oid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $catalog$
SELECT jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,co.collname,pg_get_expr(d.adbin,d.adrelid),NULLIF(a.attacl::text,'{}')) ORDER BY a.attnum)
 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation
 WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid),convalidated,connoinherit) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
 'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions,
 'acl',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type,x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),x.privilege_type,x.is_grantable) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x)
 ) FROM pg_class c WHERE c.oid=p_table
$catalog$;
CREATE OR REPLACE FUNCTION pg_temp.pq_assert_catalog(p_fresh boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $guard$
DECLARE expected jsonb='{"polis_queue_attempts": "4bf01840303c3447650ada377d535bee", "polis_queue_heads": "cf987d5673228e6ca6d6f3b86b7e77e5", "polis_queue_install": "47d90bf481bea018547d70029498bbb4", "polis_queue_jobs": "d8367b8bdaa7701b9c377450d23b5db5", "polis_queue_requests": "cae8fcd4db4562b9936b7d33cf598f1e", "polis_queue_runs": "8e7fd316c23320c229387822146eebec"}'::jsonb;
 entry record; actual text; names text[];
BEGIN
 SELECT array_agg(relname::text ORDER BY relname) INTO names FROM pg_class
 WHERE relnamespace='public'::regnamespace AND starts_with(relname,'polis_queue_')
 AND relkind IN ('r','p','v','m','f');
 IF p_fresh AND names IS NULL THEN RETURN; END IF;
 IF names IS DISTINCT FROM ARRAY(SELECT jsonb_object_keys(expected) ORDER BY 1) THEN
  RAISE EXCEPTION 'queue catalog drift: table inventory';
 END IF;
 FOR entry IN SELECT * FROM jsonb_each_text(expected) LOOP
  SELECT md5(pg_temp.pq_catalog(to_regclass('public.'||entry.key))::text) INTO actual;
  IF actual IS DISTINCT FROM entry.value THEN
   RAISE EXCEPTION 'queue catalog drift: %',entry.key
   USING DETAIL='observed: '||pg_temp.pq_catalog(to_regclass('public.'||entry.key))::text;
  END IF;
 END LOOP;
END $guard$;
SELECT pg_temp.pq_assert_catalog(false);

CREATE OR REPLACE FUNCTION pg_temp.pq_assert_signatures(p_fresh boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $guard$
DECLARE expected text[]=ARRAY['pq_backoff(uuid, integer)','pq_cancel(text, uuid, bigint)','pq_claim(text, smallint, uuid, uuid, integer)','pq_due(text, uuid, integer)','pq_end_attempt(text, uuid, uuid, uuid, bigint, text, text)','pq_enqueue(text, integer, text, text, text, text, uuid, uuid, text, text, text, text, smallint, integer)','pq_fail(text, uuid, uuid, uuid, bigint, boolean, text)','pq_finalize(text, uuid, uuid, uuid, bigint, text, text)','pq_head_status(text, text)','pq_heartbeat(text, uuid, uuid, uuid, bigint, integer)','pq_job_status(text, uuid)','pq_lock(text, uuid, boolean, boolean)','pq_no_regression()','pq_owns(public.polis_queue_jobs, uuid, uuid, bigint)','pq_park(text, uuid, uuid, uuid, bigint, text)','pq_publish_allowed(public.polis_queue_heads, public.polis_queue_runs)','pq_reap(text, uuid, integer)','pq_reap_one(text, uuid)','pq_release(text, uuid, uuid, uuid, bigint)','pq_result(text, public.polis_queue_jobs, boolean)','pq_terminate_attempt(public.polis_queue_jobs, text, text, text, boolean)']; actual text[];
BEGIN
 SELECT array_agg(proname || '(' || oidvectortypes(proargtypes) || ')' ORDER BY proname || '(' || oidvectortypes(proargtypes) || ')')
 INTO actual FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pq_');
 IF p_fresh AND actual IS NULL THEN RETURN; END IF;
 IF actual IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'queue catalog drift: unexpected function signatures (including overloads)';
 END IF;
END $guard$;
SELECT pg_temp.pq_assert_signatures(false);
CREATE OR REPLACE FUNCTION pg_temp.pq_assert_functions(p_fresh boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $guard$
DECLARE actual text;
BEGIN
 SELECT md5((SELECT jsonb_agg(jsonb_build_object(
 'signature',p.proname || '(' || oidvectortypes(p.proargtypes) || ')',
 'result',pg_get_function_result(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),
 'language',l.lanname,'kind',p.prokind,'security_definer',p.prosecdef,
 'volatility',p.provolatile,'parallel',p.proparallel,'strict',p.proisstrict,
 'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),
 'acl',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
 ORDER BY a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable)
 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)
 ) ORDER BY p.proname) FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
 WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'pq_'))::text) INTO actual;
 IF p_fresh AND actual IS NULL THEN RETURN; END IF;
 IF actual IS DISTINCT FROM 'f27901140fda2363181773810f5fbfa5' THEN
  -- Migration addition 3: the fingerprint says only that something moved. The
  -- likeliest drift is a hand-edited grant or owner, so name what is observed.
  RAISE EXCEPTION 'queue catalog drift: function result/defaults/config/owner/ACL'
   USING DETAIL='observed: '||(SELECT string_agg(format('%s owner=%s definer=%s executor_execute=%s',
    p.proname,pg_get_userbyid(p.proowner),p.prosecdef,
    has_function_privilege('polis_queue_executor',p.oid,'EXECUTE')),'; ' ORDER BY p.proname)
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'pq_'));
 END IF;
END $guard$;
SELECT pg_temp.pq_assert_functions(false);
CREATE FUNCTION pg_temp.pd_state() RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $s$
SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,pg_temp.pq_catalog(c.oid)) FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (starts_with(c.relname,'polis_queue_') OR starts_with(c.relname,'delphi_')) AND c.relname<>'delphi_foundation_install'),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_functiondef(p.oid),p.proacl::text,pg_get_userbyid(p.proowner)))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (starts_with(p.proname,'pq_') OR starts_with(p.proname,'pd_'))))
$s$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'delphi_'))
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pd_')) THEN RAISE EXCEPTION 'foundation object collision'; END IF;
END $$;
SELECT set_config('delphi.baseline',pg_temp.pd_state()::text,true);
-- DRAFT: dormant foundation. Apply only after the schema rulings.
-- P1 executor RPCs only. No application flag or data import changes.
ALTER TABLE public.polis_queue_install ADD COLUMN contract_version text NOT NULL
 DEFAULT 'polis-queue/2' CHECK(contract_version='polis-queue/2');
ALTER TABLE public.polis_queue_runs DROP CONSTRAINT polis_queue_runs_contract_version_check;
ALTER TABLE public.polis_queue_runs ADD CONSTRAINT polis_queue_runs_contract_version_check
 CHECK(contract_version IN ('polis-queue/1','polis-queue/2'));
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_stage_check
 CHECK(stage IN ('noop','delphi_full_pipeline','delphi_narrative'));
ALTER TABLE public.polis_queue_jobs ADD COLUMN worker_class text NOT NULL DEFAULT 'noop'
 CHECK(worker_class IN ('noop','delphi'));
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT pq_stage_worker
 CHECK((stage='noop') = (worker_class='noop'));
ALTER TABLE public.polis_queue_attempts ADD COLUMN process_exit_confirmed_at timestamptz;
ALTER TABLE public.polis_queue_attempts ADD CONSTRAINT pq_attempt_binding UNIQUE(env,job_id,attempt_id);
ALTER TABLE public.polis_queue_requests ADD COLUMN binding_expires_at timestamptz;

CREATE TABLE public.delphi_jobs (
 job_id uuid PRIMARY KEY, env text NOT NULL CHECK(env<>''),
 zid integer NOT NULL REFERENCES public.conversations(zid), report_id text,
 kind text NOT NULL CHECK(kind IN ('full_pipeline','embed','snapshot','umap','cluster','keywords',
 'topic_name','narrative','collective_statement','visualize','legacy_import','legacy_queue_record')),
 parent_job_id uuid, run_id uuid,
 origin text NOT NULL CHECK(origin IN ('queued','legacy_import')),
 replayable boolean NOT NULL DEFAULT false, reuse_eligible boolean NOT NULL DEFAULT false,
 status text NOT NULL CHECK(status IN ('queued','running','retry_wait','parked','succeeded','dead','cancelled')),
 inputs_digest bytea CHECK(octet_length(inputs_digest)=32), math_env text, math_tick bigint,
 math_caching_tick bigint, math_snapshot_key bytea CHECK(octet_length(math_snapshot_key)=32),
 config_effective jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(config_effective)='object'),
 code_version text, model_versions jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(model_versions)='object'),
 cost jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(cost)='object'),
 output_manifest_digest bytea CHECK(octet_length(output_manifest_digest)=32),
 pinned boolean NOT NULL DEFAULT false, label text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz, error text,
 UNIQUE(zid,job_id), UNIQUE(env,zid,job_id), UNIQUE(env,job_id),
 FOREIGN KEY(env,zid,parent_job_id) REFERENCES public.delphi_jobs(env,zid,job_id),
 FOREIGN KEY(env,run_id) REFERENCES public.polis_queue_runs(env,run_id),
 CHECK(parent_job_id IS DISTINCT FROM job_id),
 CHECK(origin <> 'legacy_import' OR (NOT replayable AND NOT reuse_eligible AND run_id IS NULL
  AND status IN ('succeeded','dead','cancelled')))
);
CREATE INDEX delphi_jobs_history ON public.delphi_jobs(env,zid,created_at,job_id);
CREATE INDEX delphi_jobs_parent ON public.delphi_jobs(parent_job_id);
-- Closed aliases: the ruled import will supply an exact allowlist; there is no
-- application insert/update/delete grant and no alias-minting RPC in this draft.
CREATE TABLE public.delphi_job_aliases (
 public_id text COLLATE "C" PRIMARY KEY CHECK(length(public_id) BETWEEN 1 AND 512),
 job_id uuid NOT NULL REFERENCES public.delphi_jobs(job_id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source<>''),
 CHECK(public_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
CREATE TABLE public.delphi_job_inputs (
 zid integer NOT NULL, consumer_job_id uuid NOT NULL,
 input_role text NOT NULL CHECK(input_role<>''), ordinal integer NOT NULL CHECK(ordinal>=0),
 producer_job_id uuid NOT NULL, producer_output_digest bytea NOT NULL CHECK(octet_length(producer_output_digest)=32),
 PRIMARY KEY(zid,consumer_job_id,input_role,ordinal),
 FOREIGN KEY(zid,consumer_job_id) REFERENCES public.delphi_jobs(zid,job_id) ON DELETE CASCADE,
 FOREIGN KEY(zid,producer_job_id) REFERENCES public.delphi_jobs(zid,job_id) ON DELETE RESTRICT,
 CHECK(consumer_job_id<>producer_job_id)
);
CREATE INDEX delphi_job_inputs_producer ON public.delphi_job_inputs(zid,producer_job_id);
CREATE TABLE public.delphi_current (
 env text NOT NULL, zid integer NOT NULL REFERENCES public.conversations(zid),
 scope text NOT NULL CHECK(scope='pipeline' OR scope ~ '^narrative:.+'),
 job_id uuid, requested_generation bigint NOT NULL DEFAULT 0 CHECK(requested_generation>=0),
 published_generation bigint NOT NULL DEFAULT 0 CHECK(published_generation>=0),
 PRIMARY KEY(env,zid,scope), FOREIGN KEY(env,zid,job_id) REFERENCES public.delphi_jobs(env,zid,job_id) ON DELETE RESTRICT,
 CHECK(published_generation<=requested_generation), CHECK(job_id IS NOT NULL OR published_generation=0)
);
CREATE TRIGGER pq_no_regression BEFORE UPDATE ON public.delphi_current
 FOR EACH ROW EXECUTE FUNCTION public.pq_no_regression();
CREATE TABLE public.delphi_job_guards (
 env text NOT NULL, scope_key text NOT NULL CHECK(scope_key<>''), zid integer NOT NULL,
 root_job_id uuid NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(env,scope_key), FOREIGN KEY(env,zid,root_job_id) REFERENCES public.delphi_jobs(env,zid,job_id)
);
CREATE TABLE public.delphi_provider_requests (
 request_id uuid PRIMARY KEY, env text NOT NULL, job_id uuid NOT NULL, attempt_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider<>''), provider_batch_id text,
 state text NOT NULL CHECK(state IN ('intent','submission_unknown','submitted','completed','failed')),
 request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(env,job_id) REFERENCES public.delphi_jobs(env,job_id),
 FOREIGN KEY(env,job_id,attempt_id) REFERENCES public.polis_queue_attempts(env,job_id,attempt_id),
 UNIQUE(provider,provider_batch_id), CHECK(state NOT IN ('submitted','completed') OR provider_batch_id IS NOT NULL)
);
CREATE INDEX delphi_provider_open ON public.delphi_provider_requests(env,job_id)
 WHERE state IN ('intent','submission_unknown','submitted');
CREATE TABLE public.polis_queue_logs (
 env text NOT NULL, attempt_id uuid NOT NULL, seq bigint NOT NULL CHECK(seq>=0),
 ts timestamptz NOT NULL DEFAULT clock_timestamp(),
 stream text NOT NULL CHECK(stream IN ('stdout','stderr','manifest','truncated')),
 line text NOT NULL CHECK(octet_length(line)<=1048576),
 PRIMARY KEY(env,attempt_id,seq), FOREIGN KEY(env,attempt_id) REFERENCES public.polis_queue_attempts(env,attempt_id)
);

CREATE FUNCTION public.pd_lock(p_env text,p_job uuid,p_skip boolean DEFAULT false,p_head boolean DEFAULT true)
RETURNS public.polis_queue_jobs LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; r public.polis_queue_runs;
BEGIN
 SELECT q.* INTO j FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.job_id=p_job;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT q.* INTO r FROM public.polis_queue_runs q WHERE q.env=j.env AND q.run_id=j.run_id;
 IF p_skip THEN
  PERFORM 1 FROM public.conversations c WHERE c.zid=r.zid FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_head THEN
   PERFORM 1 FROM public.polis_queue_heads h WHERE h.env=r.env AND h.product_key=r.product_key FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  PERFORM 1 FROM public.polis_queue_runs q WHERE q.env=r.env AND q.run_id=r.run_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT q.* INTO j FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.job_id=p_job FOR UPDATE SKIP LOCKED;
 ELSE
  PERFORM 1 FROM public.conversations c WHERE c.zid=r.zid FOR KEY SHARE;
  IF p_head THEN
   PERFORM 1 FROM public.polis_queue_heads h WHERE h.env=r.env AND h.product_key=r.product_key FOR UPDATE;
  END IF;
  PERFORM 1 FROM public.polis_queue_runs q WHERE q.env=r.env AND q.run_id=r.run_id FOR UPDATE;
  SELECT q.* INTO j FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.job_id=p_job FOR UPDATE;
 END IF;
 RETURN j;
END $$;
CREATE OR REPLACE FUNCTION public.pq_claim(p_env text,p_priority smallint,p_owner uuid,p_attempt uuid,p_lease_seconds integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs;
BEGIN
 IF p_lease_seconds NOT BETWEEN 10 AND 900 OR p_owner IS NULL OR p_attempt IS NULL THEN RAISE EXCEPTION 'invalid claim arguments' USING ERRCODE='22023'; END IF;
 WITH candidate AS (
  SELECT q.env,q.job_id FROM public.polis_queue_jobs q
  WHERE q.stage='noop' AND q.env=p_env AND q.priority=p_priority AND q.state IN ('queued','retry_wait')
   AND q.eligible_at<=statement_timestamp() AND q.attempt_count-q.parked_attempt_count<q.max_attempts
  ORDER BY q.eligible_at,q.created_at,q.job_id FOR UPDATE SKIP LOCKED LIMIT 1
 ) UPDATE public.polis_queue_jobs q SET state='running',owner_id=p_owner,attempt_id=p_attempt,
  locked_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),lease_epoch=q.lease_epoch+1,
  version=q.version+1,mgmt_version=q.mgmt_version+1,attempt_count=q.attempt_count+1,updated_at=clock_timestamp()
 FROM candidate c WHERE q.env=c.env AND q.job_id=c.job_id AND q.state IN ('queued','retry_wait')
 RETURNING q.* INTO j;
 IF NOT FOUND THEN RETURN public.pq_result('none',NULL); END IF;
 INSERT INTO public.polis_queue_attempts(env,attempt_id,job_id,owner_id,lease_epoch,outcome)
 VALUES(j.env,j.attempt_id,j.job_id,j.owner_id,j.lease_epoch,'running');
 RETURN public.pq_result('owned',j);
END $$;
CREATE OR REPLACE FUNCTION public.pq_lock(p_env text,p_job uuid,p_skip boolean DEFAULT false,p_head boolean DEFAULT true)
RETURNS public.polis_queue_jobs LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; r public.polis_queue_runs;
BEGIN
 SELECT q.* INTO j FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.job_id=p_job;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT q.* INTO r FROM public.polis_queue_runs q WHERE q.env=j.env AND q.run_id=j.run_id;
 IF p_skip THEN
  PERFORM 1 FROM public.conversations c WHERE c.zid=r.zid FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_head THEN
   PERFORM 1 FROM public.polis_queue_heads h WHERE h.env=r.env AND h.product_key=r.product_key FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  PERFORM 1 FROM public.polis_queue_runs q WHERE q.env=r.env AND q.run_id=r.run_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT q.* INTO j FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.job_id=p_job FOR UPDATE SKIP LOCKED;
 ELSE
  PERFORM 1 FROM public.conversations c WHERE c.zid=r.zid FOR KEY SHARE;
  IF p_head THEN
   PERFORM 1 FROM public.polis_queue_heads h WHERE h.env=r.env AND h.product_key=r.product_key FOR UPDATE;
  END IF;
  PERFORM 1 FROM public.polis_queue_runs q WHERE q.env=r.env AND q.run_id=r.run_id FOR UPDATE;
  SELECT q.* INTO j FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.job_id=p_job FOR UPDATE;
 END IF;
 RETURN j;
END $$;
CREATE OR REPLACE FUNCTION public.pq_heartbeat(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_lease_seconds integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs;
BEGIN
 IF p_lease_seconds NOT BETWEEN 10 AND 900 THEN RAISE EXCEPTION 'invalid lease interval' USING ERRCODE='22023'; END IF;
 SELECT q.* INTO j FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.job_id=p_job FOR UPDATE;
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RETURN public.pq_result('fenced',j); END IF;
 UPDATE public.polis_queue_jobs SET locked_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),version=version+1,updated_at=clock_timestamp()
 WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 RETURN public.pq_result('owned',j);
END $$;
CREATE OR REPLACE FUNCTION public.pq_due(p_env text,p_after_job uuid,p_limit integer)
RETURNS TABLE(job_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT q.job_id FROM public.polis_queue_jobs q WHERE q.stage='noop' AND q.env=p_env AND (p_after_job IS NULL OR q.job_id>p_after_job) AND
  ((q.state='running' AND q.locked_until<=statement_timestamp()) OR
   (q.state='parked' AND q.eligible_at<=statement_timestamp()) OR
   (q.state IN ('queued','retry_wait') AND q.attempt_count-q.parked_attempt_count>=q.max_attempts))
 ORDER BY q.job_id LIMIT LEAST(GREATEST(p_limit,0),100)
$$;
CREATE OR REPLACE FUNCTION public.pq_result(p_outcome text, j public.polis_queue_jobs, p_published boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('schema_version',CASE WHEN j.stage IS NULL OR j.stage='noop' THEN 'polis-queue/1' ELSE 'polis-queue/2' END,'outcome',p_outcome,
  'env',j.env,'job_id',j.job_id,'run_id',j.run_id,
  'attempt_id',COALESCE(j.attempt_id,j.terminal_attempt_id),'owner_id',j.owner_id,
  'lease_epoch',j.lease_epoch::text,'version',j.version::text,'mgmt_version',j.mgmt_version::text,'locked_until',j.locked_until,
  'state',j.state,'output_sha256',j.output_sha256,'published',COALESCE(p_published,false),
  'stage',j.stage,'stage_instance',j.stage_instance,'attempt_count',j.attempt_count,'max_attempts',j.max_attempts,'parked_attempt_count',j.parked_attempt_count,
  'eligible_at',j.eligible_at,'first_parked_at',j.first_parked_at,'last_error_code',j.last_error_code,
  'input',(SELECT jsonb_build_object('uri',r.input_uri,'sha256',r.input_sha256,'config_sha256',r.config_sha256,'code_image_digest',r.code_image_digest) FROM public.polis_queue_runs r WHERE r.env=j.env AND r.run_id=j.run_id))
$$;
-- Internal graph and logical/execution binding checks.
CREATE FUNCTION public.pd_input_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.delphi_jobs; p public.delphi_jobs;
BEGIN
 -- Keep parent existence stable without blocking participant-count updates.
 PERFORM 1 FROM public.conversations WHERE zid=NEW.zid FOR KEY SHARE;
 -- Serialize graph edits, including competing reverse edges.
 PERFORM pg_advisory_xact_lock(hashtextextended('pd:graph:'||NEW.zid::text,0));
 SELECT * INTO STRICT c FROM public.delphi_jobs WHERE job_id=NEW.consumer_job_id;
 SELECT * INTO STRICT p FROM public.delphi_jobs WHERE job_id=NEW.producer_job_id;
 IF c.env<>p.env OR c.status<>'queued' THEN RAISE EXCEPTION 'invalid dependency namespace or consumer state'; END IF;
 IF EXISTS(WITH RECURSIVE upstream(id) AS (
  SELECT NEW.producer_job_id UNION SELECT i.producer_job_id FROM public.delphi_job_inputs i JOIN upstream u ON i.consumer_job_id=u.id
 ) SELECT 1 FROM upstream WHERE id=NEW.consumer_job_id) THEN RAISE EXCEPTION 'dependency cycle'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pd_input_guard BEFORE INSERT OR UPDATE ON public.delphi_job_inputs FOR EACH ROW EXECUTE FUNCTION public.pd_input_guard();

-- Deferred triggers run after the RPC returns; retain the owner privilege
-- boundary when the restricted executor commits its transaction.
CREATE FUNCTION public.pd_queue_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.polis_queue_jobs; j public.delphi_jobs; r public.polis_queue_runs;
BEGIN
 SELECT * INTO q FROM public.polis_queue_jobs WHERE env=NEW.env AND job_id=NEW.job_id;
 IF q.stage='noop' THEN RETURN NULL; END IF;
 SELECT * INTO j FROM public.delphi_jobs WHERE env=q.env AND job_id=q.job_id;
 SELECT * INTO r FROM public.polis_queue_runs WHERE env=q.env AND run_id=q.run_id;
 IF j.job_id IS NULL OR j.zid<>r.zid OR j.origin<>'queued' OR j.run_id IS DISTINCT FROM q.run_id
 OR r.contract_version<>'polis-queue/2'
 OR (q.stage='delphi_full_pipeline' AND j.kind<>'full_pipeline')
 OR (q.stage='delphi_narrative' AND j.kind<>'narrative') THEN RAISE EXCEPTION 'invalid logical execution binding'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pd_queue_binding AFTER INSERT OR UPDATE ON public.polis_queue_jobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pd_queue_binding();
CREATE FUNCTION public.pd_sync_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.stage<>'noop' THEN
  UPDATE public.delphi_jobs SET status=NEW.state,
   completed_at=CASE WHEN NEW.state IN ('succeeded','dead','cancelled') THEN clock_timestamp() END,
   error=NEW.last_error_code WHERE env=NEW.env AND job_id=NEW.job_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER pd_sync_status AFTER UPDATE OF state ON public.polis_queue_jobs FOR EACH ROW EXECUTE FUNCTION public.pd_sync_status();

CREATE FUNCTION public.pq_claim(p_env text,p_priority smallint,p_owner uuid,p_attempt uuid,p_lease_seconds integer,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.polis_queue_jobs;
BEGIN
 IF p_owner IS NULL OR p_attempt IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 900
 OR p_worker_class IS DISTINCT FROM 'delphi' THEN RAISE EXCEPTION 'invalid claim'; END IF;
 WITH candidate AS (
  SELECT q.env,q.job_id FROM public.polis_queue_jobs q JOIN public.delphi_jobs d ON d.env=q.env AND d.job_id=q.job_id
  WHERE q.env=p_env AND q.priority=p_priority AND q.worker_class='delphi'
  AND q.state IN ('queued','retry_wait') AND q.eligible_at<=statement_timestamp()
  AND q.attempt_count-q.parked_attempt_count<q.max_attempts
  AND NOT EXISTS(SELECT 1 FROM public.delphi_job_inputs i JOIN public.delphi_jobs p ON p.job_id=i.producer_job_id
   WHERE i.consumer_job_id=q.job_id AND (p.status<>'succeeded' OR p.output_manifest_digest IS DISTINCT FROM i.producer_output_digest))
  -- An expired lease is not evidence that the previous process stopped.
  AND NOT EXISTS(SELECT 1 FROM public.polis_queue_attempts a WHERE a.env=q.env AND a.job_id=q.job_id AND a.process_exit_confirmed_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM public.delphi_provider_requests pr WHERE pr.env=q.env AND pr.job_id=q.job_id AND pr.state IN ('intent','submission_unknown'))
  ORDER BY q.eligible_at,q.created_at,q.job_id FOR UPDATE OF q SKIP LOCKED LIMIT 1
 ) UPDATE public.polis_queue_jobs q SET state='running',owner_id=p_owner,attempt_id=p_attempt,
 locked_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),lease_epoch=q.lease_epoch+1,
 version=q.version+1,mgmt_version=q.mgmt_version+1,attempt_count=q.attempt_count+1,updated_at=clock_timestamp()
 FROM candidate c WHERE q.env=c.env AND q.job_id=c.job_id RETURNING q.* INTO j;
 IF NOT FOUND THEN RETURN jsonb_build_object('schema_version','polis-queue/2','outcome','none'); END IF;
 INSERT INTO public.polis_queue_attempts(env,attempt_id,job_id,owner_id,lease_epoch,outcome)
 VALUES(j.env,j.attempt_id,j.job_id,j.owner_id,j.lease_epoch,'running');
 RETURN public.pq_result('owned',j);
END $$;

CREATE FUNCTION public.pd_release_scope(p_env text,p_scope text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.delphi_job_guards; ids uuid[];
BEGIN
 -- Match admission lock order when release and enqueue share a transaction.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:scope',p_env,p_scope)::text,0));
 SELECT * INTO g FROM public.delphi_job_guards WHERE env=p_env AND scope_key=p_scope FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 WITH RECURSIVE descendants(id) AS (SELECT g.root_job_id UNION SELECT j.job_id FROM public.delphi_jobs j JOIN descendants d ON j.parent_job_id=d.id)
 SELECT array_agg(id) INTO ids FROM descendants;
 IF EXISTS(SELECT 1 FROM public.delphi_jobs WHERE job_id=ANY(ids) AND status NOT IN ('succeeded','dead','cancelled'))
 OR EXISTS(SELECT 1 FROM public.polis_queue_attempts WHERE env=p_env AND job_id=ANY(ids) AND process_exit_confirmed_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.delphi_provider_requests WHERE env=p_env AND job_id=ANY(ids) AND state IN ('intent','submission_unknown','submitted')) THEN RETURN false; END IF;
 DELETE FROM public.delphi_job_guards WHERE env=p_env AND scope_key=p_scope;
 RETURN true;
END $$;

-- P1 admission: callers authenticate the request; SQL owns the atomic guard,
-- request binding, logical job and queue row. No child admission in P1.
CREATE FUNCTION public.pd_enqueue(p_env text,p_zid integer,p_product text,p_actor text,p_key text,p_request_sha text,
 p_run uuid,p_job uuid,p_input_uri text,p_input_sha text,p_config_sha text,p_image text,p_priority smallint,p_max_attempts integer,
 p_stage text,p_report text,p_scope text,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE g public.delphi_job_guards; j public.polis_queue_jobs; alias public.polis_queue_requests; reply jsonb;
BEGIN
 IF p_stage IS NULL OR p_stage NOT IN ('delphi_full_pipeline','delphi_narrative') OR p_scope IS NULL OR p_scope=''
 OR p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR (p_stage='delphi_narrative' AND COALESCE(p_report,'')='')
 THEN RAISE EXCEPTION 'invalid admission'; END IF;
 -- Parent FK/existence lock only; participant-count updates remain compatible.
 PERFORM 1 FROM public.conversations WHERE zid=p_zid FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown conversation'; END IF;
 -- Serialize an empty or occupied scope, including competing first admissions.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:scope',p_env,p_scope)::text,0));
 SELECT * INTO alias FROM public.polis_queue_requests WHERE env=p_env AND actor_scope=p_actor AND product_key=p_product AND request_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF alias.binding_expires_at IS NULL THEN RAISE EXCEPTION 'legacy request binding'; END IF;
  IF alias.binding_expires_at>clock_timestamp() THEN
   SELECT * INTO j FROM public.polis_queue_jobs WHERE env=p_env AND job_id=alias.job_id;
   RETURN public.pq_result(CASE WHEN alias.request_sha256=p_request_sha THEN 'existing' ELSE 'conflict' END,j);
  END IF;
  DELETE FROM public.polis_queue_requests WHERE env=p_env AND actor_scope=p_actor AND product_key=p_product AND request_key=p_key;
 END IF;
 SELECT * INTO g FROM public.delphi_job_guards WHERE env=p_env AND scope_key=p_scope FOR UPDATE;
 IF FOUND THEN
  SELECT * INTO j FROM public.polis_queue_jobs WHERE env=p_env AND job_id=g.root_job_id;
  IF g.zid<>p_zid OR NOT EXISTS(SELECT 1 FROM public.delphi_jobs d WHERE d.job_id=g.root_job_id
   AND d.report_id IS NOT DISTINCT FROM p_report AND d.kind=CASE p_stage WHEN 'delphi_narrative' THEN 'narrative' ELSE 'full_pipeline' END)
   OR NOT EXISTS(SELECT 1 FROM public.polis_queue_runs r WHERE r.env=p_env AND r.run_id=j.run_id AND r.product_key=p_product)
   THEN RAISE EXCEPTION 'scope binding mismatch'; END IF;
  IF g.request_sha256<>p_request_sha THEN RETURN public.pq_result('conflict',j); END IF;
  INSERT INTO public.polis_queue_requests(env,actor_scope,product_key,request_key,request_sha256,run_id,job_id,binding_expires_at)
   VALUES(p_env,p_actor,p_product,p_key,p_request_sha,j.run_id,j.job_id,clock_timestamp()+interval '24 hours');
  RETURN public.pq_result('existing',j);
 END IF;
 reply=public.pq_enqueue(p_env,p_zid,p_product,p_actor,p_key,p_request_sha,p_run,p_job,p_input_uri,p_input_sha,p_config_sha,p_image,p_priority,p_max_attempts);
 IF reply->>'outcome'<>'enqueued' THEN RAISE EXCEPTION 'unexpected admission conflict'; END IF;
 UPDATE public.polis_queue_runs SET contract_version='polis-queue/2' WHERE env=p_env AND run_id=p_run;
 INSERT INTO public.delphi_jobs(job_id,env,zid,report_id,kind,run_id,origin,status,config_effective,code_version)
 VALUES(p_job,p_env,p_zid,p_report,CASE p_stage WHEN 'delphi_narrative' THEN 'narrative' ELSE 'full_pipeline' END,p_run,'queued','queued',p_config,p_image);
 UPDATE public.polis_queue_jobs SET stage=p_stage,worker_class='delphi' WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 INSERT INTO public.delphi_job_guards VALUES(p_env,p_scope,p_zid,p_job,p_request_sha);
 UPDATE public.polis_queue_requests SET binding_expires_at=clock_timestamp()+interval '24 hours'
 WHERE env=p_env AND actor_scope=p_actor AND product_key=p_product AND request_key=p_key;
 RETURN public.pq_result('enqueued',j);
END $$;

-- Exit attestation is accepted only for the specified attempt's original owner
-- and epoch, including after cancellation/expiry. It never restores ownership.
CREATE FUNCTION public.pq_end_attempt(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,
 p_action text,p_error text,p_process_exit_confirmed boolean,p_eligible_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; a public.polis_queue_attempts; s text;
BEGIN
 j=public.pd_lock(p_env,p_job,false,false);
 IF j.job_id IS NULL OR j.stage='noop' THEN RETURN public.pq_result('fenced',j); END IF;
 SELECT * INTO a FROM public.polis_queue_attempts WHERE env=p_env AND job_id=p_job AND attempt_id=p_attempt;
 IF a.attempt_id IS NULL OR a.owner_id IS DISTINCT FROM p_owner OR a.lease_epoch IS DISTINCT FROM p_epoch
 THEN RETURN public.pq_result('fenced',j); END IF;
 IF p_action IS NULL OR p_action NOT IN ('confirm_exit','retry','permanent','release','park')
 OR p_process_exit_confirmed IS DISTINCT FROM true THEN RAISE EXCEPTION 'process exit proof required'; END IF;
 UPDATE public.polis_queue_attempts SET process_exit_confirmed_at=COALESCE(process_exit_confirmed_at,clock_timestamp())
 WHERE env=p_env AND attempt_id=p_attempt;
 IF p_action='confirm_exit' THEN RETURN public.pq_result('exit_confirmed',j); END IF;
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RETURN public.pq_result('fenced',j); END IF;
 s=CASE WHEN p_action='park' THEN 'parked' WHEN p_action='permanent' OR j.attempt_count-j.parked_attempt_count>=j.max_attempts THEN 'dead' ELSE 'retry_wait' END;
 IF EXISTS(SELECT 1 FROM public.delphi_provider_requests WHERE env=p_env AND job_id=p_job AND state IN ('intent','submission_unknown'))
 THEN s='parked'; p_error='provider_unresolved'; END IF;
 j=public.pq_terminate_attempt(j,s,s,p_error,p_action='release');
 IF s='parked' AND p_action<>'park' THEN
  UPDATE public.polis_queue_jobs SET parked_attempt_count=parked_attempt_count-1 WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 END IF;
 IF s='parked' AND p_eligible_at IS NOT NULL THEN
  UPDATE public.polis_queue_jobs SET eligible_at=p_eligible_at WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 END IF;
 RETURN public.pq_result(s,j);
END $$;
CREATE FUNCTION public.pq_fail(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_permanent boolean,p_error text,p_process_exit_confirmed boolean)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.pq_end_attempt($1,$2,$3,$4,$5,CASE WHEN $6 THEN 'permanent' ELSE 'retry' END,$7,$8,NULL)
$$;
CREATE FUNCTION public.pq_release(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_process_exit_confirmed boolean)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.pq_end_attempt($1,$2,$3,$4,$5,'release',NULL,$6,NULL)
$$;
CREATE FUNCTION public.pq_park(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_error text,p_process_exit_confirmed boolean,p_eligible_at timestamptz)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.pq_end_attempt($1,$2,$3,$4,$5,'park',$6,$7,$8)
$$;

-- A manifest receipt is not publication of results. P1 never moves either
-- serving pointer and has no result-writing function or publisher credential.
CREATE FUNCTION public.pd_finalize(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_uri text,p_sha text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; a public.polis_queue_attempts; r public.polis_queue_runs; raw text; m jsonb;
BEGIN
 j=public.pd_lock(p_env,p_job);
 SELECT * INTO a FROM public.polis_queue_attempts WHERE env=p_env AND job_id=p_job AND attempt_id=p_attempt;
 SELECT * INTO r FROM public.polis_queue_runs WHERE env=p_env AND run_id=j.run_id;
 IF j.state='succeeded' AND j.terminal_attempt_id=p_attempt AND a.owner_id=p_owner AND a.lease_epoch=p_epoch THEN
  RETURN public.pq_result(CASE WHEN a.output_sha256=p_sha AND r.expected_output_uri=p_uri THEN 'already_succeeded' ELSE 'invalid_output' END,j);
 END IF;
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RETURN public.pq_result('fenced',j); END IF;
 IF a.process_exit_confirmed_at IS NULL THEN RAISE EXCEPTION 'process exit proof required'; END IF;
 IF p_uri IS NULL OR p_uri !~ '^file://.+' OR length(p_uri)>2048 OR p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$'
 THEN RETURN public.pq_result('invalid_output',j); END IF;
 SELECT line INTO raw FROM public.polis_queue_logs WHERE env=p_env AND attempt_id=p_attempt AND stream='manifest'
 AND encode(sha256(convert_to(line,'UTF8')),'hex')=p_sha ORDER BY seq DESC LIMIT 1;
 IF raw IS NULL THEN RETURN public.pq_result('invalid_output',j); END IF;
 BEGIN m=raw::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN public.pq_result('invalid_output',j); END;
 IF m->>'schema' IS DISTINCT FROM 'polis-jobs.output-manifest/1'
 OR m->>'job_id' IS DISTINCT FROM p_job::text OR m->>'attempt_id' IS DISTINCT FROM p_attempt::text
 OR m->>'stage' IS DISTINCT FROM j.stage OR m->>'outcome' IS DISTINCT FROM 'succeeded'
 OR COALESCE(m->>'phase','') NOT IN ('submit','recheck','run')
 OR jsonb_typeof(m->'outputs') IS DISTINCT FROM 'array'
 OR jsonb_typeof(m->'inputs') IS DISTINCT FROM 'object'
 OR jsonb_typeof(m->'models') IS DISTINCT FROM 'object'
 OR jsonb_typeof(m->'cost') IS DISTINCT FROM 'object'
 OR (m ? 'artifacts' AND m->'artifacts'<>'[]'::jsonb)
 THEN RETURN public.pq_result('invalid_output',j); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(m->'outputs') o WHERE o->>'store' IS DISTINCT FROM 'dynamodb'
 OR COALESCE(o->>'table','')='' OR NOT (o ? 'keys' OR o ? 'key_prefix') OR COALESCE(o->>'rows','') !~ '^[0-9]+$')
 THEN RETURN public.pq_result('invalid_output',j); END IF;
 IF EXISTS(SELECT 1 FROM public.delphi_provider_requests WHERE env=p_env AND job_id=p_job AND state IN ('intent','submission_unknown','submitted'))
 THEN RAISE EXCEPTION 'provider request unresolved'; END IF;
 UPDATE public.polis_queue_attempts SET outcome='succeeded',ended_at=clock_timestamp(),output_sha256=p_sha WHERE env=p_env AND attempt_id=p_attempt;
 UPDATE public.polis_queue_jobs SET state='succeeded',terminal_attempt_id=p_attempt,owner_id=NULL,attempt_id=NULL,locked_until=NULL,
 output_sha256=p_sha,version=version+1,mgmt_version=mgmt_version+1,updated_at=clock_timestamp() WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 UPDATE public.delphi_jobs SET output_manifest_digest=decode(p_sha,'hex') WHERE env=p_env AND job_id=p_job;
 UPDATE public.polis_queue_runs SET state='succeeded',expected_output_uri=p_uri,expected_output_sha256=p_sha,output_sha256=p_sha WHERE env=p_env AND run_id=j.run_id;
 RETURN public.pq_result('succeeded',j,false);
END $$;

CREATE FUNCTION public.pq_attempt_logs(p_env text,p_attempt uuid,p_after_seq bigint,p_limit integer)
RETURNS TABLE(seq bigint,ts timestamptz,stream text,line text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT l.seq,l.ts,l.stream,l.line FROM public.polis_queue_logs l
 WHERE l.env=p_env AND l.attempt_id=p_attempt AND (p_after_seq IS NULL OR l.seq>p_after_seq)
 ORDER BY l.seq LIMIT LEAST(GREATEST(p_limit,0),1000)
$$;
CREATE FUNCTION public.pd_job_view(p_env text,p_job uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.pq_result('job_status',q)||jsonb_build_object('kind',j.kind,'report_id',j.report_id,
 'manifest_sha256',encode(j.output_manifest_digest,'hex'),'manifest_uri',CASE WHEN q.state='succeeded' THEN r.expected_output_uri END,
 -- Preserve the original attempt identity after lease ownership is cleared.
 'last_attempt',(SELECT jsonb_build_object('attempt_id',a.attempt_id,'owner_id',a.owner_id,
   'lease_epoch',a.lease_epoch::text,'process_exit_confirmed_at',a.process_exit_confirmed_at)
   FROM public.polis_queue_attempts a WHERE a.env=q.env AND a.job_id=q.job_id
   AND a.attempt_id=COALESCE(q.attempt_id,q.terminal_attempt_id)),
 'provider_requests',COALESCE((SELECT jsonb_agg(jsonb_build_object('request_id',p.request_id,'provider',p.provider,
 'batch_id',p.provider_batch_id,'state',p.state) ORDER BY p.created_at,p.request_id) FROM public.delphi_provider_requests p WHERE p.env=p_env AND p.job_id=p_job),'[]'::jsonb))
 FROM public.delphi_jobs j JOIN public.polis_queue_jobs q ON q.env=j.env AND q.job_id=j.job_id
 JOIN public.polis_queue_runs r ON r.env=q.env AND r.run_id=q.run_id WHERE j.env=p_env AND j.job_id=p_job
$$;

CREATE FUNCTION public.pd_provider_intent(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,
 p_request uuid,p_provider text,p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.polis_queue_jobs; previous public.delphi_provider_requests;
BEGIN
 j=public.pd_lock(p_env,p_job,false,false);
 IF j.stage IS NULL OR j.stage='noop' OR NOT public.pq_owns(j,p_owner,p_attempt,p_epoch)
 THEN RAISE EXCEPTION 'fenced provider intent'; END IF;
 SELECT * INTO previous FROM public.delphi_provider_requests WHERE request_id=p_request;
 IF FOUND THEN
  IF previous.env=p_env AND previous.job_id=p_job AND previous.attempt_id=p_attempt AND previous.provider=p_provider AND previous.request_digest=p_digest
  THEN RETURN jsonb_build_object('outcome','existing','state',previous.state,'request_id',previous.request_id); END IF;
  RAISE EXCEPTION 'provider request conflict';
 END IF;
 IF EXISTS(SELECT 1 FROM public.delphi_provider_requests WHERE env=p_env AND job_id=p_job AND state IN ('intent','submission_unknown','submitted'))
 THEN RAISE EXCEPTION 'provider request unresolved'; END IF;
 INSERT INTO public.delphi_provider_requests(request_id,env,job_id,attempt_id,provider,state,request_digest)
 VALUES(p_request,p_env,p_job,p_attempt,p_provider,'intent',p_digest);
 RETURN jsonb_build_object('outcome','recorded','state','intent','request_id',p_request);
END $$;
CREATE FUNCTION public.pd_provider_update(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,
 p_request uuid,p_state text,p_batch text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.polis_queue_jobs; pr public.delphi_provider_requests; original public.polis_queue_attempts;
BEGIN
 j=public.pd_lock(p_env,p_job,false,false);
 SELECT * INTO pr FROM public.delphi_provider_requests WHERE env=p_env AND job_id=p_job AND request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown provider request'; END IF;
 SELECT * INTO original FROM public.polis_queue_attempts WHERE env=p_env AND attempt_id=pr.attempt_id;
 -- A fenced submitter may record a late acknowledgement, never clear paid work.
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) AND NOT
 (original.attempt_id=p_attempt AND original.owner_id=p_owner AND original.lease_epoch=p_epoch
 AND p_state IN ('submission_unknown','submitted')) THEN RAISE EXCEPTION 'fenced provider update'; END IF;
 IF pr.provider_batch_id IS NOT NULL AND pr.provider_batch_id IS DISTINCT FROM p_batch THEN RAISE EXCEPTION 'immutable provider batch'; END IF;
 IF p_state IS NULL OR NOT (pr.state=p_state OR
 (pr.state='intent' AND p_state IN ('submission_unknown','submitted','failed')) OR
 (pr.state='submission_unknown' AND p_state IN ('submitted','failed')) OR
 (pr.state='submitted' AND p_state IN ('completed','failed'))) THEN RAISE EXCEPTION 'invalid provider transition'; END IF;
 UPDATE public.delphi_provider_requests SET state=p_state,provider_batch_id=p_batch,updated_at=clock_timestamp()
 WHERE request_id=p_request;
 RETURN jsonb_build_object('outcome','recorded','state',p_state,'request_id',p_request);
END $$;

CREATE OR REPLACE FUNCTION public.pq_finalize(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_output_uri text,p_output_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; r public.polis_queue_runs; h public.polis_queue_heads; a public.polis_queue_attempts; moved boolean=false;
BEGIN
 IF EXISTS(SELECT 1 FROM public.polis_queue_jobs WHERE env=p_env AND job_id=p_job AND stage<>'noop') THEN
  RETURN public.pd_finalize(p_env,p_job,p_owner,p_attempt,p_epoch,p_output_uri,p_output_sha);
 END IF;
 j=public.pq_lock(p_env,p_job);
 IF j.job_id IS NULL THEN RETURN public.pq_result('fenced',j); END IF;
 SELECT x.* INTO r FROM public.polis_queue_runs x WHERE x.env=p_env AND x.run_id=j.run_id;
 SELECT x.* INTO h FROM public.polis_queue_heads x WHERE x.env=p_env AND x.product_key=r.product_key;
 SELECT x.* INTO a FROM public.polis_queue_attempts x WHERE x.env=p_env AND x.attempt_id=p_attempt;
 IF j.state='succeeded' AND j.terminal_attempt_id=p_attempt AND a.job_id=p_job
    AND a.owner_id=p_owner AND a.lease_epoch=p_epoch AND a.outcome='succeeded'
 THEN
  IF a.output_sha256 IS DISTINCT FROM p_output_sha OR r.expected_output_uri IS DISTINCT FROM p_output_uri THEN
   RETURN public.pq_result('invalid_output',j);
  END IF;
  RETURN public.pq_result('already_succeeded',j,COALESCE(h.published_run_id=r.run_id,false));
 END IF;
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RETURN public.pq_result('fenced',j); END IF;
 -- Admission target is data. /1 enqueue fixes it to public-fixture input; Q21 may change only that assignment.
 IF p_output_sha IS DISTINCT FROM r.expected_output_sha256 OR p_output_uri IS DISTINCT FROM r.expected_output_uri THEN
  RETURN public.pq_result('invalid_output',j);
 END IF;
 UPDATE public.polis_queue_attempts SET outcome='succeeded',ended_at=clock_timestamp(),output_sha256=p_output_sha
 WHERE env=p_env AND attempt_id=p_attempt;
 UPDATE public.polis_queue_jobs SET state='succeeded',terminal_attempt_id=p_attempt,owner_id=NULL,attempt_id=NULL,locked_until=NULL,
  version=version+1,mgmt_version=mgmt_version+1,updated_at=clock_timestamp(),output_sha256=p_output_sha WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 UPDATE public.polis_queue_runs SET state='succeeded',output_sha256=p_output_sha WHERE env=p_env AND run_id=r.run_id;
 IF public.pq_publish_allowed(h,r) THEN
  UPDATE public.polis_queue_heads SET published_run_id=r.run_id,published_generation=r.requested_generation,
   published_sha256=p_output_sha,version=version+1 WHERE env=p_env AND product_key=r.product_key;
  moved=true;
 END IF;
 RETURN public.pq_result('succeeded',j,moved);
END $$;
CREATE OR REPLACE FUNCTION public.pq_end_attempt(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_action text,p_error text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; s text;
BEGIN
 j=public.pq_lock(p_env,p_job,false,false);
 IF j.stage<>'noop' THEN RAISE EXCEPTION 'use /2 exit-proof transition'; END IF;
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RETURN public.pq_result('fenced',j); END IF;
 IF p_action NOT IN ('retry','permanent','release','park') THEN RAISE EXCEPTION 'invalid transition' USING ERRCODE='22023'; END IF;
 s=CASE WHEN p_action='park' THEN 'parked' WHEN p_action='permanent' OR j.attempt_count-j.parked_attempt_count>=j.max_attempts THEN 'dead' ELSE 'retry_wait' END;
 j=public.pq_terminate_attempt(j,s,s,p_error,p_action='release');
 RETURN public.pq_result(s,j);
END $$;
CREATE OR REPLACE FUNCTION public.pq_reap_one(p_env text,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; s text;
BEGIN
 j=public.pq_lock(p_env,p_job,true,false); IF j.job_id IS NULL THEN RETURN NULL; END IF;
 IF j.stage<>'noop' AND j.state='running' AND j.locked_until<=clock_timestamp() THEN
  j=public.pq_terminate_attempt(j,'parked','expired','exit_unconfirmed');
  UPDATE public.polis_queue_jobs SET parked_attempt_count=parked_attempt_count-1 WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
  RETURN public.pq_result('parked',j);
 END IF;
 IF j.stage<>'noop' AND (
 EXISTS(SELECT 1 FROM public.polis_queue_attempts WHERE env=p_env AND job_id=p_job AND process_exit_confirmed_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.delphi_provider_requests WHERE env=p_env AND job_id=p_job AND state IN ('intent','submission_unknown')))
 THEN RETURN NULL; END IF;
 IF j.state='running' AND j.locked_until<=clock_timestamp() THEN
  s=CASE WHEN j.attempt_count-j.parked_attempt_count>=j.max_attempts THEN 'dead' ELSE 'retry_wait' END;
  j=public.pq_terminate_attempt(j,s,'expired','lease_expired');
 ELSIF j.state='parked' AND j.eligible_at<=clock_timestamp() THEN
  s=CASE WHEN j.attempt_count-j.parked_attempt_count>=j.max_attempts THEN 'dead' ELSE 'queued' END;
  UPDATE public.polis_queue_jobs SET state=s,version=version+1,mgmt_version=mgmt_version+1,updated_at=clock_timestamp() WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 ELSIF j.state IN ('queued','retry_wait') AND j.attempt_count-j.parked_attempt_count>=j.max_attempts THEN
  s='dead';
  UPDATE public.polis_queue_jobs SET state=s,version=version+1,mgmt_version=mgmt_version+1,last_error_code='attempt_budget_exhausted',updated_at=clock_timestamp() WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 ELSE RETURN NULL;
 END IF;
 IF s='dead' THEN UPDATE public.polis_queue_runs SET state='dead' WHERE env=p_env AND run_id=j.run_id; END IF;
 RETURN public.pq_result(s,j);
END $$;

-- Explicit /2 bounded reaper; /1 discovery remains noop-only.
CREATE FUNCTION public.pq_reap(p_env text,p_after_job uuid,p_limit integer,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE id uuid; reply jsonb; last_id uuid; scanned integer=0; results jsonb='[]'::jsonb;
BEGIN
 IF p_worker_class IS DISTINCT FROM 'delphi' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'invalid reap bound or worker class'; END IF;
 FOR id IN SELECT q.job_id FROM public.polis_queue_jobs q
 WHERE q.env=p_env AND q.worker_class=p_worker_class AND (p_after_job IS NULL OR q.job_id>p_after_job)
 AND ((q.state='running' AND q.locked_until<=statement_timestamp()) OR
 (q.state='parked' AND q.eligible_at<=statement_timestamp()) OR
 (q.state IN ('queued','retry_wait') AND q.attempt_count-q.parked_attempt_count>=q.max_attempts))
 ORDER BY q.job_id LIMIT p_limit LOOP
  last_id=id; scanned=scanned+1;
  reply=public.pq_reap_one(p_env,id);
  IF reply IS NOT NULL THEN results=results||jsonb_build_array(reply); END IF;
 END LOOP;
 RETURN jsonb_build_object('schema_version','polis-queue/2','outcome','reap_page',
 'next_after_job_id',CASE WHEN scanned<p_limit THEN NULL ELSE last_id END,'transitions',results);
END $$;

DO $$ DECLARE f record; t record; BEGIN
 FOR f IN SELECT oid::regprocedure name FROM pg_proc WHERE pronamespace='public'::regnamespace AND (starts_with(proname,'pd_') OR starts_with(proname,'pq_')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,polis_queue_executor',f.name);
 END LOOP;
 FOR t IN SELECT oid::regclass name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'
 AND (starts_with(relname,'delphi_') OR relname='polis_queue_logs') LOOP
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,polis_queue_executor',t.name);
 END LOOP;
END $$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure name FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND proname IN ('pq_enqueue','pq_claim','pq_heartbeat','pq_finalize','pq_fail','pq_release','pq_park',
 'pq_due','pq_reap_one','pq_cancel','pq_job_status','pq_head_status','pq_attempt_logs',
 'pd_enqueue','pd_release_scope','pd_job_view','pd_provider_intent','pd_provider_update') LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO polis_queue_executor',f.name);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.pq_end_attempt(text,uuid,uuid,uuid,bigint,text,text,boolean,timestamptz) TO polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pq_reap(text,uuid,integer,text) TO polis_queue_executor;
GRANT INSERT ON public.polis_queue_logs TO polis_queue_executor;
GRANT SELECT(contract_version) ON public.polis_queue_install TO polis_queue_executor;

CREATE TABLE public.delphi_foundation_install (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), baseline jsonb NOT NULL, installed jsonb NOT NULL
);
REVOKE ALL ON public.delphi_foundation_install FROM PUBLIC,polis_queue_executor;
INSERT INTO public.delphi_foundation_install VALUES(true,current_setting('delphi.baseline')::jsonb,pg_temp.pd_state());
COMMIT;
