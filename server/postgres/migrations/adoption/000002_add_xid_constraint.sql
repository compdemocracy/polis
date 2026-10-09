-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.con('xids','UNIQUE (owner, xid)')
 AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.xids') AND conname='xids_owner_uid_key');
