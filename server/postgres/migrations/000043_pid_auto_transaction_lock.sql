-- 000043_pid_auto_transaction_lock.sql
--
-- Hold the participant-number lock until the inserting transaction ends.
--
-- pid_auto (BEFORE INSERT on participants, 000000_initial.sql) numbers a
-- conversation's participants MAX(pid) + 1, from 0, under the advisory lock
-- (873791983, zid), and copies the count to conversations.participant_count.
-- It took that lock with pg_advisory_lock, a SESSION lock, and pid_auto_unlock
-- (AFTER INSERT) released it as soon as the INSERT statement ended, before its
-- transaction committed. A second INSERT into the same conversation could take
-- the lock in that window and read the same MAX(pid): it then waited on the
-- conversations row the first held and failed with 23505 on (zid, pid) once
-- the first committed, so the join was refused unless the server retried it.
-- An INSERT that failed after the BEFORE trigger, or a row skipped by ON
-- CONFLICT DO NOTHING (the CSV import), never reached the AFTER trigger, so
-- its session kept the lock, through ROLLBACK, until the connection closed.
--
-- pid_auto now takes pg_advisory_xact_lock, which Postgres releases at COMMIT
-- or ROLLBACK and never earlier. The next INSERT in the conversation waits for
-- it, then reads MAX(pid) with a fresh snapshot (READ COMMITTED: each statement
-- in a volatile PL/pgSQL function takes its own), which includes the committed
-- row. pid_auto_unlock and its trigger are dropped: there is nothing left for
-- them to release, and pg_advisory_unlock on a transaction lock would only
-- warn. Everything else is unchanged: the same lock key, numbering from 0 with
-- no gaps (a failed INSERT uses no number), the participant_count update, the
-- same function name, owner, STRICT and volatility, and the same BEFORE INSERT
-- trigger. No table, column, index, constraint or stored row changes. The
-- participant_count UPDATE already held the conversations row until commit, so
-- no join waits longer than it did before.
--
-- Compatibility: additive. No code calls pid_auto_unlock or takes this lock
-- itself; every writer inserts with pid NULL (or lets the trigger overwrite
-- it) and reads the assigned pid back. A release that does not list this
-- migration therefore inserts and numbers participants exactly as it does here.
--
-- Locks at deploy. CREATE OR REPLACE FUNCTION and DROP FUNCTION write the
-- catalog only. DROP TRIGGER takes ACCESS EXCLUSIVE on participants, held
-- until this migration's transaction commits a few statements later: it first
-- waits for transactions already using participants to finish, and
-- participant reads and writes that arrive meanwhile (votes, comments,
-- nextComment, participationInit, joins) wait behind it. The wait is bounded by
-- lock_timeout (5 s, set below and by the runner); on timeout the migration
-- fails with no history row, nothing is changed, and the deploy can be retried.
-- So: at most one stall of about 5 s on the participants table, once, and no
-- request refused.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.pid_auto()
    RETURNS trigger AS $$
DECLARE
    _magic_id constant int := 873791983; -- This is a magic key used for locking conversation row-sets within the participants table. TODO keep track of these
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Obtain an advisory lock on the participants table, limited to this
    -- conversation, held until this transaction commits or rolls back.
    PERFORM pg_advisory_xact_lock(_magic_id, _conversation_id);

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
DROP TRIGGER pid_auto_unlock ON public.participants;
DROP FUNCTION public.pid_auto_unlock();
COMMIT;
