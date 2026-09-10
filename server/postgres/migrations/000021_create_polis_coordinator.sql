-- 000021_create_polis_coordinator.sql
-- Coordinator ownership substrate /1; schema installation only, no activation.
--
-- New tables only: NO columns, triggers, payload changes or data backfills on
-- any existing math table. Keys/owner/epoch/ticks/digests are typed. Checkpoint,
-- source-probe and consumer-position JSONB preserve the prototype's versioned
-- shapes in v1: changing their serialization together with the ownership bridge
-- would enlarge the compatibility change. Original science bytes are bytea,
-- kept BEFORE JSONB normalization, with SHA256 in generation-keyed rows. Future
-- job/run/attempt and result tables can join these (env,zid,tick) identities;
-- no DynamoDB migration, generic JSON job store, or queue /1 policy change here.
--
-- Apply THIS FILE ALONE only after separate operator approval, tested reversal,
-- backup/restore and publisher exclusion. Never replay the migration directory.
-- This migration requires a superuser installer on PostgreSQL 17. It provisions
-- three NOLOGIN roles; it grants NO login membership, NO existing math-table
-- write privileges, and wires NO adapter. The bridge's restricted publication
-- API/authority is a separate reviewed handoff; these tables alone do not fence
-- any current Python/Clojure writer. The control role cannot write receipts.
--
-- Sequence initialization reads the old main maximum under SHARE lock. That
-- lock lasts to COMMIT, not forever: publisher exclusion must last until the
-- reviewed sequence-using bridge is active. Replay does not reset the sequence.
-- The sequence is NOT a commit-order guarantee. Full reader sweep still required.
--
-- Exact catalog and provenance guards run before a replay can modify anything
-- and after fresh creation. No schema adoption/repair. Safe pre-existing NOLOGIN
-- roles can be adopted; external ACL provenance preserves identical/coalesced
-- grants (including pre-existing grant options). This file never upgrades a
-- grant option. Down removes only recorded additions, never DROP OWNED/CASCADE.
-- PostgreSQL 17 catalog deparse is pinned; profile drift requires reviewed repin.
-- Local rehearsals use disposable synthetic clusters ONLY. No persistent,
-- development, shared or production database has permission from this file.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(210021);
DO $pre$
BEGIN
 IF current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
  RAISE EXCEPTION 'coordinator migration requires PostgreSQL 17'; END IF;
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'coordinator migration requires superuser installer'; END IF;
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'coordinator_'))
 OR EXISTS(SELECT FROM pg_attribute WHERE attrelid=ANY(ARRAY['public.math_ticks'::regclass,'public.math_main'::regclass,'public.math_bidtopid'::regclass,'public.math_ptptstats'::regclass]) AND NOT attisdropped AND attname IN ('publisher_epoch','input_checkpoint','operation_id','original_bytes','original_sha256')) THEN
  RAISE EXCEPTION 'refusing: prototype coordinator schema must be isolated, not adopted'; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publisher') AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
  RAISE EXCEPTION 'refusing: unsafe coordinator role attributes'; END IF;
 -- Memberships could make a control/publisher login inherit the owner role.
 -- Adoption with unrelated grants/settings is safe; role hierarchies require a
 -- separate operator review. Provisioning runtime memberships happens later.
 IF EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publisher')) THEN
  RAISE EXCEPTION 'refusing: coordinator roles inherit another role'; END IF;
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
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,oidvectortypes(p.proargtypes),pg_get_function_result(p.oid),p.prosrc,p.probin,p.proconfig,p.prosecdef,p.provolatile,p.proisstrict,p.proparallel,p.proacl::text,pg_get_userbyid(p.proowner)) ORDER BY p.proname,oidvectortypes(p.proargtypes)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'pc_'))
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
('column','conversations','topic','polis_coordinator_owner','UPDATE')
$spec$;
CREATE OR REPLACE FUNCTION pg_temp.pc_external_acl()
RETURNS TABLE(object_kind text,object_name text,column_name text,grantee text,grantor text,privilege text,grantable boolean)
LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $acl$
 SELECT 'schema',n.nspname::text,'',pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable
 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='public'
 UNION ALL SELECT 'table',c.relname::text,'',pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable
 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid='public.conversations'::regclass
 UNION ALL SELECT 'column','conversations',att.attname::text,pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable
 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid='public.conversations'::regclass AND att.attnum>0
$acl$;
DO $admit$
BEGIN
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'polis_coordinator_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pc_')) THEN
  IF pg_temp.pc_catalog() IS DISTINCT FROM '9b49e569942fb328509a560141cdd203' THEN
   RAISE EXCEPTION 'refusing: coordinator catalog drift before replay' USING DETAIL=pg_temp.pc_catalog(); END IF;
  PERFORM set_config('polis_coordinator.replay','true',true);
 ELSE PERFORM set_config('polis_coordinator.replay','false',true);
 END IF;
END $admit$;
-- Snapshot before adding any external privileges. No membership grants occur.
CREATE TEMP TABLE pc_before_roles ON COMMIT DROP AS SELECT oid,rolname FROM pg_roles
 WHERE rolname IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publisher');
