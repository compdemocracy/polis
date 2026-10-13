-- down/000039_restore_zinvites_uuid.sql  (reversal of 000039_clear_zinvites_uuid.sql)
--
-- There is nothing to restore, and this script restores nothing. 000039 sets
-- every zinvites.uuid to NULL; the previous keys are not recorded anywhere, so
-- no down migration can bring them back. Like the other irreversible-by-design
-- reversals in this directory, it does not invent data -- 000038 refuses to
-- "restore" embeddings it cannot reconstruct and drops only what it created;
-- here the honest reversal is a documented no-op.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000039_restore_zinvites_uuid.sql
--
-- The forward remediation, which is automatic, is the only way a conversation
-- gets a key again: GET /api/v3/conversationUuid mints a fresh uuid for the
-- owner (or a moderator on the owner's site) on demand, and newly created
-- conversations receive one at creation. Rolling the application back to a
-- release that predates 000039 does not restore the cleared keys either; it
-- only removes the owner check in front of the mint. The runner never runs a
-- down migration automatically (docs/migrations.md "History and failure
-- behavior"); this file documents the reversal and is a safe no-op if run.
BEGIN;
SET LOCAL lock_timeout='5s';
-- Intentionally no data statement: the cleared keys cannot be restored.
DO $$ BEGIN
 RAISE NOTICE 'down/000039 is a no-op: cleared conversation download keys cannot be restored; owners re-mint via GET /api/v3/conversationUuid';
END $$;
COMMIT;
