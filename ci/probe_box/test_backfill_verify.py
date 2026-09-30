"""P-070 backfill verification job: closed run-spec, SQL binding, reader, switch condition and receipt refusals.

Dependency-free except the opt-in PostgreSQL case at the end (psycopg2 and a
disposable PG17 named by POLIS_BACKFILL_VERIFY_PG). Receipts are built with
the verifier's own fixture helpers; the image tests (ci/private_cert) cover
recipes, admission and the isolated closures.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'private_cert/images'))
from contracts import BoundaryError, decode_job, refuse_placeholder, validate_job
from receipt import decode_receipt, receipt_limit, receipt_passed, sha
import backfill_verify as bv
from backfill_verify import (BLOCKING, CONTROLS, TEMPLATE_RUN_SPEC, encoded, expected_verdict, validate_projection,
                             validate_receipt, validate_run_spec)
import backfill_verify_queries as q
import backfill_verify_reader as reader
import backfill_verify_producer as producer
import backfill_verify_verifier as verifier

SQL = (HERE / 'backfill_verification.sql').read_bytes()
SNAPSHOT = verifier.SNAPSHOT_MS
CUTOFF = verifier.CUTOFF_MS
ready = verifier.fixture_readiness


def job(**spec):
    base = {'cutoff_ms': CUTOFF, 'readiness': ready()}
    return validate_job(dict(schema='polis-probe-job/2', kind='backfill-verify', run_id='c' * 32, max_seconds=7200,
                             run_spec=dict(TEMPLATE_RUN_SPEC, **dict(base, **spec)),
                             reader={'image': 'localhost/polis-verify-reader@sha256:' + '1' * 64, 'args': ['read']},
                             producer={'image': 'localhost/polis-verify-producer@sha256:' + '2' * 64, 'args': ['produce']},
                             verifier={'image': 'localhost/polis-verify-verifier@sha256:' + '3' * 64, 'args': ['verify']}))


def export(results=None, status='COMPLETE', j=None):
    j = job() if j is None else j
    p = verifier.fixture_projection(verifier.fixture_results() if results is None else results, status)
    return verifier.export(p, producer.produce(p, j['run_spec']), j, '1' * 40), j


class Registry(unittest.TestCase):
    def setUp(self):
        self.registry = json.loads((HERE / 'jobs.json').read_bytes())['jobs']
        self.entry = self.registry['math-backfill-verify-v1']

    def test_entry_is_a_template_bound_to_the_reviewed_sql(self):
        self.assertEqual(validate_job(self.entry), self.entry)
        self.assertEqual((self.entry['schema'], self.entry['kind'], self.entry['max_seconds']),
                         ('polis-probe-job/2', 'backfill-verify', 7200))
        self.assertEqual(self.entry['run_spec'], TEMPLATE_RUN_SPEC)
        self.assertEqual(self.entry['run_spec']['verification_sql_sha256'], q.SQL_SHA256)
        for role, action in (('reader', 'read'), ('producer', 'produce'), ('verifier', 'verify')):
            self.assertEqual(self.entry[role]['args'], [action])
            self.assertRegex(self.entry[role]['image'], '^localhost/polis-verify-' + role + '@sha256:')

    def test_template_and_unpinned_images_are_never_launched(self):
        with self.assertRaisesRegex(BoundaryError, 'PLACEHOLDER'):
            refuse_placeholder(validate_job(self.entry))
        pinned = {r: dict(self.entry[r], image=self.entry[r]['image'][:-64] + str(i) * 64)
                  for i, r in enumerate(('reader', 'producer', 'verifier'), 1)}
        with self.assertRaisesRegex(BoundaryError, 'PLACEHOLDER_RUN_SPEC'):
            refuse_placeholder(validate_job(dict(self.entry, **pinned)))
        refuse_placeholder(validate_job(dict(self.entry, **pinned, run_spec=dict(self.entry['run_spec'], cutoff_ms=CUTOFF))))
        for name in ('sampled-paired-battery-v1', 'roles-census-v1'):
            refuse_placeholder(validate_job(self.registry[name]))

    def test_job_shape_is_closed(self):
        j = job()
        self.assertEqual(decode_job(encoded(j)), j)
        for bad in (dict(j, run_spec=None), {k: v for k, v in j.items() if k != 'run_spec'},
                    dict(j, triage_selection={}), dict(j, reader=dict(j['reader'], args=['extract'])),
                    dict(j, verifier=dict(j['reader'], args=['verify']))):
            with self.assertRaises(BoundaryError):
                validate_job(bad)
        self.assertEqual(receipt_limit(j), 131072)


class RunSpec(unittest.TestCase):
    def test_labels_ruling_and_sql_digest_are_fixed(self):
        spec = dict(TEMPLATE_RUN_SPEC, cutoff_ms=CUTOFF, readiness=ready())
        self.assertEqual(validate_run_spec(spec), spec)
        self.assertEqual(validate_run_spec(dict(spec, readiness=None))['readiness'], None)
        for key, value, code in (('source_env', 'python', 'VERIFY_ENV'), ('target_env', 'prod', 'VERIFY_ENV'),
                                 ('target_env', 'shadow', 'VERIFY_ENV'),
                                 ('source_ahead_ruling', 'accept_input', 'VERIFY_RULING'),
                                 ('verification_sql_sha256', '0' * 64, 'VERIFY_SQL_DIGEST'),
                                 ('cutoff_ms', 1, 'VERIFY_RUN_SPEC'), ('cutoff_ms', float(CUTOFF), 'VERIFY_RUN_SPEC'),
                                 ('cutoff_ms', True, 'VERIFY_RUN_SPEC'),
                                 ('max_cutoff_age_seconds', 299, 'VERIFY_RUN_SPEC'),
                                 ('max_cutoff_age_seconds', 86401, 'VERIFY_RUN_SPEC'),
                                 ('max_readiness_age_seconds', 59, 'VERIFY_RUN_SPEC'),
                                 ('max_readiness_age_seconds', 3601, 'VERIFY_RUN_SPEC'),
                                 ('max_discovery_gap_seconds', 9, 'VERIFY_DISCOVERY_GAP'),
                                 # Option (a) of review [1459] is refused by name, not configurable.
                                 ('max_discovery_gap_seconds', 121, 'VERIFY_DISCOVERY_GAP'),
                                 ('max_discovery_gap_seconds', 600, 'VERIFY_DISCOVERY_GAP'),
                                 ('max_discovery_gap_seconds', 120.0, 'VERIFY_RUN_SPEC'),
                                 ('readiness', {}, 'VERIFY_SCHEMA'),
                                 ('readiness', dict(ready(), schema='polis-backfill-readiness/1'), 'VERIFY_READINESS'),
                                 ('readiness', {k: v for k, v in ready().items() if k != 'seq'}, 'VERIFY_SCHEMA'),
                                 ('readiness', ready(seq=-1), 'VERIFY_COUNT'),
                                 ('readiness', ready(queue={'parked': True}), 'VERIFY_COUNT'),
                                 ('readiness', ready(holder={'role': 'leader'}), 'VERIFY_READINESS'),
                                 ('readiness', ready(holder={'run': 'not-a-run-id'}), 'VERIFY_DIGEST'),
                                 ('readiness', ready(sweep={'status': 'DONE'}), 'VERIFY_READINESS'),
                                 ('readiness', ready(discovery={'successes': -1}), 'VERIFY_COUNT'),
                                 ('readiness', ready(drain={'drained_ms': 1.5e12}), 'VERIFY_CLOCK'),
                                 ('readiness', dict(ready(), note='free text'), 'VERIFY_SCHEMA'),
                                 ('readiness', ready(holder=dict(ready()['holder'], zid=1)), 'VERIFY_SCHEMA')):
            with self.subTest(key=key, value=value):
                with self.assertRaisesRegex(ValueError, code):
                    validate_run_spec(dict(spec, **{key: value}))
                with self.assertRaisesRegex(BoundaryError, 'RUN_SPEC'):
                    job(**{key: value})
        with self.assertRaises(ValueError):
            validate_run_spec(dict(spec, zid=1))


class ShippedSql(unittest.TestCase):
    def test_copy_is_the_reviewed_file(self):
        self.assertEqual(q.digest(SQL), q.SQL_SHA256)
        self.assertEqual(bv.POLICY['verification_sql'], q.SQL_SHA256)

    def test_merged_delphi_copy_matches_when_present(self):
        """After the backfill branch merges, the file Delphi ships must be this exact copy."""
        shipped = REPO / 'delphi/polismath/poller' / q.SQL_NAME
        if shipped.exists():
            self.assertEqual(q.digest(shipped.read_bytes()), q.SQL_SHA256,
                             'the shipped verification SQL changed: re-review, re-copy and re-pin the job')

    def test_five_selects_with_driver_parameters(self):
        statements = q.shipped_statements(SQL)
        self.assertEqual(len(statements), len(q.SHIPPED))
        text = SQL.decode()
        for sql in statements:
            self.assertTrue(sql.startswith('SELECT'))
            self.assertNotIn('--', sql)
            self.assertNotRegex(sql, r"(?<!:):(?!:)")
            for word in ('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'TRUNCATE', 'COPY', 'SET',
                         'CALL', 'DO', 'LOCK', 'NOTIFY', 'PG_SLEEP', 'DBLINK'):
                self.assertNotRegex(sql.upper(), r'\b' + word + r'\b')
        # Every psql variable became a parameter, and nothing else changed.
        joined = ';\n'.join(statements)
        text = '\n'.join(line for line in text.split('\n') if not line.lstrip().startswith('--'))
        self.assertEqual(joined.count('%(source)s'), text.count(":'source'"))
        self.assertEqual(joined.count('%(target)s'), text.count(":'target'"))
        self.assertEqual(joined.count('%(cutoff_ms)s'), text.count(':cutoff_ms'))
        restored = joined
        for name, placeholder in q.VARIABLES.items():
            restored = restored.replace(placeholder, name)
        body = [line for line in text.split('\n') if not line.lstrip().startswith('--')]
        self.assertIn(re.sub(r'\s+', ' ', restored), re.sub(r'\s+', ' ', '\n'.join(body)))
        # The result columns this job expects are the file's own aliases.
        for name, columns, _ in q.SHIPPED[1:]:
            for column in columns:
                self.assertIn('AS ' + column, text, name)

    def test_any_other_file_is_refused(self):
        for raw in (SQL + b'\n', SQL.replace(b'REPEATABLE READ', b'READ COMMITTED'), b'', SQL.decode()):
            with self.assertRaisesRegex(ValueError, 'VERIFY_SQL_DIGEST'):
                q.shipped_statements(raw)

    def test_extra_statements_are_plain_bounded_selects(self):
        for name, sql in q.EXTRA.items():
            with self.subTest(name=name):
                self.assertTrue(sql.startswith('SELECT'))
                self.assertTrue(sql.endswith(f' LIMIT {q.EXTRA_LIMITS[name] + 1}'))
                for word in ('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'data', 'zid IN', 'ORDER BY'):
                    self.assertNotIn(word, sql)
        self.assertIn('pg_current_xact_id_if_assigned', q.EXTRA['no_write'])
        self.assertIn("statement_timeout='1200s'", q.SETTINGS)
        self.assertIn('search_path=pg_catalog,public,pg_temp', q.SETTINGS)

    def test_bake_installs_both_modules(self):
        bake = (HERE / 'bake.sh').read_text()
        names = re.search(r'for file in (.+?); do install', bake)[1].split()
        self.assertIn('backfill_verify.py', names)
        self.assertIn('backfill_verify_queries.py', names)
        self.assertNotIn(q.SQL_NAME, names)


class Cursor:
    """A scripted DB-API cursor: one result per execute, in order."""
    def __init__(self, script, fail_at=None):
        self.script, self.fail_at, self.calls = list(script), fail_at, []
        self.description, self.rows = None, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if self.fail_at is not None and len(self.calls) == self.fail_at[0]:
            raise self.fail_at[1]
        if sql.startswith('SET LOCAL'):
            return
        columns, rows = self.script.pop(0)
        self.description = [(c,) for c in columns]
        self.rows = list(rows)

    def fetchone(self):
        return self.rows.pop(0)

    def fetchmany(self, n):
        out, self.rows = self.rows[:n], self.rows[n:]
        return out


class Connection:
    def __init__(self, cursor):
        self.cur, self.closed, self.rollbacks = cursor, False, 0

    def set_session(self, **kw):
        assert kw == {'readonly': True, 'isolation_level': 'REPEATABLE READ', 'autocommit': False}

    def cursor(self):
        return self.cur

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class PgError(Exception):
    def __init__(self, pgcode):
        super().__init__('error text that must never be kept')
        self.pgcode = pgcode


def script(results=None, grants=True, snapshot=verifier.SNAPSHOT_MS):
    r = verifier.fixture_results() if results is None else results
    out = [(('v', 'ro', 'iso', 'u', 's'), [(170004, 'on', 'repeatable read', 'polis_probe_reader', 'polis_probe_reader')]),
           (('t', 'g'), [(t, grants if t != 'math_ptptstats' else grants) for t in q.READ_TABLES]),
           (('c',), [(snapshot,)])]
    rows = [(t, env, r['rows'][t][label]) for t in q.TABLES for env, label in (('prod', 'source'), ('python', 'target'))]
    out.append((('tbl', 'math_env', 'n'), rows))
    for name, columns, _ in q.SHIPPED[1:]:
        out.append((columns, [tuple(r[name][c] for c in columns)]))
    out.append((('t', 'n'), [(t, r['without_target'][t]) for t in q.TABLES]))
    out.append((('s', 't'), [(r['published']['source_newest_ms'], r['published']['target_newest_ms'])]))
    out.append((('w',), [(True,)]))
    return out


class Reader(unittest.TestCase):
    def read(self, cursor, sql=SQL, spec=None):
        conn = Connection(cursor)
        spec = job()['run_spec'] if spec is None else spec
        p = reader.projection(lambda: conn, '1' * 40, spec, sql)
        return p, conn

    def test_complete_snapshot_is_the_fixture_projection(self):
        p, conn = self.read(Cursor(script()))
        self.assertEqual(p, verifier.fixture_projection(verifier.fixture_results()))
        self.assertTrue(conn.closed and conn.rollbacks >= 1)
        executed = [sql for sql, _ in conn.cur.calls]
        self.assertEqual(executed[0], q.SETTINGS)
        shipped = q.shipped_statements(SQL)
        self.assertEqual([s for s in executed if s in shipped], shipped)
        params = [p for s, p in conn.cur.calls if s in shipped]
        self.assertEqual(params, [{'source': 'prod', 'target': 'python', 'cutoff_ms': CUTOFF}] * len(shipped))

    def test_sql_mismatch_never_connects(self):
        def connect():
            raise AssertionError('connected')
        for raw in (SQL + b' ', b'SELECT 1;'):
            p = reader.projection(connect, '1' * 40, job()['run_spec'], raw)
            self.assertEqual((p['status'], p['results']), ('SQL_MISMATCH', None))
            self.assertEqual(p['verification_sql'], q.digest(raw))

    def test_missing_grant_is_not_visible(self):
        p, _ = self.read(Cursor(script(grants=False)))
        self.assertEqual((p['status'], p['results'], p['snapshot_ms']), ('NOT_VISIBLE', None, None))

    def test_errors_map_to_closed_statuses_without_text(self):
        for code, status in (('42501', 'NOT_VISIBLE'), ('57014', 'TIMEOUT'), ('55P03', 'TIMEOUT'),
                             ('40001', 'QUERY_FAILED'), (None, 'QUERY_FAILED')):
            with self.subTest(code=code):
                p, conn = self.read(Cursor(script(), fail_at=(6, PgError(code))))
                self.assertEqual(p['status'], status)
                self.assertNotIn(b'error text', encoded(p))
                self.assertTrue(conn.closed)

    def test_limits_and_shapes_refuse(self):
        s = script()
        s[3] = (s[3][0], s[3][1] + [('math_main', 'prod', 1)])
        self.assertEqual(self.read(Cursor(s))[0]['status'], 'LIMIT_EXCEEDED')
        s = script()
        s[4] = (('renamed',) + s[4][0][1:], s[4][1])
        self.assertEqual(self.read(Cursor(s))[0]['status'], 'QUERY_FAILED')
        s = script()
        s[3] = (s[3][0], [('math_main', 'other-label', 1)])
        self.assertEqual(self.read(Cursor(s))[0]['status'], 'QUERY_FAILED')
        s = script()
        s[5] = (s[5][0], [(-1,) + s[5][1][0][1:]])
        self.assertEqual(self.read(Cursor(s))[0]['status'], 'QUERY_FAILED')

    def test_inconsistent_snapshot_is_never_complete(self):
        r = verifier.fixture_results()
        r['payloads']['invalid_payload'] = 1
        self.assertEqual(self.read(Cursor(script(r)))[0]['status'], 'QUERY_FAILED')


class Receipts(unittest.TestCase):
    def test_complete_fixture_passes_with_every_control(self):
        r, j = export()
        self.assertEqual(r['verdict'], 'BACKFILL-COMPLETE')
        self.assertTrue(all(r['controls'].values()))
        self.assertEqual(set(r['controls']), set(CONTROLS))
        self.assertTrue(receipt_passed(decode_receipt(encoded(r), j), j))
        self.assertLess(len(encoded(r)), bv.LIMIT)

    def test_every_blocking_condition_is_backfill_incomplete(self):
        base = verifier.fixture_results()
        cases = {
            'missing_main': [('conversations', 'missing_main', 1), ('conversations', 'complete', 9),
                             ('payloads', 'checked', 9), ('without_target', 'math_main', 1)],
            'unequal_generation': [('conversations', 'unequal_generation', 1), ('conversations', 'complete', 9),
                                   ('payloads', 'checked', 9)],
            'uninitialized_generation': [('conversations', 'uninitialized_generation', 1),
                                         ('conversations', 'complete', 9), ('payloads', 'checked', 9)],
            'behind_source_stale': [('conversations', 'behind_source_stale', 1), ('conversations', 'complete', 9)],
            'orphan_bidtopid': [('orphans', 'orphan_bidtopid', 1)],
            'source_ahead_of_input': [('cutoff', 'source_ahead_of_input', 1)],
            'without-target-math_ticks': [('without_target', 'math_ticks', 1)],
        }
        for name, changes in cases.items():
            with self.subTest(name=name):
                r = copy.deepcopy(base)
                for group, key, value in changes:
                    r[group][key] = value
                if name == 'without-target-math_ticks':
                    r['rows']['math_ticks']['source'] = 11
                receipt, j = export(r)
                self.assertEqual(receipt['verdict'], 'BACKFILL-INCOMPLETE')
                self.assertIn(name, receipt['blocking'])
                self.assertFalse(receipt_passed(receipt, j))
                self.assertEqual(receipt['blocking'], [n for n in BLOCKING if n in receipt['blocking']])

    def test_no_evidence_is_incomplete(self):
        for status in ('NOT_VISIBLE', 'TIMEOUT', 'QUERY_FAILED', 'LIMIT_EXCEEDED', 'SQL_MISMATCH'):
            with self.subTest(status=status):
                r, j = export(status=status)
                self.assertEqual((r['verdict'], r['counts'], r['snapshot'], r['blocking']),
                                 ('INCOMPLETE', None, None, []))
                self.assertFalse(r['controls']['reader-no-write'])
        r, _ = export(verifier.fixture_results(0))
        self.assertEqual(r['verdict'], 'INCOMPLETE')
        for cutoff in (verifier.SNAPSHOT_MS + 1, verifier.SNAPSHOT_MS - 3_600_001):
            r, _ = export(j=job(cutoff_ms=cutoff))
            self.assertEqual(r['verdict'], 'INCOMPLETE')

    def test_failed_control_is_incomplete(self):
        r, j = export()
        r = copy.deepcopy(r)
        r['controls']['wrong-sql-refused'] = False
        with self.assertRaisesRegex(ValueError, 'VERIFY_FALSE_PASS'):
            validate_receipt(r, j)
        r['verdict'] = 'INCOMPLETE'
        validate_receipt(r, j)
        self.assertFalse(receipt_passed(r, j))

    def test_refusals(self):
        good, j = export()

        def refuse(mutate, code):
            r = copy.deepcopy(good)
            mutate(r)
            with self.assertRaisesRegex(ValueError, code):
                decode_receipt(encoded(r), j)
        refuse(lambda r: r.update(kind='light-shadow-compare'), 'VERIFY_BINDING')
        refuse(lambda r: r.update(schema='polis-probe-receipt/4'), 'VERIFY_BINDING')
        refuse(lambda r: r.update(run_id='d' * 32), 'VERIFY_BINDING')
        refuse(lambda r: r.update(job_sha256='0' * 64), 'VERIFY_BINDING')
        refuse(lambda r: r['bindings'].update(producer='0' * 64), 'VERIFY_IMAGE')
        refuse(lambda r: r['bindings'].update(query_policy='0' * 64), 'VERIFY_POLICY')
        refuse(lambda r: r['bindings'].update(verification_sql='0' * 64), 'VERIFY_SQL_DIGEST')
        refuse(lambda r: r['run_spec'].update(cutoff_ms=CUTOFF + 1), 'VERIFY_BINDING')
        refuse(lambda r: r['coverage'].update(poller_sweep='COLLECTED'), 'VERIFY_SCOPE')
        refuse(lambda r: r['coverage'].update(poller_progress='COLLECTED'), 'VERIFY_SCOPE')
        refuse(lambda r: r['coverage'].update(readiness='CURRENT'), 'VERIFY_SCOPE')
        refuse(lambda r: r['coverage'].update(switch_readiness='READY'), 'VERIFY_SCOPE')
        refuse(lambda r: r.update(verdict='READY'), 'VERIFY_VERDICT')
        refuse(lambda r: r['bindings'].update(readiness='0' * 64), 'VERIFY_BINDING')
        refuse(lambda r: r['run_spec']['readiness']['sweep'].update(unresolved=1), 'VERIFY_BINDING')
        refuse(lambda r: r['snapshot'].update(clock='UNKNOWN'), 'VERIFY_COUNT')
        refuse(lambda r: r.update(acceptance='certified'), 'VERIFY_SCOPE')
        refuse(lambda r: r['counts']['conversations'].update(zid=12), 'VERIFY_SCHEMA')
        refuse(lambda r: r['counts'].update(zids=[12]), 'VERIFY_SCHEMA')
        refuse(lambda r: r.update(note='text'), 'VERIFY_SCHEMA')
        refuse(lambda r: r['counts']['conversations'].update(complete=9.0), 'VERIFY_COUNT')
        refuse(lambda r: r['counts']['conversations'].update(complete='10'), 'VERIFY_COUNT')
        refuse(lambda r: r['counts']['conversations'].update(complete=-1), 'VERIFY_COUNT')
        refuse(lambda r: r['counts']['conversations'].update(complete=9), 'VERIFY_COUNT|VERIFY_FALSE_PASS')
        refuse(lambda r: r['counts']['payloads'].update(invalid_payload=1), 'VERIFY_CONSISTENCY')
        refuse(lambda r: r['counts']['without_target'].update(math_main=1), 'VERIFY_CONSISTENCY')
        refuse(lambda r: r['counts']['published'].update(target_newest_ms=None), 'VERIFY_CONSISTENCY')
        refuse(lambda r: r['snapshot'].update(newest_published_target_age_ms=0), 'VERIFY_COUNT')
        refuse(lambda r: r.update(blocking=['missing_main']), 'VERIFY_COUNT')
        refuse(lambda r: r.update(verdict='PASS'), 'VERIFY_VERDICT')
        refuse(lambda r: r.update(verdict='BACKFILL-INCOMPLETE'), 'VERIFY_FALSE_PASS')
        refuse(lambda r: r['controls'].pop('wrong-sql-refused'), 'VERIFY_SCHEMA')
        with self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'):
            decode_receipt(b' ' * 131073, j)
        with self.assertRaisesRegex(ValueError, 'RECEIPT_DUPLICATE_KEY'):
            decode_receipt(b'{"kind":"a","kind":"b"}', j)

    def test_receipt_carries_no_identifier_or_text(self):
        r, _ = export()

        def leaves(v, path=()):
            if isinstance(v, dict):
                for k, x in v.items():
                    yield from leaves(x, path + (k,))
            elif isinstance(v, list):
                for x in v:
                    yield from leaves(x, path)
            else:
                yield path, v
        closed = set(BLOCKING) | set(bv.VERDICTS) | set(bv.STATUS) | set(bv.CLOCKS) | set(bv.HOLDER_ROLES) | set(
            bv.SWEEP_STATUS) | set(bv.ALARMS) | {
            'polis-probe-receipt/3', 'backfill-verify', bv.ACCEPTANCE, 'prod', 'python', 'unresolved',
            'NOT_COLLECTED', 'NOT_EVALUATED', 'HISTORICAL', 'HANDOFF_ONLY', bv.READINESS_SCHEMA, *q.READ_TABLES}
        for path, v in leaves(r):
            self.assertNotIn('zid', path)
            if isinstance(v, str):
                self.assertTrue(v in closed or re.fullmatch('[a-f0-9]{12}|[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64}', v),
                                (path, v))
            else:
                self.assertTrue(v is None or type(v) in (int, bool), (path, v))

    def test_forged_evidence_and_projection_are_refused(self):
        j = job()
        p = verifier.fixture_projection(verifier.fixture_results())
        evidence = producer.produce(p, j['run_spec'])
        with self.assertRaisesRegex(ValueError, 'VERIFY_RECONSTRUCTION'):
            verifier.receipt(p, dict(evidence, blocking=[]) if evidence['blocking'] else
                             dict(evidence, blocking=['missing_main']), j, '1' * 40)
        with self.assertRaisesRegex(ValueError, 'VERIFY_RECONSTRUCTION'):
            verifier.receipt(p, evidence, j, '2' * 40)
        with self.assertRaisesRegex(ValueError, 'VERIFY_SQL_DIGEST'):
            validate_projection(dict(p, verification_sql='0' * 64), j['run_spec'])
        with self.assertRaisesRegex(ValueError, 'VERIFY_POLICY'):
            validate_projection(dict(p, query_policy='0' * 64), j['run_spec'])

    def test_expected_verdict_matches_the_switch_condition(self):
        r, _ = export()
        self.assertEqual(expected_verdict(r), 'BACKFILL-COMPLETE')
        self.assertEqual(bv.POLICY['blocking'], list(BLOCKING))
        # Every section-8 zero condition is named, and source-ahead blocks while unresolved.
        for n in ('missing_main', 'missing_bidtopid', 'missing_ptptstats', 'missing_ticks', 'unequal_generation',
                  'uninitialized_generation', 'invalid_payload', 'behind_source_stale', 'source_ahead',
                  'orphan_bidtopid', 'orphan_ptptstats', 'orphan_ticks', 'behind_input_at_cutoff',
                  'source_ahead_of_input', 'complete-short', 'history-missing', 'future-publication-clock'):
            self.assertIn(n, BLOCKING)
        # The receipt's vocabulary has no current or expiry names and no READY (review [1459]).
        for n in ('live_lag', 'live_tail_after_cutoff', 'target_only_main', 'poller-not-live', 'history-expired',
                  'readiness-expired', 'READY'):
            self.assertNotIn(n, BLOCKING)
        self.assertFalse([n for n in BLOCKING if n.startswith('current-')])
        self.assertNotIn('READY', bv.VERDICTS)
        self.assertEqual(bv.HANDOFF[0], 'READY')


def with_published(source=None, target=None):
    r = verifier.fixture_results()
    r['published'].update(source_newest_ms=source, target_newest_ms=target)
    return r


class Liveness(unittest.TestCase):
    """Review [1453] R1: publication maxima are catch-up evidence; progress comes from the bound history."""

    def verdict(self, results=None, **spec):
        r, j = export(results, j=job(**spec))
        self.assertEqual(decode_receipt(encoded(r), j), r)
        return r

    def test_coverage_says_progress_is_not_collected_and_readiness_is_historical(self):
        r = self.verdict()
        cov = r['coverage']
        self.assertEqual((cov['poller_progress'], cov['poller_sweep'], cov['readiness'], cov['switch_readiness']),
                         ('NOT_COLLECTED', 'NOT_COLLECTED', 'HISTORICAL', 'HANDOFF_ONLY'))
        self.assertIn('not switch readiness', r['acceptance'])
        self.assertEqual(r['bindings']['readiness'], bv.readiness_digest(ready()))
        self.assertNotIn('liveness', bv.__doc__.split('What the snapshot cannot see')[0])
        self.assertNotIn('unresolved backfill work has no complete target', bv.__doc__)

    def test_stale_ticks_without_progress_are_incomplete(self):
        """The reviewer's vectors: both old, old target ahead; none may pass on publication alone."""
        day = 86_400_000
        for source, target in ((SNAPSHOT - day, SNAPSHOT - day), (SNAPSHOT - 2 * day, SNAPSHOT - day)):
            with self.subTest(source=source, target=target):
                r = self.verdict(with_published(source, target), readiness=None)
                self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['history-missing']))
                self.assertEqual(r['snapshot']['newest_published_target_age_ms'], SNAPSHOT - target)
                # Stopped writer: its own last discovery success is as old as its tick.
                stopped = ready(discovery={'last_success_ms': target})
                r = self.verdict(with_published(source, target), readiness=stopped)
                self.assertEqual((r['verdict'], r['blocking']),
                                 ('BACKFILL-INCOMPLETE', ['history-discovery-stale']))

    def test_healthy_idle_writer_needs_progress_not_publication(self):
        r = self.verdict(with_published(SNAPSHOT - 86_400_000, SNAPSHOT - 86_400_000))
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-COMPLETE', []))
        self.assertTrue(receipt_passed(r, job()))

    def test_fresh_publication_then_wedged_discovery_blocks(self):
        wedged = ready(discovery={'last_success_ms': CUTOFF - 60_000})
        r = self.verdict(readiness=wedged)
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['history-discovery-stale']))
        r = self.verdict(readiness=ready(queue={'pending': 3, 'oldest_work_age_ms': 3_600_000}))
        self.assertEqual(r['blocking'], ['history-queue-stuck'])

    def test_standby_or_report_process_blocks(self):
        for role in ('standby', 'report'):
            r = self.verdict(readiness=ready(holder={'role': role}))
            self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['history-holder-not-primary']))

    def test_missing_or_mismatched_history_is_backfill_incomplete(self):
        cases = {
            ('history-missing',): None,
            ('history-run-mismatch',): ready(sweep={'run': 'd' * 12}),
            ('history-sweep-unresolved',): ready(sweep={'parked_live': 1}),
            ('history-not-drained',): ready(drain={'drained_ms': CUTOFF + 1}),
            ('history-monitoring-not-ok',): ready(monitoring={'alert_test_sha256': None}),
            ('history-before-cutoff', 'history-discovery-stale'): ready(observed=CUTOFF - 1),
        }
        for want, readiness in cases.items():
            with self.subTest(want=want):
                r = self.verdict(readiness=readiness)
                self.assertEqual((r['verdict'], tuple(r['blocking'])), ('BACKFILL-INCOMPLETE', want))
                self.assertFalse(receipt_passed(r, job(readiness=readiness)))
        # Malformed history is refused with the job, never ignored.
        with self.assertRaisesRegex(BoundaryError, 'RUN_SPEC'):
            job(readiness=dict(ready(), note='free text'))

    def test_future_clocks_are_unknown_never_fresh(self):
        r = self.verdict(with_published(SNAPSHOT - 5000, SNAPSHOT + 86_400_000))
        self.assertEqual((r['verdict'], r['snapshot']['clock']), ('INCOMPLETE', 'UNKNOWN'))
        self.assertIsNone(r['snapshot']['newest_published_target_age_ms'])
        self.assertEqual(r['blocking'], ['future-publication-clock'])
        # Within the tolerance is plausible; beyond it is not.
        r = self.verdict(with_published(SNAPSHOT - 5000, SNAPSHOT + bv.CLOCK_TOLERANCE_MS))
        self.assertEqual((r['verdict'], r['snapshot']['clock'], r['snapshot']['newest_published_target_age_ms']),
                         ('BACKFILL-COMPLETE', 'PLAUSIBLE', 0))
        r = self.verdict(readiness=ready(observed=SNAPSHOT + bv.CLOCK_TOLERANCE_MS + 1))
        self.assertEqual((r['verdict'], r['snapshot']['clock']), ('INCOMPLETE', 'UNKNOWN'))
        self.assertIn('future-history-clock', r['blocking'])
        r = self.verdict(readiness=ready(monitoring={'evaluated_ms': SNAPSHOT + 3_600_000}))
        self.assertEqual((r['verdict'], r['snapshot']['clock']), ('INCOMPLETE', 'UNKNOWN'))


