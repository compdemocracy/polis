-- down/000042_restore_tid_auto_session_lock.sql  (reversal of 000042_tid_auto_transaction_lock.sql)
--
-- Restores the statement-number triggers exactly as 000000_initial.sql defines
-- them: tid_auto takes the SESSION advisory lock (873791984, zid), and the
-- AFTER INSERT trigger tid_auto_unlock releases it when the INSERT statement
-- ends. No stored row changes in either direction; statement numbers already
-- assigned stay as they are.
--
-- Restoring it brings back the defect 000042 removes: two statements inserted
-- at the same moment in one conversation can be given the same number, and one
-- of them is refused and not stored.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000042_restore_tid_auto_session_lock.sql
--
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on comments (writes wait, reads do
-- not), bounded by the 5 s lock_timeout below. Runner history is not edited
-- here; the operator removes the 000042 history row in the same sitting, after
-- this succeeds. The runner never runs a down migration automatically.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.tid_auto()
    RETURNS trigger AS $$
DECLARE
    _magic_id constant int := 873791984; -- This is a magic key used for locking conversation row-sets within the comments table. TODO keep track of these
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Obtain an advisory lock on the comments table, limited to this conversation
    PERFORM pg_advisory_lock(_magic_id, _conversation_id);

    SELECT  COALESCE(MAX(tid) + 1, 0) -- Start with comment id of 0
    INTO    NEW.tid
    FROM    comments
    WHERE   zid = NEW.zid;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql STRICT;

CREATE OR REPLACE FUNCTION public.tid_auto_unlock()
    RETURNS trigger AS $$
DECLARE
    _magic_id constant int := 873791984;
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Release the lock.
    PERFORM pg_advisory_unlock(_magic_id, _conversation_id);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql STRICT;

CREATE TRIGGER tid_auto_unlock
    AFTER INSERT ON public.comments
    FOR EACH ROW
    EXECUTE PROCEDURE public.tid_auto_unlock();
COMMIT;
