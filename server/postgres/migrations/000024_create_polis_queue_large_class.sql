-- 000024_create_polis_queue_large_class.sql
--
-- The large worker class: contract polis-queue/3 on top of 000023's
-- polis-queue/2 (the Delphi job table) and 000019's polis-queue/1 substrate.
-- Design: cost-reduction/04-plans/P-073-r2-queue.md (oversized conversations
-- are jobs on the Postgres queue; decision #350, 2026-10-06). The polis-jobs
-- daemon (queue-rs) claims with a worker class; until this file, the only
-- class a /2 database admitted was `delphi`.
--
-- WHAT IT CHANGES (no new job table; every job table stays empty on apply)
-- -----------------------------------------------------------------------
--   polis_queue_jobs      worker_class admits `large` beside noop and delphi;
--                         stage admits `math_rebuild` beside noop and the two
--                         Delphi stages; a new CHECK (pq_stage_large) binds
--                         math_rebuild to class large and class large to
--                         math_rebuild, as pq_stage_worker binds noop to noop.
--   delphi_jobs           kind admits `math_rebuild` (the logical row behind a
--                         math_rebuild queue row, so the one-active-job-per-
--                         scope guard of 000023 covers it unchanged).
--   polis_queue_runs      contract_version admits `polis-queue/3`; a run
--                         enqueued for math_rebuild is stamped /3.
--   polis_queue_install   contract_version reads `polis-queue/3`.
--   pq_claim (6 args)     takes the class as given: `delphi` or `large`, and
--                         claims only jobs of that class.
--   pq_reap (4 args)      the same two classes.
--   pd_enqueue            admits stage math_rebuild (report id must be null;
--                         scope `math:<label>:<zid>` by convention, one
--                         active root job per scope) under the guards it
--                         already applies to the Delphi stages.
--   pd_queue_binding      binds stage math_rebuild to kind math_rebuild,
--                         class large and contract /3.
--   pq_result             reports schema_version polis-queue/3 for a
--                         math_rebuild job (/1 for noop, /2 for Delphi).
--   pq_class_depth        NEW read, (env, worker_class) -> counts of queued
--                         (queued + retry_wait), leased (running), parked and
--                         dead jobs of that class, and the oldest unresolved
--                         created_at. The small poller's capacity line reads
--                         it; no table grant is needed.
--   pd_enqueue            the poison latch: when the scope's last three jobs
--                         all died under the code image being admitted now,
--                         no fresh job is admitted; the reply is outcome
--                         `poisoned` naming the latest dead job. A different
--                         image (a deploy), or a succeeded or cancelled job
--                         in between, resets it. Without it an automated
--                         producer re-admits a permanent failure forever,
--                         one attempt budget per pass.
--   pd_job_view           gains `scope_key`: the guard the job's root holds
--                         (null once released), so the daemon can name the
--                         scope it releases after a terminal attempt. Who
--                         releases, and when: the polis-jobs daemon, after a
--                         terminal reply whose attempt exit it proved, through
--                         pd_release_scope (which still refuses while any job
--                         of the root's tree is not terminal, lacks exit proof
--                         or has an open provider request); the poller as a
--                         fallback when an admission hands it a terminal job
--                         still holding its guard. Terminal status alone never
--                         releases anything.
--   polis_queue_large_class_install
--                         the catalog baseline this apply recorded, read by
--                         the down script.
-- The /1 noop path and the /2 Delphi path are unchanged in behaviour.
-- Nothing is enqueued by this file; the daemon admits class `large` in a
-- later change, and the poller enqueues in a later change still.
--
-- HOW TO APPLY
-- ------------
-- A fresh container applies it once from /docker-entrypoint-initdb.d in
-- file-name order, after 000023. An existing database needs THIS FILE ALONE,
-- by hand, as docs/migrations.md describes; 000019 and 000023 must already
-- be applied:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
--     < server/postgres/migrations/000024_create_polis_queue_large_class.sql
--
-- Applying it to production is a separate, explicit step by the owner.
--
-- APPLIER REQUIREMENTS
-- --------------------
-- The applying login must be able to SET ROLE polis_queue_owner (the roles
-- come from 000019; this file creates no role and stores no password). It
-- runs in one transaction with lock_timeout 5s and refuses, changing nothing,
-- when: 000023 is absent ("foundation missing"); the installed /2 catalog
-- differs from what 000023 recorded ("queue catalog drift", which is also
-- what a second apply says, since the catalog is then already in /3 shape);
-- or the install table or pq_class_depth already exists ("large class object
-- collision"). Re-applying is therefore NOT a no-op: it is refused. 000019
-- and 000023 both refuse to replay over this schema (their own fingerprint
-- guards), so nothing reverts to /1 or /2 by accident.
--
-- SCOPE
-- -----
-- Installing this schema wires nothing. No code enqueues a math_rebuild job;
-- the polis-jobs daemon refuses POLIS_JOBS_WORKER_CLASS=large until its own
-- change lands, and even then starts only with POLIS_JOBS_ENABLED=1 and is
-- started by no compose service. The large box keeps its present behaviour
-- until the poller change and the enable runbook.
--
-- REVERSAL
-- --------
-- down/000024_drop_polis_queue_large_class.sql restores the /2 catalog
-- exactly as recorded at apply time; it refuses if any /3 row exists (a
-- math_rebuild or class-large job, a math_rebuild delphi_jobs row, a /3 run).
-- Proven by down/test_000024_down.sh against the real chain (forward,
-- backward, re-apply, refusals, and 000023's own down still unwinding after
-- it). Both files are sealed in down/000024-files.sha256; a change to either
-- reseals in the same reviewed change.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
-- pq_catalog and pd_state are 000023's definitions, verbatim, so that the
-- state this file compares against is the one 000023 recorded. OR REPLACE,
-- because a harness that applies the chain in one session still holds
-- 000023's pg_temp functions.
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
CREATE OR REPLACE FUNCTION pg_temp.pd_state() RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $s$
SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,pg_temp.pq_catalog(c.oid)) FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (starts_with(c.relname,'polis_queue_') OR starts_with(c.relname,'delphi_')) AND c.relname<>'delphi_foundation_install'),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_functiondef(p.oid),p.proacl::text,pg_get_userbyid(p.proowner)))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (starts_with(p.proname,'pq_') OR starts_with(p.proname,'pd_'))))
$s$;
-- The /3 state: the same, less this file's own install table.
CREATE OR REPLACE FUNCTION pg_temp.pq3_state() RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $s$
SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,pg_temp.pq_catalog(c.oid)) FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (starts_with(c.relname,'polis_queue_') OR starts_with(c.relname,'delphi_'))
 AND c.relname NOT IN ('delphi_foundation_install','polis_queue_large_class_install')),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_functiondef(p.oid),p.proacl::text,pg_get_userbyid(p.proowner)))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (starts_with(p.proname,'pq_') OR starts_with(p.proname,'pd_'))))
