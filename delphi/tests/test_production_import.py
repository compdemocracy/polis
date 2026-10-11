"""Generated boundary tests; no cloud, provider or raw votes."""
import json
import os
from pathlib import Path
import sqlite3
from types import SimpleNamespace
import pytest
from polismath.delphi_storage import production_import as imp
from polismath.delphi_storage import legacy_import as legacy
from polismath.delphi_storage import codec
from polismath.delphi_storage import scan_pacing


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
