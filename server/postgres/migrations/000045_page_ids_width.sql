-- 000045_page_ids_width.sql
--
-- Embed identities can contain up to 2,000 characters. Widening varchar(100)
-- to varchar(2000) is a metadata-only change in Postgres: no table rewrite or
-- stored-value conversion. The UNIQUE(site_id, page_id) constraint is retained.
-- Compatibility: additive. Old servers can keep reading and writing while this
-- schema is installed, including during a rolling application replacement.
-- ALTER TABLE takes ACCESS EXCLUSIVE until commit; reads and writes briefly
-- wait. The 5 s lock timeout bounds acquisition; failure rolls everything back.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.page_ids
    ALTER COLUMN page_id TYPE varchar(2000),
    ALTER COLUMN site_id TYPE varchar(2000);
COMMIT;
