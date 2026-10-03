"""P-078 un-flip rehearsal: the held migration, the bound queries, the run-spec, the
receipt's closed validation, the operator's refusals and the step machine.

The step-machine cases need a disposable PostgreSQL 17 named by
POLIS_UNFLIP_REHEARSAL_PG (a superuser URL on a throwaway server; the wrapper
test_unflip_rehearsal.sh starts one under COMPOSE_PROJECT_NAME=p078h on port
5474 and removes it after). They build the real migration chain 000000-000022
into a template database, add a generated fixture of conversations and votes
in today's storage sign (agree = -1), and run every case on a fresh clone as a
non-superuser owner role, like the master role of an RDS copy. This is the
first executable test of the held un-flip migration.
"""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'private_cert/images'))
from contracts import BoundaryError, decode_job, refuse_placeholder, validate_job
from receipt import decode_receipt, receipt_passed, sha
import unflip_rehearsal as u
import unflip_rehearsal_steps as steps
import unflip_operator as op
import unflip_rehearsal_reader as image_reader
import unflip_rehearsal_producer as image_producer
import unflip_rehearsal_verifier as image_verifier

MIGRATION = u.MIGRATION_PATH.read_bytes()
QUERIES = u.QUERIES_PATH.read_bytes()
DDL = u.CONVENTION_STANDIN_PATH.read_bytes()
CERT_IDS = ('genfixcert1', 'genfixcert2')
CERT = sorted(hashlib.sha256(x.encode()).hexdigest() for x in CERT_IDS)
NOW_MS = int(time.time() * 1000)


def spec(**changes):
    base = dict(u.TEMPLATE_RUN_SPEC, mode='flip', restore_rule=True, snapshot_sha256='a' * 64,
                snapshot_created_ms=NOW_MS - 3_600_000, db_host_sha256='b' * 64, r2_host_sha256='c' * 64,
                sample_conversations=6, certification_conversations=2, certification_sha256=CERT,
                migration_sql_sha256=u.digest(MIGRATION), convention_ddl_sha256=u.digest(DDL),
                queries_sha256=u.digest(QUERIES), server_image='sha256:' + 'd' * 64,
                engine_image='sha256:' + 'e' * 64,
                restore_observed={'duration_s': 812.5, 'storage_growth_s': 640.0, 'instance_class': 'db.t3.large',
                                  'storage_type': 'gp3', 'allocated_storage_gb': 60})
    if changes.get('mode') == 'dry':
        base.update(restore_rule=False, r2_host_sha256=None)
    base.update(changes)
    return base


def job(**changes):
    return validate_job({'schema': 'polis-probe-job/2', 'kind': 'unflip-rehearsal', 'run_id': 'f' * 32,
                         'max_seconds': 14400, 'run_spec': spec(**changes),
                         'reader': {'image': 'localhost/polis-unflip-reader@sha256:' + '1' * 64, 'args': ['read']},
                         'producer': {'image': 'localhost/polis-unflip-producer@sha256:' + '2' * 64,
                                      'args': ['produce']},
                         'verifier': {'image': 'localhost/polis-unflip-verifier@sha256:' + '3' * 64,
                                      'args': ['verify']}})


def recording(**changes):
    r = {'conversations': 6, 'participants': 40, 'votes': 500, 'votes_latest': 400, 'agg_sha256': '4' * 64,
         'hashes_sha256': '5' * 64, 'lsn_before_sha256': '6' * 64}
    r.update(changes)
    return r


def passing_state(mode='flip'):
    s = u.empty_state()
    s['preflight'] = {'server_version_num': 170009, 'snapshot_age_s': 3600.0, 'free_storage_gb': 48.5,
                      'convention_ddl_applied': True}
    s['pre'] = recording()
    s['post'] = recording(lsn_before_sha256='7' * 64)
    s['migrate'] = {'wall_s': 12.5, 'wal_bytes': 10_000, 'max_lock_waiters': 0, 'max_lock_wait_ms': 0,
                    'heap_growth_bytes': 8192, 'index_growth_bytes': 4096, 'dead_tuples_after': 0,
                    'counts_mirrored': True, 'vacuum_s': 1.5 if mode == 'flip' else None}
    s['rerun'] = {'refused': True, 'sqlstate_class': 'P0'}
    if mode == 'flip':
        # The selection the reader made (box-local) and one case per selected item.
        s['zids'] = {'certification': [101, 102], 'sample': [101, 102, 103, 104, 105, 106]}
        cases = {'pca2': {'0': '8' * 64, '1': '9' * 64}, 'exports': {'0': 'a' * 64, '1': 'b' * 64},
                 'math': {u.zid_key(z): 'd' * 64 for z in s['zids']['sample']}}
        s['pre_cases'], s['post_cases'] = copy.deepcopy(cases), copy.deepcopy(cases)
        s['convention_after'] = [1, 1]
        s['insert_roundtrip'] = 'PASS'
        s['restore_rule'] = 'PASS'
    else:
        s['convention_after'] = [0, -1]
    return s


