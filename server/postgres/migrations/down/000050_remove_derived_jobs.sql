-- down/000050_remove_derived_jobs.sql
--
-- Reverses 000050_add_derived_jobs.sql. Never run automatically.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000050_remove_derived_jobs.sql
--
-- Refuses, changing nothing, while any derived job, derived key or derived
-- input exists: a derived job's record is kept, never deleted to roll back.
-- The two tables are held first (ACCESS EXCLUSIVE, until COMMIT), so no
-- derived admission can commit between the check and the restore. Restores
-- each function to the body it had before 000050 and each CHECK to its
-- earlier list, validated (this scans polis_queue_jobs and delphi_jobs once
-- under that lock; seconds at most on millions of rows; queue work waits,
-- conversations, votes, comments and participants are not touched).
-- Runner history is not edited here; the operator removes the 000050 history
-- row in the same sitting, after this succeeds.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
LOCK TABLE public.polis_queue_jobs, public.delphi_jobs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.delphi_jobs WHERE kind='derived')
 OR EXISTS(SELECT 1 FROM public.polis_queue_jobs WHERE stage='delphi_derived' OR worker_class='derived')
 OR EXISTS(SELECT 1 FROM public.delphi_job_aliases WHERE source='derived')
 THEN RAISE EXCEPTION 'derived jobs exist; their records are kept, so 000050 is not reversed'; END IF;
