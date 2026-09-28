-- down/000022_drop_poll_timestamp_indexes.sql
--
-- Reverses 000022_add_poll_timestamp_indexes.sql: drops the two poll indexes.
--
-- Apply with psql in its default autocommit mode, one statement at a time:
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000022_drop_poll_timestamp_indexes.sql
--
-- Never with --single-transaction, never inside BEGIN/COMMIT, and never as one
-- multi-statement driver call: DROP INDEX CONCURRENTLY cannot run in a
-- transaction block. CONCURRENTLY lets reads and writes on votes/comments
-- continue while each index is removed; it waits for transactions that are
-- using the table to finish first.
--
-- Idempotent: IF EXISTS makes a second run, or a run on a database that never
-- had the indexes, a no-op with a NOTICE. It also removes an INVALID index left
-- by a failed CREATE INDEX CONCURRENTLY under either name.
--
-- Effect: both math pollers go back to sequential scans of votes and comments
-- on every poll. Reversal does not return storage already allocated.

DROP INDEX CONCURRENTLY IF EXISTS public.votes_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.comments_modified_idx;
