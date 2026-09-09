-- 000019_drop_polis_queue.sql  (reversal of 000019_create_polis_queue.sql)
--
-- P-024 Postgres queue substrate, contract polis-queue/1: the down script.
-- Colin's ruling: a written, tested down script is a precondition for ever
-- applying 000019 to production. This is that script. See the "Reversal"
-- section of docs/queue-substrate.md for the runbook.
--
-- WHAT IT REMOVES, AND ONLY WHAT 000019 PROVABLY CREATED
-- -----------------------------------------------------
-- The up migration ACCEPTS pre-existing NOLOGIN owner/executor roles and does
-- not require that they own nothing else. So this script does NOT trust names.
-- It removes an object only after proving the installed schema matches 000019's
-- OWN catalog fingerprint -- the table-md5 map, the 21-signature array, and a
-- per-function digest that hashes each prosrc BODY along with its result,
-- argument types, volatility, security-definer flag, config, owner and ACL --
-- then drops exactly its enumerated inventory by full signature:
--   * the trigger pq_no_regression on public.polis_queue_heads
--   * the 21 public.pq_* functions (dropped by full argument signature)
--   * the 9 explicitly-created indexes (the rest go with their tables)
--   * the 5 tables polis_queue_{runs,heads,jobs,attempts,requests}
--   * the schema-level grants 000019 made, and the conversations grant, via REVOKE
--   * the two NOLOGIN roles -- ONLY if each role's ENTIRE footprint equals what
--     000019 establishes. Because the up migration ADOPTS a pre-existing role,
--     existence is not provenance: the script compares the live role's pg_roles
--     attributes (default NOLOGIN), its pg_db_role_setting settings (000019 sets
--     none), and every grant involving it on public/conversations against
--     000019's exact expected set, plus pg_shdepend/pg_auth_members for any
--     other owned object, grant or membership. ANY extra attribute, setting or
--     grant means the role was adopted or altered: REFUSE, name the extras, and
--     revoke NOTHING (an operator's own grant is never erased).
-- It touches no object 000019 did not create; public.conversations and the
-- public schema themselves are left alone.
--
-- REFUSALS (all roll the whole transaction back, drop nothing)
-- -----------------------------------------------------------
--   * Live queue: any polis_queue_* table holds rows, without -v force=1.
--   * Drift / collision: queue-named objects exist but do not match 000019's
--     fingerprint (an unrelated public.pq_* function, an added overload, an
--     altered table, or a body-only rewrite of a function).
--   * Adopted role: a queue role carries an attribute, a role-level setting, or
--     a grant/ownership/membership beyond exactly what 000019 establishes --
--     named in the message; nothing is revoked or dropped.
-- force overrides ONLY the live-queue refusal. It never overrides a drift or
-- adopted-role refusal.
--
-- CONCURRENCY
-- -----------
-- The five tables are locked ACCESS EXCLUSIVE, in a fixed order, BEFORE the row
-- count, and held through COMMIT. A concurrent writer therefore either committed
-- before the count (and is seen, causing refusal) or cannot insert until the
-- reversal finishes; a counted-empty table cannot be populated behind the count.
-- lock_timeout bounds the wait (default 5s, override -v lock_timeout=...).
-- Stop/drain the operational writers too; the lock is a guard, not a substitute.
--
-- HOW TO APPLY
-- ------------
-- Run THIS FILE ALONE, manually, as a superuser (postgres), exactly as
-- docs/migrations.md applies a file:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
--     < server/postgres/migrations/down/000019_drop_polis_queue.sql
--
-- Deliberate override of the live-queue guard only:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -v force=1 -U postgres \
--     -d polis-dev < server/postgres/migrations/down/000019_drop_polis_queue.sql
--
-- IDEMPOTENCE: one transaction. When no queue table, no pq_ function and no
-- queue role exist, it is a no-op that emits a NOTICE. Re-running after a
-- successful down is the same no-op.

\set ON_ERROR_STOP on

-- Default force to 0 unless the operator passed -v force=1.
\if :{?force}
\else
  \set force 0
\endif

-- Bounded wait for the destructive table locks.
\if :{?lock_timeout}
\else
  \set lock_timeout '5s'
\endif

BEGIN;

SET LOCAL lock_timeout = :'lock_timeout';

-- Mirror of 000019's pq_catalog (000019:116-128): the per-table catalog
-- fingerprint source. Identical code + PostgreSQL 17 + fixed search_path give
-- the identical md5 that 000019 pins and asserts on itself, so a table that
-- matches here is provably the table 000019 created.
CREATE FUNCTION pg_temp.pqd_catalog(p_table oid) RETURNS jsonb
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

-- -------------------------------------------------------------------------
-- PHASE 1: lock every present queue table against writers, in a fixed order,
-- BEFORE counting. Held to COMMIT. (Astra P2: count-before-lock races.)
--
-- Order is CHILDREN BEFORE PARENTS (requests/attempts, then jobs/heads, then
-- runs). A writer inserting a child row holds ROW EXCLUSIVE on that child and
-- then needs a KEY/ROW SHARE lock on the parent for FK validation. Locking the
-- parents last means this reversal never holds a parent's ACCESS EXCLUSIVE lock
-- while a writer, holding the child, waits for that parent -- which would
-- deadlock. Locking parents-first does deadlock; this order does not.
-- -------------------------------------------------------------------------
DO $lock$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'polis_queue_requests','polis_queue_attempts','polis_queue_jobs',
    'polis_queue_heads','polis_queue_runs']
  LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
    END IF;
  END LOOP;
