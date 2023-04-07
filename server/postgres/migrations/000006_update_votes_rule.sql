DROP RULE IF EXISTS on_vote_insert_update_unique_table ON votes;

CREATE RULE on_vote_insert_update_unique_table AS
    ON INSERT TO votes
    DO ALSO
        INSERT INTO votes_latest_unique (zid, pid, tid, vote, weight_x_32767, modified)
        values (NEW.zid, NEW.pid, NEW.tid, NEW.vote, NEW.weight_x_32767, NEW.created)
            ON CONFLICT (zid, pid, tid) DO UPDATE SET vote = excluded.vote, modified = excluded.modified;
