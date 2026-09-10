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
-- four NOLOGIN roles; it grants NO login membership and wires NO adapter. A new
-- NOLOGIN
-- polis_coordinator_publication_owner receives SELECT/INSERT/UPDATE on only
-- math_ticks, math_bidtopid, math_ptptstats and math_main; conversations SELECT
-- and UPDATE(topic) allow the parent lock. Public schema USAGE only. Every
-- external grant is recorded/reversed without adding a grant option.
-- pc_publish has fixed SQL, SECURITY DEFINER and search_path=pg_catalog,pg_temp.
-- It alone writes math and receipts under the final owner/epoch/margin check.
-- The Python publisher role gets EXECUTE only (plus metadata reads); the Rust
-- control role gets no EXECUTE and no math write permission. These privileges
-- do not fence existing broad-credential writers; exclude them before activation.
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
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publication_owner','polis_coordinator_publisher') AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
  RAISE EXCEPTION 'refusing: unsafe coordinator role attributes'; END IF;
 -- Memberships could make a control/publisher login inherit the owner role.
 -- Adoption with unrelated grants/settings is safe; role hierarchies require a
 -- separate operator review. Provisioning runtime memberships happens later.
 IF EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publication_owner','polis_coordinator_publisher')) THEN
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
('table','math_ticks','','polis_coordinator_owner','SELECT'),('table','math_main','','polis_coordinator_owner','SELECT'),('table','math_bidtopid','','polis_coordinator_owner','SELECT'),('table','math_ptptstats','','polis_coordinator_owner','SELECT'),
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
DO $admit$
BEGIN
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'polis_coordinator_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pc_')) THEN
  IF pg_temp.pc_catalog() IS DISTINCT FROM 'dd88a9711bbdac72155d4e8862052c4b' THEN
   RAISE EXCEPTION 'refusing: coordinator catalog drift before replay' USING DETAIL=pg_temp.pc_catalog(); END IF;
  PERFORM set_config('polis_coordinator.replay','true',true);
 ELSE PERFORM set_config('polis_coordinator.replay','false',true);
 END IF;
END $admit$;
-- Snapshot before adding any external privileges. No membership grants occur.
CREATE TEMP TABLE pc_before_roles ON COMMIT DROP AS SELECT oid,rolname FROM pg_roles
 WHERE rolname IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publication_owner','polis_coordinator_publisher');
