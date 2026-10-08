-- 000024_drop_polis_queue_large_class.sql
--
-- Reversal of 000024 (the large worker class, polis-queue/3). Stop every
-- writer first (the polis-jobs daemon of either class; the poller's enqueue
-- path, if it is on). In one transaction it locks every polis_queue_* and
-- delphi_* table ACCESS EXCLUSIVE, verifies the installed catalog is exactly
-- what 000024 recorded, refuses if any /3 row exists (a math_rebuild or
-- class-large queue job, a math_rebuild delphi_jobs row, a /3 run) - there is
-- no force override - and then drops pq_class_depth, restores every /2
-- function from the recorded baseline, restores the /2 CHECK constraints and
-- the /2 contract version, and checks the result against the baseline.
--
-- Run it the same way as the up script:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
--     < server/postgres/migrations/down/000024_drop_polis_queue_large_class.sql
--
-- A database without 000024 has no polis_queue_large_class_install table, so
-- the script fails before changing anything. After it, 000023's own down
-- script applies as if 000024 had never been applied. Proven by
-- test_000024_down.sh.
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
CREATE OR REPLACE FUNCTION pg_temp.pq3_state() RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $s$
SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,pg_temp.pq_catalog(c.oid)) FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (starts_with(c.relname,'polis_queue_') OR starts_with(c.relname,'delphi_'))
 AND c.relname NOT IN ('delphi_foundation_install','polis_queue_large_class_install')),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_functiondef(p.oid),p.proacl::text,pg_get_userbyid(p.proowner)))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (starts_with(p.proname,'pq_') OR starts_with(p.proname,'pd_'))))
$s$;
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT oid::regclass name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'
 AND (starts_with(relname,'delphi_') OR starts_with(relname,'polis_queue_')) ORDER BY relname LOOP
  EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',t.name);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.polis_queue_large_class_install WHERE installed=pg_temp.pq3_state()) THEN RAISE EXCEPTION 'large class catalog drift'; END IF;
 IF EXISTS(SELECT 1 FROM public.polis_queue_jobs WHERE stage='math_rebuild' OR worker_class='large')
 OR EXISTS(SELECT 1 FROM public.delphi_jobs WHERE kind='math_rebuild')
 OR EXISTS(SELECT 1 FROM public.polis_queue_runs WHERE contract_version='polis-queue/3') THEN RAISE EXCEPTION 'refusing reversal: /3 data'; END IF;
END $$;
DO $$ DECLARE f record; baseline jsonb; BEGIN
 SELECT i.baseline->'functions' INTO baseline FROM public.polis_queue_large_class_install i;
 FOR f IN SELECT oid::regprocedure name FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND (starts_with(proname,'pd_') OR starts_with(proname,'pq_')) LOOP
  IF NOT baseline ? f.name::text THEN EXECUTE format('DROP FUNCTION %s',f.name); END IF;
 END LOOP;
 FOR f IN SELECT value FROM jsonb_each(baseline) LOOP
  EXECUTE f.value->>0;
 END LOOP;
END $$;
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT pq_stage_large;
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_worker_class_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_worker_class_check CHECK(worker_class IN ('noop','delphi'));
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_stage_check CHECK(stage IN ('noop','delphi_full_pipeline','delphi_narrative'));
ALTER TABLE public.delphi_jobs DROP CONSTRAINT delphi_jobs_kind_check;
ALTER TABLE public.delphi_jobs ADD CONSTRAINT delphi_jobs_kind_check CHECK(kind IN ('full_pipeline','embed','snapshot','umap','cluster','keywords',
 'topic_name','narrative','collective_statement','visualize','legacy_import','legacy_queue_record'));
ALTER TABLE public.polis_queue_runs DROP CONSTRAINT polis_queue_runs_contract_version_check;
ALTER TABLE public.polis_queue_runs ADD CONSTRAINT polis_queue_runs_contract_version_check CHECK(contract_version IN ('polis-queue/1','polis-queue/2'));
ALTER TABLE public.polis_queue_install DROP CONSTRAINT polis_queue_install_contract_version_check;
UPDATE public.polis_queue_install SET contract_version='polis-queue/2';
ALTER TABLE public.polis_queue_install ADD CONSTRAINT polis_queue_install_contract_version_check CHECK(contract_version='polis-queue/2');
ALTER TABLE public.polis_queue_install ALTER COLUMN contract_version SET DEFAULT 'polis-queue/2';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.polis_queue_large_class_install WHERE baseline=pg_temp.pq3_state()) THEN RAISE EXCEPTION 'baseline restoration mismatch'; END IF;
END $$;
DROP TABLE public.polis_queue_large_class_install;
COMMIT;
