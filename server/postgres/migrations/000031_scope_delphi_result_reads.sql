-- Conversation-scoped, paged reads of served Delphi results. Additive only:
-- no table, row, writer function or grant from M28-M30 changes meaning.
--
-- 1. delphi_result_current_rows is redefined with the same columns and the same
--    rows. Its bundle walk is written inline instead of through the SECURITY
--    DEFINER function pd_result_bundle_rows, so a filter on zid/family reaches
--    delphi_graph_served and delphi_result_rows instead of expanding every
--    served conversation's bundle first. The view owner already owns every table
--    it reads, so no privilege moves.
-- 2. pd_result_family_batches and pd_result_page resolve one family of the
--    served bundles of given conversations and return its rows in DynamoDB key
--    order, one bounded keyset page at a time.
-- 3. Indexes for that order and for the job reader's text-keyed filters.
--
-- Locks. The runner applies a migration in one transaction and builds indexes
-- CONCURRENTLY only for 000022, so these are plain builds, held until COMMIT:
-- ACCESS EXCLUSIVE on delphi_result_current_rows (view readers wait), SHARE on
-- delphi_result_rows (result writers wait; plain table reads do not) and SHARE
-- on delphi_jobs (job admission and status writes wait). On a generated copy
-- of 1.6 million result rows (1.7 GB) and 10,000 jobs the whole migration took
-- about 2 s, 1.7 s of it the key-order index; the job indexes took
-- milliseconds. With result tables near empty it takes milliseconds. A result
-- read or write transaction left open makes the migration wait lock_timeout
-- (5 s, during which new view readers queue), then fail with 55P03 and roll
-- back with no history row; the deploy can be retried.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;

CREATE OR REPLACE VIEW public.delphi_result_current_rows WITH(security_barrier=true) AS
 SELECT s.env,s.zid,s.scope_key,s.generation,r.family,r.item_key,r.item
 FROM public.delphi_graph_served s CROSS JOIN LATERAL (
  WITH RECURSIVE upstream(id,depth,path) AS (
   SELECT s.artifact_id,0,ARRAY[s.artifact_id] UNION ALL
   SELECT e.artifact_id,u.depth+1,u.path||e.artifact_id FROM upstream u
   JOIN public.delphi_artifacts a ON a.env=s.env AND a.artifact_id=u.id
   JOIN public.delphi_graph_edges e ON e.env=a.env AND e.consumer=a.job_id
   WHERE e.artifact_id IS NOT NULL AND NOT e.artifact_id=ANY(u.path)
  ), chosen AS (
   SELECT DISTINCT ON(f.family) f.family,b.batch_id FROM upstream u
   JOIN public.delphi_result_batches b ON b.env=s.env AND b.artifact_id=u.id
   JOIN public.delphi_result_families f ON f.env=b.env AND f.batch_id=b.batch_id
   ORDER BY f.family,u.depth,u.id
  ) SELECT c.family,x.item_key,x.item FROM chosen c JOIN public.delphi_result_rows x
  ON x.env=s.env AND x.batch_id=c.batch_id AND x.family=c.family
 ) r;

