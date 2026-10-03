-- Test fixture: a stand-in for P-078 PR-A's vote_convention migration.
--
-- PR-A is not on edge yet. The un-flip rehearsal applies "PR-A's DDL if the
-- copy predates it", bound by sha256 (run_spec.convention_ddl_sha256). Until
-- PR-A lands, the rehearsal's tests bind this file instead; the registry
-- template keeps an all-zero digest, so no launch can use it. When PR-A
-- lands, the registry entry binds PR-A's committed file and this fixture is
-- only the tests' input. It follows the PR-A build spec sections 1-3: the
-- singleton, its history, the monotonic guard, the ledger, the read and
-- conversion functions, vote_insert() and the two semantic views. Grants
-- are left out (the rehearsal connects as the copy's master role).

BEGIN;

CREATE TABLE public.vote_convention (
  singleton        boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  version          integer     NOT NULL CHECK (version >= 0),
  agree_value      smallint    NOT NULL CHECK (agree_value IN (-1, 1)),
  changed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by       name        NOT NULL DEFAULT session_user,
  reason           text        NOT NULL CHECK (length(reason) > 0),
  contract_version integer     NOT NULL DEFAULT 1 CHECK (contract_version = 1)
);

CREATE TABLE public.vote_convention_history (
  version          integer     PRIMARY KEY,
  agree_value      smallint    NOT NULL CHECK (agree_value IN (-1, 1)),
  changed_at       timestamptz NOT NULL,
  changed_by       name        NOT NULL,
  reason           text        NOT NULL,
  contract_version integer     NOT NULL
);

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
BEGIN RAISE EXCEPTION 'vote_convention_history is append-only' USING ERRCODE = 'P0781'; END $$;
CREATE TRIGGER vote_convention_history_ro
  BEFORE UPDATE OR DELETE ON public.vote_convention_history
  FOR EACH ROW EXECUTE FUNCTION public.vote_convention_history_immutable();

CREATE FUNCTION public.vote_convention_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'vote_convention.version must advance by exactly 1 (old %, new %)', OLD.version, NEW.version
      USING ERRCODE = 'P0782';
  END IF;
  IF NEW.agree_value = OLD.agree_value THEN
    RAISE EXCEPTION 'vote_convention update must change agree_value' USING ERRCODE = 'P0782';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vote_convention_monotonic_trg
  BEFORE UPDATE ON public.vote_convention
  FOR EACH ROW EXECUTE FUNCTION public.vote_convention_monotonic();

INSERT INTO public.vote_convention (version, agree_value, reason)
VALUES (0, -1, 'storage convention since 2012: agree = -1, disagree = +1, pass = 0');

CREATE TABLE public.schema_migrations (
  name        text        PRIMARY KEY CHECK (name ~ '^[0-9]{6}_[a-z0-9_]+$'),
  applied_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by  name        NOT NULL DEFAULT session_user,
  checksum    text        NOT NULL CHECK (length(checksum) = 64 OR checksum = 'pre-ledger'),
  note        text        NOT NULL DEFAULT ''
);
INSERT INTO public.schema_migrations (name, checksum, note)
VALUES ('000023_vote_convention', 'pre-ledger', 'test fixture standing in for PR-A');

CREATE FUNCTION public.vote_convention_current()
RETURNS TABLE (version integer, agree_value smallint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT version, agree_value FROM public.vote_convention WHERE singleton
$$;

CREATE FUNCTION public.vote_semantic(raw smallint, agree_value smallint) RETURNS smallint
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN raw = 0 THEN 0::smallint ELSE (raw * agree_value)::smallint END
$$;
CREATE FUNCTION public.vote_storage(semantic smallint, agree_value smallint) RETURNS smallint
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN semantic = 0 THEN 0::smallint ELSE (semantic * agree_value)::smallint END
$$;

CREATE FUNCTION public.vote_insert(
  p_zid integer, p_pid integer, p_tid integer,
  p_semantic smallint,
  p_weight_x_32767 smallint DEFAULT 0,
  p_high_priority boolean DEFAULT false,
  p_expected_version integer DEFAULT NULL)
RETURNS TABLE (zid integer, pid integer, tid integer, vote smallint, created bigint, convention_version integer)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_version integer; v_agree smallint;
BEGIN
  IF p_semantic IS NULL OR p_semantic NOT IN (-1, 0, 1) THEN
    RAISE EXCEPTION 'vote_insert: semantic must be -1, 0 or 1' USING ERRCODE = 'P0783';
  END IF;
  SET LOCAL lock_timeout = '2s';
  SELECT c.version, c.agree_value INTO v_version, v_agree
    FROM public.vote_convention c WHERE c.singleton FOR SHARE;
  IF p_expected_version IS NOT NULL AND p_expected_version <> v_version THEN
    RAISE EXCEPTION 'vote_insert: convention version % expected, % current', p_expected_version, v_version
      USING ERRCODE = 'P0784';
  END IF;
  RETURN QUERY
    INSERT INTO public.votes AS v (zid, pid, tid, vote, weight_x_32767, high_priority)
    VALUES (p_zid, p_pid, p_tid, public.vote_storage(p_semantic, v_agree), p_weight_x_32767, p_high_priority)
    RETURNING v.zid, v.pid, v.tid, v.vote, v.created, v_version;
END $$;
REVOKE ALL ON FUNCTION public.vote_insert(integer, integer, integer, smallint, smallint, boolean, integer) FROM PUBLIC;

CREATE VIEW public.votes_semantic AS
  SELECT v.zid, v.pid, v.tid, v.created, v.weight_x_32767, v.high_priority,
         public.vote_semantic(v.vote, c.agree_value) AS semantic_vote,
         CASE public.vote_semantic(v.vote, c.agree_value) WHEN 1 THEN 'agree' WHEN -1 THEN 'disagree' WHEN 0 THEN 'pass' END AS reaction,
         c.version AS convention_version
  FROM public.votes v CROSS JOIN public.vote_convention c;
CREATE VIEW public.votes_latest_unique_semantic AS
  SELECT u.zid, u.pid, u.tid, u.modified, u.weight_x_32767,
         public.vote_semantic(u.vote, c.agree_value) AS semantic_vote,
         CASE public.vote_semantic(u.vote, c.agree_value) WHEN 1 THEN 'agree' WHEN -1 THEN 'disagree' WHEN 0 THEN 'pass' END AS reaction,
         c.version AS convention_version
  FROM public.votes_latest_unique u CROSS JOIN public.vote_convention c;

COMMIT;
