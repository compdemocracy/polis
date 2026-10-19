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

def test_spool_keeps_exact_decimal_and_holds_only_the_written_family(writer):
    table=writer.Table('Delphi_CommentEmbeddings')
    table.put_item(Item=dict(conversation_id='1',comment_id=Decimal(2),value=Decimal('0.00000000000000000001')))
    files=writer.spool()
    assert set(files)=={table.name}
    actual,rows=decode_family((writer.directory/files[table.name]['file']).read_bytes())
    assert actual==table.name and len(rows)==1 and rows[0]['value']=={'N':'0.00000000000000000001'}


PRESERVED={'Delphi_NarrativeReports','report_narrative_store','Delphi_CollectiveStatement','Delphi_TopicAgendaSelections'}


def _based_writer(tmp_path, monkeypatch, base_families):
    """A writer whose admission captured a publication holding these rows."""
    jid,run,attempt=[str(uuid.uuid4()) for _ in range(3)]
    tagged={family:[item_from_python(row) for row in rows] for family,rows in base_families.items()}
    frame=dict(schema='polis-jobs.frame/1',env='proof',zid=1,job_id=jid,run_id=run,attempt_id=attempt,lease_epoch='1',
        config={'result_backend':'postgres'},writer_base={'schema':'delphi-writer-base/1','zid':1,'families':tagged})
    (tmp_path/'frame.json').write_text(json.dumps(frame))
    for key,value in dict(DELPHI_RESULT_BACKEND='postgres',DELPHI_OUTPUT_MANIFEST=str(tmp_path/'manifest.json'),
            DELPHI_FRAME=str(tmp_path/'frame.json'),DELPHI_JOB_ID=jid,DELPHI_RUN_ID=run,DELPHI_ATTEMPT_ID=attempt).items():
        monkeypatch.setenv(key,value)
    return WriterResource()


BASE={
    'Delphi_CommentHierarchicalClusterAssignments':[{'conversation_id':'1','comment_id':1,'layer0_cluster_id':0}],
    'Delphi_CommentClustersLLMTopicNames':[{'conversation_id':'1','topic_key':'job#0#0','topic_name':'old'}],
    'Delphi_UMAPGraph':[{'conversation_id':'1','edge_id':'1_2','weight':Decimal('0.5')}],
    'Delphi_NarrativeReports':[{'rid_section_model':'r1#topics#m','timestamp':'2026-01-01T00:00:00Z','report_data':'{}'}],
    'Delphi_CollectiveStatement':[{'zid_topic_jobid':'1#t#j','text':'kept'}],
}


def _spooled(writer, files):
    return {family:decode_family((writer.directory/d['file']).read_bytes())[1] for family,d in files.items()}


def test_narrative_only_run_holds_no_topic_or_cluster_family(tmp_path, monkeypatch):
    writer=_based_writer(tmp_path,monkeypatch,BASE)
    writer.Table('Delphi_NarrativeReports').put_item(Item={'rid_section_model':'r1#uncertainty#m',
        'timestamp':'2026-01-02T00:00:00Z','report_data':'{"new":true}'})
    spooled=_spooled(writer,writer.spool())
    assert set(spooled)=={'Delphi_NarrativeReports'}
    # The family is whole: the base's section and this run's.
    assert [r['rid_section_model']['S'] for r in spooled['Delphi_NarrativeReports']]==['r1#topics#m','r1#uncertainty#m']


def test_full_run_holds_every_family_it_cleared_and_none_it_kept(tmp_path, monkeypatch):
    writer=_based_writer(tmp_path,monkeypatch,BASE)
    writer.reset()
    writer.Table('Delphi_CommentClustersLLMTopicNames').put_item(Item={'conversation_id':'1','topic_key':'new#0#0','topic_name':'new'})
    spooled=_spooled(writer,writer.spool())
    assert set(spooled)==RESULT_FAMILIES-PRESERVED and len(spooled)==14
    assert [r['topic_name']['S'] for r in spooled['Delphi_CommentClustersLLMTopicNames']]==['new']
    # Cleared and not rewritten: emitted empty, so the ancestor's rows stay hidden.
    assert spooled['Delphi_UMAPGraph']==[] and spooled['Delphi_CommentHierarchicalClusterAssignments']==[]


def test_a_delete_alone_emits_the_family(tmp_path, monkeypatch):
    writer=_based_writer(tmp_path,monkeypatch,BASE)
    writer.Table('Delphi_CollectiveStatement').delete_item(Key={'zid_topic_jobid':'1#t#j'})
    assert _spooled(writer,writer.spool())=={'Delphi_CollectiveStatement':[]}


