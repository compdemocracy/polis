-- 000046: narrative and topic-name jobs written outside Polis, each one job.
--
-- A conversation owner's own agent writes a report narrative (or the topic
-- names) with the owner's own model from Delphi's own prompts, and imports
-- it. Each import is one Delphi job with its own job id, run and attempt,
-- holding only its own result rows (one batch, one family, immutable like
-- every other result row), with the provenance it was written under:
-- the prompt pack it answered (the clustering labels, the math tick and the
-- comment set it was built over, the prompt version), the model as its
-- runner declared it, the runner, the channel, the time, and the
-- deterministic checks of each section against that pack. Nothing is copied
-- forward from earlier jobs, and no served pointer moves at import. A
-- report's published narrative is a pointer the owner moves
-- (pd_narrative_publish, recorded in delphi_current under the
-- `narrative:<report>` scope that table was made for, with every move kept
-- in delphi_narrative_publications); a job is never overwritten.
--
-- New objects:
--   delphi_narrative_packs         Delphi's prompts for a report, built by
--                                  Delphi's own prompt code with no model
--                                  call, stored once per content digest.
--   delphi_narrative_jobs          one row per narrative or topic-name job.
--   delphi_narrative_publications  every move of a published pointer.
--   pd_narrative_source_state      the inputs a pack's freshness is judged
--                                  by (SECURITY INVOKER: the caller reads).
--   pd_narrative_pack_put / _pack_current, pd_narrative_job_submit,
--   pd_narrative_publish, pd_narrative_jobs_list, pd_narrative_job_read,
--   pd_narrative_compare.
-- Changed object: pd_queue_binding (000027) also binds a delphi_narrative
-- run to a job of kind topic_name; every other binding is as it was.
--
-- Locks at deploy: the foreign key to delphi_jobs takes SHARE ROW EXCLUSIVE
-- on delphi_jobs until commit (Delphi admissions wait at most the 5 s
-- lock_timeout once); nothing here locks conversations, votes, comments or
-- participants, so votes, comments and the next comment never wait on it.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;

CREATE TABLE public.delphi_narrative_packs(
 env text NOT NULL CHECK(env ~ '^[a-z0-9_-]{1,64}$'),
 pack_id uuid NOT NULL,
 zid integer NOT NULL,
 report_id text NOT NULL CHECK(length(report_id) BETWEEN 1 AND 100),
 prompt_version text NOT NULL CHECK(prompt_version ~ '^[a-z_]{1,32}/[0-9]{1,6}$'),
 pack_sha256 text NOT NULL,
 inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object'),
 pack jsonb NOT NULL CHECK(jsonb_typeof(pack)='object'),
 byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 33554432),
 code_version text NOT NULL CHECK(code_version ~ '^[0-9a-f]{40,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,pack_id), UNIQUE(env,report_id,pack_sha256),
 CHECK(pack_sha256=encode(sha256(convert_to(pack::text,'UTF8')),'hex')),
 CHECK(byte_count=octet_length(pack::text))
);
CREATE INDEX delphi_narrative_packs_report ON public.delphi_narrative_packs(env,report_id,created_at);

