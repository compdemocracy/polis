-- 000026_create_polis_queue_retention.sql
--
-- Retention and restart-safe reads for the Postgres job queue, on top of
-- 000024 (polis-queue/3, the large worker class). Plans: cost-reduction
-- P-083 (retention), P-086 (observability), P-082 (scheduling), and the
-- dead-job breaker of decision #729. It follows 000025 (the vote convention
-- and the migration ledger): it records itself in public.schema_migrations,
-- so 000025 must be applied first.
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
--   pq_sweep              NEW, (env, sweep_id, page, max_pages) -> ONE
--                         bounded page of retention by reachability (rules
--                         below): a dry-run report, tombstones, purges; the
--                         page is recorded in polis_queue_sweeps. A daemon
--                         calls it page by page, one transaction per page.
--   polis_queue_retention_policy, polis_queue_tombstones,
--   pq_retention_reached, pq_retention_candidates
--                         NEW: the policy as data, the first phase of a
--                         delete, the mark and the deletable set (owner only).
--   polis_queue_sweeps    NEW table: one row per sweep (start, finish, pages,
--                         what stopped it, counts). The sweep keeps 90 days
--                         of it. No grant: read through pq_queue_usage.
--   three indexes         polis_queue_jobs (env, updated_at, job_id) over
--                         terminal jobs; polis_queue_attempts (env, ended_at,
--                         attempt_id) over ended attempts;
--                         polis_queue_requests (env, binding_expires_at) over
--                         bindings that expire. The sweep's three scans.
--   polis_queue_breakers  NEW table: the dead-job breaker, one row per
--                         (env, zid, product_key). A durable count of the
--                         scope's consecutive dead jobs under one code image,
--                         kept by a trigger on polis_queue_jobs
--                         (pq_breaker_record) as each job ends; retention
--                         never touches it. Seeded at apply from the queue's
--                         history.
--   pd_enqueue            the poison latch reads the breaker, not the
--                         surviving rows (decision #729): three consecutive
--                         dead jobs under the image being admitted open it;
--                         while open, admission answers `poisoned` (the reply
--                         names the latest dead job, as under 000024); 24
--                         hours after it opened it is half-open and admits
--                         ONE probe job; the probe succeeding closes it, the
--                         probe dying re-opens it for 24 hours more, the probe
--                         being cancelled frees the probe slot. A different
--                         image (a deploy) resets it. A succeeded job closes
--                         it; a cancelled job ends a streak that has not
--                         opened. Every other part of pd_enqueue is 000024's.
--   polis_queue_retention_install
--                         the catalog baseline this apply recorded, read by
--                         the down script.
--   public.schema_migrations
--                         this file's own ledger row (the last statement,
--                         written as the applying login, not as the queue
--                         owner). 000025's down refuses while it is there.
-- polis_queue_install.contract_version stays polis-queue/3: no existing reply
-- other than pq_class_depth changes (pd_enqueue's replies keep their shape;
-- only when it answers `poisoned` moves to the breaker), and no daemon or poller has to move to
-- run on this schema. The depth reply's new version tells a reader which
-- shape it holds.
--
-- RETENTION (pq_sweep; reachability, decision #758; P-083's ages as data)
-- ----------------------------------------------------------------------
--   Mark: a job is REACHED, and kept, when it is unfinished (queued,
--   retry_wait, running, parked), pinned, an alias, a delphi_current
--   pointer, the root of a held scope guard, on a head's desired or
--   published run, holds an attempt without exit proof or an open provider
--   request, is dead under an open breaker (#729), or is an input or the
--   parent of a reached job, transitively (pq_retention_reached).
--   Policy as data: polis_queue_retention_policy holds one row per kind
--   (keep_days, keep_last, action). Shipped: succeeded jobs 30 days keeping
--   the newest of each product, cancelled 30, dead 90; a succeeded attempt's
--   output lines 7 days, any other's 30 (the manifest row stays with its
--   attempt); bindings 1 day after expiry; tombstones 7 days before purge;
--   sweep rows 90 days. Every action ships as 'dry_run'. A retention change
--   is an UPDATE of that table, never a migration.
--   Deletable (pq_retention_candidates): an unreached finished job past its
--   age and outside keep_last that no job names as input or parent; the
--   output lines of an ended attempt past its age, unless its job is reached
--   for a reason that keeps evidence; a binding past its age.
--   Dry run: page 1 reports would_<kind> counts and deletes nothing.
--   Two phases for a kind whose action is 'delete': the sweep TOMBSTONES the
--   row (polis_queue_tombstones; the row still exists, and deleting its
--   tombstone, or the row becoming reachable or kept by policy again,
--   restores it); a later sweep PURGES rows tombstoned more than the
--   'tombstone' kind's keep_days ago, only when that kind's action is
--   'delete'. Purges go in foreign key order: logs, provider rows, consumer
--   edges, requests, attempts, logical jobs, queue jobs, unreferenced runs.
--   Bounds per page: 200 jobs and 50,000 log rows purged, 5,000 bindings;
--   200 jobs, 5,000 attempts' logs and 5,000 bindings tombstoned.
-- A page that hit no bound finishes the sweep; a page that reaches max_pages
-- finishes it as `budget`. A sweep runs at most once per 24 hours per env
-- (`not_due`); a second sweeper while one is in progress is told `busy`; a
-- sweep left unfinished for an hour is closed as `abandoned`. Nothing here
-- touches conversations, votes, comments or math results.
--
-- HOW TO APPLY
-- ------------
-- A fresh container applies it once from /docker-entrypoint-initdb.d in
-- file-name order, after 000025. An existing database takes it by hand
-- through the checked wrapper, after 000019, 000023, 000024 and 000025:
--
--   server/postgres/bin/apply-migration.sh --free-bytes <measured> 000026 -- \
--     docker exec -i polis-dev-postgres-1 psql -U postgres -d polis-dev
--
-- Applying it to production is a separate, explicit step by the owner. It
-- takes no lock on conversations or any table outside the queue: it creates
-- three indexes on queue tables (SHARE lock on those tables until COMMIT, so
-- queue writes wait; reads continue), a trigger on polis_queue_jobs (SHARE ROW
-- EXCLUSIVE until COMMIT), two tables, five functions (one replaced) and one
-- ledger row (ROW EXCLUSIVE on public.schema_migrations).
--
-- APPLIER REQUIREMENTS
-- --------------------
-- The applying login must be able to SET ROLE polis_queue_owner and to SELECT
-- and INSERT public.schema_migrations. It runs in one transaction with
-- lock_timeout 5s and refuses, changing nothing, when: 000025 is not recorded
-- in the ledger ("migration ledger missing"); 000026 or a later file is
-- recorded there ("ledger already records"); 000024 is absent ("large class
-- missing"); the installed /3 catalog differs
-- from what 000024 recorded ("queue catalog drift", which is also what a
-- second apply says); or one of this file's objects already exists
-- ("retention object collision"). 000019, 000023 and 000024 all refuse to
-- replay over this schema (their own fingerprint guards).
--
-- REVERSAL
-- --------
-- down/000026_drop_polis_queue_retention.sql restores the /3 catalog exactly
-- as recorded at apply time and removes this file's ledger row; it refuses
-- once a sweep has purged a row (polis_queue_retention_install.rows_purged
-- above zero: a purge cannot be undone; dry runs and tombstones can) or while the ledger records a later migration. Order:
-- 000026's down runs before 000025's (000025's refuses while this row is
-- there) and before 000024's (000024's refuses the /4 catalog). Proven by
-- down/test_000026_down.sh against the real chain. Both files are sealed in
-- down/000026-files.sha256; a change to either reseals in the same reviewed
-- change.
BEGIN;
SET LOCAL lock_timeout='5s';
-- The ledger, read as the applying login (the queue owner has no grant on it).
DO $ledger$ BEGIN
 IF to_regclass('public.schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'migration ledger missing: apply 000025 (the vote convention and the ledger) first';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='000025_vote_convention' AND length(checksum)=64) THEN
  RAISE EXCEPTION 'migration ledger missing: the ledger does not record 000025_vote_convention';
 END IF;
 IF EXISTS(SELECT 1 FROM public.schema_migrations WHERE name>='000026' AND length(checksum)=64) THEN
  RAISE EXCEPTION 'ledger already records %', (SELECT string_agg(name,', ' ORDER BY name) FROM public.schema_migrations WHERE name>='000026' AND length(checksum)=64);
 END IF;
END $ledger$;
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
 OR to_regclass('public.polis_queue_breakers') IS NOT NULL OR to_regclass('public.polis_queue_retention_policy') IS NOT NULL
 OR to_regclass('public.polis_queue_tombstones') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
  AND proname IN ('pq_class_parked','pq_queue_usage','pq_sweep','pq_breaker_record','pq_retention_reached','pq_retention_candidates'))
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

-- The dead-job breaker (decision #729): a durable count per scope, kept
-- as jobs end, never derived from the rows retention may delete.
--   consecutive_dead  dead jobs in a row under code_image_digest; a
--                     succeeded job, or a cancelled one before it opens,
--                     sets it to 0; a dead job under another image to 1.
--   opened_at         set when the count reaches 3 (and again when a probe
--                     dies): admission answers `poisoned` for 24 hours
--                     from it, then admits one probe.
--   probe_job_id      the probe while it runs; cleared when it ends.
--   last_dead_job_id  the job a `poisoned` reply names.
-- No foreign key (no lock on conversations); no grant: pd_enqueue and the
-- trigger read and write it as the owner.
CREATE TABLE public.polis_queue_breakers (
 env text NOT NULL CHECK(env<>''), zid integer NOT NULL, product_key text NOT NULL CHECK(product_key<>''),
 code_image_digest text NOT NULL,
 consecutive_dead integer NOT NULL DEFAULT 0 CHECK(consecutive_dead>=0),
 last_dead_job_id uuid, opened_at timestamptz, probe_job_id uuid,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,zid,product_key),
 CHECK((opened_at IS NOT NULL) = (consecutive_dead>=3)),
 CHECK(probe_job_id IS NULL OR opened_at IS NOT NULL),
 CHECK(consecutive_dead=0 OR last_dead_job_id IS NOT NULL)
);
REVOKE ALL ON public.polis_queue_breakers FROM PUBLIC,polis_queue_executor;

-- Seed it from the history present at apply, in 000024's order (the scope's
-- runs, newest first): the leading run of dead jobs under the newest job's
-- image. Three or more opens it, as of the newest death.
WITH o AS (
 SELECT r.env,r.zid,r.product_key,q.job_id,q.state,q.updated_at,r.code_image_digest AS image,
  row_number() OVER w AS rn,first_value(r.code_image_digest) OVER w AS head_image
 FROM public.polis_queue_runs r JOIN public.polis_queue_jobs q ON q.env=r.env AND q.run_id=r.run_id
 WINDOW w AS (PARTITION BY r.env,r.zid,r.product_key ORDER BY r.created_at DESC,r.run_id DESC,q.job_id DESC)),
