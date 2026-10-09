-- Reconciliation only. These pg_temp helpers vanish when the connection closes.
-- A nullability/default argument checks only when specified by that migration.
CREATE FUNCTION pg_temp.col(t text,c text,typ text,nn boolean DEFAULT NULL,def text DEFAULT NULL)
RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM pg_attribute a
 LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid=to_regclass('public.'||t) AND a.attname=c AND NOT a.attisdropped
 AND (format_type(a.atttypid,a.atttypmod)=typ
      -- Historical deployments have json where fresh schema says jsonb.
      OR (typ='jsonb' AND a.atttypid='json'::regtype))
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
