-- 000044: routing propensities (PROPENSITY-LOGGING-DESIGN.md section 5).
--
-- Three new tables, nothing else:
--
--   comment_serve_log        one row per next-statement choice, written by the
--                            API (server/src/nextComment.ts) after it chooses,
--                            fire-and-forget, when ROUTING_SERVE_LOG is on (the
--                            default). It records the branch taken, the pool,
--                            the served statement's lottery weight and its
--                            propensity, so impressions can be reweighted.
--   math_recompute_log       one row per committed math generation (written by
--                            the Python math engine in the same transaction as
--                            math_ticks/math_main), fixing which votes each
--                            generation saw.
--   math_priorities_history  the comment-priorities map of each generation,
--                            written only when MATH_PRIORITIES_HISTORY is on.
--
-- Compatibility: additive. No existing table, column, function, index or row
-- changes. A release that does not list this migration never reads or writes
-- these tables, so it runs unchanged beside them. CREATE TABLE and CREATE
-- INDEX on a new, empty table take locks only on that table.
--
-- Reversal: drop the three tables (this loses the logged serves and
-- recomputes, nothing else). The writers stop once ROUTING_SERVE_LOG=0 and
-- MATH_PRIORITIES_HISTORY is unset; an API that still logs serves after the
-- drop only logs the failed insert (polis_err_comment_serve_log).

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
  last_vote_timestamp BIGINT,
  n_votes INTEGER,                      -- votes in the batch that triggered the recompute, NULL if unknown
  n_comments INTEGER,                   -- comments with a priority in this generation
  created BIGINT NOT NULL DEFAULT now_as_millis(),
  PRIMARY KEY (zid, math_env, math_tick)
);

CREATE TABLE math_priorities_history (
  zid INTEGER NOT NULL,
  math_env VARCHAR(999) NOT NULL,
  math_tick BIGINT NOT NULL,
  priorities JSONB NOT NULL,            -- the comment-priorities map of this generation
  created BIGINT NOT NULL DEFAULT now_as_millis(),
  PRIMARY KEY (zid, math_env, math_tick)
);
