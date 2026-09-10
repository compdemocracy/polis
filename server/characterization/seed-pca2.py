#!/usr/bin/env python3
"""Generate independent public-fixture SQL inputs, then run the real engine + writer.

Only the sealed compose postgres service and database p027.
No stored math blob is fabricated or imported. The engine's wall clock is pinned
like the Node harness clock, and PCA cold-start uses the replay driver's ones seed.
"""
import hashlib
import json
import logging
import platform
import os
from pathlib import Path
import sys
from unittest.mock import patch

from isolation import isolated_environment

# Fail before importing the engine or opening a database connection.
isolated_environment(os.environ)

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'delphi'))
import numpy as np
import pandas
import scipy
import sklearn
import psycopg2
from psycopg2.extras import RealDictCursor
from polismath.conversation.conversation import Conversation
from polismath.database.postgres import PostgresClient, PostgresConfig
from polismath.poller.math_writer import MathWriter

HERE = Path(__file__).resolve().parent
CLOCK = 1700000000000

def main():
    logging.disable(logging.INFO)
    fixtures = json.loads((HERE / 'pca2-fixtures.json').read_text())
    db = psycopg2.connect(host='postgres', port=5432, dbname='p027', user='postgres')
    db.autocommit = True
    with db.cursor() as cur:
        cur.execute("INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES(4,'Generated foreign owner','foreign@example.invalid',true,'p027r4-foreign',%s)",(CLOCK,))
    evidence = []
    for f in fixtures:
        zid, nc, npart = f['zid'], f['comments'], f['participants']
        with db.cursor(cursor_factory=RealDictCursor) as cur:
            owner = 4 if f['shape'] == 'foreign' else 1
            cur.execute('INSERT INTO conversations(zid,owner,topic,is_active,is_draft,is_public,profanity_filter,spam_filter,created,modified) VALUES(%s,%s,%s,true,false,true,false,false,%s,%s)', (zid,owner,f'Generated PCA fixture {zid}',CLOCK+zid*1000,CLOCK+zid*1000))
            cur.execute('INSERT INTO zinvites(zid,zinvite,uuid,created) VALUES(%s,%s,%s,%s)', (zid,f['capability'],f'00000000-0000-4000-8000-{zid:012d}',CLOCK))
            # Stable actor pids 0,1,2; additional users are distinct per fixture.
            uids = [1,2,3]
            for i in range(3,npart):
                uid = zid*100+i
                cur.execute('INSERT INTO users(uid,hname,email,site_id,created) VALUES(%s,%s,%s,%s,%s)', (uid,f'Generated {uid}',f'f{uid}@example.invalid',f'p027r4-site-{uid}',CLOCK))
                uids.append(uid)
            for uid in uids:
                cur.execute('INSERT INTO participants(zid,uid,created) VALUES(%s,%s,%s)',(zid,uid,CLOCK))
            for tid in range(nc):
                cur.execute('INSERT INTO comments(zid,pid,uid,txt,lang,created,modified,mod) VALUES(%s,0,1,%s,\'en\',%s,%s,%s)',(zid,f'Generated fixture {zid} statement {tid}',CLOCK,CLOCK,0 if f['shape']=='zero-approved' else 1))
            rng=np.random.RandomState(f['seed'])
            for pid in range(npart):
                for tid in range(nc):
                    vote = int(rng.choice([-1,0,1], p=[.45,.1,.45]))
                    cur.execute('INSERT INTO votes(zid,pid,tid,vote,created) VALUES(%s,%s,%s,%s,%s)',(zid,pid,tid,vote,CLOCK))
            cur.execute('SELECT pid,tid,vote,created FROM votes WHERE zid=%s ORDER BY pid,tid',(zid,))
            raw=[dict(r) for r in cur.fetchall()]
            cur.execute('SELECT tid,mod,is_meta,modified FROM comments WHERE zid=%s ORDER BY tid',(zid,))
            mods=[dict(r) for r in cur.fetchall()]
        tick=None
        if f['rowMathEnv']:
            votes=[{**v,'vote':-v['vote']} for v in raw] # DB agree=-1; engine agree=+1.
            with patch('time.time', return_value=CLOCK/1000):
                conv=Conversation(zid,last_updated=CLOCK)
                conv.pca={'center':np.zeros(1),'comps':np.array([[1.0],[1.0]])}
                conv=conv.update_votes({'votes':votes,'lastVoteTimestamp':CLOCK},recompute=False)
                conv=conv.mod_update(mods).recompute()
                pg=PostgresClient(PostgresConfig(host='postgres',port=5432,database='p027',user='postgres',ssl_mode='disable',math_env=f['rowMathEnv']))
                pg.initialize()
                try:
                    writer=MathWriter(pg)
                    assert writer.write_conv_updates(zid,conv)==0
                    tick=writer.write_conv_updates(zid,conv)
                finally: pg.shutdown()
            assert tick==1
        with db.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute('SELECT math_env, math_tick, data FROM math_main WHERE zid=%s ORDER BY math_env',(zid,))
            rows=[dict(r) for r in cur.fetchall()]
        if rows:
            assert rows[0]['data']['n'] > 0 and rows[0]['data']['pca']['comps']
        evidence.append({**f,'owner':owner,'approvedCommentCount':sum(m['mod']==1 for m in mods),'voteCount':len(raw),'inputSha256':hashlib.sha256(json.dumps({'votes':raw,'mods':mods},sort_keys=True).encode()).hexdigest(),'rows':[{'mathEnv':r['math_env'],'mathTick':r['math_tick'],'n':r['data']['n'],'dataSha256':hashlib.sha256(json.dumps(r['data'],sort_keys=True).encode()).hexdigest()} for r in rows]})
    with db.cursor() as cur:
        cur.execute("SELECT setval('users_uid_seq',(SELECT max(uid) FROM users)),setval('conversations_zid_seq',(SELECT max(zid) FROM conversations))")
    db.close()
    sources=[p for p in (ROOT/'delphi/polismath').rglob('*.py')]
    h=hashlib.sha256()
    for p in sorted(sources):h.update(str(p.relative_to(ROOT)).encode());h.update(p.read_bytes())
    (HERE/'artifacts/pca2-seed.json').write_text(json.dumps({'engineSourceSha256':h.hexdigest(),'clock':CLOCK,'python':platform.python_version(),'numpy':np.__version__,'pandas':pandas.__version__,'scipy':scipy.__version__,'sklearn':sklearn.__version__,'fixtures':evidence},indent=2)+'\n')
    print(f'PCA2: {len(fixtures)} independent SQL fixtures; {sum(bool(f["rowMathEnv"]) for f in fixtures)} real engine/writer conversations (two publications each)')

if __name__=='__main__':main()
