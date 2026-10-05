-- Private throwaway database; columns used by the real routing queries.
CREATE TABLE conversations (zid integer PRIMARY KEY, strict_moderation boolean, prioritize_seed boolean, is_active boolean DEFAULT true, modified bigint DEFAULT 0);
CREATE TABLE comments (zid integer, tid integer, pid integer, uid integer, created bigint, txt text, velocity double precision, active boolean, mod integer, quote_src_url text, is_seed boolean, is_meta boolean, lang text, original_id uuid);
CREATE TABLE votes_latest_unique (zid integer, pid integer, tid integer, vote smallint);
CREATE TABLE topic_agenda_selections (zid integer, pid integer, archetypal_selections jsonb, delphi_job_id text);
CREATE TABLE math_main (zid integer, math_env text, math_tick bigint, caching_tick bigint, data json);
CREATE FUNCTION now_as_millis() RETURNS bigint LANGUAGE SQL AS $$ SELECT 1700000000000::bigint $$;
CREATE TABLE comment_translations (zid integer, tid integer, txt text, lang text, src integer, created bigint DEFAULT now_as_millis(), modified bigint DEFAULT now_as_millis(), UNIQUE(zid,tid,src,lang));

CREATE TABLE participants(zid integer,pid integer,uid integer,last_interaction bigint,nsli integer,vote_count integer);
CREATE TABLE zinvites(zid integer,zinvite text);
CREATE TABLE votes(pid integer,zid integer,tid integer,vote smallint,weight_x_32767 smallint,high_priority boolean,created bigint DEFAULT now_as_millis());
CREATE TABLE event_ptpt_no_more_comments(zid integer,pid integer,votes_placed integer);
CREATE FUNCTION latest_vote() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 DELETE FROM votes_latest_unique WHERE zid=NEW.zid AND pid=NEW.pid AND tid=NEW.tid;
 INSERT INTO votes_latest_unique VALUES(NEW.zid,NEW.pid,NEW.tid,NEW.vote); RETURN NEW;
END $$;
CREATE TRIGGER latest_vote AFTER INSERT ON votes FOR EACH ROW EXECUTE FUNCTION latest_vote();
