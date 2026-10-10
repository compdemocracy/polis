-- Empty draft reversal only. Runner history is never edited here.
BEGIN;
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
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


DO $$ DECLARE r record; baseline jsonb; BEGIN
 LOCK TABLE public.delphi_graphs IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM public.delphi_graphs)
 THEN RAISE EXCEPTION 'nonempty graph contract: retain schema and use compatible workers'; END IF;
 SELECT i.baseline||'{}'::jsonb INTO STRICT baseline FROM public.delphi_graph_install i;
 -- Drop only draft objects. Restore original function definitions and ACLs below.
 DROP TRIGGER graph_parent_guard ON public.delphi_jobs;
 DROP TABLE public.delphi_graph_served,public.delphi_graph_edges,public.delphi_artifacts,
 public.delphi_graph_nodes,public.delphi_graphs,public.delphi_graph_install CASCADE;
 FOR r IN SELECT oid::regprocedure AS name FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'pd_graph_%' LOOP
  EXECUTE format('DROP FUNCTION %s CASCADE',r.name);
 END LOOP;
 ALTER TABLE public.polis_queue_install DROP CONSTRAINT polis_queue_install_contract_version_check;
 UPDATE public.polis_queue_install SET contract_version='polis-queue/3';
 ALTER TABLE public.polis_queue_install ADD CONSTRAINT polis_queue_install_contract_version_check CHECK(contract_version='polis-queue/3');
 ALTER TABLE public.polis_queue_install ALTER COLUMN contract_version SET DEFAULT 'polis-queue/3';
 ALTER TABLE public.polis_queue_runs DROP CONSTRAINT polis_queue_runs_contract_version_check;
 ALTER TABLE public.polis_queue_runs ADD CONSTRAINT polis_queue_runs_contract_version_check CHECK(contract_version IN ('polis-queue/1','polis-queue/2','polis-queue/3'));
 ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
 ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_stage_check CHECK(stage IN ('noop','delphi_full_pipeline','delphi_narrative','math_rebuild'));
 ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT pq_stage_large;
 ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT pq_stage_large CHECK((stage='math_rebuild')=(worker_class='large'));
 FOR r IN SELECT key,value FROM jsonb_each(baseline->'functions') LOOP
  EXECUTE r.value->>0;
 END LOOP;
 IF baseline IS DISTINCT FROM pg_temp.pq3_state() THEN RAISE EXCEPTION 'graph down did not restore exact /3 catalog'; END IF;
END $$;
COMMIT;