b AS (
 SELECT o.*,count(*) FILTER (WHERE o.state<>'dead' OR o.image<>o.head_image)
  OVER (PARTITION BY o.env,o.zid,o.product_key ORDER BY o.rn) AS broken FROM o),
s AS (
 SELECT env,zid,product_key,min(head_image) AS image,count(*)::integer AS n,
  (array_agg(job_id ORDER BY rn))[1] AS last_job,(array_agg(updated_at ORDER BY rn))[1] AS died_at
 FROM b WHERE broken=0 GROUP BY env,zid,product_key)
INSERT INTO public.polis_queue_breakers(env,zid,product_key,code_image_digest,consecutive_dead,last_dead_job_id,opened_at)
SELECT env,zid,product_key,image,n,last_job,CASE WHEN n>=3 THEN died_at END FROM s;

-- The count, as each job ends (an UPDATE of state into succeeded, dead or
-- cancelled). Concurrent ends of one scope serialize on the breaker row.
CREATE FUNCTION public.pq_breaker_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.polis_queue_runs; b public.polis_queue_breakers;
BEGIN
 SELECT * INTO r FROM public.polis_queue_runs WHERE env=NEW.env AND run_id=NEW.run_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NEW.state='dead' THEN
  INSERT INTO public.polis_queue_breakers(env,zid,product_key,code_image_digest)
  VALUES(NEW.env,r.zid,r.product_key,r.code_image_digest) ON CONFLICT DO NOTHING;
 END IF;
 SELECT * INTO b FROM public.polis_queue_breakers WHERE env=NEW.env AND zid=r.zid AND product_key=r.product_key FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NEW.state='dead' THEN
  IF b.code_image_digest<>r.code_image_digest THEN
   UPDATE public.polis_queue_breakers SET code_image_digest=r.code_image_digest,consecutive_dead=1,last_dead_job_id=NEW.job_id,
    opened_at=NULL,probe_job_id=NULL,updated_at=clock_timestamp()
   WHERE env=b.env AND zid=b.zid AND product_key=b.product_key;
  ELSE
   UPDATE public.polis_queue_breakers SET consecutive_dead=b.consecutive_dead+1,last_dead_job_id=NEW.job_id,
    opened_at=CASE WHEN b.consecutive_dead+1>=3 THEN clock_timestamp() END,probe_job_id=NULL,updated_at=clock_timestamp()
   WHERE env=b.env AND zid=b.zid AND product_key=b.product_key;
  END IF;
 ELSIF NEW.state='succeeded' THEN
  UPDATE public.polis_queue_breakers SET consecutive_dead=0,last_dead_job_id=NULL,opened_at=NULL,probe_job_id=NULL,updated_at=clock_timestamp()
  WHERE env=b.env AND zid=b.zid AND product_key=b.product_key;
 ELSIF b.probe_job_id=NEW.job_id THEN
  -- A cancelled probe proves nothing: the breaker stays open (half-open).
  UPDATE public.polis_queue_breakers SET probe_job_id=NULL,updated_at=clock_timestamp()
  WHERE env=b.env AND zid=b.zid AND product_key=b.product_key;
 ELSIF b.opened_at IS NULL THEN
  UPDATE public.polis_queue_breakers SET consecutive_dead=0,last_dead_job_id=NULL,updated_at=clock_timestamp()
  WHERE env=b.env AND zid=b.zid AND product_key=b.product_key;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.pq_breaker_record() FROM PUBLIC,polis_queue_executor;