def test_a_run_that_changed_nothing_emits_nothing(tmp_path, monkeypatch):
    writer=_based_writer(tmp_path,monkeypatch,BASE)
    assert writer.Table('Delphi_CommentClustersLLMTopicNames').scan()['Items'][0]['topic_name']=='old'
    assert writer.spool()=={}

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
    # A row a run before the retirement wrote: the reset clears it and no stage writes it again.
    writer.Table('Delphi_PCAResults').put_item(Item={'zid':'1','math_tick':1})
    monkeypatch.setattr(census,'default_pg_query',lambda:None)
    monkeypatch.setattr(census,'observe_inputs',lambda *a:{'math_env':'proof','math_tick':None,'math_caching_tick':None,'comment_set_sha256':None,'vote_hwm':None})
    scripts=[]
    def stage(command,**kwargs):
        scripts.append(command[1])
        assert 'reset_conversation' not in command[1]
        resource=result_resource()
        if command[1].endswith('run_pipeline.py'):
            resource.Table('Delphi_CommentEmbeddings').put_item(Item={'conversation_id':'1','comment_id':0})
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(run_delphi.subprocess,'run',stage)
    monkeypatch.setattr(sys,'argv',['run_delphi.py','--zid=1'])
    with pytest.raises(SystemExit) as done:run_delphi.main()
    assert done.value.code==0
    assert [Path(script).name for script in scripts]==['run_pipeline.py','700_datamapplot_for_layer.py']
    manifest=json.loads(Path(os.environ['DELPHI_OUTPUT_MANIFEST']).read_text())
    assert manifest['schema']=='polis-jobs.output-manifest/2'
    assert all(o['store']=='postgres' for o in manifest['outputs'])
    assert [o['family'] for o in manifest['outputs']]==list(census.CONVERSATION_FAMILIES)
    resource=result_resource()
    for family in census.RETIRED_FAMILIES:
        assert resource.Table(family).scan()['Items']==[]
        spooled=Path(os.environ['DELPHI_OUTPUT_MANIFEST']).parent/manifest['family_spool'][family]['file']
        assert len(spooled.read_bytes().splitlines())==1  # the codec header only: published empty
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


# --- embeddings table (migration 000038), flag on ---------------------------

def _flag_on_writer(tmp_path, monkeypatch, base_families=None):
    jid, run, attempt = [str(uuid.uuid4()) for _ in range(3)]
    frame = dict(schema='polis-jobs.frame/1', env='proof', zid=1, job_id=jid, run_id=run, attempt_id=attempt,
                 lease_epoch='1', config={'result_backend': 'postgres', 'embeddings_table': True},
                 writer_base={'schema': 'delphi-writer-base/1', 'zid': 1, 'families': base_families or {}})
    (tmp_path/'frame.json').write_text(json.dumps(frame))
    for key, value in dict(DELPHI_RESULT_BACKEND='postgres', DELPHI_OUTPUT_MANIFEST=str(tmp_path/'manifest.json'),
            DELPHI_FRAME=str(tmp_path/'frame.json'), DELPHI_JOB_ID=jid, DELPHI_RUN_ID=run, DELPHI_ATTEMPT_ID=attempt).items():
        monkeypatch.setenv(key, value)
    import boto3
    monkeypatch.setattr(boto3, 'resource', lambda *a, **k: pytest.fail('Dynamo resource created'))
    return WriterResource()


def test_embeddings_table_write_spools_and_excludes_codec_family(tmp_path, monkeypatch):
    import hashlib
    from polismath.delphi_storage.embedding_spool import read_spool
    # A base publication that carries the codec embeddings family; the flag must
    # keep it out of the scratch so it stages empty.
    base = {'Delphi_CommentEmbeddings': [{'conversation_id': '1', 'comment_id': 9,
            'embedding': {'vector': [0.5], 'dimensions': 1, 'model': 'm'}}]}
    w = _flag_on_writer(tmp_path, monkeypatch, base_families=base)
    assert w.embeddings_table is True
    assert w.Table('Delphi_CommentEmbeddings').scan()['Items'] == []  # base family not seeded
    rows = [(5, hashlib.sha256(b'c5').digest(), [0.5, -1.0, 2.25]),
            (2, hashlib.sha256(b'c2').digest(), [0.0, 1.5, -3.5])]
    w.put_comment_embeddings(rows, 'sentence-transformers/all-MiniLM-L6-v2', 3)
    descriptor = w.embedding_spool()
    assert descriptor == dict(file='embeddings.spool', sha256=descriptor['sha256'],
                              model='sentence-transformers/all-MiniLM-L6-v2', dims=3, rows=2)
    model, dims, back = read_spool((w.directory/'embeddings.spool').read_bytes())
    assert model == 'sentence-transformers/all-MiniLM-L6-v2' and dims == 3 and {r['tid'] for r in back} == {2, 5}
    files = w.spool()
    # The base's codec rows were dropped, so the run emits that family, empty,
    # to hide them; it touched nothing else.
    assert set(files) == {'Delphi_CommentEmbeddings'}
    actual, crows = decode_family((w.directory/files['Delphi_CommentEmbeddings']['file']).read_bytes())
    assert actual == 'Delphi_CommentEmbeddings' and crows == []  # codec family stays empty


def test_embedding_spool_refuses_bad_rows_and_mixed_model(tmp_path, monkeypatch):
    import hashlib
    w = _flag_on_writer(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match='invalid embedding row'):
        w.put_comment_embeddings([(0, hashlib.sha256(b'x').digest(), [0.5, 0.5])], 'm', 3)  # width != dims
    w.put_comment_embeddings([(1, hashlib.sha256(b'a').digest(), [0.5, 0.5, 0.5])], 'm', 3)
    with pytest.raises(ValueError, match='changed within a run'):
        w.put_comment_embeddings([(2, hashlib.sha256(b'b').digest(), [0.5, 0.5, 0.5])], 'other', 3)


def test_embedding_spool_is_none_when_flag_off(writer):
    # Flag off: no spool, no base exclusion; the codec-family path is unchanged.
    assert writer.embeddings_table is False
    assert writer.embedding_spool() is None
    import pytest as _pytest
    with _pytest.raises(ValueError, match='flag off'):
        writer.put_comment_embeddings([(0, b'0'*32, [0.5])], 'm', 1)
