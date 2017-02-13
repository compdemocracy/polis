-- Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

-- NOTE: use \d TABLENAME to see info, like indexes

-- Intersting query examples:
-- 1.
--  This one uses postgres's ful text search without an index.
-- Query:
--   select topic from conversations where to_tsvector(topic) @@ to_tsquery('(wage | night)  & seattle');
-- Results:
--   Seattle JS Hack Night Frequency
--   Seattle Minimum Wage Hike



CREATE OR REPLACE FUNCTION to_zid(associated_zinvite TEXT) RETURNS INT AS $$
        BEGIN
            RETURN (select zid from zinvites where zinvite = associated_zinvite);
        END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION now_as_millis() RETURNS BIGINT AS $$
        DECLARE
            temp TIMESTAMP := now();
        BEGIN
            -- NOTE: milliseconds includes the seconds, so subtracting seconds from milliseconds
            -- SEE: http://www.postgresql.org/docs/8.4/static/functions-datetime.html
            RETURN 1000*FLOOR(EXTRACT(EPOCH FROM temp)) + FLOOR(EXTRACT(MILLISECONDS FROM temp)) - 1000*FLOOR(EXTRACT(SECOND FROM temp));
        END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION to_millis(t TIMESTAMP WITH TIME ZONE) RETURNS BIGINT AS $$
        BEGIN
            RETURN 1000*FLOOR(EXTRACT(EPOCH FROM t)) + FLOOR(EXTRACT(MILLISECONDS FROM t)) - 1000*FLOOR(EXTRACT(SECOND FROM t));
        END;
$$ LANGUAGE plpgsql;

-- This is a light table that's used exclusively for generating IDs
CREATE TABLE users(
    -- TODO After testing failure cases with 10, use this:
    -- 2147483647  (2**32/2 -1)
    uid SERIAL,
    hname VARCHAR(746), --  human name (the token 'name' returns too many results when grepped) 746 is the longest name on records: (Wolfe+585, Senior.) Some cultures have more than two names, and some people don't even have two names. for example: http://s.ai/dl_redacted_small.png
    created BIGINT DEFAULT now_as_millis(),
    username VARCHAR(128),
    email VARCHAR(256), -- http://stackoverflow.com/questions/386294/what-is-the-maximum-length-of-a-valid-email-address
    is_owner BOOLEAN DEFAULT FALSE, -- has the ability to start conversations
    zinvite VARCHAR(300), -- The initial zinvite used to create the user, can be used for attribution (may be null)
    oinvite VARCHAR(300), -- The oinvite used to create the user, or to upgrade the user to a conversation owner.
    plan SMALLINT DEFAULT 0,
    tut SMALLINT DEFAULT 0,
    site_id VARCHAR(256) NOT NULL DEFAULT random_polis_site_id(), -- TODO add a separate table for this, once we have people with multiple sites
    site_owner BOOLEAN DEFAULT TRUE,
    -- UNIQUE (site_id), -- not unique, since many usres can be admins for the same site_id
    UNIQUE (email),
    UNIQUE (uid)
);
CREATE INDEX users_uid_idx ON users USING btree (uid);
-- alter table users add constraint users_site_id_index UNIQUE(site_id);


