"""Census capacity revision: job/2 single-object bounds at 1 MiB, 4096 rows per
family and 16384 total; nested bounds, job/1 and provisioning unchanged.

Every catalog here is built from the public fixture plus public filler names.
The reader runs against a scripted cursor; no database or SDK call is made.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent/'private_cert/images'))
sys.path.insert(0, str(HERE.parent/'private_cert'))
from contracts import validate_job
from receipt import JSON_LIMIT, canonical, decode_json, decode_receipt, receipt_limit, sha
from roles_queries import QUERIES, MAX_BYTES, MAX_FAMILY_ROWS, MAX_ROWS
from roles_census import (FAMILIES, FLAGS, LIMIT, MAX_NESTED_ENTRIES, POLICY, POLICY_SHA,
                          encoded, normalize, validate_census, validate_receipt)
from roles_producer import produce
from roles_reader import projection as read_projection
import roles_verifier
from roles_verifier import receipt as build_receipt, controls
from roles_rehearsal import test_job as census_job

FIXTURE = json.loads((HERE/'fixtures/roles_projection.json').read_bytes())
# Pinned so any change to the bounds or the generated SQL needs a reviewed re-pin.
EXPECTED_POLICY_SHA = 'b2f9237a1e662906eed221a323f99aca6f636266cb66f690f5679c780df3b728'


def role(name):
    return dict(name=name, connection_limit=-1, valid_until=None, config_present=False,
                config_count=0, **{k: False for k in FLAGS})


def filler_names(count, width=6):
    return [f'r{i:05d}'.ljust(width, 'x') for i in range(count)]


def catalog(roles=0, columns=0, memberships=0, acls=0, width=6):
    """A valid public-fixture catalog widened with public filler rows."""
    c = copy.deepcopy(FIXTURE['census'])
    names = filler_names(roles, width)
    c['roles'] += [role(n) for n in names]
    c['columns'] += [dict(acl_state='DEFAULT', name=f'c{n:05d}', number=n,
                          relation=['public', 'default_acl']) for n in range(1000, 1000+columns)]
    for i in range(memberships):
        a = i % len(names); b = (a + 1 + i // len(names)) % len(names)
        c['memberships'].append(dict(role=names[a], member=names[b], grantor='postgres',
                                     admin=False, inherit=True, set=True))
    privileges = sorted(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'])
    for i in range(acls):
        c['acls'].append(dict(kind='RELATION', object=['public', 'empty_acl'], grantor='postgres',
                              grantee={'kind': 'ROLE', 'name': names[i // 8]},
                              privilege=privileges[i % 8], grantable=False))
    return normalize(c)


def sized_catalog(target):
    """A valid catalog whose canonical encoding is exactly `target` bytes."""
    c = copy.deepcopy(FIXTURE['census'])
    base = len(encoded(c))
    step = len(encoded(role('r'+'0'*47))) + 1
    count = (target - base) // step
    c['roles'] += [role(n) for n in filler_names(count, 48)]
    added = c['roles'][-count:]
    remaining = target - len(encoded(c))
    for r in added:
        if remaining <= 0: break
        grow = min(15, remaining)
        r['name'] += 'y'*grow; remaining -= grow
    c = normalize(c)
    assert len(encoded(c)) == target, (len(encoded(c)), target)
    return c


class Cursor:
    """Answers the reader's fixed statements from a prepared catalog."""
    def __init__(self, rows):
        self.rows, self.family, self.requested, self.queried = rows, None, [], []
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def execute(self, statement):
        self.family = next((f for f, q in QUERIES.items() if q == statement), None)
        if self.family: self.queried.append(self.family)
    def fetchone(self):
        return 170011, 'on', 'repeatable read', 'polis_probe_reader', 'polis_probe_reader', 63
    def fetchmany(self, n):
        self.requested.append(n)
        return [(copy.deepcopy(r),) for r in self.rows[self.family][:n]]
    def fetchall(self):
        return [(copy.deepcopy(r),) for r in self.rows.get(self.family, [])]


