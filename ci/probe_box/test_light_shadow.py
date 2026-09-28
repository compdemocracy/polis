"""Light-shadow comparison: closed run-spec, pairing, reader and receipt/3 refusals.

Dependency-free: no engine, driver or database. Receipts here are assembled by
hand from the closed schema; the image tests (ci/private_cert) exercise the
certified comparison itself.
"""
import copy
import json
from pathlib import Path
import re
import sys
import unittest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'private_cert/images'))
from contracts import BoundaryError, decode_job, refuse_placeholder, validate_job
from receipt import decode_receipt, receipt_passed, sha
import light_shadow as ls
from light_shadow import (CONTROLS, COVERED, EXCLUDED_FIELDS, TEMPLATE_RUN_SPEC, UNCOVERED_TABLES, encoded,
                          expected_verdict, outcome, pair, tally, validate_projection,
                          validate_run_spec, worst)
from light_shadow_queries import LIMITS, MAX_CONVERSATIONS, QUERIES
import light_shadow_reader as reader

SPEC = dict(TEMPLATE_RUN_SPEC, shadow_started_ms=1_800_000_000_000, engine_commit='a' * 40,
            engine_image='sha256:' + 'b' * 64)


def job(**spec):
    return validate_job(dict(schema='polis-probe-job/2', kind='light-shadow-compare', run_id='c' * 32,
                             max_seconds=3600, run_spec=dict(SPEC, **spec),
                             reader={'image': 'localhost/polis-shadow-reader@sha256:' + '1' * 64, 'args': ['read']},
                             producer={'image': 'localhost/polis-shadow-producer@sha256:' + '2' * 64, 'args': ['produce']},
                             verifier={'image': 'localhost/polis-shadow-verifier@sha256:' + '3' * 64, 'args': ['verify']}))


def entry(pairing='PAIRED', unpaired=None, differing=(), created=False, legacy=None):
    e = dict(pairing=pairing, unpaired=unpaired, outcome=None, legacy_defect=legacy, differing=sorted(differing),
             float_leaves=0, g12_outliers=0, exact_leaves=0, exact_mismatches=0, shape_faults=0, nonfinite=0,
             worst_abs=None, worst_rel=None, created_after_start=created)
    if pairing == 'PAIRED':
        e.update(outcome=outcome(differing), float_leaves=10, exact_leaves=5, worst_abs=0.0, worst_rel=0.0)
        if differing:
            e.update(g12_outliers=1, worst_abs=0.25, worst_rel=0.5)
    return e


def build(j, entries, status='COMPLETE', **controls):
    entries = sorted(entries, key=encoded)
    complete = status == 'COMPLETE'
    flagged = [[z, 5, None] for z, e in enumerate(entries, 1)
               if e['outcome'] in ls.TRIAGE_SELECTED]
    r = {'schema': 'polis-probe-receipt/3', 'kind': 'light-shadow-compare', 'run_id': j['run_id'],
         'job_sha256': sha(j), 'verdict': 'INCOMPLETE', 'acceptance': ls.ACCEPTANCE,
         'triage': {'required': len(flagged), 'sha256': ls.triage_digest(flagged), 'ids': 'ON-BOX-ONLY'},
         'bindings': dict(source_commit='d' * 40, query_policy=ls.POLICY_SHA,
                          certification_policy=ls.CERTIFICATION_POLICY, server_version_num=170004,
                          **{k: j[k]['image'].split('@sha256:')[1] for k in ('reader', 'producer', 'verifier')}),
         'run_spec': dict(j['run_spec']),
         'window': {'start_ms': 1_900_000_000_000 - 86_400_000, 'end_ms': 1_900_000_000_000} if complete else None,
         'coverage': {'status': status, 'covered': list(COVERED), 'uncovered_tables': list(UNCOVERED_TABLES),
                      'excluded_fields': list(EXCLUDED_FIELDS)},
         'rows': dict(prod_main=9, shadow_main=7, prod_ticks=9, shadow_ticks=7, active=len(entries),
                      prod_main_after=9, prod_ticks_after=9, prod_python_shape=0),
         'totals': tally(entries), 'worst': worst(entries), 'conversations': entries,
         'controls': dict(dict.fromkeys(CONTROLS, True), **controls)}
    r['verdict'] = expected_verdict(r)
    return r


