-- Production-sized served Delphi results for read-cost measurement. Generated
-- data only, in environment 'bench', scope 'delphi'. Run as a superuser on a
-- migrated, otherwise empty database: graph scaffolding is written directly
-- with triggers and foreign keys off, as a published queue run leaves it.
--
-- 2,500 conversations; comments per conversation 10,000 * rank^-0.85 (at least
-- 10), about 150,000 comments in all; the largest has 10,000. Per comment:
-- an embedding (32 dimensions here; production uses 384, so production rows
-- are larger), a cluster assignment, an extremity value, a UMAP node and six
-- UMAP edges. Per conversation also topic names, cluster keywords, narrative
-- reports, collective statements, cached narratives and four queue jobs.
-- Every tenth conversation has a second, edit-like generation; the largest has
-- a chain of 20 such generations.
\set ON_ERROR_STOP on
SET session_replication_role = replica;
SELECT setseed(0.4242);
BEGIN;
CREATE TEMP TABLE bench_conv AS
 SELECT 100000+r AS zid, r, greatest(10, round(10000*power(r,-0.85)))::int AS comments,
  'rbench'||lpad(r::text,8,'0') AS report_id
 FROM generate_series(1,2500) r;
INSERT INTO users(uid,hname,email) SELECT zid,'bench owner','bench-'||zid||'@example.invalid' FROM bench_conv ON CONFLICT DO NOTHING;
INSERT INTO conversations(zid,owner,topic) SELECT zid,zid,'bench' FROM bench_conv ON CONFLICT DO NOTHING;
INSERT INTO reports(report_id,zid) SELECT report_id,zid FROM bench_conv;
CREATE TEMP TABLE bench_gen AS
 SELECT c.zid, c.report_id, g AS generation, gen_random_uuid() AS job_id, gen_random_uuid() AS run_id,
  gen_random_uuid() AS batch_id, gen_random_uuid() AS artifact_id, gen_random_uuid() AS graph_id
 FROM bench_conv c CROSS JOIN LATERAL generate_series(1, CASE WHEN c.r=1 THEN 20 WHEN c.r%10=0 THEN 2 ELSE 1 END) g;
INSERT INTO delphi_graphs(env,graph_id,zid,scope_key,request_key,request,root_job_id,sealed)
 SELECT 'bench',graph_id,zid,'delphi',job_id::text,'{}',job_id,true FROM bench_gen;
INSERT INTO delphi_graph_nodes(env,zid,graph_id,job_id,run_id,node_key,declared)
 SELECT 'bench',zid,graph_id,job_id,run_id,'bench','{}' FROM bench_gen;
INSERT INTO delphi_artifacts(env,artifact_id,job_id,run_id,attempt_id,output_role,schema_version,payload,content_sha,byte_count)
 SELECT 'bench',artifact_id,job_id,run_id,batch_id,'result','bench/1','{}',encode(sha256('{}'),'hex'),2 FROM bench_gen;
INSERT INTO delphi_result_batches(env,batch_id,job_id,run_id,sealed_sha,artifact_id)
 SELECT 'bench',batch_id,job_id,run_id,repeat('0',64),artifact_id FROM bench_gen;
INSERT INTO delphi_graph_edges(env,consumer,producer,input_role,expected_sha,artifact_id)
 SELECT 'bench',n.job_id,p.job_id,'previous',encode(sha256('{}'),'hex'),p.artifact_id
 FROM bench_gen n JOIN bench_gen p ON p.zid=n.zid AND p.generation=n.generation-1;
INSERT INTO delphi_graph_served(env,zid,scope_key,generation,artifact_id)
 SELECT DISTINCT ON(zid) 'bench',zid,'delphi',generation,artifact_id FROM bench_gen ORDER BY zid,generation DESC;

-- Rows. First generation: every family. Later generations: the two narrative
-- families, as report edits and narrative runs write them.
CREATE TEMP TABLE bench_rows(batch_id uuid, family text, item jsonb, key_names text[]);
INSERT INTO bench_rows
 SELECT g.batch_id,'Delphi_CommentEmbeddings',jsonb_build_object('conversation_id',jsonb_build_object('S',c.zid::text),
  'comment_id',jsonb_build_object('N',t::text),'embedding',jsonb_build_object('M',jsonb_build_object(
  'vector',jsonb_build_object('L',(SELECT jsonb_agg(jsonb_build_object('N',round((random()*2-1)::numeric,6)::text)) FROM generate_series(1,32+0*t))),
  'dimensions',jsonb_build_object('N','384'),'model',jsonb_build_object('S','bench-embedding-model')))),
  ARRAY['conversation_id','comment_id']
 FROM bench_conv c JOIN bench_gen g ON g.zid=c.zid AND g.generation=1 CROSS JOIN LATERAL generate_series(0,c.comments-1) t;
