-- Pre-switch backfill completeness (P-070): aggregate counts only, read-only.
--
-- Run by a read-only login inside one REPEATABLE READ READ ONLY snapshot,
-- after the backfill reports COMPLETE and again immediately before the reader
-- switch. It prints counts, never identifiers. The intended runner is a new,
-- reviewed, aggregate-only probe job (fixed output schema, bounded query time,
-- source/config binding); no probe job runs it yet.
--
-- psql variables:
--   source     the label readers serve today           (prod)
--   target     the label readers will serve            (python)
--   cutoff_ms  the release boundary, epoch milliseconds, fixed for the run.
--              Every vote created at or before it must be in the target
--              (query 5); a target published after it may trail its source
--              only as live lag, which is bounded by now - cutoff_ms.
--
--   psql -v source=prod -v target=python -v cutoff_ms=<ms> -f backfill_verification.sql
--
-- One validity rule for selection, the backfill's postcondition and this
-- file: the predicate in queries 2 and 4 is the exact text of
-- polismath.poller.backfill.VALID_BUNDLE_SQL (a test holds them equal). It
-- checks the four rows at one initialized generation (>= 0) and the reader
-- contract of all three payloads: types, the row/body bindings (zids; main's
-- lastVoteTimestamp against its column), the bidToPid/base-clusters
-- alignment, in-conv <= n, and n = 0 only in Python's named empty form.
-- Nested entries the readers dereference are checked too, including every
-- group-votes entry ({n-members, votes: {tid: {A, D, S}}}) and every repness
-- entry (an array of objects), per review [1449] B.
--
-- Every payload reference is cast (m.data::jsonb): production's math data
-- columns are json although the migrations declare jsonb, and the jsonb
-- functions and operators used here do not exist for json. The cast is a
-- no-op on jsonb, so the file runs on either column type.
--
-- The switch needs, while the source-ahead ruling is unresolved (the default,
-- MATH_BACKFILL_SOURCE_AHEAD_RULING=unresolved):
--   query 2: missing_* = 0, unequal_generation = 0, uninitialized_generation
--            = 0, invalid_payload = 0, behind_source_stale = 0,
--            source_ahead = 0, and complete = source_conversations;
--   query 3: orphan_* = 0;
--   query 5: behind_input_at_cutoff = 0 and source_ahead_of_input = 0.
-- Only once Colin's ruling is encoded as accept_input may source-ahead
-- targets count: then complete + source_ahead = source_conversations, and
-- source_ahead / source_ahead_of_input are carried with that disposition.
--
-- behind_source_stale counts targets behind their source row, with votes
-- they have not consumed, that were not themselves published after cutoff_ms:
-- an old target is never exempted because its source is recent. live_lag
-- (the same, published after the cutoff) is reported, not exempted: query 5
-- proves the input up to the cutoff. source_ahead (query 2) is a valid target
-- behind its source row although it reflects every vote in the votes table;
-- source_ahead_of_input (query 5) counts source rows that claim a later vote
-- than the votes table holds at all, whatever the target's publication time,
-- so a recent target cannot hide it (review [1447] C). Unresolved backfill
-- work (refusals, exhausted retries) is in the poller's sweep summary, not in
-- these tables.

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
--    publication in all four tables. Reads every target payload once.
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
    WHERE m.math_tick < 0 OR b.math_tick < 0 OR p.math_tick < 0
       OR k.math_tick < 0) AS uninitialized_generation,
  count(*) FILTER (
    WHERE m.zid IS NOT NULL AND b.zid IS NOT NULL AND p.zid IS NOT NULL AND k.zid IS NOT NULL
      AND m.math_tick >= 0 AND m.math_tick = b.math_tick AND m.math_tick = p.math_tick
      AND m.math_tick = k.math_tick
      AND NOT v.valid) AS invalid_payload,
  count(*) FILTER (
    WHERE m.last_vote_timestamp < s.last_vote_timestamp
      AND NOT COALESCE(m.last_vote_timestamp >= i.input_lvt, false)
      AND m.last_vote_timestamp < :cutoff_ms) AS behind_source_stale,
  count(*) FILTER (
    WHERE m.last_vote_timestamp < s.last_vote_timestamp
      AND NOT COALESCE(m.last_vote_timestamp >= i.input_lvt, false)
      AND m.last_vote_timestamp >= :cutoff_ms) AS live_lag,
  count(*) FILTER (
    WHERE v.valid AND m.last_vote_timestamp < s.last_vote_timestamp
      AND COALESCE(m.last_vote_timestamp >= i.input_lvt, false)) AS source_ahead,
  count(*) FILTER (
    WHERE v.valid
      AND NOT COALESCE(m.last_vote_timestamp < s.last_vote_timestamp
                       AND (m.last_vote_timestamp < :cutoff_ms
                            OR m.last_vote_timestamp >= i.input_lvt), false)) AS complete
