-- Draft #1428, step 7. Run-bound, immutable Delphi results on graph contract /5.
-- Does not rewrite historical migrations or mutate any vote or result row.
BEGIN;
SET LOCAL lock_timeout='5s';
GRANT SELECT(report_id,zid) ON public.reports TO polis_queue_owner;
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
CREATE TABLE public.delphi_result_catalog(family text PRIMARY KEY, key_spec jsonb NOT NULL);
INSERT INTO public.delphi_result_catalog VALUES
('Delphi_PCAConversationConfig','[["zid", "S"]]'::jsonb),
('Delphi_PCAResults','[["zid", "S"], ["math_tick", "N"]]'::jsonb),
('Delphi_KMeansClusters','[["zid_tick", "S"], ["group_id", "N"]]'::jsonb),
('Delphi_CommentRouting','[["zid_tick", "S"], ["comment_id", "S"]]'::jsonb),
('Delphi_RepresentativeComments','[["zid_tick_gid", "S"], ["comment_id", "S"]]'::jsonb),
('Delphi_PCAParticipantProjections','[["zid_tick", "S"], ["participant_id", "S"]]'::jsonb),
('Delphi_UMAPConversationConfig','[["conversation_id", "S"]]'::jsonb),
('Delphi_CommentEmbeddings','[["conversation_id", "S"], ["comment_id", "N"]]'::jsonb),
('Delphi_CommentHierarchicalClusterAssignments','[["conversation_id", "S"], ["comment_id", "N"]]'::jsonb),
('Delphi_CommentClustersStructureKeywords','[["conversation_id", "S"], ["cluster_key", "S"]]'::jsonb),
('Delphi_UMAPGraph','[["conversation_id", "S"], ["edge_id", "S"]]'::jsonb),
('Delphi_CommentClustersFeatures','[["conversation_id", "S"], ["cluster_key", "S"]]'::jsonb),
('Delphi_CommentClustersLLMTopicNames','[["conversation_id", "S"], ["topic_key", "S"]]'::jsonb),
('Delphi_NarrativeReports','[["rid_section_model", "S"], ["timestamp", "S"]]'::jsonb),
('Delphi_CommentExtremity','[["conversation_id", "S"], ["comment_id", "S"]]'::jsonb),
('Delphi_TopicAgendaSelections','[["conversation_id", "S"], ["participant_id", "S"]]'::jsonb),
('Delphi_CollectiveStatement','[["zid_topic_jobid", "S"]]'::jsonb),
('report_narrative_store','[["rid_section_model", "S"], ["timestamp", "S"]]'::jsonb);
CREATE TABLE public.delphi_result_batches(
 env text NOT NULL, batch_id uuid NOT NULL, job_id uuid NOT NULL, run_id uuid NOT NULL,
 sealed_sha text, artifact_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,batch_id), UNIQUE(env,artifact_id),
 FOREIGN KEY(env,job_id,run_id) REFERENCES public.delphi_graph_nodes(env,job_id,run_id),
 FOREIGN KEY(env,job_id,batch_id) REFERENCES public.polis_queue_attempts(env,job_id,attempt_id),
 FOREIGN KEY(env,artifact_id) REFERENCES public.delphi_artifacts(env,artifact_id)
);
CREATE TABLE public.delphi_result_families(
 env text NOT NULL,batch_id uuid NOT NULL,family text NOT NULL REFERENCES public.delphi_result_catalog,
 codec_wire text NOT NULL, content_sha text NOT NULL, row_count integer NOT NULL CHECK(row_count>=0),
 PRIMARY KEY(env,batch_id,family), FOREIGN KEY(env,batch_id) REFERENCES public.delphi_result_batches,
 CHECK(content_sha=encode(sha256(convert_to(codec_wire,'UTF8')),'hex'))
);
CREATE TABLE public.delphi_result_rows(
 env text NOT NULL,batch_id uuid NOT NULL,family text NOT NULL,item_key jsonb NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>0),item jsonb NOT NULL CHECK(jsonb_typeof(item)='object'),
 PRIMARY KEY(env,batch_id,family,item_key), UNIQUE(env,batch_id,family,ordinal),
 FOREIGN KEY(env,batch_id,family) REFERENCES public.delphi_result_families
);
CREATE TRIGGER result_family_immutable BEFORE UPDATE OR DELETE ON public.delphi_result_families
 FOR EACH ROW EXECUTE FUNCTION public.pd_graph_immutable();
