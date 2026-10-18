"""A writer batch holds only the families its run produced, and readers serve
the same bytes as when every batch carried a full copy of the publication.

The same sequence (full run, narrative batch, collective-statement save, second
full run) runs twice through the real writer scratch and the release's SQL
(admission, claim, base, put/seal, exit, finalize; the statement through
pd_result_mutate): once as the writer emits now, and once with every family
marked produced, which is exactly what the writer emitted before (a full copy
of the scratch). After every step each reader's output is compared.

Generated data only; no votes and no provider calls. Needs
POLIS_TEST_POSTGRES_URL (a superuser on a migrated database) and skips without
it. Each run uses its own result environments and conversation.
"""
import hashlib
import json
import os
import random
import uuid
from decimal import Decimal

import pytest

from polismath.delphi_storage.codec import FAMILIES, encode_item, item_from_python
from polismath.delphi_storage.postgres import RESULT_FAMILIES
from polismath.delphi_storage.resource import PostgresResource
from polismath.delphi_storage.writer import WriterResource

SCOPE = 'delphi'
CODE = 'd6f9ed6093e46b3c07db98f3c644bbbd9c4e87cd'
PRESERVED = {'Delphi_NarrativeReports', 'report_narrative_store', 'Delphi_CollectiveStatement', 'Delphi_TopicAgendaSelections'}
COMPUTE = sorted(RESULT_FAMILIES - PRESERVED)
# Families the second full run leaves empty: their first-run rows must not reappear.
EMPTIED = {'Delphi_CommentExtremity', 'Delphi_KMeansClusters'}


def compute_rows(zid, generation, count, emptied=()):
    special = {'zid': str(zid), 'conversation_id': str(zid), 'zid_tick': f'{zid}:{generation}',
               'zid_tick_gid': f'{zid}:{generation}:0'}
    rows = {}
    for family in COMPUTE:
        rows[family] = [] if family in emptied else [
            {**{k: (i if tag == 'N' else special.get(k, f'g{generation}-{i:03d}')) for k, tag in FAMILIES[family]['key']},
             'value': Decimal(f'{generation}.{i}00000000000000000001'), 'label': f'run {generation} row {i}',
             'names': {'a', f'g{generation}'}, 'nested': {'list': [i, 'x', True], 'map': {'k': Decimal('1.5')}},
             'blob': bytes([generation, i])}
            for i in range(count)]
    return rows


