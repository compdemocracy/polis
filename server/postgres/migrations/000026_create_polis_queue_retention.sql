-- 000026_create_polis_queue_retention.sql
--
-- Retention and restart-safe reads for the Postgres job queue, on top of
-- 000024 (polis-queue/3, the large worker class). Plans: cost-reduction
-- P-083 (retention), P-086 (observability), P-082 (scheduling). 000025 is
-- held by the vote-convention migration (#2944), so this file is 000026.
--
-- WHAT IT CHANGES (no job table changes shape; every job table stays empty)
-- -----------------------------------------------------------------------
--   pq_class_depth        gains `oldest_eligible_at`: the eligible_at of the
--                         oldest job a worker of the class could claim now
--                         (queued or retry_wait, budget left, eligible), not
--                         its created_at. The reply says schema_version
--                         polis-queue/4. Every other field is unchanged.
--   pq_class_parked       NEW read, (env, worker_class, after_job, limit) ->
--                         one page of the class's parked jobs, each with the
--                         attempts whose process exit is not yet proven. A
--                         daemon rebuilds its watch set from this at start
--                         and on every reaper tick, so a parked job outlives
--                         the process that saw it park.
--   pq_queue_usage        NEW read, (env) -> the bytes the queue and job
--                         tables hold (pg_total_relation_size, every env) and
--                         when this env's last sweep finished (an abandoned
--                         sweep does not count). The small
--                         poller's capacity line reads it; no table grant.
--   pq_sweep              NEW, (env, sweep_id, page, max_pages) -> deletes ONE
--                         bounded page of expired queue history (rules below)
--                         and records it in polis_queue_sweeps. A daemon calls
--                         it page by page, one transaction per page.
--   polis_queue_sweeps    NEW table: one row per sweep (start, finish, pages,
--                         what stopped it, counts). The sweep keeps 90 days
--                         of it. No grant: read through pq_queue_usage.
--   three indexes         polis_queue_jobs (env, updated_at, job_id) over
--                         terminal jobs; polis_queue_attempts (env, ended_at,
--                         attempt_id) over ended attempts;
--                         polis_queue_requests (env, binding_expires_at) over
--                         bindings that expire. The sweep's three scans.
--   polis_queue_retention_install
--                         the catalog baseline this apply recorded, read by
--                         the down script.
-- polis_queue_install.contract_version stays polis-queue/3: no existing reply
-- other than pq_class_depth changes, and no daemon or poller has to move to
-- run on this schema. The depth reply's new version tells a reader which
-- shape it holds.
--
-- RETENTION (pq_sweep; P-083's bounds, per env)
-- ---------------------------------------------
--   Log rows (stdout, stderr, truncated) of an attempt that succeeded go 7
--   days after it ended; of any other ended attempt, 30 days. The manifest row
--   stays with its attempt until the job goes. At most 50,000 log rows a page.
--   Request bindings go 1 day after binding_expires_at (a binding without an
--   expiry is never touched). At most 5,000 a page.
--   A job goes, with its attempts, its remaining logs, its closed provider
--   requests, its consumer edges, its request rows, its logical row and its
--   queue row (and its run once nothing references the run), when it is
--   succeeded or cancelled and last changed 30 days ago, or dead and last
--   changed 90 days ago, AND none of these keeps it: pinned; an alias; a
--   delphi_current pointer; the root of a held scope guard; its run is a
--   head's desired or published run; an attempt without exit proof; an open
--   provider request; it produces an input of another job; it is the parent
--   of another job; it is the latest succeeded job of its product (the result
--   promotion is authorized by). At most 200 jobs a page.
--   Sweep rows go 90 days after they finished.
-- A page that deleted nothing on every count finishes the sweep; a page that
-- reaches max_pages finishes it as `budget`. A sweep runs at most once per 24
-- hours per env (`not_due`); a second sweeper while one is in progress is
-- told `busy`; a sweep left unfinished for an hour is closed as `abandoned`.
-- Deletion is irreversible by design; nothing here touches conversations,
-- votes, comments or math results.
--
-- HOW TO APPLY
-- ------------
-- A fresh container applies it once from /docker-entrypoint-initdb.d in
-- file-name order, after 000024. An existing database needs THIS FILE ALONE,
-- by hand; 000019, 000023 and 000024 must already be applied:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
--     < server/postgres/migrations/000026_create_polis_queue_retention.sql
--
-- Applying it to production is a separate, explicit step by the owner. It
-- takes no lock on conversations or any table outside the queue: it creates
-- three indexes on queue tables (SHARE lock on those tables until COMMIT, so
-- queue writes wait; reads continue), one table and four functions.
--
-- APPLIER REQUIREMENTS
-- --------------------
-- The applying login must be able to SET ROLE polis_queue_owner. It runs in
-- one transaction with lock_timeout 5s and refuses, changing nothing, when:
-- 000024 is absent ("large class missing"); the installed /3 catalog differs
-- from what 000024 recorded ("queue catalog drift", which is also what a
-- second apply says); or one of this file's objects already exists
-- ("retention object collision"). 000019, 000023 and 000024 all refuse to
-- replay over this schema (their own fingerprint guards).
--
-- REVERSAL
-- --------
-- down/000026_drop_polis_queue_retention.sql restores the /3 catalog exactly
-- as recorded at apply time; it refuses while polis_queue_sweeps holds a row
-- (a sweep has run, and its deletions cannot be undone). Proven by
-- down/test_000026_down.sh against the real chain. Both files are sealed in
-- down/000026-files.sha256; a change to either reseals in the same reviewed
-- change.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
-- pq_catalog is 000023's definition, verbatim; pq3_state is 000024's.
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
CREATE OR REPLACE FUNCTION pg_temp.pq3_state() RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $s$
SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,pg_temp.pq_catalog(c.oid)) FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (starts_with(c.relname,'polis_queue_') OR starts_with(c.relname,'delphi_'))
 AND c.relname NOT IN ('delphi_foundation_install','polis_queue_large_class_install')),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_functiondef(p.oid),p.proacl::text,pg_get_userbyid(p.proowner)))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (starts_with(p.proname,'pq_') OR starts_with(p.proname,'pd_'))))