FROM math_main s
LEFT JOIN math_main m ON m.zid = s.zid AND m.math_env = :'target'
LEFT JOIN math_bidtopid b ON b.zid = s.zid AND b.math_env = :'target'
LEFT JOIN math_ptptstats p ON p.zid = s.zid AND p.math_env = :'target'
LEFT JOIN math_ticks k ON k.zid = s.zid AND k.math_env = :'target'
CROSS JOIN LATERAL (SELECT COALESCE((
        m.zid IS NOT NULL AND b.zid IS NOT NULL AND p.zid IS NOT NULL AND k.zid IS NOT NULL
        AND m.math_tick >= 0 AND b.math_tick = m.math_tick
        AND p.math_tick = m.math_tick AND k.math_tick = m.math_tick
        AND m.last_vote_timestamp IS NOT NULL
        AND jsonb_typeof(m.data::jsonb) = 'object'
        AND CASE WHEN jsonb_typeof(m.data::jsonb->'zid') = 'number'
                 THEN (m.data::jsonb->>'zid')::numeric = m.zid ELSE false END
        AND CASE WHEN jsonb_typeof(m.data::jsonb->'lastVoteTimestamp') = 'number'
                 THEN (m.data::jsonb->>'lastVoteTimestamp')::numeric = m.last_vote_timestamp
                 ELSE false END
        AND jsonb_typeof(m.data::jsonb->'tids') = 'array'
        AND jsonb_typeof(m.data::jsonb->'pca') = 'object'
        AND jsonb_typeof(m.data::jsonb->'repness') = 'object'
        AND jsonb_typeof(b.data::jsonb) = 'object'
        AND CASE WHEN jsonb_typeof(b.data::jsonb->'zid') = 'number'
                 THEN (b.data::jsonb->>'zid')::numeric = b.zid ELSE false END
        AND CASE WHEN jsonb_typeof(b.data::jsonb->'lastVoteTimestamp') = 'number'
                 THEN (b.data::jsonb->>'lastVoteTimestamp')::numeric = m.last_vote_timestamp
                 ELSE false END
        AND jsonb_typeof(p.data::jsonb) = 'object'
        AND CASE WHEN jsonb_typeof(p.data::jsonb->'zid') = 'number'
                 THEN (p.data::jsonb->>'zid')::numeric = p.zid ELSE false END
        AND CASE WHEN jsonb_typeof(p.data::jsonb->'lastVoteTimestamp') = 'number'
                 THEN (p.data::jsonb->>'lastVoteTimestamp')::numeric = m.last_vote_timestamp
                 ELSE false END
        AND CASE WHEN jsonb_typeof(p.data::jsonb->'ptptstats') = 'object'
             THEN p.data::jsonb->'ptptstats' = '{}'::jsonb
                  OR (jsonb_typeof(p.data::jsonb->'ptptstats'->'pid') = 'array'
                      AND jsonb_typeof(p.data::jsonb->'ptptstats'->'gid') = 'array'
                      AND NOT EXISTS (
                          SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(p.data::jsonb->'ptptstats') = 'object'
                                                        THEN p.data::jsonb->'ptptstats' ELSE '{}'::jsonb END) e
                          WHERE (CASE WHEN jsonb_typeof(e.value) = 'array'
                                      THEN jsonb_array_length(e.value) END)
                                IS DISTINCT FROM
                                (CASE WHEN jsonb_typeof(p.data::jsonb->'ptptstats'->'pid') = 'array'
                                      THEN jsonb_array_length(p.data::jsonb->'ptptstats'->'pid') END)))
             ELSE false END
        AND jsonb_typeof(m.data::jsonb->'pca'->'center') = 'array'
        AND jsonb_typeof(m.data::jsonb->'pca'->'comps') = 'array'
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'pca'->'center') = 'array'
                                                    THEN m.data::jsonb->'pca'->'center' ELSE '[]'::jsonb END) x
            WHERE jsonb_typeof(x) <> 'number')
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'pca'->'comps') = 'array'
                                                    THEN m.data::jsonb->'pca'->'comps' ELSE '[]'::jsonb END) c
            WHERE jsonb_typeof(c) <> 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c) = 'array'
                                                                  THEN c ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) <> 'number'))
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'group-clusters') = 'array'
                                                    THEN m.data::jsonb->'group-clusters' ELSE '[]'::jsonb END) g
            WHERE jsonb_typeof(g) <> 'object'
               OR jsonb_typeof(g->'id') IS DISTINCT FROM 'number'
               OR jsonb_typeof(g->'members') IS DISTINCT FROM 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(g->'members') = 'array'
                                                                  THEN g->'members' ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) <> 'number'))
        AND jsonb_typeof(m.data::jsonb->'group-votes') = 'object'
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(m.data::jsonb->'group-votes') = 'object'
                                          THEN m.data::jsonb->'group-votes' ELSE '{}'::jsonb END) g
            WHERE jsonb_typeof(g.value) IS DISTINCT FROM 'object'
               OR jsonb_typeof(g.value->'n-members') IS DISTINCT FROM 'number'
               OR jsonb_typeof(g.value->'votes') IS DISTINCT FROM 'object'
               OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(g.value->'votes') = 'object'
                                                        THEN g.value->'votes' ELSE '{}'::jsonb END) v
                          WHERE jsonb_typeof(v.value) IS DISTINCT FROM 'object'
                             OR jsonb_typeof(v.value->'A') IS DISTINCT FROM 'number'
                             OR jsonb_typeof(v.value->'D') IS DISTINCT FROM 'number'
                             OR jsonb_typeof(v.value->'S') IS DISTINCT FROM 'number'))
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(m.data::jsonb->'repness') = 'object'
                                          THEN m.data::jsonb->'repness' ELSE '{}'::jsonb END) r
            WHERE jsonb_typeof(r.value) IS DISTINCT FROM 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.value) = 'array'
                                                                  THEN r.value ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'))
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'base-clusters'->'id') = 'array'
                                                    THEN m.data::jsonb->'base-clusters'->'id' ELSE '[]'::jsonb END) x
            WHERE jsonb_typeof(x) <> 'number')
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'base-clusters'->'members') = 'array'
                                                    THEN m.data::jsonb->'base-clusters'->'members' ELSE '[]'::jsonb END) c
            WHERE jsonb_typeof(c) <> 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c) = 'array'
                                                                  THEN c ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) <> 'number'))
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.data::jsonb->'bidToPid') = 'array'
                                                    THEN b.data::jsonb->'bidToPid' ELSE '[]'::jsonb END) c
            WHERE jsonb_typeof(c) <> 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c) = 'array'
                                                                  THEN c ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) <> 'number'))
        AND CASE WHEN jsonb_typeof(m.data::jsonb->'n') = 'number'
                  AND jsonb_typeof(m.data::jsonb->'base-clusters') = 'object'
                  AND jsonb_typeof(m.data::jsonb->'base-clusters'->'id') = 'array'
                  AND jsonb_typeof(m.data::jsonb->'base-clusters'->'members') = 'array'
                  AND jsonb_typeof(m.data::jsonb->'group-clusters') = 'array'
                  AND jsonb_typeof(m.data::jsonb->'in-conv') = 'array'
                  AND jsonb_typeof(b.data::jsonb->'bidToPid') = 'array'
             THEN (m.data::jsonb->>'n')::numeric >= 0
                  AND jsonb_array_length(m.data::jsonb->'base-clusters'->'members')
                      = jsonb_array_length(m.data::jsonb->'base-clusters'->'id')
                  AND jsonb_array_length(b.data::jsonb->'bidToPid')
                      = jsonb_array_length(m.data::jsonb->'base-clusters'->'id')
                  AND jsonb_array_length(m.data::jsonb->'in-conv') <= (m.data::jsonb->>'n')::numeric
                  AND ((m.data::jsonb->>'n')::numeric > 0
                       OR (jsonb_array_length(m.data::jsonb->'base-clusters'->'id') = 0
                           AND jsonb_array_length(m.data::jsonb->'group-clusters') = 0
                           AND jsonb_array_length(m.data::jsonb->'in-conv') = 0
                           AND m.last_vote_timestamp = 0
                           AND p.data::jsonb->'ptptstats' = '{}'::jsonb))
             ELSE false END
    ), false) AS valid) v
