
-- This is a light table that's used exclusively for generating IDs
CREATE TABLE users(
    -- TODO After testing failure cases with 10, use this:
    -- 2147483647  (2**32/2 -1)
    uid INTEGER UNIQUE DEFAULT CEIL(RANDOM() * 100),
    given_name VARCHAR(64),
    family_name VARCHAR(64),
    pwhash VARCHAR(128),
    created TIMESTAMP WITH TIME ZONE DEFAULT now(),
    username VARCHAR(128),
    email VARCHAR(256)
);

--CREATE TABLE groups(
    ---- TODO After testing failure cases with 10, use this:
    ---- 2147483647  (2**32/2 -1)
    --gid INTEGER UNIQUE DEFAULT CEIL(RANDOM() * 10)
--);

--CREATE TABLE memberships(
    --gid INTEGER REFERENCES groups(gid),
    --uid INTEGER REFERENCES users(uid),
    --UNIQUE (gid, uid)
--);

-- This is a light table that's used exclusively for generating IDs
CREATE TABLE conversations(
    -- TODO after testing failure cases with 10, use this:
    -- 2147483647  (2**32/2 -1)
    zid INTEGER UNIQUE DEFAULT (CEIL(RANDOM() * 100)),
    owner INTEGER REFERENCES users(uid), -- TODO use groups(gid)
    -- owner_group_id ?? 
    isActive BOOLEAN DEFAULT FALSE,
    isDraft BOOLEAN DEFAULT FALSE, -- TODO check default
    isAnon BOOLEAN DEFAULT TRUE,
    isPublic BOOLEAN DEFAULT TRUE,
    participantsMustHaveAcct BOOLEAN DEFAULT FALSE,
    participantsMustValidate BOOLEAN DEFAULT FALSE,
    participantsMustHaveEmail BOOLEAN DEFAULT FALSE,
    participantsMustHaveEmailDomain VARCHAR(200), -- space separated domain names
    created TIMESTAMP WITH TIME ZONE DEFAULT now(),
    topic VARCHAR(1000), -- default as time in the presentation layer
    description VARCHAR(50000),
    UNIQUE(zid)
);

CREATE TABLE participants(
    pid INTEGER NOT NULL, -- populated by trigger pid_auto
    uid INTEGER NOT NULL REFERENCES users(uid),
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    -- server admin bool
    created TIMESTAMP WITH TIME ZONE DEFAULT now(),
    -- archived (not included because creator might not be a participant) will add later somewhere else
    UNIQUE (zid, pid),
    UNIQUE (zid, uid) 
);


--CREATE TABLE permissions(
    --uid INTEGER NOT NULL REFERENCES users(uid),
    --zid INTEGER NOT NULL REFERENCES conversations(zid),
    --rwx?
    --admin bool
--);


CREATE INDEX participants_conv_idx ON participants USING btree (zid); -- speed up the auto-increment trigger

 -- can't rely on SEQUENCEs since they may have gaps.. or maybe we can live with that? maybe we use a trigger incrementer like on the participants table? that would mean locking on a per conv basis, maybe ok for starters
CREATE TABLE comments(
    tid INTEGER NOT NULL, -- populated by trigger tid_auto
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    created TIMESTAMP WITH TIME ZONE DEFAULT now(),
    txt VARCHAR(1000) NOT NULL,
    FOREIGN KEY (zid, pid) REFERENCES participants (zid, pid)
);

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
CREATE TABLE votes(
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    vote SMALLINT,
    created TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE (tid, pid)
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

INSERT INTO conversations (zid, owner, created, topic, description, active, draft) values (45342, 1000, default, 'Legalization', 'Seattle recently ...', default, default);
INSERT INTO conversations (zid, owner, created, topic, description, active, draft) values (983572, 1000, default, 'Legalization 2', 'Seattle recently ....', default, default);
    
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