$s$;
-- The /4 state: the same, less this file's own install table.
CREATE OR REPLACE FUNCTION pg_temp.pq4_state() RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $s$
SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,pg_temp.pq_catalog(c.oid)) FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (starts_with(c.relname,'polis_queue_') OR starts_with(c.relname,'delphi_'))
 AND c.relname NOT IN ('delphi_foundation_install','polis_queue_large_class_install','polis_queue_retention_install')),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_functiondef(p.oid),p.proacl::text,pg_get_userbyid(p.proowner)))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (starts_with(p.proname,'pq_') OR starts_with(p.proname,'pd_'))))
$s$;
DO $$ BEGIN
 IF to_regclass('public.polis_queue_large_class_install') IS NULL THEN RAISE EXCEPTION 'large class missing: apply 000024 first'; END IF;
 IF to_regclass('public.polis_queue_retention_install') IS NOT NULL OR to_regclass('public.polis_queue_sweeps') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('pq_class_parked','pq_queue_usage','pq_sweep'))
 OR to_regclass('public.polis_queue_jobs_terminal_age') IS NOT NULL OR to_regclass('public.polis_queue_attempts_ended') IS NOT NULL
 OR to_regclass('public.polis_queue_requests_expiry') IS NOT NULL THEN RAISE EXCEPTION 'retention object collision'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.polis_queue_large_class_install WHERE installed=pg_temp.pq3_state()) THEN
  RAISE EXCEPTION 'queue catalog drift: the installed catalog is not the polis-queue/3 shape 000024 recorded';
 END IF;
END $$;
SELECT set_config('queue4.baseline',pg_temp.pq4_state()::text,true);

-- The sweep's three scans.
CREATE INDEX polis_queue_jobs_terminal_age ON public.polis_queue_jobs(env,updated_at,job_id)
 WHERE state IN ('succeeded','dead','cancelled');
CREATE INDEX polis_queue_attempts_ended ON public.polis_queue_attempts(env,ended_at,attempt_id)
 WHERE ended_at IS NOT NULL;
CREATE INDEX polis_queue_requests_expiry ON public.polis_queue_requests(env,binding_expires_at)
 WHERE binding_expires_at IS NOT NULL;

