-- P-078 un-flip rehearsal: every query the rehearsal runs, bound by sha256
-- (run_spec.queries_sha256). Each block starts with a "-- name:" line; the
-- rehearsal executes blocks by name with psycopg2 named parameters
-- (%(name)s). Blocks marked "day" are the production-day verification
-- queries (P-078 section 2c step 5): Colin runs them on the box, never from a
-- laptop, and compares their shape with the rehearsal receipt. Print them with
--   python3 ci/probe_box/unflip_rehearsal.py --print-sql
-- No block writes except copy_marker (a comment on the temporary copy),
-- insert_roundtrip (rehearsal only, always inside a
-- transaction its caller rolls back) and the engine label cleanup (its own
-- non-served label only). insert_roundtrip and insert_readback are NOT
-- production-day queries: on production they would overwrite a real
-- participant's vote. The production day checks the write path with one
-- browser vote (P-078 section 2c step 5); --print-sql prints the two blocks
-- only wrapped in BEGIN; ... ROLLBACK;.

-- name: session
SELECT pg_catalog.current_setting('server_version_num')::int AS server_version_num,
       pg_catalog.current_setting('is_superuser') AS is_superuser,
       (extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint AS now_ms;

-- name: objects
SELECT pg_catalog.to_regclass('public.vote_convention') IS NOT NULL AS convention,
       pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL AS ledger,
       pg_catalog.to_regclass('public.votes_semantic') IS NOT NULL AS views;

-- name: copy_marker
-- Marks the temporary restored copy (never production) for the engine-rebuild
-- tool's --require-copy-marker. Run by the rehearsal's preflight, before any
-- other write, on the copy its secret names.
DO $marker$ BEGIN
  EXECUTE 'COMMENT ON DATABASE ' || pg_catalog.quote_ident(pg_catalog.current_database())
       || ' IS ' || pg_catalog.quote_literal('polis-unflip-rehearsal-copy');
END $marker$;

-- name: copy_marker_read
SELECT pg_catalog.shobj_description(d.oid, 'pg_database') AS marker
  FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database();

-- name: convention (day)
SELECT version, agree_value FROM public.vote_convention WHERE singleton;

-- name: unflip_ledger (day)
SELECT count(*)::bigint AS unflip_rows FROM public.schema_migrations
 WHERE pg_catalog.right(name, 17) = '_vote_sign_unflip';

-- name: storage_bytes
-- Used storage on the copy: every database the session may size plus the WAL
-- directory (pg_ls_waldir needs pg_monitor, which RDS's rds_superuser holds).
-- An estimate of the instance's used disk; the rehearsal refuses when it
-- cannot be read.
SELECT (SELECT coalesce(sum(pg_catalog.pg_database_size(d.datname)), 0)
          FROM pg_catalog.pg_database d
         WHERE d.datallowconn AND pg_catalog.has_database_privilege(d.datname, 'CONNECT'))::bigint AS databases,
       (SELECT coalesce(sum(w.size), 0) FROM pg_catalog.pg_ls_waldir() w)::bigint AS wal;

-- name: raw_counts (day)
SELECT 'votes'::text AS t, v.vote::int AS vote, count(*)::bigint AS n FROM public.votes v GROUP BY v.vote
UNION ALL
SELECT 'votes_latest_unique'::text, u.vote::int, count(*)::bigint FROM public.votes_latest_unique u GROUP BY u.vote
ORDER BY 1, 2 NULLS LAST;

-- name: totals
SELECT (SELECT count(*) FROM public.votes)::bigint AS votes,
       (SELECT count(*) FROM public.votes_latest_unique)::bigint AS votes_latest,
       (SELECT count(DISTINCT zid) FROM public.votes)::bigint AS conversations;

-- name: aggregates_votes
SELECT s.zid,
       count(*) FILTER (WHERE s.semantic_vote = 1)::bigint AS agree,
       count(*) FILTER (WHERE s.semantic_vote = -1)::bigint AS disagree,
       count(*) FILTER (WHERE s.semantic_vote = 0)::bigint AS pass,
       count(*) FILTER (WHERE s.semantic_vote IS NULL)::bigint AS missing
  FROM public.votes_semantic s GROUP BY s.zid ORDER BY s.zid;

-- name: aggregates_latest
SELECT s.zid,
       count(*) FILTER (WHERE s.semantic_vote = 1)::bigint AS agree,
       count(*) FILTER (WHERE s.semantic_vote = -1)::bigint AS disagree,
       count(*) FILTER (WHERE s.semantic_vote = 0)::bigint AS pass,
       count(*) FILTER (WHERE s.semantic_vote IS NULL)::bigint AS missing
  FROM public.votes_latest_unique_semantic s GROUP BY s.zid ORDER BY s.zid;

-- name: participant_hashes
SELECT s.zid, s.pid,
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
         pg_catalog.string_agg(s.tid::text || ':' || coalesce(s.semantic_vote::text, 'N') || ':' || coalesce(s.created::text, 'N'),
                               ',' ORDER BY s.tid, s.created, s.semantic_vote), 'UTF8')), 'hex') AS digest
  FROM public.votes_semantic s GROUP BY s.zid, s.pid ORDER BY s.zid, s.pid;

