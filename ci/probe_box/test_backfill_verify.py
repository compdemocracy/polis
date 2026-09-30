"""P-070 backfill verification job: closed run-spec, SQL binding, reader, switch condition and receipt refusals.

Dependency-free except the opt-in PostgreSQL case at the end (psycopg2 and a
disposable PG17 named by POLIS_BACKFILL_VERIFY_PG). Receipts are built with
the verifier's own fixture helpers; the image tests (ci/private_cert) cover
recipes, admission and the isolated closures.
"""
import copy
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
                                 ('max_discovery_gap_seconds', 9, 'VERIFY_RUN_SPEC'),
                                 ('readiness', {}, 'VERIFY_SCHEMA'),
                                 ('readiness', dict(ready(), schema='polis-backfill-readiness/0'), 'VERIFY_READINESS'),
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
            'NOT_COLLECTED', 'NOT_EVALUATED', 'OPERATOR_SUPPLIED', bv.READINESS_SCHEMA, *q.READ_TABLES}
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
                  'source_ahead_of_input', 'complete-short', 'readiness-missing', 'future-publication-clock'):
            self.assertIn(n, BLOCKING)
        for n in ('live_lag', 'live_tail_after_cutoff', 'target_only_main', 'poller-not-live'):
            self.assertNotIn(n, BLOCKING)


def with_published(source=None, target=None):
    r = verifier.fixture_results()
    r['published'].update(source_newest_ms=source, target_newest_ms=target)
    return r


class Liveness(unittest.TestCase):
    """Review [1453] R1: publication maxima are catch-up evidence; progress comes from the readiness record."""

    def verdict(self, results=None, **spec):
        r, j = export(results, j=job(**spec))
        self.assertEqual(decode_receipt(encoded(r), j), r)
        return r

    def test_coverage_says_progress_is_not_collected(self):
        r = self.verdict()
        self.assertEqual((r['coverage']['poller_progress'], r['coverage']['poller_sweep'], r['coverage']['readiness']),
                         ('NOT_COLLECTED', 'NOT_COLLECTED', 'OPERATOR_SUPPLIED'))
        self.assertEqual(r['bindings']['readiness'], bv.readiness_digest(ready()))
        self.assertNotIn('liveness', bv.__doc__.split('What the snapshot cannot see')[0])
        self.assertNotIn('unresolved backfill work has no complete target', bv.__doc__)

    def test_stale_ticks_without_progress_are_incomplete(self):
        """The reviewer's vectors: both old, old target ahead; none may pass on publication alone."""
        day = 86_400_000
        for source, target in ((SNAPSHOT - day, SNAPSHOT - day), (SNAPSHOT - 2 * day, SNAPSHOT - day)):
            with self.subTest(source=source, target=target):
                r = self.verdict(with_published(source, target), readiness=None)
                self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['readiness-missing']))
                self.assertEqual(r['snapshot']['newest_published_target_age_ms'], SNAPSHOT - target)
                # Stopped writer: its own last discovery success is as old as its tick.
                stopped = ready(discovery={'last_success_ms': target})
                r = self.verdict(with_published(source, target), readiness=stopped)
                self.assertEqual((r['verdict'], r['blocking']),
                                 ('BACKFILL-INCOMPLETE', ['readiness-discovery-stale']))

    def test_healthy_idle_writer_needs_progress_not_publication(self):
        r = self.verdict(with_published(SNAPSHOT - 86_400_000, SNAPSHOT - 86_400_000))
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-COMPLETE', []))
        self.assertTrue(receipt_passed(r, job()))

    def test_fresh_publication_then_wedged_discovery_blocks(self):
        wedged = ready(discovery={'last_success_ms': CUTOFF - 60_000})
        r = self.verdict(readiness=wedged)
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['readiness-discovery-stale']))
        r = self.verdict(readiness=ready(queue={'pending': 3, 'oldest_work_age_ms': 3_600_000}))
        self.assertEqual(r['blocking'], ['readiness-queue-stuck'])

    def test_standby_or_report_process_blocks(self):
        for role in ('standby', 'report'):
            r = self.verdict(readiness=ready(holder={'role': role}))
            self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['readiness-holder-not-primary']))

    def test_missing_mismatched_or_expired_readiness_is_backfill_incomplete(self):
        cases = {
            ('readiness-missing',): None,
            ('readiness-run-mismatch',): ready(sweep={'run': 'd' * 12}),
            ('readiness-sweep-unresolved',): ready(sweep={'parked_live': 1}),
            ('readiness-not-drained',): ready(drain={'drained_ms': CUTOFF + 1}),
            ('readiness-monitoring-not-ok',): ready(monitoring={'alert_test_sha256': None}),
            # Expired also means stale inner evidence at the snapshot (review [1455] R1).
            ('readiness-discovery-stale', 'readiness-monitoring-not-ok', 'readiness-expired'):
                ready(observed=SNAPSHOT - 900_001, cutoff=SNAPSHOT - 1_000_000),
        }
        for want, readiness in cases.items():
            with self.subTest(want=want):
                spec = {'readiness': readiness}
                if 'readiness-expired' in want:
                    spec['cutoff_ms'] = SNAPSHOT - 1_000_000
                r = self.verdict(**spec)
                self.assertEqual((r['verdict'], tuple(r['blocking'])), ('BACKFILL-INCOMPLETE', want))
                self.assertFalse(receipt_passed(r, job(**spec)))

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
        self.assertIn('future-readiness-clock', r['blocking'])
        r = self.verdict(readiness=ready(monitoring={'evaluated_ms': SNAPSHOT + 3_600_000}))
        self.assertEqual((r['verdict'], r['snapshot']['clock']), ('INCOMPLETE', 'UNKNOWN'))


