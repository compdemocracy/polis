"""One writer scope per conversation couples every Delphi result family.

The server passes its one configured DELPHI_RESULT_SCOPE to every admission
(pd_writer_admit) and every synchronous edit (pd_result_mutate), and
pd_writer_admit keeps one delphi_job_guards row per (conversation, scope) until
the root job, its attempts and its provider requests are finished. These tests
drive the release's SQL (admission, claim, embeddings put/close, put/seal,
exit, finalize; provider intent, submit and park for a narrative batch) with
the Python writer's spool, and pin what happens while one job holds the scope:

- a second full run (here an embeddings recompute) is refused at once with
  'conflict' and the live run's job id. It is not queued, so nothing waits in
  the queue: it is admitted only by a request that arrives after the live run
  has finalized;
- a narrative admission raises 'scope binding mismatch';
- a collective-statement save raises 'result scope busy or request conflict';
- the embedding set the live run already closed is not served until the whole
  run finalizes;
- a parked narrative batch (provider request submitted, eligible again in
  24 h) holds the same scope: a full run and a statement save both raise
  'scope binding mismatch'.

The tests marked xfail(strict=True) state the ruled target, publication per
family group (pipeline, narrative per report, statements), with the arguments
callers pass today. They fail now and must be unmarked when the scopes split
(if the split changes the admission arguments, change the calls with it). The
control shows the SQL already keeps two scope values apart: the coupling is
the one scope value every caller passes.

Generated data only; no votes and no provider calls (the provider request is
a recorded row). Needs POLIS_TEST_POSTGRES_URL (a superuser on a migrated
database) and skips without it. Each test uses its own result environment and
conversation.
"""
import hashlib
import json
import os
import random
import threading
import time
import uuid

import pytest

from polismath.delphi_storage.codec import encode_item, item_from_python
from polismath.delphi_storage.writer import WriterResource

SCOPE = 'delphi'
CODE = 'd6f9ed6093e46b3c07db98f3c644bbbd9c4e87cd'
MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
DIMS = 384
ADMIT = 'text,integer,text,text,text,text,uuid,uuid,text,text,jsonb,text'
TOKEN = 'text,uuid,uuid,uuid,bigint'
RUN = {'model': 'generated'}
RECOMPUTE = {'model': 'generated', 'recompute': 'embeddings'}
# How long the live run's remaining stages take here (in production, UMAP,
# EVoC and the topic-name LLM calls after the embeddings are closed).
HOLD_SECONDS = 3.0
POLL_SECONDS = 0.05

TARGET = pytest.mark.xfail(strict=True, reason='today one writer scope per conversation holds every family; '
                           'passes when publication is per family group (pipeline, narrative per report, statements)')


