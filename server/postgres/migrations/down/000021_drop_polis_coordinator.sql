-- Reversal of 000021. PostgreSQL 17 superuser; THIS FILE ALONE.
-- Stop/drain publishers first. -v force=1 overrides ONLY the data/sequence-use
-- refusal. Drift, missing/corrupt provenance, new role grants/settings or
-- dependencies always refuse and roll back every drop/revoke. No CASCADE,
-- DROP OWNED, role-name inference or cleanup of unrecorded objects.
-- No data backup is made here. Preserve receipts before any approved force.
-- Adopted roles, settings, memberships and coalesced privileges survive.
-- Same shared guards and catalog pin as up. See docs/coordinator-substrate.md.
\set ON_ERROR_STOP on
\if :{?force}
\else
 \set force 0
\endif
\if :{?lock_timeout}
\else
 \set lock_timeout '5s'
\endif
BEGIN;
SET LOCAL lock_timeout=:'lock_timeout';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(210021);
DO $pre$
BEGIN
 IF current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'coordinator down requires PostgreSQL 17 superuser'; END IF;
END $pre$;
-- Shared guard body is byte-identical in up/down; only pg_temp functions.
CREATE OR REPLACE FUNCTION pg_temp.pc_catalog() RETURNS text
LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $catalog$
SELECT md5(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_object(
  'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
  'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions,
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,co.collname,pg_get_expr(d.adbin,d.adrelid),a.attacl::text) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid),convalidated,connoinherit) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
  'sequence',(SELECT jsonb_build_array(format_type(seqtypid,NULL),seqincrement,seqmin,seqmax,seqcache,seqcycle) FROM pg_sequence WHERE seqrelid=c.oid),
  'acl',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee=0,pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
   FROM aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a)
 ) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'polis_coordinator_')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,oidvectortypes(p.proargtypes),pg_get_function_result(p.oid),p.prosrc,p.probin,(SELECT lanname FROM pg_language WHERE oid=p.prolang),p.prokind,pg_get_function_arguments(p.oid),p.proconfig,p.prosecdef,p.provolatile,p.proisstrict,p.proparallel,p.proacl::text,pg_get_userbyid(p.proowner)) ORDER BY p.proname,oidvectortypes(p.proargtypes)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'pc_'))
)::text)
$catalog$;
CREATE OR REPLACE FUNCTION pg_temp.pc_grant_spec()
RETURNS TABLE(object_kind text,object_name text,column_name text,grantee text,privilege text)
LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $spec$
VALUES ('schema','public','','polis_coordinator_owner','USAGE'),
('schema','public','','polis_coordinator_owner','CREATE'),
('schema','public','','polis_coordinator_control','USAGE'),
('schema','public','','polis_coordinator_publisher','USAGE'),
('table','conversations','','polis_coordinator_owner','SELECT'),
('column','conversations','zid','polis_coordinator_owner','REFERENCES'),
('column','conversations','topic','polis_coordinator_owner','UPDATE'),
('schema','public','','polis_coordinator_publication_owner','USAGE'),
('table','conversations','','polis_coordinator_publication_owner','SELECT'),
('column','conversations','topic','polis_coordinator_publication_owner','UPDATE'),
('table','math_ticks','','polis_coordinator_publication_owner','SELECT'),
('table','math_ticks','','polis_coordinator_publication_owner','INSERT'),
('table','math_ticks','','polis_coordinator_publication_owner','UPDATE'),
('table','math_main','','polis_coordinator_publication_owner','SELECT'),
('table','math_main','','polis_coordinator_publication_owner','INSERT'),
('table','math_main','','polis_coordinator_publication_owner','UPDATE'),
('table','math_bidtopid','','polis_coordinator_publication_owner','SELECT'),
('table','math_bidtopid','','polis_coordinator_publication_owner','INSERT'),
('table','math_bidtopid','','polis_coordinator_publication_owner','UPDATE'),
('table','math_ptptstats','','polis_coordinator_publication_owner','SELECT'),
('table','math_ptptstats','','polis_coordinator_publication_owner','INSERT'),
('table','math_ptptstats','','polis_coordinator_publication_owner','UPDATE')
$spec$;
CREATE OR REPLACE FUNCTION pg_temp.pc_external_acl()
RETURNS TABLE(object_kind text,object_name text,column_name text,grantee text,grantor text,privilege text,grantable boolean)
LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $acl$
 SELECT 'schema',n.nspname::text,'',pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable
 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='public'
 UNION ALL SELECT 'table',c.relname::text,'',pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable
 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=ANY(ARRAY['public.conversations'::regclass,'public.math_ticks'::regclass,'public.math_main'::regclass,'public.math_bidtopid'::regclass,'public.math_ptptstats'::regclass])
 UNION ALL SELECT 'column','conversations',att.attname::text,pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable
 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid='public.conversations'::regclass AND att.attnum>0