INSERT INTO bench_rows
 SELECT g.batch_id,'Delphi_CommentHierarchicalClusterAssignments',jsonb_build_object('conversation_id',jsonb_build_object('S',c.zid::text),
  'comment_id',jsonb_build_object('N',t::text),'is_outlier',jsonb_build_object('BOOL',t%17=0),
  'layer0_cluster_id',jsonb_build_object('N',(t%9)::text),'layer1_cluster_id',jsonb_build_object('N',(t%4)::text),
  'distance_to_centroid',jsonb_build_object('M',jsonb_build_object('0',jsonb_build_object('N',round(random()::numeric,5)::text))),
  'cluster_confidence',jsonb_build_object('M',jsonb_build_object('0',jsonb_build_object('N','0.95')))),
  ARRAY['conversation_id','comment_id']
 FROM bench_conv c JOIN bench_gen g ON g.zid=c.zid AND g.generation=1 CROSS JOIN LATERAL generate_series(0,c.comments-1) t;
INSERT INTO bench_rows
 SELECT g.batch_id,'Delphi_CommentExtremity',jsonb_build_object('conversation_id',jsonb_build_object('S',c.zid::text),
  'comment_id',jsonb_build_object('S',t::text),'extremity_value',jsonb_build_object('N',round(random()::numeric,5)::text),
  'calculation_method',jsonb_build_object('S','pca_based')),
  ARRAY['conversation_id','comment_id']
 FROM bench_conv c JOIN bench_gen g ON g.zid=c.zid AND g.generation=1 CROSS JOIN LATERAL generate_series(0,c.comments-1) t;
INSERT INTO bench_rows
 SELECT g.batch_id,'Delphi_UMAPGraph',jsonb_build_object('conversation_id',jsonb_build_object('S',c.zid::text),
  'edge_id',jsonb_build_object('S',t||'_'||u),'source_id',jsonb_build_object('N',t::text),'target_id',jsonb_build_object('N',u::text),
  'weight',jsonb_build_object('N',CASE WHEN t=u THEN '1' ELSE round(random()::numeric,5)::text END),
  'distance',jsonb_build_object('N',CASE WHEN t=u THEN '0' ELSE round(random()::numeric,5)::text END),
  'is_nearest_neighbor',jsonb_build_object('BOOL',u<=t+1),'shared_cluster_layers',jsonb_build_object('L','[]'::jsonb))
  || CASE WHEN t=u THEN jsonb_build_object('position',jsonb_build_object('M',jsonb_build_object(
   'x',jsonb_build_object('N',round((random()*20-10)::numeric,5)::text),'y',jsonb_build_object('N',round((random()*20-10)::numeric,5)::text)))) ELSE '{}' END,
  ARRAY['conversation_id','edge_id']
 FROM bench_conv c JOIN bench_gen g ON g.zid=c.zid AND g.generation=1 CROSS JOIN LATERAL generate_series(0,c.comments-1) t
 CROSS JOIN LATERAL generate_series(t, least(c.comments-1,t+6)) u;
INSERT INTO bench_rows
 SELECT g.batch_id,'Delphi_CommentClustersLLMTopicNames',jsonb_build_object('conversation_id',jsonb_build_object('S',c.zid::text),
  'topic_key',jsonb_build_object('S',g.job_id||'#'||(k%3)||'#'||k),'layer_id',jsonb_build_object('N',(k%3)::text),
  'cluster_id',jsonb_build_object('N',k::text),'topic_name',jsonb_build_object('S','Bench topic '||k),
  'model_name',jsonb_build_object('S','bench-model'),'created_at',jsonb_build_object('S','2026-01-01T00:00:00.000000'),
  'job_id',jsonb_build_object('S',g.job_id::text)),
  ARRAY['conversation_id','topic_key']
 FROM bench_conv c JOIN bench_gen g ON g.zid=c.zid AND g.generation=1 CROSS JOIN LATERAL generate_series(0,10+c.comments/20) k;
INSERT INTO bench_rows
 SELECT g.batch_id,'Delphi_CommentClustersStructureKeywords',jsonb_build_object('conversation_id',jsonb_build_object('S',c.zid::text),
  'cluster_key',jsonb_build_object('S','layer'||(k%3)||'_'||k),'layer_id',jsonb_build_object('N',(k%3)::text),
  'cluster_id',jsonb_build_object('N',k::text),'topic_label',jsonb_build_object('S','Bench label '||k),
  'sample_comments',jsonb_build_object('L',jsonb_build_array(jsonb_build_object('S',repeat('bench sample ',12)),jsonb_build_object('S',repeat('bench sample ',12)))),
  'top_words',jsonb_build_object('L',jsonb_build_array(jsonb_build_object('S','alpha'),jsonb_build_object('S','beta')))),
  ARRAY['conversation_id','cluster_key']
 FROM bench_conv c JOIN bench_gen g ON g.zid=c.zid AND g.generation=1 CROSS JOIN LATERAL generate_series(0,10+c.comments/20) k;