CREATE TEMP TABLE pc_before_acl ON COMMIT DROP AS SELECT * FROM pg_temp.pc_external_acl();
DO $roles$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publication_owner','polis_coordinator_publisher'] LOOP
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
  dispatch_operation_id text, dispatch_capability_sha256 text, dispatch_checkpoint_sha256 text,
  dispatch_expected_tick bigint, dispatch_margin_ms integer,
  CHECK ((dispatch_operation_id IS NULL AND dispatch_capability_sha256 IS NULL AND dispatch_checkpoint_sha256 IS NULL AND dispatch_expected_tick IS NULL AND dispatch_margin_ms IS NULL)
   OR (dispatch_operation_id IS NOT NULL AND length(dispatch_operation_id) BETWEEN 1 AND 128
    AND dispatch_capability_sha256 IS NOT NULL AND dispatch_capability_sha256 ~ '^[0-9a-f]{64}$'
    AND dispatch_checkpoint_sha256 IS NOT NULL AND dispatch_checkpoint_sha256 ~ '^[0-9a-f]{64}$'
    AND (dispatch_expected_tick IS NULL OR dispatch_expected_tick BETWEEN 0 AND 9007199254740990)
    AND dispatch_margin_ms IS NOT NULL AND dispatch_margin_ms BETWEEN 1 AND 60000)),
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
  capability_sha256 text NOT NULL CHECK(capability_sha256 ~ '^[0-9a-f]{64}$'),
  expected_tick bigint CHECK(expected_tick BETWEEN 0 AND 9007199254740990),
  CHECK(math_tick=coalesce(expected_tick+1,0)),
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
 -- No profiles are installed: an operator must review explicit per-namespace
 -- count/logical-byte ceilings before admission. Reservations remain charged
 -- until protected cleanup removes a resolved operation and its receipt.
 CREATE TABLE public.polis_coordinator_budgets (
  math_env varchar(999) PRIMARY KEY CHECK(length(math_env)>0),
  max_operations integer NOT NULL CHECK(max_operations BETWEEN 1 AND 1000000),
  max_bytes bigint NOT NULL CHECK(max_bytes BETWEEN 1048576 AND 1099511627776)
 );
 CREATE TABLE public.polis_coordinator_operations (
  math_env varchar(999) NOT NULL REFERENCES public.polis_coordinator_budgets(math_env),
  zid integer NOT NULL REFERENCES public.conversations(zid),
  operation_id text NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
  owner_epoch bigint NOT NULL CHECK(owner_epoch>0),
  expected_tick bigint CHECK(expected_tick BETWEEN 0 AND 9007199254740990),
  capability_sha256 text NOT NULL CHECK(capability_sha256 ~ '^[0-9a-f]{64}$'),
  checkpoint_sha256 text NOT NULL CHECK(checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  reserved_bytes bigint NOT NULL CHECK(reserved_bytes BETWEEN 1048576 AND 1099511627776),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','unresolved','resolved')),
  protected boolean NOT NULL DEFAULT false,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reconciled_at timestamptz NOT NULL DEFAULT '-infinity',
  resolved_tick bigint CHECK(resolved_tick BETWEEN 0 AND 9007199254740991),
  CHECK((state='resolved')=(resolved_tick IS NOT NULL)),
  PRIMARY KEY(math_env,zid,operation_id)
 );
 CREATE INDEX polis_coordinator_operations_reconcile ON public.polis_coordinator_operations(math_env,reconciled_at,zid,operation_id) WHERE state<>'resolved';
 CREATE INDEX polis_coordinator_operations_references ON public.polis_coordinator_operations(math_env,zid,expected_tick) WHERE state<>'resolved' OR protected;
 CREATE TABLE public.polis_coordinator_references (
  math_env varchar(999) NOT NULL, zid integer NOT NULL, operation_id text NOT NULL,
  reference_name text NOT NULL CHECK(length(reference_name) BETWEEN 1 AND 128),
  PRIMARY KEY(math_env,zid,operation_id,reference_name),
  FOREIGN KEY(math_env,zid,operation_id) REFERENCES public.polis_coordinator_operations(math_env,zid,operation_id)
 );
 CREATE TABLE public.polis_coordinator_floors (
  math_env varchar(999) NOT NULL, zid integer NOT NULL REFERENCES public.conversations(zid),
  math_tick bigint NOT NULL CHECK(math_tick BETWEEN 0 AND 9007199254740991),
  caching_tick bigint NOT NULL CHECK(caching_tick BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(math_env,zid)
 );
 CREATE TABLE public.polis_coordinator_install (
  singleton boolean PRIMARY KEY CHECK(singleton), migration_id text NOT NULL CHECK(migration_id='000021'),
  catalog_fingerprint text NOT NULL CHECK(catalog_fingerprint ~ '^[0-9a-f]{32}$'),
  provenance_fingerprint text NOT NULL CHECK(provenance_fingerprint ~ '^[0-9a-f]{32}$'),
  sequence_start bigint NOT NULL CHECK(sequence_start BETWEEN 1 AND 9007199254740991),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(), installed_by name NOT NULL
 );
 CREATE TABLE public.polis_coordinator_install_roles (
  role_name text PRIMARY KEY CHECK(role_name IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publication_owner','polis_coordinator_publisher')),
  role_oid oid NOT NULL, created boolean NOT NULL
 );
 CREATE TABLE public.polis_coordinator_install_grants (
  object_kind text NOT NULL CHECK(object_kind IN ('schema','table','column')),
  object_name text NOT NULL, column_name text NOT NULL, grantee text NOT NULL, grantor text NOT NULL,
  privilege text NOT NULL CHECK(privilege IN ('USAGE','CREATE','SELECT','REFERENCES','UPDATE','INSERT')),
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
 GRANT SELECT ON public.polis_coordinator_generations,public.polis_coordinator_payloads TO polis_coordinator_publisher;
 GRANT SELECT ON public.polis_coordinator_install TO polis_coordinator_control,polis_coordinator_publisher;
 GRANT SELECT,UPDATE ON public.polis_coordinator_leases TO polis_coordinator_publication_owner;
 GRANT SELECT,INSERT ON public.polis_coordinator_generations,public.polis_coordinator_payloads TO polis_coordinator_publication_owner;
 GRANT SELECT ON public.polis_coordinator_references TO polis_coordinator_control;
 GRANT SELECT ON public.polis_coordinator_budgets,public.polis_coordinator_operations,public.polis_coordinator_floors TO polis_coordinator_control,polis_coordinator_publisher;
 GRANT SELECT,UPDATE ON public.polis_coordinator_budgets,public.polis_coordinator_operations TO polis_coordinator_publication_owner;
 GRANT SELECT,INSERT,UPDATE ON public.polis_coordinator_floors TO polis_coordinator_publication_owner;
 GRANT USAGE ON SEQUENCE public.polis_coordinator_caching_tick TO polis_coordinator_publication_owner;
 INSERT INTO public.polis_coordinator_install_roles
 SELECT r.rolname,r.oid,b.oid IS NULL FROM pg_roles r LEFT JOIN pc_before_roles b ON b.oid=r.oid
 WHERE r.rolname IN ('polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publication_owner','polis_coordinator_publisher');
 INSERT INTO public.polis_coordinator_install_grants(object_kind,object_name,column_name,grantee,grantor,privilege,prior_present,prior_grantable)
 SELECT s.object_kind,s.object_name,s.column_name,s.grantee,a.grantor,s.privilege,b.grantor IS NOT NULL,coalesce(b.grantable,false)
 FROM pg_temp.pc_grant_spec() s JOIN pg_temp.pc_external_acl() a USING(object_kind,object_name,column_name,grantee,privilege)
 LEFT JOIN pc_before_acl b USING(object_kind,object_name,column_name,grantee,grantor,privilege);
 EXECUTE $authority$
-- Fixed statements only. Payload preparation and integrity hashes precede locks.
-- SECURITY DEFINER owner is a dedicated NOLOGIN role, never a service login.
CREATE FUNCTION public.pc_canonical(p_value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $canonical$
 SELECT CASE jsonb_typeof(p_value)
 WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_jsonb(key)::text||':'||public.pc_canonical(value),',' ORDER BY key COLLATE "C") FROM jsonb_each(p_value)),'')||'}'
 WHEN 'array' THEN '['||coalesce((SELECT string_agg(public.pc_canonical(value),',' ORDER BY ord) FROM jsonb_array_elements(p_value) WITH ORDINALITY a(value,ord)),'')||']'
 WHEN 'number' THEN CASE WHEN p_value::text::numeric=0 THEN '0' ELSE trim_scale(p_value::text::numeric)::text END
 ELSE p_value::text END
$canonical$;
CREATE FUNCTION public.pc_publish(
 p_env text,p_zid integer,p_owner text,p_epoch bigint,p_operation text,
 p_capability bytea,p_expected_tick bigint,p_checkpoint jsonb,
 p_main bytea,p_bidtopid bytea,p_ptptstats bytea
) RETURNS TABLE(outcome text,math_tick bigint,caching_tick bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $publish$
DECLARE
 op public.polis_coordinator_operations; admission_xid xid;
 main_data jsonb; bid_data jsonb; stats_data jsonb; stamp bigint;
 capability_hash text; checkpoint_hash text; originals jsonb; storage_hashes jsonb;
 lease public.polis_coordinator_leases; receipt public.polis_coordinator_generations;
 current_tick bigint; new_tick bigint; new_cursor bigint; recorded_checkpoint jsonb;
BEGIN
 IF p_env IS NULL OR length(p_env) NOT BETWEEN 1 AND 999 OR p_zid IS NULL
 OR p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 128
 OR p_epoch IS NULL OR p_epoch<=0 OR p_operation IS NULL OR length(p_operation) NOT BETWEEN 1 AND 128
 OR p_capability IS NULL OR octet_length(p_capability)<>32
 OR (p_expected_tick IS NOT NULL AND (p_expected_tick<0 OR p_expected_tick>=9007199254740991))
 OR jsonb_typeof(p_checkpoint) IS DISTINCT FROM 'object'
 OR p_checkpoint ?| ARRAY['operation_id','publisher_epoch','original_digests','payload_digests']
 OR octet_length(p_checkpoint::text)>65536
 OR p_main IS NULL OR p_bidtopid IS NULL OR p_ptptstats IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='P2010',MESSAGE='INVALID_PUBLICATION_REQUEST';
 END IF;
 -- PostgreSQL 17 rejects malformed/duplicate-key JSON before JSONB can collapse
 -- it; the original supplied byte stream is retained and hashed unchanged.
 IF NOT (convert_from(p_main,'UTF8') IS JSON OBJECT WITH UNIQUE KEYS)
 OR NOT (convert_from(p_bidtopid,'UTF8') IS JSON OBJECT WITH UNIQUE KEYS)
 OR NOT (convert_from(p_ptptstats,'UTF8') IS JSON OBJECT WITH UNIQUE KEYS) THEN
  RAISE EXCEPTION USING ERRCODE='P2010',MESSAGE='INVALID_ORIGINAL_JSON';
 END IF;
 main_data:=convert_from(p_main,'UTF8')::jsonb;
 bid_data:=convert_from(p_bidtopid,'UTF8')::jsonb;
 stats_data:=convert_from(p_ptptstats,'UTF8')::jsonb;
 IF main_data->'zid' IS DISTINCT FROM to_jsonb(p_zid)
 OR bid_data->'zid' IS DISTINCT FROM to_jsonb(p_zid)
 OR stats_data->'zid' IS DISTINCT FROM to_jsonb(p_zid)
 OR jsonb_typeof(main_data->'lastVoteTimestamp') IS DISTINCT FROM 'number'
 OR main_data->'lastVoteTimestamp' IS DISTINCT FROM bid_data->'lastVoteTimestamp'
 OR main_data->'lastVoteTimestamp' IS DISTINCT FROM stats_data->'lastVoteTimestamp' THEN
  RAISE EXCEPTION USING ERRCODE='P2010',MESSAGE='FOREIGN_OR_INCONSISTENT_PAYLOAD';
 END IF;
 IF (main_data->>'lastVoteTimestamp')::numeric <> trunc((main_data->>'lastVoteTimestamp')::numeric) THEN
  RAISE EXCEPTION USING ERRCODE='P2010',MESSAGE='INVALID_VOTE_TIMESTAMP'; END IF;
 stamp:=(main_data->>'lastVoteTimestamp')::numeric::bigint;
 capability_hash:=encode(sha256(p_capability),'hex');
 checkpoint_hash:=encode(sha256(convert_to(p_checkpoint::text,'UTF8')),'hex');
 originals:=jsonb_build_object('main',encode(sha256(p_main),'hex'),'bidtopid',encode(sha256(p_bidtopid),'hex'),'ptptstats',encode(sha256(p_ptptstats),'hex'));
 storage_hashes:=jsonb_build_object('main',encode(sha256(convert_to(public.pc_canonical(main_data),'UTF8')),'hex'),'bidtopid',encode(sha256(convert_to(public.pc_canonical(bid_data),'UTF8')),'hex'),'ptptstats',encode(sha256(convert_to(public.pc_canonical(stats_data),'UTF8')),'hex'));
 recorded_checkpoint:=p_checkpoint||jsonb_build_object('operation_id',p_operation,'publisher_epoch',p_epoch,'original_digests',originals,'payload_digests',storage_hashes);
 -- Parent first, then lease. Locking the lease serializes this exact operation
 -- with renewal, takeover and another publication. One zid per transaction.
 PERFORM zid FROM public.conversations WHERE zid=p_zid FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2010',MESSAGE='UNKNOWN_CONVERSATION'; END IF;
 SELECT * INTO lease FROM public.polis_coordinator_leases WHERE math_env=p_env AND zid=p_zid FOR UPDATE;
 -- Durable exact-attempt readback remains possible after a newer generation or
 -- lease exists. A different capability/checkpoint/payload is never a lost-ack
 -- retry of the original operation. It cannot overwrite an old receipt.
 SELECT * INTO receipt FROM public.polis_coordinator_generations g WHERE g.math_env=p_env AND g.zid=p_zid AND g.operation_id=p_operation;
 IF FOUND THEN
  IF receipt.owner_id IS DISTINCT FROM p_owner OR receipt.publisher_epoch IS DISTINCT FROM p_epoch
  OR receipt.capability_sha256 IS DISTINCT FROM capability_hash
  OR receipt.expected_tick IS DISTINCT FROM p_expected_tick
  OR receipt.input_checkpoint IS DISTINCT FROM recorded_checkpoint
  OR (SELECT count(*) FROM public.polis_coordinator_payloads r WHERE r.math_env=p_env AND r.zid=p_zid AND r.math_tick=receipt.math_tick
      AND r.original_sha256=originals->>r.payload_kind AND r.storage_sha256=storage_hashes->>r.payload_kind)<>3 THEN
   RAISE EXCEPTION USING ERRCODE='P2011',MESSAGE='OPERATION_IDENTITY_CONFLICT'; END IF;
  RETURN QUERY SELECT 'already_committed'::text,receipt.math_tick,receipt.caching_tick;
  RETURN;
 END IF;
 IF lease.owner_id IS DISTINCT FROM p_owner OR lease.owner_epoch IS DISTINCT FROM p_epoch THEN
  RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='FENCED'; END IF;
 IF lease.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION USING ERRCODE='P2005',MESSAGE='LEASE-EXPIRED'; END IF;
 IF lease.dispatch_operation_id IS DISTINCT FROM p_operation
 OR lease.dispatch_capability_sha256 IS DISTINCT FROM capability_hash
 OR lease.dispatch_checkpoint_sha256 IS DISTINCT FROM checkpoint_hash
 OR lease.dispatch_expected_tick IS DISTINCT FROM p_expected_tick THEN
  RAISE EXCEPTION USING ERRCODE='P2010',MESSAGE='DISPATCH_IDENTITY_CONFLICT'; END IF;
 -- Durable admission is mandatory before any science write. A caller must
 -- COMMIT pc_admit before spawning its child; no adapter is activated here.
 PERFORM 1 FROM public.polis_coordinator_budgets WHERE math_env=p_env FOR UPDATE;
 SELECT * INTO op FROM public.polis_coordinator_operations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='OPERATION_NOT_ADMITTED'; END IF;
 SELECT xmin INTO admission_xid FROM public.polis_coordinator_operations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation;
 IF admission_xid=pg_current_xact_id()::text::xid THEN
  RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='ADMISSION_NOT_DURABLE'; END IF;
 IF op.owner_id IS DISTINCT FROM p_owner OR op.owner_epoch IS DISTINCT FROM p_epoch
 OR op.expected_tick IS DISTINCT FROM p_expected_tick OR op.capability_sha256 IS DISTINCT FROM capability_hash
 OR op.checkpoint_sha256 IS DISTINCT FROM checkpoint_hash OR op.state='resolved' THEN
  RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='ADMISSION_IDENTITY_CONFLICT'; END IF;
 IF octet_length(p_main)::bigint+octet_length(p_bidtopid)+octet_length(p_ptptstats)+octet_length(recorded_checkpoint::text)+1048576>op.reserved_bytes THEN
  RAISE EXCEPTION USING ERRCODE='P2021',MESSAGE='PUBLICATION_BYTE_CAPACITY'; END IF;
 SELECT t.math_tick INTO current_tick FROM public.math_ticks t WHERE t.zid=p_zid AND t.math_env=p_env FOR UPDATE;
 -- Receipt history is the generation floor even if the latest pointer was
 -- deleted or regressed. The held parent/lease locks serialize this namespace
 -- and zid; this bounded indexed maximum reads no science payloads.
 SELECT greatest(current_tick,max(g.math_tick)) INTO current_tick
 FROM public.polis_coordinator_generations g WHERE g.zid=p_zid AND g.math_env=p_env;
 SELECT greatest(current_tick,(SELECT f.math_tick FROM public.polis_coordinator_floors f WHERE f.math_env=p_env AND f.zid=p_zid)) INTO current_tick;
 IF current_tick IS DISTINCT FROM p_expected_tick THEN
  RETURN QUERY SELECT 'conflict'::text,current_tick,NULL::bigint; RETURN; END IF;
 new_tick:=coalesce(current_tick+1,0);
 INSERT INTO public.math_ticks(zid,math_env,math_tick) VALUES(p_zid,p_env,new_tick)
 ON CONFLICT(zid,math_env) DO UPDATE SET math_tick=excluded.math_tick,modified=public.now_as_millis();
 INSERT INTO public.math_bidtopid(zid,math_env,math_tick,data) VALUES(p_zid,p_env,new_tick,bid_data)
 ON CONFLICT(zid,math_env) DO UPDATE SET math_tick=excluded.math_tick,data=excluded.data,modified=public.now_as_millis();
 INSERT INTO public.math_ptptstats(zid,math_env,math_tick,data) VALUES(p_zid,p_env,new_tick,stats_data)
 ON CONFLICT(zid,math_env) DO UPDATE SET math_tick=excluded.math_tick,data=excluded.data,modified=public.now_as_millis();
 new_cursor:=nextval('public.polis_coordinator_caching_tick');
 INSERT INTO public.math_main(zid,math_env,math_tick,data,last_vote_timestamp,caching_tick) VALUES(p_zid,p_env,new_tick,main_data,stamp,new_cursor)
 ON CONFLICT(zid,math_env) DO UPDATE SET math_tick=excluded.math_tick,data=excluded.data,last_vote_timestamp=excluded.last_vote_timestamp,caching_tick=excluded.caching_tick,modified=public.now_as_millis();
 INSERT INTO public.polis_coordinator_generations(math_env,zid,math_tick,caching_tick,owner_id,publisher_epoch,operation_id,capability_sha256,expected_tick,input_checkpoint)
 VALUES(p_env,p_zid,new_tick,new_cursor,p_owner,p_epoch,p_operation,capability_hash,p_expected_tick,recorded_checkpoint);
 INSERT INTO public.polis_coordinator_payloads(math_env,zid,math_tick,payload_kind,original_bytes,original_sha256,storage_sha256)
 VALUES(p_env,p_zid,new_tick,'main',p_main,originals->>'main',storage_hashes->>'main'),
 (p_env,p_zid,new_tick,'bidtopid',p_bidtopid,originals->>'bidtopid',storage_hashes->>'bidtopid'),
 (p_env,p_zid,new_tick,'ptptstats',p_ptptstats,originals->>'ptptstats',storage_hashes->>'ptptstats');
 INSERT INTO public.polis_coordinator_floors(math_env,zid,math_tick,caching_tick) VALUES(p_env,p_zid,new_tick,new_cursor)
 ON CONFLICT(math_env,zid) DO UPDATE SET math_tick=greatest(polis_coordinator_floors.math_tick,excluded.math_tick),caching_tick=greatest(polis_coordinator_floors.caching_tick,excluded.caching_tick);
 -- Remain pending until the controller reconciles the durable exact receipt.
 -- The final authorization remains under the same lease lock; renewal cannot
 -- extend through it. An exception rolls back every write in this call. It does
 -- NOT promise the caller's COMMIT completes before expiry. The caller must
 -- commit immediately and reconcile an ambiguous COMMIT by exact receipt.
 SELECT * INTO lease FROM public.polis_coordinator_leases WHERE math_env=p_env AND zid=p_zid FOR UPDATE;
 IF lease.owner_id IS DISTINCT FROM p_owner OR lease.owner_epoch IS DISTINCT FROM p_epoch THEN
  RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='FENCED'; END IF;
 IF lease.expires_at<=clock_timestamp()+make_interval(secs=>lease.dispatch_margin_ms::double precision/1000) THEN
  RAISE EXCEPTION USING ERRCODE='P2005',MESSAGE='LEASE-EXPIRED'; END IF;
 RETURN QUERY SELECT 'committed'::text,new_tick,new_cursor;
END $publish$;
ALTER FUNCTION public.pc_canonical(jsonb) OWNER TO polis_coordinator_publication_owner;
ALTER FUNCTION public.pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea) OWNER TO polis_coordinator_publication_owner;
REVOKE ALL ON FUNCTION public.pc_canonical(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea) TO polis_coordinator_publisher;

-- Control-only admission and reconciliation. The lock order is parent, lease,
-- namespace budget, operation. Namespace serialization also covers cleanup.
CREATE FUNCTION public.pc_admit(p_env text,p_zid integer,p_owner text,p_epoch bigint,p_operation text,
 p_source_sha256 text,p_reserved_bytes bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $admit_operation$
DECLARE lease public.polis_coordinator_leases; budget public.polis_coordinator_budgets;
 op public.polis_coordinator_operations; n bigint; used numeric;
BEGIN
 IF p_source_sha256 IS NULL OR p_source_sha256 !~ '^[0-9a-f]{64}$'
 OR p_reserved_bytes IS NULL OR p_reserved_bytes NOT BETWEEN 1048576 AND 1099511627776 THEN
  RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='INVALID_ADMISSION'; END IF;
 PERFORM zid FROM public.conversations WHERE zid=p_zid FOR KEY SHARE;
 SELECT * INTO lease FROM public.polis_coordinator_leases WHERE math_env=p_env AND zid=p_zid FOR UPDATE;
 IF lease.owner_id IS DISTINCT FROM p_owner OR lease.owner_epoch IS DISTINCT FROM p_epoch
 OR lease.dispatch_operation_id IS DISTINCT FROM p_operation OR lease.dispatch_operation_id IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='ADMISSION_IDENTITY_CONFLICT'; END IF;
 SELECT * INTO budget FROM public.polis_coordinator_budgets WHERE math_env=p_env FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2021',MESSAGE='ADMISSION_PROFILE_REQUIRED'; END IF;
 SELECT * INTO op FROM public.polis_coordinator_operations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation;
 IF FOUND THEN
  IF op.owner_id IS DISTINCT FROM p_owner OR op.owner_epoch IS DISTINCT FROM p_epoch
  OR op.expected_tick IS DISTINCT FROM lease.dispatch_expected_tick
  OR op.capability_sha256 IS DISTINCT FROM lease.dispatch_capability_sha256
  OR op.checkpoint_sha256 IS DISTINCT FROM lease.dispatch_checkpoint_sha256
  OR op.source_sha256 IS DISTINCT FROM p_source_sha256 OR op.reserved_bytes IS DISTINCT FROM p_reserved_bytes THEN
   RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='ADMISSION_IDENTITY_CONFLICT'; END IF;
  RETURN 'already_admitted';
 END IF;
 IF lease.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P2005',MESSAGE='LEASE-EXPIRED'; END IF;
 -- A compacted operation cannot be replayed at or below its generation floor.
 -- The same floor check is repeated by publication under these same locks.
 IF lease.dispatch_expected_tick IS DISTINCT FROM
  greatest((SELECT math_tick FROM public.math_ticks WHERE math_env=p_env AND zid=p_zid),
   (SELECT max(math_tick) FROM public.polis_coordinator_generations WHERE math_env=p_env AND zid=p_zid),
   (SELECT f.math_tick FROM public.polis_coordinator_floors f WHERE f.math_env=p_env AND f.zid=p_zid)) THEN
  RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='ADMISSION_TICK_CONFLICT'; END IF;
 SELECT count(*),coalesce(sum(reserved_bytes),0) INTO n,used FROM public.polis_coordinator_operations WHERE math_env=p_env;
 IF n>=budget.max_operations OR used+p_reserved_bytes>budget.max_bytes THEN
  RAISE EXCEPTION USING ERRCODE='P2021',MESSAGE='ADMISSION_CAPACITY'; END IF;
 INSERT INTO public.polis_coordinator_operations(math_env,zid,operation_id,owner_id,owner_epoch,expected_tick,
  capability_sha256,checkpoint_sha256,source_sha256,reserved_bytes)
 VALUES(p_env,p_zid,p_operation,p_owner,p_epoch,lease.dispatch_expected_tick,
  lease.dispatch_capability_sha256,lease.dispatch_checkpoint_sha256,p_source_sha256,p_reserved_bytes);
 RETURN 'admitted';
END $admit_operation$;
CREATE FUNCTION public.pc_reconcile(p_env text,p_zid integer,p_operation text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $reconcile_operation$
DECLARE op public.polis_coordinator_operations; receipt public.polis_coordinator_generations;
BEGIN
 PERFORM zid FROM public.conversations WHERE zid=p_zid FOR KEY SHARE;
 PERFORM 1 FROM public.polis_coordinator_leases WHERE math_env=p_env AND zid=p_zid FOR UPDATE;
 PERFORM 1 FROM public.polis_coordinator_budgets WHERE math_env=p_env FOR UPDATE;
 SELECT * INTO op FROM public.polis_coordinator_operations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='OPERATION_NOT_ADMITTED'; END IF;
 SELECT * INTO receipt FROM public.polis_coordinator_generations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation;
 IF FOUND THEN
  IF receipt.owner_id IS DISTINCT FROM op.owner_id OR receipt.publisher_epoch IS DISTINCT FROM op.owner_epoch
  OR receipt.capability_sha256 IS DISTINCT FROM op.capability_sha256 OR receipt.expected_tick IS DISTINCT FROM op.expected_tick
  OR encode(sha256(convert_to((receipt.input_checkpoint-ARRAY['operation_id','publisher_epoch','original_digests','payload_digests'])::text,'UTF8')),'hex') IS DISTINCT FROM op.checkpoint_sha256
  OR (SELECT count(*) FROM public.polis_coordinator_payloads WHERE math_env=p_env AND zid=p_zid AND math_tick=receipt.math_tick)<>3 THEN
   RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='RECEIPT_IDENTITY_CONFLICT'; END IF;
  UPDATE public.polis_coordinator_operations SET state='resolved',resolved_tick=receipt.math_tick,reconciled_at=clock_timestamp()
  WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation;
  RETURN 'resolved';
 END IF;
 -- An absent receipt never becomes proof that a dispatch did not commit.
 UPDATE public.polis_coordinator_operations SET state='unresolved',resolved_tick=NULL,reconciled_at=clock_timestamp()
 WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation;
 RETURN 'unresolved';
END $reconcile_operation$;
CREATE FUNCTION public.pc_protect(p_env text,p_zid integer,p_operation text,p_protected boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $protect_operation$
BEGIN
 IF p_protected IS NULL THEN RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='INVALID_PROTECTION'; END IF;
 PERFORM zid FROM public.conversations WHERE zid=p_zid FOR KEY SHARE;
 PERFORM 1 FROM public.polis_coordinator_leases WHERE math_env=p_env AND zid=p_zid FOR UPDATE;
 PERFORM 1 FROM public.polis_coordinator_budgets WHERE math_env=p_env FOR UPDATE;
 UPDATE public.polis_coordinator_operations SET protected=p_protected WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='OPERATION_NOT_ADMITTED'; END IF;
END $protect_operation$;
CREATE FUNCTION public.pc_reference(p_env text,p_zid integer,p_operation text,p_reference text,p_present boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $reference_operation$
BEGIN
 IF p_reference IS NULL OR length(p_reference) NOT BETWEEN 1 AND 128 OR p_present IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='INVALID_REFERENCE'; END IF;
 PERFORM zid FROM public.conversations WHERE zid=p_zid FOR KEY SHARE;
 PERFORM 1 FROM public.polis_coordinator_leases WHERE math_env=p_env AND zid=p_zid FOR UPDATE;
 PERFORM 1 FROM public.polis_coordinator_budgets WHERE math_env=p_env FOR UPDATE;
 PERFORM 1 FROM public.polis_coordinator_operations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2020',MESSAGE='OPERATION_NOT_ADMITTED'; END IF;
 IF NOT p_present THEN
  DELETE FROM public.polis_coordinator_references WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation AND reference_name=p_reference;
 ELSIF NOT EXISTS(SELECT FROM public.polis_coordinator_references WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation AND reference_name=p_reference) THEN
  IF (SELECT count(*) FROM public.polis_coordinator_references WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation)>=128 THEN
   RAISE EXCEPTION USING ERRCODE='P2021',MESSAGE='REFERENCE_CAPACITY'; END IF;
  INSERT INTO public.polis_coordinator_references VALUES(p_env,p_zid,p_operation,p_reference);
 END IF;
END $reference_operation$;
ALTER FUNCTION public.pc_reference(text,integer,text,text,boolean) OWNER TO polis_coordinator_owner;
REVOKE ALL ON FUNCTION public.pc_reference(text,integer,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pc_reference(text,integer,text,text,boolean) TO polis_coordinator_control;
CREATE FUNCTION public.pc_cleanup(p_env text,p_zid integer,p_operation text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $cleanup_operation$
DECLARE op public.polis_coordinator_operations; receipt public.polis_coordinator_generations;
BEGIN
 PERFORM zid FROM public.conversations WHERE zid=p_zid FOR KEY SHARE;
 PERFORM 1 FROM public.polis_coordinator_leases WHERE math_env=p_env AND zid=p_zid FOR UPDATE;
 PERFORM 1 FROM public.polis_coordinator_budgets WHERE math_env=p_env FOR UPDATE;
 SELECT * INTO op FROM public.polis_coordinator_operations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR op.state<>'resolved' OR op.protected THEN RETURN false; END IF;
 IF EXISTS(SELECT FROM public.polis_coordinator_references WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation) THEN RETURN false; END IF;
 SELECT * INTO receipt FROM public.polis_coordinator_generations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation;
 IF NOT FOUND OR receipt.math_tick IS DISTINCT FROM op.resolved_tick THEN RETURN false; END IF;
 -- Protect every actual current pointer, the durable floor, active expected
 -- generations and explicit operation references. Missing/regressed current
 -- rows cannot erase the maximum ever published generation or caching cursor.
 IF receipt.math_tick >= (SELECT f.math_tick FROM public.polis_coordinator_floors f WHERE f.math_env=p_env AND f.zid=p_zid)
 OR EXISTS(SELECT FROM public.math_ticks WHERE math_env=p_env AND zid=p_zid AND math_tick=receipt.math_tick)
 OR EXISTS(SELECT FROM public.math_main WHERE math_env=p_env AND zid=p_zid AND math_tick=receipt.math_tick)
 OR EXISTS(SELECT FROM public.math_bidtopid WHERE math_env=p_env AND zid=p_zid AND math_tick=receipt.math_tick)
 OR EXISTS(SELECT FROM public.math_ptptstats WHERE math_env=p_env AND zid=p_zid AND math_tick=receipt.math_tick)
 OR EXISTS(SELECT FROM public.polis_coordinator_operations WHERE math_env=p_env AND zid=p_zid
   AND (state<>'resolved' OR protected) AND (expected_tick=receipt.math_tick OR resolved_tick=receipt.math_tick))
 OR EXISTS(SELECT FROM public.polis_coordinator_leases WHERE math_env=p_env AND zid=p_zid AND dispatch_expected_tick=receipt.math_tick AND expires_at>clock_timestamp()) THEN
  RETURN false;
 END IF;
 IF NOT EXISTS(SELECT FROM public.polis_coordinator_floors WHERE math_env=p_env AND zid=p_zid AND math_tick>receipt.math_tick AND caching_tick>receipt.caching_tick) THEN
  RETURN false; END IF;
 DELETE FROM public.polis_coordinator_payloads WHERE math_env=p_env AND zid=p_zid AND math_tick=receipt.math_tick;
 DELETE FROM public.polis_coordinator_generations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation;
 DELETE FROM public.polis_coordinator_operations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation;
 RETURN true;
END $cleanup_operation$;
ALTER FUNCTION public.pc_admit(text,integer,text,bigint,text,text,bigint) OWNER TO polis_coordinator_owner;
ALTER FUNCTION public.pc_reconcile(text,integer,text) OWNER TO polis_coordinator_owner;
ALTER FUNCTION public.pc_protect(text,integer,text,boolean) OWNER TO polis_coordinator_owner;
ALTER FUNCTION public.pc_cleanup(text,integer,text) OWNER TO polis_coordinator_owner;
REVOKE ALL ON FUNCTION public.pc_admit(text,integer,text,bigint,text,text,bigint),public.pc_reconcile(text,integer,text),public.pc_protect(text,integer,text,boolean),public.pc_cleanup(text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pc_admit(text,integer,text,bigint,text,text,bigint),public.pc_reconcile(text,integer,text),public.pc_protect(text,integer,text,boolean),public.pc_cleanup(text,integer,text) TO polis_coordinator_control;

$authority$;
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
  coalesce((SELECT max(caching_tick) FROM public.polis_coordinator_generations),1),
  coalesce((SELECT max(caching_tick) FROM public.polis_coordinator_floors),1)) THEN
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
DO $record$
BEGIN
 IF NOT current_setting('polis_coordinator.replay')::boolean THEN
  INSERT INTO public.polis_coordinator_install(singleton,migration_id,catalog_fingerprint,provenance_fingerprint,sequence_start,installed_by)
  VALUES(true,'000021',pg_temp.pc_catalog(),pg_temp.pc_provenance_hash(),(SELECT seqstart FROM pg_sequence WHERE seqrelid='public.polis_coordinator_caching_tick'::regclass),session_user);
 END IF;
 IF pg_temp.pc_catalog() IS DISTINCT FROM 'dd88a9711bbdac72155d4e8862052c4b' THEN
  RAISE EXCEPTION 'refusing: coordinator catalog assertion' USING DETAIL=pg_temp.pc_catalog(); END IF;
 PERFORM pg_temp.pc_assert_provenance();
END $record$;
COMMIT;
