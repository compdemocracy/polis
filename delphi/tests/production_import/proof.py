"""Real DynamoDB Local -> real daemon -> unpublished Postgres results; constructed only."""
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import psycopg2
sys.path.insert(0,'/app')
sys.path.insert(0,'/app/scripts')
from polismath.delphi_storage import codec, legacy_import as legacy, production_import as imp, import_report, scan_pacing
from polismath.delphi_storage.golden_corpus import corpus


def sql(query,args=()):
    with psycopg2.connect(os.environ['TEST_ADMIN_DATABASE_URL']) as c,c.cursor() as q:
        q.execute(query,args)
        return q.fetchall() if q.description else []


def cli(*args,ok=True):
    command=[sys.executable,'scripts/import_dynamo_production.py','--region','us-east-1',
             '--local-endpoint','http://127.0.0.1:8000','--max-read-units-per-second','200',*args]
    result=subprocess.run(command,capture_output=True,text=True)
    if ok and result.returncode:
        # Constructed test diagnosis only; production CLI never prints private logs.
        print(result.stderr)
        if Path('/import/worker.log').exists(): print(Path('/import/worker.log').read_text()[-10000:])
        raise AssertionError('import CLI failed')
    if not ok:
        assert result.returncode==2 and not result.stdout
        assert all(x not in result.stderr for x in ('9001','9002','generated','postgresql'))
        return
    value=json.loads(result.stdout)
    assert not any(k in result.stdout for k in ('r9001','r9002','postgresql://','graph_id','job_id'))
    return value


