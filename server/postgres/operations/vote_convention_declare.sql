-- operations/vote_convention_declare.sql: declare the stored vote sign of a
-- database that already holds votes.
--
-- An OPERATION, not a migration: it is never applied by the migration runner
-- or by docker-entrypoint-initdb.d. It is run once, by the operator, through
--   make vote-convention-declare AGREE=-1          (or AGREE=+1)
-- which calls server/bin/vote-convention-declare.sh, which runs this file with
--   psql -X -v ON_ERROR_STOP=1 -v agree=<-1|1> -v reason='<text>' -f <this file>
--
-- What it does, in one transaction: writes THE ONE ROW of public.vote_convention
--   AGREE=-1  -> (version 0, agree -1): the storage convention since 2012.
--                Nearly every Polis database is this one.
--   AGREE=+1  -> (version 1, agree +1): ONLY for a deployment that reversed its
--                own stored vote signs. This release's components are built for
--                agree = -1 and refuse to start against a +1 declaration; the
--                declaration protects such data from being read inverted until
--                a release that serves +1 exists.
-- No vote is read for writing, updated or deleted. No vote value changes.
--
-- Refuses, changing nothing:
--   P0796  no vote_convention table: apply migration 000025 first
--   P0797  AGREE is not -1 or +1, or the reason is empty
--   P0798  the database already declares its convention (a declaration is
--          changed only by the flip tool, never by declaring again)
--
-- The history row records operation = 'vote_convention_declare' and this
-- file's ledger checksum (sha256 of the file without the marker line below;
-- server/postgres/check_ledger_checksums.py verifies it).
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
-- psql substitutes the two variables here; inside the dollar-quoted block
-- below it does not, so the block reads them back through current_setting.
SELECT set_config('polis.declare_agree', :'agree', true);
SELECT set_config('polis.declare_reason', :'reason', true);

DO $declare$
DECLARE
  v_agree   smallint;
  v_reason  text := nullif(trim(current_setting('polis.declare_reason', true)), '');
  v_version integer;
  v_have_version integer;
  v_have_agree smallint;
BEGIN
  IF to_regclass('public.vote_convention') IS NULL THEN
    RAISE EXCEPTION 'vote_convention_declare: this database has no vote_convention table: migration 000025 has not been applied. Nothing has been changed. Next: apply server/postgres/migrations/000025_vote_convention.sql, then declare. Guide: docs/vote-convention-upgrade.md#guard'
      USING ERRCODE = 'P0796';
  END IF;
  BEGIN
    v_agree := current_setting('polis.declare_agree', true)::smallint;
  EXCEPTION WHEN others THEN
    v_agree := NULL;
  END;
  IF v_agree IS NULL OR v_agree NOT IN (-1, 1) THEN
    RAISE EXCEPTION 'vote_convention_declare: AGREE must be -1 (the original convention) or +1 (a deployment that reversed its own signs); got "%". Nothing has been changed.',
      coalesce(current_setting('polis.declare_agree', true), '')
      USING ERRCODE = 'P0797';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'vote_convention_declare: a non-empty reason is required (it is recorded in vote_convention_history). Nothing has been changed.'
      USING ERRCODE = 'P0797';
  END IF;
  LOCK TABLE public.vote_convention IN EXCLUSIVE MODE;
  SELECT c.version, c.agree_value INTO v_have_version, v_have_agree
    FROM public.vote_convention c WHERE c.singleton;
  IF FOUND THEN
    RAISE EXCEPTION 'vote_convention_declare: this database already declares its convention: version %, agree = %. A declaration is changed only by the flip tool. Nothing has been changed.',
      v_have_version, v_have_agree
      USING ERRCODE = 'P0798';
  END IF;
  v_version := CASE WHEN v_agree = -1 THEN 0 ELSE 1 END;
  INSERT INTO public.vote_convention (version, agree_value, reason, operation, operation_checksum)
  VALUES (v_version, v_agree, v_reason, 'vote_convention_declare', '60e17ec16e1e035c1645575978f1028c0f4f08c253880f6c51222f3377ece20c'); -- ledger-self-checksum
  RAISE NOTICE 'vote convention: GUARDED v% agree % (declared by %)', v_version, v_agree, session_user;
END
$declare$;

SELECT 'declared' AS state, c.version, c.agree_value, c.contract_version, c.changed_by, c.reason
  FROM public.vote_convention c;
COMMIT;
