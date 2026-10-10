-- Per-step runs, immutable results and inputs, dependency waiting, atomic publication.
-- Contract /5; /4 belongs to held retention. No provider remediation or scoped breakers.
-- Forward-only compatibility with the original M19/M23/M24 checksums.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
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
 IF NOT EXISTS(SELECT 1 FROM public.polis_queue_large_class_install WHERE installed=pg_temp.pq3_state())
 THEN RAISE EXCEPTION 'queue /3 catalog drift'; END IF;
END $$;
DO $$ BEGIN PERFORM set_config('graph.baseline',pg_temp.pq3_state()::text,true); END $$;
CREATE TABLE public.delphi_graph_install(singleton boolean PRIMARY KEY CHECK(singleton), baseline jsonb NOT NULL);
INSERT INTO public.delphi_graph_install VALUES(true,current_setting('graph.baseline')::jsonb);
ALTER TABLE public.polis_queue_install DROP CONSTRAINT polis_queue_install_contract_version_check;
UPDATE public.polis_queue_install SET contract_version='polis-queue/5';
ALTER TABLE public.polis_queue_install ADD CHECK(contract_version='polis-queue/5');
ALTER TABLE public.polis_queue_install ALTER COLUMN contract_version SET DEFAULT 'polis-queue/5';
ALTER TABLE public.polis_queue_runs DROP CONSTRAINT polis_queue_runs_contract_version_check;
ALTER TABLE public.polis_queue_runs ADD CHECK(contract_version IN ('polis-queue/1','polis-queue/2','polis-queue/3','polis-queue/5'));
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
ALTER TABLE public.polis_queue_jobs ADD CHECK(stage IN ('noop','delphi_full_pipeline','delphi_narrative','math_rebuild','graph_embed','graph_cluster','graph_narrative'));
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT pq_stage_large;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT pq_stage_large CHECK(
 (stage='math_rebuild' AND worker_class='large') OR
 (stage='graph_cluster' AND worker_class IN ('delphi','large')) OR
 (stage NOT IN ('math_rebuild','graph_cluster') AND worker_class<>'large'));

CREATE TABLE public.delphi_graphs(
 env text NOT NULL, graph_id uuid NOT NULL, zid integer NOT NULL REFERENCES public.conversations(zid),
 scope_key text NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 128), request_key text NOT NULL,
 request jsonb NOT NULL, root_job_id uuid NOT NULL, sealed boolean NOT NULL DEFAULT false,
 supersedes uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,graph_id), UNIQUE(env,scope_key,request_key), UNIQUE(env,zid,graph_id),
 FOREIGN KEY(env,supersedes) REFERENCES public.delphi_graphs(env,graph_id)
);
CREATE TABLE public.delphi_graph_nodes(
 env text NOT NULL, zid integer NOT NULL, graph_id uuid NOT NULL, job_id uuid NOT NULL,
 run_id uuid NOT NULL, node_key text NOT NULL CHECK(node_key ~ '^[a-z][a-z0-9_]{0,31}$'),
 declared jsonb NOT NULL, resolved jsonb, resolved_sha text,
 PRIMARY KEY(env,job_id), UNIQUE(env,run_id), UNIQUE(env,job_id,run_id), UNIQUE(env,graph_id,node_key),
 FOREIGN KEY(env,zid,graph_id) REFERENCES public.delphi_graphs(env,zid,graph_id),
 FOREIGN KEY(env,job_id) REFERENCES public.delphi_jobs(env,job_id),
 FOREIGN KEY(env,run_id) REFERENCES public.polis_queue_runs(env,run_id),
 CHECK((resolved IS NULL)=(resolved_sha IS NULL))
);
CREATE TABLE public.delphi_artifacts(
 env text NOT NULL, artifact_id uuid NOT NULL DEFAULT gen_random_uuid(), job_id uuid NOT NULL,
 run_id uuid NOT NULL, attempt_id uuid NOT NULL, output_role text NOT NULL CHECK(output_role='result'),
 schema_version text NOT NULL, payload text NOT NULL CHECK(octet_length(payload)<=524288),
 content_sha text NOT NULL CHECK(content_sha ~ '^[0-9a-f]{64}$'),
 byte_count integer NOT NULL CHECK(byte_count>=0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,artifact_id), UNIQUE(env,job_id,output_role),
 FOREIGN KEY(env,job_id) REFERENCES public.delphi_graph_nodes(env,job_id),
 FOREIGN KEY(env,job_id,run_id) REFERENCES public.delphi_graph_nodes(env,job_id,run_id),
 FOREIGN KEY(env,job_id,attempt_id) REFERENCES public.polis_queue_attempts(env,job_id,attempt_id),
 CHECK(content_sha=encode(sha256(convert_to(payload,'UTF8')),'hex')),
 CHECK(byte_count=octet_length(payload))
);
CREATE TABLE public.delphi_graph_edges(
 env text NOT NULL, consumer uuid NOT NULL, producer uuid NOT NULL, input_role text NOT NULL,
 expected_sha text CHECK(expected_sha ~ '^[0-9a-f]{64}$'), artifact_id uuid,
 PRIMARY KEY(env,consumer,input_role), CHECK(consumer<>producer),
 FOREIGN KEY(env,consumer) REFERENCES public.delphi_graph_nodes(env,job_id),
 FOREIGN KEY(env,producer) REFERENCES public.delphi_graph_nodes(env,job_id),
 FOREIGN KEY(env,artifact_id) REFERENCES public.delphi_artifacts(env,artifact_id)
);
CREATE INDEX delphi_graph_edges_producer ON public.delphi_graph_edges(env,producer);
CREATE TABLE public.delphi_graph_served(
 env text NOT NULL, zid integer NOT NULL REFERENCES public.conversations(zid), scope_key text NOT NULL,
 generation bigint NOT NULL CHECK(generation>0), artifact_id uuid NOT NULL,
 PRIMARY KEY(env,zid,scope_key), FOREIGN KEY(env,artifact_id) REFERENCES public.delphi_artifacts(env,artifact_id)
);
CREATE FUNCTION public.pd_graph_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE
 SET search_path=pg_catalog,pg_temp AS $$ SELECT encode(sha256(convert_to(j::text,'UTF8')),'hex') $$;
