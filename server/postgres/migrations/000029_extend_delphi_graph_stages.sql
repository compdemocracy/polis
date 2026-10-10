-- #1427: actual bounded Delphi numerical graph on #1432 core M27.
-- Superseding dead branches, scoped breakers and provider remediation remain deferred.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
ALTER TABLE public.polis_queue_jobs ADD CHECK(stage IN ('noop','delphi_full_pipeline','delphi_narrative','math_rebuild','graph_embed','graph_cluster','graph_topics','graph_narrative'));
ALTER TABLE public.delphi_jobs DROP CONSTRAINT delphi_jobs_kind_check;
ALTER TABLE public.delphi_jobs ADD CHECK(kind IN ('full_pipeline','embed','snapshot','umap','cluster','keywords','topics','topic_name','narrative','collective_statement','visualize','math_rebuild','legacy_import','legacy_queue_record'));
CREATE OR REPLACE FUNCTION public.pd_graph_admit(p_env text,p_zid integer,p_scope text,p_key text,p_spec jsonb,p_supersedes uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE g public.delphi_graphs; gid uuid=gen_random_uuid(); root uuid;
 n jsonb; e jsonb; jid uuid; rid uuid; prod uuid; aid uuid; decl jsonb; reply jsonb;
 v_stage text; cls text;
BEGIN
 IF p_supersedes IS NOT NULL THEN RAISE EXCEPTION 'superseding dead branches is not supported'; END IF;
 IF p_env IS NULL OR p_env !~ '^[a-z0-9_-]{1,64}$' OR p_scope IS NULL OR length(p_scope) NOT BETWEEN 1 AND 128
 OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 128 OR p_spec->>'schema' IS DISTINCT FROM 'polis-job-graph/1'
 OR jsonb_typeof(p_spec->'nodes') IS DISTINCT FROM 'array' OR jsonb_array_length(p_spec->'nodes') NOT BETWEEN 1 AND 32
 OR p_spec-'schema'-'nodes'<>'{}'::jsonb OR octet_length(p_spec::text)>1048576 THEN RAISE EXCEPTION 'invalid graph'; END IF;
 PERFORM 1 FROM public.conversations WHERE zid=p_zid FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown conversation'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:scope',p_env,p_scope)::text,0));
 SELECT * INTO g FROM public.delphi_graphs WHERE env=p_env AND scope_key=p_scope AND request_key=p_key;
 IF FOUND THEN
  IF g.zid<>p_zid OR g.request IS DISTINCT FROM p_spec OR g.supersedes IS DISTINCT FROM p_supersedes THEN RAISE EXCEPTION 'graph request conflict'; END IF;
  RETURN jsonb_build_object('outcome','existing','graph_id',g.graph_id,'root_job_id',g.root_job_id);
 END IF;
 IF EXISTS(SELECT 1 FROM public.delphi_job_guards WHERE env=p_env AND scope_key=p_scope) THEN RAISE EXCEPTION 'scope busy'; END IF;
 root=gen_random_uuid();
 INSERT INTO public.delphi_graphs(env,graph_id,zid,scope_key,request_key,request,root_job_id,supersedes)
 VALUES(p_env,gid,p_zid,p_scope,p_key,p_spec,root,p_supersedes);
 FOR n IN SELECT value FROM jsonb_array_elements(p_spec->'nodes') LOOP
  v_stage=n->>'stage'; cls=n->>'class'; decl=n->'declared';
  IF n-'key'-'stage'-'class'-'declared'-'inputs'-'max_attempts'<>'{}'::jsonb
  OR n->>'key' IS NULL OR v_stage IS NULL OR v_stage NOT IN ('graph_embed','graph_cluster','graph_topics','graph_narrative')
  OR cls IS NULL OR NOT ((v_stage='graph_cluster' AND cls IN ('delphi','large')) OR (v_stage<>'graph_cluster' AND cls='delphi'))
  OR jsonb_typeof(decl) IS DISTINCT FROM 'object'
  OR decl-'snapshot'-'code'-'model'-'runtime'-'seed'-'config'-'mode'-'memory_bytes'-'work_units'<>'{}'::jsonb
  OR decl->>'mode' IS DISTINCT FROM 'full'
  OR decl->>'code' IS NULL OR decl->>'code' !~ '^[0-9a-f]{40,64}$'
  OR NOT COALESCE((CASE v_stage WHEN 'graph_embed' THEN decl->>'model' IN ('local-token-count/1','sentence-transformers/all-MiniLM-L6-v2') WHEN 'graph_cluster' THEN decl->>'model' IN ('local-nearest-centroid/1','delphi-umap-evoc/1') WHEN 'graph_topics' THEN decl->>'model' = 'delphi-tfidf-keywords/1' WHEN 'graph_narrative' THEN decl->>'model' IN ('local-cluster-summary/1','local-narrative-fixture/1','legacy-dynamo-export/1') ELSE false END),false) OR COALESCE(decl->>'runtime','')=''
  OR jsonb_typeof(decl->'seed') IS DISTINCT FROM 'number' OR jsonb_typeof(decl->'config') IS DISTINCT FROM 'object'
  OR jsonb_typeof(decl->'snapshot') IS DISTINCT FROM 'object'
  OR jsonb_typeof(decl->'snapshot'->'data'->'texts') IS DISTINCT FROM 'array'
  OR jsonb_array_length(decl->'snapshot'->'data'->'texts') NOT BETWEEN 1 AND 2000
  OR (decl->'snapshot'->'data')-'texts'<>'{}'::jsonb
  OR public.pd_graph_hash(decl->'snapshot'->'data') IS DISTINCT FROM decl->'snapshot'->>'sha256'
  OR (decl->'snapshot')-'data'-'sha256'<>'{}'::jsonb
  OR COALESCE((decl->>'memory_bytes')::bigint,0) NOT BETWEEN 1 AND (CASE cls WHEN 'delphi' THEN 4294967296 ELSE 2147483648 END)
  OR COALESCE((decl->>'work_units')::integer,0) NOT BETWEEN 1 AND 10000
  OR jsonb_typeof(n->'inputs') IS DISTINCT FROM 'array' OR jsonb_array_length(n->'inputs')>4
  OR COALESCE((n->>'max_attempts')::integer,0) NOT BETWEEN 1 AND 10
  THEN RAISE EXCEPTION 'invalid stage contract (incremental not supported)'; END IF;
  IF (v_stage='graph_embed' OR decl->>'model'='legacy-dynamo-export/1') AND jsonb_array_length(n->'inputs')<>0 OR (v_stage<>'graph_embed' AND decl->>'model'<>'legacy-dynamo-export/1') AND jsonb_array_length(n->'inputs')<>1
  THEN RAISE EXCEPTION 'stage input arity'; END IF;
  jid=CASE WHEN NOT EXISTS(SELECT 1 FROM public.delphi_graph_nodes WHERE env=p_env AND graph_id=gid) THEN root ELSE gen_random_uuid() END;
  rid=gen_random_uuid();
  reply=public.pq_enqueue(p_env,p_zid,'graph:'||p_scope||':'||(n->>'key'),'graph-admission',p_key,
   public.pd_graph_hash(n),rid,jid,'graph://'||gid::text||'/'||(n->>'key'),public.pd_graph_hash(decl),public.pd_graph_hash(decl->'config'),
   decl->>'code',1::smallint,(n->>'max_attempts')::integer);
  IF reply->>'outcome'<>'enqueued' THEN RAISE EXCEPTION 'graph product conflict'; END IF;
  UPDATE public.polis_queue_runs SET contract_version='polis-queue/5' WHERE env=p_env AND run_id=rid;
  INSERT INTO public.delphi_jobs(job_id,env,zid,kind,parent_job_id,run_id,origin,replayable,reuse_eligible,status,config_effective,code_version,model_versions)
  VALUES(jid,p_env,p_zid,substring(v_stage from 7),CASE WHEN jid<>root THEN root END,rid,'queued',true,true,'queued',decl->'config',decl->>'code',jsonb_build_object('exact',decl->>'model'));
  INSERT INTO public.delphi_graph_nodes VALUES(p_env,p_zid,gid,jid,rid,n->>'key',decl,NULL,NULL);
  UPDATE public.polis_queue_jobs SET stage=n->>'stage',worker_class=cls WHERE env=p_env AND job_id=jid;
 END LOOP;
 FOR n IN SELECT value FROM jsonb_array_elements(p_spec->'nodes') LOOP
  SELECT job_id INTO STRICT jid FROM public.delphi_graph_nodes WHERE env=p_env AND graph_id=gid AND node_key=n->>'key';
  FOR e IN SELECT value FROM jsonb_array_elements(n->'inputs') LOOP
   aid=NULL;
   IF e-'node'-'artifact_id'-'sha256'-'contract_sha256'-'role'<>'{}'::jsonb
   OR e->>'role' IS DISTINCT FROM (CASE n->>'stage' WHEN 'graph_cluster' THEN 'embeddings' WHEN 'graph_topics' THEN 'clusters' WHEN 'graph_narrative' THEN CASE WHEN n->'declared'->>'model'='local-cluster-summary/1' THEN 'clusters' ELSE 'topics' END END)
   OR (e ? 'node')=(e ? 'artifact_id') THEN RAISE EXCEPTION 'invalid input role or reference'; END IF;
   IF e ? 'node' THEN
    SELECT job_id INTO STRICT prod FROM public.delphi_graph_nodes WHERE env=p_env AND graph_id=gid AND node_key=e->>'node';
   ELSE
    aid=(e->>'artifact_id')::uuid;
    SELECT a.job_id INTO STRICT prod FROM public.delphi_artifacts a JOIN public.delphi_graph_nodes pn USING(env,job_id)
    WHERE a.env=p_env AND a.artifact_id=aid AND pn.zid=p_zid AND a.content_sha=e->>'sha256' AND public.pd_graph_hash(pn.declared)=e->>'contract_sha256';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.polis_queue_jobs qp WHERE qp.env=p_env AND qp.job_id=prod AND qp.stage=CASE n->>'stage' WHEN 'graph_cluster' THEN 'graph_embed' WHEN 'graph_topics' THEN 'graph_cluster' WHEN 'graph_narrative' THEN CASE WHEN n->'declared'->>'model'='local-cluster-summary/1' THEN 'graph_cluster' ELSE 'graph_topics' END END)
   THEN RAISE EXCEPTION 'input stage mismatch'; END IF;
   IF (SELECT gn.declared->'snapshot'->>'sha256' FROM public.delphi_graph_nodes gn WHERE gn.env=p_env AND gn.job_id=prod) IS DISTINCT FROM n->'declared'->'snapshot'->>'sha256' THEN RAISE EXCEPTION 'upstream snapshot mismatch'; END IF;
   INSERT INTO public.delphi_graph_edges VALUES(p_env,jid,prod,e->>'role',e->>'sha256',aid);
  END LOOP;
 END LOOP;
 UPDATE public.delphi_graphs SET sealed=true WHERE env=p_env AND graph_id=gid;
 INSERT INTO public.delphi_job_guards VALUES(p_env,p_scope,p_zid,root,public.pd_graph_hash(p_spec));
 RETURN jsonb_build_object('outcome','enqueued','graph_id',gid,'root_job_id',root);
END $$;

COMMIT;