CROSS JOIN LATERAL (SELECT CASE WHEN m.last_vote_timestamp < s.last_vote_timestamp
    THEN (SELECT COALESCE(max(x.created), 0) FROM votes x WHERE x.zid = s.zid)
    END AS input_lvt) i
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

-- 4. Diagnostic breakdown of the payloads of structurally coherent targets
--    (why invalid_payload is nonzero). Informational; query 2 decides.
SELECT
  count(*) AS checked,
  count(*) FILTER (WHERE jsonb_typeof(m.data::jsonb) <> 'object') AS main_not_object,
  count(*) FILTER (
    WHERE jsonb_typeof(m.data::jsonb) = 'object'
      AND NOT (m.data::jsonb ?& ARRAY['zid', 'n', 'tids', 'pca', 'base-clusters',
                              'group-clusters', 'group-votes', 'repness', 'in-conv',
                              'lastVoteTimestamp'])) AS main_missing_keys,
  count(*) FILTER (WHERE (m.data::jsonb->>'zid') IS DISTINCT FROM m.zid::text) AS main_zid_unbound,
  count(*) FILTER (
    WHERE (m.data::jsonb->>'lastVoteTimestamp') IS DISTINCT FROM m.last_vote_timestamp::text)
    AS main_timestamp_unbound,
  count(*) FILTER (WHERE jsonb_typeof(b.data::jsonb->'bidToPid') IS DISTINCT FROM 'array'
                      OR (b.data::jsonb->>'zid') IS DISTINCT FROM b.zid::text) AS bidtopid_malformed,
  count(*) FILTER (WHERE jsonb_typeof(p.data::jsonb->'ptptstats') IS DISTINCT FROM 'object'
                      OR (p.data::jsonb->>'zid') IS DISTINCT FROM p.zid::text) AS ptptstats_malformed,
  count(*) FILTER (
    WHERE (b.data::jsonb->>'lastVoteTimestamp') IS DISTINCT FROM m.last_vote_timestamp::text
       OR (p.data::jsonb->>'lastVoteTimestamp') IS DISTINCT FROM m.last_vote_timestamp::text)
    AS companion_timestamp_unbound,
  count(*) FILTER (WHERE v.valid AND m.data::jsonb->>'n' = '0') AS empty_shape,
  count(*) FILTER (WHERE NOT v.valid) AS invalid_payload
