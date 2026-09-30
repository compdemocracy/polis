"""P-070 backfill completeness proof: closed run-spec, projection, switch condition and receipt.

Dependency-free: the supervisor, the operator and all three images import it.
Nothing here reads a database or a file. The receipt carries counts, integer
millisecond clocks, fixed condition names and digests: no conversation ids,
payloads or text.

The result is a shape and coverage proof at one cutoff, taken from one
REPEATABLE READ snapshot through the shipped verification SQL (bound by
digest). It is not numerical certification of the backfilled conversations,
and it does not read the poller's sweep summary (saved refusals, parked live
work), which stays on the Delphi host; the receipt names both as outside its
coverage. A conversation with unresolved backfill work has no complete target,
so it still counts against `complete = source_conversations` here.
"""
from __future__ import annotations
import hashlib
import json
import re

from backfill_verify_queries import (EXTRA, READ_TABLES, SETTINGS, SHIPPED, SOURCE, SQL_SHA256, TABLES,
                                     TARGET)

KIND = 'backfill-verify'
LIMIT = 16384
VERDICTS = ('BACKFILL-COMPLETE', 'BACKFILL-INCOMPLETE', 'INCOMPLETE')
ACCEPTANCE = 'shape and coverage at one cutoff; not numerical certification'
# COMPLETE, or why the snapshot produced no evidence. Never a zero count.
STATUS = ('COMPLETE', 'NOT_VISIBLE', 'TIMEOUT', 'QUERY_FAILED', 'LIMIT_EXCEEDED', 'SQL_MISMATCH')
# Only the default disposition exists until Colin rules on source-ahead (P-070 section 11).
RULINGS = ('unresolved',)
COVERAGE = {'status': None, 'tables': list(READ_TABLES), 'poller_sweep': 'NOT_COLLECTED',
            'numerical': 'NOT_EVALUATED'}
MS_FLOOR, MS_CEILING = 1_500_000_000_000, 4_000_000_000_000
CUTOFF_AGE = (300, 86400)
TICK_AGE = (60, 86400)

COLUMNS = {name: columns for name, columns, _ in SHIPPED if name != 'rows'}
# Switch-condition counts that must be zero (P-070 section 8, unresolved ruling).
ZERO = (('conversations', ('missing_main', 'missing_bidtopid', 'missing_ptptstats', 'missing_ticks',
                           'unequal_generation', 'uninitialized_generation', 'invalid_payload',
                           'behind_source_stale', 'source_ahead')),
        ('orphans', ('orphan_bidtopid', 'orphan_ptptstats', 'orphan_ticks')),
        ('cutoff', ('behind_input_at_cutoff', 'source_ahead_of_input')))
BLOCKING = tuple(n for _, names in ZERO for n in names) + (
    'complete-short',) + tuple('without-target-' + t for t in TABLES) + ('poller-not-live',)
CONTROLS = (
    # Live checks on this run's own snapshot and inputs.
    'reader-no-write', 'sql-digest-bound',
    # Fixed self-tests of the refusal paths.
    'empty-result-incomplete', 'not-visible-incomplete', 'forged-evidence-refused', 'forged-projection-refused',
    'wrong-sql-refused', 'wrong-ruling-refused', 'identifier-field-refused', 'content-field-refused',
    'wrong-kind-refused', 'wrong-image-refused', 'wrong-policy-refused', 'false-complete-refused',
    'count-mismatch-refused', 'stale-cutoff-incomplete', 'future-cutoff-incomplete',
    # Fixed switch-condition vectors.
    'complete-vector', 'missing-blocks', 'invalid-blocks', 'source-ahead-blocks', 'orphan-blocks',
    'cutoff-proof-blocks', 'without-target-blocks', 'poller-behind-blocks', 'live-lag-allowed')
LIVE_CONTROLS = CONTROLS[:2]

POLICY = {'schema': 'polis-backfill-verify-policy/1', 'source': SOURCE, 'target': TARGET,
          'verification_sql': SQL_SHA256, 'shipped': [[n, list(c), k] for n, c, k in SHIPPED],
          'tables': list(TABLES), 'read_tables': list(READ_TABLES), 'status': list(STATUS),
          'rulings': list(RULINGS), 'blocking': list(BLOCKING), 'controls': list(CONTROLS),
          'verdicts': list(VERDICTS), 'acceptance': ACCEPTANCE, 'coverage': COVERAGE,
          'cutoff_age_seconds': list(CUTOFF_AGE), 'tick_age_seconds': list(TICK_AGE), 'max_bytes': LIMIT}


