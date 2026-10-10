-- Catalog postconditions only; this file never replays migration DDL.
SELECT (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid=to_regtype('public.job_status')) = ARRAY['pending','processing','completed','failed']
 AND pg_temp.col_exact('byod_import_jobs','id','integer',true,'nextval(''byod_import_jobs_id_seq''::regclass)')
 AND pg_temp.col_exact('byod_import_jobs','zid','integer',true)
 AND pg_temp.col_exact('byod_import_jobs','s3_key','text',true)
 AND pg_temp.col_exact('byod_import_jobs','status','job_status',false,'''pending''::job_status')
 AND pg_temp.col_exact('byod_import_jobs','stage','text',false,'''init''::text')
 AND pg_temp.col_exact('byod_import_jobs','error_message','text',false)
 AND pg_temp.col_exact('byod_import_jobs','created_at','timestamp with time zone',false,'now()')
 AND pg_temp.col_exact('byod_import_jobs','updated_at','timestamp with time zone',false,'now()')
 AND pg_temp.con_exact('byod_import_jobs','PRIMARY KEY (id)')
 AND pg_temp.idx('idx_byod_jobs_zid','CREATE INDEX idx_byod_jobs_zid ON public.byod_import_jobs USING btree (zid)');