CREATE TABLE twitter_users (
    uid INTEGER NOT NULL REFERENCES users(uid),
    twitter_user_id BIGINT NOT NULL,

    -- Fields from here: https://api.twitter.com/1.1/users/lookup.json
    -- NOTE: there are more fields we could fetch
    -- [{"id":1131541,"id_str":"1131541","name":"mbjorkegren","screen_name":"mbjorkegren","location":"","profile_location":null,"description":"","url":null,"entities":{"description":{"urls":[]}},"protected":false,"followers_count":23,"friends_count":47,"listed_count":0,"created_at":"Wed Mar 14 01:52:44 +0000 2007","favourites_count":81,"utc_offset":-28800,"time_zone":"Pacific Time (US & Canada)","geo_enabled":false,"verified":false,"statuses_count":66,"lang":"en","status":{"created_at":"Wed Dec 19 00:58:20 +0000 2012","id":281201767100858369,"id_str":"281201767100858369","text":"Test http:\/\/t.co\/7D0KUDOj Two Systems","source":"\u003ca href=\"https:\/\/kindle.amazon.com\" rel=\"nofollow\"\u003eKindle\u003c\/a\u003e","truncated":false,"in_reply_to_status_id":null,"in_reply_to_status_id_str":null,"in_reply_to_user_id":null,"in_reply_to_user_id_str":null,"in_reply_to_screen_name":null,"geo":null,"coordinates":null,"place":null,"contributors":null,"retweet_count":0,"favorite_count":0,"entities":{"hashtags":[],"symbols":[],"user_mentions":[],"urls":[{"url":"http:\/\/t.co\/7D0KUDOj","expanded_url":"http:\/\/amzn.com\/k\/3a1lRsZGQzuI9xucpcrVNA","display_url":"amzn.com\/k\/3a1lRsZGQzuI\u2026","indices":[5,25]}]},"favorited":false,"retweeted":false,"possibly_sensitive":false,"lang":"en"},"contributors_enabled":false,"is_translator":false,"is_translation_enabled":false,"profile_background_color":"9AE4E8","profile_background_image_url":"http:\/\/abs.twimg.com\/images\/themes\/theme1\/bg.png","profile_background_image_url_https":"https:\/\/abs.twimg.com\/images\/themes\/theme1\/bg.png","profile_background_tile":false,"profile_image_url":"http:\/\/pbs.twimg.com\/profile_images\/2293381619\/image_normal.jpg","profile_image_url_https":"https:\/\/pbs.twimg.com\/profile_images\/2293381619\/image_normal.jpg","profile_link_color":"0000FF","profile_sidebar_border_color":"87BC44","profile_sidebar_fill_color":"E0FF92","profile_text_color":"000000","profile_use_background_image":true,"default_profile":false,"default_profile_image":false,"following":false,"follow_request_sent":false,"notifications":false}]
    screen_name VARCHAR(999) NOT NULL,
    name VARCHAR(9999),
    followers_count INTEGER NOT NULL,
    friends_count INTEGER NOT NULL, -- followees
    verified BOOLEAN NOT NULL,
    profile_image_url_https VARCHAR(9999),
    location VARCHAR(9999),
    response json,
    modified BIGINT NOT NULL DEFAULT now_as_millis(),
    created BIGINT NOT NULL DEFAULT now_as_millis(),
    UNIQUE(uid), -- In theory someone could have multiple twitter accounts, so we might remove this restriction if we add support for that.
    UNIQUE(twitter_user_id)
);


CREATE TABLE site_domain_whitelist(
    site_id VARCHAR(256) NOT NULL,
    domain_whitelist VARCHAR(999),
    modified BIGINT NOT NULL DEFAULT now_as_millis(),
    created BIGINT NOT NULL DEFAULT now_as_millis()
);
CREATE INDEX site_domain_whitelist_idx ON users USING btree (site_id);

-- simple, compact metrics storage. Don't put any bulky stuff like strings here.
-- We'll probably need to replace this with something that scales better.
CREATE TABLE metrics (
    uid INTEGER REFERENCES users(uid),
    type INTEGER NOT NULL,
    dur INTEGER,
    hashedPc INTEGER,
    created BIGINT DEFAULT now_as_millis()
);

CREATE TABLE auth_tokens(
    token VARCHAR(32),
    uid INTEGER REFERENCES users(uid),
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE(token)
);


-- this is the password hashes table.
-- the funny name is a bit of security by obscurity in case
-- somehow we end up with a security hole that allows for
-- querying arbitrary tables. Don't want it called "passwords".
CREATE TABLE jianiuevyew (
    uid INTEGER NOT NULL REFERENCES users(uid),
    pwhash VARCHAR(128) NOT NULL,
    UNIQUE(uid)
);


-- apikeys api key table
-- the funny name is a bit of security by obscurity in case
-- somehow we end up with a security hole that allows for
-- querying arbitrary tables. Don't want it called "apikeys".
CREATE TABLE apikeysndvweifu (
    uid INTEGER NOT NULL REFERENCES users(uid),
    apikey VARCHAR(32) NOT NULL,
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (apikey)
);
CREATE INDEX apikeysndvweifu_uid_idx ON apikeysndvweifu USING btree (uid);
CREATE INDEX apikeysndvweifu_apikey_idx ON apikeysndvweifu USING btree (apikey);





CREATE TABLE coupons_for_free_upgrades (
    uid INTEGER NOT NULL REFERENCES users(uid),
    plan SMALLINT DEFAULT 0,
    code VARCHAR(32) NOT NULL,
    created BIGINT DEFAULT now_as_millis()
);

--CREATE TABLE orgs (
    --oid SERIAL,
    --oname VARCHAR(999)
--);

--CREATE TABLE oadmins (
    --uid REFERENCES users(uid),
    --oid REFERENCES orgs(oid),
    --UNIQUE (uid, oid)
--);

--CREATE TABLE omemberships(
    --oid REFERENCES orgs(oid),
    --uid REFERENCES users(uid),
    --UNIQUE (uid, oid)
--);

