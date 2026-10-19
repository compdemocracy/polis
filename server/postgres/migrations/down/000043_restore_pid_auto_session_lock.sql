-- down/000043_restore_pid_auto_session_lock.sql  (reversal of 000043_pid_auto_transaction_lock.sql)
--
-- Restores the participant-number triggers exactly as 000000_initial.sql
-- defines them: pid_auto takes the SESSION advisory lock (873791983, zid), and
-- the AFTER INSERT trigger pid_auto_unlock releases it when the INSERT
-- statement ends. No stored row changes in either direction; participant
-- numbers already assigned and participant_count stay as they are.
--
-- Restoring it brings back the defects 000043 removes: two participants joining
-- one conversation at the same moment can be given the same number, and one of
-- them is refused unless the server retries; and an insert that fails or is
-- skipped keeps the lock on its connection.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000043_restore_pid_auto_session_lock.sql
--
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on participants (writes wait, reads
-- do not), bounded by the 5 s lock_timeout below. Runner history is not edited
-- here; the operator removes the 000043 history row in the same sitting, after
-- this succeeds. The runner never runs a down migration automatically.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.pid_auto()
    RETURNS trigger AS $$
DECLARE
    _magic_id constant int := 873791983; -- This is a magic key used for locking conversation row-sets within the participants table. TODO keep track of these
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Obtain an advisory lock on the participants table, limited to this conversation
    PERFORM pg_advisory_lock(_magic_id, _conversation_id);

    SELECT  COALESCE(MAX(pid) + 1, 0) -- Start with comment id of 0
    INTO    NEW.pid
    FROM    participants
    WHERE   zid = NEW.zid;

    -- Duplicate participant_count to the conversations table to speed up conversationsView queries.
    UPDATE conversations
    SET participant_count = NEW.pid + 1
    WHERE zid = NEW.zid;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql STRICT;

CREATE OR REPLACE FUNCTION public.pid_auto_unlock()
    RETURNS trigger AS $$
DECLARE
    _magic_id constant int := 873791983;
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Release the lock.
    PERFORM pg_advisory_unlock(_magic_id, _conversation_id);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql STRICT;

CREATE TRIGGER pid_auto_unlock
    AFTER INSERT ON public.participants
    FOR EACH ROW
    EXECUTE PROCEDURE public.pid_auto_unlock();
COMMIT;