class Conversation:
    """One result environment driven through the release's writer functions."""

    def __init__(self, connection, env, zid, report, directory, monkeypatch, copy_forward):
        self.connection, self.env, self.zid, self.report = connection, env, zid, report
        self.directory, self.monkeypatch, self.copy_forward = directory, monkeypatch, copy_forward
        self.batches = []  # (step, batch_id)

    def sql(self, query, args=()):
        with self.connection.cursor() as cursor:
            cursor.execute(query, args)
            return cursor.fetchall() if cursor.description else []

    def call(self, name, casts, args):
        placeholders = ','.join('%s::' + cast for cast in casts.split(','))
        return self.sql(f'SELECT public.{name}({placeholders})', args)[0][0]

    def writer_run(self, step, stage, produce):
        job, run = str(uuid.uuid4()), str(uuid.uuid4())
        key = f'{step}-{job}'
        reply = self.call('pd_writer_admit', 'text,integer,text,text,text,text,uuid,uuid,text,text,jsonb,text',
                          [self.env, self.zid, SCOPE, 'generated-api', key, hashlib.sha256(key.encode()).hexdigest(), job, run,
                           stage, self.report if stage == 'delphi_narrative' else None, json.dumps({'model': 'generated'}), CODE])
        assert reply['outcome'] == 'enqueued', reply
        owner, attempt = str(uuid.uuid4()), str(uuid.uuid4())
        claim = self.call('pq_claim', 'text,smallint,uuid,uuid,integer,text', [self.env, 1, owner, attempt, 60, 'delphi'])
        assert claim['job_id'] == job, claim
        epoch = int(claim['lease_epoch'])
        token = [self.env, job, owner, attempt, epoch]
        base = self.call('pd_writer_base', 'text,uuid', [self.env, job])
        work = self.directory / attempt
        work.mkdir()
        frame = dict(schema='polis-jobs.frame/1', env=self.env, zid=self.zid, job_id=job, run_id=run, attempt_id=attempt,
                     lease_epoch=str(epoch), config={'result_backend': 'postgres', 'result_scope': SCOPE}, writer_base=base)
        (work / 'frame.json').write_text(json.dumps(frame))
        for name, value in dict(DELPHI_RESULT_BACKEND='postgres', DELPHI_OUTPUT_MANIFEST=str(work / 'output-manifest.json'),
                                DELPHI_FRAME=str(work / 'frame.json'), DELPHI_JOB_ID=job, DELPHI_RUN_ID=run,
                                DELPHI_ATTEMPT_ID=attempt).items():
            self.monkeypatch.setenv(name, value)
        writer = WriterResource()
        produce(writer)
        if self.copy_forward:
            with writer.connection:
                writer.connection.executemany('INSERT OR IGNORE INTO dirty VALUES(?)', [(f,) for f in RESULT_FAMILIES])
        for family, description in sorted(writer.spool().items()):
            wire = (work / description['file']).read_bytes().decode('utf-8')
            put = self.call('pd_result_put_family', 'text,uuid,uuid,uuid,bigint,text,text', token + [family, wire])
            assert put['sha256'] == description['sha256']
        seal = self.call('pd_result_seal', 'text,uuid,uuid,uuid,bigint', token)
        exit_reply = self.call('pq_end_attempt', 'text,uuid,uuid,uuid,bigint,text,text,boolean', token + ['confirm_exit', None, True])
        assert exit_reply['outcome'] == 'exit_confirmed', exit_reply
        manifest = json.dumps(dict(schema='polis-jobs.output-manifest/2', job_id=job, attempt_id=attempt, stage=stage,
                                   phase='recheck' if stage == 'delphi_narrative' else 'run', outcome='succeeded',
                                   inputs={}, outputs=[], models={}, cost={}, results=seal), sort_keys=True)
        self.sql("INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line) VALUES(%s,%s,0,'manifest',%s)",
                 [self.env, attempt, manifest])
        done = self.call('pq_finalize', 'text,uuid,uuid,uuid,bigint,text,text',
                         token + ['file:///generated/output-manifest.json', hashlib.sha256(manifest.encode()).hexdigest()])
        assert done['outcome'] == 'succeeded', done
        self.batches.append((step, attempt))

    def statement_save(self, step, item):
        tagged = json.loads(encode_item('Delphi_CollectiveStatement', item_from_python(item)))
        reply = self.call('pd_result_mutate', 'text,text,text,uuid,text,text,jsonb',
                          [self.env, SCOPE, 'generated-http-owner', str(uuid.uuid4()), 'Delphi_CollectiveStatement', 'put',
                           json.dumps(tagged)])
        assert reply['outcome'] == 'succeeded', reply
        self.batches.append((step, str(self.sql('SELECT batch_id FROM delphi_result_batches WHERE env=%s AND job_id=%s',
                                                [self.env, reply['job_id']])[0][0])))

    def batch_families(self, batch):
        return {f for (f,) in self.sql('SELECT family FROM delphi_result_families WHERE env=%s AND batch_id=%s', [self.env, batch])}

    def producer(self, family):
        rows = self.sql('SELECT batch_id::text FROM pd_result_family_batches(%s,ARRAY[%s]::integer[],%s,%s)',
                        [self.env, self.zid, SCOPE, family])
        return rows[0][0] if rows else None

    def stored(self):
        return self.sql("""SELECT count(DISTINCT f.batch_id)::int,count(*)::int,sum(f.row_count)::int,sum(octet_length(f.codec_wire))::int
                           FROM delphi_result_families f WHERE f.env=%s""", [self.env])[0]

    def served(self):
        """Every reader's output, as text where the database produces it."""
        bundle = self.sql('SELECT pd_result_served_bundle(%s,%s,%s)::text', [self.env, self.zid, SCOPE])[0][0]
        families = {f: self.sql('SELECT pd_result_served(%s,%s,%s,%s)::text', [self.env, self.zid, SCOPE, f])[0][0]
                    for f in sorted(RESULT_FAMILIES)}
        pages = {f: self.sql("""SELECT zid,scope_key,generation,item_key::text,item::text,sort_n::text,sort_t,hash_t
                    FROM pd_result_page(%s,ARRAY[%s]::integer[],%s,%s,NULL,NULL,NULL,NULL,false,NULL)""",
                             [self.env, self.zid, SCOPE, f]) for f in sorted(RESULT_FAMILIES)}
        current = self.sql("""SELECT zid,scope_key,generation,family,item_key::text,item::text FROM delphi_result_current_rows
                              WHERE env=%s AND zid=%s ORDER BY family,item_key::text""", [self.env, self.zid])
        self.monkeypatch.setenv('DELPHI_RESULT_ENV', self.env)
        self.monkeypatch.setenv('DELPHI_RESULT_SCOPE', SCOPE)
        adapter = PostgresResource(self.connection)
        scans = {f: adapter.Table(f).scan()['Items'] for f in sorted(RESULT_FAMILIES)}
        return dict(bundle=bundle, families=families, pages=pages, current=current, scans=scans)