CREATE TABLE public.delphi_narrative_jobs(
 env text NOT NULL, job_id uuid NOT NULL, zid integer NOT NULL,
 report_id text NOT NULL CHECK(length(report_id) BETWEEN 1 AND 100),
 kind text NOT NULL CHECK(kind IN ('narrative','topic_name')),
 channel text NOT NULL CHECK(channel IN ('cli','mcp','browser','pipeline')),
 model text NOT NULL CHECK(model ~ '^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,99}$'),
 model_known text NOT NULL CHECK(model_known IN ('declared','reported_by_provider','run_by_polis')),
 runner text CHECK(runner IS NULL OR runner ~ '^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,99}$'),
 prompt_version text NOT NULL CHECK(prompt_version ~ '^[a-z_]{1,32}/[0-9]{1,6}$'),
 prompt_sha256 text CHECK(prompt_sha256 IS NULL OR prompt_sha256 ~ '^[0-9a-f]{64}$'),
 pack_id uuid, pack_sha256 text CHECK(pack_sha256 IS NULL OR pack_sha256 ~ '^[0-9a-f]{64}$'),
 export_id text NOT NULL CHECK(export_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 input_digest text NOT NULL CHECK(input_digest ~ '^[0-9a-f]{64}$'),
 result_sha256 text NOT NULL CHECK(result_sha256 ~ '^[0-9a-f]{64}$'),
 inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object'),
 clustering jsonb NOT NULL CHECK(jsonb_typeof(clustering)='object'),
 checks jsonb NOT NULL CHECK(jsonb_typeof(checks)='object'),
 section_count integer NOT NULL CHECK(section_count BETWEEN 1 AND 99),
 -- The account that imported it: used for the rate limits and never served.
 submitted_by integer,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,job_id), UNIQUE(env,report_id,export_id),
 FOREIGN KEY(env,zid,job_id) REFERENCES public.delphi_jobs(env,zid,job_id),
 FOREIGN KEY(env,pack_id) REFERENCES public.delphi_narrative_packs(env,pack_id),
 CHECK((channel='pipeline')=(model_known='run_by_polis')),
 CHECK(channel='pipeline' OR (pack_id IS NOT NULL AND pack_sha256 IS NOT NULL AND submitted_by IS NOT NULL))
);
CREATE INDEX delphi_narrative_jobs_account ON public.delphi_narrative_jobs(env,submitted_by,created_at);
CREATE INDEX delphi_narrative_jobs_conversation ON public.delphi_narrative_jobs(env,zid,created_at);
CREATE INDEX delphi_narrative_jobs_report ON public.delphi_narrative_jobs(env,report_id,kind,created_at);

CREATE TABLE public.delphi_narrative_publications(
 env text NOT NULL, zid integer NOT NULL, scope text NOT NULL CHECK(scope ~ '^narrative:.+'),
 generation bigint NOT NULL CHECK(generation>0), job_id uuid NOT NULL,
 moved_by integer NOT NULL, moved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,zid,scope,generation),
 FOREIGN KEY(env,job_id) REFERENCES public.delphi_narrative_jobs(env,job_id)
);

CREATE TRIGGER narrative_pack_immutable BEFORE UPDATE OR DELETE ON public.delphi_narrative_packs
 FOR EACH ROW EXECUTE FUNCTION public.pd_graph_immutable();
CREATE TRIGGER narrative_job_immutable BEFORE UPDATE OR DELETE ON public.delphi_narrative_jobs
 FOR EACH ROW EXECUTE FUNCTION public.pd_graph_immutable();
CREATE TRIGGER narrative_publication_immutable BEFORE UPDATE OR DELETE ON public.delphi_narrative_publications
 FOR EACH ROW EXECUTE FUNCTION public.pd_graph_immutable();

