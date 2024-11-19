-- This migration fixes an issue with a poorly specified rule definition in the original 000000_initial.sql schema.
-- The old specification worked on Postgres 13, but not longer does on Postgres 14.
-- Consequently, if you set up your Polis database prior to April 9th, 2023, and wish to upgrade to Postgres 14,
-- you should run this migration first.

DROP RULE IF EXISTS on_vote_insert_update_unique_table ON votes;

CREATE RULE on_vote_insert_update_unique_table AS
    ON INSERT TO votes
    DO ALSO
        INSERT INTO votes_latest_unique (zid, pid, tid, vote, weight_x_32767, modified)
        values (NEW.zid, NEW.pid, NEW.tid, NEW.vote, NEW.weight_x_32767, NEW.created)
            ON CONFLICT (zid, pid, tid) DO UPDATE SET vote = excluded.vote, modified = excluded.modified;