FROM math_main s
JOIN math_main m ON m.zid = s.zid AND m.math_env = :'target'
JOIN math_bidtopid b ON b.zid = s.zid AND b.math_env = :'target'
JOIN math_ptptstats p ON p.zid = s.zid AND p.math_env = :'target'
JOIN math_ticks k ON k.zid = s.zid AND k.math_env = :'target'
CROSS JOIN LATERAL (SELECT COALESCE((
        m.zid IS NOT NULL AND b.zid IS NOT NULL AND p.zid IS NOT NULL AND k.zid IS NOT NULL
        AND m.math_tick >= 0 AND b.math_tick = m.math_tick
        AND p.math_tick = m.math_tick AND k.math_tick = m.math_tick
        AND m.last_vote_timestamp IS NOT NULL
        AND jsonb_typeof(m.data::jsonb) = 'object'
        AND CASE WHEN jsonb_typeof(m.data::jsonb->'zid') = 'number'
                 THEN (m.data::jsonb->>'zid')::numeric = m.zid ELSE false END
        AND CASE WHEN jsonb_typeof(m.data::jsonb->'lastVoteTimestamp') = 'number'
                 THEN (m.data::jsonb->>'lastVoteTimestamp')::numeric = m.last_vote_timestamp
                 ELSE false END
        AND jsonb_typeof(m.data::jsonb->'tids') = 'array'
        AND jsonb_typeof(m.data::jsonb->'pca') = 'object'
        AND jsonb_typeof(m.data::jsonb->'repness') = 'object'
        AND jsonb_typeof(b.data::jsonb) = 'object'
        AND CASE WHEN jsonb_typeof(b.data::jsonb->'zid') = 'number'
                 THEN (b.data::jsonb->>'zid')::numeric = b.zid ELSE false END
        AND CASE WHEN jsonb_typeof(b.data::jsonb->'lastVoteTimestamp') = 'number'
                 THEN (b.data::jsonb->>'lastVoteTimestamp')::numeric = m.last_vote_timestamp
                 ELSE false END
        AND jsonb_typeof(p.data::jsonb) = 'object'
        AND CASE WHEN jsonb_typeof(p.data::jsonb->'zid') = 'number'
                 THEN (p.data::jsonb->>'zid')::numeric = p.zid ELSE false END
        AND CASE WHEN jsonb_typeof(p.data::jsonb->'lastVoteTimestamp') = 'number'
                 THEN (p.data::jsonb->>'lastVoteTimestamp')::numeric = m.last_vote_timestamp
                 ELSE false END
        AND CASE WHEN jsonb_typeof(p.data::jsonb->'ptptstats') = 'object'
             THEN p.data::jsonb->'ptptstats' = '{}'::jsonb
                  OR (jsonb_typeof(p.data::jsonb->'ptptstats'->'pid') = 'array'
                      AND jsonb_typeof(p.data::jsonb->'ptptstats'->'gid') = 'array'
                      AND NOT EXISTS (
                          SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(p.data::jsonb->'ptptstats') = 'object'
                                                        THEN p.data::jsonb->'ptptstats' ELSE '{}'::jsonb END) e
                          WHERE (CASE WHEN jsonb_typeof(e.value) = 'array'
                                      THEN jsonb_array_length(e.value) END)
                                IS DISTINCT FROM
                                (CASE WHEN jsonb_typeof(p.data::jsonb->'ptptstats'->'pid') = 'array'
                                      THEN jsonb_array_length(p.data::jsonb->'ptptstats'->'pid') END)))
             ELSE false END
        AND jsonb_typeof(m.data::jsonb->'pca'->'center') = 'array'
        AND jsonb_typeof(m.data::jsonb->'pca'->'comps') = 'array'
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'pca'->'center') = 'array'
                                                    THEN m.data::jsonb->'pca'->'center' ELSE '[]'::jsonb END) x
            WHERE jsonb_typeof(x) <> 'number')
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'pca'->'comps') = 'array'
                                                    THEN m.data::jsonb->'pca'->'comps' ELSE '[]'::jsonb END) c
            WHERE jsonb_typeof(c) <> 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c) = 'array'
                                                                  THEN c ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) <> 'number'))
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'group-clusters') = 'array'
                                                    THEN m.data::jsonb->'group-clusters' ELSE '[]'::jsonb END) g
            WHERE jsonb_typeof(g) <> 'object'
               OR jsonb_typeof(g->'id') IS DISTINCT FROM 'number'
               OR jsonb_typeof(g->'members') IS DISTINCT FROM 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(g->'members') = 'array'
                                                                  THEN g->'members' ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) <> 'number'))
        AND jsonb_typeof(m.data::jsonb->'group-votes') = 'object'
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(m.data::jsonb->'group-votes') = 'object'
                                          THEN m.data::jsonb->'group-votes' ELSE '{}'::jsonb END) g
            WHERE jsonb_typeof(g.value) IS DISTINCT FROM 'object'
               OR jsonb_typeof(g.value->'n-members') IS DISTINCT FROM 'number'
               OR jsonb_typeof(g.value->'votes') IS DISTINCT FROM 'object'
               OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(g.value->'votes') = 'object'
                                                        THEN g.value->'votes' ELSE '{}'::jsonb END) v
                          WHERE jsonb_typeof(v.value) IS DISTINCT FROM 'object'
                             OR jsonb_typeof(v.value->'A') IS DISTINCT FROM 'number'
                             OR jsonb_typeof(v.value->'D') IS DISTINCT FROM 'number'
                             OR jsonb_typeof(v.value->'S') IS DISTINCT FROM 'number'))
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(m.data::jsonb->'repness') = 'object'
                                          THEN m.data::jsonb->'repness' ELSE '{}'::jsonb END) r
            WHERE jsonb_typeof(r.value) IS DISTINCT FROM 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.value) = 'array'
                                                                  THEN r.value ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'))
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'base-clusters'->'id') = 'array'
                                                    THEN m.data::jsonb->'base-clusters'->'id' ELSE '[]'::jsonb END) x
            WHERE jsonb_typeof(x) <> 'number')
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.data::jsonb->'base-clusters'->'members') = 'array'
                                                    THEN m.data::jsonb->'base-clusters'->'members' ELSE '[]'::jsonb END) c
            WHERE jsonb_typeof(c) <> 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c) = 'array'
                                                                  THEN c ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) <> 'number'))
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.data::jsonb->'bidToPid') = 'array'
                                                    THEN b.data::jsonb->'bidToPid' ELSE '[]'::jsonb END) c
            WHERE jsonb_typeof(c) <> 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c) = 'array'
                                                                  THEN c ELSE '[]'::jsonb END) x
                          WHERE jsonb_typeof(x) <> 'number'))
        AND CASE WHEN jsonb_typeof(m.data::jsonb->'n') = 'number'
                  AND jsonb_typeof(m.data::jsonb->'base-clusters') = 'object'
                  AND jsonb_typeof(m.data::jsonb->'base-clusters'->'id') = 'array'
                  AND jsonb_typeof(m.data::jsonb->'base-clusters'->'members') = 'array'
                  AND jsonb_typeof(m.data::jsonb->'group-clusters') = 'array'
                  AND jsonb_typeof(m.data::jsonb->'in-conv') = 'array'
                  AND jsonb_typeof(b.data::jsonb->'bidToPid') = 'array'
             THEN (m.data::jsonb->>'n')::numeric >= 0
                  AND jsonb_array_length(m.data::jsonb->'base-clusters'->'members')
                      = jsonb_array_length(m.data::jsonb->'base-clusters'->'id')
                  AND jsonb_array_length(b.data::jsonb->'bidToPid')
                      = jsonb_array_length(m.data::jsonb->'base-clusters'->'id')
                  AND jsonb_array_length(m.data::jsonb->'in-conv') <= (m.data::jsonb->>'n')::numeric
                  AND ((m.data::jsonb->>'n')::numeric > 0
                       OR (jsonb_array_length(m.data::jsonb->'base-clusters'->'id') = 0
                           AND jsonb_array_length(m.data::jsonb->'group-clusters') = 0
                           AND jsonb_array_length(m.data::jsonb->'in-conv') = 0
                           AND m.last_vote_timestamp = 0
                           AND p.data::jsonb->'ptptstats' = '{}'::jsonb))
             ELSE false END
    ), false) AS valid) v
