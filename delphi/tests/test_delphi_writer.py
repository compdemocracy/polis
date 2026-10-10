"""Only generated result rows; no votes or paid provider calls."""
import json
import os
import uuid
from decimal import Decimal
import pytest
from polismath.delphi_storage.codec import item_from_python,decode_family
from polismath.delphi_storage.resource import result_resource
from polismath.delphi_storage.writer import WriterResource
from polismath.delphi_storage.postgres import RESULT_FAMILIES

@pytest.fixture
def writer(tmp_path,monkeypatch):
    jid,run,attempt=[str(uuid.uuid4()) for _ in range(3)]
    frame=dict(schema='polis-jobs.frame/1',env='proof',zid=1,job_id=jid,run_id=run,attempt_id=attempt,lease_epoch='1',
        config={'result_backend':'postgres'},writer_base={'schema':'delphi-writer-base/1','zid':1,'families':{}})
    path=tmp_path/'frame.json';path.write_text(json.dumps(frame))
    for key,value in dict(DELPHI_RESULT_BACKEND='postgres',DELPHI_OUTPUT_MANIFEST=str(tmp_path/'manifest.json'),
            DELPHI_FRAME=str(path),DELPHI_JOB_ID=jid,DELPHI_RUN_ID=run,DELPHI_ATTEMPT_ID=attempt).items():monkeypatch.setenv(key,value)
    import boto3
    monkeypatch.setattr(boto3,'resource',lambda *a,**k:pytest.fail('Dynamo resource created'))
    return result_resource()

@pytest.mark.parametrize('family',sorted(RESULT_FAMILIES))
def test_roundtrip_every_family(writer,family):
    from polismath.delphi_storage.codec import FAMILIES
    special={'zid':'1','conversation_id':'1','zid_tick':'1:1','zid_tick_gid':'1:1:0','zid_topic_jobid':'1#topic#job'}
    row={k:(Decimal(0) if tag=='N' else special.get(k,'generated')) for k,tag in FAMILIES[family]['key']}
    row.update(value=Decimal('1.234567890123456789'),document='{"keep":"string"}',binary=b'\x00\x01',names={'x','y'})
    table=writer.Table(family)
    with table.batch_writer() as batch:batch.put_item(Item=row)
    key={k:row[k] for k,_ in FAMILIES[family]['key']}
    assert WriterResource().Table(family).get_item(Key=key)['Item']==row
    table.update_item(Key=key,UpdateExpression='SET #v = :v',ExpressionAttributeNames={'#v':'new'},ExpressionAttributeValues={':v':'changed'})
    assert table.get_item(Key=key)['Item']['new']=='changed'
    table.delete_item(Key=key)
    assert table.get_item(Key=key)=={}

def test_spool_keeps_exact_decimal_and_deleted_family(writer):
    table=writer.Table('Delphi_CommentEmbeddings')
    table.put_item(Item=dict(conversation_id='1',comment_id=Decimal(2),value=Decimal('0.00000000000000000001')))
    files=writer.spool()
    assert len(files)==18
    for family,description in files.items():
        actual,rows=decode_family((writer.directory/description['file']).read_bytes())
        assert family==actual
        assert len(rows)==(1 if family==table.name else 0)

def test_queue_and_cross_conversation_writes_refuse(writer):
    with pytest.raises(RuntimeError,match='queue state'):writer.Table('Delphi_JobQueue').put_item(Item={'job_id':'x'})
    with pytest.raises(ValueError,match='conversation'):writer.Table('Delphi_CommentEmbeddings').put_item(Item={'conversation_id':'2','comment_id':1})

def test_reset_is_private_and_preserves_other_products(writer):
    writer.Table('Delphi_CommentEmbeddings').put_item(Item={'conversation_id':'1','comment_id':1})
    writer.Table('Delphi_CollectiveStatement').put_item(Item={'zid_topic_jobid':'1#t#j','text':'keep'})
    writer.reset()
    assert not writer.Table('Delphi_CommentEmbeddings').scan()['Items']
    assert writer.Table('Delphi_CollectiveStatement').scan()['Items'][0]['text']=='keep'

