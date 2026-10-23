-- 000044: routing propensities (PROPENSITY-LOGGING-DESIGN.md sections 5 and 9).
--
-- Two new tables, nothing else:
--
--   comment_serve_log        one row per next-statement choice, written by the
--                            API (server/src/nextComment.ts) after it chooses,
--                            fire-and-forget, when ROUTING_SERVE_LOG is on (the
--                            default). It records the branch taken, the pool,
--                            the served statement's lottery weight and its
--                            propensity, so impressions can be reweighted.
--   math_recompute_log       one row per committed math generation, written by
--                            the Python math engine in the same transaction as
--                            math_ticks/math_main. The row is the engine's
--                            complete per-tick input record, for exact replay
--                            (PROPENSITY-LOGGING-DESIGN.md section 9): how the
--                            tick started (incremental, warm_restore or cold,
--                            and from which tick), the votes delivered to the
--                            engine in delivery order (incremental ticks) or
--                            the descriptor of the full-history read with its
--                            sha256 digest (rebuilds), the moderation sets read
--                            at compute time, and the engine version. Replaying
--                            the rows from the last cold/warm_restore row
--                            through the same compute function reproduces any
--                            past generation, priorities included, with no
--                            stored copy of the priorities.
--
-- Compatibility: additive. No existing table, column, function, index or row
-- changes. A release that does not list this migration never reads or writes
-- these tables, so it runs unchanged beside them. CREATE TABLE and CREATE
-- INDEX on a new, empty table take locks only on that table.
--
-- Reversal: drop the two tables (this loses the logged serves and
-- recomputes, nothing else). The API stops writing once ROUTING_SERVE_LOG=0;
-- an API that still logs serves after the drop only logs the failed insert
-- (polis_err_comment_serve_log).

CREATE TABLE comment_serve_log (
  id BIGSERIAL PRIMARY KEY,
  zid INTEGER NOT NULL,
  pid INTEGER NOT NULL,                 -- -1 = anonymous participationInit (or no pid)
  uid INTEGER,                          -- the requester's uid when known; ties a pid -1 serve to its participant
  tid INTEGER,                          -- NULL when nothing was served
  branch VARCHAR(32) NOT NULL,          -- 'epsilon' | 'priority' | 'topical' | 'priority_after_topical_fallback' | 'priority_after_topical_error' | 'priority_after_epsilon_miss' | 'initial'
  epsilon DOUBLE PRECISION NOT NULL,    -- ROUTING_EPSILON in force (0 when off)
  topical_ratio DOUBLE PRECISION,       -- TOPICAL_COMMENT_RATIO in force, NULL when unset
  math_env VARCHAR(999),
  math_tick BIGINT,                     -- generation whose priorities were used; NULL = none/uniform
  pool_size INTEGER NOT NULL,           -- lottery window size (<= 999)
  eligible_count INTEGER,               -- m: the eligible count when epsilon > 0; else the window size if < 999; NULL when unknown
  weight DOUBLE PRECISION,              -- served tid's lottery weight (priority || 1); NULL if outside window
  weight_sum DOUBLE PRECISION,          -- sum of weights over the window
  propensity DOUBLE PRECISION,          -- formula in section 4 with r = 0; NULL on topical, topical_error and initial rows, and on epsilon/priority rows while TOPICAL_COMMENT_RATIO > 0 (pid != -1)
  random_n DOUBLE PRECISION,            -- the lottery draw (priority branch), else NULL
  topical_pool_size INTEGER,
  created BIGINT NOT NULL DEFAULT now_as_millis()
);
CREATE INDEX comment_serve_log_zid_pid_tid_idx ON comment_serve_log (zid, pid, tid);
CREATE INDEX comment_serve_log_zid_created_idx ON comment_serve_log (zid, created);

CREATE TABLE math_recompute_log (
  zid INTEGER NOT NULL,
  math_env VARCHAR(999) NOT NULL,
  math_tick BIGINT NOT NULL,
  start_mode VARCHAR(16) NOT NULL,      -- 'incremental' | 'warm_restore' | 'cold'
  prev_math_tick BIGINT,                -- generation the state continued or was restored from; NULL on cold
  last_vote_timestamp BIGINT,
  n_votes INTEGER,                      -- votes delivered for this tick (0 for a moderation-only tick)
  n_comments INTEGER,                   -- comments with a priority in this generation
  vote_pids INTEGER[],                  -- the delivered votes, in delivery order (incremental ticks)
  vote_tids INTEGER[],
  vote_values SMALLINT[],
  vote_created BIGINT[],
  rebuild_through_created BIGINT,       -- rebuild ticks: the full-history read, canonical order
  rebuild_n_votes INTEGER,
  rebuild_digest VARCHAR(64),           -- sha256 over (tid, pid, created, vote) in canonical order
  mod_read BOOLEAN NOT NULL,            -- true when this tick re-read moderation and applied it; always true on cold/warm_restore
  -- Moderation deltas against the previous mod_read row of the chain (a rebuild row's deltas are against the
  -- empty sets); the engine's full sets are folded from them. All eight NULL exactly when mod_read is false.
  mod_out_tids_added INTEGER[],
  mod_out_tids_removed INTEGER[],
  mod_in_tids_added INTEGER[],
  mod_in_tids_removed INTEGER[],
  meta_tids_added INTEGER[],
  meta_tids_removed INTEGER[],
  mod_out_pids_added INTEGER[],
  mod_out_pids_removed INTEGER[],
  engine_version VARCHAR(128),          -- git sha / image tag of the engine, when known
  created BIGINT NOT NULL DEFAULT now_as_millis(),
  PRIMARY KEY (zid, math_env, math_tick),
  CHECK ((mod_read AND mod_out_tids_added IS NOT NULL AND mod_out_tids_removed IS NOT NULL AND mod_in_tids_added IS NOT NULL AND mod_in_tids_removed IS NOT NULL AND meta_tids_added IS NOT NULL AND meta_tids_removed IS NOT NULL AND mod_out_pids_added IS NOT NULL AND mod_out_pids_removed IS NOT NULL) OR (NOT mod_read AND mod_out_tids_added IS NULL AND mod_out_tids_removed IS NULL AND mod_in_tids_added IS NULL AND mod_in_tids_removed IS NULL AND meta_tids_added IS NULL AND meta_tids_removed IS NULL AND mod_out_pids_added IS NULL AND mod_out_pids_removed IS NULL))
);
