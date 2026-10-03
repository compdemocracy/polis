-- 000023_vote_convention.sql: the vote storage convention lives in the database.
--
-- SCHEMA CHANGE. NO DATA CHANGE: no existing row is read for
-- writing, updated or deleted. The seed row states today's storage convention
-- (agree = -1, disagree = +1, pass = 0), so every reader that consults it
-- computes exactly what it computes today.
--
-- Adds, in one transaction:
--   public.vote_convention          the singleton (version, agree_value), updated in place
--   public.vote_convention_history  append-only, filled by trigger
--   public.schema_migrations        the migration ledger, with the earlier files backfilled
--   public.vote_convention_current()                 STABLE SECURITY DEFINER read
--   public.vote_semantic(raw, agree_value)           IMMUTABLE STRICT storage -> semantic
--   public.vote_storage(semantic, agree_value)       IMMUTABLE STRICT semantic -> storage
--   public.vote_insert(zid, pid, tid, semantic, ...) SECURITY DEFINER; the only sanctioned INSERT into votes
--   public.votes_semantic, public.votes_latest_unique_semantic   views
-- and the grants below. Nothing on votes, votes_latest_unique, their columns,
-- indexes or the 000006 rule changes. The lookalike columns comments.mod,
-- participants.mod, report_comment_selections.selection and
-- votes.weight_x_32767 are never touched.
--
-- Named SQLSTATEs (class P0, user-defined):
--   P0780  this file refuses: already applied (or a partial copy), or PostgreSQL < 13
--   P0781  vote_convention_history is append-only (UPDATE/DELETE refused)
--   P0782  a new vote_convention state is not exactly version+1 with a sign change
--          (an UPDATE, or an INSERT after the row was removed with triggers off)
--   P0783  vote_insert: semantic vote is not -1, 0 or 1
--   P0784  vote_insert: p_expected_version differs from the current version
--   55P03  (lock_not_available) vote_insert waited 2 s for a lock: almost
--          always the convention row held FOR UPDATE by the un-flip; rarely a
--          contended votes_latest_unique row (the same vote submitted twice
--          inside a long caller transaction). Retryable either way; the server
--          answers 503 polis_err_votes_paused_retry.
--   P0790  vote_convention: DELETE and TRUNCATE are refused (the row is permanent)
--   P0791  vote_insert: the vote_convention row is missing; nothing is written
--   P0785..P0788 are the held un-flip's; P0789 is the down file's refusal.
--
-- Ledger rule, from this file on: every migration file inserts its own
-- public.schema_migrations row as its last statement. The row's checksum is
-- the sha256 of the file's bytes with exactly one line removed: the line that
-- carries the ledger marker comment (the INSERT at the end of this file).
-- Recompute it with
--   grep -v -e '-- ledger-self''-checksum' 000023_vote_convention.sql | shasum -a 256
-- (the quote pair keeps this comment line from matching; the shell joins it).
--
-- Restore detection (runbook): a restored copy is pre-flip iff
--   vote_convention.version = 0 AND no schema_migrations row named %_vote_sign_unflip.
-- No vote_convention table at all: older than this file; apply it, then decide.
-- version = 1 with the un-flip row: post-flip, serve as is. Any other
-- combination (the row without version 1, or version 1 without the row) is
-- corruption: stop. docs/vote-convention.md has the query.
--
-- Applied like 000022: fresh databases through docker-entrypoint-initdb.d and
-- server/bin/run-migrations.sh; production by the operator, by hand, as the
-- migration (owner) role, in one session:
--   psql -X -v ON_ERROR_STOP=1 -f server/postgres/migrations/000023_vote_convention.sql
-- The file carries its own BEGIN/COMMIT; it also works as one driver call
-- (the test harnesses and the probe-box rehearsal). No CONCURRENTLY, no
-- superuser, no extension. Requires PostgreSQL >= 13; production is 17.
-- A second application refuses (P0780) and changes nothing.
--
-- Reversal: down/000023_drop_vote_convention.sql. Test: down/test_000023_down.sh.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF current_setting('server_version_num')::integer < 130000 THEN
    RAISE EXCEPTION '000023: refusing: PostgreSQL 13 or newer is required' USING ERRCODE = 'P0780';
  END IF;
  IF to_regclass('public.vote_convention') IS NOT NULL
     OR to_regclass('public.vote_convention_history') IS NOT NULL
     OR to_regclass('public.schema_migrations') IS NOT NULL
     OR to_regclass('public.votes_semantic') IS NOT NULL
     OR to_regclass('public.votes_latest_unique_semantic') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('vote_convention_current', 'vote_semantic', 'vote_storage', 'vote_insert',
                                     'vote_convention_record_history', 'vote_convention_history_immutable',
                                     'vote_convention_monotonic', 'vote_convention_permanent')) THEN
    RAISE EXCEPTION '000023: refusing: the vote convention objects or the ledger already exist; nothing changed'
      USING ERRCODE = 'P0780',
            HINT = 'Already applied, or a partial copy. Inspect: SELECT * FROM public.vote_convention_current(); SELECT * FROM public.schema_migrations ORDER BY name;';
  END IF;