class History(unittest.TestCase):
    """Review [1459], design (b): the bound history is judged at its own observation;
    probe latency between capture and snapshot never decides the verdict."""
    GAP = 120_000
    BOUND = 900_000

    def verdict(self, readiness, **spec):
        r, j = export(j=job(readiness=readiness, **spec))
        self.assertEqual(decode_receipt(encoded(r), j), r)
        return r

    def test_long_launch_proves_completeness_historically(self):
        """The reviewer's timing: cutoff snapshot-600 s, capture snapshot-480 s, discovery 485 s old at the snapshot."""
        long = ready(cutoff=CUTOFF, observed=SNAPSHOT - 480_000)
        self.assertEqual(SNAPSHOT - long['discovery']['last_success_ms'], 485_000)
        r = self.verdict(long)
        self.assertEqual((r['verdict'], r['blocking'], r['coverage']['readiness']),
                         ('BACKFILL-COMPLETE', [], 'HISTORICAL'))
        self.assertTrue(all(r['controls'].values()))
        self.assertEqual(r['snapshot']['history_age_ms'], 480_000)
        # Even just after the cutoff, with the cutoff's whole allowance before the snapshot.
        edge = ready(observed=CUTOFF, discovery={'last_success_ms': CUTOFF}, monitoring={'evaluated_ms': CUTOFF})
        self.assertEqual(self.verdict(edge)['verdict'], 'BACKFILL-COMPLETE')

    def test_history_age_is_bounded_by_the_cutoff(self):
        # Captured before the cutoff: refused. The cutoff past its bound: no usable evidence.
        self.assertIn('history-before-cutoff', self.verdict(ready(observed=CUTOFF - 1))['blocking'])
        old = SNAPSHOT - 3_600_001
        r = self.verdict(ready(cutoff=old, observed=old + 1_000, discovery={'last_success_ms': old + 500},
                               monitoring={'evaluated_ms': old + 500}), cutoff_ms=old)
        self.assertEqual(r['verdict'], 'INCOMPLETE')
        self.assertEqual(r['blocking'], [])

    def test_discovery_judged_at_the_observation(self):
        for age, want in ((self.GAP, []), (self.GAP + 1, ['history-discovery-stale'])):
            with self.subTest(age=age):
                observed = SNAPSHOT - 400_000
                r = self.verdict(ready(observed=observed, discovery={'last_success_ms': observed - age}))
                self.assertEqual(r['blocking'], want)
                self.assertEqual(r['verdict'], 'BACKFILL-INCOMPLETE' if want else 'BACKFILL-COMPLETE')

    def test_alarm_evaluation_judged_at_the_observation(self):
        for age, want in ((self.BOUND, []), (self.BOUND + 1, ['history-monitoring-not-ok'])):
            with self.subTest(age=age):
                observed = SNAPSHOT - 60_000
                r = self.verdict(ready(observed=observed, monitoring={'evaluated_ms': observed - age}))
                self.assertEqual(r['blocking'], want)

    def test_queued_work_is_not_aged_to_the_snapshot(self):
        for oldest, want in ((self.GAP, []), (self.GAP + 1, ['history-queue-stuck'])):
            for queue in ({'pending': 1}, {'parked': 1}):
                with self.subTest(oldest=oldest, queue=queue):
                    r = self.verdict(ready(observed=SNAPSHOT - 400_000, queue=dict(queue, oldest_work_age_ms=oldest)))
                    self.assertEqual(r['blocking'], want)

    def test_history_has_no_expiry_of_its_own(self):
        spec = job()['run_spec']
        v = ready(observed=CUTOFF + 1_000, discovery={'last_success_ms': CUTOFF + 500},
                  monitoring={'evaluated_ms': CUTOFF + 500})
        self.assertEqual(bv.history_failures(v, spec), [])
        # The same record judged now, after the bound, has expired: that is a current question.
        now = v['observed_ms'] + self.BOUND + 1
        self.assertEqual(bv.readiness_failures(v, spec, now), ['discovery-stale', 'monitoring-not-ok', 'expired'])

    def test_compounded_future_tolerance_is_refused(self):
        """Review [1455] R2: observation reference + 4,000 ms, discovery reference + 8,000 ms."""
        r = self.verdict(ready(observed=SNAPSHOT + 4_000, discovery={'last_success_ms': SNAPSHOT + 8_000}))
        self.assertEqual((r['verdict'], r['snapshot']['clock']), ('INCOMPLETE', 'UNKNOWN'))
        self.assertIn('future-history-clock', r['blocking'])

    def test_each_stamp_at_the_reference_bound(self):
        """Each inner stamp at reference + 5,000 / + 5,001, with the observation independently offset."""
        tol = bv.CLOCK_TOLERANCE_MS
        paths = {'discovery': ('discovery', 'last_success_ms'), 'sweep': ('sweep', 'finished_ms'),
                 'drain': ('drain', 'drained_ms'), 'monitoring': ('monitoring', 'evaluated_ms')}
        for name, (section, key) in paths.items():
            for offset in (0, 4_000, -60_000):
                for extra, future in ((tol, False), (tol + 1, True)):
                    stamp = SNAPSHOT + extra
                    if stamp > SNAPSHOT + offset + tol:
                        continue  # beyond the observation's own allowance; covered below
                    with self.subTest(stamp=name, observed_offset=offset, extra=extra):
                        v = ready(observed=SNAPSHOT + offset, **{section: {key: stamp}})
                        self.assertEqual(bv.readiness_future(v, SNAPSHOT), future)
                        r = self.verdict(v)
                        self.assertEqual(r['snapshot']['clock'], 'UNKNOWN' if future else 'PLAUSIBLE')
                        self.assertEqual('future-history-clock' in r['blocking'], future)
            v = ready(observed=SNAPSHOT - 60_000, **{section: {key: SNAPSHOT - 60_000 + tol + 1}})
            self.assertTrue(bv.readiness_future(v, SNAPSHOT), name)
        self.assertFalse(bv.readiness_future(ready(observed=SNAPSHOT + tol), SNAPSHOT))
        self.assertTrue(bv.readiness_future(ready(observed=SNAPSHOT + tol + 1), SNAPSHOT))


