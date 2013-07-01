-- This is a light table that's used exclusively for generating IDs
CREATE TABLE conversations(
    -- TODO after testing failure cases with 10, use this:
    -- 2147483647  (2**32/2 -1)
    conv_id INTEGER UNIQUE DEFAULT (CEIL(RANDOM() * 10))
);

CREATE TABLE conversation_info(
    conv_id INTEGER REFERENCES conversations(conv_id),
    owner_id INTEGER REFERENCES users(user_id),
    created TIMESTAMP WITH TIME ZONE DEFAULT now()
    -- owner_group_id ?? 
);
CREATE UNIQUE INDEX conversation_info(conv_id);


CREATE TABLE conversation_topics(
    conv_id INTEGER REFERENCES conv(id),
    title VARCHAR(1000),
    body VARCHAR(50000)
);
CREATE UNIQUE INDEX conversation_topics_idx(conv_id);


CREATE TABLE opinions(
    op_id INTEGER,
    ptpt_id INTEGER,
    conv_id INTEGER REFERENCES conversations(conv_id),
    UNIQUE (op_id, conv_id)
);


 -- can't rely on SEQUENCEs since they may have gaps.. or maybe we can live with that? maybe we use a trigger incrementer like on the participants table? that would mean locking on a per conv basis, maybe ok for starters

--CREATE SEQUENCE vote_ids_for_4 START 1 OWNED BY conv.id;
CREATE SEQUENCE vote_ids START 1 OWNED BY conv.id;
CREATE TABLE votes(
    id INTEGER NOT NULL,
    conv_id INTEGER REFERENCES conversations(conv_id),
    ptpt_id INTEGER REFERENCES participants(ptpt_id),
    op_id INTEGER REFERENCES opinions(op_id),
    vote SMALLINT,
    created TIMESTAMP WITH TIME ZONE DEFAULT now()
    UNIQUE (op_id, ptpt_id)
    UNIQUE (id)
);
CREATE UNIQUE INDEX votes_idx(conv_id, id);

-- This is a light table that's used exclusively for generating IDs
CREATE TABLE users(
    -- TODO After testing failure cases with 10, use this:
    -- 2147483647  (2**32/2 -1)
    user_id INTEGER UNIQUE DEFAULT CEIL(RANDOM() * 10)
);
CREATE UNIQUE INDEX users_idx(id);

CREATE TABLE user_info(
    user_id INTEGER REFERENCES users(user_id),
    name VARCHAR
);

CREATE TABLE participants(
    ptpt_id INTEGER,
    conv_id INTEGER REFERENCES conversations(conv_id),
    user_id INTEGER REFERENCES users(user_id),
    UNIQUE (ptpt_id, conv_id),
    UNIQUE (conv_id, user_id) 
);
CREATE UNIQUE INDEX participants_conv_ptpt_idx(conv_id); -- speed up the auto-increment trigger

CREATE TABLE participant_info(
    conv_id INTEGER REFERENCES conversations(conv_id),
    user_id INTEGER REFERENCES users(user_id),
    created TIMESTAMP WITH TIME ZONE DEFAULT now()
);


CREATE TRIGGER ptpt_id_auto
    BEFORE INSERT ON participants
    FOR EACH ROW WHEN (NEW.id = 0)
    EXECUTE PROCEDURE ptpt_id_auto();

CREATE OR REPLACE FUNCTION ptpt_id_auto()
    RETURNS trigger AS $$
DECLARE
    _rel_id constant int := 873791983; -- This is a magic key used for locking conversation row-sets within the participants table. TODO keep track of these 
    _grp_id int;
BEGIN
    _grp_id = NEW.conv_id;

    -- Obtain an advisory lock on the participants table, limited to this conversation
    PERFORM pg_advisory_lock(_rel_id, _grp_id);

    SELECT  COALESCE(MAX(ptpt_id) + 1, 1)
    INTO    NEW.ptpt_id
    FROM    participants
    WHERE   conv_id = NEW.conv_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql STRICT;

CREATE OR REPLACE FUNCTION ptpt_id_auto_unlock()
    RETURNS trigger AS $$
DECLARE
    _rel_id constant int := 873791983;
    _grp_id int;
BEGIN
    _grp_id = NEW.conv_id;

    -- Release the lock.
    PERFORM pg_advisory_unlock(_rel_id, _grp_id);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql STRICT;

CREATE TRIGGER ptpt_id_auto_unlock
    AFTER INSERT ON participants
    FOR EACH ROW
    EXECUTE PROCEDURE ptpt_id_auto_unlock();

insert into users values (1000);
insert into users values (1001);
insert into users values (1002);

insert into conversations values (45342);
insert into conversation_info (conv_id, owner_id) values (45342, 1000);

insert into conversations values (983572);
insert into conversation_info (conv_id, owner_id) values (983572, 1000);
    
BEGIN;
    INSERT INTO participants (conv_id, user_id) VALUES ( 45342, 1001);
    INSERT INTO participant_info (conv_id, user_id) VALUES ( 45342, 1001);
COMMIT;

BEGIN;
    INSERT INTO participants (conv_id, user_id) VALUES ( 45342, 1002);
    INSERT INTO participant_info (conv_id, user_id) VALUES ( 45342, 1002);
COMMIT;