class RunSpec(unittest.TestCase):
    def test_template_is_the_registry_entry_and_uses_the_compose_default_label(self):
        registry = json.loads((HERE / 'jobs.json').read_bytes())['jobs']['light-shadow-compare-v1']
        self.assertEqual(validate_job(registry), registry)
        self.assertEqual(registry['run_spec'], TEMPLATE_RUN_SPEC)
        self.assertEqual(registry['run_spec']['shadow_env'], 'python')
        self.assertEqual((registry['schema'], registry['kind'], registry['max_seconds']),
                         ('polis-probe-job/2', 'light-shadow-compare', 3600))
        for role, action in (('reader', 'read'), ('producer', 'produce'), ('verifier', 'verify')):
            self.assertEqual(registry[role]['args'], [action])
            self.assertEqual(registry[role]['image'], f'localhost/polis-shadow-{role}@sha256:' + '0' * 64)

    def test_placeholder_digests_are_never_launched(self):
        registry = json.loads((HERE / 'jobs.json').read_bytes())['jobs']
        with self.assertRaisesRegex(BoundaryError, 'PLACEHOLDER_IMAGE'):
            refuse_placeholder(validate_job(registry['light-shadow-compare-v1']))
        refuse_placeholder(job())
        for bad in ({'engine_commit': '0' * 40}, {'engine_image': 'sha256:' + '0' * 64}):
            with self.assertRaisesRegex(BoundaryError, 'PLACEHOLDER_RUN_SPEC'):
                refuse_placeholder(job(**bad))
        for name in ('sampled-paired-battery-v1', 'roles-census-v1'):
            refuse_placeholder(validate_job(registry[name]))
        self.assertIn('refuse_placeholder(validate_job(job))', (HERE / 'run.py').read_text())

    def test_the_served_label_and_malformed_labels_are_refused(self):
        for label in ('prod', '', 'Prod', 'python shadow', "python'--", 'x' * 33, None, 1):
            with self.subTest(label=label), self.assertRaises(ValueError):
                validate_run_spec(dict(SPEC, shadow_env=label))
            with self.assertRaisesRegex(BoundaryError, 'RUN_SPEC'):
                job(shadow_env=label)
        for label in ('python', 'python-shadow', 'py_2'):
            self.assertEqual(job(shadow_env=label)['run_spec']['shadow_env'], label)

    def test_run_spec_is_closed_and_bounded(self):
        for bad in (dict(SPEC, extra=1), {k: v for k, v in SPEC.items() if k != 'window_seconds'},
                    dict(SPEC, window_seconds=60), dict(SPEC, window_seconds=8 * 86400),
                    dict(SPEC, window_seconds=True), dict(SPEC, shadow_started_ms=0),
                    dict(SPEC, engine_commit='A' * 40), dict(SPEC, engine_image='b' * 64)):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_run_spec(bad)
        j = job()
        with self.assertRaisesRegex(BoundaryError, 'JOB_SCHEMA'):
            validate_job({k: v for k, v in j.items() if k != 'run_spec'})
        with self.assertRaisesRegex(BoundaryError, 'JOB_SCHEMA'):
            validate_job(dict(j, kind='roles-census'))
        self.assertEqual(decode_job(json.dumps(j).encode()), j)