END
$pre$;

-- 1.1 The singleton, updated in place. In READ COMMITTED a writer whose
-- FOR SHARE waited on the row re-reads the updated row after the un-flip
-- commits; an append-only "max(version)" table would hand it the old row.
CREATE TABLE public.vote_convention (
  singleton        boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  version          integer     NOT NULL CHECK (version >= 0),
  agree_value      smallint    NOT NULL CHECK (agree_value IN (-1, 1)),
  changed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by       name        NOT NULL DEFAULT session_user,
  reason           text        NOT NULL CHECK (length(reason) > 0),
  contract_version integer     NOT NULL DEFAULT 1 CHECK (contract_version = 1)
);
COMMENT ON TABLE public.vote_convention IS
  'The storage sign of votes.vote and votes_latest_unique.vote. agree_value is the raw value that means AGREE; disagree is -agree_value; pass is 0. Read it in the same statement as the votes. Updated in place by the un-flip migration only.';

-- 1.2 Append-only history.
CREATE TABLE public.vote_convention_history (
  version          integer     PRIMARY KEY,
  agree_value      smallint    NOT NULL CHECK (agree_value IN (-1, 1)),
  changed_at       timestamptz NOT NULL,
  changed_by       name        NOT NULL,
  reason           text        NOT NULL,
  contract_version integer     NOT NULL
);
COMMENT ON TABLE public.vote_convention_history IS
  'Every state public.vote_convention has had, one row per version, written by trigger. Append-only.';

CREATE FUNCTION public.vote_convention_record_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.vote_convention_history (version, agree_value, changed_at, changed_by, reason, contract_version)
  VALUES (NEW.version, NEW.agree_value, NEW.changed_at, NEW.changed_by, NEW.reason, NEW.contract_version);
  RETURN NEW;
END $$;
CREATE TRIGGER vote_convention_history_trg
  AFTER INSERT OR UPDATE ON public.vote_convention
  FOR EACH ROW EXECUTE FUNCTION public.vote_convention_record_history();

CREATE FUNCTION public.vote_convention_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'vote_convention_history is append-only' USING ERRCODE = 'P0781';
END $$;
CREATE TRIGGER vote_convention_history_ro
  BEFORE UPDATE OR DELETE ON public.vote_convention_history
  FOR EACH ROW EXECUTE FUNCTION public.vote_convention_history_immutable();
-- Row triggers do not fire on TRUNCATE; this statement trigger does.
CREATE TRIGGER vote_convention_history_no_truncate
  BEFORE TRUNCATE ON public.vote_convention_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.vote_convention_history_immutable();

-- The monotonic guard: a new state is exactly old + 1 and changes the sign.
-- On UPDATE "old" is the row; on INSERT (the seed, or a row put back after it
-- was removed with triggers disabled) "old" is the newest history row, and
-- with no history the first state must be version 0. The guard also stamps
-- changed_at and changed_by, so a bare UPDATE of version and sign records
-- who changed it and when.
CREATE FUNCTION public.vote_convention_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  old_version integer;
  old_agree smallint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_version := OLD.version;
    old_agree := OLD.agree_value;
  ELSE
    SELECT h.version, h.agree_value INTO old_version, old_agree
      FROM public.vote_convention_history h ORDER BY h.version DESC LIMIT 1;
    IF NOT FOUND THEN
      IF NEW.version <> 0 THEN
        RAISE EXCEPTION 'vote_convention: the first state must be version 0 (got %)', NEW.version
          USING ERRCODE = 'P0782';
      END IF;
      NEW.changed_at := clock_timestamp();
      NEW.changed_by := session_user;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.version <> old_version + 1 THEN
    RAISE EXCEPTION 'vote_convention.version must advance by exactly 1 (old %, new %)', old_version, NEW.version
      USING ERRCODE = 'P0782';
  END IF;
  IF NEW.agree_value = old_agree THEN
    RAISE EXCEPTION 'vote_convention update must change agree_value' USING ERRCODE = 'P0782';
  END IF;
  NEW.changed_at := clock_timestamp();
  NEW.changed_by := session_user;
  RETURN NEW;