CREATE TRIGGER result_row_immutable BEFORE UPDATE OR DELETE ON public.delphi_result_rows
 FOR EACH ROW EXECUTE FUNCTION public.pd_graph_immutable();
-- Validate AttributeValue tags before making a result readable. No numeric value
-- passes through a float; the immutable original bytes remain the audit record.
CREATE FUNCTION public.pd_result_valid_value(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE tag text;body jsonb;x jsonb;t text;n numeric;
BEGIN
 IF jsonb_typeof(v)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>1 THEN RETURN false; END IF;
 SELECT key,value INTO tag,body FROM jsonb_each(v);
 IF tag='S' THEN RETURN jsonb_typeof(body)='string';
 ELSIF tag='BOOL' THEN RETURN jsonb_typeof(body)='boolean';
 ELSIF tag='NULL' THEN RETURN body='true'::jsonb;
 ELSIF tag='N' THEN
  IF jsonb_typeof(body)<>'string' THEN RETURN false; END IF;
  t=body#>>'{}';
  IF length(t)>256 OR t !~ '^-?(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' OR t='-0' THEN RETURN false; END IF;
  n=t::numeric;
  RETURN (n=0 OR (abs(n)>=1e-130::numeric AND abs(n)<1e126::numeric))
   AND length(trim(both '0' from replace(replace(t,'-',''),'.','')))<=38;
 ELSIF tag='B' THEN
  IF jsonb_typeof(body)<>'string' THEN RETURN false; END IF;
  t=body#>>'{}';RETURN replace(encode(decode(t,'base64'),'base64'),chr(10),'')=t;
 ELSIF tag='M' THEN
  IF jsonb_typeof(body)<>'object' THEN RETURN false; END IF;
  FOR x IN SELECT value FROM jsonb_each(body) LOOP IF NOT public.pd_result_valid_value(x) THEN RETURN false; END IF; END LOOP;
 ELSIF tag IN ('L','SS','NS','BS') THEN
  IF jsonb_typeof(body)<>'array' THEN RETURN false; END IF;
  IF tag<>'L' AND (jsonb_array_length(body)=0 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(body))<>jsonb_array_length(body)) THEN RETURN false; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(body) LOOP
   IF NOT public.pd_result_valid_value(CASE tag WHEN 'L' THEN x ELSE jsonb_build_object(left(tag,1),x) END) THEN RETURN false; END IF;
  END LOOP;
 ELSE RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- Internal insertion helper; caller has already acquired the queue row lock and fence.
