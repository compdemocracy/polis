"""Generated local fixture only. Never imported by an image."""
import time

def fixture(now=None):
 now=int(time.time()*1000) if now is None else now
 old=1577836800000
 conversations=list(range(1,11))
 participants=[(z,p) for z in conversations for p in (0,1)]
 comments=[(z,t,0) for z in conversations for t in (0,1)]
 # zid,pid,tid,value,created. Tied values, repeated values, NULLs, bad values,
 # missing timestamps, absent parents and cross-conversation identities.
 votes=[(1,0,0,-1,old),(1,0,0,1,old+1),(1,0,1,-1,old),
 (2,0,0,1,old),(2,0,1,1,old),(2,0,1,1,old+1),
 (3,0,0,-1,old),(3,0,1,1,old),
 (5,0,0,-1,old),(5,0,0,1,old),(5,0,1,-1,old),(5,0,1,-1,old),
 (6,0,0,None,old),(6,0,0,-1,old+1),(6,0,1,-1,old),(6,0,1,None,old+1),
 (7,0,0,-1,None),(7,0,0,1,old),(7,0,1,0,old),
 (8,0,0,2,old),(8,0,1,-1,old),(8,0,1,2,old+1),
 (9,1,0,None,now-1000),(9,1,1,None,now-2*86400000),
 (9,0,0,None,now-60*86400000),(9,0,1,None,now+86400000),
 (10,0,0,-1,0),(10,0,1,1,4133980800000),
 (10,1,0,-1,-1),(10,1,1,None,None),
 (1,1,88,-1,old),(1,99,0,1,old),(99,0,0,None,old)]
 latest={}
 for z,p,t,v,stamp in votes:latest[z,p,t]=(v,stamp)
 latest[1,0,0]=(-1,old+1)  # wrong value at correct newest time
 latest[2,0,1]=(1,old)  # correct value but old time
 del latest[3,0,0]
 latest[3,1,1]=(0,old)  # cache-only key
 # Kebab-only object, dual keys, malformed object, custom label not exportable.
 math=[(1,'prod',{'group-clusters':[]},old,old),
 (1,'python',{'group-clusters':[],'group_clusters':[]},now,now),
 (2,'prod',{},now-2*86400000,old),
 (3,'private label must not leave',[],None,None)]
 return dict(now=now,conversations=conversations,participants=participants,comments=comments,
 comment_metadata=[(z,t,z==2,('imported' if z in (3,5,6) else None),
  None if z==7 else -1 if z==8 else 4133980800000 if z==10 else old+(z%2)*366*86400000) for z,t,p in comments],
 votes=votes,latest=[(*k,*v) for k,v in latest.items()],math=math)

def seed(conn,data):
 import json
 with conn:
  with conn.cursor() as c:
   c.execute("""CREATE ROLE polis_probe_reader LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 CREATE TABLE conversations(zid integer PRIMARY KEY);
 CREATE TABLE participants(zid integer,pid integer,UNIQUE(zid,pid));
 CREATE TABLE comments(zid integer,tid integer,pid integer,is_seed boolean DEFAULT false,original_id text,created bigint,UNIQUE(zid,tid));
 CREATE TABLE votes(zid integer,pid integer,tid integer,vote smallint,created bigint);
 CREATE TABLE votes_latest_unique(zid integer,pid integer,tid integer,vote smallint,modified bigint,UNIQUE(zid,pid,tid));
 CREATE TABLE math_main(zid integer,math_env text,data json,modified bigint,last_vote_timestamp bigint,UNIQUE(zid,math_env));
 GRANT SELECT ON ALL TABLES IN SCHEMA public TO polis_probe_reader;
 ALTER ROLE polis_probe_reader SET default_transaction_read_only=on;""")
   c.executemany('INSERT INTO conversations VALUES(%s)',[(z,) for z in data['conversations']])
   for table in ('participants','comments','votes','votes_latest_unique'):
    key='latest' if table=='votes_latest_unique' else table
    rows=data[key];c.executemany('INSERT INTO '+table+(' (zid,tid,pid)' if table=='comments' else '')+' VALUES('+','.join(['%s']*len(rows[0]))+')',rows)
   c.executemany('UPDATE comments SET is_seed=%s,original_id=%s,created=%s WHERE zid=%s AND tid=%s',[(seed,orig,stamp,z,t) for z,t,seed,orig,stamp in data['comment_metadata']])
   c.executemany('INSERT INTO math_main VALUES(%s,%s,%s,%s,%s)',[(z,e,json.dumps(d),m,t) for z,e,d,m,t in data['math']])
