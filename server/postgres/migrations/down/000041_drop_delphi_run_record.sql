-- down/000041_drop_delphi_run_record.sql
--
-- Reverses 000041_create_delphi_run_record.sql: drops the one read function it
-- created. The function stores nothing and nothing else depends on it, so the
-- reversal loses no data; a reader that calls it (the run-record route in
-- polis-api, off by default) answers 502 afterwards and nginx hands the
-- request to the Node server.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000041_drop_delphi_run_record.sql
--
-- Runner history is not edited here; the operator removes the 000041 history
-- row in the same sitting, after this succeeds.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
DROP FUNCTION public.pd_run_record(text,uuid);
COMMIT;