class Consumption(unittest.TestCase):
    """Review [1453] R2: current-time readiness at consumption and at the switch; archival decode unchanged."""

    def setUp(self):
        self.r, self.j = export()
        self.raw = encoded(self.r)
        self.bound = self.j['run_spec']['readiness']

    def current(self, now, **changes):
        return ready(observed=now, **changes)

    def test_archival_decode_never_reads_the_clock(self):
        for wall in (0.0, SNAPSHOT / 1000, (SNAPSHOT + 7_000_000) / 1000, 4e9):
            with patch('time.time', return_value=wall), patch('time.time_ns', return_value=int(wall * 1e9)):
                self.assertEqual(decode_receipt(self.raw, self.j), self.r)
                self.assertTrue(receipt_passed(decode_receipt(self.raw, self.j), self.j))
        source = (HERE / 'backfill_verify.py').read_text()
        self.assertNotRegex(source, r'(?m)^\s*(import time|from time |import datetime|from datetime )')

    def test_fresh_result(self):
        out = bv.consumption(self.r, SNAPSHOT + 60_000)
        self.assertEqual((out['status'], out['reasons']), ('FRESH', []))
        out = bv.handoff(self.r, self.current(SNAPSHOT + 60_000), SNAPSHOT + 61_000)
        self.assertEqual((out['status'], out['reasons']), ('READY', []))
        self.assertEqual(out['current_readiness'], bv.readiness_digest(self.current(SNAPSHOT + 60_000)))

    def test_delayed_consumption_is_refused_with_new_proof(self):
        """The reviewer's witness: stored cutoff age 600,000 ms, consumed at snapshot + 7,000,000 ms."""
        now = SNAPSHOT + 7_000_000
        self.assertEqual(self.r['snapshot']['cutoff_age_ms'], 600_000)
        out = bv.consumption(self.r, now)
        self.assertEqual((out['status'], out['reasons'], out['cutoff_age_ms']), ('EXPIRED', ['cutoff-expired'], 7_600_000))
        self.assertIn('new proof required', bv.NEW_PROOF)
        out = bv.handoff(self.r, self.current(now), now)
        self.assertEqual(out['status'], 'EXPIRED')
        self.assertIn('cutoff-expired', out['reasons'])
        # Expired for the switch, still valid and unchanged as history.
        self.assertEqual(decode_receipt(self.raw, self.j), self.r)
        self.assertTrue(receipt_passed(self.r, self.j))

    def test_long_running_query_outlives_the_bound(self):
        """Snapshot fresh at start; the job ends past the bound (7,200 s ceiling > 3,600 s bound)."""
        bound = 1000 * self.j['run_spec']['max_cutoff_age_seconds']
        self.assertEqual(bv.consumption(self.r, CUTOFF + bound)['status'], 'FRESH')
        out = bv.consumption(self.r, CUTOFF + bound + 1)
        self.assertEqual((out['status'], out['reasons']), ('EXPIRED', ['cutoff-expired']))

    def test_clock_reversal_and_future_stamps_are_unknown(self):
        out = bv.consumption(self.r, SNAPSHOT - bv.CLOCK_TOLERANCE_MS - 1)
        self.assertEqual(out['status'], 'UNKNOWN')
        self.assertIn('clock-reversal', out['reasons'])
        self.assertEqual(bv.consumption(self.r, SNAPSHOT - bv.CLOCK_TOLERANCE_MS)['status'], 'FRESH')
        now = SNAPSHOT + 60_000
        out = bv.handoff(self.r, self.current(now + bv.CLOCK_TOLERANCE_MS + 1), now)
        self.assertEqual(out['status'], 'UNKNOWN')
        self.assertIn('future-current-readiness-clock', out['reasons'])

    def test_handoff_requires_the_current_matching_holder(self):
        now = SNAPSHOT + 60_000
        cases = {
            'current-readiness-missing': None,
            'current-readiness-mismatch': self.current(now, holder={'run': 'e' * 12}),
            'current-readiness-holder-not-primary': self.current(now, holder={'role': 'standby'}),
            'current-readiness-discovery-stale': self.current(now, discovery={'last_success_ms': now - 600_000}),
            'current-readiness-sweep-unresolved': self.current(now, sweep={'in_flight': 1}),
            'current-readiness-not-refreshed': ready(observed=self.bound['observed_ms'] - 1),
            'current-readiness-invalid': dict(self.current(now), note='free text'),
        }
        for reason, current in cases.items():
            with self.subTest(reason=reason):
                out = bv.handoff(self.r, current, now)
                self.assertEqual(out['status'], 'REFUSED', out)
                self.assertIn(reason, out['reasons'])
        # A current record past its own age bound, while the cutoff is still fresh: its inner
        # evidence is stale now as well, so it is refused; capture a newer one.
        now = CUTOFF + 3_000_000
        out = bv.handoff(self.r, self.current(now - 900_001), now)
        self.assertEqual((out['status'], out['reasons']),
                         ('REFUSED', ['current-readiness-discovery-stale', 'current-readiness-monitoring-not-ok',
                                      'current-readiness-expired']))
        # Only the record-age bound failing, with every inner age fresh now, maps to EXPIRED.
        spec = dict(self.j['run_spec'], max_readiness_age_seconds=60, max_discovery_gap_seconds=900)
        late = self.current(now - 60_001, discovery={'last_success_ms': now - 60_001},
                            monitoring={'evaluated_ms': now - 60_000})
        self.assertEqual(bv.readiness_failures(late, spec, now), ['readiness-expired'])

    def test_not_complete_receipts_never_hand_off(self):
        r, _ = export(j=job(readiness=None))
        self.assertEqual(r['verdict'], 'BACKFILL-INCOMPLETE')
        self.assertEqual(bv.consumption(r, SNAPSHOT + 1)['status'], 'NOT_COMPLETE')
        self.assertEqual(bv.handoff(r, self.current(SNAPSHOT), SNAPSHOT + 1)['status'], 'NOT_COMPLETE')