CREATE FUNCTION public.pd_result_insert_family(p_env text,p_job uuid,p_attempt uuid,p_family text,p_wire text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE n public.delphi_graph_nodes;b public.delphi_result_batches;spec jsonb;head jsonb;
 lines text[];rowdoc jsonb;k jsonb;part jsonb;i integer;sha text;old public.delphi_result_families;
BEGIN
 SELECT * INTO STRICT n FROM public.delphi_graph_nodes WHERE env=p_env AND job_id=p_job;
 SELECT key_spec INTO STRICT spec FROM public.delphi_result_catalog WHERE family=p_family;
 IF p_wire IS NULL OR octet_length(p_wire)>67108864 OR right(p_wire,1)<>chr(10) THEN RAISE EXCEPTION 'invalid result family bytes'; END IF;
 sha=encode(sha256(convert_to(p_wire,'UTF8')),'hex');
 INSERT INTO public.delphi_result_batches(env,batch_id,job_id,run_id) VALUES(p_env,p_attempt,p_job,n.run_id) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT b FROM public.delphi_result_batches WHERE env=p_env AND batch_id=p_attempt FOR UPDATE;
 IF b.job_id<>p_job OR b.run_id<>n.run_id THEN RAISE EXCEPTION 'result run binding'; END IF;
 SELECT * INTO old FROM public.delphi_result_families WHERE env=p_env AND batch_id=p_attempt AND family=p_family;
 IF FOUND THEN
  IF old.codec_wire<>p_wire THEN RAISE EXCEPTION 'immutable result family conflict'; END IF;
  RETURN jsonb_build_object('sha256',old.content_sha,'row_count',old.row_count);
 END IF;
 IF b.sealed_sha IS NOT NULL THEN RAISE EXCEPTION 'result batch sealed'; END IF;
 IF COALESCE((SELECT sum(octet_length(codec_wire)) FROM public.delphi_result_families WHERE env=p_env AND batch_id=p_attempt),0)+octet_length(p_wire)>268435456 THEN RAISE EXCEPTION 'result batch byte limit'; END IF;
 lines=string_to_array(left(p_wire,length(p_wire)-1),chr(10));head=lines[1]::jsonb;
 IF head IS DISTINCT FROM jsonb_build_object('codec','delphi-storage-codec/1','family',p_family,'key',(SELECT jsonb_agg(x->0) FROM jsonb_array_elements(spec) x))
 THEN RAISE EXCEPTION 'invalid result codec header'; END IF;
 INSERT INTO public.delphi_result_families VALUES(p_env,p_attempt,p_family,p_wire,sha,cardinality(lines)-1);
 FOR i IN 2..cardinality(lines) LOOP
  rowdoc=lines[i]::jsonb;k='[]'::jsonb;
  IF jsonb_typeof(rowdoc)<>'object' OR EXISTS(SELECT 1 FROM jsonb_each(rowdoc) a WHERE a.key='' OR NOT public.pd_result_valid_value(a.value)) THEN RAISE EXCEPTION 'invalid result row'; END IF;
  FOR part IN SELECT value FROM jsonb_array_elements(spec) LOOP
   IF rowdoc->(part->>0) IS NULL OR jsonb_typeof(rowdoc->(part->>0))<>'object'
    OR NOT (rowdoc->(part->>0) ? (part->>1)) OR (SELECT count(*) FROM jsonb_object_keys(rowdoc->(part->>0)))<>1
    OR jsonb_typeof(rowdoc->(part->>0)->(part->>1))<>'string' THEN RAISE EXCEPTION 'invalid result key'; END IF;
   k=k||jsonb_build_array(rowdoc->(part->>0));
  END LOOP;
  IF (rowdoc ? 'conversation_id' AND rowdoc->'conversation_id'->>'S' IS DISTINCT FROM n.zid::text)
   OR (rowdoc ? 'zid' AND COALESCE(rowdoc->'zid'->>'S',rowdoc->'zid'->>'N') IS DISTINCT FROM n.zid::text)
   OR (rowdoc ? 'zid_tick' AND split_part(rowdoc->'zid_tick'->>'S',':',1)<>n.zid::text)
   OR (rowdoc ? 'zid_tick_gid' AND split_part(rowdoc->'zid_tick_gid'->>'S',':',1)<>n.zid::text)
   OR (rowdoc ? 'zid_topic_jobid' AND split_part(rowdoc->'zid_topic_jobid'->>'S','#',1)<>n.zid::text)
  THEN RAISE EXCEPTION 'result conversation mismatch'; END IF;
  IF rowdoc ? 'rid_section_model' AND NOT EXISTS(
   SELECT 1 FROM public.reports r WHERE r.zid=n.zid AND r.report_id=split_part(rowdoc->'rid_section_model'->>'S','#',1)
    AND (NOT rowdoc ? 'report_id' OR rowdoc->'report_id'->>'S'=r.report_id))
  THEN RAISE EXCEPTION 'result report conversation mismatch'; END IF;
  INSERT INTO public.delphi_result_rows VALUES(p_env,p_attempt,p_family,k,i-1,rowdoc);
 END LOOP;
 RETURN jsonb_build_object('sha256',sha,'row_count',cardinality(lines)-1);
END $$;
CREATE FUNCTION public.pd_result_seal_internal(p_env text,p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE digest text;names jsonb;
BEGIN
 SELECT encode(sha256(convert_to(COALESCE(string_agg(family||':'||content_sha||':'||row_count::text,chr(10) ORDER BY family COLLATE "C"),''),'UTF8')),'hex'),
 COALESCE(jsonb_agg(family ORDER BY family COLLATE "C"),'[]'::jsonb) INTO digest,names
 FROM public.delphi_result_families WHERE env=p_env AND batch_id=p_attempt;
 UPDATE public.delphi_result_batches SET sealed_sha=digest WHERE env=p_env AND batch_id=p_attempt AND sealed_sha IS NULL;
 IF NOT EXISTS(SELECT 1 FROM public.delphi_result_batches WHERE env=p_env AND batch_id=p_attempt AND sealed_sha=digest) THEN RAISE EXCEPTION 'result seal mismatch'; END IF;
 RETURN jsonb_build_object('schema','delphi-result-batch/1','batch_id',p_attempt,'sha256',digest,'families',names);
END $$;
CREATE FUNCTION public.pd_result_put_family(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_family text,p_wire text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.polis_queue_jobs;
BEGIN
 j=public.pd_lock(p_env,p_job);
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RAISE EXCEPTION 'result writer fenced'; END IF;
 RETURN public.pd_result_insert_family(p_env,p_job,p_attempt,p_family,p_wire);
END $$;
CREATE FUNCTION public.pd_result_seal(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.polis_queue_jobs;
BEGIN
 j=public.pd_lock(p_env,p_job);
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RAISE EXCEPTION 'result writer fenced'; END IF;
 RETURN public.pd_result_seal_internal(p_env,p_attempt);
END $$;
CREATE FUNCTION public.pd_result_bind_artifact() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE doc jsonb;ref jsonb;pair record;b public.delphi_result_batches;expected jsonb;
BEGIN
 doc=NEW.payload::jsonb;
 IF doc ? 'family_files' THEN
  IF doc ? 'results' OR jsonb_typeof(doc->'family_files')<>'object' OR doc->'family_files'='{}'::jsonb THEN RAISE EXCEPTION 'invalid inline result families'; END IF;
  FOR pair IN SELECT key,value FROM jsonb_each(doc->'family_files') LOOP
   IF jsonb_typeof(pair.value)<>'string' THEN RAISE EXCEPTION 'invalid inline codec bytes'; END IF;
   PERFORM public.pd_result_insert_family(NEW.env,NEW.job_id,NEW.attempt_id,pair.key,pair.value#>>'{}');
  END LOOP;
  ref=public.pd_result_seal_internal(NEW.env,NEW.attempt_id);
 ELSIF doc ? 'results' THEN ref=doc->'results';
 ELSE RETURN NEW; END IF; -- Reference graph artifacts remain compatible.
 SELECT * INTO STRICT b FROM public.delphi_result_batches WHERE env=NEW.env AND batch_id=NEW.attempt_id FOR UPDATE;
 expected=public.pd_result_seal_internal(NEW.env,NEW.attempt_id);
 IF ref IS DISTINCT FROM expected OR b.job_id<>NEW.job_id OR b.run_id<>NEW.run_id OR b.artifact_id IS NOT NULL THEN RAISE EXCEPTION 'artifact result binding'; END IF;
 UPDATE public.delphi_result_batches SET artifact_id=NEW.artifact_id WHERE env=NEW.env AND batch_id=NEW.attempt_id;
 RETURN NEW;
END $$;
-- AFTER INSERT permits the batch's FK to the newly fenced artifact.
CREATE TRIGGER result_artifact_bind AFTER INSERT ON public.delphi_artifacts FOR EACH ROW EXECUTE FUNCTION public.pd_result_bind_artifact();
CREATE FUNCTION public.pd_result_bundle_rows(p_env text,p_root uuid)
RETURNS TABLE(family text,item_key jsonb,item jsonb,ordinal integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH RECURSIVE upstream(id,depth,path) AS (
  SELECT p_root,0,ARRAY[p_root] UNION ALL
  SELECT e.artifact_id,u.depth+1,u.path||e.artifact_id FROM upstream u
  JOIN public.delphi_artifacts a ON a.env=p_env AND a.artifact_id=u.id
  JOIN public.delphi_graph_edges e ON e.env=a.env AND e.consumer=a.job_id
  WHERE e.artifact_id IS NOT NULL AND NOT e.artifact_id=ANY(u.path)
 ), chosen AS (
  SELECT DISTINCT ON(f.family) f.family,b.batch_id FROM upstream u
  JOIN public.delphi_result_batches b ON b.env=p_env AND b.artifact_id=u.id
  JOIN public.delphi_result_families f ON f.env=b.env AND f.batch_id=b.batch_id
  ORDER BY f.family,u.depth,u.id
 ) SELECT r.family,r.item_key,r.item,r.ordinal FROM chosen c JOIN public.delphi_result_rows r
 ON r.env=p_env AND r.batch_id=c.batch_id AND r.family=c.family
$$;
CREATE FUNCTION public.pd_result_artifact_wire(p_env text,p_artifact uuid,p_family text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('wire',f.codec_wire,'sha256',f.content_sha,'batch_sha256',b.sealed_sha,'batch_id',b.batch_id)
 FROM public.delphi_result_batches b JOIN public.delphi_result_families f USING(env,batch_id)
 WHERE b.env=p_env AND b.artifact_id=p_artifact AND f.family=p_family
$$;
CREATE FUNCTION public.pd_result_artifact_family(p_env text,p_artifact uuid,p_family text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(item ORDER BY ordinal),'[]'::jsonb) FROM public.pd_result_bundle_rows(p_env,p_artifact) WHERE family=p_family
$$;
CREATE VIEW public.delphi_result_current_rows WITH(security_barrier=true) AS
 SELECT s.env,s.zid,s.scope_key,s.generation,r.family,r.item_key,r.item
 FROM public.delphi_graph_served s CROSS JOIN LATERAL public.pd_result_bundle_rows(s.env,s.artifact_id) r;
CREATE FUNCTION public.pd_result_served(p_env text,p_zid integer,p_scope text,p_family text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.pd_result_artifact_family(p_env,s.artifact_id,p_family) FROM public.delphi_graph_served s
 WHERE s.env=p_env AND s.zid=p_zid AND s.scope_key=p_scope
$$;
CREATE FUNCTION public.pd_result_served_bundle(p_env text,p_zid integer,p_scope text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('generation',s.generation,'families',COALESCE((SELECT jsonb_object_agg(family,items) FROM
  (SELECT family,jsonb_agg(item ORDER BY ordinal) items FROM public.pd_result_bundle_rows(p_env,s.artifact_id) GROUP BY family) f),'{}'::jsonb))
 FROM public.delphi_graph_served s WHERE s.env=p_env AND s.zid=p_zid AND s.scope_key=p_scope
$$;
-- Archive wire stays text: PostgreSQL JSONB cannot represent NUL in a legacy
-- attribute. Decode the canonical inner file in the language codec, not SQL.
CREATE VIEW public.delphi_result_legacy_controls WITH(security_barrier=true) AS
 SELECT s.env,s.zid,s.scope_key,s.generation,c.key AS family,c.value AS codec_wire
 FROM public.delphi_graph_served s JOIN public.delphi_artifacts a USING(env,artifact_id)
 CROSS JOIN LATERAL jsonb_each_text(COALESCE(a.payload::jsonb->'legacy_control_files','{}'::jsonb)) c
 WHERE c.key IN ('Delphi_JobQueue','Delphi_JobActiveGuard');
CREATE VIEW public.delphi_result_publications WITH(security_barrier=true) AS
 SELECT s.env,s.zid,s.scope_key,s.generation,s.artifact_id,a.job_id::text
 FROM public.delphi_graph_served s JOIN public.delphi_artifacts a USING(env,artifact_id);
REVOKE ALL ON public.delphi_result_legacy_controls,public.delphi_result_publications FROM PUBLIC,polis_queue_executor;
GRANT SELECT ON public.delphi_result_legacy_controls,public.delphi_result_publications TO polis_queue_executor;
CREATE VIEW public.delphi_result_jobs WITH(security_barrier=true) AS
 SELECT env,job_id::text,zid::text AS conversation_id,report_id,
 CASE status WHEN 'succeeded' THEN 'COMPLETED' WHEN 'dead' THEN 'FAILED' WHEN 'running' THEN 'PROCESSING' ELSE upper(status) END AS status,
 kind AS job_type,config_effective AS job_config,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,error,
 (SELECT g.scope_key FROM public.delphi_graph_nodes n JOIN public.delphi_graphs g USING(env,graph_id)
  WHERE n.env=delphi_jobs.env AND n.job_id=delphi_jobs.job_id) AS scope_key
 FROM public.delphi_jobs;
REVOKE ALL ON public.delphi_result_jobs FROM PUBLIC,polis_queue_executor;
GRANT SELECT ON public.delphi_result_jobs TO polis_queue_executor;
REVOKE ALL ON public.delphi_result_catalog,public.delphi_result_batches,public.delphi_result_families,public.delphi_result_rows,public.delphi_result_current_rows FROM PUBLIC,polis_queue_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure name FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pd_result_') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,polis_queue_executor',f.name); END LOOP;
END $$;
GRANT SELECT ON public.delphi_result_current_rows TO polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pd_result_put_family(text,uuid,uuid,uuid,bigint,text,text),
 public.pd_result_seal(text,uuid,uuid,uuid,bigint),public.pd_result_artifact_family(text,uuid,text),
 public.pd_result_bundle_rows(text,uuid),public.pd_result_artifact_wire(text,uuid,text),
 public.pd_result_served(text,integer,text,text),public.pd_result_served_bundle(text,integer,text) TO polis_queue_executor;
COMMIT;