class Controls(unittest.TestCase):
    """Review [1459]: the fixed vectors follow the job's limits, so no supported
    configuration can fail a control through a mismatched embedded vector."""

    def test_every_supported_limit_keeps_every_control(self):
        for gap in bv.DISCOVERY_GAP:
            for bound in bv.READINESS_AGE:
                for age in bv.CUTOFF_AGE:
                    with self.subTest(gap=gap, bound=bound, age=age):
                        j = job(max_discovery_gap_seconds=gap, max_readiness_age_seconds=bound,
                                max_cutoff_age_seconds=age)
                        outcomes = verifier.controls(j)
                        self.assertEqual([k for k, v in outcomes.items() if not v], [])

    def test_the_vectors_really_move_with_the_limits(self):
        """A 10 s gap job: 11 s discovery at the observation blocks; 10 s passes."""
        observed = SNAPSHOT - 60_000
        for age, want in ((10_000, []), (10_001, ['history-discovery-stale'])):
            r, _ = export(j=job(max_discovery_gap_seconds=10,
                                readiness=ready(observed=observed, discovery={'last_success_ms': observed - age})))
            self.assertEqual(r['blocking'], want)
            self.assertTrue(all(r['controls'].values()))

    def test_a_wider_gap_is_refused_not_a_false_control(self):
        with self.assertRaisesRegex(ValueError, 'VERIFY_DISCOVERY_GAP'):
            validate_run_spec(dict(TEMPLATE_RUN_SPEC, cutoff_ms=CUTOFF, readiness=ready(),
                                   max_discovery_gap_seconds=600))
        with self.assertRaisesRegex(BoundaryError, 'RUN_SPEC'):
            job(max_discovery_gap_seconds=600)


