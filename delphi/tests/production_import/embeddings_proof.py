"""Flag-on comment-embeddings import: DynamoDB Local -> daemon -> delphi_comment_embeddings.

Constructed source only; no AWS, no production data. A clean DynamoDB and a fresh
import environment, so the only embeddings are the mappable ones this proof builds
(the shared proof.py corpus deliberately carries an unmappable test model, which
the flag-on importer must refuse, so this proof owns its own source state).

Set IMPORT_PROOF_EMBEDDINGS_COMMENTS to size the conversation. The default keeps
hosted CI fast and under the old 64 MiB codec-family cap; on a work box a value
large enough to exceed that cap (about 6,000 384-dim comments) additionally proves
the two oversized production conversations now import, flag off refusing them."""
from contextlib import closing
import json
import os
from pathlib import Path
import random
import struct
import subprocess
import sys

import psycopg2
sys.path.insert(0, '/app')
sys.path.insert(0, '/app/scripts')
from polismath.delphi_storage import codec, legacy_import as legacy, production_import as imp

ENV = 'import-emb-proof'
ZID = 9102
MODEL = 'all-MiniLM-L6-v2'          # the legacy bare name; normalizes to the seeded model
DIMS = 384
COMMENTS = int(os.environ.get('IMPORT_PROOF_EMBEDDINGS_COMMENTS', '240'))


def sql(query, args=()):
    with psycopg2.connect(os.environ['TEST_ADMIN_DATABASE_URL']) as c, c.cursor() as q:
        q.execute(query, args)
        return q.fetchall() if q.description else []


def f32(value):
    """A float32-exact Python float, as the legacy MiniLM path printed and stored."""
    return struct.unpack('<f', struct.pack('<f', value))[0]


def cli(script, *args, flag=False, ok=True):
    env = dict(os.environ)
    if flag:
        env['DELPHI_EMBEDDINGS_TABLE'] = '1'
    else:
        env.pop('DELPHI_EMBEDDINGS_TABLE', None)
    command = [sys.executable, 'scripts/' + script, '--region', 'us-east-1',
               '--local-endpoint', 'http://127.0.0.1:8000', '--max-read-units-per-second', '100000', *args]
    result = subprocess.run(command, capture_output=True, text=True, env=env)
    if ok and result.returncode:
        print(result.stderr)
        if Path('/import/worker.log').exists():
            print(Path('/import/worker.log').read_text()[-10000:])
        raise AssertionError(script + ' failed')
    if not ok:
        assert result.returncode == 2, (result.returncode, result.stderr)
        return result.stderr
    return json.loads(result.stdout) if result.stdout.strip() else None


def reset_dynamo(source):
    for name in source.list_tables().get('TableNames', []):
        source.delete_table(TableName=name)
        source.get_waiter('table_not_exists').wait(TableName=name)
    for family, definition in codec.FAMILIES.items():
        key = definition['key']
        source.create_table(TableName=family, BillingMode='PAY_PER_REQUEST',
            AttributeDefinitions=[dict(AttributeName=n, AttributeType=t) for n, t in key],
            KeySchema=[dict(AttributeName=n, KeyType='HASH' if i == 0 else 'RANGE') for i, (n, t) in enumerate(key)])
        source.get_waiter('table_exists').wait(TableName=family)


def build_embeddings(source, tids):
    from decimal import Decimal
    rng = random.Random(20261013)
    items = []
    for tid in tids:
        vector = [Decimal(repr(f32(rng.uniform(-1.0, 1.0)))) for _ in range(DIMS)]
        items.append(codec.item_from_python(dict(conversation_id=str(ZID), comment_id=tid,
            embedding=dict(vector=vector, dimensions=DIMS, model=MODEL))))
    for start in range(0, len(items), 25):
        batch = items[start:start + 25]
        source.batch_write_item(RequestItems={'Delphi_CommentEmbeddings': [{'PutRequest': {'Item': i}} for i in batch]})
    return items


