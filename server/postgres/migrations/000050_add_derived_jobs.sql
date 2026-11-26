-- 000050_add_derived_jobs.sql
--
-- A derived job: a job that reads one finished run's stored results and
-- writes only what it adds (the first is a stored run's topic map). This
-- file adds the kind to the queue's closed lists, a worker class of its own,
-- and one admission function that gives every derived request a lasting
-- identity. No table, column or index is added; no operation, model or
-- version name appears here: those are chosen and validated by the caller
-- and arrive as an opaque 64-hex key and a JSON specification.
--
--   polis_queue_jobs   stage admits delphi_derived; worker_class admits
--                      derived; pq_stage_derived binds the two together.
--                      An existing daemon claims only delphi or large, so it
--                      never claims (or fails) a derived job.
--   delphi_jobs        kind admits derived.
--   pq_claim, pq_reap, pq_class_depth   the class list admits derived
--                      (bodies otherwise those of 000027 / 000024 / 000027).
--   pd_enqueue         delphi_derived -> kind derived, class derived, no
--                      report (otherwise 000024's body).
--   pd_queue_binding   delphi_derived binds only kind derived, class
--                      derived, no report (otherwise 000027's body).
--   pd_writer_admit    admits delphi_derived (otherwise 000030's body).
--   pd_derived_admit   NEW. Under a lock on the key: an existing job for the
--                      key is returned whatever its state (queued, running,
--                      succeeded, dead, cancelled); otherwise the source must
--                      be a succeeded job of the same env and conversation
--                      with a sealed output, or a one-word refusal is
--                      returned and nothing is written; otherwise the job is
--                      admitted through pd_writer_admit under its own scope
--                      ('derived:' || key), its source is recorded as its
--                      declared input (delphi_job_inputs, role 'source',
--                      with the source's output digest, which pq_claim
--                      already requires to still hold), and the key is
--                      recorded for good in delphi_job_aliases
--                      ('derived/1:' || key, source 'derived'), whose primary
--                      key is the lasting uniqueness. The 24-hour request
--                      alias of pd_enqueue is not relied on.
--   pq_claim, pq_reap_one, pq_end_attempt, pd_release_scope, pd_finalize
--                      A derived attempt needs no proof that its process
--                      exited. Its inputs are stored and digest-checked and
--                      its only writes (put, seal, finalize) are fenced by
--                      owner, attempt, epoch and live lease, so a worker that
--                      vanished leaves nothing that a later attempt must wait
--                      for. For stage delphi_derived only: claim does not
--                      wait on an unconfirmed old attempt; the reaper ends
--                      an expired attempt as an ordinary retry
--                      (lease_expired, one attempt of the job's budget)
--                      instead of parking it exit_unconfirmed; ending an
--                      attempt (fail, release, park) takes no exit proof and
--                      records none unless one is given (confirm_exit still
--                      requires it); pd_release_scope does not wait on such
--                      an attempt; finalize does not require one. Each body is
--                      the earlier one (000023, pd_finalize 000030) with that
--                      one stage condition added (pq_end_attempt: in its
--                      proof check and in the stamp it then writes). Every
--                      other stage keeps its exit-proof and provider checks
--                      exactly; provider checks apply to derived jobs too.
--
-- Compatibility: additive. An earlier release never names the new stage,
-- class, kind or function; its daemons claim only their own classes; every
-- function keeps its signature, owner, SECURITY DEFINER, search_path and
-- grants, and behaves as before for every existing stage and class.
--
-- Locks at deploy are held until this file's COMMIT. Adding the CHECKs
-- NOT VALID avoids scanning existing rows; it does not bound lock duration.
--   polis_queue_jobs  ACCESS EXCLUSIVE (DROP/ADD CONSTRAINT): queue claims,
--                     heartbeats and admissions wait until commit/rollback.
--   delphi_jobs       ACCESS EXCLUSIVE (DROP/ADD CONSTRAINT): likewise.
--   CREATE OR REPLACE FUNCTION changes catalog entries, not table rows.
-- conversations, votes, comments and participants are not touched or locked.
-- lock_timeout is 5 s per lock acquisition, not for the whole file or for
-- how long an acquired lock is held. If a conflicting lock is not released
-- within that wait, the transaction rolls back with no history row and the
-- next deploy retries. Earlier locks remain held through later statements
-- and their waits until the transaction ends. No elapsed duration is promised.
--
-- NOT VALID is exact here: each new list is a superset of the validated list
-- it replaces, in the same transaction, so every existing row satisfies it,
-- and PostgreSQL enforces a NOT VALID CHECK on every row inserted or updated
-- from now on. An operator may VALIDATE them later (SHARE UPDATE EXCLUSIVE,
-- which blocks no reads or writes).
--
-- Way back: down/000050_remove_derived_jobs.sql, run by hand; it refuses
-- while any derived job, alias or input exists.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_stage_check CHECK(stage IN ('noop','delphi_full_pipeline','delphi_narrative','math_rebuild','graph_embed','graph_cluster','graph_topics','graph_narrative','delphi_derived')) NOT VALID;
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_worker_class_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_worker_class_check CHECK(worker_class IN ('noop','delphi','large','derived')) NOT VALID;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT pq_stage_derived CHECK((stage='delphi_derived')=(worker_class='derived')) NOT VALID;
ALTER TABLE public.delphi_jobs DROP CONSTRAINT delphi_jobs_kind_check;
ALTER TABLE public.delphi_jobs ADD CONSTRAINT delphi_jobs_kind_check CHECK(kind IN ('full_pipeline','embed','snapshot','umap','cluster','keywords','topics','topic_name','narrative','collective_statement','visualize','math_rebuild','legacy_import','legacy_queue_record','derived')) NOT VALID;
CREATE OR REPLACE FUNCTION public.pq_claim(p_env text,p_priority smallint,p_owner uuid,p_attempt uuid,p_lease_seconds integer,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE j public.polis_queue_jobs;
BEGIN
 IF p_owner IS NULL OR p_attempt IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 900
 OR p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large','derived') THEN RAISE EXCEPTION 'invalid claim'; END IF;
 WITH candidate AS (
  SELECT q.env,q.job_id FROM public.polis_queue_jobs q JOIN public.delphi_jobs d ON d.env=q.env AND d.job_id=q.job_id
  WHERE q.env=p_env AND q.priority=p_priority AND q.worker_class=p_worker_class
  AND q.stage NOT LIKE 'graph_%'
  AND q.state IN ('queued','retry_wait') AND q.eligible_at<=statement_timestamp()
  AND q.attempt_count-q.parked_attempt_count<q.max_attempts
  AND NOT EXISTS(SELECT 1 FROM public.delphi_job_inputs i JOIN public.delphi_jobs p ON p.job_id=i.producer_job_id
   WHERE i.consumer_job_id=q.job_id AND (p.status<>'succeeded' OR p.output_manifest_digest IS DISTINCT FROM i.producer_output_digest))
  -- An expired lease is not evidence that the previous process stopped.
  -- A derived attempt needs no such evidence: its only writes are fenced.
  AND (q.stage='delphi_derived' OR NOT EXISTS(SELECT 1 FROM public.polis_queue_attempts a WHERE a.env=q.env AND a.job_id=q.job_id AND a.process_exit_confirmed_at IS NULL))
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
-- The four bodies below are 000023's (pd_finalize: 000030's), each with one
-- condition added for stage delphi_derived and nothing else changed.
CREATE OR REPLACE FUNCTION public.pq_reap_one(p_env text,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; s text;
BEGIN
 j=public.pq_lock(p_env,p_job,true,false); IF j.job_id IS NULL THEN RETURN NULL; END IF;
 IF j.stage NOT IN ('noop','delphi_derived') AND j.state='running' AND j.locked_until<=clock_timestamp() THEN
  j=public.pq_terminate_attempt(j,'parked','expired','exit_unconfirmed');
  UPDATE public.polis_queue_jobs SET parked_attempt_count=parked_attempt_count-1 WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
  RETURN public.pq_result('parked',j);
 END IF;
 IF j.stage<>'noop' AND (
 (j.stage<>'delphi_derived' AND EXISTS(SELECT 1 FROM public.polis_queue_attempts WHERE env=p_env AND job_id=p_job AND process_exit_confirmed_at IS NULL))
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
CREATE OR REPLACE FUNCTION public.pq_end_attempt(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,
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
 OR (p_process_exit_confirmed IS DISTINCT FROM true AND (j.stage<>'delphi_derived' OR p_action='confirm_exit')) THEN RAISE EXCEPTION 'process exit proof required'; END IF;
 UPDATE public.polis_queue_attempts SET process_exit_confirmed_at=COALESCE(process_exit_confirmed_at,clock_timestamp())
 WHERE env=p_env AND attempt_id=p_attempt AND p_process_exit_confirmed;
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
CREATE OR REPLACE FUNCTION public.pd_release_scope(p_env text,p_scope text) RETURNS boolean
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
 OR EXISTS(SELECT 1 FROM public.polis_queue_attempts a WHERE a.env=p_env AND a.job_id=ANY(ids) AND a.process_exit_confirmed_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.polis_queue_jobs q WHERE q.env=a.env AND q.job_id=a.job_id AND q.stage='delphi_derived'))
 OR EXISTS(SELECT 1 FROM public.delphi_provider_requests WHERE env=p_env AND job_id=ANY(ids) AND state IN ('intent','submission_unknown','submitted')) THEN RETURN false; END IF;
 DELETE FROM public.delphi_job_guards WHERE env=p_env AND scope_key=p_scope;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.pd_finalize(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_uri text,p_sha text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE j public.polis_queue_jobs; a public.polis_queue_attempts; r public.polis_queue_runs; raw text; m jsonb;
BEGIN
 j=public.pd_lock(p_env,p_job);
 IF j.stage LIKE 'graph_%' THEN RAISE EXCEPTION 'graph manifest required'; END IF;
 SELECT * INTO a FROM public.polis_queue_attempts WHERE env=p_env AND job_id=p_job AND attempt_id=p_attempt;
 SELECT * INTO r FROM public.polis_queue_runs WHERE env=p_env AND run_id=j.run_id;
 IF j.state='succeeded' AND j.terminal_attempt_id=p_attempt AND a.owner_id=p_owner AND a.lease_epoch=p_epoch THEN
  RETURN public.pq_result(CASE WHEN a.output_sha256=p_sha AND r.expected_output_uri=p_uri THEN 'already_succeeded' ELSE 'invalid_output' END,j);
 END IF;
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RETURN public.pq_result('fenced',j); END IF;
 IF a.process_exit_confirmed_at IS NULL AND j.stage<>'delphi_derived' THEN RAISE EXCEPTION 'process exit proof required'; END IF;
 IF p_uri IS NULL OR p_uri !~ '^file://.+' OR length(p_uri)>2048 OR p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$'
 THEN RETURN public.pq_result('invalid_output',j); END IF;
 SELECT line INTO raw FROM public.polis_queue_logs WHERE env=p_env AND attempt_id=p_attempt AND stream='manifest'
 AND encode(sha256(convert_to(line,'UTF8')),'hex')=p_sha ORDER BY seq DESC LIMIT 1;
 IF raw IS NULL THEN RETURN public.pq_result('invalid_output',j); END IF;
 BEGIN m=raw::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN public.pq_result('invalid_output',j); END;
 IF (m->>'schema' IS DISTINCT FROM 'polis-jobs.output-manifest/1' AND m->>'schema' IS DISTINCT FROM 'polis-jobs.output-manifest/2')
 OR m->>'job_id' IS DISTINCT FROM p_job::text OR m->>'attempt_id' IS DISTINCT FROM p_attempt::text
 OR m->>'stage' IS DISTINCT FROM j.stage OR m->>'outcome' IS DISTINCT FROM 'succeeded'
 OR COALESCE(m->>'phase','') NOT IN ('submit','recheck','run')
 OR jsonb_typeof(m->'outputs') IS DISTINCT FROM 'array'
 OR jsonb_typeof(m->'inputs') IS DISTINCT FROM 'object'
 OR jsonb_typeof(m->'models') IS DISTINCT FROM 'object'
 OR jsonb_typeof(m->'cost') IS DISTINCT FROM 'object'
 OR (m ? 'artifacts' AND m->'artifacts'<>'[]'::jsonb)
 THEN RETURN public.pq_result('invalid_output',j); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(m->'outputs') o WHERE o->>'store' IS DISTINCT FROM CASE WHEN m->>'schema'='polis-jobs.output-manifest/2' THEN 'postgres' ELSE 'dynamodb' END
 OR COALESCE(o->>'table','')='' OR NOT (o ? 'keys' OR o ? 'key_prefix') OR COALESCE(o->>'rows','') !~ '^[0-9]+$')
 THEN RETURN public.pq_result('invalid_output',j); END IF;
 IF EXISTS(SELECT 1 FROM public.delphi_provider_requests WHERE env=p_env AND job_id=p_job AND state IN ('intent','submission_unknown','submitted'))
 THEN RAISE EXCEPTION 'provider request unresolved'; END IF;
 IF EXISTS(SELECT 1 FROM public.delphi_writer_runs WHERE env=p_env AND job_id=p_job) THEN
  IF m->>'schema' IS DISTINCT FROM 'polis-jobs.output-manifest/2' OR NOT (m ? 'results') OR m ? 'family_spool'
  THEN RETURN public.pq_result('invalid_output',j); END IF;
  PERFORM public.pd_writer_publish(p_env,p_job,p_attempt,m->'results');
 ELSIF m->>'schema'<>'polis-jobs.output-manifest/1' THEN RETURN public.pq_result('invalid_output',j);
 END IF;
 UPDATE public.polis_queue_attempts SET outcome='succeeded',ended_at=clock_timestamp(),output_sha256=p_sha WHERE env=p_env AND attempt_id=p_attempt;
 UPDATE public.polis_queue_jobs SET state='succeeded',terminal_attempt_id=p_attempt,owner_id=NULL,attempt_id=NULL,locked_until=NULL,
 output_sha256=p_sha,version=version+1,mgmt_version=mgmt_version+1,updated_at=clock_timestamp() WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 UPDATE public.delphi_jobs SET output_manifest_digest=decode(p_sha,'hex') WHERE env=p_env AND job_id=p_job;
 UPDATE public.polis_queue_runs SET state='succeeded',expected_output_uri=p_uri,expected_output_sha256=p_sha,output_sha256=p_sha WHERE env=p_env AND run_id=j.run_id;
 RETURN public.pq_result('succeeded',j,false);
END $$;
CREATE OR REPLACE FUNCTION public.pq_reap(p_env text,p_after_job uuid,p_limit integer,p_worker_class text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE id uuid; reply jsonb; last_id uuid; scanned integer=0; results jsonb='[]'::jsonb;
BEGIN
 IF p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large','derived') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
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
 IF p_env IS NULL OR p_env='' OR p_worker_class IS NULL OR p_worker_class NOT IN ('delphi','large','derived')
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
 IF p_stage IS NULL OR p_stage NOT IN ('delphi_full_pipeline','delphi_narrative','math_rebuild','delphi_derived') OR p_scope IS NULL OR p_scope=''
 OR p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR (p_stage='delphi_narrative' AND COALESCE(p_report,'')='')
 OR (p_stage='math_rebuild' AND p_report IS NOT NULL) OR (p_stage='delphi_derived' AND p_report IS NOT NULL)
 THEN RAISE EXCEPTION 'invalid admission'; END IF;
 v_kind=CASE p_stage WHEN 'delphi_narrative' THEN 'narrative' WHEN 'math_rebuild' THEN 'math_rebuild' WHEN 'delphi_derived' THEN 'derived' ELSE 'full_pipeline' END;
 v_class=CASE p_stage WHEN 'math_rebuild' THEN 'large' WHEN 'delphi_derived' THEN 'derived' ELSE 'delphi' END;
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
 OR (q.stage='delphi_derived' AND (j.kind<>'derived' OR q.worker_class<>'derived' OR j.report_id IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid logical execution binding'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.pd_writer_admit(p_env text,p_zid integer,p_scope text,p_actor text,p_key text,p_sha text,
 p_job uuid,p_run uuid,p_stage text,p_report text,p_config jsonb,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE frame text; conf jsonb; reply jsonb;writer_scope text;
BEGIN
 IF p_scope IS NULL OR length(p_scope) NOT BETWEEN 1 AND 128 OR p_stage NOT IN ('delphi_full_pipeline','delphi_narrative','delphi_derived')
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
-- p_spec NULL: look up only (an existing job, a refusal, or 'none' when the
-- source would be admitted). p_spec present: admit. The caller validates the
-- specification against the source's stored record before admitting; this
-- function owns only what must be atomic: the key, the source's state, and
-- recording the job, its input and its key together.
CREATE FUNCTION public.pd_derived_admit(p_env text,p_key text,p_source uuid,p_zid integer,p_spec jsonb,p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE pid text; a public.delphi_job_aliases; d public.delphi_jobs; s public.delphi_jobs; q public.polis_queue_jobs; reply jsonb; why text;
BEGIN
 IF p_env IS NULL OR p_env='' OR p_key IS NULL OR p_key!~'^[0-9a-f]{64}$' OR p_source IS NULL OR p_zid IS NULL
 OR (p_spec IS NOT NULL AND (jsonb_typeof(p_spec)<>'object' OR p_spec->>'key' IS DISTINCT FROM p_key
  OR p_spec#>>'{source,job_id}' IS DISTINCT FROM p_source::text OR p_code IS NULL))
 THEN RAISE EXCEPTION 'invalid derived admission'; END IF;
 pid='derived/1:'||p_key;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:derived',pid)::text,0));
 SELECT * INTO a FROM public.delphi_job_aliases WHERE public_id=pid;
 IF FOUND THEN
  SELECT * INTO STRICT d FROM public.delphi_jobs WHERE job_id=a.job_id;
  IF a.source<>'derived' OR d.env<>p_env OR d.kind<>'derived' THEN RAISE EXCEPTION 'derived key binding mismatch'; END IF;
  IF d.zid<>p_zid THEN RETURN jsonb_build_object('schema_version','polis-queue/2','outcome','refused','reason','source_conversation'); END IF;
  SELECT * INTO STRICT q FROM public.polis_queue_jobs WHERE env=d.env AND job_id=d.job_id;
  RETURN public.pq_result(CASE WHEN p_spec IS NULL OR d.config_effective->'derived'=p_spec THEN 'existing' ELSE 'conflict' END,q)
   ||jsonb_build_object('derived',d.config_effective->'derived');
 END IF;
 SELECT * INTO s FROM public.delphi_jobs WHERE job_id=p_source;
 why=CASE WHEN NOT FOUND THEN 'source_missing' WHEN s.env<>p_env THEN 'source_env' WHEN s.zid<>p_zid THEN 'source_conversation'
  WHEN s.status<>'succeeded' OR s.output_manifest_digest IS NULL THEN 'source_not_succeeded' END;
 IF why IS NOT NULL THEN RETURN jsonb_build_object('schema_version','polis-queue/2','outcome','refused','reason',why); END IF;
 IF p_spec IS NULL THEN RETURN jsonb_build_object('schema_version','polis-queue/2','outcome','none'); END IF;
 reply=public.pd_writer_admit(p_env,p_zid,'derived:'||p_key,'derived',p_key,encode(sha256(convert_to(p_spec::text,'UTF8')),'hex'),
  gen_random_uuid(),gen_random_uuid(),'delphi_derived',NULL,jsonb_build_object('derived',p_spec),p_code);
 IF reply->>'outcome' IS DISTINCT FROM 'enqueued' THEN RAISE EXCEPTION 'derived admission did not enqueue: %',reply->>'outcome'; END IF;
 INSERT INTO public.delphi_job_inputs(zid,consumer_job_id,input_role,ordinal,producer_job_id,producer_output_digest)
  VALUES(p_zid,(reply->>'job_id')::uuid,'source',0,p_source,s.output_manifest_digest);
 INSERT INTO public.delphi_job_aliases(public_id,job_id,source) VALUES(pid,(reply->>'job_id')::uuid,'derived');
 RETURN reply||jsonb_build_object('derived',p_spec);
END $$;
REVOKE ALL ON FUNCTION public.pd_derived_admit(text,text,uuid,integer,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pd_derived_admit(text,text,uuid,integer,jsonb,text) TO polis_queue_executor;
COMMIT;