CREATE FUNCTION public.pd_graph_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'immutable graph result'; END $$;
CREATE TRIGGER graph_artifact_immutable BEFORE UPDATE OR DELETE ON public.delphi_artifacts FOR EACH ROW EXECUTE FUNCTION public.pd_graph_immutable();
CREATE FUNCTION public.pd_graph_node_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable graph node'; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'resolved'-'resolved_sha' IS DISTINCT FROM to_jsonb(OLD)-'resolved'-'resolved_sha'
 OR OLD.resolved IS NOT NULL) THEN RAISE EXCEPTION 'immutable graph input'; END IF;
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM public.delphi_graphs WHERE env=NEW.env AND graph_id=NEW.graph_id AND sealed)
 THEN RAISE EXCEPTION 'sealed graph'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER graph_node_guard BEFORE INSERT OR UPDATE OR DELETE ON public.delphi_graph_nodes FOR EACH ROW EXECUTE FUNCTION public.pd_graph_node_guard();
CREATE FUNCTION public.pd_graph_edge_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE c public.delphi_graph_nodes; p public.delphi_graph_nodes;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable graph edge'; END IF;
 SELECT * INTO STRICT c FROM public.delphi_graph_nodes WHERE env=NEW.env AND job_id=NEW.consumer;
 SELECT * INTO STRICT p FROM public.delphi_graph_nodes WHERE env=NEW.env AND job_id=NEW.producer;
 IF c.zid<>p.zid THEN RAISE EXCEPTION 'dependency namespace'; END IF;
 IF TG_OP='UPDATE' THEN
  IF to_jsonb(NEW)-'artifact_id' IS DISTINCT FROM to_jsonb(OLD)-'artifact_id' OR OLD.artifact_id IS NOT NULL
  THEN RAISE EXCEPTION 'immutable dependency'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.delphi_graphs WHERE env=c.env AND graph_id=c.graph_id AND sealed)
  THEN RAISE EXCEPTION 'sealed graph'; END IF;
  IF EXISTS(WITH RECURSIVE up(id) AS (SELECT NEW.producer UNION SELECT e.producer FROM public.delphi_graph_edges e JOIN up ON e.consumer=up.id WHERE e.env=NEW.env) SELECT 1 FROM up WHERE id=NEW.consumer)
  THEN RAISE EXCEPTION 'dependency cycle'; END IF;
 END IF;
 IF NEW.artifact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.delphi_artifacts a
 WHERE a.env=NEW.env AND a.artifact_id=NEW.artifact_id AND a.job_id=NEW.producer
 AND (NEW.expected_sha IS NULL OR a.content_sha=NEW.expected_sha)) THEN RAISE EXCEPTION 'artifact binding'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER graph_edge_guard BEFORE INSERT OR UPDATE OR DELETE ON public.delphi_graph_edges FOR EACH ROW EXECUTE FUNCTION public.pd_graph_edge_guard();