INSERT INTO bench_rows
 SELECT g.batch_id,'Delphi_NarrativeReports',jsonb_build_object('rid_section_model',jsonb_build_object('S',c.report_id||'#topic_'||k||'#bench-model'),
  'timestamp',jsonb_build_object('S','2026-02-0'||(1+g.generation%9)||'T00:00:'||lpad(k::text,2,'0')||'.000000'),
  'report_id',jsonb_build_object('S',c.report_id),'section',jsonb_build_object('S','topic_'||k),
  'model',jsonb_build_object('S','bench-model'),'report_data',jsonb_build_object('S',repeat('Bench narrative paragraph. ',60))),
  ARRAY['rid_section_model','timestamp']
 FROM bench_conv c JOIN bench_gen g ON g.zid=c.zid CROSS JOIN LATERAL generate_series(0,11) k;
INSERT INTO bench_rows
 SELECT g.batch_id,'Delphi_CollectiveStatement',jsonb_build_object('zid_topic_jobid',jsonb_build_object('S',c.zid||'#'||g.job_id||'#0#'||k),
  'zid',jsonb_build_object('S',c.zid::text),'topic_key',jsonb_build_object('S',g.job_id||'#0#'||k),
  'statement_data',jsonb_build_object('S',repeat('{"paragraphs":[]}',20)),'created_at',jsonb_build_object('S','2026-03-01T00:00:0'||k||'.000Z')),
  ARRAY['zid_topic_jobid']
 FROM bench_conv c JOIN bench_gen g ON g.zid=c.zid AND g.generation=1 CROSS JOIN LATERAL generate_series(0,2) k;
INSERT INTO bench_rows
 SELECT g.batch_id,'report_narrative_store',jsonb_build_object('rid_section_model',jsonb_build_object('S',c.report_id||'#section_'||k||'#openai'),
  'timestamp',jsonb_build_object('S','2026-04-01T00:00:0'||(g.generation%10)||'.000Z'),'report_id',jsonb_build_object('S',c.report_id),
  'report_data',jsonb_build_object('S',repeat('Bench cached narrative. ',60))),
  ARRAY['rid_section_model','timestamp']
 FROM bench_conv c JOIN bench_gen g ON g.zid=c.zid CROSS JOIN LATERAL generate_series(0,5) k;

INSERT INTO delphi_result_families(env,batch_id,family,codec_wire,content_sha,row_count)
 SELECT 'bench',batch_id,family,'bench'||chr(10),encode(sha256(convert_to('bench'||chr(10),'UTF8')),'hex'),count(*)
 FROM bench_rows GROUP BY batch_id,family;
INSERT INTO delphi_result_rows(env,batch_id,family,item_key,ordinal,item)
 SELECT 'bench',batch_id,family,(SELECT jsonb_agg(item->k ORDER BY o) FROM unnest(key_names) WITH ORDINALITY u(k,o)),
  row_number() OVER (PARTITION BY batch_id,family ORDER BY item::text),item
 FROM bench_rows;

-- Queue jobs: one per published generation (each bound to its scoped graph)
-- plus three earlier runs per conversation.
INSERT INTO delphi_jobs(job_id,env,zid,report_id,kind,origin,status,config_effective,created_at,completed_at)
 SELECT job_id,'bench',zid,report_id,'full_pipeline','queued','succeeded',
  jsonb_build_object('model','bench-model','note',repeat('x',200)),now()-make_interval(mins=>100-generation),now()-make_interval(mins=>95-generation)
 FROM bench_gen;
INSERT INTO delphi_jobs(job_id,env,zid,report_id,kind,origin,status,config_effective,created_at,completed_at)
 SELECT gen_random_uuid(),'bench',c.zid,c.report_id,'full_pipeline','queued','dead',
  jsonb_build_object('model','bench-model','note',repeat('x',200)),now()-make_interval(days=>j),now()-make_interval(days=>j)+interval '5 minutes'
 FROM bench_conv c CROSS JOIN generate_series(1,3) j;
COMMIT;
SET session_replication_role = origin;
ANALYZE;
SELECT (SELECT count(*) FROM delphi_graph_served WHERE env='bench') AS served_conversations,
 (SELECT count(*) FROM delphi_result_rows WHERE env='bench') AS result_rows,
 (SELECT pg_size_pretty(pg_total_relation_size('delphi_result_rows'))) AS rows_table_size,
 (SELECT count(*) FROM delphi_jobs WHERE env='bench') AS jobs,
 (SELECT max(comments) FROM bench_conv) AS largest_comments,
 (SELECT sum(comments) FROM bench_conv) AS all_comments;
