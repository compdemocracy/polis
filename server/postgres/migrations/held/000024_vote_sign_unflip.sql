-- 000024_vote_sign_unflip.sql: the vote-sign un-flip (P-078 section 2a).
--
-- RULING R-I. NEVER APPLY OUTSIDE THE REHEARSAL. This file is held: it lives
-- in held/ so that no apply path reaches it. server/Dockerfile-db copies
-- migrations/*.sql (top level only) and server/bin/run-migrations.sh uses
-- find -maxdepth 1; neither sees this directory. The only executor in this
-- repository is the probe-box rehearsal (ci/probe_box/unflip_rehearsal_steps.py),
-- which runs it on a temporary restored copy, and its tests, which run it on
-- a generated fixture. The rehearsal binds these exact bytes by sha256
-- (run_spec.migration_sql_sha256); the production day applies the same bytes.
--
-- What it does, in one transaction:
--   0. locks the vote_convention TABLE in EXCLUSIVE mode first, so a stream of
--      vote_insert() FOR SHARE readers cannot starve the row lock (plain reads,
--      ACCESS SHARE, are never blocked);
--   1. locks the vote_convention singleton FOR UPDATE and refuses (SQLSTATE
--      P0785) unless it is version 0 / agree_value -1 and the ledger has no
--      un-flip row. A second run, or a run on a post-flip copy, refuses here.
--   2. locks votes and votes_latest_unique in SHARE ROW EXCLUSIVE mode, which
--      blocks every writer, including one that bypasses vote_insert(), while
--      reads continue; then records the raw count table of both tables, and
--      refuses (P0786) on any stored value outside {-1, 0, 1, NULL}.
--   3. negates every -1 and +1 in both tables (the INSERT rule of 000006 does
--      not cover UPDATE, so votes_latest_unique gets its own UPDATE).
--   4. moves the convention to version 1 / agree_value +1 (PR-A's monotonic
--      trigger requires exactly old + 1 and a sign change).
--   5. asserts the mirrored counts (P0787) and the new convention row (P0788),
--      printing the count table as NOTICE lines.
--   6. records itself in public.schema_migrations as its last statement.
--
-- Requires PR-A (public.vote_convention, public.schema_migrations). Read
-- committed, set explicitly so no role or database default can change it;
-- never repeatable read: see P-078 section 2a.
-- Writers calling vote_insert() wait at most 2 s on the convention row and are
-- answered 503 polis_err_votes_paused_retry; reads are never blocked.
--
-- Apply (production day, after ruling R-I, from inside the VPC):
--   psql -X -v ON_ERROR_STOP=1 -f 000024_vote_sign_unflip.sql
-- The file carries its own BEGIN/COMMIT. Any error leaves the transaction
-- aborted and psql exits; nothing is committed. (--single-transaction adds
-- nothing here.)
--
-- Ledger checksum: the schema_migrations row carries the sha256 of this file
-- with the one line marked ledger-self-checksum removed (P-078 PR-A rule).
-- Print it with: python3 ci/probe_box/unflip_rehearsal.py --print-migration

BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = 0;

LOCK TABLE public.vote_convention IN EXCLUSIVE MODE;

DO $guard$
DECLARE
  v_version integer;
  v_agree smallint;
BEGIN
  SELECT c.version, c.agree_value INTO v_version, v_agree
    FROM public.vote_convention c WHERE c.singleton FOR UPDATE;
  IF NOT FOUND OR v_version IS DISTINCT FROM 0 OR v_agree IS DISTINCT FROM -1 THEN
    RAISE EXCEPTION 'vote_sign_unflip: refusing: the convention is version %, agree_value % (expected 0, -1)',
      v_version, v_agree USING ERRCODE = 'P0785';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations m WHERE m.name LIKE '%\_vote\_sign\_unflip') THEN
    RAISE EXCEPTION 'vote_sign_unflip: refusing: the ledger already records an un-flip at version 0'
      USING ERRCODE = 'P0785';
  END IF;
END
$guard$;

LOCK TABLE public.votes, public.votes_latest_unique IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE vote_sign_unflip_pre ON COMMIT DROP AS
  SELECT 'votes'::text AS t, v.vote, count(*)::bigint AS n FROM public.votes v GROUP BY v.vote
  UNION ALL
  SELECT 'votes_latest_unique'::text, u.vote, count(*)::bigint FROM public.votes_latest_unique u GROUP BY u.vote;

DO $domain$
BEGIN
  IF EXISTS (SELECT 1 FROM vote_sign_unflip_pre p WHERE p.vote IS NOT NULL AND p.vote NOT IN (-1, 0, 1)) THEN
    RAISE EXCEPTION 'vote_sign_unflip: refusing: a stored vote is outside {-1, 0, 1, NULL}'
      USING ERRCODE = 'P0786';
  END IF;
END
$domain$;

UPDATE public.votes SET vote = -vote WHERE vote IN (-1, 1);
UPDATE public.votes_latest_unique SET vote = -vote WHERE vote IN (-1, 1);

UPDATE public.vote_convention
   SET version = 1, agree_value = 1, changed_at = clock_timestamp(), changed_by = session_user,
       reason = 'P-078 un-flip: agree = +1 after 15 years of agree = -1'
 WHERE singleton;

CREATE TEMP TABLE vote_sign_unflip_post ON COMMIT DROP AS
  SELECT 'votes'::text AS t, v.vote, count(*)::bigint AS n FROM public.votes v GROUP BY v.vote
  UNION ALL
  SELECT 'votes_latest_unique'::text, u.vote, count(*)::bigint FROM public.votes_latest_unique u GROUP BY u.vote;

DO $mirror$
DECLARE
  r record;
  v_differences bigint;
  v_version integer;
  v_agree smallint;
BEGIN
  FOR r IN
    SELECT coalesce(a.t, b.t) AS t, coalesce(a.vote, -b.vote) AS pre_vote, a.n AS pre_n, b.n AS post_n
      FROM vote_sign_unflip_pre a
      FULL JOIN vote_sign_unflip_post b ON a.t = b.t AND b.vote IS NOT DISTINCT FROM -a.vote
     ORDER BY 1, 2 NULLS LAST
  LOOP
    RAISE NOTICE 'vote_sign_unflip counts table=% pre_vote=% pre=% post_vote=% post=%',
      r.t, coalesce(r.pre_vote::text, 'NULL'), coalesce(r.pre_n, 0),
      coalesce((-r.pre_vote)::text, 'NULL'), coalesce(r.post_n, 0);
  END LOOP;
  SELECT count(*) INTO v_differences FROM (
    (SELECT p.t, CASE WHEN p.vote IN (-1, 1) THEN -p.vote ELSE p.vote END AS vote, p.n FROM vote_sign_unflip_pre p
     EXCEPT ALL
     SELECT q.t, q.vote, q.n FROM vote_sign_unflip_post q)
    UNION ALL
    (SELECT q.t, q.vote, q.n FROM vote_sign_unflip_post q
     EXCEPT ALL
     SELECT p.t, CASE WHEN p.vote IN (-1, 1) THEN -p.vote ELSE p.vote END, p.n FROM vote_sign_unflip_pre p)
  ) d;
  IF v_differences <> 0 THEN
    RAISE EXCEPTION 'vote_sign_unflip: refusing: the post counts do not mirror the pre counts (% differences)',
      v_differences USING ERRCODE = 'P0787';
  END IF;
  SELECT c.version, c.agree_value INTO v_version, v_agree FROM public.vote_convention c WHERE c.singleton;
  IF v_version IS DISTINCT FROM 1 OR v_agree IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'vote_sign_unflip: refusing: the convention did not move to version 1, agree_value 1'
      USING ERRCODE = 'P0788';
  END IF;
  RAISE NOTICE 'vote_sign_unflip convention version=% agree_value=%', v_version, v_agree;
END
$mirror$;

INSERT INTO public.schema_migrations (name, checksum, note) VALUES ('000024_vote_sign_unflip', '2d1c44328c3ff415b37821d8078f44e15515fd678bf4d4cc68eccb5f0b1cfe43', 'P-078 un-flip, ruling R-I'); -- ledger-self-checksum
COMMIT;