class DecisionTime(unittest.TestCase):
    """Review [1455]: every inner readiness age is judged at the decision time (the
    snapshot for the verdict, now for launch and handoff), the record-age bound is
    additional, and no stamp may exceed the reference plus one tolerance."""
    GAP = 120_000
    BOUND = 900_000

    def verdict(self, readiness, **spec):
        r, j = export(j=job(readiness=readiness, **spec))
        self.assertEqual(decode_receipt(encoded(r), j), r)
        return r

    def passing(self):
        r, j = export()
        self.assertEqual(r['verdict'], 'BACKFILL-COMPLETE')
        return r, j

    def test_discovery_fresh_at_capture_stale_at_snapshot(self):
        """The reviewer's first timing: cutoff snapshot-600 s, observation snapshot-480 s, discovery 485 s old."""
        stale = ready(cutoff=CUTOFF, observed=SNAPSHOT - 480_000)
        self.assertEqual(stale['observed_ms'] - stale['discovery']['last_success_ms'], 5_000)
        self.assertEqual(bv.readiness_failures(stale, job()['run_spec'], stale['observed_ms']), [])
        r = self.verdict(stale)
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['readiness-discovery-stale']))
        self.assertTrue(all(r['controls'].values()))
        self.assertEqual(r['snapshot']['clock'], 'PLAUSIBLE')

    def test_identical_record_resubmitted_at_handoff_is_refused(self):
        """The reviewer's second timing: the bound record passed again as current at snapshot + 120 s."""
        stale = ready(cutoff=CUTOFF, observed=SNAPSHOT - 480_000)
        # Built as if it had passed (the verdict above refuses it); handoff must refuse it on its own.
        r, j = self.passing()
        r = copy.deepcopy(r)
        out = bv.handoff(r, stale, SNAPSHOT + 120_000)
        self.assertEqual(out['status'], 'REFUSED')
        self.assertIn('current-readiness-discovery-stale', out['reasons'])
        # A stopped holder resubmitting the exact launch-bound record of a passing receipt.
        bound = j['run_spec']['readiness']
        out = bv.handoff(r, bound, SNAPSHOT + 120_000)
        self.assertEqual(out['status'], 'REFUSED')
        self.assertIn('current-readiness-not-refreshed', out['reasons'])
        self.assertIn('current-readiness-discovery-stale', out['reasons'])
        # Even inside the discovery gap, the bound record is history, not current progress.
        out = bv.handoff(r, bound, SNAPSHOT)
        self.assertEqual((out['status'], out['reasons']), ('REFUSED', ['current-readiness-not-refreshed']))
        # Refreshing only the observation stamp exposes the same stale inner discovery.
        recaptured = dict(copy.deepcopy(bound), observed_ms=SNAPSHOT + 120_000)
        out = bv.handoff(r, recaptured, SNAPSHOT + 120_000)
        self.assertEqual((out['status'], out['reasons']), ('REFUSED', ['current-readiness-discovery-stale']))
        # Genuinely current discovery succeeds.
        out = bv.handoff(r, ready(observed=SNAPSHOT + 120_000), SNAPSHOT + 120_000)
        self.assertEqual((out['status'], out['reasons']), ('READY', []))

    def test_discovery_age_boundary_at_snapshot_and_at_handoff(self):
        for age, want in ((self.GAP, []), (self.GAP + 1, ['readiness-discovery-stale'])):
            with self.subTest(snapshot_age=age):
                r = self.verdict(ready(observed=SNAPSHOT - 1_000, discovery={'last_success_ms': SNAPSHOT - age}))
                self.assertEqual(r['blocking'], want)
                self.assertEqual(r['verdict'], 'BACKFILL-INCOMPLETE' if want else 'BACKFILL-COMPLETE')
        r, _ = self.passing()
        now = SNAPSHOT + 300_000
        for age, want in ((self.GAP, 'READY'), (self.GAP + 1, 'REFUSED')):
            with self.subTest(handoff_age=age):
                out = bv.handoff(r, ready(observed=now - 1_000, discovery={'last_success_ms': now - age}), now)
                self.assertEqual(out['status'], want, out)

    def test_healthy_idle_progress_passes(self):
        idle = ready(observed=SNAPSHOT - 1_000, queue={'pending': 0, 'oldest_work_age_ms': 0})
        r = self.verdict(idle, cutoff_ms=CUTOFF)
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-COMPLETE', []))
        now = SNAPSHOT + 600_000
        self.assertEqual(bv.handoff(r, ready(observed=now), now)['status'], 'READY')

    def test_stale_alarm_evaluation(self):
        for age, want in ((self.BOUND, []), (self.BOUND + 1, ['readiness-monitoring-not-ok'])):
            with self.subTest(snapshot_age=age):
                r = self.verdict(ready(observed=SNAPSHOT - 60_000, monitoring={'evaluated_ms': SNAPSHOT - age}))
                self.assertEqual(r['blocking'], want)
        r, _ = self.passing()
        now = SNAPSHOT + 300_000
        for age, want in ((self.BOUND, 'READY'), (self.BOUND + 1, 'REFUSED')):
            with self.subTest(handoff_age=age):
                current = ready(observed=now - 1_000, monitoring={'evaluated_ms': now - age})
                self.assertEqual(bv.handoff(r, current, now)['status'], want)

    def test_queued_work_ages_while_the_record_waits(self):
        # 60 s old at capture, captured 60 s before the snapshot: exactly the gap at the snapshot.
        for oldest, want in ((60_000, []), (60_001, ['readiness-queue-stuck'])):
            with self.subTest(oldest=oldest):
                r = self.verdict(ready(observed=SNAPSHOT - 60_000, queue={'pending': 1, 'oldest_work_age_ms': oldest}))
                self.assertEqual(r['blocking'], want)
        # An empty queue does not age.
        r = self.verdict(ready(observed=SNAPSHOT - 60_000, queue={'pending': 0, 'oldest_work_age_ms': 0}))
        self.assertEqual(r['blocking'], [])
        r, _ = self.passing()
        now = SNAPSHOT + 300_000
        current = ready(observed=now - 30_000, queue={'pending': 2, 'oldest_work_age_ms': 90_001})
        self.assertIn('current-readiness-queue-stuck', bv.handoff(r, current, now)['reasons'])
        current = ready(observed=now - 30_000, queue={'pending': 2, 'oldest_work_age_ms': 90_000})
        self.assertEqual(bv.handoff(r, current, now)['status'], 'READY')

    def test_record_age_bound_is_retained(self):
        # Limits the fixed control fixture cannot carry: judged directly, as the verifier does.
        spec = dict(job()['run_spec'], max_readiness_age_seconds=60, max_discovery_gap_seconds=900)
        at_bound = ready(observed=SNAPSHOT - 60_000, discovery={'last_success_ms': SNAPSHOT - 60_000},
                         monitoring={'evaluated_ms': SNAPSHOT - 60_000})
        self.assertEqual(bv.readiness_failures(at_bound, spec, SNAPSHOT), [])
        beyond = ready(observed=SNAPSHOT - 60_001, discovery={'last_success_ms': SNAPSHOT - 60_001},
                       monitoring={'evaluated_ms': SNAPSHOT - 60_000})
        self.assertEqual(bv.readiness_failures(beyond, spec, SNAPSHOT), ['readiness-expired'])

    def test_compounded_future_tolerance_is_refused(self):
        """The reviewer's case: observation reference + 4,000 ms, discovery reference + 8,000 ms."""
        future = ready(observed=SNAPSHOT + 4_000, discovery={'last_success_ms': SNAPSHOT + 8_000})
        r = self.verdict(future)
        self.assertEqual((r['verdict'], r['snapshot']['clock']), ('INCOMPLETE', 'UNKNOWN'))
        self.assertIn('future-readiness-clock', r['blocking'])
        passing, _ = self.passing()
        out = bv.handoff(passing, ready(observed=SNAPSHOT + 4_000, discovery={'last_success_ms': SNAPSHOT + 8_000}),
                         SNAPSHOT)
        self.assertEqual(out['status'], 'UNKNOWN')
        self.assertIn('future-current-readiness-clock', out['reasons'])

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
                        self.assertEqual('future-readiness-clock' in r['blocking'], future)
            # Beyond the observation's allowance while inside the reference's is still future.
            v = ready(observed=SNAPSHOT - 60_000, **{section: {key: SNAPSHOT - 60_000 + tol + 1}})
            self.assertTrue(bv.readiness_future(v, SNAPSHOT), name)
        # The observation itself at the reference bound.
        self.assertFalse(bv.readiness_future(ready(observed=SNAPSHOT + tol), SNAPSHOT))
        self.assertTrue(bv.readiness_future(ready(observed=SNAPSHOT + tol + 1), SNAPSHOT))
        # The same bound at handoff, against now.
        passing, _ = self.passing()
        now = SNAPSHOT + 300_000
        for extra, want in ((tol, 'READY'), (tol + 1, 'UNKNOWN')):
            current = ready(observed=now + 4_000, discovery={'last_success_ms': now + extra},
                            monitoring={'evaluated_ms': now})
            self.assertEqual(bv.handoff(passing, current, now)['status'], want)


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
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['readiness-missing']))
        self.assertGreaterEqual(r['snapshot']['newest_published_target_age_ms'], 86_400_000)
        stopped = ready(cutoff=now - 10_000, observed=now, discovery={'last_success_ms': now - 86_400_000})
        r = self.receipt(now, stopped)
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['readiness-discovery-stale']))
        # A healthy idle holder: genuine discovery progress after the cutoff, no new publication.
        r = self.receipt(now, ready(cutoff=now - 10_000, observed=now))
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-COMPLETE', []))
        self.assertTrue(receipt_passed(r, job(cutoff_ms=now - 10_000, readiness=ready(cutoff=now - 10_000,
                                                                                      observed=now))))

    def test_capture_time_discovery_is_judged_at_the_snapshot(self):
        """Review [1455] R1 through the real PG17 chain: discovery fresh at capture, 485 s old at the snapshot."""
        now = self.clean()
        delayed = ready(cutoff=now - 600_000, observed=now - 480_000)
        p, spec = self.read(now - 600_000, delayed)
        self.assertEqual(p['status'], 'COMPLETE', p)
        j = job(cutoff_ms=spec['cutoff_ms'], readiness=delayed)
        r = verifier.export(p, bv.assess(p, j['run_spec']), j, '1' * 40)
        self.assertEqual((r['verdict'], r['blocking']), ('BACKFILL-INCOMPLETE', ['readiness-discovery-stale']))
        self.assertTrue(all(r['controls'].values()))
        self.assertFalse(receipt_passed(r, j))

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
