-- The statements this release's adapter issues, with plans of the statements
-- inside pd_result_page (auto_explain), on the seeded database. psql -v zid=...
\set ON_ERROR_STOP on
\pset pager off
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_analyze = on;
SET auto_explain.log_buffers = on;
SET auto_explain.log_nested_statements = on;
SET auto_explain.log_format = 'text';
SET client_min_messages = log;
\echo '== proximity: Delphi_UMAPGraph, first 500-row keyset chunk of the conversation'
EXPLAIN (ANALYZE, BUFFERS) SELECT zid,scope_key,item_key,item,sort_n::text,sort_t,hash_t
 FROM public.pd_result_page('bench',ARRAY[:zid]::integer[],'delphi','Delphi_UMAPGraph',jsonb_build_object('S',:'zid'),NULL,NULL,NULL::jsonb,false,500);
\echo '== cursor check / LastEvaluatedKey: publication generations of the conversation'
EXPLAIN (ANALYZE, BUFFERS) SELECT zid,scope_key,generation::text
 FROM public.pd_result_family_batches('bench',ARRAY[:zid]::integer[],'delphi','Delphi_UMAPGraph') ORDER BY zid,scope_key;
\echo '== nextComment: one topic key'
EXPLAIN (ANALYZE, BUFFERS) SELECT zid,scope_key,item_key,item,sort_n::text,sort_t,hash_t
 FROM public.pd_result_page('bench',ARRAY[:zid]::integer[],'delphi','Delphi_CommentClustersLLMTopicNames',jsonb_build_object('S',:'zid'),'{"S":"absent#0#0"}',NULL,NULL::jsonb,false,500);
\echo '== report index (narrative reports by report_id): the conversation of the report'
EXPLAIN (ANALYZE, BUFFERS) SELECT zid,scope_key,item_key,item,sort_n::text,sort_t,hash_t
 FROM public.pd_result_page('bench',ARRAY(SELECT zid FROM public.reports WHERE report_id='rbench'||lpad((:zid-100000)::text,8,'0')),'delphi','Delphi_NarrativeReports',NULL,NULL,NULL,NULL,false,NULL);
\echo '== job queue by conversation'
EXPLAIN (ANALYZE, BUFFERS) SELECT job_id,conversation_id,report_id,status,job_type,job_config,created_at,completed_at,error,env,scope_key
 FROM public.delphi_result_jobs WHERE env='bench' AND scope_key='delphi' AND conversation_id=:'zid';
EXPLAIN (ANALYZE, BUFFERS) SELECT zid,scope_key,generation::text,codec_wire
 FROM public.delphi_result_legacy_controls WHERE env='bench' AND family='Delphi_JobQueue' AND scope_key='delphi' AND zid=:zid ORDER BY zid,scope_key;
\echo '== the replacement view filtered by conversation and family (pd_result_mutate, DescribeTable)'
EXPLAIN (ANALYZE, BUFFERS) SELECT item FROM public.delphi_result_current_rows
 WHERE env='bench' AND scope_key='delphi' AND family='report_narrative_store' AND zid=:zid;