class Scope:
    """One result environment and conversation, driven through the release's SQL."""

    def __init__(self, url, env, zid, report, directory, monkeypatch):
        self.url, self.env, self.zid, self.report = url, env, zid, report
        self.directory, self.monkeypatch = directory, monkeypatch
        self.connection = self.connect()

    def connect(self):
        import psycopg2
        connection = psycopg2.connect(self.url)
        connection.autocommit = True
        return connection

    def sql(self, query, args=(), connection=None):
        with (connection or self.connection).cursor() as cursor:
            cursor.execute(query, args)
            return cursor.fetchall() if cursor.description else []

    def call(self, name, casts, args, connection=None):
        placeholders = ','.join('%s::' + cast for cast in casts.split(','))
        return self.sql(f'SELECT public.{name}({placeholders})', args, connection)[0][0]

    def reply(self, name, casts, args):
        """The function's reply, or the error it raised."""
        import psycopg2
        try:
            return self.call(name, casts, args)
        except psycopg2.Error as error:
            return {'error': error.diag.message_primary}

    def admit(self, stage, report=None, payload=RUN, scope=SCOPE):
        """An admission as the server makes it: a fresh key, the payload's sha."""
        job, run, key = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        sha = hashlib.sha256(json.dumps([stage, report, payload], sort_keys=True).encode()).hexdigest()
        reply = self.reply('pd_writer_admit', ADMIT, [self.env, self.zid, scope, 'generated-api', key, sha, job, run,
                                                      stage, report, json.dumps(payload), CODE])
        return reply, job, run

    def save_statement(self, scope=SCOPE):
        item = {'zid_topic_jobid': f'{self.zid}#g1-000#{uuid.uuid4()}', 'zid': str(self.zid),
                'created_at': '2026-01-03T00:00:00Z', 'text': 'generated statement'}
        tagged = json.loads(encode_item('Delphi_CollectiveStatement', item_from_python(item)))
        return self.reply('pd_result_mutate', 'text,text,text,uuid,text,text,jsonb',
                          [self.env, scope, 'generated-http-owner', str(uuid.uuid4()), 'Delphi_CollectiveStatement', 'put',
                           json.dumps(tagged)])

    def claim(self, job):
        owner, attempt = str(uuid.uuid4()), str(uuid.uuid4())
        claim = self.call('pq_claim', 'text,smallint,uuid,uuid,integer,text', [self.env, 1, owner, attempt, 900, 'delphi'])
        assert claim['job_id'] == job, claim
        return [self.env, job, owner, attempt, int(claim['lease_epoch'])]

    def embed(self, token, tids):
        """What polis-jobs does with the run's embeddings spool: put, then close the set."""
        shas = [hashlib.sha256(f'comment {tid}'.encode()).digest() for tid in tids]
        vectors = [[((tid + d) % 7) / 7 for d in range(DIMS)] for tid in tids]
        self.call('pd_embedding_put', TOKEN + ',text,integer[],bytea[],real[]', token + [MODEL, tids, shas, vectors])
        return self.call('pd_embedding_close', TOKEN + ',text', token + [MODEL])

    def spool(self, token, run):
        """The Python writer's spool for a full run: every compute family, reset."""
        env, job, _, attempt, epoch = token
        work = self.directory / attempt
        work.mkdir()
        frame = dict(schema='polis-jobs.frame/1', env=env, zid=self.zid, job_id=job, run_id=run, attempt_id=attempt,
                     lease_epoch=str(epoch), config={'result_backend': 'postgres', 'result_scope': SCOPE},
                     writer_base=self.call('pd_writer_base', 'text,uuid', [env, job]))
        (work / 'frame.json').write_text(json.dumps(frame))
        for name, value in dict(DELPHI_RESULT_BACKEND='postgres', DELPHI_OUTPUT_MANIFEST=str(work / 'output-manifest.json'),
                                DELPHI_FRAME=str(work / 'frame.json'), DELPHI_JOB_ID=job, DELPHI_RUN_ID=run,
                                DELPHI_ATTEMPT_ID=attempt).items():
            self.monkeypatch.setenv(name, value)
        writer = WriterResource()
        writer.reset()
        return {family: (work / d['file']).read_bytes().decode('utf-8') for family, d in sorted(writer.spool().items())}

    def finish(self, token, wires, connection=None):
        """Put, seal, confirm the exit and finalize, which publishes the run."""
        for family, wire in wires.items():
            self.call('pd_result_put_family', TOKEN + ',text,text', token + [family, wire], connection)
        seal = self.call('pd_result_seal', TOKEN, token, connection)
        exit_reply = self.call('pq_end_attempt', TOKEN + ',text,text,boolean', token + ['confirm_exit', None, True], connection)
        assert exit_reply['outcome'] == 'exit_confirmed', exit_reply
        manifest = json.dumps(dict(schema='polis-jobs.output-manifest/2', job_id=token[1], attempt_id=token[3],
                                   stage='delphi_full_pipeline', phase='run', outcome='succeeded', inputs={}, outputs=[],
                                   models={}, cost={}, results=seal), sort_keys=True)
        self.sql("INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line) VALUES(%s,%s,0,'manifest',%s)",
                 [token[0], token[3], manifest], connection)
        done = self.call('pq_finalize', TOKEN + ',text,text',
                         token + ['file:///generated/output-manifest.json', hashlib.sha256(manifest.encode()).hexdigest()],
                         connection)
        assert done['outcome'] == 'succeeded', done

    def live_run(self, tids=(1, 2, 3)):
        """A full run admitted and claimed, its embedding set closed, its spool written, not finalized."""
        reply, job, run = self.admit('delphi_full_pipeline')
        assert reply['outcome'] == 'enqueued', reply
        token = self.claim(job)
        receipt = self.embed(token, list(tids))
        return token, receipt, self.spool(token, run)

    def park_narrative(self):
        """A narrative batch as polis-jobs leaves it: provider request submitted, parked for 24 h."""
        reply, job, _ = self.admit('delphi_narrative', self.report)
        assert reply['outcome'] == 'enqueued', reply
        token = self.claim(job)
        request = str(uuid.uuid4())
        self.call('pd_provider_intent', TOKEN + ',uuid,text,bytea', token + [request, 'anthropic', os.urandom(32)])
        self.call('pd_provider_update', TOKEN + ',uuid,text,text', token + [request, 'submitted', f'msgbatch_generated_{uuid.uuid4().hex}'])
        parked = self.sql("""SELECT public.pq_park(%s,%s::uuid,%s::uuid,%s::uuid,%s::bigint,'provider_batch_pending',true,
                             clock_timestamp()+interval '24 hours')""", token)[0][0]
        assert parked['outcome'] == 'parked', parked
        return job

    def served_embeddings(self, connection=None):
        return self.call('pd_embedding_served', 'text,integer,text,text', [self.env, self.zid, SCOPE, MODEL], connection)

    def guards(self):
        return self.sql("""SELECT g.root_job_id::text,q.state FROM delphi_job_guards g
                           JOIN polis_queue_jobs q ON q.env=g.env AND q.job_id=g.root_job_id
                           WHERE g.env=%s AND g.zid=%s ORDER BY 1""", [self.env, self.zid])

    def jobs(self):
        return self.sql('SELECT count(*)::int FROM polis_queue_jobs WHERE env=%s', [self.env])[0][0]


