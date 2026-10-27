-- Reversal of 000045_page_ids_width.sql. Never run automatically.
-- Narrowing may rewrite the table and requires ACCESS EXCLUSIVE. Refuse if
-- any identity exceeds the old limit: never truncate or change page identity.
-- The operator reconciles runner history only after this succeeds.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.page_ids IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.page_ids
               WHERE char_length(page_id) > 100 OR char_length(site_id) > 100) THEN
        RAISE EXCEPTION 'page_ids contains identities longer than 100 characters';
    END IF;
END;
$$;
ALTER TABLE public.page_ids
    ALTER COLUMN page_id TYPE varchar(100),
    ALTER COLUMN site_id TYPE varchar(100);
COMMIT;
