"""Generated boundary tests; no cloud, provider or raw votes."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
from decimal import Decimal
from types import SimpleNamespace
import pytest
from polismath.delphi_storage import production_import as imp
from polismath.delphi_storage import legacy_import as legacy
from polismath.delphi_storage import codec
from polismath.delphi_storage import scan_pacing
from polismath.delphi_storage.embedding_spool import read_spool


@pytest.fixture(autouse=True)
def no_pacing_sleep(monkeypatch):
    # Pacing arithmetic is covered in test_scan_pacing.py; never wait here.
    monkeypatch.setattr(scan_pacing, '_sleep', lambda seconds: None)

FAMILY = 'Delphi_CommentEmbeddings'

class Source:
    class Missing(Exception):
        pass
    exceptions = SimpleNamespace(ResourceNotFoundException=Missing)
    def __init__(self, rows=None, missing=(), duplicate=False):
        self.rows = rows or {}
        self.missing = missing
        self.duplicate = duplicate
        self.calls = []
    def describe_table(self, TableName):
        if TableName in self.missing:
            raise self.Missing()
        key = codec.FAMILIES[TableName]['key']
        return {'Table': dict(KeySchema=[dict(AttributeName=n,KeyType='HASH' if i==0 else 'RANGE') for i,(n,t) in enumerate(key)],
                              AttributeDefinitions=[dict(AttributeName=n,AttributeType=t) for n,t in key])}
    def scan(self, **args):
        self.calls.append(args)
        rows = self.rows.get(args['TableName'], [])
        index = int(args.get('ExclusiveStartKey', {}).get('offset', {'N':'0'})['N'])
        result = dict(Items=rows[index:index+1])
        if index+1 < len(rows):
            result['LastEvaluatedKey'] = {'offset': {'N':str(index+1)}}
        return result


def row(zid='1', cid=1, text='generated'):
    return codec.item_from_python(dict(conversation_id=zid, comment_id=cid, text=text))


def test_all_families_pages_partition_conservation(tmp_path):
    source = Source({FAMILY:[row(), row('2'), row('999'), row(cid=2,text='bad\0row')],
                     'Delphi_JobQueue':[{'job_id':{'S':'generated'}}]})
    summary = imp.census(source,tmp_path/'rows.db',{'1':1,'2':2},{})
    assert summary['counts'][FAMILY] == dict(source=4, imported=2, archived=0, quarantined=2)
    assert summary['counts']['Delphi_JobQueue']['archived'] == 1
    assert len(summary['inventory']) == 20
    assert all(c['source']==c['imported']+c['archived']+c['quarantined'] for c in summary['counts'].values())
    assert all(c['ConsistentRead'] is False for c in source.calls)
    assert all(c['ReturnConsumedCapacity'] == 'TOTAL' and c['Limit'] == 25 for c in source.calls)
    bundles = imp.materialize(tmp_path/'rows.db',tmp_path/'out',summary)
    assert {b['zid'] for b in bundles} == {1,2}
    archived = (tmp_path/'out'/'archived-Delphi_JobQueue.jsonl').read_bytes()
    assert codec.decode_family(archived)[1] == source.rows['Delphi_JobQueue']
    assert len(codec.decode_family((tmp_path/'out'/('quarantined-'+FAMILY+'.jsonl')).read_bytes())[1]) == 2


@pytest.mark.parametrize('item,expected', [
    ({'zid':{'S':'1'}},1), ({'zid_tick':{'S':'1:3'}},1),
    ({'zid_tick_gid':{'S':'1:3:2'}},1), ({'zid_topic_jobid':{'S':'1#t#j'}},1),
    ({'rid_section_model':{'S':'r#s#m'}},2), ({'report_id':{'S':'r'}},2),
    ({'zid':{'S':'1'},'report_id':{'S':'r'}},None),
    ({'zid':{'S':'01'}},None), ({'report_id':{'S':'unknown'}},None), ({},None),
    ({'zid':{'N':'1'}},1), ({'zid':{'S':'1'},'conversation_id':{'S':'2'}},None),
])
def test_binding(item,expected):
    assert imp.bind(item,{'1':1,'2':2},{'r':2}) == expected


def test_duplicate_key_refuses(tmp_path):
    with pytest.raises(ValueError, match='duplicate'):
        imp.census(Source({FAMILY:[row(),row()]}),tmp_path/'rows.db',{'1':1},{})


def test_missing_requires_explicit_inventory(tmp_path):
    with pytest.raises(ValueError,match='missing'):
        imp.census(Source(missing=[FAMILY]),tmp_path/'a',{'1':1},{})
    summary=imp.census(Source(missing=[FAMILY]),tmp_path/'b',{'1':1},{},[FAMILY])
    assert summary['missing']==[FAMILY]


def test_large_detached_bytes_provenance_and_corruption(tmp_path,monkeypatch):
    rows=[row(cid=i,text='x'*250_000) for i in range(3)]
    summary=imp.census(Source({FAMILY:rows}),tmp_path/'db',{'1':1},{})
    bundles=imp.materialize(tmp_path/'db',tmp_path/'snapshots',summary)
    assert bundles[0]['bytes']>750_000
    monkeypatch.setattr(imp,'SNAPSHOTS',tmp_path/'snapshots')
    spec=imp.specification(bundles[0],[])
    assert len(legacy.json_bytes(spec))<10_000
    out=tmp_path/'out';out.mkdir();monkeypatch.setenv('DELPHI_OUTPUT_MANIFEST',str(out/'manifest.json'))
    frame=dict(zid=1,input=dict(declared=spec['nodes'][0]['declared']))
    result=imp.execute(frame)
    assert len(result['family_spool'])==18
    assert codec.decode_family((out/(FAMILY+'.jsonl')).read_bytes())[1]==rows
    (tmp_path/'snapshots'/bundles[0]['digest']/(FAMILY+'.jsonl')).write_text('corruption')
    out2=tmp_path/'out2';out2.mkdir();monkeypatch.setenv('DELPHI_OUTPUT_MANIFEST',str(out2/'manifest.json'))
    with pytest.raises(ValueError,match='bytes'):
        imp.execute(frame)


def test_bound_refuses_without_truncation(tmp_path,monkeypatch):
    summary=imp.census(Source({FAMILY:[row(text='x'*1000)]}),tmp_path/'db',{'1':1},{})
    monkeypatch.setattr(imp,'FAMILY_LIMIT',100)
    with pytest.raises(ValueError,match='bound'):
        imp.materialize(tmp_path/'db',tmp_path/'snapshot',summary)


@pytest.mark.parametrize('bad',['../escape','f'*63,'F'*64,'file:///tmp/x'])
def test_snapshot_path_refusal(bad):
    with pytest.raises(ValueError): imp.read_bundle(bad)


def test_order_and_numeric_binary_set_fidelity(tmp_path):
    value=row()
    value.update(decimal={'N':'0.12345678901234567890123456789012345678'}, binary={'B':b'\x00\xff'}, set={'NS':['2.00','1']})
    rows=[row(cid=2),value]
    a=imp.census(Source({FAMILY:rows}),tmp_path/'a',{'1':1},{})
    b=imp.census(Source({FAMILY:rows[::-1]}),tmp_path/'b',{'1':1},{})
    assert a==b
    bundles=imp.materialize(tmp_path/'a',tmp_path/'snapshot',a)
    raw=(tmp_path/'snapshot'/bundles[0]['digest']/(FAMILY+'.jsonl')).read_bytes()
    assert raw==codec.encode_family(FAMILY,rows)


def test_snapshot_symlink_refuses(tmp_path,monkeypatch):
    monkeypatch.setattr(imp,'SNAPSHOTS',tmp_path/'snapshots')
    imp.SNAPSHOTS.mkdir()
    (imp.SNAPSHOTS/('a'*64)).symlink_to(tmp_path,target_is_directory=True)
    with pytest.raises(ValueError,match='symlink'):imp.read_bundle('a'*64)


def test_source_schema_refuses(tmp_path):
    source=Source()
    source.describe_table=lambda **kw: {'Table':dict(KeySchema=[dict(AttributeName='wrong',KeyType='HASH')],AttributeDefinitions=[dict(AttributeName='wrong',AttributeType='S')])}
    with pytest.raises(ValueError,match='schema'):imp.census(source,tmp_path/'db',{'1':1},{})


def test_changed_source_digest(tmp_path):
    a=imp.census(Source({FAMILY:[row()]}),tmp_path/'a',{'1':1},{})
    b=imp.census(Source({FAMILY:[row(text='changed')]}),tmp_path/'b',{'1':1},{})
    assert a!=b and a['source_sha256']!=b['source_sha256']


def test_no_static_aws_credentials(monkeypatch):
    import sys
    session=SimpleNamespace(get_credentials=lambda:SimpleNamespace(method='env'))
    monkeypatch.setitem(sys.modules,'boto3',SimpleNamespace(Session=lambda **kw:session))
    with pytest.raises(ValueError,match='instance role'):imp.source_client('us-east-1')


def test_iam_role_client(monkeypatch):
    import sys
    marker=object()
    session=SimpleNamespace(get_credentials=lambda:SimpleNamespace(method='iam-role'),client=lambda *a,**k:marker)
    monkeypatch.setitem(sys.modules,'boto3',SimpleNamespace(Session=lambda **kw:session))
    assert imp.source_client('us-east-1') is marker


def test_no_remote_local_endpoint():
    with pytest.raises(ValueError):imp.source_client('us-east-1','https://dynamodb.us-east-1.amazonaws.com')


def test_production_database_tls_required(monkeypatch):
    monkeypatch.setenv('IMPORT_SOURCE_DATABASE_URL','host=example.invalid sslmode=require')
    with pytest.raises(ValueError,match='TLS'):imp.connect_readonly_source()


def test_dry_run_staging_reports_every_oversized_family_and_continues(tmp_path, monkeypatch):
    """A family past the bound refuses on the apply path, and is staged in full and listed on the dry-run path."""
    other = 'Delphi_CommentExtremity'
    rows = {FAMILY: [row(cid=i, text='x'*400) for i in range(3)] + [row('2', text='small')],
            other: [codec.item_from_python(dict(conversation_id='1', comment_id='1', text='y'*400))]}
    summary = imp.census(Source(rows), tmp_path/'db', {'1': 1, '2': 2}, {})
    # Eighteen empty family headers alone are about 2 KB; one small conversation fits under 3 KB.
    monkeypatch.setattr(imp, 'FAMILY_LIMIT', 1000)
    monkeypatch.setattr(imp, 'BATCH_LIMIT', 3000)
    with pytest.raises(ValueError, match='conversation family exceeds staged storage bound'):
        imp.materialize(tmp_path/'db', tmp_path/'refused', summary)
    oversized = []
    bundles = imp.materialize(tmp_path/'db', tmp_path/'staged', summary, oversized=oversized)
    assert [b['zid'] for b in bundles] == [1, 2]
    staged = tmp_path/'staged'/bundles[0]['digest']
    # The oversized family is staged in full, not truncated, and its size is exact.
    raw = (staged/(FAMILY+'.jsonl')).read_bytes()
    assert codec.decode_family(raw)[1] == rows[FAMILY][:3]
    assert oversized == [dict(zid=1, family=FAMILY, bytes=len(raw), rows=3),
                         dict(zid=1, family=None, bytes=bundles[0]['bytes'], rows=4)]
    assert bundles[0]['bytes'] > 3000 and bundles[1]['bytes'] < 3000
    totals = imp.oversize_summary(oversized)
    assert totals == dict(conversations=1, family_limit=1000, batch_limit=3000, families={
        FAMILY: dict(conversations=1, bytes_max=len(raw), bytes_total=len(raw)),
        'batch': dict(conversations=1, bytes_max=bundles[0]['bytes'], bytes_total=bundles[0]['bytes'])})
    state = imp.staging(bundles, oversized)
    assert state['conversations'][1] == dict(bytes=bundles[0]['bytes'], within_bound=False,
                                             oversized_families={FAMILY: len(raw)}, batch_over_bound=True)
    assert state['conversations'][2] == dict(bytes=bundles[1]['bytes'], within_bound=True,
                                             oversized_families={}, batch_over_bound=False)
    assert imp.oversize_summary([]) == dict(conversations=0, families={}, family_limit=1000, batch_limit=3000)


def test_batch_bound_alone_refuses_on_apply_and_is_reported_on_dry_run(tmp_path, monkeypatch):
    other = 'Delphi_CommentExtremity'
    rows = {FAMILY: [row(text='x'*600)],
            other: [codec.item_from_python(dict(conversation_id='1', comment_id='1', text='y'*600))]}
    summary = imp.census(Source(rows), tmp_path/'db', {'1': 1}, {})
    # Every family stays under the family bound; only the conversation's sum crosses the batch bound.
    monkeypatch.setattr(imp, 'BATCH_LIMIT', 3000)
    with pytest.raises(ValueError, match='conversation exceeds staged batch bound'):
        imp.materialize(tmp_path/'db', tmp_path/'refused', summary)
    oversized = []
    bundles = imp.materialize(tmp_path/'db', tmp_path/'staged', summary, oversized=oversized)
    assert oversized == [dict(zid=1, family=None, bytes=bundles[0]['bytes'], rows=2)]
    assert 3000 < bundles[0]['bytes'] and all(entry['bytes'] < imp.FAMILY_LIMIT
                                               for entry in json.loads((tmp_path/'staged'/bundles[0]['digest']/'manifest.json').read_text())['families'].values())


# ---------------------------------------------------------------- embeddings table (flag on)

def embedding_item(zid, tid, vector, model='all-MiniLM-L6-v2'):
    """A Delphi_CommentEmbeddings source item in the real shape the writers store."""
    return codec.item_from_python(dict(
        conversation_id=str(zid), comment_id=tid,
        embedding=dict(vector=[Decimal(str(v)) for v in vector], dimensions=len(vector), model=model)))


def text_sha(text):
    return hashlib.sha256(text.encode('utf-8')).digest()


def _manifest(root, bundle):
    return json.loads((root / bundle['digest'] / 'manifest.json').read_text())


def test_embeddings_table_spools_and_empties_the_family(tmp_path, monkeypatch):
    vectors = {1: [0.5, -1.0, 2.25], 2: [0.0, 1.5, -3.5]}
    rows = [embedding_item(1, tid, vec) for tid, vec in vectors.items()]
    summary = imp.census(Source({FAMILY: rows}), tmp_path/'db', {'1': 1}, {})
    shas = {(1, tid): text_sha('generated %d' % tid) for tid in vectors}
    report = {}
    monkeypatch.setattr(imp, 'SNAPSHOTS', tmp_path/'snapshots')
    bundles = imp.materialize(tmp_path/'db', tmp_path/'snapshots', summary,
                              embeddings_table=True, text_shas=shas, embedding_report=report)
    manifest = _manifest(tmp_path/'snapshots', bundles[0])
    # The codec family is empty (header only); the rows went to the spool.
    assert manifest['embeddings_table'] is True
    assert manifest['families'][FAMILY]['rows'] == 0
    assert (tmp_path/'snapshots'/bundles[0]['digest']/(FAMILY+'.jsonl')).read_bytes() == (codec.header(FAMILY)+'\n').encode()
    descriptor = manifest['embeddings']
    assert descriptor['model'] == imp.SEEDED_EMBEDDING_MODEL and descriptor['dims'] == 3 and descriptor['rows'] == 2
    assert report == {'rows': 2, 'models': {imp.SEEDED_EMBEDDING_MODEL: 2}}
    # content_sha reproduces delphi_embedding_sets.content_sha over the float32 rows.
    expected_rows = [(tid, shas[(1, tid)], [struct.unpack('<f', struct.pack('<f', v))[0] for v in vectors[tid]])
                     for tid in sorted(vectors)]
    assert descriptor['content_sha'] == imp.embedding_content_sha(expected_rows)
    # The detached child re-emits the spool for the daemon, keyed exactly as it re-checks.
    spec = imp.specification(bundles[0], [])
    out = tmp_path/'out'; out.mkdir()
    monkeypatch.setenv('DELPHI_OUTPUT_MANIFEST', str(out/'manifest.json'))
    frame = dict(zid=1, embeddings_table=True, input=dict(declared=spec['nodes'][0]['declared']))
    output = imp.execute(frame)
    assert set(output['embedding_spool']) == {'file', 'sha256', 'model', 'dims', 'rows'}
    assert output['embedding_spool'] == dict(file='embeddings.spool', sha256=descriptor['sha256'],
                                             model=imp.SEEDED_EMBEDDING_MODEL, dims=3, rows=2)
    model, dims, back = read_spool((out/'embeddings.spool').read_bytes())
    assert model == imp.SEEDED_EMBEDDING_MODEL and dims == 3 and {r['tid'] for r in back} == {1, 2}
    # The empty codec family is still staged.
    assert codec.decode_family((out/(FAMILY+'.jsonl')).read_bytes())[1] == []


def test_embeddings_flag_must_agree_between_snapshot_and_frame(tmp_path, monkeypatch):
    rows = [embedding_item(1, 1, [0.5, 0.25, 0.125])]
    summary = imp.census(Source({FAMILY: rows}), tmp_path/'db', {'1': 1}, {})
    monkeypatch.setattr(imp, 'SNAPSHOTS', tmp_path/'snapshots')
    bundles = imp.materialize(tmp_path/'db', tmp_path/'snapshots', summary,
                              embeddings_table=True, text_shas={(1, 1): text_sha('x')}, embedding_report={})
    spec = imp.specification(bundles[0], [])
    out = tmp_path/'out'; out.mkdir()
    monkeypatch.setenv('DELPHI_OUTPUT_MANIFEST', str(out/'manifest.json'))
    frame_off = dict(zid=1, input=dict(declared=spec['nodes'][0]['declared']))
    with pytest.raises(ValueError, match='embeddings table flag mismatch'):
        imp.execute(frame_off)
    # Snapshot staged flag-off, frame flag-on also refuses rather than drop rows.
    off = imp.materialize(tmp_path/'db', tmp_path/'plain', summary)
    monkeypatch.setattr(imp, 'SNAPSHOTS', tmp_path/'plain')
    spec_off = imp.specification(off[0], [])
    out2 = tmp_path/'out2'; out2.mkdir()
    monkeypatch.setenv('DELPHI_OUTPUT_MANIFEST', str(out2/'manifest.json'))
    frame_on = dict(zid=1, embeddings_table=True, input=dict(declared=spec_off['nodes'][0]['declared']))
    with pytest.raises(ValueError, match='embeddings table flag mismatch'):
        imp.execute(frame_on)


def test_flag_on_large_embeddings_family_no_longer_refuses(tmp_path, monkeypatch):
    # Enough embedding rows that the codec family exceeds a lowered family bound.
    rows = [embedding_item(1, i, [0.5, 0.25, 0.125, -0.5]) for i in range(40)]
    summary = imp.census(Source({FAMILY: rows}), tmp_path/'db', {'1': 1}, {})
    shas = {(1, i): text_sha('c%d' % i) for i in range(40)}
    monkeypatch.setattr(imp, 'FAMILY_LIMIT', 500)
    # Flag off: the oversized codec family refuses on the apply path, as today.
    with pytest.raises(ValueError, match='conversation family exceeds staged storage bound'):
        imp.materialize(tmp_path/'db', tmp_path/'off', summary)
    # Flag on: the family is empty and the rows are in the spool; no refusal.
    report = {}
    bundles = imp.materialize(tmp_path/'db', tmp_path/'on', summary,
                              embeddings_table=True, text_shas=shas, embedding_report=report)
    manifest = _manifest(tmp_path/'on', bundles[0])
    assert manifest['families'][FAMILY]['bytes'] < 500 and manifest['families'][FAMILY]['rows'] == 0
    assert manifest['embeddings']['rows'] == 40 and report['rows'] == 40


def test_missing_comment_text_is_skipped_and_counted(tmp_path, monkeypatch):
    rows = [embedding_item(1, 1, [0.5, 0.25, 0.125]), embedding_item(1, 2, [1.0, -2.0, 0.5])]
    summary = imp.census(Source({FAMILY: rows}), tmp_path/'db', {'1': 1}, {})
    report = {}
    bundles = imp.materialize(tmp_path/'db', tmp_path/'snap', summary,
                              embeddings_table=True, text_shas={(1, 1): text_sha('only one')}, embedding_report=report)
    assert report == {'rows': 1, 'text_missing': 1, 'models': {imp.SEEDED_EMBEDDING_MODEL: 1}}
    assert _manifest(tmp_path/'snap', bundles[0])['embeddings']['rows'] == 1


@pytest.mark.parametrize('rows,match', [
    ([embedding_item(1, 1, [0.5, 0.25, 0.125], model='some-other-model')], 'unmapped embedding model'),
    ([embedding_item(1, 1, [0.1, 0.2, 0.3])], 'float32 exact'),
    ([embedding_item(1, 1, [0.5, 0.25, 0.125]), embedding_item(1, 2, [0.5, 0.25])], 'multiple embedding models in conversation'),
])
def test_flag_on_refuses_bad_embeddings(tmp_path, rows, match):
    summary = imp.census(Source({FAMILY: rows}), tmp_path/'db', {'1': 1}, {})
    shas = {(1, 1): text_sha('a'), (1, 2): text_sha('b')}
    with pytest.raises(ValueError, match=match):
        imp.materialize(tmp_path/'db', tmp_path/'snap', summary,
                        embeddings_table=True, text_shas=shas, embedding_report={})


def test_embedding_model_counts_are_per_raw_string(tmp_path):
    rows = [embedding_item(1, 1, [0.5, 0.25, 0.125], model='all-MiniLM-L6-v2'),
            embedding_item(1, 2, [0.5, 0.25, 0.125], model='all-MiniLM-L6-v2'),
            embedding_item(2, 3, [0.5, 0.25, 0.125], model='sentence-transformers/all-MiniLM-L6-v2')]
    summary = imp.census(Source({FAMILY: rows}), tmp_path/'db', {'1': 1, '2': 2}, {})
    assert imp.embedding_model_counts(tmp_path/'db') == {
        'all-MiniLM-L6-v2': 2, 'sentence-transformers/all-MiniLM-L6-v2': 1}


def test_flag_off_materialize_is_unchanged(tmp_path):
    rows = [embedding_item(1, 1, [0.5, 0.25, 0.125]), embedding_item(1, 2, [1.0, -2.0, 0.5])]
    summary = imp.census(Source({FAMILY: rows}), tmp_path/'db', {'1': 1}, {})
    plain = imp.materialize(tmp_path/'db', tmp_path/'off', summary)
    manifest = _manifest(tmp_path/'off', plain[0])
    assert 'embeddings_table' not in manifest and 'embeddings' not in manifest
    assert manifest['families'][FAMILY]['rows'] == 2
    assert codec.decode_family((tmp_path/'off'/plain[0]['digest']/(FAMILY+'.jsonl')).read_bytes())[1] == rows


def test_daemon_queue_url_strips_only_libpq_tls_params():
    """The exact production QUEUE_DATABASE_URL shape: import_worker login, verify-full
    and a pinned CA bundle. The daemon DSN drops only the libpq TLS parameters the
    Rust parser rejects and keeps the user, password, host, port and dbname."""
    from psycopg2.extensions import parse_dsn
    # 44-char password, letters+digits only (the genpw alphabet, URL-safe with no encoding).
    password = ('aZ09' * 11)
    dsn = ('postgresql://import_worker:%s@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/global-bundle.pem' % password)
    derived = imp._daemon_queue_url(dsn)
    assert 'sslmode' not in derived and 'sslrootcert' not in derived
    # Every stripped parameter is gone; everything else is byte-for-byte unchanged.
    assert derived == 'postgresql://import_worker:%s@db.example.internal:5432/polis' % password
    parsed = parse_dsn(derived)
    assert parsed['user'] == 'import_worker' and parsed['password'] == password
    assert parsed['host'] == 'db.example.internal' and parsed['port'] == '5432'
    assert parsed['dbname'] == 'polis'
    assert 'sslmode' not in parsed and 'sslrootcert' not in parsed


def test_daemon_queue_url_preserves_percent_encoding_and_other_params():
    """A percent-encoded password byte and a non-TLS parameter tokio-postgres accepts
    survive unchanged; only the TLS keys are dropped."""
    from psycopg2.extensions import parse_dsn
    dsn = ('postgresql://import_worker:p%40ss%2Fword@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/global-bundle.pem'
           '&application_name=import&connect_timeout=10')
    derived = imp._daemon_queue_url(dsn)
    assert derived == ('postgresql://import_worker:p%40ss%2Fword@db.example.internal:5432/polis'
                       '?application_name=import&connect_timeout=10')
    parsed = parse_dsn(derived)
    assert parsed['password'] == 'p@ss/word'  # the percent-encoding round-trips
    assert parsed['application_name'] == 'import' and parsed['connect_timeout'] == '10'


def test_daemon_queue_url_odd_password_in_url_form_is_byte_preserved():
    """An odd password in URL form (percent-encoded quotes, spaces and reserved bytes)
    is kept byte for byte; only the TLS keys are dropped."""
    from psycopg2.extensions import parse_dsn
    # Encodes the literal password:  'a b'@=&/
    encoded = "%27a%20b%27%40%3D%26%2F"
    dsn = ('postgresql://import_worker:%s@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/global-bundle.pem' % encoded)
    derived = imp._daemon_queue_url(dsn)
    assert derived == 'postgresql://import_worker:%s@db.example.internal:5432/polis' % encoded
    # The userinfo bytes were never decoded or re-encoded; libpq recovers the original.
    assert parse_dsn(derived)['password'] == "'a b'@=&/"


def test_daemon_queue_url_recognizes_percent_encoded_tls_keys():
    """tokio-postgres percent-decodes parameter names, so an encoded sslmode/sslrootcert
    key must be recognized and stripped, not passed through as an unknown name."""
    # ssl%6Dode -> sslmode ; sslroot%63ert -> sslrootcert
    dsn = ('postgresql://import_worker:pw@db.example.internal:5432/polis'
           '?ssl%6Dode=verify-full&sslroot%63ert=/ca/global-bundle.pem&application_name=import')
    derived = imp._daemon_queue_url(dsn)
    assert derived == ('postgresql://import_worker:pw@db.example.internal:5432/polis'
                       '?application_name=import')


def test_daemon_queue_url_drops_duplicate_tls_params_keeps_tls_text_in_values():
    """Repeated TLS keys are all removed; a non-TLS value that merely looks like a TLS
    parameter (even percent-encoded) is left untouched."""
    dsn = ('postgresql://import_worker:pw@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/a.pem&sslrootcert=/ca/b.pem'
           '&application_name=sslmode%3Dverify-full')
    derived = imp._daemon_queue_url(dsn)
    assert derived == ('postgresql://import_worker:pw@db.example.internal:5432/polis'
                       '?application_name=sslmode%3Dverify-full')


def test_daemon_queue_url_preserves_sslnegotiation():
    """sslnegotiation is accepted and applied by the pinned tokio-postgres parser, so it
    is preserved rather than stripped under the 'remove only what the daemon reproduces'
    contract."""
    dsn = ('postgresql://import_worker:pw@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/global-bundle.pem&sslnegotiation=direct')
    derived = imp._daemon_queue_url(dsn)
    assert derived == ('postgresql://import_worker:pw@db.example.internal:5432/polis'
                       '?sslnegotiation=direct')


@pytest.mark.parametrize('dsn', [
    'host=db.example.internal port=5432 user=import_worker dbname=polis sslmode=verify-full',
    "host=db.example.internal user=import_worker password='a b' sslmode=verify-full",
    'user=import_worker dbname=polis sslmode = verify-full sslrootcert = /ca/global-bundle.pem',
])
def test_daemon_queue_url_refuses_keyword_dsns(dsn):
    """Keyword/value DSNs are refused, not rewritten: their grammar cannot be edited
    safely by token splitting, and production never uses them."""
    with pytest.raises(ValueError, match='postgresql'):
        imp._daemon_queue_url(dsn)


@pytest.mark.parametrize('param', [
    'sslcrl=/ca/revoked.pem',
    'sslcrldir=/ca/crls',
    'ssl_min_protocol_version=TLSv1.3',
    'ssl_max_protocol_version=TLSv1.3',
    'sslcert=/ca/client.pem',
    'sslkey=/ca/client.key',
    'sslpassword=secret',
    'gssencmode=require',
    'sslcompression=1',
    'ssl_%6Din_protocol_version=TLSv1.3',  # encoded 'm' -> ssl_min_protocol_version
])
def test_daemon_queue_url_refuses_unreproduced_tls_params(param):
    """A TLS policy parameter the daemon does not reproduce is refused, never silently
    dropped (which would hand the daemon a weaker policy than the import requires)."""
    dsn = ('postgresql://import_worker:pw@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/global-bundle.pem&' + param)
    with pytest.raises(ValueError, match='does not reproduce'):
        imp._daemon_queue_url(dsn)


@pytest.mark.parametrize('raw', ['\t', '\n', '\r', '#'], ids=['tab', 'lf', 'cr', 'hash'])
def test_daemon_queue_url_refuses_raw_tab_newline_cr_and_hash_in_password(raw):
    """urlsplit deletes a raw tab/newline/CR and treats a raw '#' as a fragment start,
    either of which would change the password libpq sees. Refuse the raw byte and make
    the caller percent-encode it."""
    dsn = ('postgresql://import_worker:a' + raw + 'b@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/global-bundle.pem')
    with pytest.raises(ValueError, match='percent-encode'):
        imp._daemon_queue_url(dsn)


def test_daemon_queue_url_refuses_raw_hash_that_would_hide_a_policy_param():
    """A raw '#' in a query value would push the parameters after it into urlsplit's
    fragment, bypassing the TLS-policy refusal below. Refuse it."""
    dsn = ('postgresql://import_worker:pw@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/global-bundle.pem'
           '&application_name=a#b&ssl_min_protocol_version=TLSv1.3')
    with pytest.raises(ValueError, match='percent-encode'):
        imp._daemon_queue_url(dsn)


@pytest.mark.parametrize('raw', ['\t', '\n', '\r'], ids=['tab', 'lf', 'cr'])
def test_daemon_queue_url_refuses_raw_whitespace_in_a_retained_value(raw):
    """The same raw-byte refusal applies to a retained (non-TLS) query value, not only
    the password."""
    dsn = ('postgresql://import_worker:pw@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/global-bundle.pem'
           '&application_name=a' + raw + 'b')
    with pytest.raises(ValueError, match='percent-encode'):
        imp._daemon_queue_url(dsn)


def test_daemon_queue_url_preserves_percent_encoded_control_bytes():
    """The percent-encoded counterparts (%09 tab, %0A LF, %0D CR, %23 '#') pass through
    untouched in both the password and a retained value, and libpq recovers the literal
    bytes."""
    from psycopg2.extensions import parse_dsn
    pw = 'a%09b%0Ac%0Dd%23e'          # tab, LF, CR, '#'
    appname = 'x%09y%23z'
    dsn = ('postgresql://import_worker:' + pw + '@db.example.internal:5432/polis'
           '?sslmode=verify-full&sslrootcert=/ca/global-bundle.pem'
           '&application_name=' + appname)
    derived = imp._daemon_queue_url(dsn)
    assert derived == ('postgresql://import_worker:' + pw + '@db.example.internal:5432/polis'
                       '?application_name=' + appname)
    parsed = parse_dsn(derived)
    assert parsed['password'] == 'a\tb\nc\rd#e'
    assert parsed['application_name'] == 'x\ty#z'


# ---- latest-tick-only for the tick-keyed PCA/KMeans families -----------------
# Rows per tick for each tick-keyed family built by _tick_source below.
PER_TICK = {'Delphi_PCAResults': 1, 'Delphi_KMeansClusters': 2, 'Delphi_CommentRouting': 2,
            'Delphi_PCAParticipantProjections': 2, 'Delphi_RepresentativeComments': 4}


def _tick_source(zid, ticks, comments=2, participants=2, groups=2):
    """Source items for one conversation across several math ticks, shaped like the
    five tick-keyed families (PER_TICK rows each per tick), as production_import.py
    sees them from DynamoDB."""
    src = {family: [] for family in imp.TICK_FAMILIES}
    for t in ticks:
        zt = '%s:%d' % (zid, t)
        src['Delphi_PCAResults'].append(codec.item_from_python(dict(zid=zid, math_tick=t, comment_count=comments)))
        for g in range(groups):
            src['Delphi_KMeansClusters'].append(codec.item_from_python(dict(zid_tick=zt, group_id=g, zid=zid, n=1)))
        for c in range(comments):
            src['Delphi_CommentRouting'].append(codec.item_from_python(dict(zid_tick=zt, comment_id=str(c), zid=zid, p=1)))
        for p in range(participants):
            src['Delphi_PCAParticipantProjections'].append(codec.item_from_python(dict(zid_tick=zt, participant_id=str(p), zid=zid, x=1)))
        for g in range(groups):
            for c in range(comments):
                src['Delphi_RepresentativeComments'].append(codec.item_from_python(dict(zid_tick_gid='%s:%d:%d' % (zid, t, g), comment_id=str(c), zid=zid, r=1)))
    return src


@pytest.mark.parametrize('n', [3, 33])
def test_latest_tick_only_imports_newest_and_archives_older_ticks(tmp_path, n):
    # 3 ticks, then 33 ticks of accumulated math history for one active conversation:
    # one tick's worth is imported and every older tick is archived, not copied into
    # the batch (33 ticks is the shape that overran result-family staging).
    zid = '40001'
    ticks = list(range(100, 100 + n))
    newest = ticks[-1]
    src = _tick_source(zid, ticks)
    src['Delphi_PCAConversationConfig'] = [codec.item_from_python(
        dict(zid=zid, latest_math_tick=newest, participant_count=2))]
    summary = imp.census(Source(src), tmp_path / 'db', {zid: 40001}, {})

    for family, per in PER_TICK.items():
        assert summary['counts'][family] == dict(
            source=per * n, imported=per, archived=per * (n - 1), quarantined=0), family
    # The per-zid config pointer is single-copy and never archived.
    assert summary['counts']['Delphi_PCAConversationConfig'] == dict(
        source=1, imported=1, archived=0, quarantined=0)
    # Conservation balances for every family (nothing lost, dropped rows countable).
    assert all(c['source'] == c['imported'] + c['archived'] + c['quarantined']
               for c in summary['counts'].values())

    bundles = imp.materialize(tmp_path / 'db', tmp_path / 'out', summary)
    digest = next(b['digest'] for b in bundles if b['zid'] == 40001)
    for family in imp.TICK_FAMILIES:
        imported = codec.decode_family((tmp_path / 'out' / digest / (family + '.jsonl')).read_bytes())[1]
        archived = codec.decode_family((tmp_path / 'out' / ('archived-' + family + '.jsonl')).read_bytes())[1]
        assert len(imported) == PER_TICK[family]
        assert len(archived) == PER_TICK[family] * (n - 1)
        # Served reads are unchanged: a reader resolves latest_math_tick and serves
        # that one tick, which is exactly what was imported; the rest is archived.
        assert all(imp._row_tick(family, r) == newest for r in imported)
        assert all(imp._row_tick(family, r) in ticks[:-1] for r in archived)


def test_latest_tick_falls_back_to_max_when_config_row_is_missing(tmp_path):
    # No Delphi_PCAConversationConfig row: the latest tick is the max tick present,
    # even when the ticks arrive out of order.
    zid = '7001'
    summary = imp.census(Source(_tick_source(zid, [5, 9, 2])), tmp_path / 'db', {zid: 7001}, {})
    assert summary['counts']['Delphi_PCAConversationConfig']['source'] == 0
    for family, per in PER_TICK.items():
        assert summary['counts'][family] == dict(
            source=per * 3, imported=per, archived=per * 2, quarantined=0), family
    bundles = imp.materialize(tmp_path / 'db', tmp_path / 'out', summary)
    digest = next(b['digest'] for b in bundles if b['zid'] == 7001)
    for family in imp.TICK_FAMILIES:
        imported = codec.decode_family((tmp_path / 'out' / digest / (family + '.jsonl')).read_bytes())[1]
        assert all(imp._row_tick(family, r) == 9 for r in imported)