END $lock$;

-- -------------------------------------------------------------------------
-- PHASE 2: row count UNDER the lock; refuse a live queue unless force=1.
-- -------------------------------------------------------------------------
DO $count$
DECLARE total bigint := 0; n bigint; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'polis_queue_runs','polis_queue_heads','polis_queue_jobs',
    'polis_queue_attempts','polis_queue_requests']
  LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      total := total + n;
    END IF;
  END LOOP;
  PERFORM set_config('polis_queue.down_rowcount', total::text, true);
END $count$;

SELECT current_setting('polis_queue.down_rowcount')::bigint AS pq_rows \gset
SELECT CASE WHEN (:pq_rows > 0 AND :'force' <> '1') THEN 'true' ELSE 'false' END
  AS pq_refuse \gset

\if :pq_refuse
DO $refuse$
BEGIN
  RAISE EXCEPTION
    'polis_queue_* tables contain % row(s); refusing to drop a live queue. '
    'Re-run with  -v force=1  to override.',
    current_setting('polis_queue.down_rowcount');
END $refuse$;
\endif

-- -------------------------------------------------------------------------
-- PHASE 3: provenance gate, then bounded removal. One block so the decision
-- and the drops share a transaction and roll back together.
-- -------------------------------------------------------------------------
DO $main$
DECLARE
  -- 000019's own pins (000019:131,153,179). A match here proves provenance.
  expected_tables jsonb := '{"polis_queue_attempts": "4bf01840303c3447650ada377d535bee", "polis_queue_heads": "cf987d5673228e6ca6d6f3b86b7e77e5", "polis_queue_jobs": "d8367b8bdaa7701b9c377450d23b5db5", "polis_queue_requests": "cae8fcd4db4562b9936b7d33cf598f1e", "polis_queue_runs": "8e7fd316c23320c229387822146eebec"}'::jsonb;
  expected_signatures text[] := ARRAY['pq_backoff(uuid, integer)','pq_cancel(text, uuid, bigint)','pq_claim(text, smallint, uuid, uuid, integer)','pq_due(text, uuid, integer)','pq_end_attempt(text, uuid, uuid, uuid, bigint, text, text)','pq_enqueue(text, integer, text, text, text, text, uuid, uuid, text, text, text, text, smallint, integer)','pq_fail(text, uuid, uuid, uuid, bigint, boolean, text)','pq_finalize(text, uuid, uuid, uuid, bigint, text, text)','pq_head_status(text, text)','pq_heartbeat(text, uuid, uuid, uuid, bigint, integer)','pq_job_status(text, uuid)','pq_lock(text, uuid, boolean, boolean)','pq_no_regression()','pq_owns(public.polis_queue_jobs, uuid, uuid, bigint)','pq_park(text, uuid, uuid, uuid, bigint, text)','pq_publish_allowed(public.polis_queue_heads, public.polis_queue_runs)','pq_reap(text, uuid, integer)','pq_reap_one(text, uuid)','pq_release(text, uuid, uuid, uuid, bigint)','pq_result(text, public.polis_queue_jobs, boolean)','pq_terminate_attempt(public.polis_queue_jobs, text, text, text, boolean)'];
  -- Body-inclusive per-function digest. 000019's own pin covers signature,
  -- result, volatility, security_definer, config, owner and ACL but NOT prosrc,
  -- so a body-only rewrite (e.g. pq_backoff made to return 777) would pass it.
  -- This digest adds prosrc, so a drifted body is caught. It is 000019's fresh
  -- catalog value on PostgreSQL 17 with the body field present, recomputed in
  -- the same reviewed change if any function body changes.
  expected_function_md5 constant text := '246ed8c30b7ca049563046085a9f221c';
  -- The 12 functions 000019 grants EXECUTE to the executor (000019:574).
  granted_execute constant text[] := ARRAY[
    'pq_cancel','pq_claim','pq_due','pq_enqueue','pq_fail','pq_finalize','pq_head_status',
    'pq_heartbeat','pq_job_status','pq_park','pq_reap_one','pq_release'];

  present_tables text[]; present_sigs text[];
  roles_present boolean; actual_fn_md5 text; entry record;
  pubowner text; convowner text; actual_acl text[]; expected_acl text[]; onward text;
  rname text; rid oid; attr_txt text; settings_txt text; extradep text; memberships bigint;
