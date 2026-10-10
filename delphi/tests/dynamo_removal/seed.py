"""Local public-fixture importer; explicit source convention, all votes via module."""
import argparse
import csv
import json
import os
from pathlib import Path
import psycopg2
from psycopg2.extras import execute_values, RealDictCursor
from polismath.utils.vote_convention import (
    semantic_vote, storage_vote, database_row_fetcher, RowConventionSource,
)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source-agree',required=True,type=int,choices=(-1,1))
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[2]/'real_data'
    data=next(root.glob('*-biodiversity'))
    comments=list(csv.DictReader(next(data.glob('*comments.csv')).open()))
    votes=list(csv.DictReader(next(data.glob('*votes.csv')).open()))
    pids=sorted({int(v['voter-id']) for v in votes}|{int(c['author-id']) for c in comments})
    zid=1424
    with psycopg2.connect(os.environ['DATABASE_URL']) as conn:
        def query(sql):
            with conn.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(sql);return cursor.fetchall()
        convention=RowConventionSource(database_row_fetcher(query)).current()
        with conn.cursor() as cur:
            cur.execute("INSERT INTO users(uid,hname,email) VALUES (%s,'Public fixture owner','fixture@example.invalid')",(zid,))
            cur.execute("INSERT INTO conversations(zid,owner,topic,description,is_active,topics_enabled) VALUES (%s,%s,'Biodiversity public fixture','Local queue and Postgres proof',true,true)",(zid,zid))
            cur.execute("INSERT INTO reports(rid,zid,report_id) VALUES (%s,%s,'rlocaldynamo1424')",(zid,zid))
            cur.execute("INSERT INTO zinvites(zid,zinvite) VALUES(%s,'local-dynamo-1424')",(zid,))
            # Each participant receives a unique test account.
            execute_values(cur,'INSERT INTO users(uid,hname,email) VALUES %s',[(100000+p,'Fixture participant',f'fixture{p}@example.invalid') for p in pids])
            execute_values(cur,'INSERT INTO participants(zid,pid,uid,created,mod) VALUES %s',[(zid,p,100000+p,1700000000000,0) for p in pids])
            execute_values(cur,'INSERT INTO comments(zid,tid,pid,uid,txt,mod,is_meta,created,modified,active) VALUES %s',[
                (zid,int(x['comment-id']),int(x['author-id']),100000+int(x['author-id']),x['comment-body'],int(x['moderated']),False,int(x['timestamp'])*1000,int(x['timestamp'])*1000,True) for x in comments])
            converted=[(zid,int(x['voter-id']),int(x['comment-id']),storage_vote(semantic_vote(int(x['vote']),args.source_agree),convention.agree_value),int(x['timestamp'])*1000) for x in votes]
            execute_values(cur,'INSERT INTO votes(zid,pid,tid,vote,created) VALUES %s',converted,page_size=1)
            cur.execute('UPDATE participants p SET vote_count=v.n FROM (SELECT pid,count(*) n FROM votes WHERE zid=%s GROUP BY pid) v WHERE p.zid=%s AND p.pid=v.pid',(zid,zid))
            cur.execute('UPDATE conversations SET participant_count=%s WHERE zid=%s',(len(pids),zid))
            cur.execute('SELECT tid,vote,count(*) FROM votes WHERE zid=%s GROUP BY tid,vote',(zid,))
            actual={(tid,semantic_vote(v,convention.agree_value)):n for tid,v,n in cur.fetchall()}
            expected={}
            for x in votes:
                k=(int(x['comment-id']),semantic_vote(int(x['vote']),args.source_agree));expected[k]=expected.get(k,0)+1
            assert actual==expected,'vote polarity/count self-check failed'
    print(json.dumps(dict(comments=len(comments),participants=len(pids),votes=len(votes),vote_count_groups_checked=len(expected),source_agree=args.source_agree,storage_agree=convention.agree_value)))

if __name__=='__main__':main()
