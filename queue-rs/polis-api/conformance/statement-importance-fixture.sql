-- Aggregate fixture: integer participant numbers, no vote values or text.
CREATE TABLE zinvites(zid integer,zinvite text);
CREATE TABLE conversations(zid integer,strict_moderation boolean DEFAULT false);
CREATE TABLE comments(zid integer,tid integer,active boolean,mod integer,velocity real DEFAULT 1);
CREATE TABLE importance_fixture(zid integer,pid integer,tid integer,high_priority boolean,created bigint);
CREATE VIEW votes AS SELECT * FROM importance_fixture;
INSERT INTO zinvites VALUES (1,'fixture'),(2,'empty'),(3,'other'),(4,'strict');
INSERT INTO conversations VALUES (1,false),(2,false),(3,NULL),(4,true);
INSERT INTO comments VALUES (1,0,true,1),(1,2,true,1),(1,4,true,1),
 (1,5,true,0),(1,6,false,1),(1,7,true,-1),(1,9,true,1),
 (3,0,true,0),(4,0,true,0),(4,1,true,1);
-- Participant 1 unmarks importance; participant 2 marks twice but counts once.
INSERT INTO importance_fixture VALUES
 (1,1,0,true,10),(1,1,0,false,20),
 (1,2,0,true,10),(1,2,0,true,30),(1,3,0,false,10),
 -- A NULL creation time must not replace the known latest row.
 (1,1,2,false,10),(1,1,2,true,NULL),
 (1,1,5,true,10),(1,1,6,true,10),(1,1,7,true,10),
 -- Timestamp ties use high_priority DESC deterministically.
 (1,1,9,false,10),(1,1,9,true,10),
 (3,1,0,true,10),(4,1,0,true,10),(4,1,1,true,10);
INSERT INTO comments VALUES (1,8,true,1,0);
