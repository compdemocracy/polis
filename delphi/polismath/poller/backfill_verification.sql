-- Pre-switch backfill completeness (P-070): aggregate counts only, read-only.
--
-- Run by a read-only login (the probe box's reader) inside one
-- REPEATABLE READ READ ONLY snapshot, after a backfill sweep and again
-- immediately before the reader switch. It prints counts, never identifiers.
--
-- psql variables:
--   source     the label readers serve today           (prod)
--   target     the label readers will serve            (python)
--   cutoff_ms  catch-up cutoff, epoch milliseconds: a target row behind its
--              source row counts as stale only if the source's last vote is
--              older than this (live ingestion owns anything newer)
--
--   psql -v source=prod -v target=python -v cutoff_ms=<ms> -f backfill_verification.sql
--
-- The switch needs, in query 2: missing_* = 0, unequal_generation = 0,
-- uninitialized_generation = 0, behind_source_at_cutoff = 0, and
-- complete = source_conversations; in query 3: orphan_* = 0; in query 4:
-- main_not_object = 0 and main_missing_keys = 0. Zero-vote conversations are
-- complete when they carry Python's named empty shape (query 4 counts them as
-- empty_shape, not as errors). Unresolved backfill work (refusals, exhausted
-- retries, exclusions) is in the poller's sweep summary, not in these tables.

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- 1. Rows per label in each of the four tables.
SELECT 'math_main' AS tbl, math_env, count(*) AS n
  FROM math_main WHERE math_env IN (:'source', :'target') GROUP BY math_env
UNION ALL
SELECT 'math_bidtopid', math_env, count(*)
  FROM math_bidtopid WHERE math_env IN (:'source', :'target') GROUP BY math_env
UNION ALL
SELECT 'math_ptptstats', math_env, count(*)
  FROM math_ptptstats WHERE math_env IN (:'source', :'target') GROUP BY math_env
UNION ALL
SELECT 'math_ticks', math_env, count(*)
  FROM math_ticks WHERE math_env IN (:'source', :'target') GROUP BY math_env
ORDER BY 1, 2;

-- 2. Every conversation with a source row, and the state of its target
--    publication in all four tables.
SELECT
  count(*) AS source_conversations,
  count(*) FILTER (WHERE m.zid IS NULL) AS missing_main,
  count(*) FILTER (WHERE b.zid IS NULL) AS missing_bidtopid,
  count(*) FILTER (WHERE p.zid IS NULL) AS missing_ptptstats,
  count(*) FILTER (WHERE k.zid IS NULL) AS missing_ticks,
  count(*) FILTER (
    WHERE m.zid IS NOT NULL AND b.zid IS NOT NULL AND p.zid IS NOT NULL AND k.zid IS NOT NULL
      AND NOT (m.math_tick = b.math_tick AND m.math_tick = p.math_tick
               AND m.math_tick = k.math_tick)) AS unequal_generation,
  count(*) FILTER (
    WHERE m.math_tick < 0 OR b.math_tick < 0 OR p.math_tick < 0) AS uninitialized_generation,
  count(*) FILTER (
    WHERE m.last_vote_timestamp < s.last_vote_timestamp
      AND s.last_vote_timestamp < :cutoff_ms) AS behind_source_at_cutoff,
  count(*) FILTER (
    WHERE m.last_vote_timestamp < s.last_vote_timestamp) AS behind_source_any,
  count(*) FILTER (
    WHERE m.zid IS NOT NULL AND b.zid IS NOT NULL AND p.zid IS NOT NULL AND k.zid IS NOT NULL
      AND m.math_tick = b.math_tick AND m.math_tick = p.math_tick
      AND m.math_tick = k.math_tick AND m.math_tick >= 0
      AND NOT (m.last_vote_timestamp < s.last_vote_timestamp
               AND s.last_vote_timestamp < :cutoff_ms)) AS complete
FROM math_main s
LEFT JOIN math_main m ON m.zid = s.zid AND m.math_env = :'target'
LEFT JOIN math_bidtopid b ON b.zid = s.zid AND b.math_env = :'target'
LEFT JOIN math_ptptstats p ON p.zid = s.zid AND p.math_env = :'target'
LEFT JOIN math_ticks k ON k.zid = s.zid AND k.math_env = :'target'
WHERE s.math_env = :'source';

-- 3. Target rows outside the source set (conversations created after the
--    source stopped, informational) and target companions or ticks with no
--    target main row (must be 0).
SELECT
  (SELECT count(*) FROM math_main m WHERE m.math_env = :'target'
     AND NOT EXISTS (SELECT 1 FROM math_main s
                     WHERE s.zid = m.zid AND s.math_env = :'source')) AS target_only_main,
  (SELECT count(*) FROM math_bidtopid b WHERE b.math_env = :'target'
     AND NOT EXISTS (SELECT 1 FROM math_main m
                     WHERE m.zid = b.zid AND m.math_env = :'target')) AS orphan_bidtopid,
  (SELECT count(*) FROM math_ptptstats p WHERE p.math_env = :'target'
     AND NOT EXISTS (SELECT 1 FROM math_main m
                     WHERE m.zid = p.zid AND m.math_env = :'target')) AS orphan_ptptstats,
  (SELECT count(*) FROM math_ticks k WHERE k.math_env = :'target'
     AND NOT EXISTS (SELECT 1 FROM math_main m
                     WHERE m.zid = k.zid AND m.math_env = :'target')) AS orphan_ticks;

-- 4. Structure of the target payloads for source conversations. This reads
--    every target math_main blob: run it once after the final sweep, not on
--    a schedule.
SELECT
  count(*) AS checked,
  count(*) FILTER (WHERE jsonb_typeof(m.data) <> 'object') AS main_not_object,
  count(*) FILTER (
    WHERE jsonb_typeof(m.data) = 'object'
      AND NOT (m.data ?& ARRAY['zid', 'n', 'tids', 'pca', 'base-clusters',
                              'group-clusters', 'repness', 'in-conv',
                              'lastVoteTimestamp'])) AS main_missing_keys,
  count(*) FILTER (
    WHERE jsonb_typeof(m.data) = 'object' AND m.data->>'n' = '0') AS empty_shape
FROM math_main m
JOIN math_main s ON s.zid = m.zid AND s.math_env = :'source'
WHERE m.math_env = :'target';

COMMIT;