$s$;
DO $$ BEGIN
 IF to_regclass('public.delphi_foundation_install') IS NULL THEN RAISE EXCEPTION 'foundation missing: apply 000023 first'; END IF;
 IF to_regclass('public.polis_queue_large_class_install') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='pq_class_depth') THEN RAISE EXCEPTION 'large class object collision'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.delphi_foundation_install WHERE installed=pg_temp.pd_state()) THEN
  RAISE EXCEPTION 'queue catalog drift: the installed catalog is not the polis-queue/2 shape 000023 recorded';
 END IF;
END $$;
SELECT set_config('queue3.baseline',pg_temp.pq3_state()::text,true);

-- The contract version, the admitted classes, stages and kinds.
ALTER TABLE public.polis_queue_install DROP CONSTRAINT polis_queue_install_contract_version_check;
UPDATE public.polis_queue_install SET contract_version='polis-queue/3';
ALTER TABLE public.polis_queue_install ADD CONSTRAINT polis_queue_install_contract_version_check CHECK(contract_version='polis-queue/3');
ALTER TABLE public.polis_queue_install ALTER COLUMN contract_version SET DEFAULT 'polis-queue/3';
ALTER TABLE public.polis_queue_runs DROP CONSTRAINT polis_queue_runs_contract_version_check;
ALTER TABLE public.polis_queue_runs ADD CONSTRAINT polis_queue_runs_contract_version_check
 CHECK(contract_version IN ('polis-queue/1','polis-queue/2','polis-queue/3'));
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_stage_check
 CHECK(stage IN ('noop','delphi_full_pipeline','delphi_narrative','math_rebuild'));
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_worker_class_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_worker_class_check
 CHECK(worker_class IN ('noop','delphi','large'));
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT pq_stage_large
 CHECK((stage='math_rebuild') = (worker_class='large'));
