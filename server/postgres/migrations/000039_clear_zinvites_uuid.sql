-- 000039_clear_zinvites_uuid.sql
--
-- Data migration: clear every conversation download key.
--
-- zinvites.uuid is the capability key for the participant-XID export
-- (GET /api/v3/xid/<uuid>-xid.csv, resolved by getZidForUuid): anyone holding a
-- conversation's uuid can download that conversation's participant identifiers.
-- This migration sets every existing uuid back to NULL so each key is re-minted
-- on demand through GET /api/v3/conversationUuid, which returns or mints the key
-- only for the conversation's owner or a moderator on the owner's site. Owners
-- re-copy any saved download link once, after this deploy.
--
-- Reversal is impossible: the previous keys are not stored anywhere and cannot
-- be recovered. The forward remediation is the re-mint above; there is no down
-- migration that restores the old keys. See
-- down/000039_restore_zinvites_uuid.sql.
--
-- Compatibility: additive. A release that does not list this migration still
-- runs correctly once it is applied -- the uuid column is nullable (000009) and
-- every reader tolerates NULL: conversationUuid mints on demand, getZidForUuid
-- returns "not found" for a cleared key, and new conversations still receive a
-- fresh uuid at creation. No reader expects a non-NULL uuid.
--
-- Locks. zinvites is read on the participant path only to resolve a zid from a
-- zinvite CODE (never from uuid). This UPDATE takes ROW EXCLUSIVE on the table
-- and a row lock on each matched row; neither blocks those SELECT readers. The
-- WHERE skips rows already NULL so no row is rewritten twice. The runner's
-- lock_timeout (5 s) and statement_timeout (5 min) bound it; on timeout it fails
-- with no history row and the deploy can be retried.
BEGIN;
SET LOCAL lock_timeout='5s';
UPDATE public.zinvites SET uuid = NULL WHERE uuid IS NOT NULL;
COMMIT;