-- One row per sweep. The sweep keeps 90 days of it.
CREATE TABLE public.polis_queue_sweeps (
 env text NOT NULL CHECK(env<>''), sweep_id uuid NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
 pages integer NOT NULL DEFAULT 0 CHECK(pages>=0),
 stopped_by text CHECK(stopped_by IN ('','budget','abandoned')),
 counts jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(counts)='object'),
 PRIMARY KEY(env,sweep_id),
 CHECK((finished_at IS NULL) = (stopped_by IS NULL))
);
CREATE INDEX polis_queue_sweeps_finished ON public.polis_queue_sweeps(env,finished_at);
REVOKE ALL ON public.polis_queue_sweeps FROM PUBLIC,polis_queue_executor;

-- The class depth read with the oldest claimable job's eligible_at.
CREATE OR REPLACE FUNCTION public.pq_class_depth(p_env text,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE c record;
BEGIN
 IF p_env IS NULL OR p_env='' OR p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large')
 THEN RAISE EXCEPTION 'invalid class depth read'; END IF;
 SELECT count(*) FILTER (WHERE q.state IN ('queued','retry_wait')) AS queued,
  count(*) FILTER (WHERE q.state='running') AS leased,
  count(*) FILTER (WHERE q.state='parked') AS parked,
  count(*) FILTER (WHERE q.state='dead') AS dead,
  min(q.created_at) FILTER (WHERE q.state NOT IN ('succeeded','dead','cancelled')) AS oldest,
  min(q.eligible_at) FILTER (WHERE q.state IN ('queued','retry_wait') AND q.attempt_count-q.parked_attempt_count<q.max_attempts
   AND q.eligible_at<=statement_timestamp()) AS oldest_eligible
 INTO c FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.worker_class=p_worker_class;
 RETURN jsonb_build_object('schema_version','polis-queue/4','outcome','class_depth','env',p_env,'worker_class',p_worker_class,
  'queued',c.queued,'leased',c.leased,'parked',c.parked,'dead',c.dead,'oldest_unresolved_created_at',c.oldest,
  'oldest_eligible_at',c.oldest_eligible);
END $$;

-- One page of a class's parked jobs, with the attempts whose exit is not
-- proven: what a daemon that just started (or one whose memory was lost)
-- must watch and, when its journal knows the attempt, prove.
CREATE FUNCTION public.pq_class_parked(p_env text,p_worker_class text,p_after_job uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE items jsonb; n integer; last_id uuid;
BEGIN
 IF p_env IS NULL OR p_env='' OR p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large')
 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid parked read'; END IF;
 SELECT COALESCE(jsonb_agg(x.item ORDER BY x.job_id),'[]'::jsonb),count(*),(array_agg(x.job_id ORDER BY x.job_id DESC))[1]
 INTO items,n,last_id FROM (
  SELECT q.job_id,jsonb_build_object('job_id',q.job_id,'run_id',q.run_id,'stage',q.stage,
   'last_error_code',q.last_error_code,'first_parked_at',q.first_parked_at,'eligible_at',q.eligible_at,
   'attempt_count',q.attempt_count,'parked_attempt_count',q.parked_attempt_count,'max_attempts',q.max_attempts,
   'unconfirmed',COALESCE((SELECT jsonb_agg(jsonb_build_object('attempt_id',a.attempt_id,'owner_id',a.owner_id,
     'lease_epoch',a.lease_epoch::text,'started_at',a.started_at,'ended_at',a.ended_at) ORDER BY a.lease_epoch)
    FROM public.polis_queue_attempts a WHERE a.env=q.env AND a.job_id=q.job_id AND a.process_exit_confirmed_at IS NULL),'[]'::jsonb)) AS item
  FROM public.polis_queue_jobs q
  WHERE q.env=p_env AND q.worker_class=p_worker_class AND q.state='parked' AND (p_after_job IS NULL OR q.job_id>p_after_job)
  ORDER BY q.job_id LIMIT p_limit) x;
 RETURN jsonb_build_object('schema_version','polis-queue/4','outcome','class_parked','env',p_env,'worker_class',p_worker_class,
  'parked',items,'next_after_job_id',CASE WHEN n<p_limit THEN NULL ELSE last_id END);
END $$;

-- The queue's size and this env's last finished sweep.
CREATE FUNCTION public.pq_queue_usage(p_env text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE b bigint; last timestamptz;
BEGIN
 IF p_env IS NULL OR p_env='' THEN RAISE EXCEPTION 'invalid usage read'; END IF;
 SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::bigint INTO b FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (starts_with(c.relname,'polis_queue_') OR starts_with(c.relname,'delphi_'));
 SELECT max(s.finished_at) INTO last FROM public.polis_queue_sweeps s WHERE s.env=p_env AND s.stopped_by IN ('','budget');
 RETURN jsonb_build_object('schema_version','polis-queue/4','outcome','queue_usage','env',p_env,
  'queue_bytes',b,'last_sweep_finished_at',last);
END $$;

-- One bounded page of retention. Page 1 opens the sweep (or answers
-- not_due/busy); each later page must follow the previous one; the last page
-- closes it.
CREATE FUNCTION public.pq_sweep(p_env text,p_sweep uuid,p_page integer,p_max_pages integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.polis_queue_sweeps; now_ts timestamptz=statement_timestamp();
 n_logs bigint=0; n_bind bigint=0; n_jobs bigint=0; n_att bigint=0; n_runs bigint=0; n_sweeps bigint=0; n bigint;
 ids uuid[]; runs uuid[]; more boolean; page_counts jsonb; totals jsonb; outcome text; stop text;
BEGIN
 IF p_env IS NULL OR p_env='' OR p_sweep IS NULL OR p_max_pages IS NULL OR p_max_pages NOT BETWEEN 1 AND 1000
 OR p_page IS NULL OR p_page NOT BETWEEN 1 AND p_max_pages THEN RAISE EXCEPTION 'invalid sweep page'; END IF;
 -- One sweeper per env at a time.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pq:sweep',p_env)::text,0));
 IF p_page=1 THEN
  UPDATE public.polis_queue_sweeps SET finished_at=clock_timestamp(),stopped_by='abandoned'
  WHERE env=p_env AND finished_at IS NULL AND started_at<now_ts-interval '1 hour';
  IF EXISTS(SELECT 1 FROM public.polis_queue_sweeps WHERE env=p_env AND finished_at IS NULL) THEN
   RETURN jsonb_build_object('schema_version','polis-queue/4','outcome','busy','env',p_env,'sweep_id',p_sweep);
  END IF;
  IF EXISTS(SELECT 1 FROM public.polis_queue_sweeps WHERE env=p_env AND stopped_by IN ('','budget') AND finished_at>now_ts-interval '24 hours') THEN
   RETURN jsonb_build_object('schema_version','polis-queue/4','outcome','not_due','env',p_env,'sweep_id',p_sweep,
    'next_due_at',(SELECT max(finished_at)+interval '24 hours' FROM public.polis_queue_sweeps WHERE env=p_env AND stopped_by IN ('','budget')));
  END IF;
  INSERT INTO public.polis_queue_sweeps(env,sweep_id) VALUES(p_env,p_sweep) RETURNING * INTO s;
 ELSE
  SELECT * INTO s FROM public.polis_queue_sweeps WHERE env=p_env AND sweep_id=p_sweep FOR UPDATE;
  IF NOT FOUND OR s.finished_at IS NOT NULL OR s.pages<>p_page-1 THEN RAISE EXCEPTION 'sweep sequence'; END IF;
 END IF;

 -- (1) Log rows of ended attempts: succeeded after 7 days, others after 30;
 -- the manifest row stays with its attempt.
 WITH doomed AS (
  SELECT l.env,l.attempt_id,l.seq FROM public.polis_queue_attempts a
  JOIN public.polis_queue_logs l ON l.env=a.env AND l.attempt_id=a.attempt_id
  WHERE a.env=p_env AND a.ended_at IS NOT NULL AND l.stream<>'manifest'
  AND a.ended_at<now_ts-CASE WHEN a.outcome='succeeded' THEN interval '7 days' ELSE interval '30 days' END
  LIMIT 50000)
 DELETE FROM public.polis_queue_logs l USING doomed d WHERE l.env=d.env AND l.attempt_id=d.attempt_id AND l.seq=d.seq;
 GET DIAGNOSTICS n_logs=ROW_COUNT;

 -- (2) Request bindings one day after they expired.
 WITH doomed AS (
  SELECT r.env,r.actor_scope,r.product_key,r.request_key FROM public.polis_queue_requests r
  WHERE r.env=p_env AND r.binding_expires_at IS NOT NULL AND r.binding_expires_at<now_ts-interval '1 day'
  ORDER BY r.binding_expires_at LIMIT 5000)
 DELETE FROM public.polis_queue_requests r USING doomed d
 WHERE r.env=d.env AND r.actor_scope=d.actor_scope AND r.product_key=d.product_key AND r.request_key=d.request_key;
 GET DIAGNOSTICS n_bind=ROW_COUNT;

 -- (3) Whole jobs past their age, unless something keeps them.
 SELECT array_agg(x.job_id),array_agg(DISTINCT x.run_id) INTO ids,runs FROM (
  SELECT q.job_id,q.run_id FROM public.polis_queue_jobs q
  JOIN public.polis_queue_runs r ON r.env=q.env AND r.run_id=q.run_id
  LEFT JOIN public.delphi_jobs d ON d.env=q.env AND d.job_id=q.job_id
  WHERE q.env=p_env AND q.state IN ('succeeded','dead','cancelled')
  AND q.updated_at<now_ts-CASE WHEN q.state='dead' THEN interval '90 days' ELSE interval '30 days' END
  AND NOT COALESCE(d.pinned,false)
  AND NOT EXISTS(SELECT 1 FROM public.delphi_job_aliases al WHERE al.job_id=q.job_id)
  AND NOT EXISTS(SELECT 1 FROM public.delphi_current cu WHERE cu.env=q.env AND cu.job_id=q.job_id)
  AND NOT EXISTS(SELECT 1 FROM public.delphi_job_guards g WHERE g.env=q.env AND g.root_job_id=q.job_id)
  AND NOT EXISTS(SELECT 1 FROM public.polis_queue_heads h WHERE h.env=q.env AND h.product_key=r.product_key
   AND (h.desired_run_id=q.run_id OR h.published_run_id=q.run_id))
  AND NOT EXISTS(SELECT 1 FROM public.polis_queue_attempts a WHERE a.env=q.env AND a.job_id=q.job_id AND a.process_exit_confirmed_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM public.delphi_provider_requests pr WHERE pr.env=q.env AND pr.job_id=q.job_id
   AND pr.state IN ('intent','submission_unknown','submitted'))
  AND (d.job_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.delphi_job_inputs i WHERE i.zid=d.zid AND i.producer_job_id=q.job_id))
  AND NOT EXISTS(SELECT 1 FROM public.delphi_jobs ch WHERE ch.parent_job_id=q.job_id)
  -- The latest succeeded job of the product stays: promotion is authorized
  -- by its receipt (P-085).
  AND (q.state<>'succeeded' OR EXISTS(SELECT 1 FROM public.polis_queue_jobs q2
   JOIN public.polis_queue_runs r2 ON r2.env=q2.env AND r2.run_id=q2.run_id
   WHERE r2.env=q.env AND r2.product_key=r.product_key AND q2.state='succeeded'
   AND (q2.updated_at,q2.job_id)>(q.updated_at,q.job_id)))
  ORDER BY q.updated_at,q.job_id LIMIT 200 FOR UPDATE OF q SKIP LOCKED) x;
 IF ids IS NOT NULL THEN
  n_jobs=cardinality(ids);
  DELETE FROM public.polis_queue_logs l USING public.polis_queue_attempts a
  WHERE a.env=p_env AND a.job_id=ANY(ids) AND l.env=a.env AND l.attempt_id=a.attempt_id;
  GET DIAGNOSTICS n=ROW_COUNT; n_logs=n_logs+n;
  DELETE FROM public.delphi_provider_requests WHERE env=p_env AND job_id=ANY(ids);
  DELETE FROM public.delphi_job_inputs i USING public.delphi_jobs d
  WHERE d.env=p_env AND d.job_id=ANY(ids) AND i.zid=d.zid AND i.consumer_job_id=d.job_id;
  DELETE FROM public.polis_queue_requests WHERE env=p_env AND job_id=ANY(ids);
  GET DIAGNOSTICS n=ROW_COUNT; n_bind=n_bind+n;
  DELETE FROM public.polis_queue_attempts WHERE env=p_env AND job_id=ANY(ids);
  GET DIAGNOSTICS n_att=ROW_COUNT;
  DELETE FROM public.delphi_jobs WHERE env=p_env AND job_id=ANY(ids);
  DELETE FROM public.polis_queue_jobs WHERE env=p_env AND job_id=ANY(ids);
  DELETE FROM public.polis_queue_runs r WHERE r.env=p_env AND r.run_id=ANY(runs)
  AND NOT EXISTS(SELECT 1 FROM public.polis_queue_jobs q WHERE q.env=r.env AND q.run_id=r.run_id)
  AND NOT EXISTS(SELECT 1 FROM public.delphi_jobs d WHERE d.env=r.env AND d.run_id=r.run_id)
  AND NOT EXISTS(SELECT 1 FROM public.polis_queue_requests rq WHERE rq.env=r.env AND rq.run_id=r.run_id)
  AND NOT EXISTS(SELECT 1 FROM public.polis_queue_heads h WHERE h.env=r.env AND h.product_key=r.product_key
   AND (h.desired_run_id=r.run_id OR h.published_run_id=r.run_id));
  GET DIAGNOSTICS n_runs=ROW_COUNT;
 END IF;

 -- (4) The sweep's own history after 90 days.
 DELETE FROM public.polis_queue_sweeps WHERE env=p_env AND finished_at<now_ts-interval '90 days';
 GET DIAGNOSTICS n_sweeps=ROW_COUNT;

 page_counts=jsonb_build_object('log_rows_deleted',n_logs,'bindings_deleted',n_bind,'jobs_deleted',n_jobs,
  'attempts_deleted',n_att,'runs_deleted',n_runs,'sweeps_deleted',n_sweeps);
 SELECT jsonb_object_agg(k,COALESCE((s.counts->>k)::bigint,0)+(page_counts->>k)::bigint) INTO totals
 FROM jsonb_object_keys(page_counts) k;
 more=(n_logs>=50000 OR n_bind>=5000 OR n_jobs>=200);
 IF NOT more THEN outcome='sweep_done'; stop='';
 ELSIF p_page=p_max_pages THEN outcome='sweep_done'; stop='budget';
 ELSE outcome='sweep_page'; stop=NULL; END IF;
 UPDATE public.polis_queue_sweeps SET pages=p_page,counts=totals,
  finished_at=CASE WHEN stop IS NULL THEN NULL ELSE clock_timestamp() END,stopped_by=stop
 WHERE env=p_env AND sweep_id=p_sweep;
 RETURN jsonb_build_object('schema_version','polis-queue/4','outcome',outcome,'env',p_env,'sweep_id',p_sweep,
  'page',p_page,'more',outcome='sweep_page','stopped_by',stop,'page_counts',page_counts,'counts',totals);
END $$;

REVOKE ALL ON FUNCTION public.pq_class_parked(text,text,uuid,integer) FROM PUBLIC,polis_queue_executor;
REVOKE ALL ON FUNCTION public.pq_queue_usage(text) FROM PUBLIC,polis_queue_executor;
REVOKE ALL ON FUNCTION public.pq_sweep(text,uuid,integer,integer) FROM PUBLIC,polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pq_class_parked(text,text,uuid,integer) TO polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pq_queue_usage(text) TO polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pq_sweep(text,uuid,integer,integer) TO polis_queue_executor;

CREATE TABLE public.polis_queue_retention_install (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), baseline jsonb NOT NULL, installed jsonb NOT NULL
);
REVOKE ALL ON public.polis_queue_retention_install FROM PUBLIC,polis_queue_executor;
INSERT INTO public.polis_queue_retention_install VALUES(true,current_setting('queue4.baseline')::jsonb,pg_temp.pq4_state());
COMMIT;