PROOF_AT = SNAPSHOT + 30_000
ALERT = verifier.fixture_alert_test()


def current(receipt_sha256, observed, seq=41, alert=None, **changes):
    """A current record collected at `observed`: the bound fixture holder, advanced
    (seq, discovery successes and last success), alarms read at collection."""
    rec = ready(observed=observed, seq=seq)
    rec['discovery'] = dict(rec['discovery'], successes=20)
    rec['monitoring'] = dict(rec['monitoring'], evaluated_ms=observed)
    for section, values in changes.items():
        rec[section] = dict(rec[section], **values) if isinstance(values, dict) else values
    return {'schema': bv.CURRENT_SCHEMA, 'receipt_sha256': receipt_sha256, 'readiness': rec,
            'alert_test': ALERT if alert is None else alert}


class Handoff(unittest.TestCase):
    """Review [1459], design (b): only the hand-off asserts current switch readiness."""
    GAP = 120_000

    def setUp(self):
        self.r, self.j = export()
        self.raw = encoded(self.r)
        self.rs = hashlib.sha256(self.raw).hexdigest()
        self.bound = self.j['run_spec']['readiness']
        self.proof = bv.proof_record(self.r, self.rs, PROOF_AT)
        self.now = PROOF_AT + 60_000

    def gate(self, cur, now=None, **kw):
        kw = dict(dict(proof=self.proof, receipt_sha256=self.rs, job_sha256=sha(self.j), receipts=[self.rs],
                       previous=()), **kw)
        return bv.handoff(self.r, cur, self.now if now is None else now, **kw)

    def cur(self, observed=None, **kw):
        return current(self.rs, self.now - 1_000 if observed is None else observed, **kw)

    def assertRefused(self, out, *reasons, status='REFUSED'):
        self.assertEqual(out['status'], status, out)
        for reason in reasons:
            self.assertIn(reason, out['reasons'])
        self.assertEqual(out['reasons'], [n for n in bv.REASONS if n in out['reasons']])

    def test_ready_only_at_the_handoff(self):
        out = self.gate(self.cur())
        self.assertEqual((out['status'], out['reasons']), ('READY', []))
        self.assertEqual(out['current'], bv.readiness_digest(self.cur()))
        record = bv.handoff_record(self.r, out, self.proof, self.rs, self.cur())
        self.assertEqual(bv.validate_handoff_record(record), record)
        self.assertEqual((record['decision'], record['history'], record['receipt_sha256'], record['now_ms']),
                         ('READY', self.r['bindings']['readiness'], self.rs, self.now))
        # The receipt and consumption never say READY; the proof says HISTORICAL.
        self.assertEqual(self.r['verdict'], 'BACKFILL-COMPLETE')
        self.assertEqual(bv.consumption(self.r, self.now)['status'], 'FRESH')
        self.assertEqual(self.proof['readiness'], 'HISTORICAL')
        with self.assertRaisesRegex(ValueError, 'VERIFY_NOT_READY'):
            bv.handoff_record(self.r, dict(out, status='REFUSED'), self.proof, self.rs, self.cur())

    def test_long_launch_then_fresh_current_evidence(self):
        long = ready(observed=SNAPSHOT - 480_000)
        r, j = export(j=job(readiness=long))
        self.assertEqual(r['verdict'], 'BACKFILL-COMPLETE')
        rs = hashlib.sha256(encoded(r)).hexdigest()
        out = bv.handoff(r, current(rs, self.now - 1_000), self.now, proof=bv.proof_record(r, rs, PROOF_AT),
                         receipt_sha256=rs, job_sha256=sha(j), receipts=[rs])
        self.assertEqual((out['status'], out['reasons']), ('READY', []))

    def test_proof_then_readiness_ordering(self):
        self.assertRefused(self.gate(self.cur(observed=PROOF_AT)), 'current-before-proof')
        self.assertEqual(self.gate(self.cur(observed=PROOF_AT + 1, monitoring={'evaluated_ms': PROOF_AT}))['status'],
                         'READY')
        self.assertRefused(self.gate(self.cur(monitoring={'evaluated_ms': PROOF_AT - 1})),
                           'current-monitoring-before-proof')
        self.assertRefused(self.gate(self.cur(), proof=None), 'proof-missing')
        self.assertRefused(self.gate(self.cur(), proof=dict(self.proof, readiness='CURRENT')), 'proof-invalid')
        self.assertRefused(self.gate(self.cur(), proof={'schema': 'unreadable'}), 'proof-invalid')
        self.assertRefused(self.gate(self.cur(), proof=dict(self.proof, run_id='d' * 32)), 'proof-mismatch')
        self.assertRefused(self.gate(self.cur(), proof=dict(self.proof, available_ms=SNAPSHOT - 1)),
                           'clock-reversal', status='UNKNOWN')
        with self.assertRaisesRegex(ValueError, 'VERIFY_NOT_COMPLETE'):
            bv.proof_record(export(j=job(readiness=None))[0], self.rs, PROOF_AT)

    def test_same_holder_source_run_and_config(self):
        for key, value in (('role', 'standby'), ('instance_sha256', '8' * 64), ('source_commit', '8' * 40),
                           ('run', '8' * 12), ('config', '8' * 12)):
            with self.subTest(key=key):
                self.assertRefused(self.gate(self.cur(holder={key: value})), 'current-holder-mismatch')

    def test_restarted_holder_cannot_inherit_readiness(self):
        # A restart is a new run: its lines, sweep and drain carry the new run id.
        run = 'e' * 12
        out = self.gate(self.cur(holder={'run': run}, sweep={'run': run}, drain={'run': run}, seq=3))
        self.assertRefused(out, 'current-holder-mismatch', 'current-sequence-not-advanced', 'current-drain-changed')
        # Even a record claiming the old run cannot rewind its sequence.
        for seq in (self.bound['seq'], self.bound['seq'] - 1, 0):
            with self.subTest(seq=seq):
                self.assertRefused(self.gate(self.cur(seq=seq)), 'current-sequence-not-advanced')
        # A stopped holder: nothing newer than the history exists.
        self.assertRefused(self.gate(None), 'current-missing')

    def test_genuinely_newer_capture(self):
        # The bound history resubmitted inside a current record.
        resubmitted = {'schema': bv.CURRENT_SCHEMA, 'receipt_sha256': self.rs, 'readiness': self.bound,
                       'alert_test': ALERT}
        self.assertRefused(self.gate(resubmitted), 'current-before-proof', 'current-sequence-not-advanced',
                           'current-not-refreshed', 'current-discovery-not-advanced', 'current-discovery-stale')
        # Recaptured: new observation and sequence, the history's stale inner discovery.
        recaptured = copy.deepcopy(resubmitted)
        recaptured['readiness'].update(observed_ms=self.now - 1_000, seq=self.bound['seq'] + 1)
        recaptured['readiness']['monitoring'] = dict(self.bound['monitoring'], evaluated_ms=self.now - 1_000)
        self.assertRefused(self.gate(recaptured), 'current-discovery-not-advanced', 'current-discovery-stale')
        # The bare history record (the old /1 hand-off input) is not a current record.
        self.assertRefused(self.gate(self.bound), 'current-invalid')

    def test_discovery_within_120_seconds_of_now(self):
        for age, want in ((self.GAP, 'READY'), (self.GAP + 1, 'REFUSED')):
            with self.subTest(age=age):
                out = self.gate(self.cur(discovery={'last_success_ms': self.now - age}))
                self.assertEqual(out['status'], want, out)
        # A capture 30 s old whose discovery was 100 s old then: 130 s now.
        out = self.gate(self.cur(observed=self.now - 30_000, discovery={'last_success_ms': self.now - 130_000}))
        self.assertRefused(out, 'current-discovery-stale')
        self.assertRefused(self.gate(self.cur(discovery={'failures_since_success': 1})), 'current-discovery-stale')

    def test_pending_and_parked_work_age_to_now(self):
        for queue in ({'pending': 2}, {'parked': 1}, {'pending': 0, 'parked': 0}):
            for oldest, extra in ((90_000, 0), (90_001, 1)):
                with self.subTest(queue=queue, oldest=oldest):
                    out = self.gate(self.cur(observed=self.now - 30_000, queue=dict(queue, oldest_work_age_ms=oldest)))
                    # Any work (including a reported age) ages by the 30 s since capture.
                    self.assertEqual(out['status'], 'REFUSED' if extra else 'READY', out)
        # An empty queue does not age; any work does, from its age at capture.
        observed = self.now - 50_000
        for queue, oldest, want in (({'pending': 0, 'parked': 0}, 0, 'READY'), ({'parked': 1}, 70_000, 'READY'),
                                    ({'parked': 1}, 70_001, 'REFUSED'), ({'pending': 1}, 70_001, 'REFUSED')):
            with self.subTest(queue=queue, oldest=oldest, waited=50_000):
                out = self.gate(self.cur(observed=observed, discovery={'last_success_ms': observed - 1_000},
                                         queue=dict(queue, oldest_work_age_ms=oldest)))
                self.assertEqual(out['status'], want, out)

    def test_latest_clean_sweep_and_still_drained(self):
        newer = {'sweep_no': self.bound['sweep']['sweep_no'] + 1, 'finished_ms': self.now - 20_000}
        self.assertEqual(self.gate(self.cur(sweep=newer))['status'], 'READY')
        self.assertRefused(self.gate(self.cur(sweep={'sweep_no': self.bound['sweep']['sweep_no'] - 1})),
                           'current-sweep-regressed')
        for change in ({'unresolved': 1}, {'parked_live': 1}, {'in_flight': 1}, {'status': 'NOT_COMPLETE'}):
            with self.subTest(change=change):
                self.assertRefused(self.gate(self.cur(sweep=dict(newer, **change))), 'current-sweep-unresolved')
        self.assertRefused(self.gate(self.cur(drain={'drained_ms': None})), 'current-drain-changed',
                           'current-not-drained')
        self.assertRefused(self.gate(self.cur(drain={'drained_ms': self.bound['drain']['drained_ms'] + 1})),
                           'current-drain-changed')

    def test_current_monitoring_evidence(self):
        self.assertRefused(self.gate(self.cur(monitoring={'alarm': 'ALARM'})), 'current-monitoring-not-ok')
        late = PROOF_AT + 1_000_000
        self.assertRefused(self.gate(current(self.rs, late - 1_000, monitoring={'evaluated_ms': late - 900_001}),
                                     now=late), 'current-monitoring-not-ok')
        # The alert-test document, checked structurally (P-072 schema /2).
        topic = verifier.FIXTURE_TOPIC
        bad = {
            'schema': verifier.fixture_alert_test(schema='math_poller.alert_test_evidence/1'),
            'no-stale-notification': verifier.fixture_alert_test(notifications=[]),
            'other-topic-action': verifier.fixture_alert_test(notifications=[
                dict(ALERT['evidence']['notifications'][0], summary='Successfully executed action ' + topic + 'X')]),
            'transition-before-test': verifier.fixture_alert_test(transitions=[
                dict(ALERT['evidence']['transitions'][0], at_ms=ALERT['evidence']['emitted_ms'] - 1)]),
            'heartbeat-drill-without-heartbeat': verifier.fixture_alert_test(silence_s=1200, tested_run_primary=True,
                                                                             holder_runs=['f' * 12]),
            'primary-flag-inconsistent': verifier.fixture_alert_test(tested_run_primary=True),
            'extra-key': dict(ALERT, note='text'),
            'digest': dict(ALERT, sha256='0' * 64),
        }
        for name, alert in bad.items():
            with self.subTest(alert=name):
                with self.assertRaises(ValueError):
                    bv.validate_alert_test(alert)
                cur = self.cur(alert=alert)
                self.assertRefused(self.gate(cur), 'current-invalid')
        # A valid heartbeat drill with both alarms.
        at = ALERT['evidence']['transitions'][0]['at_ms']
        drill = verifier.fixture_alert_test(
            silence_s=1200, tested_run_primary=True, holder_runs=['f' * 12],
            transitions=ALERT['evidence']['transitions'] + [
                {'alarm': bv.HEARTBEAT_ALARM, 'at_ms': at, 'from': 'OK', 'to': 'ALARM'}],
            notifications=ALERT['evidence']['notifications'] + [
                dict(ALERT['evidence']['notifications'][0], alarm=bv.HEARTBEAT_ALARM)])
        self.assertEqual(bv.validate_alert_test(drill), drill['sha256'])
        # A different (valid) alert test than the one the history bound: the monitoring changed.
        out = self.gate(self.cur(alert=drill, monitoring={'alert_test_sha256': drill['sha256']}))
        self.assertRefused(out, 'current-alert-test-changed')
        # The record's digest must name the carried document.
        self.assertRefused(self.gate(self.cur(monitoring={'alert_test_sha256': drill['sha256']})), 'current-invalid')
        self.assertRefused(self.gate(self.cur(monitoring={'alert_test_sha256': None})), 'current-invalid')

    def test_no_intervening_change(self):
        cur = self.cur()
        self.assertRefused(self.gate(cur, job_sha256='0' * 64), 'job-changed')
        self.assertRefused(self.gate(cur, proof=dict(self.proof, job_sha256='0' * 64)), 'job-changed')
        self.assertRefused(self.gate(cur, receipt_sha256='0' * 64), 'receipt-changed', 'current-for-other-receipt')
        self.assertRefused(self.gate(current('0' * 64, self.now - 1_000)), 'current-for-other-receipt')
        self.assertRefused(self.gate(cur, receipts=[self.rs, '0' * 64]), 'newer-receipt-exists')
        self.assertRefused(self.gate(cur, receipts=[]), 'newer-receipt-exists')
        # One READY decision; a second needs a newer decision time and a newer current record.
        first = self.gate(cur)
        record = bv.handoff_record(self.r, first, self.proof, self.rs, cur)
        self.assertRefused(self.gate(cur, previous=[record]), 'newer-handoff-exists', 'current-reused')
        later = self.now + 30_000
        self.assertRefused(self.gate(cur, now=later, previous=[record]), 'current-reused')
        again = current(self.rs, later - 1_000, seq=42, discovery={'last_success_ms': later - 2_000})
        self.assertEqual(self.gate(again, now=later, previous=[record])['status'], 'READY')
        self.assertRefused(self.gate(again, now=later, previous=[dict(record, now_ms=later)]), 'newer-handoff-exists')
        self.assertRefused(self.gate(again, now=later, previous=[{'schema': 'unreadable'}]), 'handoff-record-invalid')

    def test_cutoff_expiry_is_rechecked(self):
        """A long query or a long wait: the cutoff passes its bound before the switch."""
        bound = 1000 * self.j['run_spec']['max_cutoff_age_seconds']
        now = CUTOFF + bound + 1
        out = self.gate(current(self.rs, now - 1_000), now=now)
        self.assertEqual((out['status'], out['reasons']), ('EXPIRED', ['cutoff-expired']))
        self.assertEqual(self.gate(current(self.rs, now - 2_000), now=now - 1)['status'], 'READY')

    def test_current_record_expiry_alone_is_expired(self):
        spec = dict(self.j['run_spec'], max_readiness_age_seconds=60, max_discovery_gap_seconds=120)
        late = ready(observed=self.now - 60_001, discovery={'last_success_ms': self.now - 60_001},
                     monitoring={'evaluated_ms': self.now - 60_000})
        self.assertEqual(bv.readiness_failures(late, spec, self.now), ['expired'])

    def test_unknown_clocks(self):
        tol = bv.CLOCK_TOLERANCE_MS
        self.assertRefused(self.gate(self.cur(observed=self.now + tol + 1)), 'future-current-clock', status='UNKNOWN')
        at_bound = self.cur(observed=self.now + tol, discovery={'last_success_ms': self.now})
        self.assertEqual(self.gate(at_bound)['status'], 'READY')
        self.assertRefused(self.gate(self.cur(discovery={'last_success_ms': self.now + tol + 1})),
                           'future-current-clock', status='UNKNOWN')
        self.assertRefused(self.gate(self.cur(), proof=dict(self.proof, available_ms=self.now + tol + 1)),
                           'future-proof-clock', status='UNKNOWN')
        future_alert = verifier.fixture_alert_test(emitted_ms=self.now + tol + 1, transitions=[
            dict(ALERT['evidence']['transitions'][0], at_ms=self.now + tol + 1)], notifications=[
            dict(ALERT['evidence']['notifications'][0], at_ms=self.now + tol + 1)])
        out = self.gate(self.cur(alert=future_alert, monitoring={'alert_test_sha256': future_alert['sha256']}))
        self.assertEqual(out['status'], 'UNKNOWN')
        self.assertIn('future-current-clock', out['reasons'])
        out = self.gate(self.cur(), now=SNAPSHOT - tol - 1)
        self.assertEqual(out['status'], 'UNKNOWN')
        self.assertIn('clock-reversal', out['reasons'])

    def test_not_complete_receipts_never_hand_off(self):
        r, j = export(j=job(readiness=None))
        self.assertEqual(r['verdict'], 'BACKFILL-INCOMPLETE')
        self.assertEqual(bv.consumption(r, SNAPSHOT + 1)['status'], 'NOT_COMPLETE')
        out = bv.handoff(r, self.cur(), self.now, proof=None, receipt_sha256=self.rs, job_sha256=sha(j))
        self.assertEqual((out['status'], out['current']), ('NOT_COMPLETE', None))


