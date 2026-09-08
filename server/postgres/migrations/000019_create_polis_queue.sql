-- 000019_create_polis_queue.sql
--
-- P-024 Postgres queue substrate, contract polis-queue/1, first slice: noop only.
-- Design: cost-reduction/04-plans/P-024-queue-substrate.md (revision 4).
-- Content below is cost-reduction/04-plans/P-024-queue-substrate-v1.sql, which
-- carries the round-4 review's H1 overload guard and the catalog fingerprint
-- guards. Three additions are made here, each numbered and marked in place:
-- the post-apply signature assertion, the explicit granted-RPC allowlist
-- assertion, and the observed-state DETAIL on a drift abort.
--
-- HOW TO APPLY
-- ------------
-- Apply THIS FILE ALONE, manually, on a pinned read-write connection, exactly as
-- docs/migrations.md describes for a post-provisioning migration:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
--     < server/postgres/migrations/000019_create_polis_queue.sql
--
-- Never replay the migrations directory as an upgrade mechanism:
-- server/bin/run-migrations.sh has no version ledger and the existing files in
-- this directory are not replay-safe. (This file is; see IDEMPOTENCE below.)
-- On a fresh container the postgres image applies it once from
-- /docker-entrypoint-initdb.d, in file-name order, as the superuser.
--
-- APPLIER REQUIREMENTS
-- --------------------
-- This is the first migration in this repository that creates roles and
-- transfers object ownership, so the applying login must be able to SET ROLE to
-- the object owner. Concretely:
--   * On a first apply that must create the roles: CREATEROLE (or superuser).
--   * On every apply: SET-capable membership in polis_queue_owner. PostgreSQL 17
--     lets a role creator hold ADMIN without SET, so this file grants itself
--     WITH SET TRUE when it is allowed to; an applier that is only a member
--     WITHOUT SET fails with a readable precondition instead of half-applying.
--   * public schema USAGE and CREATE, both WITH GRANT OPTION, and
--     public.conversations SELECT, UPDATE(topic) and REFERENCES(zid), all WITH
--     GRANT OPTION (owning conversations satisfies this).
-- polis_queue_owner and polis_queue_executor are NOLOGIN. Provisioning a service
-- login into polis_queue_executor is separate, separately reviewed work; this
-- migration creates no login role and stores no password.
--
-- IDEMPOTENCE AND DRIFT
-- ---------------------
-- Re-running this file against the schema it created is safe: CREATE ... IF NOT
-- EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE
-- TRIGGER, and idempotent GRANT/ALTER OWNER. It does NOT repair or bless an
-- incompatible pre-existing object. The guards below fingerprint the enumerated
-- catalog metadata (columns with types/defaults/collations/ACLs, constraints,
-- indexes, triggers, ownership, table options, RLS, and every pq_ signature,
-- result, default, language, volatility, config, owner and ACL) before the DDL
-- runs and again after it, and abort the transaction on any difference. The
-- fingerprints are pinned to PostgreSQL 17 deparse output with a fixed
-- search_path; changing the schema means regenerating them in the same reviewed
-- change. See docs/queue-substrate.md.
--
-- SCOPE
-- -----
-- Installing this schema wires nothing. No route calls it; the Node helper that
-- does is behind POLIS_QUEUE_SUBSTRATE_ENABLED, default off. stage is CHECK'd to
-- 'noop' and contract_version to 'polis-queue/1'; admitting a real stage or a /2
-- wire needs its own reviewed migration. Gates A1-A8 in the design document are
-- open: nothing here is certified against a deployed conversations schema, no
-- COMMIT has been severed, and there is no backup/restore rehearsal yet.

BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreaterole))
    AND (NOT EXISTS (SELECT FROM pg_roles WHERE rolname='polis_queue_owner')
      OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname='polis_queue_executor')) THEN
  RAISE EXCEPTION 'queue migration requires CREATEROLE for initial role provisioning';
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='polis_queue_owner') THEN
  CREATE ROLE polis_queue_owner NOLOGIN;
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='polis_queue_executor') THEN
  CREATE ROLE polis_queue_executor NOLOGIN;
 END IF;
 IF NOT pg_has_role(current_user,'polis_queue_owner','SET') THEN
  BEGIN
   GRANT polis_queue_owner TO CURRENT_USER WITH SET TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
   RAISE EXCEPTION 'queue migration requires membership in polis_queue_owner; ask role administrator to grant it';
  END;
 END IF;
 IF NOT has_schema_privilege(current_user,'public','USAGE WITH GRANT OPTION')
    OR NOT has_schema_privilege(current_user,'public','CREATE WITH GRANT OPTION')
    OR NOT has_table_privilege(current_user,'public.conversations','SELECT WITH GRANT OPTION')
    OR NOT has_column_privilege(current_user,'public.conversations','topic','UPDATE WITH GRANT OPTION')
    OR NOT has_column_privilege(current_user,'public.conversations','zid','REFERENCES WITH GRANT OPTION') THEN
  RAISE EXCEPTION 'queue migration requires public schema CREATE and conversations SELECT/UPDATE(topic)/REFERENCES(zid) with grant option';
 END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('polis_queue_owner','polis_queue_executor')
  AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
  RAISE EXCEPTION 'queue catalog drift: owner/executor role attributes';
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO polis_queue_owner WITH GRANT OPTION;
GRANT CREATE ON SCHEMA public TO polis_queue_owner;
GRANT SELECT, REFERENCES(zid), UPDATE(topic) ON public.conversations TO polis_queue_owner;
-- Create AND replay as the object owner, not merely a role allowed to transfer it.
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
-- H1: known unshipped signatures must not survive as ambiguous overloads.
-- No CASCADE: unexpected dependencies fail the transaction for review.
DROP FUNCTION IF EXISTS public.pq_lock(text,uuid,boolean);
DO $$ BEGIN
 IF to_regtype('public.polis_queue_jobs') IS NOT NULL THEN
  DROP FUNCTION IF EXISTS public.pq_terminate_attempt(public.polis_queue_jobs,text,text,text);
 END IF;
END $$;

-- Catalog fingerprints are over the explicitly enumerated metadata below, not
-- data or object OIDs. PostgreSQL 17 and a fixed search_path make them stable.
-- Any changed column/default, CHECK/FK, index, trigger, owner/ACL or table option
-- requires a reviewed migration. IF NOT EXISTS must never bless schema drift.
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
DECLARE expected jsonb='{"polis_queue_attempts": "4bf01840303c3447650ada377d535bee", "polis_queue_heads": "cf987d5673228e6ca6d6f3b86b7e77e5", "polis_queue_jobs": "d8367b8bdaa7701b9c377450d23b5db5", "polis_queue_requests": "cae8fcd4db4562b9936b7d33cf598f1e", "polis_queue_runs": "8e7fd316c23320c229387822146eebec"}'::jsonb;
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
SELECT pg_temp.pq_assert_catalog(true);

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
SELECT pg_temp.pq_assert_signatures(true);
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
SELECT pg_temp.pq_assert_functions(true);



