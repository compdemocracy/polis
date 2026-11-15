-- down/000046_drop_delphi_narrative_jobs.sql
--
-- Reverses 000046_create_delphi_narrative_jobs.sql: drops its three tables and
-- ten functions and restores pd_queue_binding exactly as 000027 defines it.
-- Nothing else that existed before 000046 is touched.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000046_drop_delphi_narrative_jobs.sql
--
-- Refuses, changing nothing, while any narrative job, prompt pack or
-- publication is stored: an unwanted narrative is unpublished by moving the
-- pointer, never by a drop. Runner history is not edited here; the operator
-- removes the 000046 history row in the same sitting, after this succeeds.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
-- Hold the tables before checking, so a submission still in flight either
-- commits first (and the check sees it) or waits and then fails.
LOCK TABLE public.delphi_narrative_packs,public.delphi_narrative_jobs,public.delphi_narrative_publications IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.delphi_narrative_jobs) OR EXISTS(SELECT 1 FROM public.delphi_narrative_packs)
 OR EXISTS(SELECT 1 FROM public.delphi_narrative_publications) THEN
  RAISE EXCEPTION 'narrative jobs are stored; unpublish by pointer, not by drop';
 END IF;
END $$;
DROP FUNCTION public.pd_narrative_compare(text,uuid,uuid),public.pd_narrative_job_read(text,uuid),
 public.pd_narrative_jobs_list(text,text),public.pd_narrative_job_doc(public.delphi_narrative_jobs),
 public.pd_narrative_publish(text,text,uuid,integer),public.pd_narrative_job_submit(text,text,uuid,uuid,jsonb,jsonb,jsonb,text),
 public.pd_narrative_pack_current(text,text),public.pd_narrative_pack_put(text,integer,text,jsonb,text),
 public.pd_narrative_source_state(integer,text);
DROP TABLE public.delphi_narrative_publications,public.delphi_narrative_jobs,public.delphi_narrative_packs;
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
COMMIT;