class Pairing(unittest.TestCase):
    base = {'n': 3, 'n-cmts': 2, 'user-vote-counts': {'0': 2, '1': 1}, 'lastVoteTimestamp': 5,
            'lastModTimestamp': None, 'math_tick': 1}

    def test_equal_timestamps_and_totals_pair_and_ticks_never_matter(self):
        self.assertEqual(pair(self.base, dict(self.base, math_tick=99, caching_tick=4)), ('PAIRED', None))
        snake = {k.replace('-', '_'): v for k, v in self.base.items()}
        self.assertEqual(pair(self.base, snake), ('PAIRED', None))

    def test_unpaired_reasons(self):
        self.assertEqual(pair(None, self.base), ('UNPAIRED', 'NO-PROD-ROW'))
        self.assertEqual(pair(self.base, None), ('UNPAIRED', 'NO-SHADOW-ROW'))
        self.assertEqual(pair(self.base, dict(self.base, lastVoteTimestamp=6)), ('UNPAIRED', 'TIMESTAMPS'))
        self.assertEqual(pair(self.base, dict(self.base, lastModTimestamp=7)), ('UNPAIRED', 'TIMESTAMPS'))
        for key, value in (('n', 4), ('n-cmts', 3), ('user-vote-counts', {'0': 2, '1': 2})):
            self.assertEqual(pair(self.base, dict(self.base, **{key: value})), ('UNPAIRED', 'TOTALS'))
        # Same vote sum spread differently still pairs; the comparison sees it.
        self.assertEqual(pair(self.base, dict(self.base, **{'user-vote-counts': {'0': 1, '1': 2}})), ('PAIRED', None))

    def test_malformed_pairing_fields(self):
        for bad in ([], dict(self.base, n='3'), dict(self.base, lastVoteTimestamp=-1),
                    dict(self.base, **{'user-vote-counts': {'0': 1.5}})):
            self.assertEqual(pair(self.base, bad)[0], 'MALFORMED')

    def test_absent_pairing_metadata_is_never_evidence(self):
        self.assertEqual(pair({}, {}), ('MALFORMED', None))
        for key in ('lastVoteTimestamp', 'lastModTimestamp', 'n', 'n-cmts', 'user-vote-counts'):
            both = {k: v for k, v in self.base.items() if k != key}
            with self.subTest(key=key):
                self.assertEqual(pair(both, copy.deepcopy(both)), ('MALFORMED', None))
                self.assertEqual(pair(self.base, both), ('MALFORMED', None))
        # A prod row may omit totals only as the named legacy empty row.
        prod = {k: v for k, v in self.base.items() if k != 'n'}
        self.assertEqual(pair(prod, self.base), ('MALFORMED', None))

    def test_legacy_empty_row_pairs_with_the_complete_empty_shadow(self):
        shadow = {'n': 0, 'n-cmts': 0, 'user-vote-counts': {}, 'lastVoteTimestamp': 0, 'lastModTimestamp': None}
        prod = {'lastVoteTimestamp': 0, 'lastModTimestamp': None}
        self.assertEqual(pair(prod, shadow), ('PAIRED', None))
        # Omitted totals against a non-empty shadow are not the legacy empty row.
        self.assertEqual(pair(prod, dict(shadow, n=1)), ('MALFORMED', None))

    def test_outcome_is_a_function_of_the_differing_keys(self):
        self.assertEqual(outcome([]), 'PASS')
        self.assertEqual(outcome(['group-clusters', 'repness']), 'NEAR-TIE-CANDIDATE')
        self.assertEqual(outcome(['pca', 'repness']), 'HISTORY-DIVERGENCE')
        for keys in (['tids'], ['pca', 'n'], ['consensus'], ['row-schema'], ['in-conv', 'repness'],
                     ['pca', 'row-schema'], ['group-clusters', 'row-schema']):
            self.assertEqual(outcome(keys), 'FAIL')


