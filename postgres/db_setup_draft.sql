-- NOTE: use \d TABLENAME to see info, like indexes


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
    UNIQUE (email),
    UNIQUE (uid)
);
CREATE INDEX users_uid_idx ON users USING btree (uid);


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


CREATE TABLE courses(
    course_id SERIAL,
    topic VARCHAR(1000),
    description VARCHAR(1000),
    owner INTEGER REFERENCES users(uid),
    course_invite VARCHAR(32),
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE(invite),
    UNIQUE(course_id)
);
CREATE UNIQUE INDEX course_id_idx ON courses USING btree (course_id);


-- This is a light table that's used exclusively for generating IDs
CREATE TABLE conversations(
    -- TODO after testing failure cases with 10, use this:
    -- 2147483647  (2**32/2 -1)
    zid SERIAL,
    topic VARCHAR(1000), -- default as time in the presentation layer
    description VARCHAR(50000),
    link VARCHAR(9999), -- a url to some other page
    upvotes INTEGER NOT NULL DEFAULT 1, -- upvotes for the conversation as a whole
    participant_count INTEGER DEFAULT 0,
    is_anon BOOLEAN DEFAULT TRUE,
    is_active BOOLEAN DEFAULT FALSE,
    is_draft BOOLEAN DEFAULT FALSE, -- TODO check default
    is_public BOOLEAN DEFAULT TRUE,
    profanity_filter BOOLEAN DEFAULT TRUE,
    spam_filter BOOLEAN DEFAULT TRUE,
    strict_moderation BOOLEAN DEFAULT FALSE,
    email_domain VARCHAR(200), -- space separated domain names, "microsoft.com google.com"
    owner INTEGER REFERENCES users(uid), -- TODO use groups(gid)
    -- owner_group_id ?? 
    context VARCHAR(1000), -- for things like a semester of a class, etc
    course_id INTEGER REFERENCES courses(course_id),
    lti_users_only BOOLEAN DEFAULT FALSE,
    owner_sees_participation_stats BOOLEAN DEFAULT FALSE, -- currently maps to users needing a polis account, or to requiring single use urls?
    modified BIGINT DEFAULT now_as_millis(),    
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE(zid)
);
CREATE INDEX conversations_owner_idx ON conversations USING btree (owner);

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
    -- server admin bool
    created BIGINT DEFAULT now_as_millis(),
    -- archived (not included because creator might not be a participant) will add later somewhere else
    UNIQUE (zid, pid),
    UNIQUE (zid, uid) 
);
CREATE INDEX participants_conv_uid_idx ON participants USING btree (uid); -- speed up the inbox query
CREATE INDEX participants_conv_idx ON participants USING btree (zid); -- speed up the auto-increment trigger


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

CREATE TABLE facebook_users (
    uid INTEGER NOT NULL REFERENCES users(uid),
    fb_user_id TEXT,
    fb_public_profile TEXT,
    fb_login_status TEXT,
    fb_auth_response TEXT,
    fb_access_token TEXT,
    fb_granted_scopes TEXT,
    response TEXT,
    fb_friends_response TEXT,
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE(uid),
    UNIQUE(fb_user_id)
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
    created BIGINT DEFAULT now_as_millis(),
    txt VARCHAR(1000) NOT NULL, -- TODO ensure not empty
    velocity REAL NOT NULL DEFAULT 1,
    mod INTEGER NOT NULL DEFAULT 0,-- {-1,0,1} where -1 is reject, 0 is no action, and 1 is accept
    active BOOLEAN NOT NULL DEFAULT TRUE, -- will be false if the comment should not be shown.
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


--CREATE SEQUENCE vote_ids_for_4 START 1 OWNED BY conv.id;
--CREATE SEQUENCE vote_ids START 1 OWNED BY conversations.zid;
-- not enforcing uniqueness, save complete history
-- TODO make a table that has a snapshot of the current state
CREATE TABLE votes(
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    vote SMALLINT,
    created BIGINT DEFAULT now_as_millis()
);
-- needed to make nextComment query fast
-- If updating this index becomes slow, we might consider something else. not sure what.
-- dropped it, didn't really help (Aug 27 2014, no real load on db at the moment)
-- CREATE INDEX votes_zid_pid_idx ON votes USING btree (zid, pid);



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
    created BIGINT DEFAULT now_as_millis(),
);

-- not enforcing uniqueness, save complete history
-- TODO make a table that has a snapshot of the current state
CREATE TABLE trashes(
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    trashed INTEGER NOT NULL, -- 1 for trashed, 0 for untrashed
    created BIGINT DEFAULT now_as_millis(),
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
