-- The statements the previous release's adapter issues for the same reads, on
-- the same seeded data under the previous release's migrations. psql -v zid=...
\set ON_ERROR_STOP on
\pset pager off
\echo '== proximity: Delphi_UMAPGraph for the conversation (every row, every conversation expanded)'
EXPLAIN (ANALYZE, BUFFERS) SELECT zid,scope_key,generation::text,item FROM public.delphi_result_current_rows
 WHERE env='bench' AND family='Delphi_UMAPGraph' AND scope_key='delphi' AND (item->'conversation_id'::text = jsonb_build_object('S',:'zid'))
 ORDER BY zid,scope_key,item_key::text;
\echo '== nextComment: one topic key'
EXPLAIN (ANALYZE, BUFFERS) SELECT zid,scope_key,generation::text,item FROM public.delphi_result_current_rows
 WHERE env='bench' AND family='Delphi_CommentClustersLLMTopicNames' AND scope_key='delphi'
 AND (item->'conversation_id'::text = jsonb_build_object('S',:'zid') AND item->'topic_key'::text = '{"S":"absent#0#0"}'::jsonb)
 ORDER BY zid,scope_key,item_key::text;
\echo '== report index (narrative reports by report_id)'
EXPLAIN (ANALYZE, BUFFERS) SELECT zid,scope_key,generation::text,item FROM public.delphi_result_current_rows
 WHERE env='bench' AND family='Delphi_NarrativeReports' AND scope_key='delphi'
 AND (item->'report_id'::text = jsonb_build_object('S','rbench'||lpad((:zid-100000)::text,8,'0')))
 ORDER BY zid,scope_key,item_key::text;
\echo '== job queue (every job and every archive in the environment)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.delphi_result_jobs WHERE env='bench' AND scope_key='delphi';
EXPLAIN (ANALYZE, BUFFERS) SELECT zid,scope_key,generation::text,codec_wire
 FROM public.delphi_result_legacy_controls WHERE env='bench' AND family='Delphi_JobQueue' AND scope_key='delphi' ORDER BY zid,scope_key;