ALTER TABLE public.delphi_jobs DROP CONSTRAINT delphi_jobs_kind_check;
ALTER TABLE public.delphi_jobs ADD CONSTRAINT delphi_jobs_kind_check
 CHECK(kind IN ('full_pipeline','embed','snapshot','umap','cluster','keywords',
 'topic_name','narrative','collective_statement','visualize','legacy_import','legacy_queue_record','math_rebuild'));

-- A reply names the contract that defines the job's shape: /1 noop, /2 the
-- Delphi stages, /3 math_rebuild.
CREATE OR REPLACE FUNCTION public.pq_result(p_outcome text, j public.polis_queue_jobs, p_published boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('schema_version',CASE WHEN j.stage IS NULL OR j.stage='noop' THEN 'polis-queue/1' WHEN j.stage='math_rebuild' THEN 'polis-queue/3' ELSE 'polis-queue/2' END,'outcome',p_outcome,
  'env',j.env,'job_id',j.job_id,'run_id',j.run_id,
  'attempt_id',COALESCE(j.attempt_id,j.terminal_attempt_id),'owner_id',j.owner_id,
  'lease_epoch',j.lease_epoch::text,'version',j.version::text,'mgmt_version',j.mgmt_version::text,'locked_until',j.locked_until,
  'state',j.state,'output_sha256',j.output_sha256,'published',COALESCE(p_published,false),
  'stage',j.stage,'stage_instance',j.stage_instance,'attempt_count',j.attempt_count,'max_attempts',j.max_attempts,'parked_attempt_count',j.parked_attempt_count,
  'eligible_at',j.eligible_at,'first_parked_at',j.first_parked_at,'last_error_code',j.last_error_code,
  'input',(SELECT jsonb_build_object('uri',r.input_uri,'sha256',r.input_sha256,'config_sha256',r.config_sha256,'code_image_digest',r.code_image_digest) FROM public.polis_queue_runs r WHERE r.env=j.env AND r.run_id=j.run_id))
$$;

-- The class is taken as given (delphi or large); a worker claims only jobs of
-- its class. Everything else is 000023's claim, unchanged.
CREATE OR REPLACE FUNCTION public.pq_claim(p_env text,p_priority smallint,p_owner uuid,p_attempt uuid,p_lease_seconds integer,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.polis_queue_jobs;
BEGIN
 IF p_owner IS NULL OR p_attempt IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 900
 OR p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large') THEN RAISE EXCEPTION 'invalid claim'; END IF;
 WITH candidate AS (
  SELECT q.env,q.job_id FROM public.polis_queue_jobs q JOIN public.delphi_jobs d ON d.env=q.env AND d.job_id=q.job_id
  WHERE q.env=p_env AND q.priority=p_priority AND q.worker_class=p_worker_class
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
 IF NOT FOUND THEN RETURN jsonb_build_object('schema_version',CASE p_worker_class WHEN 'large' THEN 'polis-queue/3' ELSE 'polis-queue/2' END,'outcome','none'); END IF;
 INSERT INTO public.polis_queue_attempts(env,attempt_id,job_id,owner_id,lease_epoch,outcome)
 VALUES(j.env,j.attempt_id,j.job_id,j.owner_id,j.lease_epoch,'running');
 RETURN public.pq_result('owned',j);
END $$;

-- The bounded reaper, per class.
CREATE OR REPLACE FUNCTION public.pq_reap(p_env text,p_after_job uuid,p_limit integer,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE id uuid; reply jsonb; last_id uuid; scanned integer=0; results jsonb='[]'::jsonb;
BEGIN
 IF p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
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
 RETURN jsonb_build_object('schema_version',CASE p_worker_class WHEN 'large' THEN 'polis-queue/3' ELSE 'polis-queue/2' END,'outcome','reap_page',
 'next_after_job_id',CASE WHEN scanned<p_limit THEN NULL ELSE last_id END,'transitions',results);
END $$;

-- Admission: 000023's pd_enqueue with stage math_rebuild admitted. A
-- math_rebuild job has no report id, is kind math_rebuild, class large, and
-- its run is stamped polis-queue/3. The scope guard (one active root job per
-- scope; an identical active admission returns the existing job) is the one
-- the Delphi stages use; the scope for a rebuild is `math:<label>:<zid>` by
-- convention, and the guard binds it to the one zid it was admitted for.
CREATE OR REPLACE FUNCTION public.pd_enqueue(p_env text,p_zid integer,p_product text,p_actor text,p_key text,p_request_sha text,
 p_run uuid,p_job uuid,p_input_uri text,p_input_sha text,p_config_sha text,p_image text,p_priority smallint,p_max_attempts integer,
 p_stage text,p_report text,p_scope text,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE g public.delphi_job_guards; j public.polis_queue_jobs; alias public.polis_queue_requests; reply jsonb; v_kind text; v_class text; v_contract text; v_dead integer;
BEGIN
 IF p_stage IS NULL OR p_stage NOT IN ('delphi_full_pipeline','delphi_narrative','math_rebuild') OR p_scope IS NULL OR p_scope=''
 OR p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR (p_stage='delphi_narrative' AND COALESCE(p_report,'')='')
 OR (p_stage='math_rebuild' AND p_report IS NOT NULL)
 THEN RAISE EXCEPTION 'invalid admission'; END IF;
 v_kind=CASE p_stage WHEN 'delphi_narrative' THEN 'narrative' WHEN 'math_rebuild' THEN 'math_rebuild' ELSE 'full_pipeline' END;
 v_class=CASE p_stage WHEN 'math_rebuild' THEN 'large' ELSE 'delphi' END;
 v_contract=CASE p_stage WHEN 'math_rebuild' THEN 'polis-queue/3' ELSE 'polis-queue/2' END;
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
   AND d.report_id IS NOT DISTINCT FROM p_report AND d.kind=v_kind)
   OR NOT EXISTS(SELECT 1 FROM public.polis_queue_runs r WHERE r.env=p_env AND r.run_id=j.run_id AND r.product_key=p_product)
   THEN RAISE EXCEPTION 'scope binding mismatch'; END IF;
  IF g.request_sha256<>p_request_sha THEN RETURN public.pq_result('conflict',j); END IF;
  INSERT INTO public.polis_queue_requests(env,actor_scope,product_key,request_key,request_sha256,run_id,job_id,binding_expires_at)
   VALUES(p_env,p_actor,p_product,p_key,p_request_sha,j.run_id,j.job_id,clock_timestamp()+interval '24 hours');
  RETURN public.pq_result('existing',j);
 END IF;
 -- The poison latch (no guard is held): the scope's last three jobs all dead
 -- under the image being admitted now means no fresh job; the reply names the
 -- latest dead job. A new image, or any succeeded or cancelled job among the
 -- last three, admits again. The runs' (env,zid,created_at) index serves it.
 SELECT count(*) FILTER (WHERE t.state='dead' AND t.image=p_image) INTO v_dead FROM (
  SELECT q.state,r.code_image_digest AS image FROM public.polis_queue_runs r
  JOIN public.polis_queue_jobs q ON q.env=r.env AND q.run_id=r.run_id
  WHERE r.env=p_env AND r.zid=p_zid AND r.product_key=p_product
  ORDER BY r.created_at DESC,r.run_id DESC LIMIT 3) t;
 IF v_dead>=3 THEN
  SELECT q.* INTO j FROM public.polis_queue_runs r JOIN public.polis_queue_jobs q ON q.env=r.env AND q.run_id=r.run_id
  WHERE r.env=p_env AND r.zid=p_zid AND r.product_key=p_product ORDER BY r.created_at DESC,r.run_id DESC LIMIT 1;
  RETURN public.pq_result('poisoned',j);
 END IF;
 reply=public.pq_enqueue(p_env,p_zid,p_product,p_actor,p_key,p_request_sha,p_run,p_job,p_input_uri,p_input_sha,p_config_sha,p_image,p_priority,p_max_attempts);
 IF reply->>'outcome'<>'enqueued' THEN RAISE EXCEPTION 'unexpected admission conflict'; END IF;
 UPDATE public.polis_queue_runs SET contract_version=v_contract WHERE env=p_env AND run_id=p_run;
 INSERT INTO public.delphi_jobs(job_id,env,zid,report_id,kind,run_id,origin,status,config_effective,code_version)
 VALUES(p_job,p_env,p_zid,p_report,v_kind,p_run,'queued','queued',p_config,p_image);
 UPDATE public.polis_queue_jobs SET stage=p_stage,worker_class=v_class WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 INSERT INTO public.delphi_job_guards VALUES(p_env,p_scope,p_zid,p_job,p_request_sha);
 UPDATE public.polis_queue_requests SET binding_expires_at=clock_timestamp()+interval '24 hours'
 WHERE env=p_env AND actor_scope=p_actor AND product_key=p_product AND request_key=p_key;
 RETURN public.pq_result('enqueued',j);
END $$;

-- The logical/execution binding, with the math_rebuild row bound to its kind,
-- its class and its contract.
CREATE OR REPLACE FUNCTION public.pd_queue_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.polis_queue_jobs; j public.delphi_jobs; r public.polis_queue_runs;
BEGIN
 SELECT * INTO q FROM public.polis_queue_jobs WHERE env=NEW.env AND job_id=NEW.job_id;
 IF q.stage='noop' THEN RETURN NULL; END IF;
 SELECT * INTO j FROM public.delphi_jobs WHERE env=q.env AND job_id=q.job_id;
 SELECT * INTO r FROM public.polis_queue_runs WHERE env=q.env AND run_id=q.run_id;
 IF j.job_id IS NULL OR j.zid<>r.zid OR j.origin<>'queued' OR j.run_id IS DISTINCT FROM q.run_id
 OR r.contract_version<>(CASE WHEN q.stage='math_rebuild' THEN 'polis-queue/3' ELSE 'polis-queue/2' END)
 OR (q.stage='delphi_full_pipeline' AND j.kind<>'full_pipeline')
 OR (q.stage='delphi_narrative' AND j.kind<>'narrative')
 OR (q.stage='math_rebuild' AND (j.kind<>'math_rebuild' OR q.worker_class<>'large' OR j.report_id IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid logical execution binding'; END IF;
 RETURN NULL;
END $$;

-- The job view with the scope its root job holds (null once released):
-- 000023's pd_job_view plus `scope_key`, so the daemon can name the scope it
-- releases through pd_release_scope after a terminal attempt.
CREATE OR REPLACE FUNCTION public.pd_job_view(p_env text,p_job uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.pq_result('job_status',q)||jsonb_build_object('kind',j.kind,'report_id',j.report_id,
 'manifest_sha256',encode(j.output_manifest_digest,'hex'),'manifest_uri',CASE WHEN q.state='succeeded' THEN r.expected_output_uri END,
 'scope_key',(SELECT g.scope_key FROM public.delphi_job_guards g WHERE g.env=q.env AND g.root_job_id=q.job_id LIMIT 1),
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

-- The class depth read: what the scale-out and scale-in signals are made of.
-- `queued` is demand (queued + retry_wait), `leased` is busy (running);
-- parked and dead are reported so an operator sees what waits on exit proof
-- or a ruling. The oldest unresolved created_at is the age signal.
CREATE FUNCTION public.pq_class_depth(p_env text,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE c record;
BEGIN
 IF p_env IS NULL OR p_env='' OR p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large')
 THEN RAISE EXCEPTION 'invalid class depth read'; END IF;
 SELECT count(*) FILTER (WHERE q.state IN ('queued','retry_wait')) AS queued,
  count(*) FILTER (WHERE q.state='running') AS leased,
  count(*) FILTER (WHERE q.state='parked') AS parked,
  count(*) FILTER (WHERE q.state='dead') AS dead,
  min(q.created_at) FILTER (WHERE q.state NOT IN ('succeeded','dead','cancelled')) AS oldest
 INTO c FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.worker_class=p_worker_class;
 RETURN jsonb_build_object('schema_version','polis-queue/3','outcome','class_depth','env',p_env,'worker_class',p_worker_class,
  'queued',c.queued,'leased',c.leased,'parked',c.parked,'dead',c.dead,'oldest_unresolved_created_at',c.oldest);
END $$;
REVOKE ALL ON FUNCTION public.pq_class_depth(text,text) FROM PUBLIC,polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pq_class_depth(text,text) TO polis_queue_executor;

CREATE TABLE public.polis_queue_large_class_install (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), baseline jsonb NOT NULL, installed jsonb NOT NULL
);
REVOKE ALL ON public.polis_queue_large_class_install FROM PUBLIC,polis_queue_executor;
INSERT INTO public.polis_queue_large_class_install VALUES(true,current_setting('queue3.baseline')::jsonb,pg_temp.pq3_state());
COMMIT;
