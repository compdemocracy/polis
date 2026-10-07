-- 000026_drop_polis_queue_retention.sql
--
-- Reversal of 000026 (queue retention and restart-safe reads). Stop every
-- caller of the new functions first (a daemon with the sweep on; a poller
-- reading pq_queue_usage). In one transaction it locks every polis_queue_* and
-- delphi_* table ACCESS EXCLUSIVE, verifies the installed catalog is exactly
-- what 000026 recorded, refuses once a sweep has purged a row
-- (polis_queue_retention_install.rows_purged above zero: what a purge deleted
-- cannot be restored) - there is no force override - and then drops
-- pq_class_parked, pq_queue_usage, pq_sweep, the sweep ledger, the retention
-- policy, the tombstones (every tombstoned row still exists, so dropping
-- them restores it), pq_retention_reached, pq_retention_candidates, the three
-- indexes, the dead-job breaker (its trigger, pq_breaker_record and
-- polis_queue_breakers), restores every /3 function from the recorded
-- baseline (pq_class_depth's /3 reply, 000024's pd_enqueue), checks the
-- result against the baseline, and removes 000026's row from
-- public.schema_migrations.
--
-- The ledger: it refuses, changing nothing, when 000026's row is missing
-- (the catalog and the ledger disagree: inspect by hand) or when the ledger
-- records a later migration (reverse that first). 000025's down refuses while
-- 000026's row is there, so the order is 000026, then 000025, then 000024.
-- The breaker's rows go with its table: with nothing ever purged (the
-- refusal above), every dead job it counted is still in the queue, and
-- 000024's latch, which reads those rows, holds the same scopes (with no
-- 24-hour probe).
--
-- Run it the same way as the up script:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
--     < server/postgres/migrations/down/000026_drop_polis_queue_retention.sql
--
-- A database without 000026 has no polis_queue_retention_install table, so
-- the script fails before changing anything. After it, 000024's own down
-- script applies as if 000026 had never been applied. Proven by
-- test_000026_down.sh.
BEGIN;
SET LOCAL lock_timeout='5s';
-- The ledger, read as the login running the down (the queue owner has no
-- grant on it).
DO $ledger$ BEGIN
 IF to_regclass('public.schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'refusing reversal: the ledger does not record 000026_create_polis_queue_retention (there is no ledger)';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='000026_create_polis_queue_retention' AND length(checksum)=64) THEN
  RAISE EXCEPTION 'refusing reversal: the ledger does not record 000026_create_polis_queue_retention';
 END IF;
 IF EXISTS(SELECT 1 FROM public.schema_migrations WHERE name>'000026_create_polis_queue_retention' AND length(checksum)=64) THEN
  RAISE EXCEPTION 'refusing reversal: the ledger records later migrations (%); reverse them first',
   (SELECT string_agg(name,', ' ORDER BY name) FROM public.schema_migrations WHERE name>'000026_create_polis_queue_retention' AND length(checksum)=64);
 END IF;
END $ledger$;
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
CREATE OR REPLACE FUNCTION pg_temp.pq4_state() RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $s$
SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,pg_temp.pq_catalog(c.oid)) FROM pg_class c
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (starts_with(c.relname,'polis_queue_') OR starts_with(c.relname,'delphi_'))
 AND c.relname NOT IN ('delphi_foundation_install','polis_queue_large_class_install','polis_queue_retention_install')),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_functiondef(p.oid),p.proacl::text,pg_get_userbyid(p.proowner)))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (starts_with(p.proname,'pq_') OR starts_with(p.proname,'pd_'))))
$s$;
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT oid::regclass name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'
 AND (starts_with(relname,'delphi_') OR starts_with(relname,'polis_queue_')) ORDER BY relname LOOP
  EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',t.name);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.polis_queue_retention_install WHERE installed=pg_temp.pq4_state()) THEN RAISE EXCEPTION 'retention catalog drift'; END IF;
 IF EXISTS(SELECT 1 FROM public.polis_queue_retention_install WHERE rows_purged>0) THEN
  RAISE EXCEPTION 'refusing reversal: a sweep has purged % rows', (SELECT rows_purged FROM public.polis_queue_retention_install);
 END IF;
END $$;
DROP TRIGGER pq_breaker_record ON public.polis_queue_jobs;
DROP TABLE public.polis_queue_breakers;
DROP TABLE public.polis_queue_tombstones;
DROP TABLE public.polis_queue_retention_policy;
DROP INDEX public.polis_queue_jobs_terminal_age;
DROP INDEX public.polis_queue_attempts_ended;
DROP INDEX public.polis_queue_requests_expiry;
DROP TABLE public.polis_queue_sweeps;
DO $$ DECLARE f record; baseline jsonb; BEGIN
 SELECT i.baseline->'functions' INTO baseline FROM public.polis_queue_retention_install i;
 FOR f IN SELECT oid::regprocedure name FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND (starts_with(proname,'pd_') OR starts_with(proname,'pq_')) LOOP
  IF NOT baseline ? f.name::text THEN EXECUTE format('DROP FUNCTION %s',f.name); END IF;
 END LOOP;
 FOR f IN SELECT value FROM jsonb_each(baseline) LOOP
  EXECUTE f.value->>0;
 END LOOP;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.polis_queue_retention_install WHERE baseline=pg_temp.pq4_state()) THEN RAISE EXCEPTION 'baseline restoration mismatch'; END IF;
END $$;
DROP TABLE public.polis_queue_retention_install;
RESET ROLE;
DELETE FROM public.schema_migrations WHERE name='000026_create_polis_queue_retention';
COMMIT;
