-- 000042_tid_auto_transaction_lock.sql
--
-- Hold the statement-number lock until the inserting transaction ends.
--
-- tid_auto (BEFORE INSERT on comments, 000000_initial.sql) numbers a
-- conversation's statements MAX(tid) + 1, from 0, under the advisory lock
-- (873791984, zid). It took that lock with pg_advisory_lock, a SESSION lock,
-- and tid_auto_unlock (AFTER INSERT) released it as soon as the INSERT
-- statement ended, before its transaction committed. A second INSERT into the
-- same conversation could take the lock in that window and read the same
-- MAX(tid): it then waited on the (zid, tid) unique index and failed with 23505
-- once the first committed, and the comment route answered 409 duplicate, so
-- the statement was not stored. An INSERT that failed after the BEFORE trigger
-- never reached the AFTER trigger, so its session also kept the lock.
--
-- tid_auto now takes pg_advisory_xact_lock, which Postgres releases at COMMIT
-- or ROLLBACK and never earlier. The next INSERT in the conversation waits for
-- it, then reads MAX(tid) with a fresh snapshot (READ COMMITTED: each statement
-- in a volatile PL/pgSQL function takes its own), which includes the committed
-- row. tid_auto_unlock and its trigger are dropped: there is nothing left for
-- them to release, and pg_advisory_unlock on a transaction lock would only
-- warn. Everything else is unchanged: the same lock key, numbering from 0 with
-- no gaps (a failed INSERT uses no number), the same function name, owner,
-- STRICT and volatility, and the same BEFORE INSERT trigger. No table, column,
-- index, constraint or stored row changes.
--
-- Compatibility: additive. No code calls tid_auto_unlock or takes this lock
-- itself; every writer inserts with tid NULL (or lets the trigger overwrite
-- it) and reads the assigned tid back. A release that does not list this
-- migration therefore inserts and numbers statements exactly as it does here.
--
-- Locks at deploy. CREATE OR REPLACE FUNCTION and DROP FUNCTION write the
-- catalog only. DROP TRIGGER takes ACCESS EXCLUSIVE on comments, held until
-- this migration's transaction commits a few statements later: it first waits
-- for transactions already using comments to finish, and comment reads and
-- writes that arrive meanwhile (statement submission, nextComment, comment
-- lists, the vote route's next statement) wait behind it. The wait is bounded
-- by lock_timeout (5 s, set below and by the runner); on timeout the migration
-- fails with no history row, nothing is changed, and the deploy can be retried.
-- So: at most one stall of about 5 s on the comments table, once, and no
-- request refused.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.tid_auto()
    RETURNS trigger AS $$
DECLARE
    _magic_id constant int := 873791984; -- This is a magic key used for locking conversation row-sets within the comments table. TODO keep track of these
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Obtain an advisory lock on the comments table, limited to this
    -- conversation, held until this transaction commits or rolls back.
    PERFORM pg_advisory_xact_lock(_magic_id, _conversation_id);

    SELECT  COALESCE(MAX(tid) + 1, 0) -- Start with comment id of 0
    INTO    NEW.tid
    FROM    comments
    WHERE   zid = NEW.zid;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql STRICT;
DROP TRIGGER tid_auto_unlock ON public.comments;
DROP FUNCTION public.tid_auto_unlock();
COMMIT;