-- name: sizes
SELECT (pg_catalog.pg_relation_size('public.votes') + pg_catalog.pg_relation_size('public.votes_latest_unique'))::bigint AS heap,
       (pg_catalog.pg_indexes_size('public.votes') + pg_catalog.pg_indexes_size('public.votes_latest_unique'))::bigint AS indexes,
       coalesce((SELECT sum(n_dead_tup) FROM pg_catalog.pg_stat_user_tables
                  WHERE schemaname = 'public' AND relname IN ('votes', 'votes_latest_unique')), 0)::bigint AS dead;

-- name: wal_lsn
SELECT pg_catalog.pg_current_wal_insert_lsn()::text AS lsn;

-- name: wal_since
SELECT pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_insert_lsn(), %(lsn)s::pg_lsn)::bigint AS bytes;

-- name: backend
SELECT pg_catalog.pg_backend_pid() AS pid;

-- name: lock_sample
SELECT count(*)::bigint AS waiters,
       coalesce(max(extract(epoch FROM pg_catalog.clock_timestamp() - l.waitstart) * 1000), 0)::bigint AS longest_ms
  FROM pg_catalog.pg_locks l
 WHERE NOT l.granted AND l.pid <> pg_catalog.pg_backend_pid();

-- name: cancel_backend
SELECT pg_catalog.pg_cancel_backend(%(pid)s) AS cancelled;

-- name: certification
SELECT z.zid FROM public.zinvites z
 WHERE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(z.zinvite, 'UTF8')), 'hex') = ANY(%(digests)s)
 ORDER BY pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(z.zinvite, 'UTF8')), 'hex');

-- name: certification_handles
SELECT z.zid, z.zinvite,
       (SELECT r.report_id FROM public.reports r WHERE r.zid = z.zid ORDER BY r.rid LIMIT 1) AS report_id
  FROM public.zinvites z WHERE z.zid = ANY(%(zids)s) ORDER BY z.zid;

-- name: sample
SELECT d.zid FROM (SELECT DISTINCT v.zid FROM public.votes v) d
 WHERE NOT (d.zid = ANY(%(exclude)s))
 ORDER BY pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.zid::text, 'UTF8')), 'hex')
 LIMIT %(limit)s;

-- name: insert_target
SELECT u.zid, u.pid, u.tid FROM public.votes_latest_unique u ORDER BY u.zid, u.pid, u.tid LIMIT 1;

-- name: insert_roundtrip
SELECT r.vote::int AS vote, r.created, r.convention_version
  FROM public.vote_insert(%(zid)s, %(pid)s, %(tid)s, 1::smallint) r;

-- name: insert_readback
SELECT (SELECT s.semantic_vote::int FROM public.votes_semantic s
         WHERE s.zid = %(zid)s AND s.pid = %(pid)s AND s.tid = %(tid)s AND s.created = %(created)s LIMIT 1) AS semantic,
       (SELECT u.semantic_vote::int FROM public.votes_latest_unique_semantic u
         WHERE u.zid = %(zid)s AND u.pid = %(pid)s AND u.tid = %(tid)s) AS latest;

-- name: engine_rows
-- The blob's own math_tick is engine-local wall-clock (the server overwrites it
-- from the column); it is dropped from the digest, as in the engine-rebuild tool.
SELECT m.zid, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((m.data - 'math_tick')::text, 'UTF8')), 'hex') AS digest
  FROM public.math_main m WHERE m.math_env = %(label)s AND m.zid = ANY(%(zids)s) ORDER BY m.zid;

-- name: engine_clear
-- Every table the engine publishes under its label, so each rebuild mints the
-- same ticks (math_ticks restarts) and pre/post served pca2 are comparable.
DELETE FROM public.math_main WHERE math_env = %(label)s;
DELETE FROM public.math_bidtopid WHERE math_env = %(label)s;
DELETE FROM public.math_ptptstats WHERE math_env = %(label)s;
DELETE FROM public.math_ticks WHERE math_env = %(label)s;

-- name: restore_detection (day)
SELECT CASE
         WHEN pg_catalog.to_regclass('public.vote_convention') IS NULL THEN 'absent'
         ELSE 'present'
       END AS convention_table;
