-- 000041: one read function for the Delphi run record (delphi-run/1).
--
-- pd_run_record(env, job) returns one Delphi job's run record as one jsonb
-- object, or NULL when the job does not exist in that env. It is one SQL
-- statement over the job tables, so every field comes from one snapshot: the
-- queue state, the attempt and the published families cannot disagree with
-- one another the way separate reads taken at different times could.
--
-- It returns the fields the executor role cannot read today:
--   * the job's last attempt (polis_queue_attempts): its number, outcome,
--     started_at, ended_at and error code;
--   * for each result family of the job's published bundle, the batch's
--     content_sha256 and row_count (delphi_result_families), the scope and
--     generation that published it (delphi_graphs, delphi_graph_served,
--     delphi_writer_runs, also for a publication that is no longer served),
--     and whether the served pointer still resolves the family to that batch;
--   * for each artifact that produced one of those batches, its own bundle:
--     the run each family resolves to there (the runs a family's upstream
--     families came from);
--   * pinned, parent_job_id and the job's sealed job graph (graph id, root,
--     and on a root its other nodes with their attempts);
-- and, in the same statement, the fields it can already read (identity,
-- report, kind, origin, queue stage and state, max_attempts, configuration,
-- code version, the finalized manifest's inputs, models and cost, provider
-- requests), so a reader needs this one call.
--
-- A writer run's one-node storage graph (pd_writer_bind) is not reported as a
-- job graph. Families are those the job's own published artifact resolves,
-- with the same walk and the same choice (nearest batch, then artifact id) as
-- pd_result_bundle_rows; a job that published nothing lists none.
--
-- Additive: no table, row, column or existing function changes, and no table
-- grant. The function is owned by polis_queue_owner (the role this migration
-- runs as), SECURITY DEFINER with a pinned search_path, STABLE, and EXECUTE
-- is granted to polis_queue_executor only. It takes no table lock at deploy
-- (CREATE FUNCTION and the two privilege statements write the catalog only),
-- so votes, comments and the next-statement reads never wait on it.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
CREATE FUNCTION public.pd_run_record(p_env text,p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
WITH RECURSIVE
 job AS (SELECT j.* FROM public.delphi_jobs j WHERE j.env=p_env AND j.job_id=p_job),
 queue AS (SELECT q.* FROM public.polis_queue_jobs q WHERE q.env=p_env AND q.job_id=p_job),
 -- A writer run's storage graph is an implementation detail, not a job graph.
 graph AS (
  SELECT n.graph_id,g.root_job_id FROM public.delphi_graph_nodes n
  JOIN public.delphi_graphs g ON g.env=n.env AND g.graph_id=n.graph_id
  WHERE n.env=p_env AND n.job_id=p_job
   AND NOT EXISTS(SELECT 1 FROM public.delphi_writer_runs w WHERE w.env=p_env AND w.job_id=p_job)),
 -- The job, and on a graph root the graph's other nodes.
 members AS (
  SELECT p_job AS job_id
  UNION
  SELECT n.job_id FROM graph g JOIN public.delphi_graph_nodes n ON n.env=p_env AND n.graph_id=g.graph_id
  WHERE g.root_job_id=p_job),
 attempts AS (
  SELECT a.*,row_number() OVER (PARTITION BY a.job_id ORDER BY a.lease_epoch) AS number
  FROM public.polis_queue_attempts a WHERE a.env=p_env AND a.job_id IN (SELECT job_id FROM members)),
 -- The current attempt of a running job, else the last one.
 last_attempt AS (
  SELECT DISTINCT ON (a.job_id) a.job_id,jsonb_build_object('attempt_id',a.attempt_id,'number',a.number,
   'lease_epoch',a.lease_epoch,'outcome',a.outcome,
   'started_at',to_char(a.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
   'ended_at',to_char(a.ended_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
   'process_exit_confirmed_at',to_char(a.process_exit_confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
   'error_code',a.error_code) AS doc
  FROM attempts a ORDER BY a.job_id,a.lease_epoch DESC),
 -- The finalized manifest row: the one whose sha256 the queue recorded.
 manifest AS (
  SELECT l.line::jsonb AS m FROM job j JOIN queue q ON true
  JOIN public.polis_queue_logs l ON l.env=p_env AND l.attempt_id=q.terminal_attempt_id AND l.stream='manifest'
  WHERE j.output_manifest_digest IS NOT NULL AND sha256(convert_to(l.line,'UTF8'))=j.output_manifest_digest
  ORDER BY l.seq DESC LIMIT 1),
 -- The job's published bundle, walked as pd_result_bundle_rows walks it.
 walk(id,depth,path) AS (
  SELECT a.artifact_id,0,ARRAY[a.artifact_id] FROM public.delphi_artifacts a
  WHERE a.env=p_env AND a.job_id=p_job AND a.output_role='result'
  UNION ALL
  SELECT e.artifact_id,w.depth+1,w.path||e.artifact_id FROM walk w
  JOIN public.delphi_artifacts a ON a.env=p_env AND a.artifact_id=w.id
  JOIN public.delphi_graph_edges e ON e.env=a.env AND e.consumer=a.job_id
  WHERE e.artifact_id IS NOT NULL AND NOT e.artifact_id=ANY(w.path)),
 chosen AS (
  SELECT DISTINCT ON (f.family) f.family,b.batch_id,b.job_id,b.artifact_id,f.content_sha,f.row_count
  FROM walk w JOIN public.delphi_result_batches b ON b.env=p_env AND b.artifact_id=w.id
  JOIN public.delphi_result_families f ON f.env=b.env AND f.batch_id=b.batch_id
  ORDER BY f.family,w.depth,w.id),
 -- Each chosen batch's own producing artifact's bundle: the runs its
 -- upstream families came from.
 pwalk(origin,id,depth,path) AS (
  SELECT DISTINCT c.artifact_id,c.artifact_id,0,ARRAY[c.artifact_id] FROM chosen c
  UNION ALL
  SELECT w.origin,e.artifact_id,w.depth+1,w.path||e.artifact_id FROM pwalk w
  JOIN public.delphi_artifacts a ON a.env=p_env AND a.artifact_id=w.id
  JOIN public.delphi_graph_edges e ON e.env=a.env AND e.consumer=a.job_id
  WHERE e.artifact_id IS NOT NULL AND NOT e.artifact_id=ANY(w.path)),
 presolved AS (
  SELECT DISTINCT ON (w.origin,f.family) w.origin,f.family,b.job_id
  FROM pwalk w JOIN public.delphi_result_batches b ON b.env=p_env AND b.artifact_id=w.id
  JOIN public.delphi_result_families f ON f.env=b.env AND f.batch_id=b.batch_id
  ORDER BY w.origin,f.family,w.depth,w.id),
 -- The publication of each chosen batch: its graph's scope and the artifact
 -- that published it (a graph's narrative node, else the batch's own).
 pub AS (
  SELECT c.batch_id,g.scope_key,COALESCE((SELECT a2.artifact_id FROM public.delphi_graph_nodes n2
    JOIN public.polis_queue_jobs q2 ON q2.env=n2.env AND q2.job_id=n2.job_id
    JOIN public.delphi_artifacts a2 ON a2.env=n2.env AND a2.job_id=n2.job_id AND a2.output_role='result'
    WHERE n2.env=p_env AND n2.graph_id=n.graph_id AND q2.stage='graph_narrative' ORDER BY n2.node_key LIMIT 1),c.artifact_id) AS publisher
  FROM (SELECT DISTINCT batch_id,job_id,artifact_id FROM chosen) c
  JOIN public.delphi_graph_nodes n ON n.env=p_env AND n.job_id=c.job_id
  JOIN public.delphi_graphs g ON g.env=n.env AND g.graph_id=n.graph_id),
 -- The generation that published it: a writer run's own (base + 1), else
 -- the served pointer's while it still points at it, else the base a later
 -- writer run recorded when it was admitted over it.
 publication AS (
  SELECT p.batch_id,p.scope_key,COALESCE(
   (SELECT w.base_generation+1 FROM public.delphi_artifacts a JOIN public.delphi_writer_runs w ON w.env=a.env AND w.job_id=a.job_id
    WHERE a.env=p_env AND a.artifact_id=p.publisher AND w.scope_key=p.scope_key),
   (SELECT s.generation FROM job j JOIN public.delphi_graph_served s ON s.env=j.env AND s.zid=j.zid AND s.scope_key=p.scope_key
    WHERE s.artifact_id=p.publisher),
   (SELECT min(w.base_generation) FROM public.delphi_writer_runs w
    WHERE w.env=p_env AND w.base_artifact=p.publisher AND w.scope_key=p.scope_key)) AS generation
  FROM pub p),
 -- What each scope's served pointer resolves every family to now.
 swalk(scope,id,depth,path) AS (
  SELECT s.scope_key,s.artifact_id,0,ARRAY[s.artifact_id] FROM job j
  JOIN public.delphi_graph_served s ON s.env=j.env AND s.zid=j.zid
  WHERE s.scope_key IN (SELECT scope_key FROM pub)
  UNION ALL
  SELECT w.scope,e.artifact_id,w.depth+1,w.path||e.artifact_id FROM swalk w
  JOIN public.delphi_artifacts a ON a.env=p_env AND a.artifact_id=w.id
  JOIN public.delphi_graph_edges e ON e.env=a.env AND e.consumer=a.job_id
  WHERE e.artifact_id IS NOT NULL AND NOT e.artifact_id=ANY(w.path)),
 sresolved AS (
  SELECT DISTINCT ON (w.scope,f.family) w.scope,f.family,b.batch_id
  FROM swalk w JOIN public.delphi_result_batches b ON b.env=p_env AND b.artifact_id=w.id
  JOIN public.delphi_result_families f ON f.env=b.env AND f.batch_id=b.batch_id
  ORDER BY w.scope,f.family,w.depth,w.id)
SELECT jsonb_build_object(
 'job_id',j.job_id,'zid',j.zid,'report_id',j.report_id,'origin',j.origin,'kind',j.kind,
 'run_id',j.run_id,'parent_job_id',j.parent_job_id,'status',j.status,'pinned',j.pinned,
 'created_at',to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
 'completed_at',to_char(j.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
 'config_effective',j.config_effective,'code_version',j.code_version,
 'manifest_sha256',encode(j.output_manifest_digest,'hex'),
 'stage',q.stage,'state',q.state,'max_attempts',q.max_attempts,'last_error_code',q.last_error_code,
 'attempt',(SELECT la.doc FROM last_attempt la WHERE la.job_id=p_job),
 'graph',(SELECT jsonb_build_object('graph_id',g.graph_id,'root_job_id',g.root_job_id) FROM graph g),
 'nodes',COALESCE((SELECT jsonb_agg(jsonb_build_object('job_id',n.job_id,'run_id',n.run_id,'stage',nq.stage,
   'state',nq.state,'max_attempts',nq.max_attempts,'attempt',(SELECT la.doc FROM last_attempt la WHERE la.job_id=n.job_id))
   ORDER BY n.node_key)
  FROM graph g JOIN public.delphi_graph_nodes n ON n.env=p_env AND n.graph_id=g.graph_id
  JOIN public.polis_queue_jobs nq ON nq.env=n.env AND nq.job_id=n.job_id
  WHERE g.root_job_id=p_job AND n.job_id<>p_job),'[]'::jsonb),
 'manifest',(SELECT jsonb_build_object('inputs',m.m->'inputs','models',m.m->'models','cost',m.m->'cost') FROM manifest m
  WHERE m.m->>'schema' IN ('polis-jobs.output-manifest/1','polis-jobs.output-manifest/2')),
 'provider_requests',COALESCE((SELECT jsonb_agg(jsonb_build_object('request_id',p.request_id,'provider',p.provider,
   'batch_id',p.provider_batch_id,'state',p.state) ORDER BY p.created_at,p.request_id)
  FROM public.delphi_provider_requests p WHERE p.env=p_env AND p.job_id=p_job),'[]'::jsonb),
 'families',COALESCE((SELECT jsonb_agg(jsonb_build_object('family',c.family,'batch_id',c.batch_id,
   'job_id',c.job_id,'run_id',pj.run_id,'origin',pj.origin,'content_sha256',c.content_sha,'row_count',c.row_count,
   'scope',pb.scope_key,'generation',pb.generation,
   'served',EXISTS(SELECT 1 FROM sresolved s WHERE s.scope=pb.scope_key AND s.family=c.family AND s.batch_id=c.batch_id),
   'artifact_id',c.artifact_id)
   ORDER BY c.family)
  FROM chosen c JOIN public.delphi_jobs pj ON pj.env=p_env AND pj.job_id=c.job_id
  LEFT JOIN publication pb ON pb.batch_id=c.batch_id),'[]'::jsonb),
 'bundles',COALESCE((SELECT jsonb_object_agg(b.origin,b.families) FROM (
   SELECT r.origin,jsonb_object_agg(r.family,jsonb_build_object('job_id',r.job_id,'run_id',rj.run_id)) AS families
   FROM presolved r JOIN public.delphi_jobs rj ON rj.env=p_env AND rj.job_id=r.job_id GROUP BY r.origin) b),'{}'::jsonb))
FROM job j LEFT JOIN queue q ON true
$$;
REVOKE ALL ON FUNCTION public.pd_run_record(text,uuid) FROM PUBLIC,polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pd_run_record(text,uuid) TO polis_queue_executor;
COMMIT;
