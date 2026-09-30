-- 000022_add_poll_timestamp_indexes.sql
--
-- Two single-column B-tree indexes for the math pollers' global watermark
-- queries (P-009, approved 2026-09-28):
--
--   votes_created_idx     ON public.votes    (created)
--   comments_modified_idx ON public.comments (modified)
--
-- Both math engines poll every conversation once a second with
--   SELECT ... FROM votes    WHERE created  > :since ORDER BY zid, tid, pid, created
--   SELECT ... FROM comments WHERE modified > :since ORDER BY zid, tid, modified
-- (delphi/polismath/database/postgres.py poll_votes_since / poll_moderation_since,
-- math/src/polismath/components/postgres.clj). No existing index leads with
-- either column, so every poll, including an empty one, is a full sequential
-- scan. With these indexes an empty or small-tail poll is an index range scan.
-- Both columns are BIGINT epoch milliseconds; the indexes are on the bare
-- columns (no expression, no partial predicate, no INCLUDE payload). No query,
-- ordering or application code changes.
--
-- HOW THIS FILE IS APPLIED
-- ------------------------
-- * Fresh databases (docker-entrypoint-initdb.d, server/bin/run-migrations.sh on
--   an empty database, and the test harnesses that replay this directory):
--   this file builds both indexes directly. The tables are empty or tiny there,
--   so the build is instant.
--
-- * Existing, populated databases (production): the indexes are built
--   OUT-OF-BAND by the operator with CREATE INDEX CONCURRENTLY, one statement per
--   session, in autocommit, following the runbook in the PR that added this
--   file. This file is the record of that change. Once the operator build has
--   finished, applying this file is a no-op that only re-checks the result.
--
-- Why this file does not itself say CONCURRENTLY: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block, and it cannot run inside a
-- multi-statement query string (which PostgreSQL executes as one implicit
-- transaction). psql -f (the runner and initdb) would be fine, but several test
-- harnesses in this repository apply each migration file as a single driver
-- call (psycopg2 cursor.execute of the whole file, some inside an explicit
-- transaction). A plain CREATE INDEX works in all of those.
--
-- A plain CREATE INDEX on a large live table holds a SHARE lock that blocks
-- every INSERT/UPDATE/DELETE on that table for the whole build. The block below
-- therefore builds an index only when it is missing, and REFUSES to do so when
-- its table has more than 100,000 rows: build it CONCURRENTLY instead. When an
-- index already exists, no CREATE statement runs at all (see the note there).
--
-- An existing name is not accepted on its own: it may be an INVALID index left
-- by a failed CONCURRENTLY build, or a same-named index with a different
-- definition. The final block asserts that each index is valid, ready and has
-- exactly the expected definition, and fails otherwise.
--
-- Reversal: down/000022_drop_poll_timestamp_indexes.sql
-- (DROP INDEX CONCURRENTLY IF EXISTS, apply with psql -f, never in a transaction).
-- Test: down/test_000022.sh.

-- Build only what is missing. The plain CREATE INDEX runs only inside the
-- missing-index branch: CREATE INDEX IF NOT EXISTS would take the table's
-- SHARE lock BEFORE noticing the name exists, so an unconditional statement
-- would queue every writer behind it even on a database that already has the
-- index. When both indexes exist, this file takes no lock on votes or comments
-- beyond reading the catalog.
DO $build$
BEGIN
  IF to_regclass('public.votes_created_idx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.votes LIMIT 1 OFFSET 100000) THEN
      RAISE EXCEPTION '000022: public.votes has more than 100000 rows and no votes_created_idx'
        USING HINT = 'Build it first with CREATE INDEX CONCURRENTLY IF NOT EXISTS votes_created_idx ON public.votes USING btree (created), in autocommit, as the operator runbook describes. A plain CREATE INDEX here would block writes to votes for the whole build.';
    END IF;
    CREATE INDEX votes_created_idx ON public.votes USING btree (created);
  END IF;
  IF to_regclass('public.comments_modified_idx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.comments LIMIT 1 OFFSET 100000) THEN
      RAISE EXCEPTION '000022: public.comments has more than 100000 rows and no comments_modified_idx'
        USING HINT = 'Build it first with CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_modified_idx ON public.comments USING btree (modified), in autocommit, as the operator runbook describes. A plain CREATE INDEX here would block writes to comments for the whole build.';
    END IF;
    CREATE INDEX comments_modified_idx ON public.comments USING btree (modified);
  END IF;
END
$build$;

DO $check$
DECLARE
  expected CONSTANT text[][] := ARRAY[
    ARRAY['votes_created_idx',
          'CREATE INDEX votes_created_idx ON public.votes USING btree (created)'],
    ARRAY['comments_modified_idx',
          'CREATE INDEX comments_modified_idx ON public.comments USING btree (modified)']];
  i int;
  idx regclass;
  valid boolean;
  ready boolean;
  def text;
BEGIN
  FOR i IN 1 .. array_length(expected, 1) LOOP
    idx := to_regclass('public.' || expected[i][1]);
    IF idx IS NULL THEN
      RAISE EXCEPTION '000022: index public.% is missing', expected[i][1];
    END IF;
    SELECT x.indisvalid, x.indisready, pg_get_indexdef(x.indexrelid)
      INTO valid, ready, def
      FROM pg_index x WHERE x.indexrelid = idx;
    IF NOT valid OR NOT ready THEN
      RAISE EXCEPTION '000022: index public.% exists but is not valid (indisvalid=%, indisready=%)',
        expected[i][1], valid, ready
        USING HINT = 'A failed CREATE INDEX CONCURRENTLY leaves an INVALID index. Drop it with DROP INDEX CONCURRENTLY IF EXISTS public.' || expected[i][1] || ' and build it again.';
    END IF;
    IF def IS DISTINCT FROM expected[i][2] THEN
      RAISE EXCEPTION '000022: index public.% has an unexpected definition: %', expected[i][1], def;
    END IF;
  END LOOP;
END
$check$;