-- A delphi_narrative run may now also be a topic_name job (written only by
-- pd_narrative_job_submit). Otherwise the body is 000027's, unchanged.
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
 OR (q.stage='delphi_narrative' AND j.kind NOT IN ('narrative','topic_name'))
 OR (q.stage='delphi_narrative' AND j.kind='topic_name' AND NOT EXISTS(
  SELECT 1 FROM public.delphi_narrative_jobs nj WHERE nj.env=q.env AND nj.job_id=q.job_id AND nj.kind='topic_name'))
 OR (q.stage='math_rebuild' AND (j.kind<>'math_rebuild' OR q.worker_class<>'large' OR j.report_id IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid logical execution binding'; END IF;
 RETURN NULL;
END $$;

-- What a prompt pack's freshness is judged by, in the shape of the run
-- record's inputs (polis-jobs.comment-set/1, as delphi/polismath/job_child/
-- census.py computes it). SECURITY INVOKER: the caller reads these tables
-- with its own grants, as the Delphi service and the server already do.
CREATE FUNCTION public.pd_narrative_source_state(p_zid integer,p_math_env text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
  'math_env',p_math_env,
  'math_tick',(SELECT m.math_tick FROM public.math_main m WHERE m.zid=p_zid AND m.math_env=p_math_env),
  'math_caching_tick',(SELECT m.caching_tick FROM public.math_main m WHERE m.zid=p_zid AND m.math_env=p_math_env),
  'comment_set_sha256',(SELECT encode(sha256(convert_to('polis-jobs.comment-set/1'||chr(10)||COALESCE(string_agg(
    c.tid::text||chr(9)||COALESCE(c.mod,0)::text||chr(9)||(CASE WHEN c.active THEN '1' ELSE '0' END)||chr(9)||
    encode(sha256(convert_to(COALESCE(c.txt,''),'UTF8')),'hex')||chr(10),'' ORDER BY c.tid),''),'UTF8')),'hex')
   FROM public.comments c WHERE c.zid=p_zid),
  'vote_hwm',(SELECT max(v.created) FROM public.votes v WHERE v.zid=p_zid))
$$;

-- Store a prompt pack written by Delphi's prompt code (no model call). An
-- identical pack for the same report is stored once.
CREATE FUNCTION public.pd_narrative_pack_put(p_env text,p_zid integer,p_report text,p_pack jsonb,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE sha text; existing public.delphi_narrative_packs; v_id uuid; n integer;
BEGIN
 IF p_env IS NULL OR p_env !~ '^[a-z0-9_-]{1,64}$' OR p_code IS NULL OR p_code !~ '^[0-9a-f]{40,64}$'
 OR jsonb_typeof(p_pack) IS DISTINCT FROM 'object' OR p_pack->>'schema' IS DISTINCT FROM 'polis-narrative-pack/1'
 OR COALESCE(p_pack->>'pack_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR p_pack->>'report_id' IS DISTINCT FROM p_report OR p_pack->>'zid' IS DISTINCT FROM p_zid::text
 OR COALESCE(p_pack->>'prompt_version','') !~ '^[a-z_]{1,32}/[0-9]{1,6}$'
 OR jsonb_typeof(p_pack->'inputs') IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_pack->'sections') IS DISTINCT FROM 'array' OR jsonb_array_length(p_pack->'sections')<1
 OR octet_length(p_pack::text)>33554432
 THEN RAISE EXCEPTION 'invalid narrative pack'; END IF;
 SELECT count(*) INTO n FROM public.reports WHERE report_id=p_report AND zid=p_zid;
 IF n<>1 THEN RAISE EXCEPTION 'report conversation mismatch'; END IF;
 sha=encode(sha256(convert_to(p_pack::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:narrative-pack',p_env,p_report)::text,0));
 SELECT * INTO existing FROM public.delphi_narrative_packs WHERE env=p_env AND report_id=p_report AND pack_sha256=sha;
 IF FOUND THEN
  RETURN jsonb_build_object('outcome','existing','pack_id',existing.pack_id,'pack_sha256',sha,'created_at',existing.created_at);
 END IF;
 v_id=(p_pack->>'pack_id')::uuid;
 INSERT INTO public.delphi_narrative_packs(env,pack_id,zid,report_id,prompt_version,pack_sha256,inputs,pack,byte_count,code_version)
 VALUES(p_env,v_id,p_zid,p_report,p_pack->>'prompt_version',sha,p_pack->'inputs',p_pack,octet_length(p_pack::text),p_code);
 RETURN jsonb_build_object('outcome','stored','pack_id',v_id,'pack_sha256',sha,
  'created_at',(SELECT created_at FROM public.delphi_narrative_packs WHERE env=p_env AND pack_id=v_id));
END $$;

-- The newest pack for a report, or NULL.
CREATE FUNCTION public.pd_narrative_pack_current(p_env text,p_report text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('pack_id',p.pack_id,'pack_sha256',p.pack_sha256,'zid',p.zid,'report_id',p.report_id,
  'prompt_version',p.prompt_version,'inputs',p.inputs,'code_version',p.code_version,
  'created_at',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'pack',p.pack)
 FROM public.delphi_narrative_packs p WHERE p.env=p_env AND p.report_id=p_report
 ORDER BY p.created_at DESC,p.pack_id DESC LIMIT 1
$$;

-- One narrative (or topic-name) job, written whole in this transaction:
-- admitted through the queue's own admission (pd_enqueue), run as one
-- attempt with no child or provider, its rows put and sealed as one batch of
-- one family, bound to its own artifact (no served pointer moves), its
-- manifest recorded where pd_run_record reads it, and its provenance and
-- checks stored. Expected refusals are replies, not errors:
--   {"outcome":"existing"}      the same export with the same result
--   {"outcome":"conflict"}      the same export with a different result
--   {"outcome":"rate_limited","limit":...,"max":...,"reset_at":...}
CREATE FUNCTION public.pd_narrative_job_submit(p_env text,p_report text,p_job uuid,p_run uuid,
 p_sub jsonb,p_items jsonb,p_limits jsonb,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
#variable_conflict use_column
DECLARE v_zid integer; v_kind text; v_family text; v_scope text; v_product text; v_channel text;
 v_uid integer; v_pack public.delphi_narrative_packs; prior public.delphi_narrative_jobs;
 n integer; v_max integer; v_reset timestamptz; v_published uuid;
 spec jsonb; k jsonb; line jsonb; wire text; ref jsonb; reply jsonb;
 conf jsonb; frame text; gid uuid=gen_random_uuid(); owner uuid=gen_random_uuid(); aid uuid=gen_random_uuid();
 v_payload text; v_artifact uuid; v_manifest text; v_msha text; v_models jsonb;
BEGIN
 v_kind=p_sub->>'kind'; v_channel=p_sub->>'channel';
 IF p_env IS NULL OR p_env !~ '^[a-z0-9_-]{1,64}$' OR p_job IS NULL OR p_run IS NULL
 OR p_code IS NULL OR p_code !~ '^[0-9a-f]{40,64}$' OR jsonb_typeof(p_sub) IS DISTINCT FROM 'object'
 OR v_kind IS NULL OR v_kind NOT IN ('narrative','topic_name')
 OR v_channel IS NULL OR v_channel NOT IN ('cli','mcp','browser','pipeline')
 OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 99
 OR jsonb_typeof(p_limits) IS DISTINCT FROM 'object'
 OR (p_sub->>'submitted_by' IS NOT NULL AND p_sub->>'submitted_by' !~ '^[0-9]{1,10}$')
 OR octet_length(p_items::text)>4194304
 THEN RAISE EXCEPTION 'invalid narrative job submission'; END IF;
 SELECT r.zid INTO STRICT v_zid FROM public.reports r WHERE r.report_id=p_report;
 v_uid=(p_sub->>'submitted_by')::integer;
 v_family=CASE v_kind WHEN 'narrative' THEN 'Delphi_NarrativeReports' ELSE 'Delphi_CommentClustersLLMTopicNames' END;
 v_scope=CASE v_kind WHEN 'narrative' THEN 'narrative:'||p_report ELSE 'narrative:'||p_report||':topic_names' END;
 v_product='narrative-jobs:'||p_report;
 IF v_channel<>'pipeline' THEN
  SELECT * INTO v_pack FROM public.delphi_narrative_packs WHERE env=p_env AND pack_id=(p_sub->>'pack_id')::uuid
   AND report_id=p_report AND zid=v_zid AND pack_sha256=p_sub->>'pack_sha256';
  IF NOT FOUND THEN RAISE EXCEPTION 'narrative pack not found'; END IF;
 END IF;
 -- One submission at a time per conversation, and per account.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:narrative-jobs',p_env,v_zid)::text,0));
 IF v_uid IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:narrative-account',p_env,v_uid)::text,0));
 END IF;
 SELECT * INTO prior FROM public.delphi_narrative_jobs WHERE env=p_env AND report_id=p_report AND export_id=p_sub->>'export_id';
 IF FOUND THEN
  IF prior.result_sha256=p_sub->>'result_sha256' AND prior.kind=v_kind THEN
   RETURN jsonb_build_object('outcome','existing','job_id',prior.job_id,
    'created_at',to_char(prior.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'checks',prior.checks);
  END IF;
  RETURN jsonb_build_object('outcome','conflict','job_id',prior.job_id);
 END IF;
 IF v_uid IS NOT NULL THEN
  v_max=(p_limits->>'account_per_day')::integer;
  SELECT count(*),min(created_at) INTO n,v_reset FROM public.delphi_narrative_jobs
   WHERE env=p_env AND submitted_by=v_uid AND created_at>clock_timestamp()-interval '24 hours';
  IF v_max IS NOT NULL AND n>=v_max THEN
   RETURN jsonb_build_object('outcome','rate_limited','limit','account_per_day','max',v_max,'reset_at',v_reset+interval '24 hours');
  END IF;
  v_max=(p_limits->>'conversation_per_day')::integer;
  SELECT count(*),min(created_at) INTO n,v_reset FROM public.delphi_narrative_jobs
   WHERE env=p_env AND zid=v_zid AND submitted_by IS NOT NULL AND created_at>clock_timestamp()-interval '24 hours';
  IF v_max IS NOT NULL AND n>=v_max THEN
   RETURN jsonb_build_object('outcome','rate_limited','limit','conversation_per_day','max',v_max,'reset_at',v_reset+interval '24 hours');
  END IF;
  v_max=(p_limits->>'unpublished_per_report')::integer;
  SELECT job_id INTO v_published FROM public.delphi_current WHERE env=p_env AND zid=v_zid AND scope=v_scope;
  SELECT count(*) INTO n FROM public.delphi_narrative_jobs
   WHERE env=p_env AND report_id=p_report AND kind=v_kind AND job_id IS DISTINCT FROM v_published;
  IF v_max IS NOT NULL AND n>=v_max THEN
   RETURN jsonb_build_object('outcome','rate_limited','limit','unpublished_per_report','max',v_max,'reset_at',NULL);
  END IF;
 END IF;
 -- The rows: this job's own, and nothing copied from any other job.
 SELECT key_spec INTO STRICT spec FROM public.delphi_result_catalog WHERE family=v_family;
 FOR line IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  IF jsonb_typeof(line)<>'object' THEN RAISE EXCEPTION 'invalid narrative job row'; END IF;
  SELECT jsonb_agg(line->(part->>0)) INTO k FROM jsonb_array_elements(spec) part;
  -- A repeated key is refused by delphi_result_rows' primary key.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(k) x WHERE x='null'::jsonb)
  THEN RAISE EXCEPTION 'invalid narrative job row key'; END IF;
  IF line->'job_id'->>'S' IS DISTINCT FROM p_job::text
  OR (v_kind='narrative' AND (NOT starts_with(line->'rid_section_model'->>'S',p_report||'#') OR line->'report_id'->>'S' IS DISTINCT FROM p_report))
  THEN RAISE EXCEPTION 'narrative job row binding'; END IF;
 END LOOP;
 -- Admission, as every Delphi job is admitted. Its scope is released below.
 conf=jsonb_build_object('narrative_job',jsonb_build_object('kind',v_kind,'channel',v_channel,
  'prompt_version',p_sub->>'prompt_version','pack_sha256',p_sub->>'pack_sha256','export_id',p_sub->>'export_id'));
 frame=jsonb_build_object('schema','polis-jobs.admission/1','zid',v_zid,'report_id',p_report,'config',conf,'inputs','{}'::jsonb)::text;
 reply=public.pd_enqueue(p_env,v_zid,v_product,'narrative-exchange',p_sub->>'export_id',p_sub->>'result_sha256',p_run,p_job,
  'frame://inline/'||rtrim(translate(replace(encode(convert_to(frame,'UTF8'),'base64'),chr(10),''),'+/','-_'),'='),
  encode(sha256(convert_to(frame,'UTF8')),'hex'),public.pd_graph_hash(conf),p_code,1::smallint,1,
  'delphi_narrative',p_report,v_product,conf);
 IF reply->>'outcome' IS DISTINCT FROM 'enqueued' THEN RAISE EXCEPTION 'narrative job admission conflict'; END IF;
 v_models=CASE v_kind WHEN 'narrative' THEN jsonb_build_object('embed',NULL,'topic',NULL,'narrative',p_sub->>'model')
  ELSE jsonb_build_object('embed',NULL,'topic',p_sub->>'model','narrative',NULL) END;
 UPDATE public.delphi_jobs SET kind=v_kind,model_versions=jsonb_build_object(v_kind,p_sub->>'model'),
  math_env=p_sub->'inputs'->>'math_env',
  math_tick=CASE WHEN jsonb_typeof(p_sub->'inputs'->'math_tick')='number' THEN (p_sub->'inputs'->>'math_tick')::bigint END,
  math_caching_tick=CASE WHEN jsonb_typeof(p_sub->'inputs'->'math_caching_tick')='number' THEN (p_sub->'inputs'->>'math_caching_tick')::bigint END
 WHERE env=p_env AND job_id=p_job;
 -- The job's own one-node graph: the narrative node, no inputs edges and no
 -- served pointer. A topic-name job's node is 'topic_names'.
 INSERT INTO public.delphi_graphs(env,graph_id,zid,scope_key,request_key,request,root_job_id)
 VALUES(p_env,gid,v_zid,'narrative-job:'||p_job::text,p_job::text,
  jsonb_build_object('schema','delphi-narrative-job/1','kind',v_kind,'channel',v_channel),p_job);
 INSERT INTO public.delphi_graph_nodes(env,zid,graph_id,job_id,run_id,node_key,declared)
 VALUES(p_env,v_zid,gid,p_job,p_run,CASE v_kind WHEN 'narrative' THEN 'narrative' ELSE 'topic_names' END,
  jsonb_build_object('schema','delphi-narrative-job/1','model',p_sub->>'model','model_known',p_sub->>'model_known',
   'prompt_version',p_sub->>'prompt_version','pack_sha256',p_sub->>'pack_sha256'));
 UPDATE public.delphi_graphs SET sealed=true WHERE env=p_env AND graph_id=gid;
 -- One attempt, owned in this transaction; no child or provider is started.
 UPDATE public.polis_queue_jobs SET state='running',owner_id=owner,attempt_id=aid,lease_epoch=lease_epoch+1,
  attempt_count=attempt_count+1,locked_until=clock_timestamp()+interval '60 seconds',version=version+1,mgmt_version=mgmt_version+1
 WHERE env=p_env AND job_id=p_job;
 INSERT INTO public.polis_queue_attempts(env,attempt_id,job_id,owner_id,lease_epoch,outcome,process_exit_confirmed_at)
 VALUES(p_env,aid,p_job,owner,1,'running',clock_timestamp());
 wire=public.pd_writer_json(jsonb_build_object('codec','delphi-storage-codec/1','family',v_family,
  'key',(SELECT jsonb_agg(part->0) FROM jsonb_array_elements(spec) part)))||chr(10);
 FOR line IN SELECT i.value FROM jsonb_array_elements(p_items) i
  ORDER BY public.pd_writer_json((SELECT jsonb_agg(i.value->(part->>0)) FROM jsonb_array_elements(spec) part)) COLLATE "C" LOOP
  wire=wire||public.pd_writer_json(line)||chr(10);
 END LOOP;
 PERFORM public.pd_result_put_family(p_env,p_job,owner,aid,1,v_family,wire);
 ref=public.pd_result_seal(p_env,p_job,owner,aid,1);
 v_payload=jsonb_build_object('schema','delphi-narrative-job/1','results',ref)::text;
 INSERT INTO public.delphi_artifacts(env,job_id,run_id,attempt_id,output_role,schema_version,payload,content_sha,byte_count)
 VALUES(p_env,p_job,p_run,aid,'result','delphi-narrative-job/1',v_payload,encode(sha256(convert_to(v_payload,'UTF8')),'hex'),octet_length(v_payload))
 RETURNING artifact_id INTO v_artifact;
 -- The manifest pd_run_record reads: written by Polis from a submission; the
 -- model is as its runner stated it.
 v_manifest=jsonb_build_object('schema','polis-jobs.output-manifest/2','job_id',p_job,'attempt_id',aid,
  'stage','delphi_narrative','phase','run','outcome','succeeded',
  'written_by','pd_narrative_job_submit','channel',v_channel,'model_known',p_sub->>'model_known',
  'inputs',p_sub->'inputs','models',v_models,
  'cost',jsonb_build_object('llm_tokens_in',NULL,'llm_tokens_out',NULL,'provider_batches','[]'::jsonb),
  'outputs',jsonb_build_array(jsonb_build_object('store','postgres','table',v_family,'rows',jsonb_array_length(p_items)::text,
   'key_prefix',CASE v_kind WHEN 'narrative' THEN p_report||'#' ELSE v_zid::text END)),
  'results',ref)::text;
 v_msha=encode(sha256(convert_to(v_manifest,'UTF8')),'hex');
 INSERT INTO public.polis_queue_logs(env,attempt_id,seq,stream,line) VALUES(p_env,aid,0,'manifest',v_manifest);
 UPDATE public.polis_queue_attempts SET outcome='succeeded',ended_at=clock_timestamp(),output_sha256=v_msha WHERE env=p_env AND attempt_id=aid;
 UPDATE public.polis_queue_jobs SET state='succeeded',terminal_attempt_id=aid,owner_id=NULL,attempt_id=NULL,locked_until=NULL,
  output_sha256=v_msha,version=version+1,mgmt_version=mgmt_version+1 WHERE env=p_env AND job_id=p_job;
 UPDATE public.polis_queue_runs SET state='succeeded',output_sha256=v_msha WHERE env=p_env AND run_id=p_run;
 UPDATE public.delphi_jobs SET output_manifest_digest=decode(v_msha,'hex') WHERE env=p_env AND job_id=p_job;
 INSERT INTO public.delphi_narrative_jobs(env,job_id,zid,report_id,kind,channel,model,model_known,runner,prompt_version,
  prompt_sha256,pack_id,pack_sha256,export_id,input_digest,result_sha256,inputs,clustering,checks,section_count,submitted_by)
 VALUES(p_env,p_job,v_zid,p_report,v_kind,v_channel,p_sub->>'model',p_sub->>'model_known',p_sub->>'runner',p_sub->>'prompt_version',
  p_sub->>'prompt_sha256',v_pack.pack_id,v_pack.pack_sha256,p_sub->>'export_id',p_sub->>'input_digest',p_sub->>'result_sha256',
  COALESCE(p_sub->'inputs','{}'::jsonb),COALESCE(p_sub->'clustering','{}'::jsonb),COALESCE(p_sub->'checks','{}'::jsonb),
  jsonb_array_length(p_items),v_uid);
 IF NOT public.pd_release_scope(p_env,v_product) THEN RAISE EXCEPTION 'narrative job scope not released'; END IF;
 RETURN jsonb_build_object('outcome','created','job_id',p_job,'run_id',p_run,'artifact_id',v_artifact,
  'created_at',(SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM public.delphi_narrative_jobs WHERE env=p_env AND job_id=p_job),
  'rows',jsonb_array_length(p_items),'results',ref);
END $$;

-- Publication: the owner moves the report's pointer to one job. The job
-- before stays stored and listable; nothing is overwritten.
CREATE FUNCTION public.pd_narrative_publish(p_env text,p_report text,p_job uuid,p_uid integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.delphi_narrative_jobs; cur public.delphi_current; v_scope text; gen bigint;
BEGIN
 IF p_uid IS NULL THEN RAISE EXCEPTION 'invalid narrative publication'; END IF;
 SELECT * INTO j FROM public.delphi_narrative_jobs WHERE env=p_env AND job_id=p_job AND report_id=p_report;
 IF NOT FOUND THEN RAISE EXCEPTION 'narrative job not found'; END IF;
 v_scope=CASE j.kind WHEN 'narrative' THEN 'narrative:'||p_report ELSE 'narrative:'||p_report||':topic_names' END;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:narrative-jobs',p_env,j.zid)::text,0));
 SELECT * INTO cur FROM public.delphi_current WHERE env=p_env AND zid=j.zid AND scope=v_scope FOR UPDATE;
 IF FOUND AND cur.job_id=p_job THEN
  RETURN jsonb_build_object('outcome','unchanged','job_id',p_job,'generation',cur.published_generation,'scope',v_scope);
 END IF;
 gen=COALESCE(cur.published_generation,0)+1;
 INSERT INTO public.delphi_current(env,zid,scope,job_id,requested_generation,published_generation)
 VALUES(p_env,j.zid,v_scope,p_job,gen,gen)
 ON CONFLICT(env,zid,scope) DO UPDATE SET job_id=EXCLUDED.job_id,requested_generation=EXCLUDED.requested_generation,
  published_generation=EXCLUDED.published_generation;
 INSERT INTO public.delphi_narrative_publications(env,zid,scope,generation,job_id,moved_by) VALUES(p_env,j.zid,v_scope,gen,p_job,p_uid);
 RETURN jsonb_build_object('outcome','published','job_id',p_job,'generation',gen,'scope',v_scope,'previous_job_id',cur.job_id);
END $$;

-- One job as a reader sees it: provenance (never the importing account), its
-- checks, its rows, and whether it is the published one.
CREATE FUNCTION public.pd_narrative_job_doc(j public.delphi_narrative_jobs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('job_id',j.job_id,'report_id',j.report_id,'kind',j.kind,'channel',j.channel,
  'model',j.model,'model_known',j.model_known,'runner',j.runner,'prompt_version',j.prompt_version,
  'prompt_sha256',j.prompt_sha256,'pack_id',j.pack_id,'pack_sha256',j.pack_sha256,'export_id',j.export_id,
  'input_digest',j.input_digest,'inputs',j.inputs,'clustering',j.clustering,'checks',j.checks,
  'section_count',j.section_count,
  'created_at',to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'published',EXISTS(SELECT 1 FROM public.delphi_current c WHERE c.env=j.env AND c.zid=j.zid
   AND c.scope=CASE j.kind WHEN 'narrative' THEN 'narrative:'||j.report_id ELSE 'narrative:'||j.report_id||':topic_names' END
   AND c.job_id=j.job_id))
$$;
CREATE FUNCTION public.pd_narrative_jobs_list(p_env text,p_report text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(public.pd_narrative_job_doc(j) ORDER BY j.created_at DESC,j.job_id),'[]'::jsonb)
 FROM public.delphi_narrative_jobs j WHERE j.env=p_env AND j.report_id=p_report
$$;
CREATE FUNCTION public.pd_narrative_job_read(p_env text,p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.pd_narrative_job_doc(j)||jsonb_build_object('rows',public.pd_result_artifact_family(p_env,a.artifact_id,
  CASE j.kind WHEN 'narrative' THEN 'Delphi_NarrativeReports' ELSE 'Delphi_CommentClustersLLMTopicNames' END))
 FROM public.delphi_narrative_jobs j JOIN public.delphi_artifacts a ON a.env=j.env AND a.job_id=j.job_id AND a.output_role='result'
 WHERE j.env=p_env AND j.job_id=p_job
$$;
-- Two jobs side by side: whether they answered the same prompts over the
-- same inputs, and each section's checks.
CREATE FUNCTION public.pd_narrative_compare(p_env text,p_a uuid,p_b uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('a',a.job_id,'b',b.job_id,'a_model',a.model,'b_model',b.model,
  'same_report',a.report_id=b.report_id,'same_kind',a.kind=b.kind,
  'same_prompts',a.pack_sha256 IS NOT DISTINCT FROM b.pack_sha256 AND a.prompt_version=b.prompt_version,
  'same_inputs',a.inputs=b.inputs,
  'sections',COALESCE((SELECT jsonb_agg(jsonb_build_object('section',s.section,'a',sa.value,'b',sb.value) ORDER BY s.section)
   FROM (SELECT x.key AS section FROM jsonb_each(COALESCE(a.checks->'sections','{}'::jsonb)) x
         UNION SELECT y.key FROM jsonb_each(COALESCE(b.checks->'sections','{}'::jsonb)) y) s
   LEFT JOIN jsonb_each(COALESCE(a.checks->'sections','{}'::jsonb)) sa ON sa.key=s.section
   LEFT JOIN jsonb_each(COALESCE(b.checks->'sections','{}'::jsonb)) sb ON sb.key=s.section),'[]'::jsonb))
 FROM public.delphi_narrative_jobs a, public.delphi_narrative_jobs b
 WHERE a.env=p_env AND a.job_id=p_a AND b.env=p_env AND b.job_id=p_b
$$;

REVOKE ALL ON public.delphi_narrative_packs,public.delphi_narrative_jobs,public.delphi_narrative_publications FROM PUBLIC,polis_queue_executor;
REVOKE ALL ON FUNCTION public.pd_narrative_source_state(integer,text),
 public.pd_narrative_pack_put(text,integer,text,jsonb,text),public.pd_narrative_pack_current(text,text),
 public.pd_narrative_job_submit(text,text,uuid,uuid,jsonb,jsonb,jsonb,text),public.pd_narrative_publish(text,text,uuid,integer),
 public.pd_narrative_job_doc(public.delphi_narrative_jobs),public.pd_narrative_jobs_list(text,text),
 public.pd_narrative_job_read(text,uuid),public.pd_narrative_compare(text,uuid,uuid) FROM PUBLIC,polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pd_narrative_source_state(integer,text),
 public.pd_narrative_pack_put(text,integer,text,jsonb,text),public.pd_narrative_pack_current(text,text),
 public.pd_narrative_job_submit(text,text,uuid,uuid,jsonb,jsonb,jsonb,text),public.pd_narrative_publish(text,text,uuid,integer),
 public.pd_narrative_jobs_list(text,text),public.pd_narrative_job_read(text,uuid),public.pd_narrative_compare(text,uuid,uuid)
 TO polis_queue_executor;
COMMIT;