class Receipt(unittest.TestCase):
    def setUp(self):
        self.job = job()
        self.entries = [entry(), entry(created=True), entry(differing=['group-clusters']),
                        entry(differing=['pca', 'repness']), entry(legacy=ls.EMPTY_DEFECT),
                        entry('UNPAIRED', 'TIMESTAMPS'), entry('UNPAIRED', 'NO-SHADOW-ROW')]
        self.r = build(self.job, self.entries)

    def refused(self, mutate, code=None):
        r = copy.deepcopy(self.r)
        mutate(r)
        with self.assertRaisesRegex(ValueError, code or '.'):
            decode_receipt(encoded(r), self.job)

    def test_attention_round_trips_through_the_supervisor_dispatch(self):
        self.assertEqual(self.r['verdict'], 'OPERATIONAL-ATTENTION')
        self.assertEqual(decode_receipt(encoded(self.r), self.job), self.r)
        self.assertFalse(receipt_passed(self.r, self.job))
        self.assertEqual(self.r['acceptance'], 'operational-only; not certification or cutover evidence')
        t = self.r['totals']
        self.assertEqual((t['PAIRED'], t['UNPAIRED'], t['PASS'], t['NEAR-TIE-CANDIDATE'], t['HISTORY-DIVERGENCE'],
                          t['FAIL'], t['triage_required'], t['created_after_start']), (5, 2, 3, 1, 1, 0, 2, 1))
        self.assertEqual(self.r['worst'], {'abs': 0.25, 'rel': 0.5})
        self.assertEqual((self.r['triage']['required'], self.r['triage']['ids']), (2, 'ON-BOX-ONLY'))
        self.assertRegex(self.r['triage']['sha256'], '^[a-f0-9]{64}$')

    def test_only_operational_pass_passes_publicly(self):
        clean = [e for e in self.entries if e['outcome'] not in ('NEAR-TIE-CANDIDATE', 'HISTORY-DIVERGENCE')]
        r = build(self.job, clean)
        self.assertEqual(r['verdict'], 'OPERATIONAL-PASS')
        self.assertIsNone(r['triage']['sha256'])
        decode_receipt(encoded(r), self.job)
        self.assertTrue(receipt_passed(r, self.job))
        self.assertIn('receipt_passed(receipt', (HERE / 'run.py').read_text())
        for verdict in ('PASS', 'FAIL'):
            with self.assertRaisesRegex(ValueError, 'SHADOW_VERDICT'):
                decode_receipt(encoded(dict(r, verdict=verdict)), self.job)
        with self.assertRaisesRegex(ValueError, 'SHADOW_SCOPE'):
            decode_receipt(encoded(dict(r, acceptance='certified')), self.job)

    def test_triage_is_bound_by_digest_and_handed_off_without_ids(self):
        self.refused(lambda r: r['triage'].update(required=1), 'SHADOW_COUNT')
        self.refused(lambda r: r['triage'].update(sha256=None), 'SHADOW_COUNT')
        self.refused(lambda r: r['triage'].update(ids=[1, 2]), 'SHADOW_COUNT')
        spec = ls.triage_spec(self.r, self.job)
        self.assertEqual((spec['conversations'], spec['triage_sha256'], spec['source_receipt_sha256']),
                         (2, self.r['triage']['sha256'], sha(self.r)))
        self.assertEqual(spec['certification_policy'], ls.CERTIFICATION_POLICY)
        self.assertNotIn('zid', encoded(spec).decode())
        for bad in (dict(spec, zids=[1]), dict(spec, conversations=0), dict(spec, certification_policy='0' * 64)):
            with self.assertRaises(ValueError):
                ls.validate_triage_spec(bad)
        clean = build(self.job, [entry()])
        with self.assertRaisesRegex(ValueError, 'TRIAGE_EMPTY'):
            ls.triage_spec(clean, self.job)
        self.assertEqual(ls.triage_digest([[3, 5, None], [1, 5, 6]]), ls.triage_digest([[1, 5, 6], [3, 5, None]]))

    def test_no_identifier_or_payload_can_enter(self):
        self.refused(lambda r: r['conversations'][0].update(zid=1))
        self.refused(lambda r: r['conversations'][0].update(differing=['a comment text']))
        self.refused(lambda r: r['conversations'][0].update(blob={}))
        self.refused(lambda r: r['rows'].update(zids=[1]))
        self.refused(lambda r: r.update(note='x'))
        self.refused(lambda r: r['worst'].update(abs=0.123456789))
        text = encoded(self.r).decode()
        self.assertNotIn('zid', text)

    def test_any_fail_fails_and_triage_classes_do_not(self):
        r = build(self.job, self.entries + [entry(differing=['tids'])])
        self.assertEqual(r['verdict'], 'OPERATIONAL-FAIL')
        decode_receipt(encoded(r), self.job)
        self.refused(lambda v: v.update(verdict='OPERATIONAL-FAIL'), 'SHADOW_FALSE_PASS')
        self.refused(lambda v: v.update(verdict='OPERATIONAL-PASS'), 'SHADOW_FALSE_PASS')

    def test_empty_or_wholly_unpaired_result_is_never_pass(self):
        for entries in ([], [entry('UNPAIRED', 'NO-PROD-ROW')]):
            r = build(self.job, entries)
            self.assertEqual(r['verdict'], 'INCOMPLETE')
            decode_receipt(encoded(r), self.job)
            forged = dict(r, verdict='OPERATIONAL-PASS')
            with self.assertRaisesRegex(ValueError, 'SHADOW_FALSE_PASS'):
                decode_receipt(encoded(forged), self.job)

    def test_mostly_unpaired_is_incomplete(self):
        lone = [entry()] + [entry('UNPAIRED', 'NO-SHADOW-ROW') for _ in range(249)]
        r = build(self.job, lone)
        self.assertEqual(r['verdict'], 'INCOMPLETE')
        decode_receipt(encoded(r), self.job)
        half = [entry(), entry('UNPAIRED', 'TIMESTAMPS')]
        self.assertEqual(build(self.job, half)['verdict'], 'OPERATIONAL-PASS')
        self.assertEqual(build(self.job, half + [entry('UNPAIRED', 'TOTALS')])['verdict'], 'INCOMPLETE')

    def test_zero_leaf_pass_is_refused(self):
        paired = next(i for i, e in enumerate(self.r['conversations']) if e['outcome'] == 'PASS')
        self.refused(lambda r: r['conversations'][paired].update(float_leaves=0, exact_leaves=0, worst_abs=None,
                                                                  worst_rel=None))

    def test_incomplete_coverage_carries_no_entries(self):
        r = build(self.job, [], status='NOT_VISIBLE', **{'reader-no-write': False, 'prod-count-not-decreased': False})
        self.assertEqual(r['verdict'], 'INCOMPLETE')
        decode_receipt(encoded(r), self.job)
        bad = build(self.job, self.entries, status='LIMIT_EXCEEDED')
        with self.assertRaisesRegex(ValueError, 'SHADOW_COUNT'):
            decode_receipt(encoded(bad), self.job)

    def test_live_controls(self):
        for name in ('reader-no-write', 'prod-count-not-decreased'):
            r = build(self.job, self.entries, **{name: False})
            self.assertEqual(r['verdict'], 'OPERATIONAL-FAIL')
            decode_receipt(encoded(r), self.job)
        self.assertNotIn('prod-rows-unchanged', ls.CONTROLS)
        r = build(self.job, self.entries, **{'prod-count-not-decreased': False})
        decode_receipt(encoded(r), self.job)
        self.refused(lambda v: v['rows'].update(prod_main_after=8), 'SHADOW_FALSE_PASS')
        self.refused(lambda v: v['rows'].update(prod_python_shape=1), 'SHADOW_FALSE_PASS')
        r = build(self.job, self.entries, **{'shadow-label-not-prod': False})
        r['rows']['prod_python_shape'] = 1
        self.assertEqual(r['verdict'], 'OPERATIONAL-FAIL')
        decode_receipt(encoded(r), self.job)

    def test_counts_bindings_and_order(self):
        self.refused(lambda r: r['totals'].update(PASS=4), 'SHADOW_COUNT')
        self.refused(lambda r: r['rows'].update(active=8), 'SHADOW_COUNT')
        self.refused(lambda r: r['conversations'].reverse(), 'SHADOW_ORDER')
        self.refused(lambda r: r['bindings'].update(verifier='0' * 64), 'SHADOW_IMAGE')
        self.refused(lambda r: r['bindings'].update(query_policy='0' * 64), 'SHADOW_POLICY')
        self.refused(lambda r: r['bindings'].update(certification_policy='0' * 64), 'SHADOW_POLICY')
        self.refused(lambda r: r['run_spec'].update(window_seconds=7200), 'SHADOW_BINDING')
        self.refused(lambda r: r.update(kind='roles-census'), 'SHADOW_BINDING')
        self.refused(lambda r: r['window'].update(start_ms=1), 'SHADOW_WINDOW')
        self.refused(lambda r: r['coverage'].update(uncovered_tables=[]), 'SHADOW_SCOPE')

    def test_entries_are_internally_consistent(self):
        self.refused(lambda r: r['conversations'][0].update(outcome='PASS', differing=['tids']))
        unpaired = next(i for i, e in enumerate(self.r['conversations']) if e['pairing'] == 'UNPAIRED')
        self.refused(lambda r: r['conversations'][unpaired].update(outcome='PASS'))
        self.refused(lambda r: r['conversations'][unpaired].update(unpaired='IN-FLIGHT'))
        paired = next(i for i, e in enumerate(self.r['conversations']) if e['outcome'] == 'PASS')
        self.refused(lambda r: r['conversations'][paired].update(g12_outliers=1))
        self.refused(lambda r: r['conversations'][paired].update(worst_abs=None))
        self.refused(lambda r: r['conversations'][paired].update(legacy_defect='legacy-defect-other'))
        self.assertIn(self.r['conversations'][0]['pairing'], ('PAIRED', 'UNPAIRED'))

    def test_receipt_limit_fits_the_largest_ordinary_day(self):
        many = [entry(differing=sorted(ls.HISTORY_KEYS)) for _ in range(MAX_CONVERSATIONS)]
        for e in many:
            e.update(float_leaves=10**6, exact_leaves=10**6, g12_outliers=10**5, worst_abs=1.234e-05, worst_rel=9.876e-03)
        self.assertLessEqual(len(encoded(build(self.job, many))), ls.LIMIT)