@pytest.fixture
def scope(tmp_path, monkeypatch):
    url = os.environ.get('POLIS_TEST_POSTGRES_URL')
    if not url:
        pytest.skip('POLIS_TEST_POSTGRES_URL is not set')
    zid = random.randint(900000000, 999999999)
    report = 'r' + uuid.uuid4().hex[:20]
    side = Scope(url, f'writer-scope-{uuid.uuid4().hex[:12]}', zid, report, tmp_path, monkeypatch)
    side.sql("INSERT INTO users(uid,hname,email) VALUES(%s,'generated owner',%s) ON CONFLICT(uid) DO NOTHING",
             [zid, f'generated-{zid}@example.invalid'])
    side.sql("INSERT INTO conversations(zid,owner,topic) VALUES(%s,%s,'generated') ON CONFLICT(zid) DO NOTHING", [zid, zid])
    side.sql('INSERT INTO reports(report_id,zid) VALUES(%s,%s)', [report, zid])
    yield side
    with side.connection.cursor() as cursor:
        # Served pointers only; the immutable history stays, scoped to this test's env.
        cursor.execute('BEGIN')
        cursor.execute('SET LOCAL session_replication_role = replica')
        cursor.execute('DELETE FROM delphi_graph_served WHERE env=%s', [side.env])
        cursor.execute('COMMIT')
    side.connection.close()


def test_today_a_live_full_run_holds_the_scope_for_every_family(scope):
    earlier, _, wires = scope.live_run(tids=(1, 2))
    scope.finish(earlier, wires)
    token, receipt, wires = scope.live_run(tids=(1, 2, 3))
    jobs = scope.jobs()

    recompute = scope.admit('delphi_full_pipeline', payload=RECOMPUTE)[0]
    narrative = scope.admit('delphi_narrative', scope.report)[0]
    statement = scope.save_statement()
    served = scope.served_embeddings()
    print(json.dumps({'live_job': token[1], 'recompute': recompute, 'narrative': narrative, 'statement': statement,
                      'closed_set_rows': receipt['row_count'], 'served_set_rows': served['row_count']}, default=str), flush=True)

    assert (recompute['outcome'], recompute['job_id'], recompute['state']) == ('conflict', token[1], 'running')
    assert narrative == {'error': 'scope binding mismatch'}
    assert statement == {'error': 'result scope busy or request conflict'}
    assert scope.jobs() == jobs  # none of the three was queued
    assert scope.guards() == [(token[1], 'running')]
    # The live run closed its set of 3; the served set is still the earlier run's 2.
    assert (receipt['row_count'], served['row_count'], served['batch_id']) == (3, 2, earlier[3])

    scope.finish(token, wires)
    assert scope.served_embeddings()['row_count'] == 3
    assert scope.admit('delphi_full_pipeline', payload=RECOMPUTE)[0]['outcome'] == 'enqueued'