CREATE TABLE IF NOT EXISTS public.polis_queue_runs (
 env text NOT NULL CHECK (env <> ''), run_id uuid NOT NULL,
 zid integer NOT NULL REFERENCES public.conversations(zid),
 product_key text NOT NULL CHECK (product_key <> ''), requested_generation bigint NOT NULL CHECK (requested_generation>0),
 input_uri text NOT NULL CHECK (length(input_uri) BETWEEN 1 AND 2048),
 input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
 expected_output_uri text NOT NULL CHECK(length(expected_output_uri) BETWEEN 1 AND 2048),
 expected_output_sha256 text NOT NULL CHECK(expected_output_sha256 ~ '^[0-9a-f]{64}$'),
 config_sha256 text NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
 code_image_digest text NOT NULL, contract_version text NOT NULL CHECK (contract_version='polis-queue/1'),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','succeeded','dead','cancelled')),
 output_sha256 text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,run_id), UNIQUE(env,product_key,requested_generation),
 -- Required FK target: not redundant with the primary key for product binding.
 UNIQUE(env,product_key,run_id,requested_generation)
);
CREATE TABLE IF NOT EXISTS public.polis_queue_heads (
 env text NOT NULL, product_key text NOT NULL, zid integer NOT NULL REFERENCES public.conversations(zid),
 requested_generation bigint NOT NULL DEFAULT 0 CHECK (requested_generation>=0),
 desired_run_id uuid, published_run_id uuid, published_generation bigint NOT NULL DEFAULT 0,
 published_sha256 text, version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 PRIMARY KEY(env,product_key),
 FOREIGN KEY(env,product_key,desired_run_id,requested_generation)
  REFERENCES public.polis_queue_runs(env,product_key,run_id,requested_generation) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(env,product_key,published_run_id,published_generation)
  REFERENCES public.polis_queue_runs(env,product_key,run_id,requested_generation) DEFERRABLE INITIALLY DEFERRED,
 CHECK ((published_run_id IS NULL AND published_generation=0 AND published_sha256 IS NULL)
     OR (published_run_id IS NOT NULL AND published_generation>0 AND published_sha256 ~ '^[0-9a-f]{64}$')),
 CHECK(published_generation<=requested_generation)
);
CREATE TABLE IF NOT EXISTS public.polis_queue_jobs (
 env text NOT NULL, job_id uuid NOT NULL, run_id uuid NOT NULL,
 stage text NOT NULL CHECK(stage='noop'), stage_instance text,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retry_wait','parked','succeeded','dead','cancelled')),
 priority smallint NOT NULL CHECK(priority BETWEEN 0 AND 2), eligible_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 parked_attempt_count integer NOT NULL DEFAULT 0 CHECK(parked_attempt_count>=0 AND parked_attempt_count<=attempt_count), max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 100),
 lease_epoch bigint NOT NULL DEFAULT 0 CHECK(lease_epoch>=0), version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 mgmt_version bigint NOT NULL DEFAULT 0 CHECK(mgmt_version>=0),
 owner_id uuid, attempt_id uuid, locked_until timestamptz, terminal_attempt_id uuid,
 first_parked_at timestamptz,
 last_error_code text, output_sha256 text,
 PRIMARY KEY(env,job_id), FOREIGN KEY(env,run_id) REFERENCES public.polis_queue_runs(env,run_id),
 UNIQUE NULLS NOT DISTINCT(env,run_id,stage,stage_instance),
 CHECK ((state='running' AND owner_id IS NOT NULL AND attempt_id IS NOT NULL AND locked_until IS NOT NULL)
     OR (state<>'running' AND owner_id IS NULL AND attempt_id IS NULL AND locked_until IS NULL)),
 CHECK(attempt_count-parked_attempt_count<=max_attempts)
) WITH (fillfactor=80, autovacuum_vacuum_threshold=50, autovacuum_vacuum_scale_factor=0.05);
CREATE TABLE IF NOT EXISTS public.polis_queue_attempts (
 env text NOT NULL, attempt_id uuid NOT NULL, job_id uuid NOT NULL, owner_id uuid NOT NULL,
 lease_epoch bigint NOT NULL CHECK(lease_epoch>0), started_at timestamptz NOT NULL DEFAULT clock_timestamp(), ended_at timestamptz,
 outcome text NOT NULL CHECK(outcome IN ('running','succeeded','retry_wait','parked','dead','cancelled','expired')),
 error_code text, output_sha256 text,
 PRIMARY KEY(env,attempt_id), UNIQUE(env,job_id,lease_epoch),
 FOREIGN KEY(env,job_id) REFERENCES public.polis_queue_jobs(env,job_id)
);
CREATE TABLE IF NOT EXISTS public.polis_queue_requests (
 env text NOT NULL, actor_scope text NOT NULL, product_key text NOT NULL, request_key text NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 run_id uuid NOT NULL, job_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,actor_scope,product_key,request_key),
 FOREIGN KEY(env,run_id) REFERENCES public.polis_queue_runs(env,run_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(env,job_id) REFERENCES public.polis_queue_jobs(env,job_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(length(actor_scope) BETWEEN 1 AND 256 AND length(request_key) BETWEEN 1 AND 256)
);
CREATE INDEX IF NOT EXISTS polis_queue_ready ON public.polis_queue_jobs(env,priority,eligible_at,created_at,job_id)
 WHERE state IN ('queued','retry_wait') AND attempt_count-parked_attempt_count<max_attempts;
-- No heartbeat-mutated column in a key or predicate: HOT-eligible, not guaranteed HOT.
CREATE INDEX IF NOT EXISTS polis_queue_running ON public.polis_queue_jobs(env,job_id) WHERE state='running';
CREATE INDEX IF NOT EXISTS polis_queue_exhausted ON public.polis_queue_jobs(env,job_id) WHERE state IN ('queued','retry_wait') AND attempt_count-parked_attempt_count>=max_attempts;
CREATE INDEX IF NOT EXISTS polis_queue_parked ON public.polis_queue_jobs(env,eligible_at,job_id) WHERE state='parked';
CREATE INDEX IF NOT EXISTS polis_queue_heads_zid ON public.polis_queue_heads(zid);
CREATE INDEX IF NOT EXISTS polis_queue_runs_zid ON public.polis_queue_runs(zid);
CREATE INDEX IF NOT EXISTS polis_queue_runs_history ON public.polis_queue_runs(env,zid,created_at,run_id);
CREATE INDEX IF NOT EXISTS polis_queue_requests_run ON public.polis_queue_requests(env,run_id);
CREATE INDEX IF NOT EXISTS polis_queue_requests_job ON public.polis_queue_requests(env,job_id);

CREATE OR REPLACE FUNCTION public.pq_no_regression() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
BEGIN
 IF NEW.requested_generation<OLD.requested_generation OR NEW.published_generation<OLD.published_generation THEN
  RAISE EXCEPTION 'queue pointer generation regression' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pq_no_regression ON public.polis_queue_heads;
CREATE TRIGGER pq_no_regression BEFORE UPDATE ON public.polis_queue_heads FOR EACH ROW EXECUTE FUNCTION public.pq_no_regression();

-- Fixed JSON wire schema: see the companion MD. No SELECT * escapes this boundary.
CREATE OR REPLACE FUNCTION public.pq_result(p_outcome text, j public.polis_queue_jobs, p_published boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('schema_version','polis-queue/1','outcome',p_outcome,
  'env',j.env,'job_id',j.job_id,'run_id',j.run_id,
  'attempt_id',COALESCE(j.attempt_id,j.terminal_attempt_id),'owner_id',j.owner_id,
  'lease_epoch',j.lease_epoch::text,'version',j.version::text,'mgmt_version',j.mgmt_version::text,'locked_until',j.locked_until,
  'state',j.state,'output_sha256',j.output_sha256,'published',COALESCE(p_published,false),
  'stage',j.stage,'stage_instance',j.stage_instance,'attempt_count',j.attempt_count,'max_attempts',j.max_attempts,'parked_attempt_count',j.parked_attempt_count,
  'eligible_at',j.eligible_at,'first_parked_at',j.first_parked_at,'last_error_code',j.last_error_code,
  'input',(SELECT jsonb_build_object('uri',r.input_uri,'sha256',r.input_sha256,'config_sha256',r.config_sha256,'code_image_digest',r.code_image_digest) FROM public.polis_queue_runs r WHERE r.env=j.env AND r.run_id=j.run_id))
$$;
CREATE OR REPLACE FUNCTION public.pq_backoff(p_attempt uuid,p_count integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT LEAST(300,5*(1 << LEAST(GREATEST(p_count-1,0),6)))
  + get_byte(decode(replace(p_attempt::text,'-',''),'hex'),15)%5
$$;
-- Parent locks first. Reaper may skip a busy parent/job; other callers wait to their deadline.
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
CREATE OR REPLACE FUNCTION public.pq_owns(j public.polis_queue_jobs,p_owner uuid,p_attempt uuid,p_epoch bigint) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT COALESCE(j.state='running' AND j.owner_id=p_owner AND j.attempt_id=p_attempt
  AND j.lease_epoch=p_epoch AND j.locked_until>clock_timestamp(),false)
$$;

-- 1. Enqueue: all IDs/digests are application-supplied and authenticated before this call.
CREATE OR REPLACE FUNCTION public.pq_enqueue(p_env text,p_zid integer,p_product text,p_actor text,p_key text,p_request_sha text,
 p_run uuid,p_job uuid,p_input_uri text,p_input_sha text,p_config_sha text,p_image text,p_priority smallint,p_max_attempts integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE h public.polis_queue_heads; q public.polis_queue_requests; j public.polis_queue_jobs; n integer; g bigint;
BEGIN
 PERFORM 1 FROM public.conversations c WHERE c.zid=p_zid FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown conversation' USING ERRCODE='23503'; END IF;
 INSERT INTO public.polis_queue_requests(env,actor_scope,product_key,request_key,request_sha256,run_id,job_id)
 VALUES(p_env,p_actor,p_product,p_key,p_request_sha,p_run,p_job)
 ON CONFLICT(env,actor_scope,product_key,request_key) DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n=0 THEN
  SELECT x.* INTO q FROM public.polis_queue_requests x WHERE x.env=p_env AND x.actor_scope=p_actor AND x.product_key=p_product AND x.request_key=p_key;
  SELECT x.* INTO j FROM public.polis_queue_jobs x WHERE x.env=p_env AND x.job_id=q.job_id;
  RETURN public.pq_result(CASE WHEN q.request_sha256=p_request_sha THEN 'existing' ELSE 'conflict' END,j);
 END IF;
 INSERT INTO public.polis_queue_heads(env,product_key,zid) VALUES(p_env,p_product,p_zid) ON CONFLICT DO NOTHING;
 SELECT x.* INTO h FROM public.polis_queue_heads x WHERE x.env=p_env AND x.product_key=p_product FOR UPDATE;
 IF h.product_key IS NULL THEN RAISE EXCEPTION 'missing reserved product head'; END IF;
 IF h.zid<>p_zid THEN RAISE EXCEPTION 'product conversation mismatch' USING ERRCODE='23514'; END IF;
 g=h.requested_generation+1;
 INSERT INTO public.polis_queue_runs(env,run_id,zid,product_key,requested_generation,input_uri,input_sha256,expected_output_uri,expected_output_sha256,config_sha256,code_image_digest,contract_version)
 VALUES(p_env,p_run,p_zid,p_product,g,p_input_uri,p_input_sha,p_input_uri,p_input_sha,p_config_sha,p_image,'polis-queue/1');
 INSERT INTO public.polis_queue_jobs(env,job_id,run_id,stage,priority,max_attempts)
 VALUES(p_env,p_job,p_run,'noop',p_priority,p_max_attempts) RETURNING * INTO j;
 UPDATE public.polis_queue_heads SET requested_generation=g,desired_run_id=p_run,version=version+1 WHERE env=p_env AND product_key=p_product;
 PERFORM pg_notify('polis_queue_wakeup_v1','{"schema_version":"polis-queue-wakeup/1"}');
 RETURN public.pq_result('enqueued',j);
END $$;

-- 2. Claim: only grants ownership after the caller commits the transaction.
CREATE OR REPLACE FUNCTION public.pq_claim(p_env text,p_priority smallint,p_owner uuid,p_attempt uuid,p_lease_seconds integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs;
BEGIN
 IF p_lease_seconds NOT BETWEEN 10 AND 900 OR p_owner IS NULL OR p_attempt IS NULL THEN RAISE EXCEPTION 'invalid claim arguments' USING ERRCODE='22023'; END IF;
 WITH candidate AS (
  SELECT q.env,q.job_id FROM public.polis_queue_jobs q
  WHERE q.env=p_env AND q.priority=p_priority AND q.state IN ('queued','retry_wait')
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
-- 3. Heartbeat: only current, unexpired ownership renews. Version changes; epoch does not.
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
-- Q20 policy seam, distinct from invariant trigger and ownership checks.
CREATE OR REPLACE FUNCTION public.pq_publish_allowed(h public.polis_queue_heads,r public.polis_queue_runs)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT COALESCE(h.desired_run_id=r.run_id AND h.requested_generation=r.requested_generation
  AND r.requested_generation>=h.published_generation,false)
$$;
-- 4. Finalize and read-back: same successful attempt/digest returns already_succeeded, even after lost ack.
CREATE OR REPLACE FUNCTION public.pq_finalize(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_output_uri text,p_output_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; r public.polis_queue_runs; h public.polis_queue_heads; a public.polis_queue_attempts; moved boolean=false;
BEGIN
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
 -- Admission target is data. /1 enqueue fixes it to synthetic input; Q21 may change only that assignment.
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

-- Internal single terminalization primitive. Caller holds run -> job; never grants this RPC.
-- Policy choices (backoff, publication, reaper driver) stay behind separate helpers for Q20.
CREATE OR REPLACE FUNCTION public.pq_terminate_attempt(j public.polis_queue_jobs,p_state text,p_outcome text,p_error text,p_immediate boolean DEFAULT false)
RETURNS public.polis_queue_jobs LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
BEGIN
 UPDATE public.polis_queue_attempts SET outcome=p_outcome,error_code=p_error,ended_at=clock_timestamp()
 WHERE env=j.env AND attempt_id=j.attempt_id;
 UPDATE public.polis_queue_jobs q SET state=p_state,terminal_attempt_id=j.attempt_id,owner_id=NULL,attempt_id=NULL,locked_until=NULL,
  lease_epoch=q.lease_epoch+1,version=q.version+1,mgmt_version=q.mgmt_version+1,
  parked_attempt_count=q.parked_attempt_count+CASE WHEN p_state='parked' THEN 1 ELSE 0 END,
  first_parked_at=CASE WHEN p_state='parked' THEN COALESCE(q.first_parked_at,clock_timestamp()) ELSE q.first_parked_at END,
  last_error_code=p_error,updated_at=clock_timestamp(),
  eligible_at=clock_timestamp()+make_interval(secs=>CASE WHEN p_immediate THEN 0 ELSE public.pq_backoff(j.attempt_id,j.attempt_count-j.parked_attempt_count) END)
 WHERE q.env=j.env AND q.job_id=j.job_id RETURNING q.* INTO j;
 IF p_state='dead' THEN UPDATE public.polis_queue_runs SET state='dead' WHERE env=j.env AND run_id=j.run_id; END IF;
 RETURN j;
END $$;
-- Shared ownership gate for 5 fail/retry, 6 release, 7 park. End paths can dead a run.
CREATE OR REPLACE FUNCTION public.pq_end_attempt(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_action text,p_error text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; s text;
BEGIN
 j=public.pq_lock(p_env,p_job,false,false);
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RETURN public.pq_result('fenced',j); END IF;
 IF p_action NOT IN ('retry','permanent','release','park') THEN RAISE EXCEPTION 'invalid transition' USING ERRCODE='22023'; END IF;
 s=CASE WHEN p_action='park' THEN 'parked' WHEN p_action='permanent' OR j.attempt_count-j.parked_attempt_count>=j.max_attempts THEN 'dead' ELSE 'retry_wait' END;
 j=public.pq_terminate_attempt(j,s,s,p_error,p_action='release');
 RETURN public.pq_result(s,j);
END $$;
CREATE OR REPLACE FUNCTION public.pq_fail(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_permanent boolean,p_error text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT public.pq_end_attempt($1,$2,$3,$4,$5,CASE WHEN $6 THEN 'permanent' ELSE 'retry' END,$7)
$$;
CREATE OR REPLACE FUNCTION public.pq_release(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT public.pq_end_attempt($1,$2,$3,$4,$5,'release',NULL)
$$;
CREATE OR REPLACE FUNCTION public.pq_park(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_error text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT public.pq_end_attempt($1,$2,$3,$4,$5,'park',$6)
$$;
-- Q20 seams: bounded discovery, single-row primitive, optional in-DB driver.
CREATE OR REPLACE FUNCTION public.pq_due(p_env text,p_after_job uuid,p_limit integer)
RETURNS TABLE(job_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT q.job_id FROM public.polis_queue_jobs q WHERE q.env=p_env AND (p_after_job IS NULL OR q.job_id>p_after_job) AND
  ((q.state='running' AND q.locked_until<=statement_timestamp()) OR
   (q.state='parked' AND q.eligible_at<=statement_timestamp()) OR
   (q.state IN ('queued','retry_wait') AND q.attempt_count-q.parked_attempt_count>=q.max_attempts))
 ORDER BY q.job_id LIMIT LEAST(GREATEST(p_limit,0),100)
$$;
CREATE OR REPLACE FUNCTION public.pq_reap_one(p_env text,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; s text;
BEGIN
 j=public.pq_lock(p_env,p_job,true,false); IF j.job_id IS NULL THEN RETURN NULL; END IF;
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
-- 8. Owner-only dev/compat driver; never grant to the executor.
-- Normative coordinator calls pq_due, commits, then pq_reap_one in one tx per job.
CREATE OR REPLACE FUNCTION public.pq_reap(p_env text,p_after_job uuid DEFAULT NULL,p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE id uuid; result jsonb; last_id uuid; scanned integer=0; results jsonb='[]'::jsonb;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid reap bound' USING ERRCODE='22023'; END IF;
 FOR id IN SELECT d.job_id FROM public.pq_due(p_env,p_after_job,p_limit) d LOOP
  last_id=id; scanned=scanned+1;
  result=public.pq_reap_one(p_env,id);
  IF result IS NOT NULL THEN results=results || jsonb_build_array(result); END IF;
 END LOOP;
 RETURN jsonb_build_object('schema_version','polis-queue/1','outcome','reap_page','next_after_job_id',CASE WHEN scanned<p_limit THEN NULL ELSE last_id END,'transitions',results);
END $$;
-- 9. Cancel: management CAS, distinct from worker ownership. Server authorizes actor/product first.
CREATE OR REPLACE FUNCTION public.pq_cancel(p_env text,p_job uuid,p_expected_mgmt_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs;
BEGIN
 j=public.pq_lock(p_env,p_job);
 IF j.job_id IS NULL OR j.mgmt_version IS DISTINCT FROM p_expected_mgmt_version THEN RETURN public.pq_result('conflict',j); END IF;
 IF j.state IN ('succeeded','dead','cancelled') THEN RETURN public.pq_result('terminal',j); END IF;
 IF j.attempt_id IS NOT NULL THEN
  UPDATE public.polis_queue_attempts SET outcome='cancelled',ended_at=clock_timestamp() WHERE env=p_env AND attempt_id=j.attempt_id;
 END IF;
 UPDATE public.polis_queue_jobs SET state='cancelled',terminal_attempt_id=COALESCE(attempt_id,terminal_attempt_id),owner_id=NULL,attempt_id=NULL,locked_until=NULL,
  lease_epoch=lease_epoch+1,version=version+1,mgmt_version=mgmt_version+1,updated_at=clock_timestamp() WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 UPDATE public.polis_queue_runs SET state='cancelled' WHERE env=p_env AND run_id=j.run_id;
 RETURN public.pq_result('cancelled',j);
END $$;

-- Non-mutating management token and park-age read; authorize job before exposing.
CREATE OR REPLACE FUNCTION public.pq_job_status(p_env text,p_job uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT public.pq_result('job_status',j)
 FROM (SELECT 1) seed LEFT JOIN public.polis_queue_jobs j ON j.env=p_env AND j.job_id=p_job
$$;

-- Authorized internal status read. Public APIs expose only an actor-authorized subset.
CREATE OR REPLACE FUNCTION public.pq_head_status(p_env text,p_product text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('schema_version','polis-queue/1','outcome','head_status',
  'env',p_env,'product_key',p_product,'found',h.product_key IS NOT NULL,
  'desired_run_id',h.desired_run_id,'desired_state',r.state,
  'published_run_id',h.published_run_id,'published_generation',h.published_generation::text,
  'published_sha256',h.published_sha256)
 FROM (SELECT 1) seed LEFT JOIN public.polis_queue_heads h ON h.env=p_env AND h.product_key=p_product
 LEFT JOIN public.polis_queue_runs r ON r.env=h.env AND r.run_id=h.desired_run_id
$$;

SELECT pg_temp.pq_assert_signatures(false);

-- Explicit privilege boundary: no direct writes for executor; helpers not public RPCs.
GRANT USAGE ON SCHEMA public TO polis_queue_owner,polis_queue_executor;
-- UPDATE(topic) above exists solely for parent FOR KEY SHARE; never grant UPDATE(zid).
DO $$ DECLARE x record; BEGIN
 FOR x IN SELECT c.oid::regclass AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('polis_queue_runs','polis_queue_heads','polis_queue_jobs','polis_queue_attempts','polis_queue_requests')
 LOOP
  EXECUTE format('ALTER TABLE %s OWNER TO polis_queue_owner',x.name);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, polis_queue_executor',x.name);
 END LOOP;
 FOR x IN SELECT p.oid::regprocedure AS name,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('pq_no_regression','pq_publish_allowed','pq_due','pq_reap_one','pq_result','pq_backoff','pq_lock','pq_owns','pq_enqueue','pq_claim','pq_heartbeat','pq_finalize','pq_end_attempt','pq_terminate_attempt','pq_job_status','pq_head_status','pq_fail','pq_release','pq_park','pq_reap','pq_cancel')
 LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO polis_queue_owner',x.name);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, polis_queue_executor',x.name);
  IF x.proname IN ('pq_enqueue','pq_claim','pq_heartbeat','pq_finalize','pq_fail','pq_release','pq_park','pq_due','pq_reap_one','pq_cancel','pq_job_status','pq_head_status') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO polis_queue_executor',x.name);
  END IF;
 END LOOP;
END $$;
SELECT pg_temp.pq_assert_catalog(false);
SELECT pg_temp.pq_assert_functions(false);
-- Migration addition 1: the pre-apply signature assertion above compares the
-- catalog this file inherited. Repeat it after the DDL so a CREATE OR REPLACE in
-- THIS file cannot leave an overload behind either. Without it, H1's failure
-- mode (a stale pq_lock arity making pq_finalize raise "function
-- public.pq_lock(text, uuid) is not unique") would only be caught on the next
-- apply.
SELECT pg_temp.pq_assert_signatures(false);
-- Migration addition 2: name the executor's twelve granted RPCs explicitly. The
-- function fingerprint already covers every ACL, but it reports only that
-- something changed; this reports which grant is missing or extra, which is the
-- distinction an operator needs at 3am.
DO $$
DECLARE granted CONSTANT text[] := ARRAY[
 'pq_cancel','pq_claim','pq_due','pq_enqueue','pq_fail','pq_finalize','pq_head_status',
 'pq_heartbeat','pq_job_status','pq_park','pq_reap_one','pq_release'];
 actual text[];
BEGIN
 SELECT array_agg(p.proname::text ORDER BY p.proname) INTO actual FROM pg_proc p
 WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'pq_')
 AND has_function_privilege('polis_queue_executor',p.oid,'EXECUTE');
 IF actual IS DISTINCT FROM granted THEN
  RAISE EXCEPTION 'queue executor grant drift: expected % got %',granted,COALESCE(actual,'{}');
 END IF;
END $$;
COMMIT;
