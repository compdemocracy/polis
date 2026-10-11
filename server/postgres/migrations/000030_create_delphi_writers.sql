-- #1448: durable writers behind DELPHI_RESULT_BACKEND=postgres.
-- Prior artifacts and migration bytes remain immutable. No vote writes.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
CREATE TABLE public.delphi_writer_runs(
 env text NOT NULL,job_id uuid NOT NULL,zid integer NOT NULL,scope_key text NOT NULL,
 base_generation bigint NOT NULL,base_artifact uuid,actor text NOT NULL,
 PRIMARY KEY(env,job_id), FOREIGN KEY(env,job_id) REFERENCES public.delphi_graph_nodes,
 FOREIGN KEY(env,base_artifact) REFERENCES public.delphi_artifacts
);
CREATE TRIGGER writer_run_immutable BEFORE UPDATE OR DELETE ON public.delphi_writer_runs
 FOR EACH ROW EXECUTE FUNCTION public.pd_graph_immutable();
-- Called only by admission under the publication lock. Bind the existing /2
-- provider lifecycle to /5 immutable result storage without changing its stage.
CREATE FUNCTION public.pd_writer_bind(p_env text,p_job uuid,p_scope text,p_actor text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.delphi_jobs; s public.delphi_graph_served; gid uuid=gen_random_uuid();
BEGIN
 SELECT * INTO STRICT j FROM public.delphi_jobs WHERE env=p_env AND job_id=p_job;
 SELECT * INTO s FROM public.delphi_graph_served WHERE env=p_env AND zid=j.zid AND scope_key=p_scope;
 INSERT INTO public.delphi_graphs(env,graph_id,zid,scope_key,request_key,request,root_job_id)
 VALUES(p_env,gid,j.zid,p_scope,p_job::text,jsonb_build_object('schema','delphi-writer/1','actor',p_actor),p_job);
 INSERT INTO public.delphi_graph_nodes(env,zid,graph_id,job_id,run_id,node_key,declared)
 VALUES(p_env,j.zid,gid,p_job,j.run_id,'writer',jsonb_build_object('schema','delphi-writer/1','config',j.config_effective));
 IF s.artifact_id IS NOT NULL THEN
  INSERT INTO public.delphi_graph_edges(env,consumer,producer,input_role,expected_sha,artifact_id)
  SELECT p_env,p_job,a.job_id,'previous',a.content_sha,a.artifact_id FROM public.delphi_artifacts a
  WHERE a.env=p_env AND a.artifact_id=s.artifact_id;
 END IF;
 UPDATE public.delphi_graphs SET sealed=true WHERE env=p_env AND graph_id=gid;
 INSERT INTO public.delphi_writer_runs VALUES(p_env,p_job,j.zid,p_scope,COALESCE(s.generation,0),s.artifact_id,p_actor);
END $$;
CREATE FUNCTION public.pd_writer_admit(p_env text,p_zid integer,p_scope text,p_actor text,p_key text,p_sha text,
 p_job uuid,p_run uuid,p_stage text,p_report text,p_config jsonb,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE frame text; conf jsonb; reply jsonb;guard text;
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
 guard='writer:'||public.pd_graph_hash(jsonb_build_array(p_zid,p_scope));
 PERFORM public.pd_release_scope(p_env,guard);
 conf=p_config||jsonb_build_object('result_backend','postgres','result_scope',p_scope);
 frame=jsonb_build_object('schema','polis-jobs.admission/1','zid',p_zid,'report_id',p_report,'config',conf,'inputs','{}'::jsonb)::text;
 reply=public.pd_enqueue(p_env,p_zid,guard,p_actor,p_key,p_sha,p_run,p_job,
  'frame://inline/'||rtrim(translate(replace(encode(convert_to(frame,'UTF8'),'base64'),chr(10),''),'+/','-_'),'='),
  encode(sha256(convert_to(frame,'UTF8')),'hex'),public.pd_graph_hash(conf),p_code,1::smallint,3,
  p_stage,p_report,guard,conf);
 IF reply->>'outcome'='enqueued' THEN PERFORM public.pd_writer_bind(p_env,p_job,p_scope,p_actor); END IF;
 RETURN reply;
END $$;
-- Daemon reads the immutable base; no queue credential reaches Python.
CREATE FUNCTION public.pd_writer_base(p_env text,p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('schema','delphi-writer-base/1','zid',w.zid,'scope',w.scope_key,
 'generation',w.base_generation,'artifact_id',w.base_artifact,
 'families',COALESCE((SELECT jsonb_object_agg(family,rows) FROM (
 SELECT family,jsonb_agg(item ORDER BY ordinal) rows FROM public.pd_result_bundle_rows(w.env,w.base_artifact) GROUP BY family) f),'{}'::jsonb))
 FROM public.delphi_writer_runs w WHERE env=p_env AND job_id=p_job
$$;
CREATE FUNCTION public.pd_writer_publish(p_env text,p_job uuid,p_attempt uuid,p_results jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.delphi_writer_runs; aid uuid;gen bigint;wire text;j public.polis_queue_jobs;
BEGIN
 SELECT * INTO STRICT w FROM public.delphi_writer_runs WHERE env=p_env AND job_id=p_job;
 SELECT * INTO STRICT j FROM public.polis_queue_jobs WHERE env=p_env AND job_id=p_job;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:writer',p_env,w.zid,w.scope_key)::text,0));
 SELECT generation INTO gen FROM public.delphi_graph_served WHERE env=p_env AND zid=w.zid AND scope_key=w.scope_key FOR UPDATE;
 IF COALESCE(gen,0)<>w.base_generation THEN RAISE EXCEPTION 'writer publication conflict'; END IF;
 IF p_results IS DISTINCT FROM public.pd_result_seal_internal(p_env,p_attempt) THEN RAISE EXCEPTION 'writer result seal mismatch'; END IF;
 wire=jsonb_build_object('schema','delphi-writer-result/1','results',p_results,'legacy_control_files',COALESCE((SELECT payload::jsonb->'legacy_control_files' FROM public.delphi_artifacts WHERE env=p_env AND artifact_id=w.base_artifact),'{}'::jsonb))::text;
 INSERT INTO public.delphi_artifacts(env,job_id,run_id,attempt_id,output_role,schema_version,payload,content_sha,byte_count)
 VALUES(p_env,p_job,j.run_id,p_attempt,'result','delphi-writer-result/1',wire,encode(sha256(convert_to(wire,'UTF8')),'hex'),octet_length(wire)) RETURNING artifact_id INTO aid;
 INSERT INTO public.delphi_graph_served VALUES(p_env,w.zid,w.scope_key,w.base_generation+1,aid)
 ON CONFLICT(env,zid,scope_key) DO UPDATE SET generation=EXCLUDED.generation,artifact_id=EXCLUDED.artifact_id;
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
 IF a.process_exit_confirmed_at IS NULL THEN RAISE EXCEPTION 'process exit proof required'; END IF;
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

-- Canonical JSON for codec bytes (JSONB's display order is not canonical).
CREATE FUNCTION public.pd_writer_json(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE
 SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'object' THEN RETURN '{'||COALESCE((SELECT string_agg(to_jsonb(key)::text||':'||public.pd_writer_json(value),',' ORDER BY key COLLATE "C") FROM jsonb_each(v)),'')||'}';
 WHEN 'array' THEN RETURN '['||COALESCE((SELECT string_agg(public.pd_writer_json(value),',' ORDER BY ord) FROM jsonb_array_elements(v) WITH ORDINALITY a(value,ord)),'')||']';
 ELSE RETURN v::text; END CASE;
END $$;
-- Synchronous API edits use a completed producer/attempt in the same transaction.
-- Only three audited HTTP families are writable here. The canonical key derives
-- the conversation; caller-supplied zids cannot redirect a report's results.
CREATE FUNCTION public.pd_result_mutate(p_env text,p_scope text,p_actor text,p_request uuid,p_family text,p_operation text,p_item jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE v_zid integer; jid uuid=gen_random_uuid();rid uuid=gen_random_uuid();aid uuid=gen_random_uuid();owner uuid=gen_random_uuid();
 reply jsonb; k jsonb; spec jsonb; wire text;ref jsonb;guard text;old_item jsonb;line jsonb;
BEGIN
 IF p_family NOT IN ('Delphi_CollectiveStatement','Delphi_NarrativeReports','report_narrative_store') OR p_operation NOT IN ('put','delete')
 OR jsonb_typeof(p_item) IS DISTINCT FROM 'object' OR octet_length(p_item::text)>1048576
 THEN RAISE EXCEPTION 'invalid synchronous result mutation'; END IF;
 IF p_family='Delphi_CollectiveStatement' THEN v_zid=split_part(p_item->'zid_topic_jobid'->>'S','#',1)::integer;
 ELSE SELECT r.zid INTO STRICT v_zid FROM public.reports r WHERE report_id=split_part(p_item->'rid_section_model'->>'S','#',1); END IF;
 SELECT key_spec INTO STRICT spec FROM public.delphi_result_catalog WHERE family=p_family;
 SELECT jsonb_agg(p_item->(part->>0)) INTO k FROM jsonb_array_elements(spec) part;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(k) v WHERE v='null'::jsonb) THEN RAISE EXCEPTION 'missing result key'; END IF;
 reply=public.pd_writer_admit(p_env,v_zid,p_scope,p_actor,p_request::text,
 public.pd_graph_hash(jsonb_build_array(p_family,p_operation,p_item)),jid,rid,'delphi_full_pipeline',NULL,
 jsonb_build_object('synchronous',true),encode(sha256(convert_to(pg_get_functiondef('public.pd_result_mutate(text,text,text,uuid,text,text,jsonb)'::regprocedure),'UTF8')),'hex'));
 IF reply->>'outcome'<>'enqueued' THEN
  IF reply->>'outcome'='existing' AND reply->>'state'='succeeded' THEN RETURN reply; END IF;
  RAISE EXCEPTION 'result scope busy or request conflict';
 END IF;
 -- No child or provider is started. The in-transaction producer owns only jid.
 UPDATE public.polis_queue_jobs SET state='running',owner_id=owner,attempt_id=aid,lease_epoch=lease_epoch+1,
 attempt_count=attempt_count+1,locked_until=clock_timestamp()+interval '60 seconds',version=version+1,mgmt_version=mgmt_version+1
 WHERE env=p_env AND job_id=jid;
 INSERT INTO public.polis_queue_attempts(env,attempt_id,job_id,owner_id,lease_epoch,outcome,process_exit_confirmed_at)
 VALUES(p_env,aid,jid,owner,1,'running',clock_timestamp());
 SELECT item INTO old_item FROM public.delphi_result_current_rows WHERE env=p_env AND scope_key=p_scope AND family=p_family AND item_key=k AND delphi_result_current_rows.zid=v_zid;
 wire=public.pd_writer_json(jsonb_build_object('codec','delphi-storage-codec/1','family',p_family,'key',(SELECT jsonb_agg(part->0) FROM jsonb_array_elements(spec) part)))||chr(10);
 FOR line IN SELECT doc FROM (
  SELECT item AS doc,item_key AS sort_key FROM public.delphi_result_current_rows
  WHERE env=p_env AND scope_key=p_scope AND family=p_family AND item_key<>k AND delphi_result_current_rows.zid=v_zid
  UNION ALL SELECT p_item,k WHERE p_operation='put'
 ) items ORDER BY public.pd_writer_json(sort_key) COLLATE "C" LOOP
  wire=wire||public.pd_writer_json(line)||chr(10);
 END LOOP;
 PERFORM public.pd_result_put_family(p_env,jid,owner,aid,1,p_family,wire);
 ref=public.pd_result_seal(p_env,jid,owner,aid,1);
 PERFORM public.pd_writer_publish(p_env,jid,aid,ref);
 UPDATE public.polis_queue_attempts SET outcome='succeeded',ended_at=clock_timestamp(),output_sha256=ref->>'sha256' WHERE env=p_env AND attempt_id=aid;
 UPDATE public.polis_queue_jobs SET state='succeeded',terminal_attempt_id=aid,owner_id=NULL,attempt_id=NULL,locked_until=NULL,
 output_sha256=ref->>'sha256',version=version+1,mgmt_version=mgmt_version+1 WHERE env=p_env AND job_id=jid;
 UPDATE public.polis_queue_runs SET state='succeeded',output_sha256=ref->>'sha256' WHERE env=p_env AND run_id=rid;
 guard='writer:'||public.pd_graph_hash(jsonb_build_array(v_zid,p_scope));
 PERFORM public.pd_release_scope(p_env,guard);
 RETURN jsonb_build_object('outcome','succeeded','job_id',jid,'previous',old_item);
END $$;
REVOKE ALL ON public.delphi_writer_runs FROM PUBLIC,polis_queue_executor;
REVOKE ALL ON FUNCTION public.pd_writer_bind(text,uuid,text,text),public.pd_writer_publish(text,uuid,uuid,jsonb) FROM PUBLIC,polis_queue_executor;
REVOKE ALL ON FUNCTION public.pd_writer_admit(text,integer,text,text,text,text,uuid,uuid,text,text,jsonb,text),public.pd_writer_base(text,uuid),public.pd_result_mutate(text,text,text,uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pd_writer_admit(text,integer,text,text,text,text,uuid,uuid,text,text,jsonb,text),public.pd_writer_base(text,uuid),public.pd_result_mutate(text,text,text,uuid,text,text,jsonb) TO polis_queue_executor;
COMMIT;