def test_changed_attempt_binding_refuses(writer,monkeypatch):
    monkeypatch.setenv('DELPHI_ATTEMPT_ID',str(uuid.uuid4()))
    with pytest.raises(ValueError,match='bound queue attempt'):WriterResource()

def test_pagination_projection_and_filters(writer):
    table=writer.Table('Delphi_CommentEmbeddings')
    for cid in range(5):table.put_item(Item={'conversation_id':'1','comment_id':cid,'text':str(cid)})
    first=table.query(KeyConditionExpression='conversation_id = :z',ExpressionAttributeValues={':z':'1'},Limit=2)
    second=table.query(KeyConditionExpression='conversation_id = :z',ExpressionAttributeValues={':z':'1'},Limit=2,ExclusiveStartKey=first['LastEvaluatedKey'])
    assert [i['comment_id'] for i in second['Items']]==[2,3]
    assert table.scan(Select='COUNT')['Count']==5

def test_actual_pipeline_orchestration_uses_private_reset_and_v2_manifest(writer,monkeypatch):
    import run_delphi
    from polismath.job_child import census
    import sys
    from types import SimpleNamespace
    frame=writer.frame
    frame.update(stage='delphi_full_pipeline',phase='run',report_id=None,inputs={},provider={'batch_id':None})
    frame['config'].update(include_moderation=True,exclude_comment_selections=True,model=None,batch_size=None)
    Path=__import__('pathlib').Path
    Path(os.environ['DELPHI_FRAME']).write_text(json.dumps(frame))
    for key,value in {'DELPHI_LEASE_EPOCH':'1','DELPHI_STAGE':'delphi_full_pipeline','DELPHI_PHASE':'run'}.items():monkeypatch.setenv(key,value)
    writer.Table('Delphi_CollectiveStatement').put_item(Item={'zid_topic_jobid':'1#old#report','text':'preserved'})
    writer.Table('Delphi_CommentEmbeddings').put_item(Item={'conversation_id':'1','comment_id':999})
    monkeypatch.setattr(census,'default_pg_query',lambda:None)
    monkeypatch.setattr(census,'observe_inputs',lambda *a:{'math_env':'proof','math_tick':None,'math_caching_tick':None,'comment_set_sha256':None,'vote_hwm':None})
    scripts=[]
    def stage(command,**kwargs):
        scripts.append(command[1])
        assert 'reset_conversation' not in command[1]
        resource=result_resource()
        if command[1].endswith('run_math_pipeline.py'):
            resource.Table('Delphi_PCAConversationConfig').put_item(Item={'zid':'1','math_tick':1})
        if command[1].endswith('run_pipeline.py'):
            resource.Table('Delphi_CommentEmbeddings').put_item(Item={'conversation_id':'1','comment_id':0})
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(run_delphi.subprocess,'run',stage)
    monkeypatch.setattr(sys,'argv',['run_delphi.py','--zid=1'])
    with pytest.raises(SystemExit) as done:run_delphi.main()
    assert done.value.code==0 and len(scripts)>=4
    manifest=json.loads(Path(os.environ['DELPHI_OUTPUT_MANIFEST']).read_text())
    assert manifest['schema']=='polis-jobs.output-manifest/2'
    assert all(o['store']=='postgres' for o in manifest['outputs'])
    resource=result_resource()
    assert [i['comment_id'] for i in resource.Table('Delphi_CommentEmbeddings').scan()['Items']]==[0]
    assert resource.Table('Delphi_CollectiveStatement').scan()['Items'][0]['text']=='preserved'

def test_postgres_bootstrap_and_legacy_poller_never_construct_dynamo(writer,monkeypatch):
    import boto3
    import create_dynamodb_tables
    from scripts.job_poller import JobProcessor
    monkeypatch.setattr(boto3,'Session',lambda *a,**k:pytest.fail('Dynamo session created'))
    assert create_dynamodb_tables.create_tables()==[]
    assert create_dynamodb_tables.main() is None
    with pytest.raises(RuntimeError,match='polis-jobs'):JobProcessor()
