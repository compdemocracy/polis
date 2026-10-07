-- down/000025_drop_vote_convention.sql
--
-- Reverses 000025_vote_convention.sql: drops the vote convention row and its
-- history, the two semantic views, the four functions, the four trigger
-- functions and the migration ledger. DROP fires no DELETE or TRUNCATE
-- trigger, so the permanence guards do not stand in its way. No vote is read or changed; votes,
-- votes_latest_unique and the 000006 rule are untouched. Every grant 000025
-- made is on an object dropped here, so the drops remove exactly those grants.
--
-- Apply as the migration (owner) role, in one session:
--   psql -X -v ON_ERROR_STOP=1 -f server/postgres/migrations/down/000025_drop_vote_convention.sql
-- One transaction (BEGIN/COMMIT in the file); any refusal changes nothing.
--
-- Refuses (SQLSTATE P0789) when dropping would lose information:
--   * the convention has moved (version <> 0, agree_value <> -1, or more than
--     one history row), or the ledger records an un-flip: the stored votes are
--     then in a sign that only these rows declare. A database that was never
--     declared (no row, no history) is dropped: nothing is lost;
--   * the ledger holds a ledger-era row for another migration (a 64-hex
--     checksum other than this file's own: it would be lost). The rows for
--     the earlier files ('verified' / 'unverified') carry no information the
--     catalog lacks and go with the table;
--   * only some of the objects exist (a partial copy: inspect by hand).
-- On a database that never had 000025 it is a no-op.
-- Before running it in production, take the server back to raw INSERTs (roll
-- back the server change that calls vote_insert): this file drops vote_insert.
-- No CASCADE: an object someone built on top of these makes the DROP fail.
--
-- Order with 000021: run this file before down/000021_drop_polis_coordinator.sql.
-- 000021's down refuses to drop a coordinator role that still holds a grant,
-- and 000025 grants to those roles.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  present integer;
  v_version integer;
  v_agree smallint;
  v_history bigint;
  later text;
BEGIN
  SELECT (to_regclass('public.vote_convention') IS NOT NULL)::int
       + (to_regclass('public.vote_convention_history') IS NOT NULL)::int
       + (to_regclass('public.schema_migrations') IS NOT NULL)::int
       + (to_regclass('public.votes_semantic') IS NOT NULL)::int
       + (to_regclass('public.votes_latest_unique_semantic') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_current()') IS NOT NULL)::int
       + (to_regprocedure('public.vote_semantic(smallint,smallint)') IS NOT NULL)::int
       + (to_regprocedure('public.vote_storage(smallint,smallint)') IS NOT NULL)::int
       + (to_regprocedure('public.vote_insert(integer,integer,integer,smallint,smallint,boolean,integer)') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_record_history()') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_history_immutable()') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_monotonic()') IS NOT NULL)::int
       + (to_regprocedure('public.vote_convention_permanent()') IS NOT NULL)::int
    INTO present;
  IF present = 0 THEN
    RAISE NOTICE '000025 down: nothing to drop';
    RETURN;
  END IF;
  IF present <> 13 THEN
    RAISE EXCEPTION '000025 down: refusing: only % of the 13 objects exist (a partial copy); nothing changed', present
      USING ERRCODE = 'P0789';
  END IF;
  -- Lock the row as the un-flip does, so no convention change races this check.
  LOCK TABLE public.vote_convention IN EXCLUSIVE MODE;
  SELECT c.version, c.agree_value INTO v_version, v_agree
    FROM public.vote_convention c WHERE c.singleton FOR UPDATE;
  SELECT count(*) INTO v_history FROM public.vote_convention_history;
  IF v_version IS NULL THEN
    -- No row (the column is NOT NULL, so NULL means none): an undeclared
    -- database, one that held votes when 000025 ran. Nothing is lost.
    IF v_history <> 0 THEN
      RAISE EXCEPTION '000025 down: refusing: no convention row but % history rows (the row was removed by hand); inspect vote_convention_history first',
        v_history USING ERRCODE = 'P0789';
    END IF;
  ELSIF v_version IS DISTINCT FROM 0 OR v_agree IS DISTINCT FROM -1 OR v_history <> 1 THEN
    RAISE EXCEPTION '000025 down: refusing: the convention is version %, agree_value % with % history rows; dropping it would leave the stored sign undeclared',
      v_version, v_agree, v_history USING ERRCODE = 'P0789';
  END IF;
  SELECT string_agg(m.name, ', ' ORDER BY m.name) INTO later
    FROM public.schema_migrations m
   WHERE m.name <> '000025_vote_convention' AND length(m.checksum) = 64;
  IF later IS NOT NULL OR EXISTS (SELECT 1 FROM public.schema_migrations m WHERE m.name LIKE '%\_vote\_sign\_unflip') THEN
    RAISE EXCEPTION '000025 down: refusing: the ledger records later migrations (%); reverse them first', later
      USING ERRCODE = 'P0789';
  END IF;
END
$guard$;

-- Each statement is a no-op when the guard found nothing (IF EXISTS); when it
-- found the full set, every object is present and is dropped.
DROP VIEW IF EXISTS public.votes_latest_unique_semantic;
DROP VIEW IF EXISTS public.votes_semantic;
DROP FUNCTION IF EXISTS public.vote_insert(integer, integer, integer, smallint, smallint, boolean, integer);
DROP FUNCTION IF EXISTS public.vote_storage(smallint, smallint);
DROP FUNCTION IF EXISTS public.vote_semantic(smallint, smallint);
DROP FUNCTION IF EXISTS public.vote_convention_current();
DROP TABLE IF EXISTS public.vote_convention;
DROP TABLE IF EXISTS public.vote_convention_history;
DROP FUNCTION IF EXISTS public.vote_convention_permanent();
DROP FUNCTION IF EXISTS public.vote_convention_monotonic();
DROP FUNCTION IF EXISTS public.vote_convention_history_immutable();
DROP FUNCTION IF EXISTS public.vote_convention_record_history();
DROP TABLE IF EXISTS public.schema_migrations;

COMMIT;