END $$;
CREATE TRIGGER vote_convention_monotonic_trg
  BEFORE INSERT OR UPDATE ON public.vote_convention
  FOR EACH ROW EXECUTE FUNCTION public.vote_convention_monotonic();

-- The row is permanent: DELETE (row trigger) and TRUNCATE (statement trigger)
-- refuse. Without it vote_insert would have no sign to write with.
CREATE FUNCTION public.vote_convention_permanent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'vote_convention: % is refused; the row is permanent', TG_OP USING ERRCODE = 'P0790';
END $$;
CREATE TRIGGER vote_convention_no_delete
  BEFORE DELETE ON public.vote_convention
  FOR EACH ROW EXECUTE FUNCTION public.vote_convention_permanent();
CREATE TRIGGER vote_convention_no_truncate
  BEFORE TRUNCATE ON public.vote_convention
  FOR EACH STATEMENT EXECUTE FUNCTION public.vote_convention_permanent();

-- 1.3 The seed: today's convention, version 0. History gets its first row
-- through the trigger.
INSERT INTO public.vote_convention (version, agree_value, reason)
VALUES (0, -1, 'storage convention since 2012: agree = -1, disagree = +1, pass = 0');

-- 1.4 The migration ledger.
CREATE TABLE public.schema_migrations (
  name        text        PRIMARY KEY CHECK (name ~ '^[0-9]{6}_[a-z0-9_]+$'),
  applied_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by  name        NOT NULL DEFAULT session_user,
  checksum    text        NOT NULL CHECK (length(checksum) = 64 OR checksum = 'pre-ledger'),
  note        text        NOT NULL DEFAULT ''
);
COMMENT ON TABLE public.schema_migrations IS
  'One row per applied migration file from 000023 on (sha256 of the file without its ledger line). Rows for earlier files are backfilled as pre-ledger. A restored copy whose rows stop early is older than its missing migrations.';
-- Backfill: every top-level migration file on edge before this one, assumed
-- applied. (There is no 000020.)
INSERT INTO public.schema_migrations (name, checksum, note)
SELECT n, 'pre-ledger', 'assumed applied before the ledger existed'
FROM unnest(ARRAY[
  '000000_initial',
  '000001_update_pwreset_table',
  '000002_add_xid_constraint',
  '000003_add_origin_permanent_cookie_columns',
  '000004_drop_waitinglist_table',
  '000005_drop_slack_stripe_canvas',
  '000006_update_votes_rule',
  '000007_drop_geolocation_fields',
  '000008_add_comment_priority',
  '000009_add_uuid_to_zinvites',
  '000010_create_oidc_user_mappings',
  '000011_alter_suzinvites_xid_to_text',
  '000012_create_topic_agenda_selections',
  '000013_create_treevite',
  '000014_alter_reports_modlevel',
  '000015_add_xid_requirements',
  '000016_add_orig_id',
  '000017_create_byod_job_table',
  '000018_add_topics_enabled',
  '000019_create_polis_queue',
  '000021_create_polis_coordinator',
  '000022_add_poll_timestamp_indexes'
]) AS n
ON CONFLICT DO NOTHING;