--CREATE TABLE org_member_metadata_types (

CREATE TABLE participant_metadata_questions (
    pmqid SERIAL,
    zid INTEGER REFERENCES conversations(zid),
    key VARCHAR(999), -- City, Office, Role, etc
    alive BOOLEAN  DEFAULT TRUE, -- !deleted
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (zid, key), -- TODO index!
    UNIQUE (pmqid)
);

CREATE TABLE participant_metadata_answers (
    pmaid SERIAL,
    pmqid INTEGER REFERENCES participant_metadata_questions(pmqid),
    zid INTEGER REFERENCES conversations(zid), -- for fast disk-local indexing
    value VARCHAR(999), -- Seattle, Office 23, Manager, etc
    alive BOOLEAN DEFAULT TRUE, -- !deleted
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (pmqid, zid, value),
    UNIQUE (pmaid)
);

CREATE TABLE participant_metadata_choices (
    zid INTEGER,
    pid INTEGER,
    pmqid INTEGER REFERENCES participant_metadata_questions(pmqid),
    pmaid INTEGER REFERENCES participant_metadata_answers(pmaid),
    alive BOOLEAN DEFAULT TRUE, -- !deleted
    created BIGINT DEFAULT now_as_millis(),
    FOREIGN KEY (zid, pid) REFERENCES participants (zid, pid),
    UNIQUE (zid, pid, pmqid, pmaid)
);

 ---- top level
---- these can be used to construct the tree, then add an empty list to each node
--SELECT * FROM participant_metadata_questions WHERE zid = 34;
--SELECT * FROM participant_metadata_answers WHERE zid = 34;
-- now populate the tree with participant entries
--SELECT * from participant_metadata_choices WHERE zid = 34;
----for (each) {
----  tree.zid.pmqid.pmaid.push(pid)
----}

CREATE TABLE contexts(
    context_id SERIAL,
    name VARCHAR(300),
    creator INTEGER REFERENCES users(uid), -- rather than owner, since not sure how ownership will be done
    is_public BOOLEAN DEFAULT FALSE,
    created BIGINT DEFAULT now_as_millis()
);

CREATE TABLE courses(
    course_id SERIAL,
    topic VARCHAR(1000),
    description VARCHAR(1000),
    owner INTEGER REFERENCES users(uid),
    course_invite VARCHAR(32),
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE(course_id)
);
CREATE UNIQUE INDEX course_id_idx ON courses USING btree (course_id);


CREATE TABLE conversations(
    -- TODO after testing failure cases with 10, use this:
    -- 2147483647  (2**32/2 -1)
    zid SERIAL,
    topic VARCHAR(1000), -- default as time in the presentation layer
    description VARCHAR(50000),
    link_url VARCHAR(9999), -- a url to some other page
    parent_url VARCHAR(9999), -- url of this embedded conversation's parent frame
    upvotes INTEGER NOT NULL DEFAULT 1, -- upvotes for the conversation as a whole
    participant_count INTEGER DEFAULT 0,
    is_anon BOOLEAN DEFAULT TRUE,
    is_active BOOLEAN DEFAULT FALSE,
    is_draft BOOLEAN DEFAULT FALSE, -- TODO check default
    is_public BOOLEAN DEFAULT TRUE,
    is_data_open BOOLEAN DEFAULT FALSE, -- anyone can export a data dump
    profanity_filter BOOLEAN DEFAULT TRUE,
    spam_filter BOOLEAN DEFAULT TRUE,
    strict_moderation BOOLEAN DEFAULT FALSE,
    vis_type INTEGER NOT NULL DEFAULT 1, -- for now, vis=1 is on, vis=0 is off. in the future, other values may be used for other configurations of vis
    write_type INTEGER NOT NULL DEFAULT 1, -- for now, 1 shows comment form, 0 hides the comment form. in the future, other values may be used for other configurations of comment form
    help_type INTEGER NOT NULL DEFAULT 1, -- 0 for disabled, 1 for enabled
    style_btn VARCHAR(500),
    socialbtn_type INTEGER NOT NULL DEFAULT 1, -- 0 for none, 1 for all,
    bgcolor VARCHAR(20),
    help_bgcolor VARCHAR(20),
    help_color VARCHAR(20),
    email_domain VARCHAR(200), -- space separated domain names, "microsoft.com google.com"
    owner INTEGER REFERENCES users(uid), -- TODO use groups(gid)
    -- owner_group_id ??
    context VARCHAR(1000), -- for things like a semester of a class, etc
    course_id INTEGER REFERENCES courses(course_id),
    lti_users_only BOOLEAN DEFAULT FALSE,
    owner_sees_participation_stats BOOLEAN DEFAULT FALSE, -- currently maps to users needing a polis account, or to requiring single use urls?

    auth_needed_to_vote BOOLEAN, -- if null, server will default to FALSE
    auth_needed_to_write BOOLEAN, -- if null, server will default to TRUE
    auth_opt_fb BOOLEAN, -- if null, server will default to TRUE
    auth_opt_tw BOOLEAN, -- if null, server will default to TRUE
    auth_opt_allow_3rdparty BOOLEAN, -- if null, server will default to TRUE -- this overrides auth_opt_fb and auth_opt_tw if false

    is_slack BOOLEAN DEFAULT FALSE,

--     ptpts_can_vote INTEGER DEFAULT 1,
--     ptpts_can_write INTEGER DEFAULT 1,
--     ptpts_can_see_vis INTEGER DEFAULT 1,


    modified BIGINT DEFAULT now_as_millis(),
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE(zid)
);
CREATE INDEX conversations_owner_idx ON conversations USING btree (owner);

CREATE TABLE slack_oauth_access_tokens (
    slack_access_token VARCHAR(100) NOT NULL,
    slack_scope VARCHAR(100) NOT NULL,
    -- slack_team VARCHAR(100) NOT NULL,    
    slack_auth_response json NOT NULL,
    created BIGINT DEFAULT now_as_millis()
    -- UNIQUE(slack_team)
);

CREATE TABLE inviters (
    inviter_uid INTEGER REFERENCES users(uid),
    invited_email VARCHAR(999),
    created BIGINT DEFAULT now_as_millis()
);

CREATE TABLE upvotes (
    uid INTEGER REFERENCES users(uid),
    zid INTEGER REFERENCES conversations(zid),
    UNIQUE(uid, zid)
);


--  invite codes for Owners
CREATE TABLE oinvites (
    oinvite VARCHAR(300) NOT NULL,
    note VARCHAR(999),
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (oinvite)
);

--  email verification codes
CREATE TABLE einvites (
    einvite VARCHAR(100) NOT NULL,
    email VARCHAR(999),
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (einvite)
);

CREATE TABLE email_validations (
    email VARCHAR(999),
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (email)
);

--  invite codes for converationZ
CREATE TABLE zinvites (
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    zinvite VARCHAR(300) NOT NULL,
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (zinvite)
);
CREATE INDEX zinvites_zid_idx ON zinvites USING btree (zid);

-- TODO flush regularly
CREATE TABLE password_reset_tokens (
    uid INTEGER REFERENCES users(uid),
    created BIGINT DEFAULT now_as_millis(),
    pwresettoken VARCHAR(250),
    UNIQUE (pwresettoken)
);

CREATE TABLE beta(
    name VARCHAR(999),
    email VARCHAR(200),
    organization VARCHAR(200),
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE(email)
);



CREATE TABLE participants(
    pid INTEGER NOT NULL, -- populated by trigger pid_auto
    uid INTEGER NOT NULL REFERENCES users(uid),
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    vote_count INTEGER NOT NULL DEFAULT 0, -- May be greater than number of comments, if they change votes
    -- What counts as an interaction? voting, commenting, reloading the page (tbd if reloading is a good idea)
    last_interaction BIGINT NOT NULL DEFAULT 0,

    -- subscription stuff
    subscribed INTEGER NOT NULL DEFAULT 0, -- 0 for false, 1 for email, 2 for telegram
    last_notified BIGINT DEFAULT 0, -- time of last email

    mod INTEGER NOT NULL DEFAULT 0,-- {-1,0,1,2} where -1 is "hide from vis", 0 is no action, 1 is "acknowledge", and 2 is is "pin" (always show, even if there are lots of high-follower count alternatives)

    -- server admin bool
    created BIGINT DEFAULT now_as_millis(),
    -- archived (not included because creator might not be a participant) will add later somewhere else
    UNIQUE (zid, pid),
    UNIQUE (zid, uid)
);
CREATE INDEX participants_conv_uid_idx ON participants USING btree (uid); -- speed up the inbox query
CREATE INDEX participants_conv_idx ON participants USING btree (zid); -- speed up the auto-increment trigger


CREATE TABLE participants_extended(
    uid INTEGER NOT NULL REFERENCES users(uid),
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    referrer VARCHAR(9999), -- 2083 is listed as the max
    parent_url VARCHAR(9999), -- 2083 is listed as the max
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (zid, uid)
);

CREATE TABLE participant_locations (
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    uid INTEGER NOT NULL REFERENCES users(uid),
    pid INTEGER NOT NULL,
    lat DOUBLE PRECISION NOT NULL, -- latitude
    lng DOUBLE PRECISION NOT NULL, -- longitude
    created BIGINT DEFAULT now_as_millis(),
    source INTEGER NOT NULL, -- 1: manual entry into db, 100:IP,200:HTML5,300:FB,400:Twitter
    UNIQUE (zid, uid)
);


-- mapping between uid and (owner,eXternalID)
CREATE TABLE xids (
    uid INTEGER NOT NULL REFERENCES users(uid),
    owner INTEGER NOT NULL REFERENCES users(uid),
    xid TEXT NOT NULL, -- TODO add constraint to limit length
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (owner, xid)
);
CREATE INDEX xids_owner_idx ON xids USING btree (owner);

-- this could probably be called external_user_links, and should have a scope for the user identities, like "canvas.instructure.com" or something like that
-- NOTE, there may be multiple uids for a given lti_user_id
CREATE TABLE lti_users (
    uid INTEGER NOT NULL REFERENCES users(uid),
    lti_user_id TEXT NOT NULL, -- TODO add constraint to limit length
    lti_user_image VARCHAR(9999), -- URL - may be null
    tool_consumer_instance_guid TEXT NOT NULL,
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (lti_user_id, tool_consumer_instance_guid)
);

CREATE TABLE lti_context_memberships (
    uid INTEGER NOT NULL REFERENCES users(uid),
    lti_context_id TEXT NOT NULL,
    tool_consumer_instance_guid TEXT NOT NULL
);

CREATE TABLE geolocation_cache (
    location VARCHAR(9999), -- "Seattle, WA"
    lat DOUBLE PRECISION NOT NULL, -- latitude
    lng DOUBLE PRECISION NOT NULL, -- longitude
    response json,
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (location)
);


CREATE TABLE slack_users (
    uid INTEGER NOT NULL REFERENCES users(uid),
    slack_team VARCHAR(20) NOT NULL,
    slack_user_id VARCHAR(20) NOT NULL,
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE(slack_team, slack_user_id)
);
CREATE TABLE slack_user_invites (
    slack_team VARCHAR(20) NOT NULL,
    slack_user_id VARCHAR(20) NOT NULL,
    token VARCHAR(100) NOT NULL,
    created BIGINT DEFAULT now_as_millis()
);

CREATE TABLE slack_bot_events (
    -- slack_team VARCHAR(20) NOT NULL,
    id SERIAL, -- to help with deleting
    event json NOT NULL,
    created BIGINT DEFAULT now_as_millis()
);



CREATE TABLE facebook_users (
    uid INTEGER NOT NULL REFERENCES users(uid),
    fb_user_id TEXT,
    fb_name VARCHAR(9999),
    fb_link VARCHAR(9999),
    fb_public_profile TEXT,
    fb_login_status TEXT,
    fb_auth_response TEXT,
    fb_access_token TEXT,
    fb_granted_scopes TEXT,
    fb_location_id VARCHAR(100), -- "110843418940484"
    location VARCHAR(9999), -- "Seattle, WA"
    response TEXT,
    fb_friends_response TEXT,
    created BIGINT DEFAULT now_as_millis(),
    modified BIGINT DEFAULT now_as_millis(),
    UNIQUE(uid),
    UNIQUE(fb_user_id)
);

CREATE TABLE social_settings (
    uid INTEGER NOT NULL REFERENCES users(uid),
    polis_pic VARCHAR(3000) -- profile picture url (should be https)
);

-- we may have duplicates, since no upsert. We should periodically remove duplicates.
-- there may also be duplicates in the reverse direction
-- or we may have a one-way mapping because one user signed on before their friend.

------------ sample "get all friends" query ---------
-- select friend from facebook_friends where uid = 302 union select uid from facebook_friends where friend = 302;
------------------------------------------------------

CREATE TABLE facebook_friends (
    uid INTEGER NOT NULL REFERENCES users(uid),
    friend INTEGER NOT NULL REFERENCES users(uid)
    -- UNIQUE(uid, friend)
);




-- the use-case for this table is that there are many conversations, but a single grading callback for the whole course
-- allowing for duplicates (for now) by using 'created' field
-- TODO don't allow for duplicates
CREATE TABLE canvas_assignment_callback_info (
    tool_consumer_instance_guid VARCHAR(999) NOT NULL,
    lti_context_id TEXT NOT NULL, -- TODO add constraint to limit length
    lti_user_id TEXT NOT NULL, -- TODO add constraint to limit length
    custom_canvas_assignment_id BIGINT NOT NULL,

    lis_result_sourcedid VARCHAR(256),
    lis_outcome_service_url TEXT, -- TODO add constraint to limit length
    stringified_json_of_post_content TEXT, -- TODO add constraint to limit length
    created BIGINT DEFAULT now_as_millis(),
    grade_assigned DOUBLE PRECISION DEFAULT NULL, -- leave this null until we assign a grade, we want to keep track of which of these are resolved.
    UNIQUE (lti_user_id, lti_context_id, custom_canvas_assignment_id, tool_consumer_instance_guid)
);

CREATE TABLE canvas_assignment_conversation_info (
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    tool_consumer_instance_guid VARCHAR(999) NOT NULL,
    lti_context_id VARCHAR(999) NOT NULL,
    custom_canvas_assignment_id BIGINT NOT NULL,
    UNIQUE(zid, tool_consumer_instance_guid, lti_context_id, custom_canvas_assignment_id)
);

CREATE TABLE lti_oauthv1_credentials (
    uid INTEGER NOT NULL REFERENCES users(uid),
    oauth_consumer_key VARCHAR(999) NOT NULL,
    oauth_shared_secret VARCHAR(999) NOT NULL,
    UNIQUE(uid) -- NOTE: if we want to allow multiple keys per instructor, we'd need to scope to tool_consumer_instance_guid, and maybe lti_context_id, but let's not go there yet
);


-- Single Use Invites
-- These records should contain enough to populate a record in the xids table (in conjunction with creating a user, which provides a uid)
CREATE TABLE suzinvites (
    owner INTEGER NOT NULL REFERENCES users(uid),
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    xid VARCHAR(32) NOT NULL,
    created BIGINT DEFAULT now_as_millis(),
    suzinvite VARCHAR(32), -- Be sure the URLs fit in Tweets.  pol.is/<xinvite>
    UNIQUE (suzinvite)
);
CREATE INDEX suzinvites_owner_zid_idx ON suzinvites USING btree (owner, zid);


--CREATE TABLE permissions(
    --uid INTEGER NOT NULL REFERENCES users(uid),
    --zid INTEGER NOT NULL REFERENCES conversations(zid),
    --rwx?
    --admin bool
--);


 -- can't rely on SEQUENCEs since they may have gaps.. or maybe we can live with that? maybe we use a trigger incrementer like on the participants table? that would mean locking on a per conv basis, maybe ok for starters
CREATE TABLE comments(
    tid INTEGER NOT NULL, -- populated by trigger tid_auto
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    created BIGINT DEFAULT now_as_millis(),
    modified BIGINT DEFAULT now_as_millis(),
    txt VARCHAR(1000) NOT NULL, -- TODO ensure not empty
    velocity REAL NOT NULL DEFAULT 1,
    mod INTEGER NOT NULL DEFAULT 0,-- {-1,0,1} where -1 is reject, 0 is no action, and 1 is accept
    active BOOLEAN NOT NULL DEFAULT TRUE, -- will be false if the comment should not be shown.
    tweet_id BIGINT, -- Used when this comment is an imported tweet, else null.
    quote_src_url VARCHAR(1000), -- URL for a page where the (presumably) famous person's quote can be found
    anon BOOLEAN NOT NULL DEFAULT false, -- if true, the author of the comment will not be shown.
    is_seed BOOLEAN NOT NULL DEFAULT false,
    UNIQUE(zid, txt),    --issued this: ALTER TABLE comments ADD CONSTRAINT comments_txt_unique_constraint UNIQUE (zid, txt);
    FOREIGN KEY (zid, pid) REFERENCES participants (zid, pid)
);
CREATE INDEX comments_zid_idx ON comments USING btree (zid);
-- for a faster nextComment query (where pid != myPid)
-- dropped it, didn't really help (Aug 27 2014, no real load on db at the moment)
-- CREATE INDEX comments_zid_pid_idx ON comments USING btree (zid, pid);

CREATE OR REPLACE FUNCTION tid_auto()
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

CREATE TRIGGER tid_auto
    BEFORE INSERT ON comments
    FOR EACH ROW -- WHEN (NEW.tid = 0 || NEW.tid = null)
    EXECUTE PROCEDURE tid_auto();

CREATE OR REPLACE FUNCTION tid_auto_unlock()
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
    AFTER INSERT ON comments
    FOR EACH ROW
    EXECUTE PROCEDURE tid_auto_unlock();

-- NOTE: not currently used, but is a nice example of using RETURNS TABLE, as opposed to RETURNS SET OF
-- taking moderation settings into account, return the timestamp for the latest comment
CREATE FUNCTION get_times_for_most_recent_visible_comments() RETURNS TABLE (zid INTEGER, modified BIGINT) AS $$
    select zid, max(modified) from (select comments.*, conversations.strict_moderation from comments left join conversations on comments.zid = conversations.zid) as c where c.mod >= (CASE WHEN c.strict_moderation=TRUE then 1 else 0 END) group by c.zid order by c.zid;
$$ LANGUAGE SQL;


CREATE TABLE math_ticks (
    zid INTEGER REFERENCES conversations(zid),
    math_tick BIGINT NOT NULL DEFAULT 0,
    modified BIGINT NOT NULL DEFAULT now_as_millis(),
    UNIQUE (zid)
);


-- insert into math_ticks (zid) values ($1) on conflict (zid) 
--    do update set modified = now_as_millis(), math_tick = (math_tick + 1) returning *;



--CREATE SEQUENCE vote_ids_for_4 START 1 OWNED BY conv.id;
--CREATE SEQUENCE vote_ids START 1 OWNED BY conversations.zid;
-- not enforcing uniqueness, save complete history
-- TODO make a table that has a snapshot of the current state
CREATE TABLE votes(
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,

    vote SMALLINT,

    -- Divide by 32767 before using! (and multiply by 32767 before storing). Applications should refer to this as "weight" after converting to a float in the range [-1, 1]
    -- This is a SMALLINT for space saving reasons only (since vote is also SMALLINT (2 bytes), They'll line up w 4 a byte boundary).
    -- -1.0 for "Don't show", 1.0 for "Show a lot", 0.0 is default.
    weight_x_32767 SMALLINT DEFAULT 0,

    created BIGINT DEFAULT now_as_millis()
);
-- needed to make nextComment query fast
-- If updating this index becomes slow, we might consider something else. not sure what.
-- dropped it, didn't really help (Aug 27 2014, no real load on db at the moment)
CREATE INDEX votes_zid_pid_idx ON votes USING btree (zid, pid);


-- since each participant can change their vote, and those values are stored in votes, use this if you want to fetch the current state
-- CREATE FUNCTION votes_lastest_unique(int) RETURNS SETOF votes AS $$
--     WITH m AS (SELECT zid, pid, tid, MAX(created) AS created FROM votes WHERE zid = $1 GROUP BY zid, pid, tid) SELECT v.* FROM m LEFT JOIN votes v ON m.zid = v.zid AND m.pid = v.pid AND m.tid = v.tid WHERE m.created = v.created;
-- $$ LANGUAGE SQL;

-- udpate the votes_latest_unique table if it gets out of sync
-- insert into votes_latest_unique (zid, pid, tid, vote, modified, weight_x_32767) select zid, pid, tid, vote, created as modified, weight_x_32767 from (WITH m AS (SELECT zid, pid, tid, MAX(created) AS created FROM votes GROUP BY zid, pid, tid) SELECT v.* FROM m LEFT JOIN votes v ON m.zid = v.zid AND m.pid = v.pid AND m.tid = v.tid WHERE m.created = v.created) as foo;
-- if that fails, run this and retry
-- delete from votes a where a.ctid <> (select min(b.ctid) from votes b where a.zid = b.zid and a.tid = b.tid and a.pid = b.pid and a.vote = b.vote and a.created = b.created);

CREATE TABLE votes_latest_unique (    
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,

    vote SMALLINT,

    -- Divide by 32767 before using! (and multiply by 32767 before storing). Applications should refer to this as "weight" after converting to a float in the range [-1, 1]
    -- This is a SMALLINT for space saving reasons only (since vote is also SMALLINT (2 bytes), They'll line up w 4 a byte boundary).
    -- -1.0 for "Don't show", 1.0 for "Show a lot", 0.0 is default.
    weight_x_32767 SMALLINT DEFAULT 0,

    modified BIGINT DEFAULT now_as_millis(),
    UNIQUE (zid, pid, tid)
);
CREATE INDEX votes_latest_unique_zid_tid_idx ON votes USING btree (zid, tid);


CREATE RULE on_vote_insert_update_unique_table AS
    ON INSERT TO votes
    DO ALSO
        INSERT INTO votes_latest_unique (zid, pid, tid, vote, weight_x_32767, modified)
        values (NEW.zid, NEW.pid, NEW.tid, NEW.vote, NEW.weight_x_32767, NEW.created)
            ON CONFLICT (zid, pid, tid) DO UPDATE SET vote = excluded.vote, modified = NEW.created;


CREATE TABLE crowd_mod (
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    created BIGINT DEFAULT now_as_millis(),

    -- agreed
    as_important BOOLEAN,
    as_factual BOOLEAN,
    as_feeling BOOLEAN,

    -- disagreed
    as_notmyfeeling BOOLEAN,
    as_notgoodidea BOOLEAN,
    as_notfact BOOLEAN,
    --as_abusive BOOLEAN,

    -- passed
    as_unsure BOOLEAN,
    as_spam BOOLEAN,
    as_abusive BOOLEAN,
    as_offtopic BOOLEAN
);





CREATE TABLE event_ptpt_no_more_comments (
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    votes_placed SMALLINT NOT NULL,
    created BIGINT DEFAULT now_as_millis()
);


CREATE TABLE contributer_agreement_signatures(
    uid INTEGER REFERENCES users(uid),
    name VARCHAR(746) NOT NULL,
    company_name VARCHAR(746),
    github_id VARCHAR(256),
    email VARCHAR(256) NOT NULL, -- http://stackoverflow.com/questions/386294/what-is-the-maximum-length-of-a-valid-email-address
    agreement_version INTEGER NOT NULL,
    created BIGINT DEFAULT now_as_millis()
);


CREATE TABLE waitinglist (
    email VARCHAR(256) NOT NULL,
    campaign VARCHAR(100) NOT NULL,
    name VARCHAR(746),
    affiliation VARCHAR(999),
    role VARCHAR(999),
    intercom_lead_user_id VARCHAR(100),
    created BIGINT DEFAULT now_as_millis()
);

-- -- This should be updated from math nodes, who will have an entire conversation loaded in memory.
-- CREATE TABLE stats_per_comment(
--     zid INTEGER NOT NULL,
--     tid INTEGER NOT NULL,
--     total INTEGER NOT NULL,
--     agree INTEGER NOT NULL,
--     disagree INTEGER NOT NULL,
--     last_timestamp BIGINT NOT NULL,
--     UNIQUE (zid, tid);
-- );

-- not enforcing uniqueness, save complete history
-- TODO make a table that has a snapshot of the current state
CREATE TABLE stars(
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    starred INTEGER NOT NULL, -- 0 for unstarred, 1 for starred
    created BIGINT DEFAULT now_as_millis()
);

-- not enforcing uniqueness, save complete history
-- TODO make a table that has a snapshot of the current state
CREATE TABLE trashes(
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    trashed INTEGER NOT NULL, -- 1 for trashed, 0 for untrashed
    created BIGINT DEFAULT now_as_millis()
);


-- used to force a login when someone signs out from a browser, and then joins the same conversation from that browser
CREATE TABLE permanentCookieZidJoins(
    zid INTEGER NOT NULL,
    cookie VARCHAR(32),
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (zid, cookie)
);

CREATE TRIGGER pid_auto
    BEFORE INSERT ON participants
    FOR EACH ROW -- WHEN (NEW.pid = 0 || NEW.pid = null)
    EXECUTE PROCEDURE pid_auto();

CREATE OR REPLACE FUNCTION pid_auto()
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

CREATE OR REPLACE FUNCTION pid_auto_unlock()
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
    AFTER INSERT ON participants
    FOR EACH ROW
    EXECUTE PROCEDURE pid_auto_unlock();

--BEGIN;
    --insert into memberships (uid, gid) values (
        --(insert into users values (default) returning uid),
        --(insert into groups values (default) returning gid));
--COMMIT;

BEGIN;
    insert into users values (1000, 'joe');
    --insert into groups values (11000);
    --insert into memberships (uid, gid) values (1000, 11000);
COMMIT;

BEGIN;
    insert into users values (1001, 'fran');
    --insert into groups values (11001);
    --insert into memberships (uid, gid) values (1001, 11001);
COMMIT;

BEGIN;
    insert into users values (1002, 'holly');
    --insert into groups values (11002);
    --insert into memberships (uid, gid) values (1002, 11002);
COMMIT;

INSERT INTO conversations (zid, owner, created, topic, description, is_active, is_draft) values (45342, 1000, default, 'Legalization', 'Seattle recently ...', default, default);
INSERT INTO conversations (zid, owner, created, topic, description, is_active, is_draft) values (983572, 1000, default, 'Legalization 2', 'Seattle recently ....', default, default);

BEGIN;
    INSERT INTO participants (zid, uid) VALUES ( 45342, 1001);
COMMIT;

BEGIN;
    INSERT INTO participants (zid, uid) VALUES ( 45342, 1002);
COMMIT;


--CREATE FUNCTION create_new_user(subtotal real) RETURNS real AS $$
--BEGIN
    --RETURN subtotal * 0.06;
--END;
--$$ LANGUAGE plpgsql;

--WITH foo as (insert into groups VALUES (default) returning gid),
     --bar as (insert into users VALUES (default) returning uid)
     --insert into memberships (uid, gid) select uid, gid from join(bar.uid, foo.gid);
--
     --select zid from conversations
         --where zid in (
            --select zid from foo
        --);
--
--
--CREATE OR REPLACE FUNCTION uid_self_group_auto()
    --RETURNS trigger AS $$
--DECLARE
    --_uid int;
    --_gid int;
--BEGIN
    --_uid = NEW.uid;
    --_gid =
--
    --FOR _users in users
    ---- Obtain an advisory lock on the participants table, limited to this conversation

    --RETURN NEW;
--END;
--$$ LANGUAGE plpgsql STRICT;


CREATE TABLE page_ids (
    site_id VARCHAR(100) NOT NULL,
    page_id VARCHAR(100) NOT NULL,
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    UNIQUE(site_id, page_id)
);

-- http://stackoverflow.com/questions/3970795/how-do-you-create-a-random-string-in-postgresql
CREATE OR REPLACE FUNCTION random_string(INTEGER)
RETURNS TEXT AS
$BODY$
SELECT array_to_string(
    ARRAY (
        SELECT substring(
            '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
            FROM (ceil(random()*62))::int FOR 1
        )
        FROM generate_series(1, $1)
    ),
    ''
)
$BODY$
LANGUAGE sql VOLATILE;

CREATE OR REPLACE FUNCTION random_polis_site_id()
RETURNS TEXT AS
$BODY$
-- 18 so it's 32 long, not much thought went into this so far
SELECT 'polis_site_id_' || random_string(18);
$BODY$
LANGUAGE sql VOLATILE;