@pytest.fixture
def pair(tmp_path, monkeypatch):
    url = os.environ.get('POLIS_TEST_POSTGRES_URL')
    if not url:
        pytest.skip('POLIS_TEST_POSTGRES_URL is not set')
    import psycopg2
    connection = psycopg2.connect(url)
    connection.autocommit = True
    zid = random.randint(900000000, 999999999)
    report = 'r' + uuid.uuid4().hex[:20]
    suffix = uuid.uuid4().hex[:12]
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO users(uid,hname,email) VALUES(%s,'generated owner',%s) ON CONFLICT(uid) DO NOTHING",
                       [zid, f'generated-{zid}@example.invalid'])
        cursor.execute("INSERT INTO conversations(zid,owner,topic) VALUES(%s,%s,'generated') ON CONFLICT(zid) DO NOTHING", [zid, zid])
        cursor.execute('INSERT INTO reports(report_id,zid) VALUES(%s,%s)', [report, zid])
    sides = {}
    for name, copy_forward in (('copy', True), ('own', False)):
        (tmp_path / name).mkdir()
        sides[name] = Conversation(connection, f'writer-batches-{name}-{suffix}', zid, report, tmp_path / name, monkeypatch, copy_forward)
    yield sides
    with connection.cursor() as cursor:
        # Served pointers only; the immutable history stays, scoped to this test's envs.
        cursor.execute('BEGIN')
        cursor.execute('SET LOCAL session_replication_role = replica')
        cursor.execute('DELETE FROM delphi_graph_served WHERE env=ANY(%s)', [[side.env for side in sides.values()]])
        cursor.execute('COMMIT')
    connection.close()


def test_batches_hold_only_their_own_families_and_readers_serve_the_same_bytes(pair):
    copy, own = pair['copy'], pair['own']
    zid, report = own.zid, own.report

    def full_run(generation, count, emptied=()):
        def produce(writer):
            writer.reset()
            for family, rows in compute_rows(zid, generation, count, emptied).items():
                with writer.Table(family).batch_writer() as batch:
                    for row in rows:
                        batch.put_item(Item=row)
        return produce

    def narrative(writer):
        for section in ('topics', 'uncertainty'):
            writer.Table('Delphi_NarrativeReports').put_item(Item={
                'rid_section_model': f'{report}#{section}#generated-model', 'timestamp': '2026-01-02T00:00:00Z',
                'report_id': report, 'job_id': 'generated-narrative-job', 'report_data': json.dumps({'section': section})})

    statement = {'zid_topic_jobid': f'{zid}#g1-000#generated', 'zid': str(zid), 'created_at': '2026-01-03T00:00:00Z',
                 'text': 'generated statement'}
    steps = [
        ('full run', lambda side: side.writer_run('full run', 'delphi_full_pipeline', full_run(1, 40))),
        ('narrative batch', lambda side: side.writer_run('narrative batch', 'delphi_narrative', narrative)),
        ('statement save', lambda side: side.statement_save('statement save', statement)),
        ('second full run', lambda side: side.writer_run('second full run', 'delphi_full_pipeline', full_run(2, 25, EMPTIED))),
    ]
    stored = {}
    for step, act in steps:
        for side in (copy, own):
            act(side)
        before, after = copy.served(), own.served()
        for reader in before:
            assert after[reader] == before[reader], f'{step}: {reader} differs'
        stored[step] = (copy.stored(), own.stored())
        print(json.dumps({'step': step, 'served_families': sorted(json.loads(after['bundle'])['families']),
                          'copy_forward': dict(zip(('batches', 'families', 'rows', 'bytes'), stored[step][0])),
                          'own_families': dict(zip(('batches', 'families', 'rows', 'bytes'), stored[step][1]))}), flush=True)

    # The emptied families stay empty: no first-run row reappears through an ancestor.
    served = own.served()
    for family in EMPTIED:
        assert served['scans'][family] == [] and served['pages'][family] == []
    assert len(served['scans']['Delphi_UMAPGraph']) == 25

    # Each batch holds exactly what its run produced.
    held = {step: own.batch_families(batch) for step, batch in own.batches}
    assert held == {'full run': set(COMPUTE), 'narrative batch': {'Delphi_NarrativeReports'},
                    'statement save': {'Delphi_CollectiveStatement'}, 'second full run': set(COMPUTE)}
    assert all(copy.batch_families(batch) == ({'Delphi_CollectiveStatement'} if step == 'statement save' else RESULT_FAMILIES)
               for step, batch in copy.batches)
    # A narrative batch carries no topic or cluster family.
    assert not held['narrative batch'] & {f for f in COMPUTE if 'Cluster' in f or 'Topic' in f or 'UMAP' in f}

    # Each family is served from the batch that produced it, not the last publisher.
    batch = dict(own.batches)
    for family in COMPUTE:
        assert own.producer(family) == batch['second full run']
    assert own.producer('Delphi_NarrativeReports') == batch['narrative batch']
    assert own.producer('Delphi_CollectiveStatement') == batch['statement save']
    # Before, the second full run re-copied the saved statement (and the narratives).
    assert copy.producer('Delphi_CollectiveStatement') == dict(copy.batches)['second full run']

    # Rows stored: the copies of inherited families are gone.
    (copy_batches, copy_families, copy_rows, copy_bytes), (own_batches, own_families, own_rows, own_bytes) = stored['second full run']
    assert copy_batches == own_batches == 4
    assert (copy_families, own_families) == (18 * 3 + 1, 14 * 2 + 1 + 1)
    assert own_rows < copy_rows and own_bytes < copy_bytes