CREATE TRIGGER pq_breaker_record AFTER UPDATE OF state ON public.polis_queue_jobs FOR EACH ROW
 WHEN (NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('succeeded','dead','cancelled'))
 EXECUTE FUNCTION public.pq_breaker_record();

-- Admission: 000024's pd_enqueue with its poison latch read from the breaker.
CREATE OR REPLACE FUNCTION public.pd_enqueue(p_env text,p_zid integer,p_product text,p_actor text,p_key text,p_request_sha text,
 p_run uuid,p_job uuid,p_input_uri text,p_input_sha text,p_config_sha text,p_image text,p_priority smallint,p_max_attempts integer,
 p_stage text,p_report text,p_scope text,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE g public.delphi_job_guards; j public.polis_queue_jobs; alias public.polis_queue_requests; reply jsonb; v_kind text; v_class text; v_contract text;
 b public.polis_queue_breakers; v_probe boolean=false;
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
 -- The breaker (no guard is held). Another image resets it. Open less than
 -- 24 hours, or a probe still running: `poisoned`, naming the latest dead
 -- job (retention keeps it while the breaker is open). Open 24 hours or
 -- more: this admission is the one probe.
 SELECT * INTO b FROM public.polis_queue_breakers WHERE env=p_env AND zid=p_zid AND product_key=p_product FOR UPDATE;
 IF FOUND AND b.code_image_digest<>p_image THEN
  UPDATE public.polis_queue_breakers SET code_image_digest=p_image,consecutive_dead=0,last_dead_job_id=NULL,opened_at=NULL,probe_job_id=NULL,
   updated_at=clock_timestamp()
  WHERE env=p_env AND zid=p_zid AND product_key=p_product;
 ELSIF FOUND AND b.opened_at IS NOT NULL THEN
  IF b.probe_job_id IS NOT NULL OR b.opened_at>clock_timestamp()-interval '24 hours' THEN
   SELECT * INTO j FROM public.polis_queue_jobs WHERE env=p_env AND job_id=b.last_dead_job_id;
   RETURN public.pq_result('poisoned',j);
  END IF;
  v_probe=true;
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
 IF v_probe THEN
  UPDATE public.polis_queue_breakers SET probe_job_id=p_job,updated_at=clock_timestamp()
  WHERE env=p_env AND zid=p_zid AND product_key=p_product;
 END IF;
 RETURN public.pq_result('enqueued',j);
END $$;

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

-- Retention by reachability (decision #758). Three parts:
--   polis_queue_retention_policy   the rules, as data: one row per kind
--                                  (keep_days, keep_last, action). Changing
--                                  retention is an UPDATE of this table,
--                                  never a migration. Every kind ships as
--                                  'dry_run': the sweep reports what it would
--                                  delete and deletes nothing.
--   pq_retention_reached(env)      the mark: every job something that matters
--                                  reaches, with the reason.
--   polis_queue_tombstones         the first phase of a delete: a row marked
--                                  here still exists and is restored by
--                                  deleting its tombstone (or by becoming
--                                  reachable again); it is purged only after
--                                  the 'tombstone' kind's keep_days.
CREATE TABLE public.polis_queue_retention_policy (
 kind text PRIMARY KEY CHECK(kind IN ('job_succeeded','job_cancelled','job_dead','logs_succeeded','logs_failed','binding','tombstone','sweep_history')),
 keep_days integer NOT NULL CHECK(keep_days BETWEEN 1 AND 3650),
 keep_last integer NOT NULL DEFAULT 0 CHECK(keep_last BETWEEN 0 AND 1000),
 action text NOT NULL DEFAULT 'dry_run' CHECK(action IN ('dry_run','delete')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by name NOT NULL DEFAULT session_user,
 CHECK(keep_last=0 OR starts_with(kind,'job_'))
);
REVOKE ALL ON public.polis_queue_retention_policy FROM PUBLIC,polis_queue_executor;
-- P-083's ages. keep_last 1 on succeeded jobs: the latest success of a
-- product stays (promotion is authorized by its receipt, P-085). The
-- 'tombstone' row is the purge: its keep_days is the grace between the mark
-- and the purge, its action whether the purge runs.
INSERT INTO public.polis_queue_retention_policy(kind,keep_days,keep_last) VALUES
 ('job_succeeded',30,1),('job_cancelled',30,0),('job_dead',90,0),
 ('logs_succeeded',7,0),('logs_failed',30,0),('binding',1,0),
 ('tombstone',7,0),('sweep_history',90,0);

CREATE TABLE public.polis_queue_tombstones (
 env text NOT NULL CHECK(env<>''),
 kind text NOT NULL CHECK(kind IN ('job','logs','binding')),
 ref text NOT NULL,
 policy_kind text NOT NULL,
 sweep_id uuid NOT NULL,
 tombstoned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,kind,ref)
);
CREATE INDEX polis_queue_tombstones_age ON public.polis_queue_tombstones(env,tombstoned_at);
REVOKE ALL ON public.polis_queue_tombstones FROM PUBLIC,polis_queue_executor;

-- The mark. A job is reached when it is not finished (queued, retry_wait,
-- running, parked); pinned; an alias; a delphi_current pointer; the root of a
-- held scope guard; on a head's desired or published run; holds an attempt
-- without exit proof or an open provider request; dead under an open
-- breaker (#729); or an input or the parent of a reached job (transitively).
CREATE FUNCTION public.pq_retention_reached(p_env text) RETURNS TABLE(job_id uuid,reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
WITH RECURSIVE root(job_id,reason) AS (
 SELECT q.job_id,'active' FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.state NOT IN ('succeeded','dead','cancelled')
 UNION SELECT d.job_id,'pinned' FROM public.delphi_jobs d WHERE d.env=p_env AND d.pinned
 UNION SELECT al.job_id,'alias' FROM public.delphi_job_aliases al JOIN public.delphi_jobs d ON d.job_id=al.job_id WHERE d.env=p_env
 UNION SELECT cu.job_id,'current' FROM public.delphi_current cu WHERE cu.env=p_env
 UNION SELECT g.root_job_id,'guard' FROM public.delphi_job_guards g WHERE g.env=p_env
 UNION SELECT q.job_id,'head' FROM public.polis_queue_heads h JOIN public.polis_queue_jobs q ON q.env=h.env
  AND (q.run_id=h.desired_run_id OR q.run_id=h.published_run_id) WHERE h.env=p_env
 UNION SELECT a.job_id,'unproven_exit' FROM public.polis_queue_attempts a WHERE a.env=p_env AND a.process_exit_confirmed_at IS NULL
 UNION SELECT pr.job_id,'open_provider' FROM public.delphi_provider_requests pr
  WHERE pr.env=p_env AND pr.state IN ('intent','submission_unknown','submitted')
 UNION SELECT q.job_id,'breaker' FROM public.polis_queue_jobs q JOIN public.polis_queue_runs r ON r.env=q.env AND r.run_id=q.run_id
  JOIN public.polis_queue_breakers bk ON bk.env=r.env AND bk.zid=r.zid AND bk.product_key=r.product_key
  WHERE q.env=p_env AND q.state='dead' AND bk.opened_at IS NOT NULL),
reached(job_id,reason) AS (
 SELECT root.job_id,root.reason FROM root
 UNION
 SELECT x.job_id,x.reason FROM reached k JOIN public.delphi_jobs d ON d.job_id=k.job_id
 CROSS JOIN LATERAL (
  SELECT i.producer_job_id AS job_id,'input' AS reason FROM public.delphi_job_inputs i WHERE i.zid=d.zid AND i.consumer_job_id=d.job_id
  UNION ALL SELECT d.parent_job_id,'parent' WHERE d.parent_job_id IS NOT NULL) x)
SELECT reached.job_id,reached.reason FROM reached
$$;
REVOKE ALL ON FUNCTION public.pq_retention_reached(text) FROM PUBLIC,polis_queue_executor;

-- What the policy makes deletable now, per kind (the sweep marks, purges
-- and counts from this one definition):
--   job      a finished job of its policy kind, unreached, older than
--            keep_days and not among the keep_last newest of its product in
--            that state, that no other job names as input or parent (the
--            foreign keys);
--   logs     an ended attempt's stdout/stderr/truncated rows, older than its
--            kind's keep_days, unless its job is reached for a reason that
--            keeps evidence (unfinished, pinned, alias, an open breaker, an
--            unproven exit, an open provider request); the manifest row stays
--            with the attempt;
--   binding  a request binding keep_days after it expired.
CREATE FUNCTION public.pq_retention_candidates(p_env text) RETURNS TABLE(kind text,policy_kind text,ref text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
WITH pol AS (SELECT p.kind,make_interval(days=>p.keep_days) AS keep,p.keep_last FROM public.polis_queue_retention_policy p),
reached AS MATERIALIZED (SELECT r.job_id,r.reason FROM public.pq_retention_reached(p_env) r),
jobs AS (
 SELECT q.job_id,'job_'||q.state AS pk,q.updated_at,
  row_number() OVER (PARTITION BY r.product_key,q.state ORDER BY q.updated_at DESC,q.job_id DESC) AS rn
 FROM public.polis_queue_jobs q JOIN public.polis_queue_runs r ON r.env=q.env AND r.run_id=q.run_id
 WHERE q.env=p_env AND q.state IN ('succeeded','dead','cancelled'))
SELECT 'job'::text,j.pk,j.job_id::text FROM jobs j JOIN pol ON pol.kind=j.pk
 WHERE j.updated_at<statement_timestamp()-pol.keep AND j.rn>pol.keep_last
 AND NOT EXISTS(SELECT 1 FROM reached k WHERE k.job_id=j.job_id)
 AND NOT EXISTS(SELECT 1 FROM public.delphi_jobs d JOIN public.delphi_job_inputs i ON i.zid=d.zid AND i.producer_job_id=d.job_id WHERE d.job_id=j.job_id)
 AND NOT EXISTS(SELECT 1 FROM public.delphi_jobs ch WHERE ch.parent_job_id=j.job_id)
UNION ALL
SELECT 'logs',pol.kind,a.attempt_id::text FROM public.polis_queue_attempts a
 JOIN pol ON pol.kind=CASE WHEN a.outcome='succeeded' THEN 'logs_succeeded' ELSE 'logs_failed' END
 WHERE a.env=p_env AND a.ended_at IS NOT NULL AND a.ended_at<statement_timestamp()-pol.keep
 AND NOT EXISTS(SELECT 1 FROM reached k WHERE k.job_id=a.job_id AND k.reason IN ('active','pinned','alias','breaker','unproven_exit','open_provider'))
 AND EXISTS(SELECT 1 FROM public.polis_queue_logs l WHERE l.env=a.env AND l.attempt_id=a.attempt_id AND l.stream<>'manifest')
UNION ALL
SELECT 'binding','binding',jsonb_build_array(rq.actor_scope,rq.product_key,rq.request_key)::text
 FROM public.polis_queue_requests rq JOIN pol ON pol.kind='binding'
 WHERE rq.env=p_env AND rq.binding_expires_at IS NOT NULL AND rq.binding_expires_at<statement_timestamp()-pol.keep
$$;
REVOKE ALL ON FUNCTION public.pq_retention_candidates(text) FROM PUBLIC,polis_queue_executor;

-- One bounded page of retention. Page 1 opens the sweep (or answers
-- not_due/busy) and reports, for every kind whose action is dry_run, how many
-- rows it WOULD mark (would_<kind>), and how many tombstones a dry_run purge
-- would remove (would_purge). Then, for kinds whose action is delete:
--   restore  a tombstone whose row is no longer deletable (reached again, or
--            the policy changed) is removed: the row stays;
--   purge    when the 'tombstone' kind's action is delete, rows tombstoned
--            more than its keep_days ago and still deletable go, in foreign
--            key order (at most 200 jobs, 50,000 log rows, 5,000 bindings);
--   mark     deletable rows not yet tombstoned are (at most 200 jobs, 5,000
--            attempts' logs, 5,000 bindings).
-- Sweep rows go after 'sweep_history' keep_days when its action is delete.
-- Each later page must follow the previous one; the last page closes it.
CREATE FUNCTION public.pq_sweep(p_env text,p_sweep uuid,p_page integer,p_max_pages integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.polis_queue_sweeps; now_ts timestamptz=statement_timestamp();
 n_logs bigint=0; n_bind bigint=0; n_jobs bigint=0; n_att bigint=0; n_runs bigint=0; n_sweeps bigint=0; n bigint;
 t_jobs bigint=0; t_logs bigint=0; t_bind bigint=0; n_restored bigint=0; would jsonb='{}';
 ids uuid[]; runs uuid[]; more boolean=false; page_counts jsonb; totals jsonb; outcome text; stop text;
 pol jsonb; act_purge boolean; grace interval;
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
 SELECT jsonb_object_agg(p.kind,jsonb_build_object('keep_days',p.keep_days,'keep_last',p.keep_last,'action',p.action)) INTO pol
 FROM public.polis_queue_retention_policy p;
 act_purge=COALESCE(pol->'tombstone'->>'action','dry_run')='delete';
 grace=make_interval(days=>COALESCE((pol->'tombstone'->>'keep_days')::integer,7));

 -- The candidates are computed by pq_retention_candidates in each statement
 -- that needs them (no session temp table: a caller's own temp table must
 -- never stand in for it under this function's rights).

 -- (0) What a dry run would do (page 1 only: a dry run changes nothing).
 IF p_page=1 THEN
  SELECT COALESCE(jsonb_object_agg('would_'||k.kind,COALESCE(c.n,0)),'{}') INTO would
  FROM public.polis_queue_retention_policy k
  LEFT JOIN (SELECT policy_kind,count(*) AS n FROM public.pq_retention_candidates(p_env) c
   WHERE NOT EXISTS(SELECT 1 FROM public.polis_queue_tombstones t WHERE t.env=p_env AND t.kind=c.kind AND t.ref=c.ref)
   GROUP BY policy_kind) c ON c.policy_kind=k.kind
  WHERE k.action='dry_run' AND k.kind NOT IN ('tombstone','sweep_history');
  IF NOT act_purge THEN
   would=would||jsonb_build_object('would_purge',(SELECT count(*) FROM public.polis_queue_tombstones t JOIN public.pq_retention_candidates(p_env) c
    ON c.kind=t.kind AND c.ref=t.ref WHERE t.env=p_env AND t.tombstoned_at<now_ts-grace));
  END IF;
  IF pol->'sweep_history'->>'action'='dry_run' THEN
   would=would||jsonb_build_object('would_sweep_history',(SELECT count(*) FROM public.polis_queue_sweeps
    WHERE env=p_env AND finished_at<now_ts-make_interval(days=>(pol->'sweep_history'->>'keep_days')::integer)));
  END IF;
 END IF;

 -- (1) Restore: a tombstone whose row is no longer deletable goes; the row stays.
 DELETE FROM public.polis_queue_tombstones t WHERE t.env=p_env
 AND NOT EXISTS(SELECT 1 FROM public.pq_retention_candidates(p_env) c WHERE c.kind=t.kind AND c.ref=t.ref);
 GET DIAGNOSTICS n_restored=ROW_COUNT;

 -- (2) Purge what was tombstoned more than the grace ago and is still deletable.
 IF act_purge THEN
  -- Log rows of tombstoned attempts (the manifest row stays with its attempt).
  WITH doomed AS (
   SELECT l.env,l.attempt_id,l.seq FROM public.polis_queue_tombstones t
   JOIN public.polis_queue_logs l ON l.env=t.env AND l.attempt_id=t.ref::uuid
   WHERE t.env=p_env AND t.kind='logs' AND t.tombstoned_at<now_ts-grace AND l.stream<>'manifest'
   LIMIT 50000)
  DELETE FROM public.polis_queue_logs l USING doomed d WHERE l.env=d.env AND l.attempt_id=d.attempt_id AND l.seq=d.seq;
  GET DIAGNOSTICS n_logs=ROW_COUNT;
  more=more OR n_logs>=50000;
  DELETE FROM public.polis_queue_tombstones t WHERE t.env=p_env AND t.kind='logs' AND t.tombstoned_at<now_ts-grace
  AND NOT EXISTS(SELECT 1 FROM public.polis_queue_logs l WHERE l.env=t.env AND l.attempt_id=t.ref::uuid AND l.stream<>'manifest');
  -- Bindings.
  WITH doomed AS (
   SELECT t.ref FROM public.polis_queue_tombstones t WHERE t.env=p_env AND t.kind='binding' AND t.tombstoned_at<now_ts-grace LIMIT 5000),
  gone AS (
   DELETE FROM public.polis_queue_requests r USING doomed d
   WHERE r.env=p_env AND jsonb_build_array(r.actor_scope,r.product_key,r.request_key)::text=d.ref RETURNING 1),
  untomb AS (
   DELETE FROM public.polis_queue_tombstones t USING doomed d WHERE t.env=p_env AND t.kind='binding' AND t.ref=d.ref RETURNING 1)
  SELECT (SELECT count(*) FROM gone),(SELECT count(*) FROM untomb) INTO n_bind,n;
  more=more OR n>=5000;
  -- Whole jobs, with everything that hangs off them, in foreign key order.
  SELECT array_agg(x.job_id),array_agg(DISTINCT x.run_id) INTO ids,runs FROM (
   SELECT q.job_id,q.run_id FROM public.polis_queue_tombstones t
   JOIN public.polis_queue_jobs q ON q.env=t.env AND q.job_id=t.ref::uuid
   WHERE t.env=p_env AND t.kind='job' AND t.tombstoned_at<now_ts-grace
   ORDER BY t.tombstoned_at,q.job_id LIMIT 200 FOR UPDATE OF q SKIP LOCKED) x;
  IF ids IS NOT NULL THEN
   n_jobs=cardinality(ids); more=more OR n_jobs>=200;
   DELETE FROM public.polis_queue_logs l USING public.polis_queue_attempts a
   WHERE a.env=p_env AND a.job_id=ANY(ids) AND l.env=a.env AND l.attempt_id=a.attempt_id;
   GET DIAGNOSTICS n=ROW_COUNT; n_logs=n_logs+n;
   DELETE FROM public.delphi_provider_requests WHERE env=p_env AND job_id=ANY(ids);
   DELETE FROM public.delphi_job_inputs i USING public.delphi_jobs d
   WHERE d.env=p_env AND d.job_id=ANY(ids) AND i.zid=d.zid AND i.consumer_job_id=d.job_id;
   DELETE FROM public.polis_queue_requests WHERE env=p_env AND job_id=ANY(ids);
   GET DIAGNOSTICS n=ROW_COUNT; n_bind=n_bind+n;
   DELETE FROM public.polis_queue_tombstones t USING public.polis_queue_attempts a
   WHERE a.env=p_env AND a.job_id=ANY(ids) AND t.env=a.env AND t.kind='logs' AND t.ref=a.attempt_id::text;
   DELETE FROM public.polis_queue_attempts WHERE env=p_env AND job_id=ANY(ids);
   GET DIAGNOSTICS n_att=ROW_COUNT;
   DELETE FROM public.delphi_jobs WHERE env=p_env AND job_id=ANY(ids);
   DELETE FROM public.polis_queue_jobs WHERE env=p_env AND job_id=ANY(ids);
   DELETE FROM public.polis_queue_tombstones WHERE env=p_env AND kind='job' AND ref=ANY(SELECT unnest(ids)::text);
   DELETE FROM public.polis_queue_runs r WHERE r.env=p_env AND r.run_id=ANY(runs)
   AND NOT EXISTS(SELECT 1 FROM public.polis_queue_jobs q WHERE q.env=r.env AND q.run_id=r.run_id)
   AND NOT EXISTS(SELECT 1 FROM public.delphi_jobs d WHERE d.env=r.env AND d.run_id=r.run_id)
   AND NOT EXISTS(SELECT 1 FROM public.polis_queue_requests rq WHERE rq.env=r.env AND rq.run_id=r.run_id)
   AND NOT EXISTS(SELECT 1 FROM public.polis_queue_heads h WHERE h.env=r.env AND h.product_key=r.product_key
    AND (h.desired_run_id=r.run_id OR h.published_run_id=r.run_id));
   GET DIAGNOSTICS n_runs=ROW_COUNT;
  END IF;
  UPDATE public.polis_queue_retention_install SET rows_purged=rows_purged+n_logs+n_bind+n_jobs+n_att+n_runs
  WHERE n_logs+n_bind+n_jobs+n_att+n_runs>0;
 END IF;

 -- (3) Mark: deletable rows of the kinds whose action is delete.
 WITH pick AS (
  SELECT c.kind,c.policy_kind,c.ref,row_number() OVER (PARTITION BY c.kind ORDER BY c.ref) AS rn
  FROM public.pq_retention_candidates(p_env) c JOIN public.polis_queue_retention_policy p ON p.kind=c.policy_kind AND p.action='delete'
  WHERE NOT EXISTS(SELECT 1 FROM public.polis_queue_tombstones t WHERE t.env=p_env AND t.kind=c.kind AND t.ref=c.ref)),
 ins AS (
  INSERT INTO public.polis_queue_tombstones(env,kind,ref,policy_kind,sweep_id)
  SELECT p_env,kind,ref,policy_kind,p_sweep FROM pick WHERE rn<=CASE kind WHEN 'job' THEN 200 ELSE 5000 END
  RETURNING kind)
 SELECT count(*) FILTER (WHERE kind='job'),count(*) FILTER (WHERE kind='logs'),count(*) FILTER (WHERE kind='binding')
 INTO t_jobs,t_logs,t_bind FROM ins;
 more=more OR t_jobs>=200 OR t_logs>=5000 OR t_bind>=5000;

 -- (4) The sweep's own history.
 IF pol->'sweep_history'->>'action'='delete' THEN
  DELETE FROM public.polis_queue_sweeps WHERE env=p_env
  AND finished_at<now_ts-make_interval(days=>(pol->'sweep_history'->>'keep_days')::integer);
  GET DIAGNOSTICS n_sweeps=ROW_COUNT;
 END IF;

 page_counts=jsonb_build_object('log_rows_deleted',n_logs,'bindings_deleted',n_bind,'jobs_deleted',n_jobs,
  'attempts_deleted',n_att,'runs_deleted',n_runs,'sweeps_deleted',n_sweeps,
  'jobs_tombstoned',t_jobs,'logs_tombstoned',t_logs,'bindings_tombstoned',t_bind,'tombstones_restored',n_restored)||would;
 SELECT jsonb_object_agg(k,COALESCE((s.counts->>k)::bigint,0)+(page_counts->>k)::bigint) INTO totals
 FROM jsonb_object_keys(page_counts) k;
 IF NOT more THEN outcome='sweep_done'; stop='';
 ELSIF p_page=p_max_pages THEN outcome='sweep_done'; stop='budget';
 ELSE outcome='sweep_page'; stop=NULL; END IF;
 UPDATE public.polis_queue_sweeps SET pages=p_page,counts=totals,
  finished_at=CASE WHEN stop IS NULL THEN NULL ELSE clock_timestamp() END,stopped_by=stop
 WHERE env=p_env AND sweep_id=p_sweep;
 RETURN jsonb_build_object('schema_version','polis-queue/4','outcome',outcome,'env',p_env,'sweep_id',p_sweep,
  'page',p_page,'more',outcome='sweep_page','stopped_by',stop,'page_counts',page_counts,'counts',totals,'policy',pol);
END $$;

REVOKE ALL ON FUNCTION public.pq_class_parked(text,text,uuid,integer) FROM PUBLIC,polis_queue_executor;
REVOKE ALL ON FUNCTION public.pq_queue_usage(text) FROM PUBLIC,polis_queue_executor;
REVOKE ALL ON FUNCTION public.pq_sweep(text,uuid,integer,integer) FROM PUBLIC,polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pq_class_parked(text,text,uuid,integer) TO polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pq_queue_usage(text) TO polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pq_sweep(text,uuid,integer,integer) TO polis_queue_executor;

-- rows_purged: every row a sweep has purged, ever. The down refuses once it
-- is above zero (a purge cannot be undone); dry runs and tombstones leave it
-- at zero.
CREATE TABLE public.polis_queue_retention_install (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), baseline jsonb NOT NULL, installed jsonb NOT NULL,
 rows_purged bigint NOT NULL DEFAULT 0 CHECK(rows_purged>=0)
);
REVOKE ALL ON public.polis_queue_retention_install FROM PUBLIC,polis_queue_executor;
INSERT INTO public.polis_queue_retention_install(singleton,baseline,installed) VALUES(true,current_setting('queue4.baseline')::jsonb,pg_temp.pq4_state());
-- The ledger row, written as the applying login.
RESET ROLE;
INSERT INTO public.schema_migrations (name, checksum, note) VALUES ('000026_create_polis_queue_retention', '787ecd1406298d5cda944f4554166bdb6ed382b667bcf366f604b5ca154b70b3', 'queue retention, the parked and usage reads, the dead-job breaker; install stays polis-queue/3, replies /4'); -- ledger-self-checksum
COMMIT;