class Consumption(unittest.TestCase):
    """Review [1453] R2: the cutoff at consumption; archival decode unchanged."""

    def setUp(self):
        self.r, self.j = export()
        self.raw = encoded(self.r)

    def test_archival_decode_never_reads_the_clock(self):
        for wall in (0.0, SNAPSHOT / 1000, (SNAPSHOT + 7_000_000) / 1000, 4e9):
            with patch('time.time', return_value=wall), patch('time.time_ns', return_value=int(wall * 1e9)):
                self.assertEqual(decode_receipt(self.raw, self.j), self.r)
                self.assertTrue(receipt_passed(decode_receipt(self.raw, self.j), self.j))
        source = (HERE / 'backfill_verify.py').read_text()
        self.assertNotRegex(source, r'(?m)^\s*(import time|from time |import datetime|from datetime )')

    def test_fresh_result(self):
        out = bv.consumption(self.r, SNAPSHOT + 60_000)
        self.assertEqual((out['status'], out['reasons'], out['history_age_ms']), ('FRESH', [], 120_000))

    def test_delayed_consumption_is_refused_with_new_proof(self):
        """The reviewer's witness: stored cutoff age 600,000 ms, consumed at snapshot + 7,000,000 ms."""
        now = SNAPSHOT + 7_000_000
        self.assertEqual(self.r['snapshot']['cutoff_age_ms'], 600_000)
        out = bv.consumption(self.r, now)
        self.assertEqual((out['status'], out['reasons'], out['cutoff_age_ms']), ('EXPIRED', ['cutoff-expired'], 7_600_000))
        self.assertIn('new proof required', bv.NEW_PROOF)
        # Expired for the switch, still valid and unchanged as history.
        self.assertEqual(decode_receipt(self.raw, self.j), self.r)
        self.assertTrue(receipt_passed(self.r, self.j))

    def test_long_running_query_outlives_the_bound(self):
        """Snapshot fresh at start; the job ends past the bound (7,200 s ceiling > 3,600 s bound)."""
        bound = 1000 * self.j['run_spec']['max_cutoff_age_seconds']
        self.assertEqual(bv.consumption(self.r, CUTOFF + bound)['status'], 'FRESH')
        out = bv.consumption(self.r, CUTOFF + bound + 1)
        self.assertEqual((out['status'], out['reasons']), ('EXPIRED', ['cutoff-expired']))

    def test_clock_reversal_is_unknown(self):
        out = bv.consumption(self.r, SNAPSHOT - bv.CLOCK_TOLERANCE_MS - 1)
        self.assertEqual(out['status'], 'UNKNOWN')
        self.assertIn('clock-reversal', out['reasons'])
        self.assertEqual(bv.consumption(self.r, SNAPSHOT - bv.CLOCK_TOLERANCE_MS)['status'], 'FRESH')


