-- STAND-IN for the polis-queue/3 migration (P-073 r2 §3 step 1). TEST FIXTURE ONLY.
--
-- The real migration is a separate pull request (the queue's class `large`
-- and stage `math_rebuild`), not merged when the poller's queue tests were
-- written. This file applies, on top of 000019 and 000023 (the sibling copy
-- of #2968's file), exactly the contract the poller calls, under the names
-- the plan gives them, so the tests can run against a real Postgres:
--
--   * polis_queue_jobs.stage admits 'math_rebuild'; worker_class admits
--     'large'; delphi_jobs.kind admits 'math_rebuild';
--   * pd_enqueue(...) (the 18-argument admission RPC of 000023) admits stage
--     'math_rebuild' with worker class 'large' and kind 'math_rebuild', under
--     the one-active-job-per-scope guard (delphi_job_guards): a guard whose
--     root job is terminal (succeeded, dead, cancelled) counts as released,
--     so a re-run for new input is a new row after the previous one finished;
--   * pq_claim(..., p_worker_class) and pq_reap(..., p_worker_class) take the
--     class as given ('delphi' or 'large') instead of being pinned to 'delphi';
--   * pq_class_depth(p_env, p_worker_class) -> {schema_version, outcome:
--     'class_depth', env, worker_class, queued (queued + retry_wait), running,
--     dead, oldest_created_at}, granted to polis_queue_executor.
--
-- When the real migration lands, the test fixture that applies this file is
-- pointed at it instead (tests/poller/test_capacity_queue_postgres.py); any
-- difference in names or reply shape is then a test failure to read, not a
-- silent drift. Nothing here is ever applied outside a test database.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;

ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_stage_check
 CHECK(stage IN ('noop','delphi_full_pipeline','delphi_narrative','math_rebuild'));
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_worker_class_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_worker_class_check
 CHECK(worker_class IN ('noop','delphi','large'));
ALTER TABLE public.delphi_jobs DROP CONSTRAINT delphi_jobs_kind_check;
ALTER TABLE public.delphi_jobs ADD CONSTRAINT delphi_jobs_kind_check
 CHECK(kind IN ('full_pipeline','embed','snapshot','umap','cluster','keywords',
 'topic_name','narrative','collective_statement','visualize','legacy_import','legacy_queue_record',
 'math_rebuild'));

-- The admission RPC of 000023 with the math_rebuild stage admitted (class
-- large, kind math_rebuild) and a terminal root job releasing its scope.
CREATE OR REPLACE FUNCTION public.pd_enqueue(p_env text,p_zid integer,p_product text,p_actor text,p_key text,p_request_sha text,
 p_run uuid,p_job uuid,p_input_uri text,p_input_sha text,p_config_sha text,p_image text,p_priority smallint,p_max_attempts integer,
 p_stage text,p_report text,p_scope text,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE g public.delphi_job_guards; j public.polis_queue_jobs; alias public.polis_queue_requests; reply jsonb;
 v_kind text; v_class text;
BEGIN
 IF p_stage IS NULL OR p_stage NOT IN ('delphi_full_pipeline','delphi_narrative','math_rebuild') OR p_scope IS NULL OR p_scope=''
 OR p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR (p_stage='delphi_narrative' AND COALESCE(p_report,'')='')
 THEN RAISE EXCEPTION 'invalid admission'; END IF;
 v_kind=CASE p_stage WHEN 'delphi_narrative' THEN 'narrative' WHEN 'math_rebuild' THEN 'math_rebuild' ELSE 'full_pipeline' END;
 v_class=CASE p_stage WHEN 'math_rebuild' THEN 'large' ELSE 'delphi' END;
 PERFORM 1 FROM public.conversations WHERE zid=p_zid FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown conversation'; END IF;
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
  IF j.state IN ('succeeded','dead','cancelled') THEN
   -- One active job per scope: a finished root job releases the scope.
   DELETE FROM public.delphi_job_guards WHERE env=p_env AND scope_key=p_scope;
  ELSE
   IF g.zid<>p_zid OR NOT EXISTS(SELECT 1 FROM public.delphi_jobs d WHERE d.job_id=g.root_job_id
    AND d.report_id IS NOT DISTINCT FROM p_report AND d.kind=v_kind)
    OR NOT EXISTS(SELECT 1 FROM public.polis_queue_runs r WHERE r.env=p_env AND r.run_id=j.run_id AND r.product_key=p_product)
    THEN RAISE EXCEPTION 'scope binding mismatch'; END IF;
   IF g.request_sha256<>p_request_sha THEN RETURN public.pq_result('conflict',j); END IF;
   INSERT INTO public.polis_queue_requests(env,actor_scope,product_key,request_key,request_sha256,run_id,job_id,binding_expires_at)
    VALUES(p_env,p_actor,p_product,p_key,p_request_sha,j.run_id,j.job_id,clock_timestamp()+interval '24 hours');
   RETURN public.pq_result('existing',j);
  END IF;
 END IF;
 reply=public.pq_enqueue(p_env,p_zid,p_product,p_actor,p_key,p_request_sha,p_run,p_job,p_input_uri,p_input_sha,p_config_sha,p_image,p_priority,p_max_attempts);
 IF reply->>'outcome'<>'enqueued' THEN RAISE EXCEPTION 'unexpected admission conflict'; END IF;
 UPDATE public.polis_queue_runs SET contract_version='polis-queue/2' WHERE env=p_env AND run_id=p_run;
 INSERT INTO public.delphi_jobs(job_id,env,zid,report_id,kind,run_id,origin,status,config_effective,code_version)
 VALUES(p_job,p_env,p_zid,p_report,v_kind,p_run,'queued','queued',p_config,p_image);
 UPDATE public.polis_queue_jobs SET stage=p_stage,worker_class=v_class WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 INSERT INTO public.delphi_job_guards VALUES(p_env,p_scope,p_zid,p_job,p_request_sha);
 UPDATE public.polis_queue_requests SET binding_expires_at=clock_timestamp()+interval '24 hours'
 WHERE env=p_env AND actor_scope=p_actor AND product_key=p_product AND request_key=p_key;
 RETURN public.pq_result('enqueued',j);
END $$;

-- The logical/execution binding check learns the new stage.
CREATE OR REPLACE FUNCTION public.pd_queue_binding() RETURNS trigger
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
 OR (q.stage='delphi_narrative' AND j.kind<>'narrative')
 OR (q.stage='math_rebuild' AND (j.kind<>'math_rebuild' OR q.worker_class<>'large'))
 OR (q.stage<>'math_rebuild' AND q.worker_class<>'delphi') THEN RAISE EXCEPTION 'invalid logical execution binding'; END IF;
 RETURN NULL;
END $$;

-- The claim takes the class as given.
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

-- The reaper takes the class as given (body as 000023, class check widened).
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
 RETURN jsonb_build_object('schema_version','polis-queue/2','outcome','reap_page',
 'next_after_job_id',CASE WHEN scanned<p_limit THEN NULL ELSE last_id END,'transitions',results);
END $$;

-- The one read the scale alarms need: counts of a worker class in an env.
CREATE FUNCTION public.pq_class_depth(p_env text,p_worker_class text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('schema_version','polis-queue/2','outcome','class_depth',
  'env',p_env,'worker_class',p_worker_class,
  'queued',COALESCE(count(*) FILTER (WHERE q.state IN ('queued','retry_wait')),0),
  'running',COALESCE(count(*) FILTER (WHERE q.state='running'),0),
  'dead',COALESCE(count(*) FILTER (WHERE q.state='dead'),0),
  'oldest_created_at',min(q.created_at) FILTER (WHERE q.state NOT IN ('succeeded','dead','cancelled')))
 FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.worker_class=p_worker_class
$$;
GRANT EXECUTE ON FUNCTION public.pq_class_depth(text,text) TO polis_queue_executor;
COMMIT;