@contextmanager
def scan_only_endpoint():
    """Local permission emulation: forward only Scan to real DynamoDB Local."""
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            target = self.headers.get('X-Amz-Target', '')
            payload = self.rfile.read(int(self.headers['Content-Length']))
            calls.append((target, json.loads(payload)))
            if target != 'DynamoDB_20120810.Scan':
                status, body = 400, b'{"__type":"AccessDeniedException","message":"Scan only"}'
            else:
                request = Request('http://127.0.0.1:8000/', data=payload,
                    headers={k: v for k, v in self.headers.items()
                             if k.lower() not in {'host', 'content-length', 'connection'}})
                try:
                    with urlopen(request, timeout=30) as response:
                        status, body = response.status, response.read()
                except HTTPError as error:
                    status, body = error.code, error.read()
            self.send_response(status)
            self.send_header('Content-Type', 'application/x-amz-json-1.0')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def main():
    for zid in [9001,9002,9003]:
        sql("INSERT INTO users(uid,hname) VALUES(%s,'Generated importer proof')",(zid,))
        sql("INSERT INTO conversations(zid,owner,topic) VALUES(%s,%s,'Generated importer proof')",(zid,zid))
        sql("INSERT INTO reports(report_id,zid) VALUES(%s,%s)",(f'r{zid}generated',zid))
        sql("UPDATE conversations SET description=%s,participant_count=%s WHERE zid=%s", ('Generated description '+str(zid)+' '+'x'*140, zid-9000, zid))
        sql("INSERT INTO zinvites(zid,zinvite) VALUES(%s,%s)", (zid, 'generated-conversation-'+str(zid)))
    # More than one public alias is retained, with a deterministic primary ID.
    sql("INSERT INTO zinvites(zid,zinvite,created) VALUES(9001,'generated-alias',9999999999999)")
    source=legacy.local_client('http://127.0.0.1:8000')
    data=corpus()
    for family,rows in list(data.items()):
        # Full typed corpus for conversation 1, extra large conversation 2.
        key=codec.FAMILIES[family]['key']
        source.create_table(TableName=family,BillingMode='PAY_PER_REQUEST',
            AttributeDefinitions=[dict(AttributeName=n,AttributeType=t) for n,t in key],
            KeySchema=[dict(AttributeName=n,KeyType='HASH' if i==0 else 'RANGE') for i,(n,t) in enumerate(key)])
        source.get_waiter('table_exists').wait(TableName=family)
        for row in rows: source.put_item(TableName=family,Item=row)
    large=[]
    for i in range(105): # Forces pagination; each row stays below DynamoDB's item ceiling.
        row=codec.item_from_python(dict(conversation_id='9002',comment_id=i,text='generated '*600,
                                       precise=__import__('decimal').Decimal('0.12345678901234567890123456789012345678')))
        source.put_item(TableName='Delphi_CommentEmbeddings',Item=row);large.append(row)
    source.put_item(TableName='Delphi_NarrativeReports',Item=codec.item_from_python(dict(
        rid_section_model='r9002generated#section#model',timestamp='2026-01-01',report_id='r9002generated',text='generated narrative')))
    for cid,zid,text in [(500,'9002','bad\0row'),(501,'999999','unmapped row')]:
        source.put_item(TableName='Delphi_CommentEmbeddings',Item=codec.item_from_python(dict(conversation_id=zid,comment_id=cid,text=text)))
    # Quarantine-only conversation must appear even though it makes no bundle.
    source.put_item(TableName='Delphi_CommentEmbeddings',Item=codec.item_from_python(dict(conversation_id='9003',comment_id=502,text='bad\0row')))
    def fingerprint():
        import hashlib
        from psycopg2 import sql as query
        with psycopg2.connect(os.environ['TEST_ADMIN_DATABASE_URL']) as conn, conn.cursor() as cur:
            cur.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
            names=[row[0] for row in cur]
            result={}
            for name in names:
                cur.execute(query.SQL('SELECT row_to_json(t)::text FROM {} t ORDER BY row_to_json(t)::text').format(query.Identifier(name)))
                result[name]=hashlib.sha256(json.dumps(cur.fetchall()).encode()).hexdigest()
            return result
    before_report=fingerprint()
    os.environ['DATABASE_URL']=os.environ['IMPORT_SOURCE_DATABASE_URL']
    os.environ['DATABASE_SSL_MODE']='disable'
    with scan_only_endpoint() as (endpoint, calls):
        from botocore.exceptions import ClientError
        restricted = legacy.local_client(endpoint)
        try:
            restricted.describe_table(TableName='Delphi_CommentEmbeddings')
        except ClientError as error:
            assert error.response['Error']['Code'] == 'AccessDeniedException'
        else:
            raise AssertionError('DescribeTable unexpectedly allowed')
        assert len(calls) == 1 and calls[0][0] == 'DynamoDB_20120810.DescribeTable'
        calls.clear()
        # Local proof runs faster than the 2-unit/s production default; pacing
        # itself is unit-tested. Every request must still be metered.
        result=subprocess.run([sys.executable,'scripts/report_dynamo_import.py','--region','us-east-1',
            '--local-endpoint',endpoint,'--max-read-units-per-second','200'],capture_output=True,text=True)
        assert result.returncode == 0, result.stderr
        assert calls and all(target == 'DynamoDB_20120810.Scan' for target, _ in calls)
        assert all(args['ConsistentRead'] is False for _, args in calls)
        assert all(args['ReturnConsumedCapacity'] == 'TOTAL' and args['Limit'] == 25 for _, args in calls)
        assert '"unmetered_pages": 0' in result.stderr, result.stderr
        assert {args['TableName'] for _, args in calls} == set(codec.FAMILIES)
        assert sum('ExclusiveStartKey' in args for _, args in calls) >= 2
        print(f'PASS Scan-only report: DescribeTable denied; {len(calls)} eventually consistent, metered Scan requests across two passes; all 20 families and pagination; no other DynamoDB operations')
    assert result.returncode==0,result.stderr
    rows=[json.loads(line) for line in result.stdout.splitlines()]
    report_path=Path('/import/generated-report.jsonl');report_path.write_text(result.stdout)
    assert before_report==fingerprint(), 'dry report changed a PostgreSQL table'
    convs={row['zid']:row for row in rows if row['type']=='conversation'}
    assert set(convs)=={9001,9002,9003}
    for zid,row in convs.items():
        assert row['topic']=='Generated importer proof' and row['participant_count']==zid-9000
        assert row['conversation_id']=='generated-conversation-'+str(zid)
        assert row['description']==('Generated description '+str(zid)+' '+'x'*140)[:120]
        assert len(row['families'])==20
    assert convs[9001]['conversation_ids']==['generated-conversation-9001','generated-alias']
    assert convs[9003]['families']['Delphi_CommentEmbeddings']['quarantine']==1
    assert convs[9002]['families']['Delphi_CommentEmbeddings']['would_import']==105
    assert rows[-1]['totals']==dict(source=148,would_import=140,archive=5,quarantine=3)
    assert sum(row['families']['Delphi_CommentEmbeddings']['quarantine'] for row in rows[:-1])==3
    assert rows[-1]['conversations']==3 and rows[0]['type']=='unmapped'
    # The exact source digest before/after the report proves no Dynamo mutation.
    with closing(import_report.connect_existing()) as conn:
        conversations,reports=imp.mapping(conn)
    after_source=imp.census(source,Path('/import/after-report.sqlite'),conversations,reports,
        pacer=scan_pacing.ScanPacer(200))
    assert after_source['source_sha256']==rows[-1]['source_sha256']
    # Existing broad login is made read-only before the very first transaction.
    old=os.environ['DATABASE_URL'];os.environ['DATABASE_URL']=os.environ['TEST_ADMIN_DATABASE_URL']
    with closing(import_report.connect_existing()) as conn:
        with conn.cursor() as cur:
            cur.execute('SHOW default_transaction_read_only');assert cur.fetchone()==('on',)
            try:
                cur.execute('DELETE FROM conversations WHERE false')
            except psycopg2.errors.ReadOnlySqlTransaction:
                conn.rollback()
            else:raise AssertionError('read-only startup not enforced')
    os.environ['DATABASE_URL']=old
    assert before_report==fingerprint()
    print('PASS detailed report: 3 conversations including quarantine-only, aliases, 120-character descriptions, participant counts, 20 families, unmapped bucket, all PostgreSQL tables and Dynamo digest unchanged, broad login writes refused')
    print('GENERATED DRY-RUN REPORT BEGIN')
    print(result.stdout,end='')
    print('GENERATED DRY-RUN REPORT END')
    cli('--apply',ok=False)
    first=cli()
    assert first['mode']=='dry-run' and first['conversations']==2 and first['large_conversations']==1
    assert sql("SELECT count(*) FROM delphi_graphs")==[(0,)]
    assert sql("SELECT count(*) FROM delphi_result_rows")==[(0,)]
    print('PASS dry-run: all 20 tables, two conversations, paginated >450KB artifact, zero graph/result writes')
    applied=cli('--apply','--source-frozen','--environment','import-proof','--wait-seconds','180')
    assert applied['completed_graphs']==2 and applied['mode']=='applied-unpublished'
    assert sql("SELECT count(*) FROM delphi_graph_served")==[(0,)]
    assert sql("SELECT count(*) FROM delphi_artifacts")==[(2,)]
    assert sql("SELECT count(*) FROM delphi_result_batches WHERE artifact_id IS NOT NULL")==[(2,)]
    assert sql("SELECT count(DISTINCT run_id) FROM delphi_result_batches")==[(2,)]
    assert sql("SELECT DISTINCT scope_key FROM delphi_graphs")==[('delphi',)]
    wire=sql("SELECT f.codec_wire FROM delphi_result_families f JOIN delphi_result_batches b USING(env,batch_id) JOIN delphi_graph_nodes n USING(env,job_id) WHERE n.zid=9002 AND f.family='Delphi_CommentEmbeddings'")[0][0]
    assert wire.encode()==codec.encode_family('Delphi_CommentEmbeddings',large)
    assert len(wire.encode())>450000
    assert sql("SELECT count(*) FROM polis_queue_jobs WHERE state='succeeded' AND attempt_count=1")==[(2,)]
    assert sql("SELECT count(*) FROM votes")==[(0,)]
    print('PASS real fenced daemon: two runs, 36 staged families, byte-exact large artifact, zero publications/votes')
    before=sql('SELECT job_id,attempt_count FROM polis_queue_jobs ORDER BY job_id')
    again=cli('--apply','--source-frozen','--environment','import-proof','--wait-seconds','180')
    assert again==applied and sql('SELECT job_id,attempt_count FROM polis_queue_jobs ORDER BY job_id')==before
    print('PASS repeated import: identical source/output digests, no new job or attempt')
    c=applied['counts'];assert all(v['source']==v['imported']+v['archived']+v['quarantined'] for v in c.values())
    assert sum(v['quarantined'] for v in c.values())==3
    assert sum(v['archived'] for v in c.values())==5
    snapshots=list(Path('/import').glob('census-*/snapshot/inventory.json'))
    archive=json.loads(snapshots[-1].read_text())
    for filename,entry in archive['archives'].items():
        raw=(snapshots[-1].parent/filename).read_bytes()
        assert legacy.digest(raw)==entry['sha256'] and len(codec.decode_family(raw)[1])==entry['rows']
    print('PASS conservation: all rows imported, archived or quarantined; private archives rechecked exactly')
    assert sql('SELECT count(*) FROM delphi_jobs WHERE status<>\'succeeded\'')==[(0,)]
    print(json.dumps(applied,sort_keys=True))


if __name__=='__main__':main()