$acl$;
SELECT NOT EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'polis_coordinator_'))
 AND NOT EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pc_'))
 AND NOT EXISTS(SELECT FROM pg_roles WHERE rolname IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publication_owner','polis_coordinator_publisher')) AS pc_absent \gset
\if :pc_absent
 DO $$ BEGIN RAISE NOTICE 'coordinator schema never installed or completely removed; nothing to drop'; END $$;
\else
 DO $catalog$
 BEGIN
  IF pg_temp.pc_catalog() IS DISTINCT FROM '762ab4ea71d7e314494ddd0b3290e6c1' THEN
   RAISE EXCEPTION 'refusing: coordinator catalog drift' USING DETAIL=pg_temp.pc_catalog(); END IF;
 END $catalog$;
 -- Child before parent; count only AFTER ACCESS EXCLUSIVE locks. The provenance
 -- rows are locked too so a concurrent edit cannot change the deletion plan.
 LOCK TABLE public.polis_coordinator_payloads,public.polis_coordinator_generations,
 public.polis_coordinator_cursors,public.polis_coordinator_failures,
 public.polis_coordinator_reconciliation,public.polis_coordinator_leases,
 public.polis_coordinator_install_grants,public.polis_coordinator_install_roles,
 public.polis_coordinator_install IN ACCESS EXCLUSIVE MODE;
CREATE OR REPLACE FUNCTION pg_temp.pc_provenance_hash() RETURNS text
LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $hash$
 SELECT md5(jsonb_build_object(
 'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY role_name) FROM public.polis_coordinator_install_roles r),
 'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY object_kind,object_name,column_name,grantee,privilege) FROM public.polis_coordinator_install_grants g)
 )::text)
$hash$;
CREATE OR REPLACE FUNCTION pg_temp.pc_assert_provenance() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $assert$
DECLARE bad boolean;
BEGIN
 IF (SELECT count(*) FROM public.polis_coordinator_install) <> 1
 OR NOT EXISTS(SELECT FROM public.polis_coordinator_install WHERE singleton AND migration_id='000021'
  AND catalog_fingerprint=pg_temp.pc_catalog() AND provenance_fingerprint=pg_temp.pc_provenance_hash()) THEN
  RAISE EXCEPTION 'refusing: missing or corrupt coordinator provenance';
 END IF;
 IF NOT EXISTS(SELECT FROM public.polis_coordinator_install i
 JOIN pg_sequence s ON s.seqrelid='public.polis_coordinator_caching_tick'::regclass
 WHERE s.seqstart=i.sequence_start)
 OR (SELECT last_value FROM public.polis_coordinator_caching_tick) < greatest(
  (SELECT sequence_start FROM public.polis_coordinator_install),
  coalesce((SELECT max(caching_tick) FROM public.polis_coordinator_generations),1)) THEN
  RAISE EXCEPTION 'refusing: coordinator sequence initialization or state drift';
 END IF;
 IF (SELECT array_agg(role_name ORDER BY role_name) FROM public.polis_coordinator_install_roles)
  IS DISTINCT FROM ARRAY['polis_coordinator_control','polis_coordinator_owner','polis_coordinator_publication_owner','polis_coordinator_publisher']
 OR EXISTS(SELECT FROM public.polis_coordinator_install_roles r LEFT JOIN pg_roles p ON p.rolname=r.role_name WHERE p.oid IS DISTINCT FROM r.role_oid) THEN
  RAISE EXCEPTION 'refusing: coordinator role provenance inventory or identity';
 END IF;
 IF EXISTS((SELECT object_kind,object_name,column_name,grantee,privilege FROM pg_temp.pc_grant_spec()
   EXCEPT SELECT object_kind,object_name,column_name,grantee,privilege FROM public.polis_coordinator_install_grants)
  UNION ALL
  (SELECT object_kind,object_name,column_name,grantee,privilege FROM public.polis_coordinator_install_grants
   EXCEPT SELECT object_kind,object_name,column_name,grantee,privilege FROM pg_temp.pc_grant_spec())) THEN
  RAISE EXCEPTION 'refusing: coordinator grant provenance inventory';
 END IF;
 SELECT EXISTS(SELECT FROM public.polis_coordinator_install_grants g
 LEFT JOIN pg_temp.pc_external_acl() a USING(object_kind,object_name,column_name,grantee,grantor,privilege)
 WHERE a.grantable IS DISTINCT FROM g.prior_grantable
 OR g.grantor IS DISTINCT FROM CASE WHEN g.object_kind='schema'
  THEN pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname='public'))
  ELSE pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=to_regclass('public.'||g.object_name))) END
 ) INTO bad;
 IF bad THEN RAISE EXCEPTION 'refusing: external grant drift or malformed provenance'; END IF;