CREATE TEMP TABLE pc_before_acl ON COMMIT DROP AS SELECT * FROM pg_temp.pc_external_acl();
DO $roles$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publisher'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',r); END IF;
 END LOOP;
END $roles$;
DO $create$
DECLARE g record; sequence_start bigint;
BEGIN
 IF current_setting('polis_coordinator.replay')::boolean THEN RETURN; END IF;
 FOR g IN SELECT * FROM pg_temp.pc_grant_spec() LOOP
  EXECUTE format('GRANT %s%s ON %s public%s TO %I',g.privilege,
   CASE WHEN g.object_kind='column' THEN format('(%I)',g.column_name) ELSE '' END,
   CASE WHEN g.object_kind='schema' THEN 'SCHEMA' ELSE 'TABLE' END,
   CASE WHEN g.object_kind='schema' THEN '' ELSE format('.%I',g.object_name) END,g.grantee);
 END LOOP;
 LOCK TABLE public.math_main IN SHARE MODE;
 SELECT greatest(coalesce(max(caching_tick),0)+1,1) INTO sequence_start FROM public.math_main;
 IF sequence_start>9007199254740991 THEN RAISE EXCEPTION 'coordinator caching tick exceeds exact consumer range'; END IF;
 EXECUTE format('CREATE SEQUENCE public.polis_coordinator_caching_tick AS bigint MINVALUE 1 MAXVALUE 9007199254740991 START WITH %s CACHE 1 NO CYCLE',sequence_start);
 CREATE TABLE public.polis_coordinator_leases (
  math_env varchar(999) NOT NULL CHECK(length(math_env)>0), zid integer NOT NULL REFERENCES public.conversations(zid),
  owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
  owner_epoch bigint NOT NULL CHECK(owner_epoch>0), expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
  PRIMARY KEY(math_env,zid)
 );
 CREATE TABLE public.polis_coordinator_cursors (
  math_env varchar(999) NOT NULL CHECK(length(math_env)>0), consumer text NOT NULL CHECK(length(consumer) BETWEEN 1 AND 128),
  position jsonb NOT NULL CHECK(jsonb_typeof(position)='object'), PRIMARY KEY(math_env,consumer)
 );
 CREATE TABLE public.polis_coordinator_failures (
  math_env varchar(999) NOT NULL CHECK(length(math_env)>0), zid integer NOT NULL REFERENCES public.conversations(zid),
  attempts integer NOT NULL CHECK(attempts>0), first_failed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(first_failed_at)),
  next_attempt timestamptz NOT NULL CHECK(isfinite(next_attempt)), PRIMARY KEY(math_env,zid)
 );
 CREATE INDEX polis_coordinator_failures_due ON public.polis_coordinator_failures(math_env,next_attempt,zid);
 CREATE TABLE public.polis_coordinator_reconciliation (
  math_env varchar(999) NOT NULL CHECK(length(math_env)>0), zid integer NOT NULL REFERENCES public.conversations(zid),
  reconciled_at timestamptz NOT NULL CHECK(isfinite(reconciled_at)), source_probe jsonb NOT NULL CHECK(jsonb_typeof(source_probe)='object'),
  PRIMARY KEY(math_env,zid)
 );
 CREATE INDEX polis_coordinator_reconciliation_age ON public.polis_coordinator_reconciliation(math_env,reconciled_at,zid);
 -- Immutable per-generation operation identity. Unlike latest-only math_ticks,
 -- newer math cannot overwrite this operation's commit readback proof. The
 -- bridge must insert this row AND all three payloads in the math transaction.
 -- Retention/GC is deliberately not granted to the publisher or implemented.
 CREATE TABLE public.polis_coordinator_generations (
  math_env varchar(999) NOT NULL CHECK(length(math_env)>0), zid integer NOT NULL REFERENCES public.conversations(zid),
  math_tick bigint NOT NULL CHECK(math_tick>=0 AND math_tick<=9007199254740991),
  caching_tick bigint NOT NULL CHECK(caching_tick BETWEEN 1 AND 9007199254740991),
  owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128), publisher_epoch bigint NOT NULL CHECK(publisher_epoch>0),
  operation_id text NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  input_checkpoint jsonb NOT NULL CHECK(jsonb_typeof(input_checkpoint)='object'),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(committed_at)),
  PRIMARY KEY(math_env,zid,math_tick), UNIQUE(math_env,zid,operation_id)
 );
 CREATE TABLE public.polis_coordinator_payloads (
  math_env varchar(999) NOT NULL, zid integer NOT NULL, math_tick bigint NOT NULL,
  payload_kind text NOT NULL CHECK(payload_kind IN ('main','bidtopid','ptptstats')),
  original_bytes bytea NOT NULL CHECK(octet_length(original_bytes)>0),
  original_sha256 text NOT NULL CHECK(original_sha256 ~ '^[0-9a-f]{64}$' AND original_sha256=encode(sha256(original_bytes),'hex')),
  storage_sha256 text NOT NULL CHECK(storage_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(math_env,zid,math_tick,payload_kind),
  FOREIGN KEY(math_env,zid,math_tick) REFERENCES public.polis_coordinator_generations(math_env,zid,math_tick)
 );
 CREATE TABLE public.polis_coordinator_install (
  singleton boolean PRIMARY KEY CHECK(singleton), migration_id text NOT NULL CHECK(migration_id='000021'),
  catalog_fingerprint text NOT NULL CHECK(catalog_fingerprint ~ '^[0-9a-f]{32}$'),
  provenance_fingerprint text NOT NULL CHECK(provenance_fingerprint ~ '^[0-9a-f]{32}$'),
  sequence_start bigint NOT NULL CHECK(sequence_start BETWEEN 1 AND 9007199254740991),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(), installed_by name NOT NULL
 );
 CREATE TABLE public.polis_coordinator_install_roles (
  role_name text PRIMARY KEY CHECK(role_name IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publisher')),
  role_oid oid NOT NULL, created boolean NOT NULL
 );
 CREATE TABLE public.polis_coordinator_install_grants (
  object_kind text NOT NULL CHECK(object_kind IN ('schema','table','column')),
  object_name text NOT NULL, column_name text NOT NULL, grantee text NOT NULL, grantor text NOT NULL,
  privilege text NOT NULL CHECK(privilege IN ('USAGE','CREATE','SELECT','REFERENCES','UPDATE')),
  prior_present boolean NOT NULL, prior_grantable boolean NOT NULL,
  CHECK(prior_present OR NOT prior_grantable),
  PRIMARY KEY(object_kind,object_name,column_name,grantee,privilege)
 );
 FOR g IN SELECT relname,relkind FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'polis_coordinator_') AND relkind IN ('r','S') LOOP
  EXECUTE format('ALTER %s public.%I OWNER TO polis_coordinator_owner',CASE WHEN g.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,g.relname);
  EXECUTE format('REVOKE ALL ON %s public.%I FROM PUBLIC',CASE WHEN g.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,g.relname);
 END LOOP;
 -- Explicit privileges: the control role cannot publish or rewrite receipts;
 -- the publisher cannot acquire/renew a lease or delete historical receipts.
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.polis_coordinator_leases,public.polis_coordinator_cursors,public.polis_coordinator_failures,public.polis_coordinator_reconciliation TO polis_coordinator_control;
 GRANT SELECT ON public.polis_coordinator_generations,public.polis_coordinator_payloads TO polis_coordinator_control;
 GRANT SELECT ON public.polis_coordinator_leases TO polis_coordinator_publisher;
 GRANT SELECT,INSERT ON public.polis_coordinator_generations,public.polis_coordinator_payloads TO polis_coordinator_publisher;
 GRANT USAGE ON SEQUENCE public.polis_coordinator_caching_tick TO polis_coordinator_publisher;
 INSERT INTO public.polis_coordinator_install_roles
 SELECT r.rolname,r.oid,b.oid IS NULL FROM pg_roles r LEFT JOIN pc_before_roles b ON b.oid=r.oid
 WHERE r.rolname IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publisher');
 INSERT INTO public.polis_coordinator_install_grants(object_kind,object_name,column_name,grantee,grantor,privilege,prior_present,prior_grantable)
 SELECT s.object_kind,s.object_name,s.column_name,s.grantee,a.grantor,s.privilege,b.grantor IS NOT NULL,coalesce(b.grantable,false)
 FROM pg_temp.pc_grant_spec() s JOIN pg_temp.pc_external_acl() a USING(object_kind,object_name,column_name,grantee,privilege)
 LEFT JOIN pc_before_acl b USING(object_kind,object_name,column_name,grantee,grantor,privilege);
END $create$;
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
  IS DISTINCT FROM ARRAY['polis_coordinator_control','polis_coordinator_owner','polis_coordinator_publisher']
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
  ELSE pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.conversations'::regclass)) END
 ) INTO bad;
 IF bad THEN RAISE EXCEPTION 'refusing: external grant drift or malformed provenance'; END IF;
END $assert$;
-- END SHARED GUARDS
DO $record$
BEGIN
 IF NOT current_setting('polis_coordinator.replay')::boolean THEN
  INSERT INTO public.polis_coordinator_install(singleton,migration_id,catalog_fingerprint,provenance_fingerprint,sequence_start,installed_by)
  VALUES(true,'000021',pg_temp.pc_catalog(),pg_temp.pc_provenance_hash(),(SELECT seqstart FROM pg_sequence WHERE seqrelid='public.polis_coordinator_caching_tick'::regclass),session_user);
 END IF;
 IF pg_temp.pc_catalog() IS DISTINCT FROM '9b49e569942fb328509a560141cdd203' THEN
  RAISE EXCEPTION 'refusing: coordinator catalog assertion' USING DETAIL=pg_temp.pc_catalog(); END IF;
 PERFORM pg_temp.pc_assert_provenance();
END $record$;
COMMIT;