# ---------------------------------------------------------------------------
# The held migration file and the bound queries.
# ---------------------------------------------------------------------------
class HeldMigration(unittest.TestCase):
    def test_held_outside_every_apply_path(self):
        held = u.MIGRATION_PATH
        self.assertEqual(held.parent.name, 'held')
        self.assertEqual(held.parent.parent, REPO / 'server/postgres/migrations')
        top = REPO / 'server/postgres/migrations'
        self.assertNotIn(held.name, [p.name for p in top.glob('*.sql')])
        dockerfile = (REPO / 'server/Dockerfile-db').read_text()
        self.assertIn('COPY ./postgres/migrations/*.sql /docker-entrypoint-initdb.d/', dockerfile)
        runner = (REPO / 'server/bin/run-migrations.sh').read_text()
        self.assertIn('-maxdepth 1 -name "*.sql"', runner)
        self.assertEqual(sorted(p.name for p in (top / 'held').iterdir()), [held.name])

    def test_marked_and_never_applied_outside_the_rehearsal(self):
        head = MIGRATION.decode().split('BEGIN;')[0]
        self.assertIn('RULING R-I. NEVER APPLY OUTSIDE THE REHEARSAL.', head)
        self.assertNotIn('vote_sign_unflip', '\n'.join(
            p.read_text() for p in (REPO / 'server/postgres/migrations').glob('*.sql')))

    def test_one_transaction_and_its_guard(self):
        body = u.migration_body(MIGRATION)
        self.assertNotIn('BEGIN;', body)
        self.assertNotIn('COMMIT;', body)
        self.assertTrue(body.lstrip('\n').startswith('SET TRANSACTION ISOLATION LEVEL READ COMMITTED;\n'))
        for needle in ("SET LOCAL lock_timeout = '30s'", 'FOR UPDATE', "ERRCODE = 'P0785'", "ERRCODE = 'P0786'",
                       "ERRCODE = 'P0787'", "ERRCODE = 'P0788'", 'UPDATE public.votes SET vote = -vote WHERE vote IN (-1, 1);',
                       'UPDATE public.votes_latest_unique SET vote = -vote WHERE vote IN (-1, 1);'):
            self.assertIn(needle, body)
        # The guard precedes every write; the ledger row is the last statement.
        self.assertLess(body.index("'P0785'"), body.index('UPDATE public.votes'))
        statements = [s.strip() for s in body.strip().split(';\n') if s.strip()]
        self.assertTrue(statements[-1].startswith('INSERT INTO public.schema_migrations'))
        # Only the two vote columns move; the lookalikes are never named.
        for lookalike in ('comments', 'participants', 'report_comment_selections', 'weight_x_32767 ='):
            self.assertNotIn(lookalike, body.replace('-- ', ''))

    def test_ledger_row_carries_the_self_checksum(self):
        row = re.search(r"VALUES \('000024_vote_sign_unflip', '([a-f0-9]{64})'", MIGRATION.decode())
        self.assertIsNotNone(row)
        self.assertEqual(row.group(1), u.ledger_checksum(MIGRATION))
        self.assertNotEqual(row.group(1), u.digest(MIGRATION))

    def test_body_shape_refusals(self):
        for raw in (b'BEGIN;\nSELECT 1;\n', b'SELECT 1;\nCOMMIT;\n', b'BEGIN;\nCOMMIT;\nBEGIN;\nCOMMIT;\n',
                    b'SELECT 0;\nBEGIN;\nSELECT 1;\nCOMMIT;\n', b'COMMIT;\nBEGIN;\n'):
            with self.assertRaises(ValueError):
                u.migration_body(raw)
        with self.assertRaises(ValueError):
            u.ledger_checksum(b'no marker\n')

    def test_print_migration_and_sql(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(u.main(['--print-migration']), 0)
        text = out.getvalue()
        self.assertTrue(text.startswith(f'-- migration_sql_sha256 {u.digest(MIGRATION)}\n'
                                        f'-- ledger_checksum {u.ledger_checksum(MIGRATION)}\n'))
        self.assertTrue(text.endswith(MIGRATION.decode()))
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(u.main(['--print-sql']), 0)
        text = out.getvalue()
        self.assertTrue(text.startswith(f'-- queries_sha256 {u.digest(QUERIES)}\n'))
        # The vote_insert round trip is never a production-day query and is only
        # ever printed inside a transaction that rolls back.
        block = re.search(r'\nBEGIN;\n(.*?)\nROLLBACK;\n', text, re.S)
        self.assertIsNotNone(block)
        self.assertEqual(text.count('vote_insert('), 1)
        self.assertIn('vote_insert(', block.group(1))
        self.assertIn('NEVER on production', text)
        self.assertNotRegex(text, r'name: insert_(roundtrip|readback)[^\n]*\(day\)')


class Queries(unittest.TestCase):
    def test_named_blocks_and_day_set(self):
        q = u.parse_queries(QUERIES)
        self.assertEqual(set(q), u.REQUIRED_QUERIES)
        self.assertEqual({n for n, (_, day) in q.items() if day},
                         {'convention', 'unflip_ledger', 'raw_counts', 'restore_detection'})

    def test_no_literal_percent_and_one_writer(self):
        q = u.parse_queries(QUERIES)
        for name, (sql, _) in q.items():
            self.assertNotIn('%', re.sub(r'%\([a-z_]+\)s', '', sql), name)
            writes = re.search(r'\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b', sql)
            if name == 'engine_clear':
                self.assertEqual(sql.split('\n'), [f'DELETE FROM public.{t} WHERE math_env = %(label)s;' for t in
                                                    ('math_main', 'math_bidtopid', 'math_ptptstats', 'math_ticks')])
            else:
                self.assertIsNone(writes, name)

    def test_duplicate_or_missing_blocks_refused(self):
        with self.assertRaises(ValueError):
            u.parse_queries(QUERIES + b'\n-- name: session\nSELECT 1;\n')
        with self.assertRaises(ValueError):
            u.parse_queries(b'-- name: session\nSELECT 1;\n')


# ---------------------------------------------------------------------------
# Registry, run-spec and job binding.
# ---------------------------------------------------------------------------
class Registry(unittest.TestCase):
    def setUp(self):
        self.entry = json.loads((HERE / 'jobs.json').read_bytes())['jobs']['unflip-rehearsal-v1']

    def test_entry_validates_and_binds_the_files(self):
        self.assertEqual(validate_job(self.entry), self.entry)
        s = self.entry['run_spec']
        self.assertEqual((self.entry['kind'], self.entry['max_seconds']), ('unflip-rehearsal', 14400))
        self.assertEqual(s['migration_sql_sha256'], u.digest(MIGRATION))
        self.assertEqual(s['queries_sha256'], u.digest(QUERIES))
        # PR-A's file is not on edge: the DDL digest stays zero. The operator never
        # replaces registry digests (unflip_operator.registry_binding), so no launch.
        self.assertEqual(s['convention_ddl_sha256'], u.ZERO)
        self.assertEqual(s, dict(u.TEMPLATE_RUN_SPEC, **u.file_digests()))

    def test_template_is_never_launched(self):
        with self.assertRaises(BoundaryError) as e:
            refuse_placeholder(validate_job(self.entry))
        self.assertEqual(str(e.exception), 'PLACEHOLDER_IMAGE')
        filled = job()
        self.assertEqual(refuse_placeholder(filled), filled)
        for change in ({'convention_ddl_sha256': u.ZERO}, {'snapshot_created_ms': u.MS_FLOOR},
                       {'certification_sha256': sorted(['1' * 64, CERT[0]])}, {'r2_host_sha256': u.ZERO},
                       {'engine_image': 'sha256:' + u.ZERO}):
            with self.assertRaises(BoundaryError, msg=change):
                refuse_placeholder(job(**change))

    def test_job_decodes_with_fresh_identity(self):
        j = job()
        raw = json.dumps(dict(j, run_id='9' * 32)).encode()
        self.assertEqual(decode_job(raw)['run_id'], '9' * 32)


class RunSpec(unittest.TestCase):
    def test_closed_fields(self):
        s = spec()
        self.assertEqual(u.validate_run_spec(s), s)
        for bad in ({'extra': 1}, {'mode': 'wet'}, {'restore_rule': 1}, {'snapshot_sha256': 'A' * 64},
                    {'db_host_sha256': 'x'}, {'r2_host_sha256': None}, {'r2_host_sha256': 'b' * 64},
                    {'snapshot_created_ms': 1}, {'max_snapshot_age_seconds': 200000},
                    {'instance_class': 'm5.large'}, {'storage_type': 'st1'}, {'allocated_storage_gb': 10},
                    {'min_free_storage_gb': 61}, {'certification_conversations': 0, 'certification_sha256': []},
                    {'certification_sha256': list(reversed(CERT))}, {'certification_sha256': [CERT[0], CERT[0]]},
                    {'certification_sha256': CERT[:1]}, {'sample_conversations': 1},
                    {'lock_wait_budget_ms': 99}, {'server_image': 'd' * 64},
                    {'restore_observed': {'duration_s': 1}}):
            with self.assertRaises((ValueError, TypeError), msg=bad):
                u.validate_run_spec(dict(spec(), **bad))
        with self.assertRaises(ValueError):
            u.validate_run_spec(dict(spec(), restore_observed=dict(spec()['restore_observed'], duration_s=-1)))

    def test_dry_mode_has_no_restore_rule(self):
        self.assertEqual(u.validate_run_spec(spec(mode='dry'))['restore_rule'], False)
        with self.assertRaises(ValueError):
            u.validate_run_spec(dict(spec(mode='dry'), restore_rule=True, r2_host_sha256='c' * 64))
        with self.assertRaises(ValueError):
            u.validate_run_spec(dict(spec(mode='dry'), r2_host_sha256='c' * 64))
        self.assertEqual(u.validate_run_spec(dict(spec(), restore_rule=False, r2_host_sha256=None))['mode'], 'flip')

    def test_job_refuses_a_bad_run_spec(self):
        with self.assertRaises(BoundaryError) as e:
            job(mode='wet')
        self.assertEqual(str(e.exception), 'RUN_SPEC')


# ---------------------------------------------------------------------------
# The receipt: built from a state, closed, bound and recomputed.
# ---------------------------------------------------------------------------
class Receipt(unittest.TestCase):
    def test_flip_and_dry_pass(self):
        for mode in ('flip', 'dry'):
            j = job(mode=mode)
            r = u.build_receipt(passing_state(mode), j)
            self.assertEqual(r['verdict'], 'PASS', mode)
            self.assertEqual(decode_receipt(u.encoded(r), j), r)
            self.assertTrue(receipt_passed(r, j))
        r = u.build_receipt(passing_state('dry'), job(mode='dry'))
        self.assertEqual({k for k, v in r['assertions'].items() if v == 'PASS'}, set(u.DRY_ASSERTIONS))
        self.assertEqual(r['restore_rule'], 'NOT_RUN')

    def test_numbers_and_fixed_names_only(self):
        r = u.build_receipt(passing_state(), job())
        text = u.encoded(r).decode()
        for forbidden in CERT_IDS + ('host', 'snapshot_id', '"zid"', 'arn:', 'db-'):
            self.assertNotIn(forbidden, text)
        self.assertEqual(set(r), set(u.RECEIPT))
        self.assertEqual(set(r['pre']), set(u.SECTION))
        self.assertEqual(r['pre']['pca2_cases'], 2)
        self.assertEqual(r['restore'], {'duration_s': 812.5, 'storage_growth_s': 640.0, 'class_ok': True,
                                        'storage_ok': True, 'free_storage_gb_before': 48.5})

    def test_every_condition_refuses(self):
        j = job()
        cases = {
            'aggregates': lambda s: s['post'].update(agg_sha256='0' * 64),
            'hashes': lambda s: s['post'].update(hashes_sha256='0' * 64),
            'participants': lambda s: s['post'].update(participants=41),
            'pca2': lambda s: s['post_cases']['pca2'].update({'1': '0' * 64}),
            'math': lambda s: s['post_cases'].update(math={}),
            'exports': lambda s: s['post_cases']['exports'].pop('0'),
            'convention': lambda s: s.update(convention_after=[2, -1]),
            'insert': lambda s: s.update(insert_roundtrip='FAIL'),
            'rerun': lambda s: s.update(rerun={'refused': False, 'sqlstate_class': 'NONE'}),
            'mirror': lambda s: s['migrate'].update(counts_mirrored=False),
            'lock': lambda s: s['migrate'].update(max_lock_wait_ms=30001),
            'wall': lambda s: s['migrate'].update(wall_s=u.WALL_BUDGET_SECONDS + 1),
            'stale': lambda s: s['preflight'].update(snapshot_age_s=129601),
            'storage': lambda s: s['preflight'].update(free_storage_gb=29.9),
            'rule': lambda s: s.update(restore_rule='REFUSE'),
            'rule-missing': lambda s: s.update(restore_rule='NOT_RUN'),
            'refusal': lambda s: s['refusals'].append('COLLECTION_FAILED'),
        }
        for name, change in cases.items():
            s = passing_state()
            change(s)
            r = u.build_receipt(s, j)
            self.assertEqual(r['verdict'], 'REFUSE', name)
            self.assertFalse(receipt_passed(r, j), name)

    def test_case_inventory_must_be_complete_on_both_legs(self):
        j = job()
        for name, key in (('pca2', '1'), ('exports', '0'), ('math', u.zid_key(104))):
            for legs in (('pre_cases',), ('post_cases',), ('pre_cases', 'post_cases')):
                with self.subTest(case=name, legs=legs):
                    s = passing_state()
                    for leg in legs:
                        del s[leg][name][key]
                    r = u.build_receipt(s, j)
                    self.assertEqual((r['assertions'][name], r['verdict']), ('FAIL', 'REFUSE'))
        # A selection smaller than the job asked for fails every case assertion.
        for change in ({'certification': [101], 'sample': [101, 102, 103, 104, 105, 106]},
                       {'certification': [101, 102], 'sample': [101, 102, 103]},
                       {'certification': [101, 107], 'sample': [101, 102, 103, 104, 105, 106]}):
            s = passing_state()
            s['zids'] = change
            r = u.build_receipt(s, j)
            self.assertEqual({r['assertions'][k] for k in ('pca2', 'math', 'exports')}, {'FAIL'}, change)
            self.assertEqual(r['verdict'], 'REFUSE')

    def test_restore_shape_and_rule_by_configuration(self):
        observed = dict(spec()['restore_observed'], instance_class='db.t3.medium')
        r = u.build_receipt(passing_state(), job(restore_observed=observed))
        self.assertEqual((r['restore']['class_ok'], r['verdict']), (False, 'REFUSE'))
        s = passing_state()
        s['restore_rule'] = 'NOT_RUN'
        r = u.build_receipt(s, job(restore_rule=False, r2_host_sha256=None))
        self.assertEqual(r['verdict'], 'PASS')

    def test_incomplete_without_a_named_refusal(self):
        for missing in ('pre', 'migrate', 'post'):
            s = passing_state()
            s[missing] = None
            self.assertEqual(u.build_receipt(s, job())['verdict'], 'INCOMPLETE', missing)
        s = passing_state()
        s['preflight'] = None
        r = u.build_receipt(s, job())
        self.assertEqual(r['verdict'], 'INCOMPLETE')
        self.assertFalse(receipt_passed(r, job()))

    def test_closed_decoder_refuses_tampering(self):
        j = job()
        good = u.build_receipt(passing_state(), j)
        tampering = [
            lambda r: r.update(extra=1),
            lambda r: r.pop('cleanup_confirmed'),
            lambda r: r.update(schema='polis-unflip-rehearsal-receipt/2'),
            lambda r: r.update(job_sha256='0' * 64),
            lambda r: r.update(run_id='e' * 32),
            lambda r: r.update(mode='dry'),
            lambda r: r.update(snapshot_sha256='0' * 64),
            lambda r: r['pre'].update(zid=1),
            lambda r: r['pre'].update(agg_sha256='host-name'),
            lambda r: r['pre'].update(pca2_cases=0),
            lambda r: r['migrate'].update(wal_bytes=-1),
            lambda r: r['migrate'].update(wall_s=float('nan')),
            lambda r: r['migrate'].update(counts_mirrored=1),
            lambda r: r.update(rerun_sqlstate_class='55'),
            lambda r: r.update(rerun_sqlstate_class='lowercase'),
            lambda r: r['assertions'].update(pca2='MAYBE'),
            lambda r: r['assertions'].pop('math'),
            lambda r: r.update(restore_rule='SKIPPED'),
            lambda r: r.update(refusals=['A free-text reason']),
            lambda r: r.update(refusals=['WALL_BUDGET', 'LOCK_BUDGET']),
            lambda r: r['restore'].update(class_ok=False),
            lambda r: r['restore'].update(duration_s=1.0),
            lambda r: r.update(cleanup_confirmed='yes'),
            lambda r: r['assertions'].update(math='FAIL'),     # a false PASS
            lambda r: r.update(verdict='INCOMPLETE'),
            lambda r: r.update(verdict='READY'),
        ]
        for n, change in enumerate(tampering):
            r = copy.deepcopy(good)
            change(r)
            with self.assertRaises((ValueError, TypeError, KeyError), msg=n):
                decode_receipt(json.dumps(r, allow_nan=True).encode(), j)
        refused = u.build_receipt(dict(passing_state(), refusals=['LOCK_BUDGET']), j)
        r = dict(refused, verdict='PASS')
        with self.assertRaises(ValueError):
            u.validate_receipt(r, j)
        with self.assertRaises(ValueError):
            u.validate_receipt(good, job(mode='dry'))

    def test_operator_confirmation_does_not_change_the_verdict(self):
        j = job()
        r = dict(u.build_receipt(passing_state(), j), cleanup_confirmed=True)
        self.assertEqual(u.validate_receipt(r, j)['verdict'], 'PASS')


class BoxState(unittest.TestCase):
    def test_state_round_trip_and_closed_decode(self):
        s = passing_state()
        self.assertEqual(u.decode_state(u.encoded(s)), s)
        for raw in (b'{"schema": 1, "schema": 2}', b'[]', u.encoded(dict(s, extra=1)),
                    u.encoded(dict(s, schema='other')), b'{"a": NaN}', b'x' * (u.MAX_STATE_BYTES + 1)):
            with self.assertRaises(ValueError):
                u.decode_state(raw)

    def test_engine_outputs_merge_closed(self):
        s = passing_state()
        math_cases = s['pre_cases'].pop('math')
        s['post_cases'].pop('math')
        self.assertEqual(len(math_cases), 6)
        r = image_verifier.verify(s, [{'which': 'pre', 'math': math_cases, 'refusals': []},
                                      {'which': 'post', 'math': math_cases, 'refusals': []}], job())
        self.assertEqual((r['verdict'], r['assertions']['math']), ('PASS', 'PASS'))
        s = passing_state()
        r = image_verifier.verify(s, [{'which': 'post', 'math': {}, 'refusals': ['COLLECTION_FAILED']}], job())
        self.assertEqual((r['verdict'], r['refusals']), ('REFUSE', ['COLLECTION_FAILED']))
        for bad in ({'which': 'mid', 'math': {}, 'refusals': []}, {'which': 'pre', 'math': {'1': 'x'}, 'refusals': []},
                    {'which': 'pre', 'math': {}, 'refusals': ['free text']}, {'which': 'pre', 'math': {}}):
            with self.assertRaises(ValueError):
                u.merge_engine(passing_state(), bad)

    def test_pca2_digest_ignores_ticks_and_etag_only(self):
        import gzip
        body = {'pca': {'comps': [[0.5]]}, 'math_tick': 7, 'caching_tick': 3, 'lastVoteTimestamp': 1}
        base = image_reader.pca2_digest(200, json.dumps(body).encode())
        later = dict(body, math_tick=8, caching_tick=4)
        self.assertEqual(image_reader.pca2_digest(200, json.dumps(later, indent=1).encode()), base)
        self.assertEqual(image_reader.pca2_digest(200, gzip.compress(json.dumps(later).encode()), 'gzip'), base)
        for changed in (dict(body, pca={'comps': [[-0.5]]}), dict(body, lastVoteTimestamp=2)):
            self.assertNotEqual(image_reader.pca2_digest(200, json.dumps(changed).encode()), base)
        self.assertNotEqual(image_reader.pca2_digest(304, json.dumps(body).encode()), base)

    def test_image_actions_are_closed(self):
        for module, action in ((image_reader, 'read'), (image_producer, 'produce'), (image_verifier, 'verify')):
            with mock.patch.object(sys, 'argv', ['x', 'other']), self.assertRaises(SystemExit):
                try:
                    module.main()
                except ValueError:
                    raise SystemExit(1)
        with self.assertRaises(ValueError):
            image_producer.produce('engine-mid', passing_state(), connect=None, queries=QUERIES, rebuild=None)


# ---------------------------------------------------------------------------
# The operator's local refusals (no AWS: fake clients only).
# ---------------------------------------------------------------------------
class FakeRds:
    def __init__(self, instances=(), snapshots=()):
        self.instances, self.snapshots, self.calls = list(instances), list(snapshots), []

    def get_paginator(self, name):
        rds = self

        class Pager:
            def paginate(self, **kw):
                rds.calls.append((name, kw))
                if name == 'describe_db_instances':
                    return [{'DBInstances': rds.instances}]
                return [{'DBSnapshots': rds.snapshots}]
        return Pager()

    def list_tags_for_resource(self, ResourceName):
        for i in self.instances:
            if i['DBInstanceArn'] == ResourceName:
                return {'TagList': i['TagList']}
        raise AssertionError('unknown resource')


def instance(name, box='box1', run='f' * 32, status='available', groups=('sg',)):
    tags = [{'Key': 'polis:probe-box', 'Value': box}] + ([{'Key': 'polis:probe-run', 'Value': run}] if run else [])
    return {'DBInstanceIdentifier': name, 'DBInstanceArn': 'arn:aws:rds:::db:' + name, 'TagList': tags,
            'DBInstanceStatus': status, 'VpcSecurityGroups': [{'VpcSecurityGroupId': g} for g in groups]}


class Operator(unittest.TestCase):
    def test_leftover_instances_refuse_every_launch(self):
        rds = FakeRds([instance('polis-unflip-11111111'), instance('other', box='box2')])
        self.assertEqual(op.leftovers(rds, 'box1'), ['polis-unflip-11111111'])
        self.assertEqual(op.leftovers(rds, 'box1', allow_run='f' * 32), [])
        self.assertEqual(op.leftovers(rds, 'box3'), [])
        rds = FakeRds([instance('polis-unflip-22222222', run=None)])
        self.assertEqual(op.leftovers(rds, 'box1', allow_run='f' * 32), ['polis-unflip-22222222'])
        with self.assertRaises(op.Refused) as e:
            op.refuse_leftovers(rds, 'box1')
        self.assertEqual(e.exception.code, 'REHEARSAL_INSTANCE_REMAINS')

    def test_snapshot_freshness(self):
        now = 2_000_000_000.0
        import datetime as dt
        fresh = {'DBSnapshotIdentifier': 'rds:x-1', 'Status': 'available', 'SnapshotType': 'automated',
                 'SnapshotCreateTime': dt.datetime.fromtimestamp(now - 3600, dt.timezone.utc)}
        old = dict(fresh, DBSnapshotIdentifier='rds:x-0',
                   SnapshotCreateTime=dt.datetime.fromtimestamp(now - 200000, dt.timezone.utc))
        pending = dict(fresh, DBSnapshotIdentifier='rds:x-2', Status='creating',
                       SnapshotCreateTime=dt.datetime.fromtimestamp(now - 60, dt.timezone.utc))
        snap = op.latest_snapshot(FakeRds(snapshots=[old, fresh, pending]), 'source', 129600, now=now)
        self.assertEqual(snap['DBSnapshotIdentifier'], 'rds:x-1')
        with self.assertRaises(op.Refused) as e:
            op.latest_snapshot(FakeRds(snapshots=[old]), 'source', 129600, now=now)
        self.assertEqual(e.exception.code, 'SNAPSHOT_STALE')
        with self.assertRaises(op.Refused):
            op.latest_snapshot(FakeRds(snapshots=[]), 'source', 129600, now=now)

    def test_failed_cleanup_in_the_ledger_keeps_refusing(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            op.refuse_ledger(state)
            op.append_ledger(state, {'event': 'cleanup', 'run_id': 'f' * 32, 'confirmed': False})
            with self.assertRaises(op.Refused) as e:
                op.refuse_ledger(state)
            self.assertEqual(e.exception.code, 'CLEANUP_UNCONFIRMED')
            op.append_ledger(state, {'event': 'cleanup', 'run_id': 'f' * 32, 'confirmed': True})
            op.refuse_ledger(state)

    def test_job_binding_checks_local_files(self):
        j = job(convention_ddl_sha256=u.digest(DDL))
        op.check_job_files(j, ddl=DDL)
        for change, code in (({'migration_sql_sha256': 'f' * 64}, 'MIGRATION_DIGEST'),
                             ({'queries_sha256': 'f' * 64}, 'QUERIES_DIGEST'),
                             ({'convention_ddl_sha256': 'f' * 64}, 'DDL_DIGEST')):
            with self.assertRaises(op.Refused) as e:
                op.check_job_files(job(**change), ddl=DDL)
            self.assertEqual(e.exception.code, code)

    def test_secret_document_shape(self):
        doc = {'host': 'h1.example', 'port': 5432, 'dbname': 'polis', 'username': 'm', 'password': 'p' * 44,
               'r2': {'host': 'h2.example', 'port': 5432, 'dbname': 'polis', 'username': 'm', 'password': 'q' * 44}}
        s = spec(db_host_sha256=u.digest(b'h1.example'), r2_host_sha256=u.digest(b'h2.example'))
        self.assertEqual(op.validate_secret(doc, s)['host'], 'h1.example')
        for bad in (dict(doc, host='h3.example'), dict(doc, r2=None), dict(doc, extra=1),
                    dict(doc, port='5432'), dict(doc, port=5433), dict(doc, password='p\nq')):
            with self.assertRaises(op.Refused, msg=bad):
                op.validate_secret(bad, s)
        dry = spec(mode='dry', db_host_sha256=u.digest(b'h1.example'))
        self.assertNotIn('r2', op.validate_secret({k: v for k, v in doc.items() if k != 'r2'}, dry))
        with self.assertRaises(op.Refused):
            op.validate_secret(doc, dry)


class DeletingRds(FakeRds):
    """Instances disappear `after` describes once deleted (None: never)."""

    def __init__(self, instances, after=1):
        super().__init__(instances)
        self.after, self.deleted, self.seen = after, set(), {}

    def describe_db_instances(self, DBInstanceIdentifier):
        if DBInstanceIdentifier in self.deleted:
            self.seen[DBInstanceIdentifier] = self.seen.get(DBInstanceIdentifier, 0) + 1
            if self.after is not None and self.seen[DBInstanceIdentifier] >= self.after:
                self.instances = [i for i in self.instances if i['DBInstanceIdentifier'] != DBInstanceIdentifier]
                error = Exception('gone')
                error.response = {'Error': {'Code': 'DBInstanceNotFound'}}
                raise error
        return {'DBInstances': [i for i in self.instances if i['DBInstanceIdentifier'] == DBInstanceIdentifier]}

    def delete_db_instance(self, **kw):
        self.calls.append(('delete', kw))
        self.deleted.add(kw['DBInstanceIdentifier'])


class Secrets:
    def __init__(self):
        self.values = []

    def put_secret_value(self, SecretId, SecretString):
        self.values.append(SecretString)


class RestoreRds:
    """Restore: the first call rejects AllocatedStorage, the second succeeds; the
    copy is available after one describe, at the snapshot's 20 GB until modified."""

    def __init__(self):
        self.calls, self.state = [], {}

    def restore_db_instance_from_db_snapshot(self, **kw):
        self.calls.append(('restore', kw))
        if 'AllocatedStorage' in kw:
            e = Exception('rejected')
            e.response = {'Error': {'Code': 'InvalidParameterCombination'}}
            raise e
        self.state[kw['DBInstanceIdentifier']] = {
            'DBInstanceIdentifier': kw['DBInstanceIdentifier'], 'DBInstanceStatus': 'available',
            'AllocatedStorage': 20, 'DBInstanceClass': kw['DBInstanceClass'], 'StorageType': kw['StorageType'],
            'Endpoint': {'Address': kw['DBInstanceIdentifier'] + '.generated.example', 'Port': 5432},
            'DBName': 'polis', 'MasterUsername': 'generated_master', 'PendingModifiedValues': {}}

    def modify_db_instance(self, **kw):
        self.calls.append(('modify', kw))
        if 'AllocatedStorage' in kw:
            self.state[kw['DBInstanceIdentifier']]['AllocatedStorage'] = kw['AllocatedStorage']

    def describe_db_instances(self, DBInstanceIdentifier):
        return {'DBInstances': [self.state[DBInstanceIdentifier]]}


def pinned_registry(ddl, **spec_changes):
    entry = copy.deepcopy(op.registry_entry())
    for role, n in (('reader', '1'), ('producer', '2'), ('verifier', '3')):
        entry[role]['image'] = entry[role]['image'].split('@')[0] + '@sha256:' + n * 64
    entry['run_spec'].update(convention_ddl_sha256=u.digest(ddl), **spec_changes)
    return entry


class RegistryBinding(unittest.TestCase):
    """The registry digests are the only source of truth; restore refuses before any RDS call."""
    PRA = b'-- generated stand-in for the committed PR-A file\n'

    def restore(self, ddl, registry=None):
        import tempfile
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'ddl.sql'
            path.write_bytes(ddl)
            a = SimpleNamespace(run_id='f' * 32, mode='flip', ddl=str(path), server_image='sha256:' + 'd' * 64,
                                engine_image='sha256:' + 'e' * 64, certification=list(CERT_IDS),
                                no_restore_rule=False, profile='p', source_db_instance='s',
                                max_snapshot_age_seconds=129600)
            import contextlib
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(
                    op, 'client', side_effect=AssertionError('an RDS call before the binding')))
                if registry is not None:
                    stack.enter_context(mock.patch.object(op, 'registry_entry', return_value=registry))
                with self.assertRaises(op.Refused) as e:
                    op.cmd_restore(a, Cleanup.CFG, Path(d))
            return e.exception.code

    def test_template_refuses_before_any_rds_call(self):
        self.assertEqual(self.restore(self.PRA), 'PLACEHOLDER_IMAGE')
        entry = pinned_registry(self.PRA)
        entry['run_spec']['convention_ddl_sha256'] = u.ZERO
        self.assertEqual(self.restore(self.PRA, entry), 'PLACEHOLDER_DIGEST')

    def test_the_stand_in_is_never_a_binding(self):
        self.assertEqual(self.restore(DDL, pinned_registry(DDL)), 'STANDIN_DDL')

    def test_local_files_must_be_the_pinned_bytes(self):
        self.assertEqual(self.restore(b'-- another file\n', pinned_registry(self.PRA)), 'DDL_DIGEST')
        self.assertEqual(self.restore(self.PRA, pinned_registry(self.PRA, migration_sql_sha256='f' * 64)),
                         'MIGRATION_DIGEST')
        self.assertEqual(self.restore(self.PRA, pinned_registry(self.PRA, queries_sha256='f' * 64)),
                         'QUERIES_DIGEST')

    def test_a_drafted_job_must_carry_the_registry_values(self):
        pinned = pinned_registry(self.PRA)
        j = dict(pinned, run_id='f' * 32, run_spec=dict(spec(), convention_ddl_sha256=u.digest(self.PRA)))
        with mock.patch.object(op, 'registry_entry', return_value=pinned):
            op.check_registry(j)
            for change, code in (({'convention_ddl_sha256': u.digest(DDL)}, 'DDL_DIGEST'),
                                 ({'queries_sha256': 'f' * 64}, 'QUERIES_DIGEST')):
                with self.assertRaises(op.Refused) as e:
                    op.check_registry(dict(j, run_spec=dict(j['run_spec'], **change)))
                self.assertEqual(e.exception.code, code)
            with self.assertRaises(op.Refused) as e:
                op.check_registry(dict(j, reader={'image': 'localhost/x@sha256:' + '9' * 64, 'args': ['read']}))
            self.assertEqual(e.exception.code, 'IMAGE_BINDING')


class Restore(unittest.TestCase):
    def test_restore_sizes_sets_a_one_time_password_and_drafts_a_hashed_job(self):
        import datetime as dt
        rds = RestoreRds()
        cfg = dict(Cleanup.CFG)
        snap = {'DBSnapshotIdentifier': 'rds:generated-snapshot', 'SnapshotCreateTime':
                dt.datetime.fromtimestamp(NOW_MS / 1000 - 3600, dt.timezone.utc)}
        clock = iter(range(0, 10**6, 7))
        values = op.registry_entry()['run_spec']
        pra = b'-- generated stand-in for the committed PR-A file\n'
        pinned = pinned_registry(pra)
        entry, observed = op.restore_one(rds, cfg, cfg['REHEARSAL_INSTANCE'], snap, 'f' * 32, values,
                                         sleep=lambda s: None, clock=lambda: next(clock))
        first, second = rds.calls[0][1], rds.calls[1][1]
        self.assertEqual(first['AllocatedStorage'], 60)
        self.assertNotIn('AllocatedStorage', second)
        self.assertEqual((second['PubliclyAccessible'], second['MultiAZ'], second['DeletionProtection'],
                          second['VpcSecurityGroupIds'], second['DBSubnetGroupName'], second['StorageType'],
                          second['DBInstanceClass']), (False, False, False, ['sg'], 'subnets', 'gp3', 'db.t3.large'))
        self.assertEqual(second['Tags'], [{'Key': 'polis:probe-box', 'Value': 'box1'},
                                          {'Key': 'polis:probe-run', 'Value': 'f' * 32}])
        modifies = [kw for n, kw in rds.calls if n == 'modify']
        self.assertEqual(modifies[0], {'DBInstanceIdentifier': 'polis-unflip-box1', 'AllocatedStorage': 60,
                                       'ApplyImmediately': True})
        self.assertEqual((modifies[1]['BackupRetentionPeriod'], modifies[1]['ApplyImmediately']), (0, True))
        self.assertRegex(modifies[1]['MasterUserPassword'], r'^[A-Za-z0-9_-]{40,}$')
        self.assertEqual(entry['password'], modifies[1]['MasterUserPassword'])
        self.assertEqual((observed['allocated_storage_gb'], observed['storage_type']), (60, 'gp3'))
        r2_entry = dict(entry, host='polis-unflip-box1-r2.generated.example')
        with mock.patch.object(op, 'registry_entry', return_value=pinned):
            j = op.draft_job('f' * 32, mode='flip', restore_rule=True, snap=snap, entry=entry, r2_entry=r2_entry,
                             observed=observed, certification=list(CERT_IDS), ddl=pra,
                             server_image='sha256:' + 'd' * 64, engine_image='sha256:' + 'e' * 64)
        for k in ('migration_sql_sha256', 'queries_sha256', 'convention_ddl_sha256'):
            self.assertEqual(j['run_spec'][k], pinned['run_spec'][k])
        self.assertEqual(j['reader'], pinned['reader'])
        text = json.dumps(j)
        for identifier in ('generated-snapshot', 'generated.example', 'generated_master', entry['password']) + CERT_IDS:
            self.assertNotIn(identifier, text)
        self.assertEqual(j['run_spec']['certification_sha256'], CERT)
        self.assertEqual(j['run_spec']['db_host_sha256'], hashlib.sha256(entry['host'].encode()).hexdigest())
        self.assertEqual(op.validate_secret(dict(entry, r2=r2_entry), j['run_spec'])['r2']['host'], r2_entry['host'])


class Cleanup(unittest.TestCase):
    CFG = {'REGION': 'us-east-1', 'BOX_ID': 'box1', 'REHEARSAL_SECRET_ARN': 'secret', 'REHEARSAL_SECURITY_GROUP': 'sg',
           'REHEARSAL_INSTANCE': 'polis-unflip-box1', 'REHEARSAL_INSTANCE_R2': 'polis-unflip-box1-r2',
           'DB_SUBNET_GROUP': 'subnets'}

    def run_cleanup(self, rds, state):
        from types import SimpleNamespace
        clock = iter(range(0, 10**6, 60))
        secrets = Secrets()
        err = io.StringIO()
        with mock.patch.object(sys, 'stderr', err):
            result = op.cmd_cleanup(SimpleNamespace(run_id='f' * 32, profile='p'), self.CFG, state, rds=rds,
                                    secrets_client=secrets, sleep=lambda s: None, clock=lambda: next(clock))
        return result, secrets, err.getvalue()

    def test_cleanup_deletes_this_run_and_empties_the_secret(self):
        import tempfile
        rds = DeletingRds([instance('polis-unflip-box1'), instance('polis-unflip-box1-r2'),
                           instance('elsewhere', box='box2')])
        with tempfile.TemporaryDirectory() as d:
            result, secrets, err = self.run_cleanup(rds, Path(d))
            self.assertEqual(result, {'cleanup': 'PASS', 'run_id': 'f' * 32})
            self.assertEqual(sorted(kw['DBInstanceIdentifier'] for n, kw in rds.calls if n == 'delete'),
                             ['polis-unflip-box1', 'polis-unflip-box1-r2'])
            self.assertTrue(all(kw['SkipFinalSnapshot'] and kw['DeleteAutomatedBackups']
                                for n, kw in rds.calls if n == 'delete'))
            self.assertEqual(secrets.values, ['{}'])
            op.refuse_ledger(Path(d))
            self.assertEqual(err, '')

    def test_unconfirmed_cleanup_names_the_instance_and_keeps_refusing(self):
        import tempfile
        rds = DeletingRds([instance('polis-unflip-box1')], after=None)
        with tempfile.TemporaryDirectory() as d:
            result, secrets, err = self.run_cleanup(rds, Path(d))
            self.assertEqual(result['cleanup'], 'REFUSE')
            self.assertIn('polis-unflip-box1', err)
            self.assertEqual(secrets.values, ['{}'])
            with self.assertRaises(op.Refused):
                op.refuse_ledger(Path(d))
            with self.assertRaises(op.Refused):
                op.launch_preflight(self.CFG, 'p', Path(d), rds=FakeRds())

    def test_tags_alone_never_authorize_a_delete(self):
        import tempfile
        cases = [instance('production-like', groups=('sg',)),            # a tagged non-copy identifier
                 instance('polis-unflip-box1', groups=('sg-other',)),     # the copy name outside the rehearsal group
                 instance('polis-unflip-box1-r2', groups=('sg', 'sg-2'))]  # an extra group
        for bad in cases:
            with self.subTest(bad['DBInstanceIdentifier']), tempfile.TemporaryDirectory() as d:
                rds = DeletingRds([bad])
                result, _, err = self.run_cleanup(rds, Path(d))
                self.assertEqual([n for n, _ in rds.calls if n == 'delete'], [])
                self.assertEqual(result['cleanup'], 'REFUSE')
                self.assertIn(bad['DBInstanceIdentifier'], err)
                with self.assertRaises(op.Refused):
                    op.refuse_ledger(Path(d))

    def test_every_launch_checks_leftovers_when_the_stack_has_the_rehearsal(self):
        import tempfile
        import run
        with tempfile.TemporaryDirectory() as d:
            op.launch_preflight({'BOX_ID': 'box1'}, 'p', Path(d), rds=None)   # no rehearsal delta: ledger only
            rds = FakeRds([instance('polis-unflip-ffffffff')])
            with self.assertRaises(op.Refused):
                op.launch_preflight(self.CFG, 'p', Path(d), rds=rds)
            op.launch_preflight(self.CFG, 'p', Path(d), allow_run='f' * 32, rds=rds)
            with mock.patch.object(op, 'client', return_value=rds):
                with self.assertRaises(run.Unknown) as e:
                    run.launch_preflight(self.CFG, 'p', Path(d), {'kind': 'roles-census', 'run_id': 'f' * 32})
                self.assertEqual((e.exception.reason, e.exception.operation),
                                 ('REHEARSAL_INSTANCE_REMAINS', 'REHEARSAL_PREFLIGHT'))
                run.launch_preflight(self.CFG, 'p', Path(d), {'kind': 'unflip-rehearsal', 'run_id': 'f' * 32})

    def test_subcommand_refuses_without_the_rehearsal_config(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            config = Path(d) / 'config.json'
            config.write_text(json.dumps({'REGION': 'us-east-1', 'BOX_ID': 'box1'}))
            out = io.StringIO()
            with redirect_stdout(out):
                rc = op.main(['cleanup', '--config', str(config), '--profile', 'p', '--run-id', 'f' * 32],
                             session_factory=None, watch=None)
            self.assertEqual((rc, out.getvalue()), (2, 'UNFLIP_REFUSED CONFIG_UNKNOWN\n'))


# ---------------------------------------------------------------------------
# The step machine on a disposable PostgreSQL 17 with a generated fixture.
# ---------------------------------------------------------------------------
PG = os.environ.get('POLIS_UNFLIP_REHEARSAL_PG')
MASTER, MASTER_PASSWORD = 'rehearsal_master', 'generated-fixture-only'
CHAIN = sorted(p for p in (REPO / 'server/postgres/migrations').glob('0000*.sql'))
FIXTURE = """
INSERT INTO users (uid, email) SELECT g, 'owner' || g || '@example.invalid' FROM generate_series(1, 2) g;
INSERT INTO conversations (zid, owner, topic) SELECT g, 1, 'generated fixture ' || g FROM generate_series(1, 6) g;
INSERT INTO zinvites (zid, zinvite) VALUES (2, 'genfixcert1'), (5, 'genfixcert2'), (3, 'genfixother');
-- Today's storage sign: agree = -1, disagree = +1, pass = 0, and a few NULLs.
-- Each insert goes through the 000006 rule, so votes_latest_unique follows.
INSERT INTO votes (zid, pid, tid, vote, created)
SELECT z, p, t,
       CASE WHEN (z * 7 + p * 3 + t) % 11 = 0 THEN NULL
            ELSE ((z * 5 + p * 7 + t * 3) % 3) - 1 END,
       1600000000000 + z * 100000 + p * 100 + t
  FROM generate_series(1, 6) z, generate_series(0, 7) p, generate_series(0, 5) t;
-- Revotes: a later row per (zid, pid, tid) with the opposite sign. Staged first: the
-- 000006 rule re-reads its source query, so an INSERT ... SELECT FROM votes would see its own rows.
CREATE TEMP TABLE revotes AS
SELECT zid, pid, tid, -vote AS vote, created + 50 AS created FROM votes WHERE (zid + pid + tid) % 4 = 0 AND vote IN (-1, 1);
INSERT INTO votes (zid, pid, tid, vote, created) SELECT zid, pid, tid, vote, created FROM revotes;
DROP TABLE revotes;
"""


def semantic_cases(cur, zids, raw=False):
    """Generated-fixture 'served' bytes: per conversation, the A/D/P counts per comment,
    as a server reading through the semantic view would serve them. raw=True reads the
    stored column as if it were semantic (a reader that ignores the convention)."""
    out = {}
    for i, zid in enumerate(zids):
        if raw:
            cur.execute("SELECT tid, -vote FROM votes_latest_unique WHERE zid = %s ORDER BY tid, pid", (zid,))
        else:
            cur.execute("SELECT tid, semantic_vote FROM votes_latest_unique_semantic WHERE zid = %s ORDER BY tid, pid",
                        (zid,))
        counts = {}
        for tid, v in cur.fetchall():
            c = counts.setdefault(str(tid), [0, 0, 0])
            if v is not None:
                c[{1: 0, -1: 1, 0: 2}[v]] += 1
        out[str(i)] = hashlib.sha256(json.dumps(counts, sort_keys=True).encode()).hexdigest()
    return out


def export_cases(cur, zids, hard_flip=False):
    """Generated-fixture votes.csv: export sign agree = +1 from the semantic view;
    hard_flip=True is today's `-row.vote` literal."""
    out = {}
    for i, zid in enumerate(zids):
        if hard_flip:
            cur.execute("SELECT created, tid, pid, -vote FROM votes WHERE zid = %s ORDER BY created, tid, pid", (zid,))
        else:
            cur.execute("SELECT created, tid, pid, semantic_vote FROM votes_semantic WHERE zid = %s "
                        "ORDER BY created, tid, pid", (zid,))
        text = 'timestamp,comment-id,voter-id,vote\n' + ''.join(
            f'{c},{t},{p},{"" if v is None else v}\n' for c, t, p, v in cur.fetchall())
        out[str(i)] = hashlib.sha256(text.encode()).hexdigest()
    return out


@unittest.skipUnless(PG, 'opt-in: POLIS_UNFLIP_REHEARSAL_PG names a disposable PostgreSQL 17 superuser URL')
class StepMachine(unittest.TestCase):
    """Every case runs on a fresh clone of the generated-fixture template."""

    @classmethod
    def setUpClass(cls):
        import psycopg2
        from urllib.parse import urlsplit
        cls.psycopg2 = psycopg2
        cls.parts = urlsplit(PG)
        admin = psycopg2.connect(PG)
        admin.autocommit = True
        with admin.cursor() as cur:
            cur.execute("SELECT current_database() = 'probe_test' AND current_setting('is_superuser') = 'on'")
            assert cur.fetchone()[0], 'refusing a non-disposable database'
            cur.execute(f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{MASTER}') THEN "
                        f"GRANT pg_monitor TO {MASTER}; END IF; END $$")
            cur.execute("SELECT 1 FROM pg_database WHERE datname = 'unflip_base'")
            if cur.fetchone() is None:
                cur.execute(f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{MASTER}') THEN "
                            f"CREATE ROLE {MASTER} LOGIN NOSUPERUSER PASSWORD '{MASTER_PASSWORD}'; END IF; END $$")
                # RDS's rds_superuser holds pg_monitor (the WAL size read needs it).
                cur.execute(f'GRANT pg_monitor TO {MASTER}')
                cur.execute('CREATE DATABASE unflip_build')
                build = psycopg2.connect(cls.url('unflip_build', 'postgres'))
                build.autocommit = True
                with build.cursor() as b:
                    for path in CHAIN:
                        b.execute(path.read_text())
                    b.execute(FIXTURE)
                    # The copy's master role owns the schema objects, as on RDS.
                    b.execute(f"""
                        DO $$ DECLARE r record; BEGIN
                          FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p') LOOP
                            EXECUTE format('ALTER TABLE public.%I OWNER TO {MASTER}', r.relname);
                          END LOOP;
                        END $$;
                        GRANT ALL ON SCHEMA public TO {MASTER};""")
                build.close()
                cur.execute(f'ALTER DATABASE unflip_build OWNER TO {MASTER}')
                cur.execute('ALTER DATABASE unflip_build RENAME TO unflip_base')
        cls.admin = admin
        cls.counter = 0

    @classmethod
    def tearDownClass(cls):
        cls.admin.close()

    @classmethod
    def url(cls, db, user=MASTER):
        p = cls.parts
        auth = f'{user}:{MASTER_PASSWORD}@' if user == MASTER else f'{p.username or "postgres"}@'
        return f'postgresql://{auth}{p.hostname}:{p.port}/{db}'

    def clone(self, template='unflip_base'):
        type(self).counter += 1
        name = f'unflip_case_{os.getpid()}_{type(self).counter}'
        with self.admin.cursor() as cur:
            cur.execute(f'CREATE DATABASE {name} TEMPLATE {template} OWNER {MASTER}')
        self.addCleanup(self.drop, name)
        return name

    def drop(self, name):
        with self.admin.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)')

    def connector(self, db, user=MASTER):
        url = self.url(db, user)
        return lambda: self.psycopg2.connect(url)

    def sql(self, db, text, params=None, user=MASTER):
        conn = self.psycopg2.connect(self.url(db, user))
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute(text, params)
                return cur.fetchall() if cur.description else None
        finally:
            conn.close()

    def collectors(self, db, raw_served=False, hard_flip=False):
        def served(phase, zids):
            """A server reading math_main under the rebuild's label (MATH_ENV=probe);
            raw_served=True is a route that reads the stored column itself."""
            conn = self.psycopg2.connect(self.url(db))
            try:
                with conn.cursor() as cur:
                    if raw_served:
                        return semantic_cases(cur, zids, raw=True)
                    out = {}
                    for i, zid in enumerate(zids):
                        # As the route serves it: the blob with the column ticks laid over it.
                        cur.execute("SELECT m.data, m.math_tick, t.math_tick FROM math_main m JOIN math_ticks t "
                                    "USING (zid, math_env) WHERE m.zid = %s AND m.math_env = 'probe'", (zid,))
                        row = cur.fetchone()
                        if row is None:
                            raise RuntimeError('no rebuild under the label')
                        served = dict(row[0], math_tick=row[2], caching_tick=row[1])
                        out[str(i)] = image_reader.pca2_digest(200, json.dumps(served).encode())
                    return out
            finally:
                conn.close()

        def exports(phase, zids):
            conn = self.psycopg2.connect(self.url(db))
            try:
                with conn.cursor() as cur:
                    return export_cases(cur, zids, hard_flip=hard_flip)
            finally:
                conn.close()
        return {'served': served, 'exports': exports}

    def engine(self, db, raw=False):
        """Generated-fixture engine: per conversation a cold blob of semantic counts per
        comment, published under the label. raw=True ignores the convention row."""
        def rebuild(zids, label):
            conn = self.psycopg2.connect(self.url(db))
            conn.autocommit = True
            try:
                with conn.cursor() as cur:
                    for zid in zids:
                        blob = semantic_cases(cur, [zid], raw=raw)['0']
                        # Like the engine: an in-blob wall-clock math_tick and a minted column tick.
                        cur.execute("INSERT INTO math_ticks (zid, math_env, math_tick) VALUES (%s, %s, 1) "
                                    "ON CONFLICT (zid, math_env) DO UPDATE SET math_tick = math_ticks.math_tick + 1 "
                                    "RETURNING math_tick", (zid, label))
                        (tick,) = cur.fetchone()
                        cur.execute("INSERT INTO math_main (zid, math_env, data, last_vote_timestamp, math_tick) "
                                    "VALUES (%s, %s, %s, 0, %s)",
                                    (zid, label, json.dumps({'counts': blob, 'math_tick': time.time_ns()}), tick))
            finally:
                conn.close()
        return rebuild

    def rehearse(self, db, s, r2=None, collectors=None, rebuild=None, **kw):
        return steps.rehearse(self.connector(db), s, ddl=DDL, migration=MIGRATION, queries=QUERIES,
                              collectors=collectors if collectors is not None else self.collectors(db),
                              rebuild=rebuild if rebuild is not None else self.engine(db),
                              connect_r2=self.connector(r2) if r2 else None, interval=0.05, **kw)

    def raw(self, db):
        return self.sql(db, "SELECT 'v', vote, count(*) FROM votes GROUP BY vote UNION ALL "
                            "SELECT 'u', vote, count(*) FROM votes_latest_unique GROUP BY vote ORDER BY 1, 2")

    def receipt(self, state, s):
        j = job(**{k: v for k, v in s.items()})
        r = u.build_receipt(state, j)
        self.assertEqual(decode_receipt(u.encoded(r), j), r)
        return r

    # -- the passing paths -------------------------------------------------
    def test_flip_passes_end_to_end_and_the_restore_rule_on_a_second_copy(self):
        db, r2 = self.clone(), self.clone()
        before = self.raw(db)
        s = spec()
        state = self.rehearse(db, s, r2=r2)
        self.assertEqual(state['refusals'], [])
        r = self.receipt(state, s)
        self.assertEqual(r['verdict'], 'PASS', r)
        self.assertEqual(set(r['assertions'].values()), {'PASS'})
        self.assertEqual((r['rerun_refused'], r['rerun_sqlstate_class'], r['restore_rule']), (True, 'P0', 'PASS'))
        self.assertTrue(r['convention_ddl_applied'])
        self.assertTrue(r['migrate']['counts_mirrored'])
        self.assertEqual((r['pre']['pca2_cases'], r['pre']['math_zids']), (2, 6))
        self.assertEqual(r['pre']['votes'], r['post']['votes'])
        self.assertIsNotNone(r['migrate']['vacuum_s'])
        # The copy really changed sign, and both tables moved together.
        after = self.raw(db)
        flipped = [(t, -v if v in (-1, 1) else v, n) for t, v, n in before]
        self.assertEqual(sorted(after, key=steps.order), sorted(flipped, key=steps.order))
        self.assertEqual(self.sql(db, 'SELECT version, agree_value FROM vote_convention'), [(1, 1)])
        self.assertEqual(self.sql(db, "SELECT checksum FROM schema_migrations WHERE name = '000024_vote_sign_unflip'"),
                         [(u.ledger_checksum(MIGRATION),)])
        self.assertEqual(self.sql(db, 'SELECT version, agree_value FROM vote_convention_history ORDER BY version'),
                         [(0, -1), (1, 1)])
        self.assertEqual(self.sql(r2, 'SELECT version, agree_value FROM vote_convention'), [(1, 1)])
        # The insert round trip was rolled back.
        self.assertEqual(self.sql(db, 'SELECT count(*) FROM votes')[0][0], r['post']['votes'])

    def test_dry_mode_measures_inside_a_rollback_and_leaves_the_copy(self):
        db = self.clone()
        before = self.raw(db)
        s = spec(mode='dry')
        state = self.rehearse(db, s)
        r = self.receipt(state, s)
        self.assertEqual(r['verdict'], 'PASS', r)
        self.assertEqual((r['rerun_refused'], r['rerun_sqlstate_class']), (True, 'P0'))
        self.assertEqual(r['restore_rule'], 'NOT_RUN')
        self.assertEqual({k for k, v in r['assertions'].items() if v == 'NOT_COLLECTED'},
                         {'pca2', 'math', 'exports', 'insert_roundtrip'})
        self.assertIsNone(r['migrate']['vacuum_s'])
        self.assertGreater(r['migrate']['wal_bytes'], 0)
        self.assertTrue(r['migrate']['counts_mirrored'])
        self.assertEqual(self.raw(db), before)
        self.assertEqual(self.sql(db, 'SELECT version, agree_value FROM vote_convention'), [(0, -1)])
        self.assertEqual(self.sql(db, "SELECT count(*) FROM schema_migrations WHERE name LIKE '%unflip'"), [(0,)])

    def test_image_phases_match_the_in_process_machine(self):
        """The reader, producer and verifier entrypoints, phase by phase as the worker runs them."""
        import tempfile
        db, r2 = self.clone(), self.clone()
        s = spec()
        j = job(**s)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            docs = []
            for role, phase in (('reader', 'pre'), ('producer', 'engine-pre'), ('reader', 'served-pre'),
                                ('reader', 'migrate'), ('reader', 'post'), ('producer', 'engine-post'),
                                ('reader', 'served-post'), ('reader', 'restore-rule')):
                if role == 'reader':
                    image_reader.run_phase(phase, s, out, connect=self.connector(db), connect_r2=self.connector(r2),
                                           collectors=self.collectors(db), ddl=DDL, migration=MIGRATION, queries=QUERIES)
                else:
                    state = u.decode_state((out / 'state.json').read_bytes())
                    docs.append(json.loads(u.encoded(image_producer.produce(
                        phase, state, connect=self.connector(db), queries=QUERIES, rebuild=self.engine(db)))))
            r = image_verifier.verify(u.decode_state((out / 'state.json').read_bytes()), docs, j)
        self.assertEqual(decode_receipt(u.encoded(r), j), r)
        self.assertEqual(r['verdict'], 'PASS', r)
        self.assertEqual(set(r['assertions'].values()), {'PASS'})
        self.assertEqual((r['pre']['math_zids'], r['restore_rule']), (6, 'PASS'))
        reference = self.receipt(self.rehearse(self.clone(), s, r2=self.clone()), s)
        for k in ('agg_sha256', 'hashes_sha256', 'pca2_sha256', 'math_sha256', 'exports_sha256', 'participants'):
            self.assertEqual(r['pre'][k], reference['pre'][k], k)
            self.assertEqual(r['post'][k], reference['post'][k], k)

    # -- the re-run ---------------------------------------------------------
    def test_a_second_run_refuses_by_version_and_changes_nothing(self):
        db = self.clone()
        self.sql(db, DDL.decode())
        self.sql(db, MIGRATION.decode())
        after_first = self.raw(db)
        with self.assertRaises(self.psycopg2.Error) as e:
            self.sql(db, MIGRATION.decode())
        self.assertEqual(e.exception.pgcode, 'P0785')
        self.assertEqual(self.raw(db), after_first)

    def test_a_broken_guard_is_reported_as_not_refused(self):
        db = self.clone()
        guard = b"IF NOT FOUND OR v_version IS DISTINCT FROM 0 OR v_agree IS DISTINCT FROM -1 THEN"
        ledger = b"IF EXISTS (SELECT 1 FROM public.schema_migrations m"
        self.assertEqual((MIGRATION.count(guard), MIGRATION.count(ledger)), (1, 1))
        broken = MIGRATION.replace(guard, b"IF false THEN").replace(ledger, b"IF false AND EXISTS (SELECT 1 FROM public.schema_migrations m")
        s = spec(mode='dry', migration_sql_sha256=u.digest(broken))
        state = steps.rehearse(self.connector(db), s, ddl=DDL, migration=broken, queries=QUERIES, interval=0.05)
        self.assertIn('RERUN_NOT_REFUSED', state['refusals'])
        r = self.receipt(state, s)
        self.assertEqual((r['verdict'], r['rerun_refused']), ('REFUSE', False))

    # -- the restore rule ---------------------------------------------------
    def test_restore_rule_outcomes(self):
        q = u.parse_queries(QUERIES)

        def rule(db):
            return steps.restore_rule(steps.Copy(self.connector(db), q), ddl=DDL, migration=MIGRATION)
        pre_pr_a = self.clone()
        self.assertEqual(rule(pre_pr_a), 'PASS')
        self.assertEqual(self.sql(pre_pr_a, 'SELECT version FROM vote_convention'), [(1,)])
        self.assertEqual(rule(pre_pr_a), 'PASS')                      # post-flip: serves as is
        at_zero = self.clone()
        self.sql(at_zero, DDL.decode())
        self.assertEqual(rule(at_zero), 'PASS')
        corrupt = self.clone()
        self.sql(corrupt, DDL.decode())
        self.sql(corrupt, "UPDATE vote_convention SET version = 1, agree_value = 1, reason = 'x'")
        self.assertEqual(rule(corrupt), 'REFUSE')                     # version 1 without the ledger row
        ledger_only = self.clone()
        self.sql(ledger_only, DDL.decode())
        self.sql(ledger_only, "INSERT INTO schema_migrations (name, checksum) VALUES ('000024_vote_sign_unflip', %s)",
                 (u.ledger_checksum(MIGRATION),))
        self.assertEqual(rule(ledger_only), 'REFUSE')                 # version 0 with the ledger row
        self.assertEqual(self.sql(ledger_only, 'SELECT version FROM vote_convention'), [(0,)])

    def test_restore_rule_refusal_fails_the_run(self):
        db, r2 = self.clone(), self.clone()
        self.sql(r2, DDL.decode())
        self.sql(r2, "UPDATE vote_convention SET version = 1, agree_value = 1, reason = 'x'")
        s = spec()
        r = self.receipt(self.rehearse(db, s, r2=r2), s)
        self.assertEqual((r['restore_rule'], r['verdict']), ('REFUSE', 'REFUSE'))

    # -- every post assertion's failure path ---------------------------------
    def phases(self, db, s, between=None, collectors=None, rebuild=None):
        q = u.parse_queries(QUERIES)
        c = steps.Copy(self.connector(db), q)
        state = u.empty_state()
        coll = collectors if collectors is not None else self.collectors(db)
        engine = rebuild if rebuild is not None else self.engine(db)
        steps.phase_pre(c, state, s, ddl=DDL, migration=MIGRATION, queries=QUERIES, collectors=coll)
        steps.phase_engine(c, state, 'pre', engine)
        steps.phase_served(c, state, s, 'pre', coll)
        steps.phase_migrate(c, state, s, migration=MIGRATION, interval=0.05)
        if between:
            between(db)
        steps.phase_post(c, state, s, collectors=coll)
        steps.phase_engine(c, state, 'post', engine)
        steps.phase_served(c, state, s, 'post', coll)
        return self.receipt(state, s)

    def test_each_assertion_fails_alone(self):
        s = spec(restore_rule=False, r2_host_sha256=None)
        cases = {
            'aggregates': (dict(between=lambda db: self.sql(
                db, "UPDATE votes SET vote = 0 WHERE ctid = (SELECT ctid FROM votes WHERE vote = 1 LIMIT 1)")),
                {'aggregates', 'hashes'}),
            'hashes': (dict(between=lambda db: self.sql(
                db, "UPDATE votes SET created = created + 1 WHERE ctid = (SELECT ctid FROM votes LIMIT 1)")),
                {'hashes'}),
            'pca2': ('served', {'pca2'}),
            'exports': ('exports', {'exports'}),
            'math': ('engine', {'math', 'pca2'}),    # served pca2 follows the rebuild
            'convention_version': (dict(between=lambda db: self.sql(
                db, "UPDATE vote_convention SET version = 2, agree_value = -1, reason = 'generated fault'")),
                {'convention_version', 'aggregates', 'hashes', 'pca2', 'exports', 'math', 'insert_roundtrip'}),
            'insert_roundtrip': (dict(between=lambda db: self.sql(db, """
                CREATE OR REPLACE FUNCTION public.vote_storage(semantic smallint, agree_value smallint) RETURNS smallint
                LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT (-semantic * agree_value)::smallint $$""")),
                {'insert_roundtrip'}),
        }
        for name, (how, failing) in cases.items():
            with self.subTest(name):
                db = self.clone()
                if how == 'served':
                    collectors = self.collectors(db, raw_served=True)
                    r = self.phases(db, s, collectors=collectors)
                elif how == 'exports':
                    r = self.phases(db, s, collectors=self.collectors(db, hard_flip=True))
                elif how == 'engine':
                    r = self.phases(db, s, rebuild=self.engine(db, raw=True))
                else:
                    r = self.phases(db, s, **how)
                self.assertEqual({k for k, v in r['assertions'].items() if v == 'FAIL'}, failing, r['assertions'])
                self.assertEqual(r['verdict'], 'REFUSE')

    # -- refusals before and during the migration ---------------------------
    def test_preflight_refusals_write_nothing(self):
        stale = spec(snapshot_created_ms=NOW_MS - 130_000_000)
        cases = {
            'SNAPSHOT_STALE': (stale, MASTER),
            'STORAGE_HEADROOM': (spec(allocated_storage_gb=20, min_free_storage_gb=20,
                                      restore_observed=dict(spec()['restore_observed'], allocated_storage_gb=20)),
                                 MASTER),
            'MIGRATION_DIGEST': (spec(migration_sql_sha256='f' * 64), MASTER),
            'DDL_DIGEST': (spec(convention_ddl_sha256='f' * 64), MASTER),
            'QUERIES_DIGEST': (spec(queries_sha256='f' * 64), MASTER),
            'RESTORE_SHAPE': (spec(restore_observed=dict(spec()['restore_observed'], storage_type='gp2')), MASTER),
            'SUPERUSER_SESSION': (spec(), 'postgres'),
        }
        for code, (s, user) in cases.items():
            with self.subTest(code):
                db = self.clone()
                state = steps.rehearse(self.connector(db, user), s, ddl=DDL, migration=MIGRATION, queries=QUERIES,
                                       interval=0.05)
                self.assertIn(code, state['refusals'])
                self.assertIsNone(state['pre'])
                self.assertEqual(self.receipt(state, s)['verdict'], 'REFUSE')
                self.assertEqual(self.sql(db, "SELECT to_regclass('public.vote_convention') IS NULL"), [(True,)])
        with mock.patch.object(steps, 'SERVER_MAJOR', 16):
            db = self.clone()
            state = steps.rehearse(self.connector(db), spec(), ddl=DDL, migration=MIGRATION, queries=QUERIES)
            self.assertEqual(state['refusals'], ['SERVER_VERSION'])

    def test_storage_headroom_counts_wal_and_refuses_when_unobservable(self):
        db = self.clone()
        q = u.parse_queries(QUERIES)
        conn = self.psycopg2.connect(self.url(db))
        try:
            with conn.cursor() as cur:
                cur.execute(q['storage_bytes'][0])
                databases, wal = cur.fetchone()
                cur.execute('SELECT pg_database_size(current_database())')
                (current,) = cur.fetchone()
        finally:
            conn.close()
        self.assertGreater(wal, 0)
        self.assertGreater(databases, current)     # every database, not only this one
        with self.admin.cursor() as cur:
            cur.execute(f'REVOKE pg_monitor FROM {MASTER}')
        try:
            state = steps.rehearse(self.connector(db), spec(), ddl=DDL, migration=MIGRATION, queries=QUERIES)
        finally:
            with self.admin.cursor() as cur:
                cur.execute(f'GRANT pg_monitor TO {MASTER}')
        self.assertEqual(state['refusals'], ['STORAGE_HEADROOM'])
        self.assertIsNone(state['preflight']['free_storage_gb'])

    def test_convention_state_and_certification_refusals(self):
        db = self.clone()
        self.sql(db, DDL.decode())
        self.sql(db, MIGRATION.decode())
        state = self.rehearse(db, spec())
        self.assertEqual(state['refusals'], ['CONVENTION_STATE'])
        db = self.clone()
        s = spec(certification_sha256=sorted([CERT[0], 'f' * 64]))
        state = self.rehearse(db, s)
        self.assertEqual(state['refusals'], ['CERTIFICATION_MISSING'])
        self.assertEqual(self.receipt(state, s)['verdict'], 'REFUSE')

    def test_collector_failure_refuses(self):
        db = self.clone()

        def broken(phase, zids):
            raise RuntimeError('loopback server did not start')
        s = spec()
        state = self.rehearse(db, s, collectors={'served': broken})
        self.assertEqual(state['refusals'], ['COLLECTION_FAILED'])
        self.assertIsNone(state['migrate'])
        self.assertEqual(self.sql(db, 'SELECT version FROM vote_convention'), [(0,)])

    def test_out_of_domain_vote_rolls_back(self):
        db = self.clone()
        self.sql(db, "INSERT INTO votes (zid, pid, tid, vote) VALUES (1, 99, 0, 2)")
        before = self.raw(db)
        s = spec(mode='dry')
        state = self.rehearse(db, s)
        self.assertEqual(state['refusals'], ['MIGRATION_FAILED'])
        self.assertEqual(self.raw(db), before)
        self.assertEqual(self.sql(db, 'SELECT version FROM vote_convention'), [(0,)])
        self.assertEqual(self.receipt(state, s)['verdict'], 'REFUSE')

    def test_mirrored_count_assertion_inside_the_migration(self):
        db = self.clone()
        self.sql(db, """
            CREATE FUNCTION generated_fault() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.zid = 1 AND NEW.tid = 0 THEN NEW.vote := 0; END IF; RETURN NEW; END $$;
            CREATE TRIGGER generated_fault BEFORE UPDATE ON votes FOR EACH ROW EXECUTE FUNCTION generated_fault();""")
        before = self.raw(db)
        s = spec(mode='dry')
        state = self.rehearse(db, s)
        self.assertEqual(state['refusals'], ['MIGRATION_FAILED'])
        self.assertFalse(state['migrate']['counts_mirrored'])
        self.assertEqual(self.raw(db), before)

    def hold_lock(self, db, seconds):
        """A session holding FOR SHARE on the convention row, as an in-flight vote_insert would."""
        ready = threading.Event()

        def hold():
            conn = self.psycopg2.connect(self.url(db))
            try:
                with conn.cursor() as cur:
                    cur.execute('SELECT version FROM vote_convention WHERE singleton FOR SHARE')
                    ready.set()
                    time.sleep(seconds)
                conn.rollback()
            finally:
                conn.close()
        t = threading.Thread(target=hold, daemon=True)
        t.start()
        ready.wait(10)
        return t

    def test_lock_wait_above_budget_refuses(self):
        db = self.clone()
        q = u.parse_queries(QUERIES)
        c = steps.Copy(self.connector(db), q)
        s = spec(mode='dry', lock_wait_budget_ms=300)
        state = u.empty_state()
        steps.phase_pre(c, state, s, ddl=DDL, migration=MIGRATION, queries=QUERIES)
        holder = self.hold_lock(db, 1.5)
        steps.phase_migrate(c, state, s, migration=MIGRATION, interval=0.05)
        holder.join()
        self.assertEqual(state['refusals'], ['LOCK_BUDGET'])
        self.assertGreaterEqual(state['migrate']['max_lock_waiters'], 1)
        self.assertGreater(state['migrate']['max_lock_wait_ms'], 300)
        self.assertEqual(self.receipt(state, s)['verdict'], 'REFUSE')

    def test_wall_budget_cancels_and_rolls_back(self):
        db = self.clone()
        q = u.parse_queries(QUERIES)
        c = steps.Copy(self.connector(db), q)
        s = spec(restore_rule=False, r2_host_sha256=None, lock_wait_budget_ms=60000)
        state = u.empty_state()
        steps.phase_pre(c, state, s, ddl=DDL, migration=MIGRATION, queries=QUERIES, collectors={})
        before = self.raw(db)
        holder = self.hold_lock(db, 3)
        steps.phase_migrate(c, state, s, migration=MIGRATION, wall_budget_s=0.5, interval=0.05)
        holder.join()
        self.assertEqual(state['refusals'], ['MIGRATION_FAILED', 'WALL_BUDGET'])
        self.assertEqual(self.raw(db), before)
        self.assertEqual(self.sql(db, 'SELECT version FROM vote_convention'), [(0,)])


if __name__ == '__main__':
    unittest.main()