def encoded(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


POLICY_SHA = hashlib.sha256(encoded({'policy': POLICY, 'queries': EXTRA, 'settings': SETTINGS})).hexdigest()
MAX_PROJECTION_BYTES = 65536


def fail(code='VERIFY_SCHEMA'):
    raise ValueError(code)


def decode(raw, limit=MAX_PROJECTION_BYTES):
    """Box-local JSON: duplicate keys and non-finite numbers are refused."""
    if len(raw) > limit:
        fail('VERIFY_LIMIT')

    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                fail('VERIFY_DUPLICATE_KEY')
            out[k] = v
        return out

    def constant(_):
        fail('VERIFY_NONFINITE')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        fail('VERIFY_JSON')


def closed(v, keys):
    if type(v) is not dict or set(v) != set(keys):
        fail()
    return v


def integer(v, low=0, high=2**53 - 1, code='VERIFY_COUNT'):
    if type(v) is not int or not low <= v <= high:
        fail(code)
    return v


def stamp(v):
    """A millisecond clock or null (a label with no tick row)."""
    return None if v is None else integer(v, 0, MS_CEILING, 'VERIFY_CLOCK')


def hexdigest(v, code='VERIFY_DIGEST'):
    if type(v) is not str or not re.fullmatch('[a-f0-9]{64}', v):
        fail(code)
    return v


# ---------------------------------------------------------------------------
# Run-spec: operator inputs carried in the admitted job. No ids, no SQL.
# ---------------------------------------------------------------------------
RUN_SPEC = ('source_env', 'target_env', 'cutoff_ms', 'max_cutoff_age_seconds', 'max_tick_age_seconds',
            'source_ahead_ruling', 'verification_sql_sha256')
# The registry template; the operator replaces run_id and cutoff_ms. Its floor
# cutoff is refused at launch (contracts.refuse_placeholder).
TEMPLATE_RUN_SPEC = {'source_env': SOURCE, 'target_env': TARGET, 'cutoff_ms': MS_FLOOR,
                     'max_cutoff_age_seconds': 3600, 'max_tick_age_seconds': 900,
                     'source_ahead_ruling': 'unresolved', 'verification_sql_sha256': SQL_SHA256}


def validate_run_spec(v):
    closed(v, RUN_SPEC)
    if v['source_env'] != SOURCE or v['target_env'] != TARGET:
        fail('VERIFY_ENV')
    integer(v['cutoff_ms'], MS_FLOOR, MS_CEILING, 'VERIFY_RUN_SPEC')
    integer(v['max_cutoff_age_seconds'], *CUTOFF_AGE, 'VERIFY_RUN_SPEC')
    integer(v['max_tick_age_seconds'], *TICK_AGE, 'VERIFY_RUN_SPEC')
    if type(v['source_ahead_ruling']) is not str or v['source_ahead_ruling'] not in RULINGS:
        fail('VERIFY_RULING')
    # The job names the reviewed SQL; any other digest is refused before a read.
    if v['verification_sql_sha256'] != SQL_SHA256:
        fail('VERIFY_SQL_DIGEST')
    return dict(v)


# ---------------------------------------------------------------------------
# Counts: closed shape and the cross-query consistency of one snapshot.
# ---------------------------------------------------------------------------
RESULTS = ('rows', 'conversations', 'orphans', 'payloads', 'cutoff', 'without_target', 'ticks')


def validate_results(r):
    closed(r, RESULTS)
    rows = closed(r['rows'], TABLES)
    for t in TABLES:
        for k in closed(rows[t], ('source', 'target')).values():
            integer(k)
    for name, columns in COLUMNS.items():
        for k in closed(r[name], columns).values():
            integer(k)
    for k in closed(r['without_target'], TABLES).values():
        integer(k)
    ticks = closed(r['ticks'], ('source_max_ms', 'target_max_ms'))
    for k in ticks.values():
        stamp(k)
    c, o, p, q, w = (r[k] for k in ('conversations', 'orphans', 'payloads', 'cutoff', 'without_target'))
    n = c['source_conversations']
    # One snapshot: the same source set in every query.
    if rows['math_main']['source'] != n or w['math_main'] != c['missing_main']:
        fail('VERIFY_CONSISTENCY')
    if any(v > n for v in c.values()) or any(v > n for v in q.values()):
        fail('VERIFY_CONSISTENCY')
    # Query 4 checks the coherent targets: its invalid set is query 2's.
    if p['checked'] > n or p['invalid_payload'] != c['invalid_payload'] or any(v > p['checked'] for v in p.values()):
        fail('VERIFY_CONSISTENCY')
    # Complete requires valid requires coherent.
    if c['complete'] > p['checked'] - p['invalid_payload'] or p['empty_shape'] > p['checked'] - p['invalid_payload']:
        fail('VERIFY_CONSISTENCY')
    if (o['target_only_main'] > rows['math_main']['target'] or o['orphan_bidtopid'] > rows['math_bidtopid']['target']
            or o['orphan_ptptstats'] > rows['math_ptptstats']['target'] or o['orphan_ticks'] > rows['math_ticks']['target']):
        fail('VERIFY_CONSISTENCY')
    if any(w[t] > rows[t]['source'] for t in TABLES):
        fail('VERIFY_CONSISTENCY')
    for label in ('source', 'target'):
        if (rows['math_ticks'][label] == 0) != (ticks[label + '_max_ms'] is None):
            fail('VERIFY_CONSISTENCY')
    return r


def snapshot(results, snapshot_ms, spec):
    """Derived clocks, all from the snapshot's own transaction timestamp."""
    ticks = results['ticks']

    def age(ms):
        return None if ms is None else max(0, snapshot_ms - ms)
    return {'snapshot_ms': snapshot_ms, 'cutoff_age_ms': snapshot_ms - spec['cutoff_ms'],
            'source_tick_max_ms': ticks['source_max_ms'], 'target_tick_max_ms': ticks['target_max_ms'],
            'target_tick_age_ms': age(ticks['target_max_ms'])}


def blocking(results, snap, spec):
    """The failed switch conditions, in the fixed BLOCKING order."""
    failed = [n for group, names in ZERO for n in names if results[group][n]]
    c = results['conversations']
    if c['complete'] != c['source_conversations']:
        failed.append('complete-short')
    failed += ['without-target-' + t for t in TABLES if results['without_target'][t]]
    # The target writer is live if it published within the bound, or if it is
    # not behind the source writer's newest tick (a quiet period).
    target, source = snap['target_tick_max_ms'], snap['source_tick_max_ms']
    if target is None or (snap['target_tick_age_ms'] > 1000 * spec['max_tick_age_seconds']
                          and source is not None and target < source):
        failed.append('poller-not-live')
    return failed


def usable(snap, results, spec):
    """Evidence a verdict can rest on: a fresh cutoff, not in the future, over a non-empty source set."""
    age = snap['cutoff_age_ms']
    return (0 <= age <= 1000 * spec['max_cutoff_age_seconds']
            and results['conversations']['source_conversations'] > 0)


# ---------------------------------------------------------------------------
# Box-local reader projection (never exported) and the producer's evidence.
# ---------------------------------------------------------------------------
PROJECTION_SCHEMA = 'polis-backfill-verify-projection/1'
PROJECTION = ('schema', 'source_commit', 'query_policy', 'verification_sql', 'server_version_num', 'status',
              'snapshot_ms', 'results', 'no_write')
EVIDENCE_SCHEMA = 'polis-backfill-verify-evidence/1'


def validate_projection(p, spec):
    closed(p, PROJECTION)
    if p['schema'] != PROJECTION_SCHEMA or p['query_policy'] != POLICY_SHA:
        fail('VERIFY_POLICY')
    if type(p['source_commit']) is not str or not re.fullmatch('[a-f0-9]{40}', p['source_commit']):
        fail('VERIFY_BINDING')
    if p['verification_sql'] is not None:
        hexdigest(p['verification_sql'])
    integer(p['server_version_num'], 0, 2**31 - 1)
    if p['status'] not in STATUS or type(p['no_write']) is not bool:
        fail()
    if p['status'] == 'COMPLETE':
        if p['verification_sql'] != spec['verification_sql_sha256']:
            fail('VERIFY_SQL_DIGEST')
        integer(p['snapshot_ms'], MS_FLOOR, MS_CEILING, 'VERIFY_CLOCK')
        validate_results(p['results'])
    elif p['snapshot_ms'] is not None or p['results'] is not None:
        fail('VERIFY_COUNT')
    return p


def assess(p, spec):
    """The producer's evidence, recomputed independently by the verifier."""
    spec = validate_run_spec(spec)
    validate_projection(p, spec)
    if p['status'] != 'COMPLETE':
        return {'schema': EVIDENCE_SCHEMA, 'status': p['status'], 'snapshot': None, 'blocking': []}
    snap = snapshot(p['results'], p['snapshot_ms'], spec)
    return {'schema': EVIDENCE_SCHEMA, 'status': 'COMPLETE', 'snapshot': snap,
            'blocking': blocking(p['results'], snap, spec)}


# ---------------------------------------------------------------------------
# Receipt: polis-probe-receipt/3, kind backfill-verify.
# ---------------------------------------------------------------------------
RECEIPT = ('schema', 'kind', 'run_id', 'job_sha256', 'verdict', 'acceptance', 'bindings', 'run_spec', 'coverage',
           'snapshot', 'counts', 'blocking', 'controls')
BINDINGS = ('source_commit', 'reader', 'producer', 'verifier', 'query_policy', 'verification_sql',
            'server_version_num')
SNAPSHOT = ('snapshot_ms', 'cutoff_age_ms', 'source_tick_max_ms', 'target_tick_max_ms', 'target_tick_age_ms')


def expected_verdict(r):
    if r['coverage']['status'] != 'COMPLETE' or not all(r['controls'].values()):
        return 'INCOMPLETE'
    if not usable(r['snapshot'], r['counts'], r['run_spec']):
        return 'INCOMPLETE'
    return 'BACKFILL-INCOMPLETE' if r['blocking'] else 'BACKFILL-COMPLETE'


def passed(r):
    return r['verdict'] == 'BACKFILL-COMPLETE'


def validate_receipt(r, job):
    from receipt import sha
    closed(r, RECEIPT)
    if (r['schema'] != 'polis-probe-receipt/3' or r['kind'] != KIND or job.get('kind') != KIND
            or r['run_id'] != job['run_id'] or r['job_sha256'] != sha(job)):
        fail('VERIFY_BINDING')
    if r['verdict'] not in VERDICTS:
        fail('VERIFY_VERDICT')
    if r['acceptance'] != ACCEPTANCE:
        fail('VERIFY_SCOPE')
    b = closed(r['bindings'], BINDINGS)
    if type(b['source_commit']) is not str or not re.fullmatch('[a-f0-9]{40}', b['source_commit']):
        fail('VERIFY_BINDING')
    for k in ('reader', 'producer', 'verifier'):
        if b[k] != job[k]['image'].split('@sha256:')[1]:
            fail('VERIFY_IMAGE')
    if b['query_policy'] != POLICY_SHA:
        fail('VERIFY_POLICY')
    if r['run_spec'] != job['run_spec']:
        fail('VERIFY_BINDING')
    spec = validate_run_spec(r['run_spec'])
    if b['verification_sql'] != spec['verification_sql_sha256']:
        fail('VERIFY_SQL_DIGEST')
    integer(b['server_version_num'], 0, 2**31 - 1)
    cov = closed(r['coverage'], COVERAGE)
    if cov['status'] not in STATUS or {**cov, 'status': None} != COVERAGE:
        fail('VERIFY_SCOPE')
    if cov['status'] == 'COMPLETE':
        validate_results(r['counts'])
        snap = closed(r['snapshot'], SNAPSHOT)
        integer(snap['snapshot_ms'], MS_FLOOR, MS_CEILING, 'VERIFY_CLOCK')
        if snap != snapshot(r['counts'], snap['snapshot_ms'], spec):
            fail('VERIFY_COUNT')
        if r['blocking'] != blocking(r['counts'], snap, spec):
            fail('VERIFY_COUNT')
    elif r['counts'] is not None or r['snapshot'] is not None or r['blocking'] != []:
        fail('VERIFY_COUNT')
    controls = closed(r['controls'], CONTROLS)
    if any(type(v) is not bool for v in controls.values()):
        fail()
    if r['verdict'] != expected_verdict(r):
        fail('VERIFY_FALSE_PASS')
    if len(encoded(r)) > LIMIT:
        fail('VERIFY_LIMIT')
    return r
