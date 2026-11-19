-- down/000048_drop_delphi_entitlements.sql
--
-- Reverses 000048_create_delphi_entitlements.sql: drops the table it created.
-- Never run automatically. It refuses while any row is stored, so no recorded
-- permission is lost by accident; to drop recorded permissions too, delete the
-- rows first, deliberately, in their own statement. Nothing else depends on
-- the table. A server with POLIS_DELPHI_ENTITLEMENT=claim (the default) never
-- reads it; set that first.
--
-- Locks. Dropping the table removes its two foreign keys to public.users,
-- which takes ACCESS EXCLUSIVE on users until COMMIT (measured on PostgreSQL
-- 17.11; dropping the constraints first takes the same lock). Every read and
-- write of users waits for those milliseconds, or for at most lock_timeout
-- (5 s) while an open transaction holds users, after which this fails with
-- nothing changed.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000048_drop_delphi_entitlements.sql
--
-- Runner history is not edited here; the operator removes the 000048 history
-- row in the same sitting, after this succeeds.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.delphi_entitlements IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.delphi_entitlements) THEN
        RAISE EXCEPTION 'delphi_entitlements has rows; delete them deliberately first';
    END IF;
END;
$$;
DROP TABLE public.delphi_entitlements;
COMMIT;