def test_today_a_recompute_is_refused_until_the_live_run_finalizes(scope):
    token, _, wires = scope.live_run()
    finished = {}

    def remaining_stages():
        connection = scope.connect()
        try:
            time.sleep(HOLD_SECONDS)
            # Taken before the finalize: an admission right after its commit can
            # return before this thread records the time it finished.
            finished['from'] = time.monotonic()
            scope.finish(token, wires, connection)
            finished['at'] = time.monotonic()
        except Exception as error:  # reported by the main thread
            finished['error'] = repr(error)
        finally:
            connection.close()

    started = time.monotonic()
    thread = threading.Thread(target=remaining_stages)
    thread.start()
    refused, latencies, admitted = 0, [], None
    try:
        while admitted is None:
            asked = time.monotonic()
            reply = scope.admit('delphi_full_pipeline', payload=RECOMPUTE)[0]
            latencies.append(time.monotonic() - asked)
            if reply.get('outcome') == 'enqueued':
                admitted = time.monotonic()
                break
            assert (reply.get('outcome'), reply.get('job_id')) == ('conflict', token[1]), reply
            refused += 1
            assert 'error' not in finished, finished
            assert time.monotonic() - started < HOLD_SECONDS + 30, 'the recompute was never admitted'
            time.sleep(POLL_SECONDS)
    finally:
        thread.join()
    print(json.dumps({'hold_seconds': HOLD_SECONDS, 'refused': refused, 'admitted_after_seconds': round(admitted - started, 3),
                      'admitted_after_finalize_seconds': round(admitted - finished['at'], 3),
                      'slowest_refusal_ms': round(max(latencies[:-1]) * 1000, 1),
                      'median_refusal_ms': round(sorted(latencies[:-1])[len(latencies[:-1]) // 2] * 1000, 1)}), flush=True)

    assert 'error' not in finished, finished
    # Refused for the whole of the live run's remaining stages; admitted only by
    # the first request after it finalized, never queued behind it.
    assert admitted >= finished['from'] and admitted - started >= HOLD_SECONDS
    assert refused >= 10
    assert max(latencies[:-1]) < 2.0  # each refusal answers at once; nothing waits on a lock


def test_today_a_parked_narrative_batch_holds_the_scope(scope):
    narrative = scope.park_narrative()
    held_for = scope.sql('SELECT extract(epoch FROM eligible_at-clock_timestamp())::int FROM polis_queue_jobs WHERE env=%s AND job_id=%s',
                         [scope.env, narrative])[0][0]
    jobs = scope.jobs()

    recompute = scope.admit('delphi_full_pipeline', payload=RECOMPUTE)[0]
    recompute_for_report = scope.admit('delphi_full_pipeline', scope.report, payload=RECOMPUTE)[0]
    statement = scope.save_statement()
    print(json.dumps({'parked_job': narrative, 'parked_for_seconds': held_for, 'recompute': recompute,
                      'recompute_for_report': recompute_for_report, 'statement': statement}), flush=True)

    assert recompute == {'error': 'scope binding mismatch'}
    assert recompute_for_report == {'error': 'scope binding mismatch'}
    assert statement == {'error': 'scope binding mismatch'}
    assert scope.jobs() == jobs
    # Each admission ran pd_release_scope first; the parked job and its submitted
    # provider request keep the delphi_job_guards row.
    assert scope.guards() == [(narrative, 'parked')]
    assert 86000 <= held_for <= 86400


def test_today_separate_scope_values_are_already_independent(scope):
    token, _, _ = scope.live_run()
    narrative = scope.admit('delphi_narrative', scope.report, scope=f'narrative:{scope.report}')[0]
    statement = scope.save_statement(scope='statements')

    assert narrative['outcome'] == 'enqueued', narrative
    assert statement['outcome'] == 'succeeded', statement
    assert len(scope.guards()) == 2 and (token[1], 'running') in scope.guards()


@TARGET
def test_target_a_narrative_is_admitted_while_a_full_run_is_live(scope):
    scope.live_run()
    assert scope.admit('delphi_narrative', scope.report)[0].get('outcome') == 'enqueued'


@TARGET
def test_target_a_statement_is_saved_while_a_full_run_is_live(scope):
    scope.live_run()
    assert scope.save_statement().get('outcome') == 'succeeded'


@TARGET
def test_target_an_embeddings_recompute_is_admitted_while_a_narrative_batch_is_parked(scope):
    scope.park_narrative()
    assert scope.admit('delphi_full_pipeline', payload=RECOMPUTE)[0].get('outcome') == 'enqueued'


@TARGET
def test_target_a_statement_is_saved_while_a_narrative_batch_is_parked(scope):
    scope.park_narrative()
    assert scope.save_statement().get('outcome') == 'succeeded'


@TARGET
def test_target_a_closed_embedding_set_is_served_before_the_run_finishes(scope):
    _, receipt, _ = scope.live_run()
    assert (scope.served_embeddings() or {}).get('row_count') == receipt['row_count']