class Queries(unittest.TestCase):
    def test_fixed_statements_name_only_granted_tables_and_never_the_tick_counters(self):
        text = ' '.join(QUERIES.values())
        self.assertEqual(set(re.findall(r'public\.(\w+)', text)), {'math_main', 'math_ticks', 'conversations'})
        for forbidden in ('math_bidtopid', 'math_ptptstats', 'math_tick', 'caching_tick', 'INSERT', 'UPDATE',
                          'DELETE', 'python', "'prod'"):
            self.assertIsNone(re.search(r'\b' + forbidden + r'\b', text), forbidden)
        for name, sql in QUERIES.items():
            self.assertTrue(sql.startswith('SELECT '), name)
            self.assertTrue(sql.endswith(f' LIMIT {LIMITS[name] + 1}'), name)
        provision = (HERE / 'provision_login.py').read_text()
        self.assertIn("TABLES = ('conversations','votes','comments','participants','math_main','math_ticks')", provision)

    def test_policy_digest_binds_queries_and_policy(self):
        self.assertRegex(ls.POLICY_SHA, '^[a-f0-9]{64}$')
        self.assertEqual(ls.POLICY['uncovered_tables'], ['math_bidtopid', 'math_ptptstats'])


class FakeCursor:
    def __init__(self, db):
        self.db, self.result = db, None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.db.log.append((sql, params))
        if sql.startswith('SET LOCAL'):
            self.result = []
            return
        if 'server_version_num' in sql:
            self.result = [self.db.session]
            return
        name = next(k for k, v in QUERIES.items() if v == sql)
        if name in self.db.fail:
            raise RuntimeError('permission denied for table math_main')
        self.result = list(self.db.answers(name, params))

    def fetchone(self):
        return self.result[0]

    def fetchmany(self, n):
        return self.result[:n]