END $assert$;
-- END SHARED GUARDS

 SELECT pg_temp.pc_assert_provenance();
 SELECT set_config('polis_coordinator.force',:'force',true);
 DO $drop$
 DECLARE total bigint; g record; r record; stmt text; rid oid;
 BEGIN
  SELECT (SELECT count(*) FROM public.polis_coordinator_leases)
   +(SELECT count(*) FROM public.polis_coordinator_cursors)
   +(SELECT count(*) FROM public.polis_coordinator_failures)
   +(SELECT count(*) FROM public.polis_coordinator_reconciliation)
   +(SELECT count(*) FROM public.polis_coordinator_generations)
   +(SELECT count(*) FROM public.polis_coordinator_payloads) INTO total;
  IF current_setting('polis_coordinator.force') <> '1' AND (total>0 OR (SELECT is_called FROM public.polis_coordinator_caching_tick)) THEN
   RAISE EXCEPTION 'refusing: coordinator contains data or used sequence; force=1 overrides only this guard'; END IF;
  -- Snapshot validated provenance before dropping its tables.
  CREATE TEMP TABLE pc_remove_roles ON COMMIT DROP AS SELECT * FROM public.polis_coordinator_install_roles WHERE created;
  CREATE TEMP TABLE pc_remove_grants ON COMMIT DROP AS SELECT * FROM public.polis_coordinator_install_grants WHERE NOT prior_present;
  DROP FUNCTION public.pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea);
  DROP FUNCTION public.pc_canonical(jsonb);
  DROP TABLE public.polis_coordinator_payloads;
  DROP TABLE public.polis_coordinator_generations;
  DROP TABLE public.polis_coordinator_cursors;
  DROP TABLE public.polis_coordinator_failures;
  DROP TABLE public.polis_coordinator_reconciliation;
  DROP TABLE public.polis_coordinator_leases;
  DROP SEQUENCE public.polis_coordinator_caching_tick;
  DROP TABLE public.polis_coordinator_install_grants;
  DROP TABLE public.polis_coordinator_install_roles;
  DROP TABLE public.polis_coordinator_install;
  FOR g IN SELECT * FROM pc_remove_grants ORDER BY object_kind,object_name,column_name,grantee,privilege LOOP
   -- Act as the original grantor, never accidentally revoke a different grant.
   EXECUTE format('SET LOCAL ROLE %I',g.grantor);
   EXECUTE format('REVOKE %s%s ON %s public%s FROM %I',g.privilege,
    CASE WHEN g.object_kind='column' THEN format('(%I)',g.column_name) ELSE '' END,
    CASE WHEN g.object_kind='schema' THEN 'SCHEMA' ELSE 'TABLE' END,
    CASE WHEN g.object_kind='schema' THEN '' ELSE format('.%I',g.object_name) END,g.grantee);
   RESET ROLE;
  END LOOP;
  FOR r IN SELECT * FROM pc_remove_roles ORDER BY role_name LOOP
   SELECT oid INTO rid FROM pg_roles WHERE rolname=r.role_name;
   IF rid IS DISTINCT FROM r.role_oid
   OR EXISTS(SELECT FROM pg_roles WHERE oid=rid AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolinherit OR rolconnlimit<>-1 OR rolvaliduntil IS NOT NULL OR rolconfig IS NOT NULL))
   OR EXISTS(SELECT FROM pg_authid WHERE oid=rid AND rolpassword IS NOT NULL)
   OR EXISTS(SELECT FROM pg_db_role_setting WHERE setrole=rid)
   OR EXISTS(SELECT FROM pg_auth_members WHERE roleid=rid OR member=rid OR grantor=rid)
   OR EXISTS(SELECT FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=rid) THEN
    RAISE EXCEPTION 'refusing to drop role %: not the bare role created by 000021',r.role_name; END IF;
   EXECUTE format('DROP ROLE %I',r.role_name);
  END LOOP;
 END $drop$;
\endif
COMMIT;
