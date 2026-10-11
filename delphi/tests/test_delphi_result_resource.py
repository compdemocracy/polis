import os
import unittest
from unittest.mock import patch, Mock
from decimal import Decimal
from polismath.delphi_storage.resource import PostgresResource, result_resource
from polismath.delphi_storage.codec import item_from_python, encode_family


class Cursor:
    def __init__(self,rows):self.rows=rows;self.archives=[];self.calls=[]
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def execute(self,sql,args=()):self.calls.append((sql,args))
    def fetchall(self):return self.archives if 'legacy_controls' in self.calls[-1][0] else self.rows


class Connection:
    def __init__(self,rows):self.cur=Cursor(rows)
    def cursor(self):return self.cur


class ResultResourceTest(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,DELPHI_RESULT_BACKEND='postgres',DELPHI_RESULT_ENV='test-results')
        self.env.start();self.addCleanup(self.env.stop)
        self.rows=[(1,'scope',1,item_from_python(dict(conversation_id='1',comment_id=i,value=Decimal('0.25')))) for i in range(3)]
        self.connection=Connection(self.rows)
        self.table=PostgresResource(self.connection).Table('Delphi_CommentEmbeddings')

    def test_query_pushes_bound_key_and_preserves_decimal(self):
        reply=self.table.query(KeyConditionExpression='conversation_id = :id',ExpressionAttributeValues={':id':'1'})
        self.assertEqual(reply['Count'],3)
        self.assertEqual(reply['Items'][0]['value'],Decimal('0.25'))
        sql,binds=self.connection.cur.calls[0]
        self.assertIn('item->%s = %s::jsonb',sql)
        self.assertIn('conversation_id',binds)

    def test_pagination_and_generation_change(self):
        first=self.table.query(Limit=1)
        self.assertEqual(self.table.query(Limit=1,ExclusiveStartKey=first['LastEvaluatedKey'])['Items'][0]['comment_id'],1)
        self.connection.cur.rows=[(zid,'scope',2,row) for zid,_,_,row in self.rows]
        with self.assertRaisesRegex(ValueError,'generation changed'):
            self.table.query(ExclusiveStartKey=first['LastEvaluatedKey'])

    def test_ambiguous_scopes_refused(self):
        self.connection.cur.rows.append((1,'other',1,item_from_python(dict(conversation_id='1',comment_id=0,value=Decimal('1')))))
        with self.assertRaisesRegex(ValueError,'ambiguous'):
            self.table.query()

    def test_cross_conversation_cursor_tracks_each_generation(self):
        self.connection.cur.rows += [(2,'scope',1,item_from_python(dict(conversation_id='2',comment_id=0)))]
        first=self.table.scan(Limit=1)
        self.connection.cur.rows=[(zid,scope,2 if zid==1 else generation,item) for zid,scope,generation,item in self.connection.cur.rows]
        with self.assertRaisesRegex(ValueError,'generation changed'):
            self.table.scan(ExclusiveStartKey=first['LastEvaluatedKey'])

    def test_legacy_metadata_retains_nul_and_exact_numbers_without_activation(self):
        connection=Connection([({'job_id':'current','status':'COMPLETED'},)])
        archived=[dict(job_id='legacy',conversation_id='1',status='PROCESSING',logs='a\0b',job_config={'large':Decimal('9007199254740993')},binary=b'bytes'),dict(job_id='current',status='PROCESSING')]
        wire=encode_family('Delphi_JobQueue',[item_from_python(item) for item in archived]).decode()
        connection.cur.archives=[(1,'scope',4,wire)]
        reply=PostgresResource(connection).Table('Delphi_JobQueue').scan()
        legacy=next(item for item in reply['Items'] if item['job_id']=='legacy')
        self.assertTrue(legacy['archived']);self.assertEqual(legacy['logs'],'a\0b')
        self.assertEqual(legacy['job_config']['large'],Decimal('9007199254740993'))
        self.assertEqual(legacy['binary'],b'bytes')
        self.assertEqual(next(item for item in reply['Items'] if item['job_id']=='current')['status'],'COMPLETED')

    def test_mutation_refused(self):
        with self.assertRaisesRegex(RuntimeError,'immutable'):
            self.table.put_item(Item={})

    def test_postgres_selection_never_calls_boto(self):
        # Import is lazy: this test works with no boto3 package installed.
        with patch.dict('sys.modules',{'boto3':None}):
            self.assertIsInstance(result_resource(),PostgresResource)

    def test_index_sort_uses_created_time(self):
        rows=[({'job_id':'z-older','created_at':'2025-01-01T00:00:00Z'},),
              ({'job_id':'a-newer','created_at':'2026-01-01T00:00:00Z'},)]
        table=PostgresResource(Connection(rows)).Table('Delphi_JobQueue')
        self.assertEqual(table.query(IndexName='ConversationIndex',ScanIndexForward=False,Limit=1)['Items'][0]['job_id'],'a-newer')

    def test_job_get_reads_bound_attempt_logs(self):
        connection=Connection([({'job_id':'generated-job'},)])
        fetch=connection.cur.fetchall
        def rows():
            sql=connection.cur.calls[-1][0]
            if 'pq_job_status' in sql:return [({'attempt_id':'generated-attempt'},)]
            if 'pq_attempt_logs' in sql:return [('2026-01-01T00:00:00Z','INFO','actual child output')]
            return fetch()
        connection.cur.fetchall=rows
        item=PostgresResource(connection).Table('Delphi_JobQueue').get_item(Key={'job_id':'generated-job'})['Item']
        self.assertEqual(item['log_attempt_id'],'generated-attempt')
        self.assertIn('actual child output',item['logs'])
        self.assertEqual(connection.cur.calls[-1][1],['test-results','generated-attempt'])
        self.assertIn('NULL,1000',connection.cur.calls[-1][0])

    def test_job_metadata_uses_same_graph_scope_as_archives(self):
        connection=Connection([])
        with patch.dict(os.environ,DELPHI_RESULT_SCOPE='delphi'):
            PostgresResource(connection).Table('Delphi_JobQueue').scan()
        self.assertEqual(len(connection.cur.calls),2)
        for sql,binds in connection.cur.calls:
            self.assertIn('scope_key=%s',sql)
            self.assertEqual(binds[-1],'delphi')

    def test_default_and_explicit_dynamo_forward_unchanged(self):
        for backend in (None, 'dynamodb'):
            with self.subTest(backend=backend), patch.dict(os.environ, {}, clear=True):
                if backend is not None:
                    os.environ['DELPHI_RESULT_BACKEND'] = backend
                boto = Mock()
                with patch.dict('sys.modules', {'boto3': boto}):
                    result = result_resource(endpoint_url='http://localhost:8000')
                self.assertIs(result, boto.resource.return_value)
                boto.resource.assert_called_once_with('dynamodb', endpoint_url='http://localhost:8000')

    def test_unknown_backend_refused(self):
        with patch.dict(os.environ,DELPHI_RESULT_BACKEND='postgress'):
            with self.assertRaisesRegex(ValueError,'invalid'):
                result_resource()


if __name__=='__main__':unittest.main()
