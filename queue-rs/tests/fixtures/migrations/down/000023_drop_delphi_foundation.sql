-- Reversal of dormant 000023. Refuses any /2 data; no force override.
-- Stop writers. This script restores /1 fully; reapplying 000019 is optional verification.
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
CREATE FUNCTION pg_temp.pd_state() RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $s$
SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,pg_temp.pq_catalog(c.oid)) FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (starts_with(c.relname,'polis_queue_') OR starts_with(c.relname,'delphi_')) AND c.relname<>'delphi_foundation_install'),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_functiondef(p.oid),p.proacl::text,pg_get_userbyid(p.proowner)))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (starts_with(p.proname,'pq_') OR starts_with(p.proname,'pd_'))))
$s$;
DO $$ DECLARE t record; present boolean; BEGIN
 FOR t IN SELECT oid::regclass name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'
 AND (starts_with(relname,'delphi_') OR starts_with(relname,'polis_queue_')) ORDER BY relname LOOP
  EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',t.name);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.delphi_foundation_install WHERE installed=pg_temp.pd_state()) THEN RAISE EXCEPTION 'foundation catalog drift'; END IF;
 FOR t IN SELECT oid::regclass name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'
 AND ((starts_with(relname,'delphi_') AND relname<>'delphi_foundation_install') OR relname='polis_queue_logs') LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s)',t.name) INTO present;
  IF present THEN RAISE EXCEPTION 'refusing reversal: foundation data in %',t.name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.polis_queue_jobs WHERE stage<>'noop' OR worker_class<>'noop')
 OR EXISTS(SELECT 1 FROM public.polis_queue_runs WHERE contract_version<>'polis-queue/1')
 OR EXISTS(SELECT 1 FROM public.polis_queue_attempts WHERE process_exit_confirmed_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM public.polis_queue_requests WHERE binding_expires_at IS NOT NULL) THEN RAISE EXCEPTION 'refusing reversal: /2 data'; END IF;
END $$;
DROP TRIGGER pd_queue_binding ON public.polis_queue_jobs;
DROP TRIGGER pd_sync_status ON public.polis_queue_jobs;
DROP TRIGGER pd_input_guard ON public.delphi_job_inputs;
DO $$ DECLARE f record; baseline jsonb; BEGIN
 SELECT i.baseline->'functions' INTO baseline FROM public.delphi_foundation_install i;
 FOR f IN SELECT oid::regprocedure name FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND (starts_with(proname,'pd_') OR starts_with(proname,'pq_')) LOOP
  IF NOT baseline ? f.name::text THEN EXECUTE format('DROP FUNCTION %s',f.name); END IF;
 END LOOP;
 FOR f IN SELECT value FROM jsonb_each(baseline) LOOP
  EXECUTE f.value->>0;
 END LOOP;
END $$;
DROP TABLE public.polis_queue_logs;
DROP TABLE public.delphi_provider_requests;
DROP TABLE public.delphi_job_guards;
DROP TABLE public.delphi_current;
DROP TABLE public.delphi_job_inputs;
DROP TABLE public.delphi_job_aliases;
DROP TABLE public.delphi_jobs;
ALTER TABLE public.polis_queue_install DROP COLUMN contract_version;
ALTER TABLE public.polis_queue_attempts DROP CONSTRAINT pq_attempt_binding;
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT pq_stage_worker;
ALTER TABLE public.polis_queue_jobs DROP COLUMN worker_class;
ALTER TABLE public.polis_queue_attempts DROP COLUMN process_exit_confirmed_at;
ALTER TABLE public.polis_queue_requests DROP COLUMN binding_expires_at;
ALTER TABLE public.polis_queue_runs DROP CONSTRAINT polis_queue_runs_contract_version_check;
ALTER TABLE public.polis_queue_runs ADD CONSTRAINT polis_queue_runs_contract_version_check CHECK(contract_version='polis-queue/1');
ALTER TABLE public.polis_queue_jobs DROP CONSTRAINT polis_queue_jobs_stage_check;
ALTER TABLE public.polis_queue_jobs ADD CONSTRAINT polis_queue_jobs_stage_check CHECK(stage='noop');
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.delphi_foundation_install WHERE baseline=pg_temp.pd_state()) THEN RAISE EXCEPTION 'baseline restoration mismatch'; END IF;
END $$;
DROP TABLE public.delphi_foundation_install;
COMMIT;