class FakeConnection:
    def __init__(self, active=(1, 2, 3), fail=(), no_write=True, after=None):
        self.log, self.fail, self.active, self.no_write = [], set(fail), list(active), no_write
        self.session = (170004, 'on', 'repeatable read', 'polis_probe_reader', 'polis_probe_reader')
        self.counts_calls, self.after = 0, after or (9, 9)
        self.rollbacks, self.sessions = 0, []

    def set_session(self, **kw):
        self.sessions.append(kw)

    def rollback(self):
        self.rollbacks += 1

    def cursor(self):
        return FakeCursor(self)

    def answers(self, name, params):
        shadow = params and params.get('shadow')
        if name == 'clock':
            return [(1_900_000_000_000,)]
        if name == 'counts':
            self.counts_calls += 1
            prod = (9, 9) if self.counts_calls == 1 else self.after
            return [('math_main', 'prod', prod[0]), ('math_main', shadow, 7), ('math_ticks', 'prod', prod[1]),
                    ('math_ticks', shadow, 7)]
        if name == 'active':
            return [(z,) for z in self.active]
        if name == 'created':
            return [(z, 1_700_000_000_000 + z) for z in self.active]
        if name == 'rows':
            return [(z, env, {'n': z}) for z in self.active for env in ('prod', shadow) if not (z == 3 and env == 'prod')]
        if name == 'no_write':
            return [(self.no_write,)]