-- The closest batch holding p_family in each selected served bundle; the same
-- choice pd_result_bundle_rows makes for that family. NULL p_zids = every zid.
CREATE FUNCTION public.pd_result_family_batches(p_env text,p_zids integer[],p_scope text,p_family text)
RETURNS TABLE(zid integer,scope_key text,generation bigint,batch_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER ROWS 1 SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 -- Built per call so the served-pointer lookup is planned for these values.
 RETURN QUERY EXECUTE format($q$
  SELECT s.zid,s.scope_key,s.generation,ch.batch_id FROM public.delphi_graph_served s
  CROSS JOIN LATERAL (
   WITH RECURSIVE upstream(id,depth,path) AS (
    SELECT s.artifact_id,0,ARRAY[s.artifact_id] UNION ALL
    SELECT e.artifact_id,u.depth+1,u.path||e.artifact_id FROM upstream u
    JOIN public.delphi_artifacts a ON a.env=s.env AND a.artifact_id=u.id
    JOIN public.delphi_graph_edges e ON e.env=a.env AND e.consumer=a.job_id
    WHERE e.artifact_id IS NOT NULL AND NOT e.artifact_id=ANY(u.path)
   ) SELECT b.batch_id FROM upstream u
   JOIN public.delphi_result_batches b ON b.env=s.env AND b.artifact_id=u.id
   JOIN public.delphi_result_families f ON f.env=b.env AND f.batch_id=b.batch_id AND f.family=$4
   ORDER BY u.depth,u.id LIMIT 1
  ) ch
  WHERE s.env=$1 %s %s$q$,
  CASE WHEN p_zids IS NULL THEN '' ELSE 'AND s.zid=ANY($2)' END,
  CASE WHEN p_scope IS NULL THEN '' ELSE 'AND s.scope_key=$3' END)
 USING p_env,p_zids,p_scope,p_family;
END $$;

-- DynamoDB key order: the range key (or the only key) as a number for N and as
-- UTF-8 bytes for S, then hash key, conversation and scope as tie-breakers.
-- p_after is the previous page's last row {n,t,h,z,s}; rows strictly after it
-- (before it when p_backward) are returned, at most p_limit (NULL: all). With
-- one chosen batch (any configured scope) the read walks this index from the
-- cursor and stops at p_limit rows.
CREATE INDEX delphi_result_rows_key_order ON public.delphi_result_rows(env,batch_id,family,
 (COALESCE((item_key->-1->>'N')::numeric,0)),(COALESCE(item_key->-1->>'S','') COLLATE "C"));
CREATE FUNCTION public.pd_result_page(p_env text,p_zids integer[],p_scope text,p_family text,
 p_hash jsonb,p_sort_eq jsonb,p_sort_prefix text,p_after jsonb,p_backward boolean,p_limit integer)
RETURNS TABLE(zid integer,scope_key text,generation bigint,item_key jsonb,item jsonb,sort_n numeric,sort_t text,hash_t text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 backward boolean=COALESCE(p_backward,false);
 a_n numeric=COALESCE((p_after->>'n')::numeric,CASE WHEN backward THEN 'Infinity'::numeric ELSE '-Infinity'::numeric END);
 a_t text=COALESCE(p_after->>'t','');
 a_h text=COALESCE(p_after->>'h','');
 a_z integer=COALESCE((p_after->>'z')::integer,CASE WHEN backward THEN 2147483647 ELSE -2147483648 END);
 a_s text=COALESCE(p_after->>'s','');
 zids integer[];scopes text[];gens bigint[];batches uuid[];
 sn text=$s$COALESCE((r.item_key->-1->>'N')::numeric,0)$s$;
 st text=$s$COALESCE(r.item_key->-1->>'S','') COLLATE "C"$s$;
 ht text=$s$(r.item_key->0)::text COLLATE "C"$s$;
 cz text;cs text;cg text;source text;
 dir text=CASE WHEN backward THEN ' DESC' ELSE '' END;
 cmp text=CASE WHEN backward THEN '<' ELSE '>' END;
BEGIN
 IF p_limit IS NOT NULL AND p_limit<1 THEN RAISE EXCEPTION 'invalid result page limit'; END IF;
 IF p_after IS NOT NULL AND jsonb_typeof(p_after)<>'object' THEN RAISE EXCEPTION 'invalid result page cursor'; END IF;
 SELECT array_agg(f.zid),array_agg(f.scope_key),array_agg(f.generation),array_agg(f.batch_id)
 INTO zids,scopes,gens,batches FROM public.pd_result_family_batches(p_env,p_zids,p_scope,p_family) f;
 IF batches IS NULL THEN RETURN; END IF;
 IF cardinality(batches)=1 THEN
  cz='$1[1]';cs='$2[1]';cg='$3[1]';
  source='public.delphi_result_rows r WHERE r.env=$5 AND r.batch_id=$4[1] AND r.family=$6';
 ELSE
  cz='c.zid';cs='c.scope_key';cg='c.generation';
  source='unnest($1,$2,$3,$4) c(zid,scope_key,generation,batch_id) JOIN public.delphi_result_rows r'
   ||' ON r.env=$5 AND r.batch_id=c.batch_id AND r.family=$6 WHERE TRUE';
 END IF;
 -- Only the fixed fragments above are interpolated; every value is bound.
 RETURN QUERY EXECUTE format($q$
  SELECT %1$s,%2$s,%3$s,r.item_key,r.item,%4$s,%5$s,%6$s FROM %7$s
  AND ($7::jsonb IS NULL OR r.item_key->0=$7) AND ($8::jsonb IS NULL OR r.item_key->-1=$8)
  AND ($9::text IS NULL OR starts_with(r.item_key->-1->>'S',$9))
  AND ROW(%4$s,%5$s) %8$s= ROW($10::numeric,$11::text COLLATE "C")
  AND ($12 OR ROW(%4$s,%5$s,%6$s,%1$s,%2$s COLLATE "C") %8$s ROW($10::numeric,$11::text COLLATE "C",$13::text COLLATE "C",$14::integer,$15::text COLLATE "C"))
  ORDER BY %4$s%9$s,%5$s%9$s,%6$s%9$s,%1$s%9$s,%2$s COLLATE "C"%9$s LIMIT $16$q$,
  cz,cs,cg,sn,st,ht,source,cmp,dir)
 USING zids,scopes,gens,batches,p_env,p_family,p_hash,p_sort_eq,p_sort_prefix,a_n,a_t,p_after IS NULL,a_h,a_z,a_s,p_limit;
END $$;

-- delphi_result_jobs exposes zid and job_id as text; these let its filters
-- (pushed through the view) use an index instead of reading every job.
CREATE INDEX delphi_jobs_env_zid_text ON public.delphi_jobs(env,(zid::text));
CREATE INDEX delphi_jobs_env_job_text ON public.delphi_jobs(env,(job_id::text));

REVOKE ALL ON FUNCTION public.pd_result_family_batches(text,integer[],text,text),
 public.pd_result_page(text,integer[],text,text,jsonb,jsonb,text,jsonb,boolean,integer) FROM PUBLIC,polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pd_result_family_batches(text,integer[],text,text),
 public.pd_result_page(text,integer[],text,text,jsonb,jsonb,text,jsonb,boolean,integer) TO polis_queue_executor;
COMMIT;