@unittest.skipUnless(os.environ.get('POLIS_BACKFILL_VERIFY_PG'), 'opt-in: disposable PG17 URL')
class Postgres(unittest.TestCase):
    """The exact shipped file through the reader on a real PG17 (disposable database only)."""

    def setUp(self):
        import psycopg2
        self.url = os.environ['POLIS_BACKFILL_VERIFY_PG']
        admin = psycopg2.connect(self.url)
        admin.autocommit = True
        with admin.cursor() as cur:
            cur.execute("SELECT pg_catalog.current_database() = 'probe_test'")
            assert cur.fetchone()[0], 'refusing a non-disposable database'
            cur.execute(DDL)
        self.admin = admin
        self.addCleanup(admin.close)

    def fill(self, sql):
        with self.admin.cursor() as cur:
            cur.execute('TRUNCATE math_main, math_bidtopid, math_ptptstats, math_ticks, votes')
            cur.execute(sql)

    def read(self, cutoff, readiness=None):
        import psycopg2
        from urllib.parse import urlsplit
        parts = urlsplit(self.url)

        def connect():
            return psycopg2.connect(host=parts.hostname, port=parts.port, dbname=parts.path[1:],
                                    user='polis_probe_reader', password='probe')
        spec = dict(TEMPLATE_RUN_SPEC, cutoff_ms=cutoff, readiness=readiness)
        return reader.projection(connect, '1' * 40, spec, SQL), spec

    def clean(self, tick_offset_ms=0):
        """The valid single-conversation bundle at the current wall clock; ticks shifted by the offset."""
        now = int(time.time() * 1000)
        self.fill(BUNDLES.format(now=now))
        with self.admin.cursor() as cur:
            for table in q.TABLES:
                cur.execute('DELETE FROM ' + table + ' WHERE zid = 2')
            cur.execute('UPDATE math_ticks SET modified = %s', (now + tick_offset_ms,))
        return now

    def receipt(self, now, readiness):
        p, spec = self.read(now - 10_000, readiness)
        self.assertEqual(p['status'], 'COMPLETE', p)
        j = job(cutoff_ms=spec['cutoff_ms'], readiness=readiness)
        r = verifier.export(p, bv.assess(p, j['run_spec']), j, '1' * 40)
        self.assertEqual(decode_receipt(encoded(r), j), r)
        return r

    def test_publication_clocks_are_not_poller_liveness(self):
        """Review [1453] R1 through the real PG17 chain: a stopped writer in a quiet database."""
        now = self.clean(-86_400_000)
        r = self.receipt(now, None)
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['history-missing']))
        self.assertGreaterEqual(r['snapshot']['newest_published_target_age_ms'], 86_400_000)
        stopped = ready(cutoff=now - 10_000, observed=now, discovery={'last_success_ms': now - 86_400_000})
        r = self.receipt(now, stopped)
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['history-discovery-stale']))
        # A healthy idle holder: genuine discovery progress after the cutoff, no new publication.
        r = self.receipt(now, ready(cutoff=now - 10_000, observed=now))
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-COMPLETE', []))
        self.assertTrue(receipt_passed(r, job(cutoff_ms=now - 10_000, readiness=ready(cutoff=now - 10_000,
                                                                                      observed=now))))

    def test_history_is_judged_at_its_observation(self):
        """Review [1459], design (b), through the real PG17 chain: the history captured 480 s
        before the snapshot (discovery 485 s old then) proves completeness historically; a
        history already stale when captured does not."""
        now = self.clean()
        for observed, last, want in ((now - 480_000, now - 485_000, []),
                                     (now - 480_000, now - 600_001, ['history-discovery-stale'])):
            with self.subTest(last=now - last):
                history = ready(cutoff=now - 600_000, observed=observed, discovery={'last_success_ms': last})
                p, spec = self.read(now - 600_000, history)
                self.assertEqual(p['status'], 'COMPLETE', p)
                j = job(cutoff_ms=spec['cutoff_ms'], readiness=history)
                r = verifier.export(p, bv.assess(p, j['run_spec']), j, '1' * 40)
                self.assertEqual(r['blocking'], want)
                self.assertEqual(r['verdict'], 'BACKFILL-INCOMPLETE' if want else 'BACKFILL-COMPLETE')
                self.assertEqual(r['coverage']['readiness'], 'HISTORICAL')
                self.assertTrue(all(r['controls'].values()))
                self.assertEqual(receipt_passed(r, j), not want)

    def test_future_publication_clock_is_unknown(self):
        now = self.clean(86_400_000)
        r = self.receipt(now, ready(cutoff=now - 10_000, observed=now))
        self.assertEqual((r['verdict'], r['snapshot']['clock']), ('INCOMPLETE', 'UNKNOWN'))
        self.assertIsNone(r['snapshot']['newest_published_target_age_ms'])
        self.assertIn('future-publication-clock', r['blocking'])

    def test_valid_empty_target_and_missing_target(self):
        now = int(time.time() * 1000)
        self.fill(BUNDLES.format(now=now))
        p, spec = self.read(now - 10_000, ready(cutoff=now - 10_000, observed=now))
        self.assertEqual(p['status'], 'COMPLETE', p)
        c = p['results']['conversations']
        self.assertEqual((c['source_conversations'], c['complete'], c['missing_main'], c['missing_ticks']), (2, 1, 1, 1))
        self.assertEqual(p['results']['without_target'], {'math_main': 1, 'math_bidtopid': 1,
                                                          'math_ptptstats': 1, 'math_ticks': 1})
        self.assertEqual(p['results']['payloads']['empty_shape'], 1)
        self.assertTrue(p['no_write'])
        evidence = bv.assess(p, spec)
        self.assertIn('missing_main', evidence['blocking'])
        with self.admin.cursor() as cur:
            cur.execute("DELETE FROM math_main WHERE zid = 2")
            cur.execute("DELETE FROM math_bidtopid WHERE zid = 2")
            cur.execute("DELETE FROM math_ptptstats WHERE zid = 2")
            cur.execute("DELETE FROM math_ticks WHERE zid = 2")
        p, spec = self.read(now - 10_000, ready(cutoff=now - 10_000, observed=now))
        self.assertEqual(p['status'], 'COMPLETE', p)
        self.assertEqual(bv.assess(p, spec)['blocking'], [])

    def test_missing_grant_is_not_visible(self):
        self.fill(BUNDLES.format(now=1_900_000_000_000))
        with self.admin.cursor() as cur:
            cur.execute('REVOKE SELECT ON math_ptptstats FROM polis_probe_reader')
        try:
            p, _ = self.read(1_899_999_999_000)
            self.assertEqual(p['status'], 'NOT_VISIBLE')
        finally:
            with self.admin.cursor() as cur:
                cur.execute('GRANT SELECT ON math_ptptstats TO polis_probe_reader')