END $$;
DROP FUNCTION public.pd_derived_admit(text,text,uuid,integer,jsonb,text);
CREATE OR REPLACE FUNCTION public.pq_claim(p_env text,p_priority smallint,p_owner uuid,p_attempt uuid,p_lease_seconds integer,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE j public.polis_queue_jobs;
BEGIN
 IF p_owner IS NULL OR p_attempt IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 900
 OR p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large') THEN RAISE EXCEPTION 'invalid claim'; END IF;
 WITH candidate AS (
  SELECT q.env,q.job_id FROM public.polis_queue_jobs q JOIN public.delphi_jobs d ON d.env=q.env AND d.job_id=q.job_id
  WHERE q.env=p_env AND q.priority=p_priority AND q.worker_class=p_worker_class
  AND q.stage NOT LIKE 'graph_%'
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
CREATE OR REPLACE FUNCTION public.pq_class_depth(p_env text,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE c record;
BEGIN
 IF p_env IS NULL OR p_env='' OR p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large')
 THEN RAISE EXCEPTION 'invalid class depth read'; END IF;
 SELECT count(*) FILTER (WHERE q.state IN ('queued','retry_wait') AND (q.stage NOT LIKE 'graph_%' OR (q.eligible_at<=statement_timestamp() AND q.attempt_count-q.parked_attempt_count<q.max_attempts AND public.pd_graph_readiness(q.env,q.job_id)->'blockers'='[]'::jsonb AND NOT EXISTS(SELECT 1 FROM public.polis_queue_attempts a WHERE a.env=q.env AND a.job_id=q.job_id AND a.process_exit_confirmed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM public.delphi_provider_requests pr WHERE pr.env=q.env AND pr.job_id=q.job_id AND pr.state IN ('intent','submission_unknown','submitted'))))) AS queued,
  count(*) FILTER (WHERE q.state='running') AS leased,
  count(*) FILTER (WHERE q.state='parked') AS parked,
  count(*) FILTER (WHERE q.state='dead') AS dead,
  min(q.created_at) FILTER (WHERE q.state NOT IN ('succeeded','dead','cancelled')) AS oldest
 INTO c FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.worker_class=p_worker_class;
 RETURN jsonb_build_object('schema_version','polis-queue/3','outcome','class_depth','env',p_env,'worker_class',p_worker_class,
  'queued',c.queued,'leased',c.leased,'parked',c.parked,'dead',c.dead,'oldest_unresolved_created_at',c.oldest);
END $$;
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
 -- The poison latch (no scope is held): the scope's last three jobs all dead
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
CREATE OR REPLACE FUNCTION public.pd_queue_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE q public.polis_queue_jobs; j public.delphi_jobs; r public.polis_queue_runs;
BEGIN
 SELECT * INTO q FROM public.polis_queue_jobs WHERE env=NEW.env AND job_id=NEW.job_id;
 IF EXISTS(SELECT 1 FROM public.delphi_graph_nodes gn WHERE gn.env=q.env AND gn.run_id=q.run_id) AND (SELECT count(*) FROM public.polis_queue_jobs jq WHERE jq.env=q.env AND jq.run_id=q.run_id)<>1 THEN RAISE EXCEPTION 'one computational job per run'; END IF;
 IF q.stage LIKE 'graph_%' THEN
  IF NOT EXISTS(SELECT 1 FROM public.delphi_graph_nodes n JOIN public.polis_queue_runs r USING(env,run_id) JOIN public.delphi_jobs d ON d.env=n.env AND d.job_id=n.job_id WHERE n.env=q.env AND n.job_id=q.job_id AND n.run_id=q.run_id AND r.contract_version='polis-queue/5' AND d.run_id=q.run_id AND d.zid=r.zid AND d.kind=substring(q.stage from 7)) THEN RAISE EXCEPTION 'invalid graph execution binding'; END IF;
  RETURN NULL;
 END IF;
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
CREATE OR REPLACE FUNCTION public.pd_writer_admit(p_env text,p_zid integer,p_scope text,p_actor text,p_key text,p_sha text,
 p_job uuid,p_run uuid,p_stage text,p_report text,p_config jsonb,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE frame text; conf jsonb; reply jsonb;writer_scope text;
BEGIN
 IF p_scope IS NULL OR length(p_scope) NOT BETWEEN 1 AND 128 OR p_stage NOT IN ('delphi_full_pipeline','delphi_narrative')
 OR p_code !~ '^[0-9a-f]{40,64}$' OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 128
 OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 128 OR p_sha !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid writer admission'; END IF;
 IF p_report IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.reports WHERE zid=p_zid AND report_id=p_report)
 THEN RAISE EXCEPTION 'report conversation mismatch'; END IF;
 -- One publication scope per conversation, including HTTP edits. Serialize
 -- admission with edits; an active producer retains its snapshot until completion.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:writer',p_env,p_zid,p_scope)::text,0));
 writer_scope='writer:'||public.pd_graph_hash(jsonb_build_array(p_zid,p_scope));
 PERFORM public.pd_release_scope(p_env,writer_scope);
 conf=p_config||jsonb_build_object('result_backend','postgres','result_scope',p_scope);
 frame=jsonb_build_object('schema','polis-jobs.admission/1','zid',p_zid,'report_id',p_report,'config',conf,'inputs','{}'::jsonb)::text;
 reply=public.pd_enqueue(p_env,p_zid,writer_scope,p_actor,p_key,p_sha,p_run,p_job,
  'frame://inline/'||rtrim(translate(replace(encode(convert_to(frame,'UTF8'),'base64'),chr(10),''),'+/','-_'),'='),
  encode(sha256(convert_to(frame,'UTF8')),'hex'),public.pd_graph_hash(conf),p_code,1::smallint,3,
  p_stage,p_report,writer_scope,conf);
 IF reply->>'outcome'='enqueued' THEN PERFORM public.pd_writer_bind(p_env,p_job,p_scope,p_actor); END IF;
 RETURN reply;
END $$;
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT pq_stage_derived;
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_stage_check CHECK(stage IN ('noop','delphi_full_pipeline','delphi_narrative','math_rebuild','graph_embed','graph_cluster','graph_topics','graph_narrative'));
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_worker_class_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_worker_class_check CHECK(worker_class IN ('noop','delphi','large'));
ALTER TABLE public.delphi_jobs DROP CONSTRAINT delphi_jobs_kind_check;
ALTER TABLE public.delphi_jobs ADD CONSTRAINT delphi_jobs_kind_check CHECK(kind IN ('full_pipeline','embed','snapshot','umap','cluster','keywords','topics','topic_name','narrative','collective_statement','visualize','math_rebuild','legacy_import','legacy_queue_record'));
COMMIT;
