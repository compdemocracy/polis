"""Paginated result reads that span a publication, on DynamoDB Local and on PostgreSQL.

A cursor is a key position: a publication between two pages never fails the
read. Later pages read what is served when they run and continue after the
cursor's key, even when the cursor's own item is gone, as DynamoDB does.

Generated data only. Needs POLIS_TEST_POSTGRES_URL (a superuser on a migrated
database) for the PostgreSQL leg and DYNAMODB_ENDPOINT for the DynamoDB leg;
each leg skips without its service. Every test uses its own result environment
(PostgreSQL) or its own tables (DynamoDB), and removes them afterwards.
"""
import hashlib
import json
import os
import random
import uuid

import pytest

from polismath.delphi_storage.codec import FAMILIES, encode_family, item_from_python
from polismath.delphi_storage.resource import PostgresResource

SCOPE = 'delphi'
TOPICS = 'Delphi_CommentClustersLLMTopicNames'
EXTREMITY = 'Delphi_CommentExtremity'
STATEMENTS = 'Delphi_CollectiveStatement'
INDEX = 'zid-created_at-index'


def topic_rows(zid, prefix, keys=range(20)):
    return [dict(conversation_id=str(zid), topic_key=f'k{i:02d}', topic_name=f'{prefix}{i}') for i in keys]


def statement_rows(zid, prefix, numbers):
    return [dict(zid_topic_jobid=f'{zid}#topic{i:02d}#job', zid=str(zid), created_at=f'2026-01-01T00:00:{i:02d}Z',
                 text=f'{prefix}{i}') for i in numbers]


class PostgresBackend:
    """Rows reach PostgreSQL as one served generation per publication, through
    the release's validating insert and seal; only the graph scaffolding around
    them is written directly, with triggers and foreign keys off for that
    transaction, as a queue run would leave it."""
    name = 'postgres'

    def __init__(self, url):
        import psycopg2
        self.url = url
        self.connection = psycopg2.connect(url)
        self.connection.autocommit = True
        self.env = 'resource-pagination-' + uuid.uuid4().hex[:12]
        self.zid = random.randint(900000000, 999999999)
        self.previous = {}
        with self.connection.cursor() as cursor:
            cursor.execute("INSERT INTO users(uid,hname,email) VALUES(%s,'generated owner',%s) ON CONFLICT(uid) DO NOTHING",
                           [self.zid, f'generated-{self.zid}@example.invalid'])
            cursor.execute("INSERT INTO conversations(zid,owner,topic) VALUES(%s,%s,'generated') ON CONFLICT(zid) DO NOTHING",
                           [self.zid, self.zid])
        self.reader = None

    def resource(self, monkeypatch):
        monkeypatch.setenv('DELPHI_RESULT_ENV', self.env)
        monkeypatch.setenv('DELPHI_RESULT_SCOPE', SCOPE)
        if self.reader is None:
            import psycopg2
            connection = psycopg2.connect(self.url)
            connection.autocommit = True
            self.reader = PostgresResource(connection)
        return self.reader

    def publish(self, families, zid=None):
        """Publish one generation; families it does not carry are served from the previous one."""
        zid = self.zid if zid is None else zid
        job, run, attempt, artifact = (str(uuid.uuid4()) for _ in range(4))
        previous = self.previous.get(zid)
        generation = (previous['generation'] if previous else 0) + 1
        with self.connection.cursor() as cursor:
            cursor.execute('BEGIN')
            try:
                cursor.execute('SET LOCAL session_replication_role = replica')
                cursor.execute("""INSERT INTO delphi_graph_nodes(env,zid,graph_id,job_id,run_id,node_key,declared)
                    VALUES(%s,%s,%s,%s,%s,'generated','{}')""", [self.env, zid, str(uuid.uuid4()), job, run])
                for family, rows in families.items():
                    wire = encode_family(family, [item_from_python(row) for row in rows]).decode('utf-8')
                    cursor.execute('SELECT pd_result_insert_family(%s,%s,%s,%s,%s)', [self.env, job, attempt, family, wire])
                cursor.execute('SELECT pd_result_seal_internal(%s,%s)', [self.env, attempt])
                seal = cursor.fetchone()[0]
                payload = json.dumps({'results': seal})
                sha = hashlib.sha256(payload.encode('utf-8')).hexdigest()
                cursor.execute("""INSERT INTO delphi_artifacts(env,artifact_id,job_id,run_id,attempt_id,output_role,schema_version,payload,content_sha,byte_count)
                    VALUES(%s,%s,%s,%s,%s,'result','generated/1',%s,%s,%s)""",
                               [self.env, artifact, job, run, attempt, payload, sha, len(payload.encode('utf-8'))])
                cursor.execute('UPDATE delphi_result_batches SET artifact_id=%s WHERE env=%s AND batch_id=%s', [artifact, self.env, attempt])
                if previous:
                    cursor.execute("""INSERT INTO delphi_graph_edges(env,consumer,producer,input_role,expected_sha,artifact_id)
                        VALUES(%s,%s,%s,'previous',%s,%s)""", [self.env, job, previous['job'], previous['sha'], previous['artifact']])
                cursor.execute("""INSERT INTO delphi_graph_served(env,zid,scope_key,generation,artifact_id) VALUES(%s,%s,%s,%s,%s)
                    ON CONFLICT(env,zid,scope_key) DO UPDATE SET generation=EXCLUDED.generation,artifact_id=EXCLUDED.artifact_id""",
                               [self.env, zid, SCOPE, generation, artifact])
                cursor.execute('COMMIT')
            except Exception:
                cursor.execute('ROLLBACK')
                raise
        self.previous[zid] = dict(job=job, artifact=artifact, sha=sha, generation=generation)

    def write(self, family, rows):
        self.publish({family: rows})

    def rewrite(self, family, rows):
        self.publish({family: rows})

    def write_other(self, family, rows, zid):
        self.publish({family: rows}, zid)

    def close(self):
        if self.reader is not None:
            self.reader.connection.close()
        with self.connection.cursor() as cursor:
            # Served pointers only; the immutable history stays, scoped to this test's env.
            cursor.execute('BEGIN')
            cursor.execute('SET LOCAL session_replication_role = replica')
            cursor.execute('DELETE FROM delphi_graph_served WHERE env=%s', [self.env])
            cursor.execute('COMMIT')
        self.connection.close()