BEGIN
  -- 000019 computes its signature/function fingerprints under this exact
  -- search_path (its guard functions carry SET search_path=pg_catalog,pg_temp),
  -- which is what makes oidvectortypes schema-qualify public row-types as
  -- "public.polis_queue_jobs". Match it, or the fingerprints will never agree.
  -- Every object reference below is fully schema-qualified, so this is safe.
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);

  SELECT array_agg(relname::text ORDER BY relname) INTO present_tables FROM pg_class
   WHERE relnamespace='public'::regnamespace AND starts_with(relname,'polis_queue_')
     AND relkind IN ('r','p','v','m','f');
  SELECT array_agg(proname || '(' || oidvectortypes(proargtypes) || ')'
                   ORDER BY proname || '(' || oidvectortypes(proargtypes) || ')')
    INTO present_sigs FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pq_');
  roles_present := EXISTS (SELECT 1 FROM pg_roles
                           WHERE rolname IN ('polis_queue_owner','polis_queue_executor'));

  -- (i) Truly absent: nothing queue-shaped anywhere -> genuine no-op.
  IF present_tables IS NULL AND present_sigs IS NULL AND NOT roles_present THEN
    RAISE NOTICE
      'polis_queue objects not present; 000019 was never applied. Nothing to drop.';
    RETURN;
  END IF;

  -- (ii) Something queue-shaped exists: it must PROVABLY be 000019's, or refuse.
  IF present_tables IS DISTINCT FROM ARRAY(SELECT jsonb_object_keys(expected_tables) ORDER BY 1) THEN
    RAISE EXCEPTION 'refusing: public.polis_queue_* tables do not match 000019'
      USING DETAIL = 'found tables: ' || COALESCE(array_to_string(present_tables, ', '), '(none)') ||
                     '; 000019 defines exactly its five. Resolve by hand.';
  END IF;
  FOR entry IN SELECT * FROM jsonb_each_text(expected_tables) LOOP
    IF md5(pg_temp.pqd_catalog(to_regclass('public.'||entry.key))::text) IS DISTINCT FROM entry.value THEN
      RAISE EXCEPTION 'refusing: table public.% does not match 000019''s fingerprint (drift). Resolve by hand.', entry.key;
    END IF;
  END LOOP;
  IF present_sigs IS DISTINCT FROM expected_signatures THEN
    RAISE EXCEPTION 'refusing: public.pq_* functions do not match 000019'
      USING DETAIL = 'found signatures: ' || COALESCE(array_to_string(present_sigs, ', '), '(none)') ||
                     '; 000019 defines exactly its 21. An unrelated pq_* function or overload must be resolved by hand.';
  END IF;
  SELECT md5((SELECT jsonb_agg(jsonb_build_object(
   'signature',p.proname || '(' || oidvectortypes(p.proargtypes) || ')',
   'result',pg_get_function_result(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),
   'language',l.lanname,'kind',p.prokind,'security_definer',p.prosecdef,
   'volatility',p.provolatile,'parallel',p.proparallel,'strict',p.proisstrict,
   'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'body',p.prosrc,
   'acl',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
   ORDER BY a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable)
   FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)
   ) ORDER BY p.proname) FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'pq_'))::text)
   INTO actual_fn_md5;
  IF actual_fn_md5 IS DISTINCT FROM expected_function_md5 THEN
    RAISE EXCEPTION 'refusing: a pq_* function''s body, result, volatility, config, owner or ACL does not match 000019''s fingerprint (drift). Resolve by hand.';
  END IF;

  -- Provably 000019's schema. Remove its inventory in dependency order.
  DROP TRIGGER IF EXISTS pq_no_regression ON public.polis_queue_heads;

  -- Functions by FULL signature (row-type args resolve: the tables still exist).
  DROP FUNCTION IF EXISTS public.pq_enqueue(text, integer, text, text, text, text, uuid, uuid, text, text, text, text, smallint, integer);
  DROP FUNCTION IF EXISTS public.pq_claim(text, smallint, uuid, uuid, integer);
  DROP FUNCTION IF EXISTS public.pq_heartbeat(text, uuid, uuid, uuid, bigint, integer);
  DROP FUNCTION IF EXISTS public.pq_finalize(text, uuid, uuid, uuid, bigint, text, text);
  DROP FUNCTION IF EXISTS public.pq_fail(text, uuid, uuid, uuid, bigint, boolean, text);
  DROP FUNCTION IF EXISTS public.pq_release(text, uuid, uuid, uuid, bigint);
  DROP FUNCTION IF EXISTS public.pq_park(text, uuid, uuid, uuid, bigint, text);
  DROP FUNCTION IF EXISTS public.pq_due(text, uuid, integer);
  DROP FUNCTION IF EXISTS public.pq_reap_one(text, uuid);
  DROP FUNCTION IF EXISTS public.pq_reap(text, uuid, integer);
  DROP FUNCTION IF EXISTS public.pq_cancel(text, uuid, bigint);
  DROP FUNCTION IF EXISTS public.pq_job_status(text, uuid);
  DROP FUNCTION IF EXISTS public.pq_head_status(text, text);
  DROP FUNCTION IF EXISTS public.pq_end_attempt(text, uuid, uuid, uuid, bigint, text, text);
  DROP FUNCTION IF EXISTS public.pq_terminate_attempt(public.polis_queue_jobs, text, text, text, boolean);
  DROP FUNCTION IF EXISTS public.pq_publish_allowed(public.polis_queue_heads, public.polis_queue_runs);
  DROP FUNCTION IF EXISTS public.pq_lock(text, uuid, boolean, boolean);
  DROP FUNCTION IF EXISTS public.pq_owns(public.polis_queue_jobs, uuid, uuid, bigint);
  DROP FUNCTION IF EXISTS public.pq_backoff(uuid, integer);
  DROP FUNCTION IF EXISTS public.pq_result(text, public.polis_queue_jobs, boolean);
  DROP FUNCTION IF EXISTS public.pq_no_regression();

  -- The 9 explicit indexes (PK/UNIQUE indexes go with their tables below).
  DROP INDEX IF EXISTS public.polis_queue_ready;
  DROP INDEX IF EXISTS public.polis_queue_running;
  DROP INDEX IF EXISTS public.polis_queue_exhausted;
  DROP INDEX IF EXISTS public.polis_queue_parked;
  DROP INDEX IF EXISTS public.polis_queue_heads_zid;
  DROP INDEX IF EXISTS public.polis_queue_runs_zid;
  DROP INDEX IF EXISTS public.polis_queue_runs_history;
  DROP INDEX IF EXISTS public.polis_queue_requests_run;
  DROP INDEX IF EXISTS public.polis_queue_requests_job;

  -- The five tables (one statement; inter-table FKs resolve within the set). No
  -- CASCADE: an outside dependency (e.g. a view) fails here and rolls back.
  DROP TABLE IF EXISTS
    public.polis_queue_requests,
    public.polis_queue_attempts,
    public.polis_queue_jobs,
    public.polis_queue_heads,
    public.polis_queue_runs;

  -- ---------------------------------------------------------------------
  -- Role provenance. 000019 ADOPTS a pre-existing NOLOGIN owner/executor
  -- (it CREATEs each only when absent), so a role's mere existence does not
  -- make it 000019's. A role is 000019's to drop ONLY if its ENTIRE live
  -- footprint equals what 000019 establishes: a default NOLOGIN role with no
  -- role-level settings, owning nothing beyond the (fingerprint-verified) queue
  -- objects just dropped, and holding exactly 000019's grants -- USAGE + CREATE
  -- on public and, for owner, SELECT/UPDATE(topic)/REFERENCES(zid) on
  -- conversations. ANY extra attribute, setting, or grant means the role was
  -- adopted or altered: REFUSE, name the extras, and revoke NOTHING. All of this
  -- is checked BEFORE any revoke, so an adopted grant is never erased.
  -- ---------------------------------------------------------------------
  pubowner  := pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname='public'));
  convowner := pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.conversations'::regclass));

  -- 000019's exact grant footprint involving the roles, on the objects it
  -- touches outside the queue objects: schema public and conversations. Owner's
  -- own onward grants are BY owner; the applier-made grants record the object's
  -- OWNER as grantor (a superuser GRANT records the object owner). Entries render
  -- as  object|grantee|grantor|privilege|grantable.
  expected_acl := ARRAY[]::text[];
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='polis_queue_owner') THEN
    expected_acl := expected_acl || ARRAY[
      'public|polis_queue_owner|'||pubowner||'|USAGE|true',
      'public|polis_queue_owner|'||pubowner||'|CREATE|false',
      'public|polis_queue_owner|polis_queue_owner|USAGE|false',
      'conversations|polis_queue_owner|'||convowner||'|SELECT|false',
      'conversations.topic|polis_queue_owner|'||convowner||'|UPDATE|false',
      'conversations.zid|polis_queue_owner|'||convowner||'|REFERENCES|false'];
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='polis_queue_executor') THEN
    expected_acl := expected_acl || ARRAY['public|polis_queue_executor|polis_queue_owner|USAGE|false'];
  END IF;

  SELECT COALESCE(array_agg(e ORDER BY e), ARRAY[]::text[]) INTO actual_acl FROM (
    SELECT 'public|'||pg_get_userbyid(a.grantee)||'|'||pg_get_userbyid(a.grantor)||'|'||a.privilege_type||'|'||a.is_grantable::text AS e
      FROM pg_namespace n, aclexplode(n.nspacl) a
     WHERE n.nspname='public' AND pg_get_userbyid(a.grantee) IN ('polis_queue_owner','polis_queue_executor')
    UNION ALL
    SELECT 'conversations|'||pg_get_userbyid(a.grantee)||'|'||pg_get_userbyid(a.grantor)||'|'||a.privilege_type||'|'||a.is_grantable::text
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid='public.conversations'::regclass AND pg_get_userbyid(a.grantee) IN ('polis_queue_owner','polis_queue_executor')
    UNION ALL
    SELECT 'conversations.'||att.attname||'|'||pg_get_userbyid(a.grantee)||'|'||pg_get_userbyid(a.grantor)||'|'||a.privilege_type||'|'||a.is_grantable::text
      FROM pg_attribute att, aclexplode(att.attacl) a
     WHERE att.attrelid='public.conversations'::regclass AND att.attnum>0
       AND pg_get_userbyid(a.grantee) IN ('polis_queue_owner','polis_queue_executor')
  ) s;

  -- Set comparison (order-independent): the symmetric difference must be empty.
  IF EXISTS (SELECT unnest(actual_acl) EXCEPT SELECT unnest(expected_acl))
     OR EXISTS (SELECT unnest(expected_acl) EXCEPT SELECT unnest(actual_acl)) THEN
    RAISE EXCEPTION 'refusing: a queue role holds a public/conversations grant 000019 did not establish (adopted or altered role)'
      USING DETAIL = 'extra: '||COALESCE(NULLIF(array_to_string(ARRAY(SELECT unnest(actual_acl) EXCEPT SELECT unnest(expected_acl)),'; '),''),'(none)')
                   ||' | missing: '||COALESCE(NULLIF(array_to_string(ARRAY(SELECT unnest(expected_acl) EXCEPT SELECT unnest(actual_acl)),'; '),''),'(none)'),
           HINT = 'The up migration adopts a pre-existing role; extra grants are the operator''s. Resolve by hand; nothing was revoked.';
  END IF;

  -- A queue role must not be the GRANTOR of any public grant to a third party
  -- (000019's only onward grants are owner->owner and owner->executor). Such a
  -- grant would be swept by the CASCADE below, so refuse instead.
  SELECT string_agg(DISTINCT pg_get_userbyid(a.grantee), ', ') INTO onward
    FROM pg_namespace n, aclexplode(n.nspacl) a
   WHERE n.nspname='public'
     AND pg_get_userbyid(a.grantor) IN ('polis_queue_owner','polis_queue_executor')
     AND pg_get_userbyid(a.grantee) NOT IN ('polis_queue_owner','polis_queue_executor');
  IF onward IS NOT NULL THEN
    RAISE EXCEPTION 'refusing: a queue role granted schema public onward to %, which 000019 did not do', onward
      USING HINT = 'Resolve by hand; nothing was revoked.';
  END IF;

  -- Per role: exactly a default NOLOGIN role, no role-level settings, no
  -- ownership of or grant on any object beyond public/conversations (the queue
  -- objects were dropped above), and no memberships. Any extra -> refuse.
  FOREACH rname IN ARRAY ARRAY['polis_queue_executor','polis_queue_owner'] LOOP
    SELECT oid INTO rid FROM pg_roles WHERE rolname=rname;
    IF rid IS NULL THEN CONTINUE; END IF;

    SELECT string_agg(x, ', ') INTO attr_txt
      FROM pg_roles r, LATERAL unnest(ARRAY[
        CASE WHEN r.rolcanlogin    THEN 'LOGIN' END,
        CASE WHEN r.rolsuper       THEN 'SUPERUSER' END,
        CASE WHEN r.rolcreaterole  THEN 'CREATEROLE' END,
        CASE WHEN r.rolcreatedb    THEN 'CREATEDB' END,
        CASE WHEN r.rolreplication THEN 'REPLICATION' END,
        CASE WHEN r.rolbypassrls   THEN 'BYPASSRLS' END,
        CASE WHEN NOT r.rolinherit THEN 'NOINHERIT' END,
        CASE WHEN r.rolconnlimit <> -1 THEN 'CONNLIMIT='||r.rolconnlimit::text END,
        CASE WHEN r.rolvaliduntil IS NOT NULL THEN 'VALID UNTIL '||r.rolvaliduntil::text END
      ]) AS t(x) WHERE r.oid=rid AND t.x IS NOT NULL;

    SELECT string_agg(array_to_string(setconfig, ','), '; ') INTO settings_txt
      FROM pg_db_role_setting WHERE setrole=rid;

    SELECT string_agg(
             CASE WHEN classid='pg_class'::regclass THEN COALESCE(objid::regclass::text,'pg_class#'||objid::text)
                  WHEN classid='pg_namespace'::regclass THEN 'schema '||COALESCE((SELECT nspname FROM pg_namespace WHERE oid=objid),objid::text)
                  ELSE classid::regclass::text||'#'||objid::text END
             ||' ['||deptype::text||']', ', ' ORDER BY 1)
      INTO extradep
      FROM pg_shdepend
     WHERE refclassid='pg_authid'::regclass AND refobjid=rid
       AND dbid IN (0, (SELECT oid FROM pg_database WHERE datname=current_database()))
       AND NOT (classid='pg_namespace'::regclass AND objid='public'::regnamespace)
       AND NOT (classid='pg_class'::regclass AND objid='public.conversations'::regclass);

    SELECT count(*) INTO memberships FROM pg_auth_members WHERE roleid=rid OR member=rid;

    IF attr_txt IS NOT NULL OR settings_txt IS NOT NULL OR extradep IS NOT NULL OR memberships > 0 THEN
      RAISE EXCEPTION 'refusing to drop role %: it was adopted or altered, not established by 000019', rname
        USING DETAIL = concat_ws('; ',
          CASE WHEN attr_txt     IS NOT NULL THEN 'extra attribute(s): '||attr_txt END,
          CASE WHEN settings_txt IS NOT NULL THEN 'role-level setting(s): '||settings_txt END,
          CASE WHEN extradep     IS NOT NULL THEN 'owns/holds beyond 000019: '||extradep END,
          CASE WHEN memberships  > 0 THEN memberships||' membership grant(s)' END),
           HINT = 'The up migration adopts a pre-existing role; this footprint is not 000019''s. Resolve by hand; nothing was revoked.';
    END IF;
  END LOOP;

  -- Every role is provably 000019's and nothing else. NOW revoke 000019's exact
  -- grants and drop. The CASCADE clears owner's grantable USAGE and the onward
  -- grants that depend on it (owner-self and executor) -- verified above to be
  -- 000019's only onward grants, so it sweeps nothing the operator added.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='polis_queue_owner') THEN
    REVOKE USAGE, CREATE ON SCHEMA public FROM polis_queue_owner CASCADE;
    REVOKE SELECT, REFERENCES(zid), UPDATE(topic) ON public.conversations FROM polis_queue_owner;
  END IF;
  FOREACH rname IN ARRAY ARRAY['polis_queue_executor','polis_queue_owner'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=rname) THEN
      EXECUTE format('DROP ROLE %I', rname);
    END IF;
  END LOOP;
END $main$;

COMMIT;
