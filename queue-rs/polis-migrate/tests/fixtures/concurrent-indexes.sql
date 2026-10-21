-- polis-migrate: concurrent-indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS votes_zid_created_idx ON votes (zid, created);
CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_zid_created_idx ON comments (zid, created);
CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_zid_modified_idx ON comments (zid, modified);