class DynamoBackend:
    name = 'dynamodb'

    def __init__(self, endpoint):
        import boto3
        self.db = boto3.resource('dynamodb', endpoint_url=endpoint, region_name='us-east-1',
                                 aws_access_key_id='generated', aws_secret_access_key='generated')
        self.zid = random.randint(900000000, 999999999)
        self.suffix = '-' + uuid.uuid4().hex[:8]
        self.tables = {}

    def table(self, family):
        if family not in self.tables:
            key = FAMILIES[family]['key']
            attributes = dict(key)
            indexes = []
            if family == STATEMENTS:
                attributes.update(zid='S', created_at='S')
                indexes = [dict(IndexName=INDEX, Projection={'ProjectionType': 'ALL'},
                                KeySchema=[dict(AttributeName='zid', KeyType='HASH'), dict(AttributeName='created_at', KeyType='RANGE')])]
            self.tables[family] = self.db.create_table(
                TableName=family + self.suffix, BillingMode='PAY_PER_REQUEST',
                AttributeDefinitions=[dict(AttributeName=k, AttributeType=t) for k, t in attributes.items()],
                KeySchema=[dict(AttributeName=k, KeyType='HASH' if i == 0 else 'RANGE') for i, (k, _) in enumerate(key)],
                **({'GlobalSecondaryIndexes': indexes} if indexes else {}))
            self.tables[family].wait_until_exists()
        return self.tables[family]

    def resource(self, monkeypatch):
        backend = self

        class Resource:
            def Table(self, family):
                return backend.table(family)
        return Resource()

    def write(self, family, rows):
        with self.table(family).batch_writer() as batch:
            for row in rows:
                batch.put_item(Item=row)

    def rewrite(self, family, rows):
        """Replace the family's rows for the conversation, as a publication does."""
        table = self.table(family)
        keys = [k for k, _ in FAMILIES[family]['key']]
        wanted = {tuple(row[k] for k in keys) for row in rows}
        old = table.scan()['Items']
        with table.batch_writer() as batch:
            for item in old:
                if tuple(item[k] for k in keys) not in wanted:
                    batch.delete_item(Key={k: item[k] for k in keys})
            for row in rows:
                batch.put_item(Item=row)

    def write_other(self, family, rows, zid):
        self.write(family, rows)

    def close(self):
        for table in self.tables.values():
            table.delete()


@pytest.fixture(params=['dynamodb', 'postgres'])
def backend(request):
    if request.param == 'postgres':
        url = os.environ.get('POLIS_TEST_POSTGRES_URL')
        if not url:
            pytest.skip('POLIS_TEST_POSTGRES_URL is not set')
        chosen = PostgresBackend(url)
    else:
        endpoint = os.environ.get('DYNAMODB_ENDPOINT')
        if not endpoint:
            pytest.skip('DYNAMODB_ENDPOINT is not set')
        chosen = DynamoBackend(endpoint)
    try:
        yield chosen
    finally:
        chosen.close()


def topic_query(backend, **extra):
    return dict(KeyConditionExpression='conversation_id = :c', ExpressionAttributeValues={':c': str(backend.zid)}, Limit=5, **extra)