CREATE FUNCTION public.pd_graph_parent_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.parent_job_id IS DISTINCT FROM OLD.parent_job_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.env<>OLD.env OR NEW.zid<>OLD.zid)
 AND EXISTS(SELECT 1 FROM public.delphi_graph_nodes WHERE env=OLD.env AND job_id=OLD.job_id)
 THEN RAISE EXCEPTION 'immutable graph membership'; END IF;
 IF TG_OP='INSERT' AND NEW.parent_job_id IS NOT NULL AND EXISTS(
 SELECT 1 FROM public.delphi_graph_nodes n JOIN public.delphi_graphs g USING(env,graph_id) WHERE n.env=NEW.env AND n.job_id=NEW.parent_job_id AND g.sealed)
 THEN RAISE EXCEPTION 'late child in sealed graph'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER graph_parent_guard BEFORE INSERT OR UPDATE ON public.delphi_jobs FOR EACH ROW EXECUTE FUNCTION public.pd_graph_parent_guard();

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
CREATE OR REPLACE FUNCTION public.pq_result(p_outcome text, j public.polis_queue_jobs, p_published boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('schema_version',CASE WHEN j.stage IS NULL OR j.stage='noop' THEN 'polis-queue/1' WHEN j.stage LIKE 'graph_%' THEN 'polis-queue/5' WHEN j.stage='math_rebuild' THEN 'polis-queue/3' ELSE 'polis-queue/2' END,'outcome',p_outcome,
  'env',j.env,'job_id',j.job_id,'run_id',j.run_id,
  'attempt_id',COALESCE(j.attempt_id,j.terminal_attempt_id),'owner_id',j.owner_id,
  'lease_epoch',j.lease_epoch::text,'version',j.version::text,'mgmt_version',j.mgmt_version::text,'locked_until',j.locked_until,
  'state',j.state,'output_sha256',j.output_sha256,'published',COALESCE(p_published,false),
  'stage',j.stage,'stage_instance',j.stage_instance,'attempt_count',j.attempt_count,'max_attempts',j.max_attempts,'parked_attempt_count',j.parked_attempt_count,
  'eligible_at',j.eligible_at,'first_parked_at',j.first_parked_at,'last_error_code',j.last_error_code,
  'input',(SELECT jsonb_build_object('uri',r.input_uri,'sha256',r.input_sha256,'config_sha256',r.config_sha256,'code_image_digest',r.code_image_digest) FROM public.polis_queue_runs r WHERE r.env=j.env AND r.run_id=j.run_id))
$$;
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
CREATE FUNCTION public.pd_graph_seal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable graph'; END IF;
 IF OLD.sealed OR NOT NEW.sealed OR to_jsonb(OLD)-'sealed' IS DISTINCT FROM to_jsonb(NEW)-'sealed'
 THEN RAISE EXCEPTION 'immutable sealed graph'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER graph_seal_guard BEFORE UPDATE OR DELETE ON public.delphi_graphs FOR EACH ROW EXECUTE FUNCTION public.pd_graph_seal_guard();

-- The admission JSON is a closed, bounded local-artifact contract. Every node
-- names its exact snapshot, code/model/runtime/config/seed and full-fit mode.
CREATE FUNCTION public.pd_graph_admit(p_env text,p_zid integer,p_scope text,p_key text,p_spec jsonb,p_supersedes uuid DEFAULT NULL)
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
  OR n->>'key' IS NULL OR v_stage IS NULL OR v_stage NOT IN ('graph_embed','graph_cluster','graph_narrative')
  OR cls IS NULL OR NOT ((v_stage='graph_cluster' AND cls IN ('delphi','large')) OR (v_stage<>'graph_cluster' AND cls='delphi'))
  OR jsonb_typeof(decl) IS DISTINCT FROM 'object'
  OR decl-'snapshot'-'code'-'model'-'runtime'-'seed'-'config'-'mode'-'memory_bytes'-'work_units'<>'{}'::jsonb
  OR decl->>'mode' IS DISTINCT FROM 'full'
  OR decl->>'code' IS NULL OR decl->>'code' !~ '^[0-9a-f]{40,64}$'
  OR decl->>'model' IS DISTINCT FROM (CASE v_stage WHEN 'graph_embed' THEN 'local-token-count/1' WHEN 'graph_cluster' THEN 'local-nearest-centroid/1' WHEN 'graph_narrative' THEN 'local-cluster-summary/1' END) OR COALESCE(decl->>'runtime','')=''
  OR jsonb_typeof(decl->'seed') IS DISTINCT FROM 'number' OR jsonb_typeof(decl->'config') IS DISTINCT FROM 'object'
  OR jsonb_typeof(decl->'snapshot') IS DISTINCT FROM 'object'
  OR jsonb_typeof(decl->'snapshot'->'data'->'texts') IS DISTINCT FROM 'array'
  OR jsonb_array_length(decl->'snapshot'->'data'->'texts') NOT BETWEEN 1 AND 100
  OR (decl->'snapshot'->'data')-'texts'<>'{}'::jsonb
  OR public.pd_graph_hash(decl->'snapshot'->'data') IS DISTINCT FROM decl->'snapshot'->>'sha256'
  OR (decl->'snapshot')-'data'-'sha256'<>'{}'::jsonb
  OR COALESCE((decl->>'memory_bytes')::bigint,0) NOT BETWEEN 1 AND (CASE cls WHEN 'delphi' THEN 536870912 ELSE 2147483648 END)
  OR COALESCE((decl->>'work_units')::integer,0) NOT BETWEEN 1 AND 10000
  OR jsonb_typeof(n->'inputs') IS DISTINCT FROM 'array' OR jsonb_array_length(n->'inputs')>4
  OR COALESCE((n->>'max_attempts')::integer,0) NOT BETWEEN 1 AND 10
  THEN RAISE EXCEPTION 'invalid stage contract (incremental not supported)'; END IF;
  IF v_stage='graph_embed' AND jsonb_array_length(n->'inputs')<>0 OR v_stage<>'graph_embed' AND jsonb_array_length(n->'inputs')<>1
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
   OR e->>'role' IS DISTINCT FROM (CASE n->>'stage' WHEN 'graph_cluster' THEN 'embeddings' WHEN 'graph_narrative' THEN 'clusters' END)
   OR (e ? 'node')=(e ? 'artifact_id') THEN RAISE EXCEPTION 'invalid input role or reference'; END IF;
   IF e ? 'node' THEN
    SELECT job_id INTO STRICT prod FROM public.delphi_graph_nodes WHERE env=p_env AND graph_id=gid AND node_key=e->>'node';
   ELSE
    aid=(e->>'artifact_id')::uuid;
    SELECT a.job_id INTO STRICT prod FROM public.delphi_artifacts a JOIN public.delphi_graph_nodes pn USING(env,job_id)
    WHERE a.env=p_env AND a.artifact_id=aid AND pn.zid=p_zid AND a.content_sha=e->>'sha256' AND public.pd_graph_hash(pn.declared)=e->>'contract_sha256';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.polis_queue_jobs qp WHERE qp.env=p_env AND qp.job_id=prod AND qp.stage=CASE n->>'stage' WHEN 'graph_cluster' THEN 'graph_embed' WHEN 'graph_narrative' THEN 'graph_cluster' END)
   THEN RAISE EXCEPTION 'input stage mismatch'; END IF;
   IF (SELECT gn.declared->'snapshot'->>'sha256' FROM public.delphi_graph_nodes gn WHERE gn.env=p_env AND gn.job_id=prod) IS DISTINCT FROM n->'declared'->'snapshot'->>'sha256' THEN RAISE EXCEPTION 'upstream snapshot mismatch'; END IF;
   INSERT INTO public.delphi_graph_edges VALUES(p_env,jid,prod,e->>'role',e->>'sha256',aid);
  END LOOP;
 END LOOP;
 UPDATE public.delphi_graphs SET sealed=true WHERE env=p_env AND graph_id=gid;
 INSERT INTO public.delphi_job_guards VALUES(p_env,p_scope,p_zid,root,public.pd_graph_hash(p_spec));
 RETURN jsonb_build_object('outcome','enqueued','graph_id',gid,'root_job_id',root);
