-- This is a light table that's used exclusively for generating IDs
CREATE TABLE users(
    -- TODO After testing failure cases with 10, use this:
    -- 2147483647  (2**32/2 -1)
    user_id INTEGER UNIQUE DEFAULT CEIL(RANDOM() * 10)
);

--CREATE TABLE groups(
    ---- TODO After testing failure cases with 10, use this:
    ---- 2147483647  (2**32/2 -1)
    --gid INTEGER UNIQUE DEFAULT CEIL(RANDOM() * 10)
--);

--CREATE TABLE memberships(
    --gid INTEGER REFERENCES groups(gid),
    --user_id INTEGER REFERENCES users(user_id),
    --UNIQUE (gid, user_id)
--);

CREATE TABLE user_info(
    user_id INTEGER REFERENCES users(user_id),
    name VARCHAR
);

-- This is a light table that's used exclusively for generating IDs
CREATE TABLE conversations(
    -- TODO after testing failure cases with 10, use this:
    -- 2147483647  (2**32/2 -1)
    cid INTEGER UNIQUE DEFAULT (CEIL(RANDOM() * 10))
);


CREATE TABLE conversation_info(
    cid INTEGER REFERENCES conversations(cid),
    --owner INTEGER REFERENCES groups(gid),
    owner INTEGER REFERENCES users(user_id), -- TODO use groups(gid)
    created TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(cid)
    -- owner_group_id ?? 
);

CREATE TABLE conversation_topics(
    cid INTEGER REFERENCES conversations(cid),
    title VARCHAR(1000),
    body VARCHAR(50000)
);

CREATE TABLE participants(
    pid INTEGER, -- populated by trigger pid_auto
    cid INTEGER NOT NULL REFERENCES conversations(cid),
    user_id INTEGER NOT NULL REFERENCES users(user_id),
    UNIQUE (pid, cid),
    UNIQUE (cid, user_id) 
);

CREATE INDEX participants_conv_idx ON participants USING btree (cid); -- speed up the auto-increment trigger

CREATE TABLE participant_info(
    cid INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    FOREIGN KEY (cid, user_id) REFERENCES participants (cid, user_id),
    created TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE (cid, user_id)
);

 -- can't rely on SEQUENCEs since they may have gaps.. or maybe we can live with that? maybe we use a trigger incrementer like on the participants table? that would mean locking on a per conv basis, maybe ok for starters
CREATE TABLE opinions(
    oid INTEGER NOT NULL,
    cid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    FOREIGN KEY (cid, pid) REFERENCES participants (cid, pid),
    UNIQUE (oid)
);




--CREATE SEQUENCE vote_ids_for_4 START 1 OWNED BY conv.id;
--CREATE SEQUENCE vote_ids START 1 OWNED BY conversations.cid;
CREATE TABLE votes(
    vid INTEGER NOT NULL,
    cid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    oid INTEGER NOT NULL,
    FOREIGN KEY (pid, cid) REFERENCES participants (pid, cid),
    FOREIGN KEY (oid) REFERENCES opinions (oid),
    vote SMALLINT,
    created TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE (oid, pid),
    UNIQUE (vid)
);

CREATE TRIGGER pid_auto
    BEFORE INSERT ON participants
    FOR EACH ROW WHEN (NEW.pid = 0)
    EXECUTE PROCEDURE pid_auto();

CREATE OR REPLACE FUNCTION pid_auto()
    RETURNS trigger AS $$
DECLARE
    _magic_id constant int := 873791983; -- This is a magic key used for locking conversation row-sets within the participants table. TODO keep track of these 
    _conversation_id int;
BEGIN
    _conversation_id = NEW.cid;

    -- Obtain an advisory lock on the participants table, limited to this conversation
    PERFORM pg_advisory_lock(_magic_id, _conversation_id);

    SELECT  COALESCE(MAX(pid) + 1, 1)
    INTO    NEW.pid
    FROM    participants
    WHERE   cid = NEW.cid;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql STRICT;

CREATE OR REPLACE FUNCTION pid_auto_unlock()
    RETURNS trigger AS $$
DECLARE
    _magic_id constant int := 873791983;
    _conversation_id int;
BEGIN
    _conversation_id = NEW.cid;

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
    --insert into memberships (user_id, gid) values (
        --(insert into users values (default) returning uid),
        --(insert into groups values (default) returning gid));
--COMMIT;

BEGIN;
    insert into users values (1000);
    --insert into groups values (11000);
    --insert into memberships (user_id, gid) values (1000, 11000);
COMMIT;

BEGIN;
    insert into users values (1001);
    --insert into groups values (11001);
    --insert into memberships (user_id, gid) values (1001, 11001);
COMMIT;

BEGIN;
    insert into users values (1002);
    --insert into groups values (11002);
    --insert into memberships (user_id, gid) values (1002, 11002);
COMMIT;


insert into conversations values (45342);
insert into conversation_info (cid, owner) values (45342, 1000);

insert into conversations values (983572);
insert into conversation_info (cid, owner) values (983572, 1000);
    
BEGIN;
    INSERT INTO participants (cid, user_id) VALUES ( 45342, 1001);
    INSERT INTO participant_info (cid, user_id) VALUES ( 45342, 1001);
COMMIT;

BEGIN;
    INSERT INTO participants (cid, user_id) VALUES ( 45342, 1002);
    INSERT INTO participant_info (cid, user_id) VALUES ( 45342, 1002);
COMMIT;


--CREATE FUNCTION create_new_user(subtotal real) RETURNS real AS $$
--BEGIN
    --RETURN subtotal * 0.06;
--END;
--$$ LANGUAGE plpgsql;

--WITH foo as (insert into groups VALUES (default) returning gid),
     --bar as (insert into users VALUES (default) returning user_id)
     --insert into memberships (user_id, gid) select user_id, gid from join(bar.user_id, foo.gid);
--
     --select cid from conversations
         --where cid in (
            --select cid from foo
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