def names(page):
    return [item['topic_name'] for item in page['Items']]


def test_publication_between_pages_continues_from_the_cursor_key(backend, monkeypatch):
    backend.write(TOPICS, topic_rows(backend.zid, 't'))
    table = backend.resource(monkeypatch).Table(TOPICS)
    p1 = table.query(**topic_query(backend))
    # Another family: the topic names still resolve to the first publication.
    backend.write(EXTREMITY, [dict(conversation_id=str(backend.zid), comment_id='1')])
    p2 = table.query(**topic_query(backend, ExclusiveStartKey=p1['LastEvaluatedKey']))
    # The same family, rewritten: later pages read the newer rows.
    backend.rewrite(TOPICS, topic_rows(backend.zid, 'u'))
    p3 = table.query(**topic_query(backend, ExclusiveStartKey=p2['LastEvaluatedKey']))
    assert [names(p1), names(p2), names(p3)] == [
        ['t0', 't1', 't2', 't3', 't4'], ['t5', 't6', 't7', 't8', 't9'], ['u10', 'u11', 'u12', 'u13', 'u14']]
    assert p2['LastEvaluatedKey'] == {'conversation_id': str(backend.zid), 'topic_key': 'k09'}


def test_rewrite_without_the_cursor_item_continues_after_its_key(backend, monkeypatch):
    backend.write(TOPICS, topic_rows(backend.zid, 't'))
    table = backend.resource(monkeypatch).Table(TOPICS)
    p1 = table.query(**topic_query(backend))
    assert p1['LastEvaluatedKey'] == {'conversation_id': str(backend.zid), 'topic_key': 'k04'}
    backend.rewrite(TOPICS, topic_rows(backend.zid, 'u', [i for i in range(20) if i not in (4, 5)]))
    p2 = table.query(**topic_query(backend, ExclusiveStartKey=p1['LastEvaluatedKey']))
    assert names(p2) == ['u6', 'u7', 'u8', 'u9', 'u10']
    back = table.query(**topic_query(backend, ScanIndexForward=False, ExclusiveStartKey=p1['LastEvaluatedKey']))
    assert names(back) == ['u3', 'u2', 'u1', 'u0']


def test_scan_spanning_another_conversations_publication(backend, monkeypatch):
    other = backend.zid + 1 if backend.zid < 999999999 else backend.zid - 1
    if backend.name == 'postgres':
        with backend.connection.cursor() as cursor:
            cursor.execute("INSERT INTO conversations(zid,owner,topic) VALUES(%s,%s,'generated') ON CONFLICT(zid) DO NOTHING",
                           [other, backend.zid])
    backend.write(TOPICS, topic_rows(backend.zid, 't', range(6)))
    backend.write_other(TOPICS, topic_rows(other, 'o', range(6)), other)
    table = backend.resource(monkeypatch).Table(TOPICS)
    p1 = table.scan(Limit=3)
    backend.write_other(TOPICS, topic_rows(other, 'p', range(6)), other)
    seen = list(p1['Items'])
    start = p1['LastEvaluatedKey']
    while start:
        page = table.scan(Limit=3, ExclusiveStartKey=start)
        seen += page['Items']
        start = page.get('LastEvaluatedKey')
    # DynamoDB's scan order is its own; both read every key once, and every
    # row of the other conversation read after the publication is the new one.
    keys = sorted((item['conversation_id'], item['topic_key']) for item in seen)
    assert keys == sorted([(str(z), f'k{i:02d}') for z in (backend.zid, other) for i in range(6)])
    first = {(item['conversation_id'], item['topic_key']) for item in p1['Items']}
    assert all(item['topic_name'].startswith('p') for item in seen
               if item['conversation_id'] == str(other) and (item['conversation_id'], item['topic_key']) not in first)


def test_index_query_continues_by_index_position(backend, monkeypatch):
    zid = str(backend.zid)
    backend.write(STATEMENTS, statement_rows(zid, 's', range(10)))
    table = backend.resource(monkeypatch).Table(STATEMENTS)
    read = dict(IndexName=INDEX, KeyConditionExpression='zid = :z', ExpressionAttributeValues={':z': zid}, Limit=3)
    p1 = table.query(**read)
    assert p1['LastEvaluatedKey'] == {'zid_topic_jobid': f'{zid}#topic02#job', 'zid': zid, 'created_at': '2026-01-01T00:00:02Z'}
    backend.rewrite(STATEMENTS, statement_rows(zid, 'n', [i for i in range(10) if i not in (2, 3)]))
    p2 = table.query(**read, ExclusiveStartKey=p1['LastEvaluatedKey'])
    assert [item['text'] for item in p2['Items']] == ['n4', 'n5', 'n6']