END $$;

CREATE FUNCTION public.pd_graph_readiness(p_env text,p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('schema','polis-job-readiness/1','job_id',p_job,'state',q.state,
 'blockers',COALESCE((SELECT jsonb_agg(jsonb_build_object('producer',e.producer,'reason',CASE
 WHEN p.state='dead' THEN 'dependency_dead' WHEN p.state='cancelled' THEN 'dependency_cancelled'
 WHEN p.state<>'succeeded' THEN 'waiting_for_input'
 WHEN a.artifact_id IS NULL THEN 'unresolved_output'
 ELSE 'digest_mismatch' END) ORDER BY e.input_role)
 FROM public.delphi_graph_edges e JOIN public.polis_queue_jobs p ON p.env=e.env AND p.job_id=e.producer
 LEFT JOIN public.delphi_artifacts a ON a.env=e.env AND a.job_id=e.producer
 WHERE e.env=p_env AND e.consumer=p_job AND (p.state<>'succeeded' OR a.artifact_id IS NULL OR (e.expected_sha IS NOT NULL AND e.expected_sha<>a.content_sha))),'[]'::jsonb))
 FROM public.polis_queue_jobs q JOIN public.delphi_graph_nodes n USING(env,job_id) WHERE q.env=p_env AND q.job_id=p_job
$$;
CREATE FUNCTION public.pd_graph_claim(p_env text,p_priority smallint,p_owner uuid,p_attempt uuid,p_lease integer,p_class text,p_stages text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE j public.polis_queue_jobs; n public.delphi_graph_nodes; inputs jsonb; v_resolved jsonb;
BEGIN
 IF p_owner IS NULL OR p_attempt IS NULL OR p_lease IS NULL OR p_lease NOT BETWEEN 10 AND 900
 OR p_class IS NULL OR p_class NOT IN ('delphi','large') THEN RAISE EXCEPTION 'invalid graph claim'; END IF;
 SELECT q.* INTO j FROM public.polis_queue_jobs q JOIN public.delphi_graph_nodes n USING(env,job_id)
 JOIN public.delphi_graphs g USING(env,graph_id)
 WHERE q.env=p_env AND q.priority=p_priority AND q.worker_class=p_class AND q.stage=ANY(string_to_array(p_stages,','))
 AND g.sealed AND q.state IN ('queued','retry_wait') AND q.eligible_at<=statement_timestamp()
 AND q.attempt_count-q.parked_attempt_count<q.max_attempts
 AND public.pd_graph_readiness(q.env,q.job_id)->'blockers'='[]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM public.polis_queue_attempts a WHERE a.env=q.env AND a.job_id=q.job_id AND a.process_exit_confirmed_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.delphi_provider_requests pr WHERE pr.env=q.env AND pr.job_id=q.job_id AND pr.state IN ('intent','submission_unknown','submitted'))
 ORDER BY q.eligible_at,q.created_at,q.job_id FOR UPDATE OF q SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('schema_version','polis-queue/5','outcome','none'); END IF;
 UPDATE public.delphi_graph_edges e SET artifact_id=a.artifact_id FROM public.delphi_artifacts a
 WHERE e.env=p_env AND e.consumer=j.job_id AND e.artifact_id IS NULL AND a.env=e.env AND a.job_id=e.producer
 AND (e.expected_sha IS NULL OR e.expected_sha=a.content_sha);
 SELECT * INTO STRICT n FROM public.delphi_graph_nodes WHERE env=p_env AND job_id=j.job_id;
 IF n.resolved IS NULL THEN
  SELECT COALESCE(jsonb_object_agg(e.input_role,jsonb_build_object('artifact_id',a.artifact_id,'producer',a.job_id,'run_id',a.run_id,
  'attempt_id',a.attempt_id,'sha256',a.content_sha,'schema',a.schema_version,'payload',a.payload)),'{}'::jsonb)
  INTO inputs FROM public.delphi_graph_edges e JOIN public.delphi_artifacts a USING(env,artifact_id) WHERE e.env=p_env AND e.consumer=j.job_id;
  v_resolved=jsonb_build_object('schema','polis-job-input/1','declared',n.declared,'artifacts',inputs);
  UPDATE public.delphi_graph_nodes SET resolved=v_resolved,resolved_sha=public.pd_graph_hash(v_resolved) WHERE env=p_env AND job_id=j.job_id;
  n.resolved=v_resolved; n.resolved_sha=public.pd_graph_hash(v_resolved);
 END IF;
 UPDATE public.polis_queue_jobs SET state='running',owner_id=p_owner,attempt_id=p_attempt,
 locked_until=clock_timestamp()+make_interval(secs=>p_lease),lease_epoch=lease_epoch+1,
 version=version+1,mgmt_version=mgmt_version+1,attempt_count=attempt_count+1,updated_at=clock_timestamp()
 WHERE env=p_env AND job_id=j.job_id RETURNING * INTO j;
 INSERT INTO public.polis_queue_attempts(env,attempt_id,job_id,owner_id,lease_epoch,outcome)
 VALUES(p_env,p_attempt,j.job_id,p_owner,j.lease_epoch,'running');
 RETURN public.pq_result('owned',j)||jsonb_build_object('graph_input',n.resolved,'graph_input_wire',n.resolved::text,'graph_input_sha',n.resolved_sha,'zid',n.zid);
END $$;

CREATE FUNCTION public.pd_graph_finalize(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_uri text,p_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE j public.polis_queue_jobs; a public.polis_queue_attempts; n public.delphi_graph_nodes; m jsonb; raw text; outdoc jsonb;
BEGIN
 j=public.pd_lock(p_env,p_job);
 SELECT * INTO a FROM public.polis_queue_attempts WHERE env=p_env AND attempt_id=p_attempt AND job_id=p_job;
 IF j.state='succeeded' AND j.terminal_attempt_id=p_attempt AND a.owner_id=p_owner AND a.lease_epoch=p_epoch THEN
  RETURN public.pq_result(CASE WHEN a.output_sha256=p_sha THEN 'already_succeeded' ELSE 'invalid_output' END,j);
 END IF;
 IF j.stage NOT LIKE 'graph_%' OR NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RETURN public.pq_result('fenced',j); END IF;
 IF a.process_exit_confirmed_at IS NULL THEN RAISE EXCEPTION 'process exit proof required'; END IF;
 SELECT * INTO STRICT n FROM public.delphi_graph_nodes WHERE env=p_env AND job_id=p_job;
 SELECT line INTO raw FROM public.polis_queue_logs WHERE env=p_env AND attempt_id=p_attempt AND stream='manifest'
 AND encode(sha256(convert_to(line,'UTF8')),'hex')=p_sha ORDER BY seq DESC LIMIT 1;
 IF raw IS NULL THEN RETURN public.pq_result('invalid_output',j); END IF;
 m=raw::jsonb; outdoc=m->'output';
 IF m->>'schema' IS DISTINCT FROM 'polis-job-artifact-manifest/1'
 OR m->>'job_id' IS DISTINCT FROM p_job::text OR m->>'run_id' IS DISTINCT FROM j.run_id::text
 OR m->>'attempt_id' IS DISTINCT FROM p_attempt::text OR m->>'stage' IS DISTINCT FROM j.stage
 OR m->>'input_sha256' IS DISTINCT FROM n.resolved_sha OR m->>'outcome' IS DISTINCT FROM 'succeeded'
 OR m-'schema'-'job_id'-'run_id'-'attempt_id'-'stage'-'input_sha256'-'outcome'-'output'<>'{}'::jsonb
 OR outdoc-'role'-'schema'-'payload'-'sha256'<>'{}'::jsonb
 OR outdoc->>'role' IS DISTINCT FROM 'result' OR outdoc->>'schema' IS DISTINCT FROM j.stage||'/1'
 OR jsonb_typeof(outdoc->'payload') IS DISTINCT FROM 'string' OR octet_length(outdoc->>'payload')>524288
 OR outdoc->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(outdoc->>'payload','UTF8')),'hex')
 THEN RETURN public.pq_result('invalid_output',j); END IF;
 IF EXISTS(SELECT 1 FROM public.delphi_provider_requests WHERE env=p_env AND job_id=p_job AND state IN ('intent','submission_unknown','submitted'))
 THEN RAISE EXCEPTION 'provider request unresolved'; END IF;
 INSERT INTO public.delphi_artifacts(env,job_id,run_id,attempt_id,output_role,schema_version,payload,content_sha,byte_count)
 VALUES(p_env,p_job,j.run_id,p_attempt,'result',outdoc->>'schema',outdoc->>'payload',outdoc->>'sha256',octet_length(outdoc->>'payload'));
 UPDATE public.polis_queue_attempts SET outcome='succeeded',ended_at=clock_timestamp(),output_sha256=p_sha WHERE env=p_env AND attempt_id=p_attempt;
 UPDATE public.polis_queue_jobs SET state='succeeded',terminal_attempt_id=p_attempt,owner_id=NULL,attempt_id=NULL,locked_until=NULL,
 output_sha256=p_sha,version=version+1,mgmt_version=mgmt_version+1,updated_at=clock_timestamp() WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 UPDATE public.delphi_jobs SET output_manifest_digest=decode(p_sha,'hex') WHERE env=p_env AND job_id=p_job;
 UPDATE public.polis_queue_runs SET state='succeeded',expected_output_uri='pg-artifact://'||p_job::text,expected_output_sha256=p_sha,output_sha256=p_sha WHERE env=p_env AND run_id=j.run_id;
 RETURN public.pq_result('succeeded',j,false);
END $$;
CREATE FUNCTION public.pd_graph_reconcile(p_env text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE g record; released integer=0;
BEGIN
 FOR g IN SELECT d.scope_key FROM public.delphi_job_guards d JOIN public.delphi_graphs g ON g.env=d.env AND g.root_job_id=d.root_job_id
 WHERE d.env=p_env AND NOT EXISTS(SELECT 1 FROM public.delphi_graph_nodes gn JOIN public.polis_queue_jobs jq USING(env,job_id) WHERE gn.env=g.env AND gn.graph_id=g.graph_id AND jq.state NOT IN ('succeeded','dead','cancelled')) AND NOT EXISTS(SELECT 1 FROM public.delphi_graph_nodes gn JOIN public.polis_queue_attempts a USING(env,job_id) WHERE gn.env=g.env AND gn.graph_id=g.graph_id AND a.process_exit_confirmed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM public.delphi_graph_nodes gn JOIN public.delphi_provider_requests pr USING(env,job_id) WHERE gn.env=g.env AND gn.graph_id=g.graph_id AND pr.state IN ('intent','submission_unknown','submitted')) ORDER BY d.scope_key LIMIT 100 LOOP
  IF public.pd_release_scope(p_env,g.scope_key) THEN released=released+1; END IF;
 END LOOP;
 RETURN jsonb_build_object('released',released);
END $$;
CREATE FUNCTION public.pd_graph_view(p_env text,p_graph uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('schema','polis-job-graph-status/1','graph_id',g.graph_id,'supersedes',g.supersedes,'sealed',g.sealed,
 'guard_held',EXISTS(SELECT 1 FROM public.delphi_job_guards WHERE env=g.env AND root_job_id=g.root_job_id),
 'nodes',(SELECT jsonb_agg(jsonb_build_object('key',n.node_key,'job_id',n.job_id,'run_id',n.run_id,'declared_sha',public.pd_graph_hash(n.declared),
 'readiness',public.pd_graph_readiness(n.env,n.job_id),'attempts',q.attempt_count,'mgmt_version',q.mgmt_version::text,
 'input_sha256',n.resolved_sha,'provider_requests',(SELECT COALESCE(jsonb_agg(jsonb_build_object('request_id',pr.request_id,'state',pr.state,'batch_id',pr.provider_batch_id)),'[]'::jsonb) FROM public.delphi_provider_requests pr WHERE pr.env=n.env AND pr.job_id=n.job_id),'artifact',(SELECT to_jsonb(a) FROM public.delphi_artifacts a WHERE a.env=n.env AND a.job_id=n.job_id)) ORDER BY n.node_key)
 FROM public.delphi_graph_nodes n JOIN public.polis_queue_jobs q USING(env,job_id) WHERE n.env=g.env AND n.graph_id=g.graph_id))
 FROM public.delphi_graphs g WHERE g.env=p_env AND g.graph_id=p_graph
$$;
CREATE FUNCTION public.pd_graph_bundle(p_env text,p_artifact uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH RECURSIVE upstream(id) AS (
 SELECT p_artifact UNION SELECT e.artifact_id FROM upstream u JOIN public.delphi_artifacts a ON a.env=p_env AND a.artifact_id=u.id
 JOIN public.delphi_graph_edges e ON e.env=a.env AND e.consumer=a.job_id WHERE e.artifact_id IS NOT NULL)
 SELECT jsonb_build_object('schema','polis-job-bundle/1','root',p_artifact,
 'artifacts',jsonb_agg(to_jsonb(a) ORDER BY a.artifact_id)) FROM upstream u JOIN public.delphi_artifacts a ON a.env=p_env AND a.artifact_id=u.id
$$;
CREATE FUNCTION public.pd_graph_publish(p_env text,p_graph uuid,p_job uuid,p_expected bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_column
DECLARE g public.delphi_graphs; aid uuid; current_generation bigint;
BEGIN
 SELECT * INTO STRICT g FROM public.delphi_graphs WHERE env=p_env AND graph_id=p_graph AND sealed;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:scope',p_env,g.scope_key)::text,0));
 SELECT a.artifact_id INTO STRICT aid FROM public.delphi_graph_nodes n JOIN public.delphi_artifacts a USING(env,job_id)
 JOIN public.polis_queue_jobs q USING(env,job_id) WHERE n.env=p_env AND n.graph_id=p_graph AND n.job_id=p_job AND q.stage='graph_narrative' AND q.state='succeeded';
 IF EXISTS(SELECT 1 FROM public.delphi_graph_nodes n JOIN public.polis_queue_jobs q USING(env,job_id) WHERE n.env=p_env AND n.graph_id=p_graph AND q.state<>'succeeded')
 OR EXISTS(SELECT 1 FROM public.delphi_graphs x WHERE x.env=p_env AND x.zid=g.zid AND x.scope_key=g.scope_key AND x.created_at>g.created_at) THEN RAISE EXCEPTION 'incomplete or superseded bundle'; END IF;
 SELECT generation INTO current_generation FROM public.delphi_graph_served WHERE env=p_env AND zid=g.zid AND scope_key=g.scope_key FOR UPDATE;
 IF COALESCE(current_generation,0) IS DISTINCT FROM p_expected THEN RETURN jsonb_build_object('outcome','conflict'); END IF;
 INSERT INTO public.delphi_graph_served VALUES(p_env,g.zid,g.scope_key,p_expected+1,aid)
 ON CONFLICT(env,zid,scope_key) DO UPDATE SET generation=EXCLUDED.generation,artifact_id=EXCLUDED.artifact_id;
 RETURN jsonb_build_object('outcome','published','generation',p_expected+1,'bundle',public.pd_graph_bundle(p_env,aid));
END $$;
CREATE FUNCTION public.pd_graph_served(p_env text,p_zid integer,p_scope text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('generation',generation,'bundle',public.pd_graph_bundle(env,artifact_id))
 FROM public.delphi_graph_served WHERE env=p_env AND zid=p_zid AND scope_key=p_scope
$$;
CREATE FUNCTION public.pd_graph_depth(p_env text,p_class text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('schema','polis-job-depth/1',
 'runnable',count(*) FILTER(WHERE state IN ('queued','retry_wait') AND eligible_at<=statement_timestamp() AND public.pd_graph_readiness(q.env,q.job_id)->'blockers'='[]'::jsonb AND q.attempt_count-q.parked_attempt_count<q.max_attempts AND NOT EXISTS(SELECT 1 FROM public.polis_queue_attempts a WHERE a.env=q.env AND a.job_id=q.job_id AND a.process_exit_confirmed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM public.delphi_provider_requests p WHERE p.env=q.env AND p.job_id=q.job_id AND p.state IN ('intent','submission_unknown','submitted'))),
 'dependency_blocked',count(*) FILTER(WHERE state IN ('queued','retry_wait') AND public.pd_graph_readiness(env,job_id)->'blockers'<>'[]'::jsonb),
 'running',count(*) FILTER(WHERE state='running'),'dead',count(*) FILTER(WHERE state='dead'))
 FROM public.polis_queue_jobs q WHERE env=p_env AND worker_class=p_class AND stage LIKE 'graph_%'
$$;
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
 IF m->>'schema' IS DISTINCT FROM 'polis-jobs.output-manifest/1'
 OR m->>'job_id' IS DISTINCT FROM p_job::text OR m->>'attempt_id' IS DISTINCT FROM p_attempt::text
 OR m->>'stage' IS DISTINCT FROM j.stage OR m->>'outcome' IS DISTINCT FROM 'succeeded'
 OR COALESCE(m->>'phase','') NOT IN ('submit','recheck','run')
 OR jsonb_typeof(m->'outputs') IS DISTINCT FROM 'array'
 OR jsonb_typeof(m->'inputs') IS DISTINCT FROM 'object'
 OR jsonb_typeof(m->'models') IS DISTINCT FROM 'object'
 OR jsonb_typeof(m->'cost') IS DISTINCT FROM 'object'
 OR (m ? 'artifacts' AND m->'artifacts'<>'[]'::jsonb)
 THEN RETURN public.pq_result('invalid_output',j); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(m->'outputs') o WHERE o->>'store' IS DISTINCT FROM 'dynamodb'
 OR COALESCE(o->>'table','')='' OR NOT (o ? 'keys' OR o ? 'key_prefix') OR COALESCE(o->>'rows','') !~ '^[0-9]+$')
 THEN RETURN public.pq_result('invalid_output',j); END IF;
 IF EXISTS(SELECT 1 FROM public.delphi_provider_requests WHERE env=p_env AND job_id=p_job AND state IN ('intent','submission_unknown','submitted'))
 THEN RAISE EXCEPTION 'provider request unresolved'; END IF;
 UPDATE public.polis_queue_attempts SET outcome='succeeded',ended_at=clock_timestamp(),output_sha256=p_sha WHERE env=p_env AND attempt_id=p_attempt;
 UPDATE public.polis_queue_jobs SET state='succeeded',terminal_attempt_id=p_attempt,owner_id=NULL,attempt_id=NULL,locked_until=NULL,
 output_sha256=p_sha,version=version+1,mgmt_version=mgmt_version+1,updated_at=clock_timestamp() WHERE env=p_env AND job_id=p_job RETURNING * INTO j;
 UPDATE public.delphi_jobs SET output_manifest_digest=decode(p_sha,'hex') WHERE env=p_env AND job_id=p_job;
 UPDATE public.polis_queue_runs SET state='succeeded',expected_output_uri=p_uri,expected_output_sha256=p_sha,output_sha256=p_sha WHERE env=p_env AND run_id=j.run_id;
 RETURN public.pq_result('succeeded',j,false);
END $$;
-- Explicit operator remediation, never granted to an ordinary executor.
-- Preserve the existing class-depth wire; graph blocked work is not scale-out demand.
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
-- No table access or internal helper privilege crosses the executor boundary.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT oid::regclass AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND (relname LIKE 'delphi_graph_%' OR relname='delphi_graphs' OR relname='delphi_artifacts') AND relkind='r' LOOP
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC,polis_queue_executor',r.name);
 END LOOP;
 FOR r IN SELECT oid::regprocedure AS name FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'pd_graph_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,polis_queue_executor',r.name);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.pd_graph_admit(text,integer,text,text,jsonb,uuid),public.pd_graph_claim(text,smallint,uuid,uuid,integer,text,text),
 public.pd_graph_finalize(text,uuid,uuid,uuid,bigint,text,text),public.pd_graph_reconcile(text),
 public.pd_graph_view(text,uuid),public.pd_graph_readiness(text,uuid),public.pd_graph_depth(text,text),
 public.pd_graph_publish(text,uuid,uuid,bigint),public.pd_graph_served(text,integer,text) TO polis_queue_executor;
COMMIT;