class Reader(unittest.TestCase):
    def test_complete_snapshot_binds_label_window_and_counts(self):
        db = FakeConnection()
        p = reader.projection(db, 'd' * 40, SPEC)
        validate_projection(p, SPEC)
        self.assertEqual(p['status'], 'COMPLETE')
        self.assertEqual(p['window'], {'start_ms': 1_900_000_000_000 - 86_400_000, 'end_ms': 1_900_000_000_000})
        self.assertEqual(p['catalog'], dict(prod_main=9, shadow_main=7, prod_ticks=9, shadow_ticks=7, active=3,
                                            prod_main_after=9, prod_ticks_after=9, no_write=True))
        self.assertEqual([c['zid'] for c in p['conversations']], [1, 2, 3])
        self.assertIsNone(p['conversations'][2]['prod'])
        self.assertTrue(all(kw == dict(readonly=True, isolation_level='REPEATABLE READ', autocommit=False)
                            for kw in db.sessions))
        self.assertEqual(len(db.sessions), 2)
        # Label and window travel only as bound parameters.
        bound = [params for sql, params in db.log if params and 'shadow' in params]
        self.assertTrue(bound and all(pa['shadow'] == 'python' and pa['prod'] == 'prod' for pa in bound))

    def test_failures_and_limits_never_become_rows(self):
        for fail, status in (({'rows'}, 'NOT_VISIBLE'), ({'no_write'}, 'NOT_VISIBLE')):
            p = reader.projection(FakeConnection(fail=fail), 'd' * 40, SPEC)
            validate_projection(p, SPEC)
            self.assertEqual((p['status'], p['conversations'], p['window']), (status, [], None))
        p = reader.projection(FakeConnection(active=range(1, MAX_CONVERSATIONS + 2)), 'd' * 40, SPEC)
        self.assertEqual((p['status'], p['conversations']), ('LIMIT_EXCEEDED', []))
        db = FakeConnection()
        db.session = (170004, 'off', 'repeatable read', 'polis_probe_reader', 'polis_probe_reader')
        self.assertEqual(reader.projection(db, 'd' * 40, SPEC)['status'], 'NOT_VISIBLE')

    def test_write_evidence_and_after_counts_are_recorded(self):
        p = reader.projection(FakeConnection(no_write=False, after=(8, 9)), 'd' * 40, SPEC)
        self.assertEqual((p['catalog']['no_write'], p['catalog']['prod_main_after']), (False, 8))

    def test_reader_refuses_the_served_label_before_connecting(self):
        db = FakeConnection()
        with self.assertRaises(ValueError):
            reader.projection(db, 'd' * 40, dict(SPEC, shadow_env='prod'))
        self.assertEqual(db.log, [])

    def test_projection_shape_is_closed(self):
        p = reader.projection(FakeConnection(), 'd' * 40, SPEC)
        for mutate in (lambda q: q.update(shadow_env='prod'), lambda q: q.update(shadow_env='other'),
                       lambda q: q['conversations'].append(copy.deepcopy(q['conversations'][0])),
                       lambda q: q['catalog'].update(active=4), lambda q: q.update(query_policy='0' * 64),
                       lambda q: q['conversations'][0].update(prod=None, shadow=None),
                       lambda q: q['window'].update(start_ms=0)):
            q = copy.deepcopy(p)
            mutate(q)
            with self.assertRaises(ValueError):
                validate_projection(q, SPEC)


if __name__ == '__main__':
    unittest.main()