WHERE s.math_env = :'source'
  AND m.math_tick >= 0 AND m.math_tick = b.math_tick AND m.math_tick = p.math_tick
  AND m.math_tick = k.math_tick;

-- 5. Input catch-up at the cutoff: every vote created at or before cutoff_ms
--    is reflected in the target's last_vote_timestamp. Reads each source
--    conversation's votes once (votes_zid_pid_idx).
--    source_ahead_of_input: the source row claims a later vote than any vote
--    the table holds (the full input, not only up to the cutoff), whenever
--    the target was published. live_tail_after_cutoff: a target published
--    after the cutoff that is behind its source because the table holds a
--    newer vote it has not consumed yet (live ingestion owns it); separated
--    from source_ahead_of_input, which no amount of live catch-up resolves.
SELECT
  count(*) FILTER (
    WHERE i.max_created IS NOT NULL
      AND (m.last_vote_timestamp IS NULL OR m.last_vote_timestamp < i.max_created))
    AS behind_input_at_cutoff,
  count(*) FILTER (
    WHERE s.last_vote_timestamp > COALESCE(i.max_all, 0))
    AS source_ahead_of_input,
  count(*) FILTER (
    WHERE m.last_vote_timestamp < s.last_vote_timestamp
      AND m.last_vote_timestamp >= :cutoff_ms
      AND m.last_vote_timestamp < i.max_all)
    AS live_tail_after_cutoff
FROM math_main s
LEFT JOIN math_main m ON m.zid = s.zid AND m.math_env = :'target'
LEFT JOIN LATERAL (SELECT max(created) FILTER (WHERE created <= :cutoff_ms) AS max_created,
                          max(created) AS max_all
                   FROM votes WHERE votes.zid = s.zid) i ON true
WHERE s.math_env = :'source';

COMMIT;
