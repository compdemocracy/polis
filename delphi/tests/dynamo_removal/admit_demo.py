from contextlib import closing
"""Read the complete public demo statement snapshot and admit actual Delphi jobs."""
import hashlib,json,os
from pathlib import Path
import psycopg2
from job_graph_client import GraphClient,numerical_spec
from delphi_graph_stages import model_digest
from delphi_narrative_snapshot import build_narrative_context

with psycopg2.connect(os.environ['DATABASE_URL']) as conn:
    conn.set_session(isolation_level='REPEATABLE READ', readonly=True)
    narrative_context=build_narrative_context(conn,1424,os.environ['MATH_ENV'])
    with conn.cursor() as cur:
        cur.execute('SELECT tid,txt FROM comments WHERE zid=%s ORDER BY tid',(1424,))
        rows=cur.fetchall()
        data={'texts':[text for _,text in rows]}
        cur.execute('SELECT public.pd_graph_hash(%s::jsonb)',(json.dumps(data),))
        sha=cur.fetchone()[0]
with closing(psycopg2.connect(os.environ['QUEUE_DATABASE_URL'])) as conn:
    plan=numerical_spec(data['texts'],[tid for tid,_ in rows],'rlocaldynamo1424',sha,
        model_digest(os.environ['DELPHI_EMBED_MODEL_PATH']),
        narrative_context=narrative_context)
    result=GraphClient(conn,'demo1424').admit(1424,'delphi','full-public-fixture-v1',plan)
    result['statements']=len(rows)
    Path('/proof/demo-admitted.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))