class Connection:
    def __init__(self, rows): self.cur = Cursor(rows)
    def set_session(self, **kwargs): pass
    def cursor(self): return self.cur
    def rollback(self): pass


def read(rows):
    conn = Connection(rows)
    return read_projection(conn, '1'*40), conn.cur


def full_receipt(p, job):
    r = build_receipt(p, produce(p), job, p['source_commit'])
    r['controls'] = controls(job)
    return r


def rebind(r):
    r['bindings']['census'] = hashlib.sha256(encoded(r['census'])).hexdigest()
    return r


class PolicyTests(unittest.TestCase):
    def test_reviewed_bounds_and_policy_identifier(self):
        self.assertEqual((MAX_FAMILY_ROWS, MAX_ROWS, MAX_BYTES, LIMIT), (4096, 16384, 1048576, 1048576))
        self.assertEqual(MAX_NESTED_ENTRIES, 1024)
        self.assertEqual(POLICY['schema'], 'polis-roles-census-policy/2')
        self.assertEqual((POLICY['max_family_rows'], POLICY['max_rows'], POLICY['max_bytes'],
                          POLICY['max_identifier_bytes']), (4096, 16384, 1048576, 63))
        self.assertEqual(POLICY_SHA, EXPECTED_POLICY_SHA)
        self.assertEqual(FIXTURE['query_policy'], POLICY_SHA)
        for family in FAMILIES:
            self.assertTrue(QUERIES[family].endswith(' LIMIT 4097'), family)

    def test_job_selects_ceiling_and_old_ceilings_hold(self):
        job1 = copy.deepcopy(census_job()); job1['schema'] = 'polis-probe-job/1'
        del job1['kind'], job1['reader']
        self.assertEqual(receipt_limit(job1), 131072)
        self.assertEqual(receipt_limit(census_job()), 1048576)
        self.assertEqual(JSON_LIMIT, 131072)
        over_old = b'[' + b' '*131071 + b']'
        with self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'): decode_json(over_old)
        self.assertEqual(decode_json(over_old, LIMIT), [])
        self.assertEqual(decode_json(b'[' + b' '*(LIMIT-2) + b']', LIMIT), [])
        with self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'):
            decode_json(b'[' + b' '*(LIMIT-1) + b']', LIMIT)
        for bad in (0, -1, True, '1048576', 1048576.0, None):
            with self.subTest(limit=bad), self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'):
                decode_json(b'[]', bad)


class CapacityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.job = census_job()
        cls.large = catalog(roles=1100, columns=4096 - 11, memberships=3100)
        cls.p, cls.cur = read(cls.large)
        cls.r = full_receipt(cls.p, cls.job)
        cls.raw = encoded(cls.r)

    def refused(self, r, job=None, pattern=''):
        if 'census' in r: rebind(r)
        with self.assertRaisesRegex(ValueError, pattern): decode_receipt(encoded(r), job or self.job)

    def test_complete_catalog_above_every_old_threshold_passes(self):
        sizes = {f: len(self.large[f]) for f in FAMILIES}
        self.assertGreater(len(encoded(self.large)), 131072)
        self.assertGreater(max(sizes.values()), 1024)
        self.assertEqual(sizes['columns'], MAX_FAMILY_ROWS)
        self.assertGreater(sum(sizes.values()), 8192)
        self.assertEqual(self.cur.requested, [MAX_FAMILY_ROWS+1]*len(FAMILIES))
        self.assertEqual(set(self.p['coverage'].values()), {'COMPLETE'})
        self.assertEqual(self.p['census'], self.large)
        self.assertEqual(self.r['verdict'], 'PASS')
        self.assertTrue(all(self.r['controls'].values()))
        self.assertGreater(len(self.raw), 131072)
        self.assertLessEqual(len(self.raw), LIMIT)
        self.assertEqual(decode_receipt(self.raw, self.job), self.r)

    def test_family_row_limit_and_one_more(self):
        exact = catalog(columns=MAX_FAMILY_ROWS - 11)
        self.assertEqual(len(exact['columns']), MAX_FAMILY_ROWS)
        validate_census(exact)
        p, _ = read(exact)
        self.assertEqual(set(p['coverage'].values()), {'COMPLETE'})
        over = catalog(columns=MAX_FAMILY_ROWS - 10)
        with self.assertRaisesRegex(ValueError, '^CENSUS_LIMIT$'): validate_census(over)
        p, cur = read(over)
        self.assertEqual(set(p['coverage'].values()), {'LIMIT_EXCEEDED'})
        self.assertEqual(p['census'], {f: [] for f in FAMILIES})
        self.assertEqual(p['counts'], {f: 0 for f in FAMILIES})
        # The reader stops at the overflowing family; later families are unread.
        self.assertEqual(cur.queried, list(FAMILIES[:FAMILIES.index('columns')+1]))
        r = full_receipt(p, self.job)
        self.assertEqual(r['verdict'], 'INCOMPLETE')
        decode_receipt(encoded(r), self.job)

    def test_total_row_limit_and_one_more(self):
        c = catalog(roles=4096 - 21, columns=4096 - 11, memberships=4096 - 4)
        others = sum(len(c[f]) for f in FAMILIES if f != 'acls')
        c = catalog(roles=4096 - 21, columns=4096 - 11, memberships=4096 - 4,
                    acls=MAX_ROWS - others - len(FIXTURE['census']['acls']))
        self.assertEqual(sum(len(c[f]) for f in FAMILIES), MAX_ROWS)
        self.assertTrue(all(len(c[f]) <= MAX_FAMILY_ROWS for f in FAMILIES))
        validate_census(c)
        c = catalog(roles=4096 - 21, columns=4096 - 11, memberships=4096 - 4,
                    acls=MAX_ROWS - others - len(FIXTURE['census']['acls']) + 1)
        self.assertEqual(sum(len(c[f]) for f in FAMILIES), MAX_ROWS + 1)
        self.assertTrue(all(len(c[f]) <= MAX_FAMILY_ROWS for f in FAMILIES))
        with self.assertRaisesRegex(ValueError, '^CENSUS_LIMIT$'): validate_census(c)

    def test_census_and_projection_byte_envelopes(self):
        # Projection overhead depends on count digits; measure it on the same shape.
        near = read(sized_catalog(LIMIT - 4000))[0]
        overhead = len(encoded(near)) - (LIMIT - 4000)
        # Census and projection both exactly at the ceiling: complete.
        p, _ = read(sized_catalog(LIMIT - overhead))
        self.assertEqual(len(encoded(p)), LIMIT)
        self.assertEqual(set(p['coverage'].values()), {'COMPLETE'})
        # Projection one byte over, census still fits: every family cleared.
        for target in (LIMIT - overhead + 1, LIMIT, LIMIT + 1):
            with self.subTest(census_bytes=target):
                p, _ = read(sized_catalog(target))
                self.assertEqual(set(p['coverage'].values()), {'LIMIT_EXCEEDED'})
                self.assertEqual(p['census'], {f: [] for f in FAMILIES})
                self.assertEqual(p['counts'], {f: 0 for f in FAMILIES})

    def test_receipt_byte_limit_and_one_more(self):
        overhead = len(self.raw) - len(encoded(self.r['census']))
        exact = full_receipt(read(sized_catalog(LIMIT - overhead))[0], self.job)
        self.assertEqual(len(encoded(exact)), LIMIT)
        self.assertEqual(decode_receipt(encoded(exact), self.job), exact)
        over = full_receipt(read(sized_catalog(LIMIT - overhead + 1))[0], self.job)
        self.assertEqual(len(encoded(over)), LIMIT + 1)
        with self.assertRaisesRegex(ValueError, '^CENSUS_LIMIT$'): validate_receipt(over, self.job)
        with self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'): decode_receipt(encoded(over), self.job)
        padded = self.raw + b' '*(LIMIT - len(self.raw))
        self.assertEqual(decode_receipt(padded, self.job), self.r)
        with self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'): decode_receipt(padded + b' ', self.job)

    def test_verifier_entrypoint_clears_every_family_when_receipt_overflows(self):
        overhead = len(self.raw) - len(encoded(self.r['census']))
        for census_bytes, verdict in ((LIMIT - overhead, 'PASS'), (LIMIT - overhead + 1, 'INCOMPLETE')):
            with self.subTest(verdict=verdict):
                p, _ = read(sized_catalog(census_bytes))
                self.assertEqual(set(p['coverage'].values()), {'COMPLETE'})
                files = self.verify(p, produce(p))
                out = files['/verdict/receipt.json']
                r = decode_receipt(out, self.job)
                self.assertEqual(r['verdict'], verdict)
                if verdict == 'PASS':
                    self.assertEqual(len(out), LIMIT); self.assertEqual(r['census'], p['census'])
                else:
                    self.assertEqual(r['census'], {f: [] for f in FAMILIES})
                    self.assertEqual({r['coverage'][f] for f in FAMILIES}, {'LIMIT_EXCEEDED'})
                    self.assertEqual([r['coverage'][k] for k in ('unsupported_policies', 'settings_rows',
                                      'external_dependencies')], [0, 0, 0])

    def test_verifier_inputs_census_ceiling_but_recipe_and_job_keep_default(self):
        with self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'):
            self.verify(self.p, produce(self.p), pad={'/input/projection.json': LIMIT + 1})
        with self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'):
            self.verify(self.p, produce(self.p), pad={'/evidence/census.json': LIMIT + 1})
        for name in ('/opt/polis-private-image/recipe.json', '/job/job.json'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'):
                self.verify(self.p, produce(self.p), pad={name: JSON_LIMIT + 1})

    def verify(self, projection, produced, pad=None):
        files = {'/opt/polis-private-image/recipe.json': encoded({'sourceCommit': projection['source_commit']}),
                 '/job/job.json': encoded(self.job), '/input/projection.json': encoded(projection),
                 '/evidence/census.json': encoded(produced)}
        for name, size in (pad or {}).items():
            files[name] += b' '*(size - len(files[name]))
        class StubPath:
            def __init__(self, name): self.name = name
            def read_bytes(self): return files[self.name]
            def write_bytes(self, data): files[self.name] = data
        with patch.object(roles_verifier, 'Path', StubPath), patch.object(sys, 'argv', ['roles_verifier.py', 'verify']):
            roles_verifier.main()
        return files

    def test_nested_bounds_unchanged(self):
        grantees = filler_names(65)
        entries = sorted(({'grantable': g, 'grantee': {'kind': 'ROLE', 'name': n}, 'grantor': 'census_owner',
                           'privilege': p} for n in grantees for p in ('SELECT', 'INSERT', 'UPDATE', 'DELETE',
                          'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN') for g in (False, True)), key=encoded)
        base = copy.deepcopy(FIXTURE['census']); base['roles'] += [role(n) for n in grantees]
        exact = copy.deepcopy(base); exact['default_acls'][0]['entries'] = entries[:MAX_NESTED_ENTRIES]
        validate_census(normalize(exact))
        over = copy.deepcopy(base); over['default_acls'][0]['entries'] = entries[:MAX_NESTED_ENTRIES+1]
        with self.assertRaisesRegex(ValueError, '^CENSUS_LIMIT$'): validate_census(normalize(over))
        p, _ = read(normalize(over))
        self.assertEqual(set(p['coverage'].values()), {'LIMIT_EXCEEDED'})
        # Policy principals keep their own 1024 bound, a schema refusal.
        names = filler_names(MAX_NESTED_ENTRIES + 1)
        base = copy.deepcopy(FIXTURE['census']); base['roles'] += [role(n) for n in names]
        principals = sorted(({'kind': 'ROLE', 'name': n} for n in names), key=encoded)
        exact = copy.deepcopy(base); exact['policies'][0]['roles'] = principals[:MAX_NESTED_ENTRIES]
        validate_census(normalize(exact))
        over = copy.deepcopy(base); over['policies'][0]['roles'] = principals
        with self.assertRaisesRegex(ValueError, '^CENSUS_SCHEMA$'): validate_census(normalize(over))
        p, _ = read(normalize(over))
        self.assertEqual(set(p['coverage'].values()), {'NOT_VISIBLE'})

    def test_large_receipt_json_refusals(self):
        self.assertGreater(len(self.raw), 131072)
        cases = {'RECEIPT_DUPLICATE_KEY': b'{"kind":"roles-census",' + self.raw[1:],
                 'RECEIPT_NONFINITE': self.raw.replace(b'"server_version_num":170011', b'"server_version_num":NaN'),
                 'RECEIPT_DEPTH': self.raw[:-1] + b',"extra":' + b'['*20 + b']'*20 + b'}'}
        for code, raw in cases.items():
            with self.subTest(code=code):
                self.assertNotEqual(raw, self.raw)
                with self.assertRaisesRegex(ValueError, code): decode_receipt(raw, self.job)

    def test_large_receipt_binding_and_false_pass_refusals(self):
        for field, value in [('kind', 'battery'), ('schema', 'polis-probe-receipt/2'),
                             ('run_id', '0'*32), ('job_sha256', '0'*64)]:
            with self.subTest(field=field):
                r = copy.deepcopy(self.r); r[field] = value; self.refused(r)
        for field in ('reader', 'producer', 'verifier', 'query_policy'):
            with self.subTest(binding=field):
                r = copy.deepcopy(self.r); r['bindings'][field] = '0'*64; self.refused(r)
        mutations = {
            'missing-family': lambda r: r['census'].pop('policies'),
            'not-visible': lambda r: r['coverage'].update(columns='NOT_VISIBLE'),
            'limit-exceeded-pass': lambda r: r['coverage'].update(roles='LIMIT_EXCEEDED'),
            'unsupported-policy': lambda r: r['census']['policies'][0].update(using='UNSUPPORTED_EXPRESSION'),
            'false-pass-control': lambda r: r['controls'].update({'false-pass': False}),
            'old-policy': lambda r: r['bindings'].update(
                query_policy='70d859517db8f780cd12b1019c7e4f85012503772198cdf43b6868409ee1f921')}
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                r = copy.deepcopy(self.r); mutate(r); self.refused(r)

    def test_job_one_cannot_admit_a_large_census_receipt(self):
        job1 = copy.deepcopy(self.job); job1['schema'] = 'polis-probe-job/1'
        del job1['kind'], job1['reader']
        with self.assertRaisesRegex(ValueError, 'RECEIPT_LIMIT'): decode_receipt(self.raw, validate_job(job1))

    def test_worker_file_boundary(self):
        from worker import load_receipt
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'receipt.json'
            path.write_bytes(self.raw + b' '*(LIMIT - len(self.raw)))
            self.assertEqual(load_receipt(path, self.job), self.r)
            path.write_bytes(self.raw + b' '*(LIMIT + 1 - len(self.raw)))
            with self.assertRaisesRegex(ValueError, 'RECEIPT_FILE'): load_receipt(path, self.job)

    def operator(self):
        from test_run import session_setup
        x, c, e, s, i = session_setup()
        reads = []
        original = s.get_object
        def get_object(**kw):
            out = original(**kw); body = out['Body']
            if kw['Key'].endswith('receipt.json') or kw['Key'].startswith('provision-results/'):
                class Body:
                    def read(self, n=-1): reads.append(n); return body.read(n)
                out['Body'] = Body()
            return out
        s.get_object = get_object
        return x, s, i, reads

    def test_operator_bounded_stream_read_per_job(self):
        from run import Unknown
        key = 'results/arn:aws:ec2:us-east-1:111111111111:instance/i-test/receipt.json'
        job = copy.deepcopy(self.job); job['run_id'] = 'a'*32
        r = copy.deepcopy(self.r); r.update(run_id=job['run_id'], job_sha256=sha(job))
        x, s, i, reads = self.operator()
        x.start(job); i['State']['Name'] = 'terminated'
        s.objects['evidence', key] = encoded(r)
        self.assertTrue(x.status(job['run_id'])['passed'])
        self.assertEqual(reads, [LIMIT + 1])
        s.objects['evidence', key] = encoded(r) + b' '*(LIMIT + 1 - len(encoded(r)))
        with self.assertRaisesRegex(Unknown, 'RECEIPT_LIMIT'): x.status(job['run_id'])
        self.assertEqual(reads[-1], LIMIT + 1)
        # Job/1 keeps its 131072 read and ceiling.
        from test_boundaries import job as battery_job, receipt as battery_receipt
        x, s, i, reads = self.operator()
        j1 = battery_job(); x.start(j1); i['State']['Name'] = 'terminated'
        good = canonical(battery_receipt())
        s.objects['evidence', key] = good
        self.assertTrue(x.status(j1['run_id'])['passed'])
        s.objects['evidence', key] = good + b' '*(131073 - len(good))
        with self.assertRaisesRegex(Unknown, 'RECEIPT_LIMIT'): x.status(j1['run_id'])
        self.assertEqual(set(reads), {131073})

    def test_operator_provisioning_ceiling_unchanged(self):
        from run import Unknown
        x, s, i, reads = self.operator()
        x.cfg.update(MODE='provision', INSTANCE_TYPE='t4g.small', ADMIN_SECRET_ARN='admin',
                     PROVISION_OWNER='polis-probe-login:test')
        i['InstanceType'] = 't4g.small'
        request = dict(run_id='a'*32, adminVersion='b'*32, readerVersion='c'*32)
        x.start_provision(request)
        a = x.active()[0]['admission']
        key = ('control', 'provision-results/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json')
        i['State']['Name'] = 'terminated'
        good = encoded(dict(schema='polis-probe-provision/1', admissionSha256=sha(a), success=True))
        s.objects[key] = good
        self.assertTrue(x.status(request['run_id'])['passed'])
        s.objects[key] = good + b' '*(131073 - len(good))
        with self.assertRaisesRegex(Unknown, 'RECEIPT_LIMIT'): x.status(request['run_id'])
        self.assertEqual(set(reads), {131073})

    def test_worker_pipeline_publishes_census_above_old_ceiling(self):
        import test_boundaries
        base = dict(schema='polis-probe-job/2', kind='roles-census', run_id='a'*32, max_seconds=3600,
                    producer={'image': 'localhost/census-producer@sha256:'+'4'*64, 'args': ['produce']},
                    verifier={'image': 'localhost/census-verifier@sha256:'+'5'*64, 'args': ['verify']},
                    reader={'image': 'localhost/census-reader@sha256:'+'6'*64, 'args': ['read']})
        final = validate_job(dict(copy.deepcopy(base),
                                  reader={'image': 'localhost/reader@sha256:'+'3'*64, 'args': ['read']}))
        r = full_receipt(self.p, final)
        self.assertGreater(len(canonical(r)), 131072)
        harness = test_boundaries.WorkerRecordingTests('test_actual_worker_pipeline_records_every_stage_before_cleanup')
        with patch.object(test_boundaries, 'job', lambda: copy.deepcopy(base)), \
             patch.object(test_boundaries, 'receipt', lambda: copy.deepcopy(r)):
            events, expected = harness.exercise_worker()
        published = [body for kind, body in events if kind == 'receipt']
        self.assertEqual(published, [canonical(r)])
        self.assertEqual(expected, canonical(r))
        self.assertEqual(decode_receipt(published[0], final)['verdict'], 'PASS')

    def test_reversal_snapshot_above_old_row_cap(self):
        from reversal_fixture import snapshot_rows
        cursor = Cursor(self.large)
        rows = snapshot_rows(cursor)
        self.assertEqual(rows, self.large)
        self.assertGreater(len(rows['columns']), 1024)
        cursor = Cursor(catalog(columns=MAX_FAMILY_ROWS - 10))
        with self.assertRaisesRegex(ValueError, '^REVERSAL_CATALOG_LIMIT$'): snapshot_rows(cursor)


if __name__ == '__main__':
    unittest.main()
