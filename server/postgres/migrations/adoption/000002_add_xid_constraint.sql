-- Both the public bootstrap variant (owner,xid only) and the authoritative
-- legacy variant (also owner,uid) are supported. Never drop either invariant.
SELECT pg_temp.con_exact('xids','UNIQUE (owner, xid)')
 -- If the optional legacy unique index exists, it must enforce the complete key.
 AND NOT EXISTS (
   SELECT 1 FROM pg_index i
   JOIN pg_attribute owner ON owner.attrelid=i.indrelid AND owner.attname='owner'
   JOIN pg_attribute uid ON uid.attrelid=i.indrelid AND uid.attname='uid'
   WHERE i.indrelid=to_regclass('public.xids') AND i.indisunique
     AND i.indnkeyatts=2
     AND ARRAY[i.indkey[0],i.indkey[1]] @> ARRAY[owner.attnum,uid.attnum]
     AND (NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive
          OR NOT i.indimmediate OR i.indpred IS NOT NULL)
 );
