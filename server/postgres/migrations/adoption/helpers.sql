-- Reconciliation only. These pg_temp helpers vanish when the connection closes.
-- A nullability/default argument checks only when specified by that migration.
CREATE FUNCTION pg_temp.col(t text,c text,typ text,nn boolean DEFAULT NULL,def text DEFAULT NULL)
RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM pg_attribute a
 LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid=to_regclass('public.'||t) AND a.attname=c AND NOT a.attisdropped
 AND (format_type(a.atttypid,a.atttypmod)=typ
      -- Exact public bootstrap alternatives to the authoritative legacy contract.
      OR (t='worker_tasks' AND c='task_type' AND typ='text'
          AND format_type(a.atttypid,a.atttypmod)='character varying(99)')
      OR (t IN ('pwreset_tokens','password_reset_tokens')
          AND c IN ('token','pwresettoken') AND typ='character varying(100)'
          AND format_type(a.atttypid,a.atttypmod)='character varying(250)')
      -- Only historical math payloads have an established json equivalent.
      -- Do not adopt arbitrary json columns in newer jsonb contracts.
      OR (typ='jsonb' AND a.atttypid='json'::regtype AND c='data'
          AND t IN ('math_main','math_profile','math_ptptstats','math_cache',
                    'math_bidtopid','math_exportstatus')))
 AND (nn IS NULL OR a.attnotnull=nn)
 AND (def IS NULL OR pg_get_expr(d.adbin,d.adrelid)=def));
$$;
CREATE FUNCTION pg_temp.con(t text,definition text) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.'||t)
 AND convalidated AND pg_get_constraintdef(oid)=definition);
$$;
CREATE FUNCTION pg_temp.idx(n text,definition text) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.'||n)
 AND indisvalid AND indisready AND pg_get_indexdef(indexrelid)=definition);
$$;
CREATE FUNCTION pg_temp.absent_column(t text,c text) RETURNS boolean LANGUAGE sql AS $$
 SELECT to_regclass('public.'||t) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_attribute
 WHERE attrelid=to_regclass('public.'||t) AND attname=c AND NOT attisdropped);
$$;

-- Full contracts for newly created columns. NULL means no default, not a wildcard.
-- Keep col() unchanged for legacy/core and ALTER TYPE-only postconditions.
CREATE FUNCTION pg_temp.col_exact(t text,c text,typ text,nn boolean,def text DEFAULT NULL)
RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM pg_attribute a
 LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid=to_regclass('public.'||t) AND a.attname=c AND NOT a.attisdropped
 AND format_type(a.atttypid,a.atttypmod)=typ AND a.attnotnull=nn
 AND a.attidentity='' AND a.attgenerated=''
 AND pg_get_expr(d.adbin,d.adrelid) IS NOT DISTINCT FROM def);
$$;
-- Definition checks include actions/keys; catalog flags also require enforcement.
-- Preserve the legacy helper for contracts awaiting a separate policy decision.
CREATE FUNCTION pg_temp.con_exact(t text,definition text) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM pg_constraint c
 WHERE c.conrelid=to_regclass('public.'||t)
 AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
 AND pg_get_constraintdef(c.oid)=definition
 AND (c.contype NOT IN ('p','u') OR EXISTS (
   SELECT 1 FROM pg_index i WHERE i.indexrelid=c.conindid
   AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate))
 AND NOT EXISTS (SELECT 1 FROM pg_trigger tr
   WHERE tr.tgconstraint=c.oid AND tr.tgenabled <> 'O'));
$$;
