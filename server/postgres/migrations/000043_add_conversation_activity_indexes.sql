-- 000043_add_conversation_activity_indexes.sql
-- polis-migrate: concurrent-indexes
--
-- Support derived conversation activity from vote and comment timestamps.
-- Additive: existing readers and writers keep their SQL and stored values.
-- The runner builds each index in autocommit under the migration advisory lock,
-- with a 5 s lock wait and 5 min statement budget per build. Concurrent builds
-- take SHARE UPDATE EXCLUSIVE, compatible with ordinary reads and writes.
-- Valid matching indexes survive retries. An invalid interrupted build refuses
-- before any build: inspect, DROP INDEX CONCURRENTLY the named index, then retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS votes_zid_created_idx ON votes (zid, created);
CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_zid_created_idx ON comments (zid, created);
CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_zid_modified_idx ON comments (zid, modified);