def main():
    # A fresh conversation with real comments; the trigger assigns tids 0..N-1.
    sql("INSERT INTO users(uid,hname) VALUES(%s,'Generated embeddings proof') ON CONFLICT DO NOTHING", (ZID,))
    sql("INSERT INTO conversations(zid,owner,topic) VALUES(%s,%s,'Generated embeddings proof') ON CONFLICT DO NOTHING", (ZID, ZID))
    sql("INSERT INTO participants(zid,uid) VALUES(%s,%s) ON CONFLICT DO NOTHING", (ZID, ZID))
    (pid,) = sql("SELECT pid FROM participants WHERE zid=%s AND uid=%s", (ZID, ZID))[0]
    sql("INSERT INTO comments(zid,pid,uid,txt) SELECT %s,%s,%s,'generated comment '||g FROM generate_series(0,%s) g",
        (ZID, pid, ZID, COMMENTS - 1))
    tids = [t for (t,) in sql("SELECT tid FROM comments WHERE zid=%s ORDER BY tid", (ZID,))]
    assert len(tids) == COMMENTS, (len(tids), COMMENTS)

    source = legacy.local_client('http://127.0.0.1:8000')
    reset_dynamo(source)
    items = build_embeddings(source, tids)
    family_bytes = len(codec.encode_family('Delphi_CommentEmbeddings', items))
    oversized = family_bytes > imp.FAMILY_LIMIT
    print('PASS fixture: %d comments, %d-dim embeddings, codec family %d bytes (oversized=%s, cap=%d)'
          % (COMMENTS, DIMS, family_bytes, oversized, imp.FAMILY_LIMIT))

    os.environ['DATABASE_URL'] = os.environ['IMPORT_SOURCE_DATABASE_URL']
    os.environ['DATABASE_SSL_MODE'] = 'disable'

    # Dry-run report, flag on: per-model counts, and the family stages empty.
    report_out = subprocess.run([sys.executable, 'scripts/report_dynamo_import.py', '--region', 'us-east-1',
        '--local-endpoint', 'http://127.0.0.1:8000', '--max-read-units-per-second', '100000'],
        capture_output=True, text=True, env=dict(os.environ, DELPHI_EMBEDDINGS_TABLE='1'))
    assert report_out.returncode == 0, report_out.stderr
    rows = [json.loads(line) for line in report_out.stdout.splitlines()]
    grand = rows[-1]
    assert grand['embedding_models'] == {MODEL: COMMENTS}, grand['embedding_models']
    conv = next(r for r in rows if r.get('zid') == ZID)
    assert conv['staging']['oversized_families'] == {}, conv['staging']
    print('PASS dry-run report (flag on): embedding_models=%s; family stages empty' % grand['embedding_models'])

    # Flag off: the dry-run report shows the embeddings family over the 64 MiB cap,
    # and apply refuses before storing anything (today's blocker for the two
    # oversized production conversations). import_dynamo_production redacts the
    # refusal to the exception class, so the reason is pinned via the report above.
    if oversized:
        report_off = subprocess.run([sys.executable, 'scripts/report_dynamo_import.py', '--region', 'us-east-1',
            '--local-endpoint', 'http://127.0.0.1:8000', '--max-read-units-per-second', '100000'],
            capture_output=True, text=True, env={k: v for k, v in os.environ.items() if k != 'DELPHI_EMBEDDINGS_TABLE'})
        assert report_off.returncode == 0, report_off.stderr
        conv_off = next(r for r in (json.loads(l) for l in report_off.stdout.splitlines()) if r.get('zid') == ZID)
        assert 'Delphi_CommentEmbeddings' in conv_off['staging']['oversized_families'], conv_off['staging']
        assert conv_off['staging']['oversized_families']['Delphi_CommentEmbeddings'] > imp.FAMILY_LIMIT
        cli('import_dynamo_production.py', '--apply', '--source-frozen',
            '--environment', ENV, '--wait-seconds', '600', flag=False, ok=False)
        assert sql("SELECT count(*) FROM delphi_comment_embeddings WHERE env=%s", (ENV,)) == [(0,)]
        print('PASS flag off: dry-run shows the embeddings family over the 64 MiB cap (%d bytes); apply refuses, nothing stored'
              % conv_off['staging']['oversized_families']['Delphi_CommentEmbeddings'])

    # Flag on: the same conversation imports into the per-row table.
    applied = cli('import_dynamo_production.py', '--apply', '--source-frozen',
                  '--environment', ENV, '--wait-seconds', '600', flag=True)
    assert applied['mode'] == 'applied-unpublished' and applied['completed_graphs'] == 1, applied
    assert applied['embedding_models'] == {MODEL: COMMENTS}, applied
    assert applied['embeddings'] == dict(rows=COMMENTS, models={imp.SEEDED_EMBEDDING_MODEL: COMMENTS}), applied['embeddings']

    stored = sql("SELECT count(*) FROM delphi_comment_embeddings WHERE env=%s AND zid=%s AND model_id=1", (ENV, ZID))
    assert stored == [(COMMENTS,)], stored
    sets = sql("SELECT row_count FROM delphi_embedding_sets WHERE env=%s AND zid=%s AND model_id=1", (ENV, ZID))
    assert sets == [(COMMENTS,)], sets
    # Nothing was published; the codec family carries no embeddings.
    assert sql("SELECT count(*) FROM delphi_graph_served WHERE env=%s", (ENV,)) == [(0,)]
    wire = sql("""SELECT f.codec_wire FROM delphi_result_families f
                  JOIN delphi_result_batches b USING(env,batch_id)
                  JOIN delphi_graph_nodes n USING(env,job_id)
                  WHERE n.env=%s AND n.zid=%s AND f.family='Delphi_CommentEmbeddings'""", (ENV, ZID))[0][0]
    assert codec.decode_family(wire.encode('utf-8'))[1] == [], 'codec family must be empty under the flag'

    # The stored real[] is the float32 the fixture built. (Bit-exactness across the
    # whole set is already proven: the importer verified pd_embedding_set's digest,
    # which hashes the stored array_send bytes, against the spool's content_sha.)
    # Here psycopg2 reads float4 over the text protocol, which round-trips through
    # float32 but not bit-for-bit as float64, so compare the float32 narrowings.
    by_tid = {tid: codec.to_python(i['embedding']['M']['vector']['L'][0]) for tid, i in zip(tids, items)}
    sample = tids[0]
    (stored_vec,) = sql("SELECT embedding FROM delphi_comment_embeddings WHERE env=%s AND zid=%s AND tid=%s", (ENV, ZID, sample))[0]
    assert f32(stored_vec[0]) == f32(float(by_tid[sample])), (f32(stored_vec[0]), f32(float(by_tid[sample])))
    print('PASS flag on: %d embeddings in delphi_comment_embeddings, one set row_count=%d, codec family empty, '
          'float32 round-trip exact (set digest verified), set receipt verified by the importer' % (COMMENTS, COMMENTS))

    # Repeat is idempotent: same receipt, no new rows.
    again = cli('import_dynamo_production.py', '--apply', '--source-frozen',
                '--environment', ENV, '--wait-seconds', '600', flag=True)
    assert again == applied, (again, applied)
    assert sql("SELECT count(*) FROM delphi_comment_embeddings WHERE env=%s", (ENV,)) == [(COMMENTS,)]
    assert sql("SELECT count(*) FROM votes") == [(0,)]
    print('PASS repeat import: identical result, no new embedding rows, zero votes written')
    print(json.dumps(dict(comments=COMMENTS, dims=DIMS, family_bytes=family_bytes, oversized=oversized,
                          stored=COMMENTS), sort_keys=True))


if __name__ == '__main__':
    main()