DDL = """
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'polis_probe_reader') THEN
    CREATE ROLE polis_probe_reader LOGIN PASSWORD 'probe';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS math_main (zid integer NOT NULL, math_env varchar(999) NOT NULL, data jsonb NOT NULL,
  last_vote_timestamp bigint NOT NULL, caching_tick bigint NOT NULL DEFAULT 0, math_tick bigint NOT NULL DEFAULT -1,
  modified bigint, UNIQUE (zid, math_env));
CREATE TABLE IF NOT EXISTS math_bidtopid (zid integer NOT NULL, math_env varchar(999) NOT NULL,
  math_tick bigint NOT NULL DEFAULT -1, data jsonb NOT NULL, modified bigint, UNIQUE (zid, math_env));
CREATE TABLE IF NOT EXISTS math_ptptstats (zid integer NOT NULL, math_env varchar(999) NOT NULL,
  math_tick bigint NOT NULL DEFAULT -1, data jsonb NOT NULL, modified bigint, UNIQUE (zid, math_env));
CREATE TABLE IF NOT EXISTS math_ticks (zid integer, math_tick bigint NOT NULL DEFAULT 0,
  caching_tick bigint NOT NULL DEFAULT 0, math_env varchar(999) NOT NULL, modified bigint NOT NULL, UNIQUE (zid, math_env));
CREATE TABLE IF NOT EXISTS votes (zid integer NOT NULL, pid integer NOT NULL, tid integer NOT NULL,
  vote smallint, created bigint);
GRANT USAGE ON SCHEMA public TO polis_probe_reader;
GRANT SELECT ON math_main, math_bidtopid, math_ptptstats, math_ticks, votes TO polis_probe_reader;
"""
EMPTY_MAIN = ('{"zid": %d, "n": 0, "tids": [], "pca": {"center": [], "comps": []}, "repness": {}, '
              '"base-clusters": {"id": [], "members": []}, "group-clusters": [], "group-votes": {}, '
              '"in-conv": [], "lastVoteTimestamp": 0}')
