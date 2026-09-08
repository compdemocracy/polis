-- Generated data only. Applied only to the dedicated, disposable p027 database.
INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES
 (1,'Generated Owner','owner@example.invalid',true,'p027-owner',1700000000000),
 (2,'Generated Admin','admin@example.invalid',true,'p027-admin',1700000000000),
 (3,'Generated Participant','participant@example.invalid',false,'p027-participant',1700000000000);
SELECT setval('users_uid_seq',3,true);
INSERT INTO conversations(zid,owner,topic,description,is_active,is_draft,is_public,profanity_filter,spam_filter,created,modified)
 VALUES(1,1,'Generated characterization conversation','Synthetic inputs only',true,false,true,false,false,1700000000000,1700000000000);
INSERT INTO conversations(zid,owner,topic,created,modified) VALUES(0,1,'Generated reserved-id sentinel',1700000000000,1700000000000);
SELECT setval('conversations_zid_seq',1,true);
INSERT INTO zinvites(zid,zinvite,created) VALUES(1,'2p027generated',1700000000000);
INSERT INTO participants(zid,uid,created) VALUES(1,1,1700000000000),(1,2,1700000000000),(1,3,1700000000000);
INSERT INTO participants_extended(zid,uid,subscribe_email) VALUES(1,3,'participant@example.invalid');
INSERT INTO comments(zid,pid,uid,txt,lang,created,modified) VALUES
 (1,0,1,'Generated statement A','en',1700000000000,1700000000000),
 (1,0,1,'Generated statement B','en',1700000000000,1700000000000);
INSERT INTO reports(zid,report_id,created,modified) VALUES(1,'r2p027generated',1700000000000,1700000000000);