-- 2.1 The read: one row, in the caller's statement snapshot.
-- STABLE and a plain SELECT: it never waits on the un-flip's FOR UPDATE; it
-- reads the row its snapshot sees, together with the votes of that snapshot.
-- SECURITY DEFINER: a role with EXECUTE needs no SELECT on the table.
-- The shape matches the engines' join:
--   LEFT JOIN public.vote_convention_current() AS vc ON true  -> vc.version, vc.agree_value
CREATE FUNCTION public.vote_convention_current()
RETURNS TABLE (version integer, agree_value smallint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.version, c.agree_value FROM public.vote_convention c WHERE c.singleton
$$;
COMMENT ON FUNCTION public.vote_convention_current() IS
  'The current vote storage convention (version, agree_value). Call it in the same statement as the votes it interprets.';

-- 2.2 Pure conversions. IMMUTABLE: the sign is an argument, the row is never
-- read. STRICT: NULL in, NULL out (refuse or skip is the caller's policy).
-- Callers validate raw/semantic IN (-1, 0, 1) before calling.
CREATE FUNCTION public.vote_semantic(raw smallint, agree_value smallint) RETURNS smallint
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN raw = 0 THEN 0::smallint ELSE (raw * agree_value)::smallint END
$$;
COMMENT ON FUNCTION public.vote_semantic(smallint, smallint) IS
  'Stored vote -> semantic vote (+1 agree, -1 disagree, 0 pass) under the given agree_value.';
CREATE FUNCTION public.vote_storage(semantic smallint, agree_value smallint) RETURNS smallint
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN semantic = 0 THEN 0::smallint ELSE (semantic * agree_value)::smallint END
$$;
COMMENT ON FUNCTION public.vote_storage(smallint, smallint) IS
  'Semantic vote (+1 agree, -1 disagree, 0 pass) -> stored vote under the given agree_value.';

-- 2.3 The write path: the only sanctioned INSERT into votes.
-- SECURITY DEFINER: SELECT ... FOR SHARE needs UPDATE privilege on
-- vote_convention, which no role but the owner holds. As definer, a caller
-- needs only EXECUTE on this function (revoked from PUBLIC below) and no
-- grant on votes at all; search_path is pinned and every name is qualified.
-- lock_timeout is a function SET clause, not SET LOCAL: it holds while the
-- function runs and the caller's own setting is restored on exit, so a caller
-- inside a longer transaction does not inherit a 2 s lock timeout.
-- FOR SHARE on the singleton: writers do not block each other; the un-flip's
-- FOR UPDATE blocks them (2 s, then 55P03), and a writer that waited re-reads
-- the updated row.
-- Call it in READ COMMITTED: a REPEATABLE READ or SERIALIZABLE caller whose
-- FOR SHARE meets a committed un-flip gets 40001 instead of re-reading the row.
-- The un-flip is safe only when every writer goes through this function: a raw
-- INSERT into votes carries no convention and keeps the old sign.
-- votes_latest_unique is maintained by the existing INSERT rule
-- on_vote_insert_update_unique_table (000006); the un-flip UPDATEs both tables
-- itself because that rule covers INSERT only.
CREATE FUNCTION public.vote_insert(
  p_zid integer, p_pid integer, p_tid integer,
  p_semantic smallint,
  p_weight_x_32767 smallint DEFAULT 0,
  p_high_priority boolean DEFAULT false,
  p_expected_version integer DEFAULT NULL)
RETURNS TABLE (zid integer, pid integer, tid integer, vote smallint, created bigint, convention_version integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  v_version integer;
  v_agree smallint;
BEGIN
  IF p_semantic IS NULL OR p_semantic NOT IN (-1, 0, 1) THEN
    RAISE EXCEPTION 'vote_insert: semantic must be -1, 0 or 1' USING ERRCODE = 'P0783';
  END IF;
  SELECT c.version, c.agree_value INTO v_version, v_agree
    FROM public.vote_convention c WHERE c.singleton FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vote_insert: the vote_convention row is missing; no vote written' USING ERRCODE = 'P0791';
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version <> v_version THEN
    RAISE EXCEPTION 'vote_insert: convention version % expected, % current', p_expected_version, v_version
      USING ERRCODE = 'P0784';
  END IF;
  RETURN QUERY
    INSERT INTO public.votes AS v (zid, pid, tid, vote, weight_x_32767, high_priority)
    VALUES (p_zid, p_pid, p_tid, public.vote_storage(p_semantic, v_agree), p_weight_x_32767, p_high_priority)
    RETURNING v.zid, v.pid, v.tid, v.vote, v.created, v_version;
END $$;
COMMENT ON FUNCTION public.vote_insert(integer, integer, integer, smallint, smallint, boolean, integer) IS
  'Insert one vote given its semantic value (+1 agree, -1 disagree, 0 pass) under the current convention. 55P03 after 2 s: the convention is being changed; retry.';
REVOKE ALL ON FUNCTION public.vote_insert(integer, integer, integer, smallint, smallint, boolean, integer) FROM PUBLIC;

-- 3. Views: one statement, one snapshot; the join to the singleton costs one row.
CREATE VIEW public.votes_semantic AS
  SELECT v.zid, v.pid, v.tid, v.created, v.weight_x_32767, v.high_priority,
         public.vote_semantic(v.vote, c.agree_value) AS semantic_vote,
         CASE public.vote_semantic(v.vote, c.agree_value)
           WHEN 1 THEN 'agree' WHEN -1 THEN 'disagree' WHEN 0 THEN 'pass' END AS reaction,
         c.version AS convention_version
  FROM public.votes v CROSS JOIN public.vote_convention c;
COMMENT ON VIEW public.votes_semantic IS
  'Votes with semantic_vote (+1 agree, -1 disagree, 0 pass, NULL) and the convention version, in one snapshot.';
CREATE VIEW public.votes_latest_unique_semantic AS
  SELECT u.zid, u.pid, u.tid, u.modified, u.weight_x_32767,
         public.vote_semantic(u.vote, c.agree_value) AS semantic_vote,
         CASE public.vote_semantic(u.vote, c.agree_value)
           WHEN 1 THEN 'agree' WHEN -1 THEN 'disagree' WHEN 0 THEN 'pass' END AS reaction,
         c.version AS convention_version
  FROM public.votes_latest_unique u CROSS JOIN public.vote_convention c;
COMMENT ON VIEW public.votes_latest_unique_semantic IS
  'votes_latest_unique with semantic_vote (+1 agree, -1 disagree, 0 pass, NULL) and the convention version, in one snapshot.';

-- 4. Grants.
-- * The server, math and Delphi logins: every deployment in this repository
--   connects them as the role that runs the migrations (the RDS master user of
--   cdk/db.ts; postgres in the Docker stacks), which owns every object above.
--   They need no grant. vote_insert is revoked from PUBLIC, so only the owner
--   (and a role an operator grants explicitly) can call it.
-- * vote_convention_current(), vote_semantic(), vote_storage(): EXECUTE stays
--   with PUBLIC (the PostgreSQL default). The current() function returns two
--   numbers, writes nothing and runs with a pinned search_path; PUBLIC EXECUTE
--   is what lets every reader (math, Delphi, the probe reader, the
--   coordinator, a read replica's login) read the convention without a table
--   grant.
-- * The 000021 coordinator roles get the grants below, when they exist.
-- * polis_probe_reader gets NO direct grant here: ci/probe_box/provision_login.py
--   refuses a reader with a direct grant on any object outside its fixed table
--   list (READER_EXTRA_TABLE_AUTHORITY, READER_FUNCTION_AUTHORITY). It reads
--   the convention through PUBLIC EXECUTE on vote_convention_current(); table
--   and view grants for it land with the probe-box allowlist change.
-- * UPDATE on vote_convention is granted to nobody: the un-flip runs as the
--   owner role.
-- Every grant made is recorded in this file's ledger row (note). All of them
-- are on objects this file creates, so the down file's DROPs remove exactly them.
DO $grants$
DECLARE
  g record;
  made text[] := '{}';
BEGIN
  FOR g IN
    SELECT t.role_name, t.kind, t.object_name, t.privilege
      FROM (VALUES
        ('polis_coordinator_observer',  'TABLE',    'public.vote_convention',                'SELECT'),
        ('polis_coordinator_observer',  'TABLE',    'public.vote_convention_history',        'SELECT'),
        ('polis_coordinator_observer',  'FUNCTION', 'public.vote_convention_current()',      'EXECUTE'),
        ('polis_coordinator_control',   'TABLE',    'public.vote_convention',                'SELECT'),
        ('polis_coordinator_control',   'FUNCTION', 'public.vote_convention_current()',      'EXECUTE'),
        ('polis_coordinator_publisher', 'TABLE',    'public.vote_convention',                'SELECT'),
        ('polis_coordinator_publisher', 'FUNCTION', 'public.vote_convention_current()',      'EXECUTE')
      ) AS t(role_name, kind, object_name, privilege)
     ORDER BY t.role_name COLLATE "C", t.object_name COLLATE "C", t.privilege COLLATE "C"
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = g.role_name)
       AND g.role_name <> current_user THEN
      EXECUTE format('GRANT %s ON %s %s TO %I', g.privilege, g.kind, g.object_name, g.role_name);
      made := made || format('%s:%s:%s', g.role_name, g.privilege, g.object_name);
    END IF;
  END LOOP;
  PERFORM set_config('polis.vote_convention_grants',
                     CASE WHEN cardinality(made) = 0 THEN 'none' ELSE array_to_string(made, ' ') END,
                     true);
END
$grants$;

-- The ledger row for this file, as its last statement (the checksum is the
-- sha256 of this file without the next line).
INSERT INTO public.schema_migrations (name, checksum, note) VALUES ('000023_vote_convention', '879c1445a742fe5787e7428c85f81c185911d3a0c60c26b0bf86d54b70852b5e', 'vote storage convention; grants: ' || current_setting('polis.vote_convention_grants')); -- ledger-self-checksum
COMMIT;