BUNDLES = ("""
INSERT INTO math_main VALUES (1, 'prod', '{EMPTY1}', 0, 0, 3, {now}), (2, 'prod', '{EMPTY2}', 0, 0, 3, {now}),
  (1, 'python', '{EMPTY1}', 0, 0, 7, {now});
INSERT INTO math_bidtopid VALUES (1, 'prod', 3, '{{"zid": 1, "bidToPid": [], "lastVoteTimestamp": 0}}', {now}),
  (2, 'prod', 3, '{{"zid": 2, "bidToPid": [], "lastVoteTimestamp": 0}}', {now}),
  (1, 'python', 7, '{{"zid": 1, "bidToPid": [], "lastVoteTimestamp": 0}}', {now});
INSERT INTO math_ptptstats VALUES (1, 'prod', 3, '{{"zid": 1, "ptptstats": {{}}, "lastVoteTimestamp": 0}}', {now}),
  (2, 'prod', 3, '{{"zid": 2, "ptptstats": {{}}, "lastVoteTimestamp": 0}}', {now}),
  (1, 'python', 7, '{{"zid": 1, "ptptstats": {{}}, "lastVoteTimestamp": 0}}', {now});
INSERT INTO math_ticks VALUES (1, 3, 0, 'prod', {now}), (2, 3, 0, 'prod', {now}), (1, 7, 0, 'python', {now});
""".replace('{EMPTY1}', (EMPTY_MAIN % 1).replace('{', '{{').replace('}', '}}'))
   .replace('{EMPTY2}', (EMPTY_MAIN % 2).replace('{', '{{').replace('}', '}}')))


if __name__ == '__main__':
    unittest.main()
