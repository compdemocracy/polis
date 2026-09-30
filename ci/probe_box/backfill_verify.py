"""P-070 backfill completeness proof: closed run-spec, projection, switch condition and receipt.

Dependency-free: the supervisor, the operator and all three images import it.
Nothing here reads a database, a file or the wall clock. The receipt carries
counts, integer millisecond clocks, fixed condition names and digests: no
conversation ids, payloads or text.

The result is a shape and coverage proof at one cutoff, taken from one
REPEATABLE READ snapshot through the shipped verification SQL (bound by
digest). It is not numerical certification of the backfilled conversations.

What the snapshot cannot see, and so never claims:

- Poller progress. The newest `math_ticks.modified` per label is reported as
  the newest *published* tick (catch-up evidence), not liveness: a stopped
  poller in a quiet database keeps an old tick forever, and a healthy idle
  one publishes nothing. The receipt marks `poller_progress: NOT_COLLECTED`.
- The poller's sweep (saved refusals, exhausted retries, parked live work).
  Persisted failures can remain while a valid target exists and lags live
  (the P-070 reconciliation contract), so the SQL's counts do not imply an
  empty unresolved set. The receipt marks `poller_sweep: NOT_COLLECTED`.

Both are covered by a separately bound input instead: the operator's
readiness record (`run_spec.readiness`, schema polis-backfill-readiness/1),
taken from the admitted holder's own lines after DRAINED and after the
cutoff. BACKFILL-COMPLETE needs it present, matching (one primary holder,
one run/config across sweep, drain and liveness) and fresh at the snapshot:
every inner age is judged at the snapshot, not only at capture;
otherwise the verdict is BACKFILL-INCOMPLETE and names the reason. A clock
from the future (a published tick or any readiness stamp beyond the snapshot
plus CLOCK_TOLERANCE_MS, the tolerances never compounded) makes the snapshot's clocks UNKNOWN and the verdict
INCOMPLETE; it is never clamped to fresh.

The receipt is archival: decoding it is deterministic and never consults the
current time. Whether a saved receipt may still authorize the switch is a
separate check, `consumption` (at the operator's receipt phase) and `handoff`
(immediately before the S2 switch step, with the holder's current readiness
record), both against an explicit current time.
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
            'poller_progress': 'NOT_COLLECTED', 'readiness': 'OPERATOR_SUPPLIED', 'numerical': 'NOT_EVALUATED'}
MS_FLOOR, MS_CEILING = 1_500_000_000_000, 4_000_000_000_000
CUTOFF_AGE = (300, 86400)
READINESS_AGE = (60, 3600)
DISCOVERY_GAP = (10, 900)
# Allowed disagreement between the database, holder and operator clocks.
CLOCK_TOLERANCE_MS = 5_000
CLOCKS = ('PLAUSIBLE', 'UNKNOWN')

COLUMNS = {name: columns for name, columns, _ in SHIPPED if name != 'rows'}
# Switch-condition counts that must be zero (P-070 section 8, unresolved ruling).
ZERO = (('conversations', ('missing_main', 'missing_bidtopid', 'missing_ptptstats', 'missing_ticks',
                           'unequal_generation', 'uninitialized_generation', 'invalid_payload',
                           'behind_source_stale', 'source_ahead')),
        ('orphans', ('orphan_bidtopid', 'orphan_ptptstats', 'orphan_ticks')),
        ('cutoff', ('behind_input_at_cutoff', 'source_ahead_of_input')))
# The readiness record's failed conditions, in fixed order.
READINESS_BLOCKING = ('readiness-missing', 'readiness-holder-not-primary', 'readiness-run-mismatch',
                      'readiness-sweep-unresolved', 'readiness-not-drained', 'readiness-before-cutoff',
                      'readiness-discovery-stale', 'readiness-queue-stuck', 'readiness-monitoring-not-ok',
                      'readiness-expired')
FUTURE = ('future-publication-clock', 'future-readiness-clock')
BLOCKING = (tuple(n for _, names in ZERO for n in names) + ('complete-short',)
            + tuple('without-target-' + t for t in TABLES) + READINESS_BLOCKING + FUTURE)
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
    'cutoff-proof-blocks', 'without-target-blocks', 'live-lag-allowed',
    # Readiness and clock vectors (review [1453] R1).
    'readiness-missing-blocks', 'readiness-mismatch-blocks', 'readiness-stale-blocks', 'standby-holder-blocks',
    'old-publication-not-liveness', 'future-clock-incomplete')
LIVE_CONTROLS = CONTROLS[:2]


def encoded(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def fail(code='VERIFY_SCHEMA'):
    raise ValueError(code)


MAX_PROJECTION_BYTES = 65536


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


def clock(v):
    return integer(v, MS_FLOOR, MS_CEILING, 'VERIFY_CLOCK')


def hexdigest(v, code='VERIFY_DIGEST', width=64):
    if type(v) is not str or not re.fullmatch('[a-f0-9]{%d}' % width, v):
        fail(code)
    return v


# ---------------------------------------------------------------------------
# Readiness record: the admitted holder's own evidence, supplied by the
# operator after DRAINED and after the cutoff (review [1453] R1, S2 [1439]).
# Closed: counts, clocks, closed labels and digests; the verbatim lines stay
# with the operator and are bound by lines_sha256.
# ---------------------------------------------------------------------------
READINESS_SCHEMA = 'polis-backfill-readiness/1'
READINESS = ('schema', 'observed_ms', 'holder', 'discovery', 'queue', 'sweep', 'drain', 'monitoring',
             'lines_sha256')
HOLDER = ('role', 'instance_sha256', 'source_commit', 'run', 'config')
HOLDER_ROLES = ('primary', 'standby', 'report')
DISCOVERY = ('last_success_ms', 'successes', 'failures_since_success')
QUEUE = ('pending', 'oldest_work_age_ms')
SWEEP = ('sweep_no', 'finished_ms', 'run', 'config', 'status', 'unresolved', 'parked_live', 'in_flight')
SWEEP_STATUS = ('COMPLETE', 'NOT_COMPLETE', 'UNKNOWN')
DRAIN = ('run', 'drained_ms')
MONITORING = ('alarm', 'evaluated_ms', 'alert_test_sha256')
ALARMS = ('OK', 'ALARM', 'INSUFFICIENT_DATA')


def validate_readiness(v):
    """The closed record, or ValueError. Shape and types only; `readiness_failures` judges it."""
    closed(v, READINESS)
    if v['schema'] != READINESS_SCHEMA:
        fail('VERIFY_READINESS')
    clock(v['observed_ms'])
    hexdigest(v['lines_sha256'])
    h = closed(v['holder'], HOLDER)
    if h['role'] not in HOLDER_ROLES:
        fail('VERIFY_READINESS')
    hexdigest(h['instance_sha256'])
    hexdigest(h['source_commit'], width=40)
    hexdigest(h['run'], width=12)
    hexdigest(h['config'], width=12)
    d = closed(v['discovery'], DISCOVERY)
    clock(d['last_success_ms'])
    integer(d['successes'])
    integer(d['failures_since_success'])
    for k in closed(v['queue'], QUEUE).values():
        integer(k)
    s = closed(v['sweep'], SWEEP)
    integer(s['sweep_no'], 1)
    clock(s['finished_ms'])
    hexdigest(s['run'], width=12)
    hexdigest(s['config'], width=12)
    if s['status'] not in SWEEP_STATUS:
        fail('VERIFY_READINESS')
    for k in ('unresolved', 'parked_live', 'in_flight'):
        integer(s[k])
    dr = closed(v['drain'], DRAIN)
    hexdigest(dr['run'], width=12)
    if dr['drained_ms'] is not None:
        clock(dr['drained_ms'])
    m = closed(v['monitoring'], MONITORING)
    if m['alarm'] not in ALARMS:
        fail('VERIFY_READINESS')
    clock(m['evaluated_ms'])
    if m['alert_test_sha256'] is not None:
        hexdigest(m['alert_test_sha256'])
    return v


def readiness_digest(v):
    return None if v is None else hashlib.sha256(encoded(v)).hexdigest()


def readiness_future(v, reference_ms):
    """Any readiness stamp beyond the reference (snapshot or now) plus the
    tolerance, or an inner stamp beyond its own observation plus the tolerance.

    Each inner stamp is compared with the reference directly as well as with the
    observation, so the two allowances never add up (review [1455] R2): no stamp
    may exceed reference + CLOCK_TOLERANCE_MS.
    """
    if v is None:
        return False
    observed = v['observed_ms']
    inner = (v['discovery']['last_success_ms'], v['sweep']['finished_ms'], v['drain']['drained_ms'],
             v['monitoring']['evaluated_ms'])
    return (observed > reference_ms + CLOCK_TOLERANCE_MS
            or any(t is not None and (t > reference_ms + CLOCK_TOLERANCE_MS or t > observed + CLOCK_TOLERANCE_MS)
                   for t in inner))


def readiness_failures(v, spec, reference_ms):
    """Failed READINESS_BLOCKING names for record `v` judged at `reference_ms`.

    `reference_ms` is the decision time: the verifier's snapshot for the verdict,
    the current time for launch and handoff. Every inner age (discovery success,
    queued work, monitoring evaluation) is measured against it, and also against
    the record's own observation; the record-age bound (`readiness-expired`) is
    an additional check, never a replacement (review [1455] R1). A record
    captured earlier is history: its capture-time freshness is never current
    progress, and waiting inside the 900 s record bound never extends the
    discovery gap.
    """
    if v is None:
        return ['readiness-missing']
    failed = set()
    h, d, qu, s, dr, m = (v[k] for k in ('holder', 'discovery', 'queue', 'sweep', 'drain', 'monitoring'))
    observed, cutoff = v['observed_ms'], spec['cutoff_ms']
    gap = 1000 * spec['max_discovery_gap_seconds']
    bound = 1000 * spec['max_readiness_age_seconds']
    # Time since capture: the record's own clock may lead the reference by the tolerance.
    waited = max(0, reference_ms - observed)
    # A standby or report process never satisfies the holder's liveness.
    if h['role'] != 'primary':
        failed.add('readiness-holder-not-primary')
    # Sweep, drain and liveness all from the admitted holder's one run/config.
    if s['run'] != h['run'] or s['config'] != h['config'] or dr['run'] != h['run']:
        failed.add('readiness-run-mismatch')
    if s['status'] != 'COMPLETE' or s['unresolved'] or s['parked_live'] or s['in_flight']:
        failed.add('readiness-sweep-unresolved')
    # The cutoff is taken after DRAINED.
    if dr['drained_ms'] is None or dr['drained_ms'] > cutoff:
        failed.add('readiness-not-drained')
    if observed < cutoff:
        failed.add('readiness-before-cutoff')
    # Genuine discovery-loop progress after the cutoff (empty successful polls
    # count; publications do not), with no failure since the last success,
    # within the gap at observation AND at the decision.
    last = d['last_success_ms']
    if (d['successes'] == 0 or d['failures_since_success'] or last < cutoff
            or observed - last > gap or reference_ms - last > gap):
        failed.add('readiness-discovery-stale')
    # Pending work keeps ageing while the record waits; an empty queue does not.
    if qu['oldest_work_age_ms'] > gap or (qu['pending'] and qu['oldest_work_age_ms'] + waited > gap):
        failed.add('readiness-queue-stuck')
    if (m['alarm'] != 'OK' or m['alert_test_sha256'] is None
            or observed - m['evaluated_ms'] > bound or reference_ms - m['evaluated_ms'] > bound):
        failed.add('readiness-monitoring-not-ok')
    if reference_ms - observed > bound:
        failed.add('readiness-expired')
    return [n for n in READINESS_BLOCKING if n in failed]


# ---------------------------------------------------------------------------
# Run-spec: operator inputs carried in the admitted job. No ids, no SQL.
# ---------------------------------------------------------------------------
RUN_SPEC = ('source_env', 'target_env', 'cutoff_ms', 'max_cutoff_age_seconds', 'max_readiness_age_seconds',
            'max_discovery_gap_seconds', 'source_ahead_ruling', 'verification_sql_sha256', 'readiness')
# The registry template; the operator replaces run_id, cutoff_ms and
# readiness. Its floor cutoff is refused at launch (contracts.refuse_placeholder).
TEMPLATE_RUN_SPEC = {'source_env': SOURCE, 'target_env': TARGET, 'cutoff_ms': MS_FLOOR,
                     'max_cutoff_age_seconds': 3600, 'max_readiness_age_seconds': 900,
                     'max_discovery_gap_seconds': 120, 'source_ahead_ruling': 'unresolved',
                     'verification_sql_sha256': SQL_SHA256, 'readiness': None}


def validate_run_spec(v):
    closed(v, RUN_SPEC)
    if v['source_env'] != SOURCE or v['target_env'] != TARGET:
        fail('VERIFY_ENV')
    integer(v['cutoff_ms'], MS_FLOOR, MS_CEILING, 'VERIFY_RUN_SPEC')
    integer(v['max_cutoff_age_seconds'], *CUTOFF_AGE, 'VERIFY_RUN_SPEC')
    integer(v['max_readiness_age_seconds'], *READINESS_AGE, 'VERIFY_RUN_SPEC')
    integer(v['max_discovery_gap_seconds'], *DISCOVERY_GAP, 'VERIFY_RUN_SPEC')
    if type(v['source_ahead_ruling']) is not str or v['source_ahead_ruling'] not in RULINGS:
        fail('VERIFY_RULING')
    # The job names the reviewed SQL; any other digest is refused before a read.
    if v['verification_sql_sha256'] != SQL_SHA256:
        fail('VERIFY_SQL_DIGEST')
    # Absent readiness is allowed and reported (readiness-missing), never assumed.
    if v['readiness'] is not None:
        validate_readiness(v['readiness'])
    return dict(v)


# ---------------------------------------------------------------------------
# Counts: closed shape and the cross-query consistency of one snapshot.
# ---------------------------------------------------------------------------
RESULTS = ('rows', 'conversations', 'orphans', 'payloads', 'cutoff', 'without_target', 'published')


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
    published = closed(r['published'], ('source_newest_ms', 'target_newest_ms'))
    for k in published.values():
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
        if (rows['math_ticks'][label] == 0) != (published[label + '_newest_ms'] is None):
            fail('VERIFY_CONSISTENCY')
    return r


def snapshot(results, snapshot_ms, spec):
    """Derived clocks, all from the snapshot's own transaction timestamp.

    The newest published tick per label is catch-up evidence only; its age is
    null when absent or from the future (never clamped to zero), and a future
    publication or readiness clock makes `clock` UNKNOWN.
    """
    pub = results['published']
    limit = snapshot_ms + CLOCK_TOLERANCE_MS
    future_pub = any(t is not None and t > limit for t in pub.values())
    readiness = spec['readiness']
    target = pub['target_newest_ms']
    return {'snapshot_ms': snapshot_ms, 'cutoff_age_ms': snapshot_ms - spec['cutoff_ms'],
            'newest_published_source_ms': pub['source_newest_ms'], 'newest_published_target_ms': target,
            'newest_published_target_age_ms': (None if target is None or target > limit
                                               else max(0, snapshot_ms - target)),
            'readiness_age_ms': None if readiness is None else snapshot_ms - readiness['observed_ms'],
            'clock': 'UNKNOWN' if future_pub or readiness_future(readiness, snapshot_ms) else 'PLAUSIBLE'}


def blocking(results, snap, spec):
    """The failed switch conditions, in the fixed BLOCKING order."""
    failed = [n for group, names in ZERO for n in names if results[group][n]]
    c = results['conversations']
    if c['complete'] != c['source_conversations']:
        failed.append('complete-short')
    failed += ['without-target-' + t for t in TABLES if results['without_target'][t]]
    # Poller progress is not in the snapshot: the readiness record carries it.
    failed += readiness_failures(spec['readiness'], spec, snap['snapshot_ms'])
    limit = snap['snapshot_ms'] + CLOCK_TOLERANCE_MS
    if any(t is not None and t > limit for t in results['published'].values()):
        failed.append('future-publication-clock')
    if readiness_future(spec['readiness'], snap['snapshot_ms']):
        failed.append('future-readiness-clock')
    return failed


def usable(snap, results, spec):
    """Evidence a verdict can rest on: plausible clocks and a fresh cutoff, not in
    the future, over a non-empty source set."""
    age = snap['cutoff_age_ms']
    return (snap['clock'] == 'PLAUSIBLE' and 0 <= age <= 1000 * spec['max_cutoff_age_seconds']
            and results['conversations']['source_conversations'] > 0)


POLICY = {'schema': 'polis-backfill-verify-policy/2', 'source': SOURCE, 'target': TARGET,
          'verification_sql': SQL_SHA256, 'shipped': [[n, list(c), k] for n, c, k in SHIPPED],
          'tables': list(TABLES), 'read_tables': list(READ_TABLES), 'status': list(STATUS),
          'rulings': list(RULINGS), 'blocking': list(BLOCKING), 'controls': list(CONTROLS),
          'verdicts': list(VERDICTS), 'acceptance': ACCEPTANCE, 'coverage': COVERAGE,
          'cutoff_age_seconds': list(CUTOFF_AGE), 'readiness_age_seconds': list(READINESS_AGE),
          'discovery_gap_seconds': list(DISCOVERY_GAP), 'clock_tolerance_ms': CLOCK_TOLERANCE_MS,
          'readiness_schema': READINESS_SCHEMA, 'holder_roles': list(HOLDER_ROLES), 'max_bytes': LIMIT}
POLICY_SHA = hashlib.sha256(encoded({'policy': POLICY, 'queries': EXTRA, 'settings': SETTINGS})).hexdigest()


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
            'server_version_num', 'readiness')
SNAPSHOT = ('snapshot_ms', 'cutoff_age_ms', 'newest_published_source_ms', 'newest_published_target_ms',
            'newest_published_target_age_ms', 'readiness_age_ms', 'clock')


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
    if b['readiness'] != readiness_digest(spec['readiness']):
        fail('VERIFY_BINDING')
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


# ---------------------------------------------------------------------------
# Current-time readiness (review [1453] R2). Never part of decoding: a saved
# receipt stays valid historical evidence at any later time. These answer a
# different question, whether it may still authorize the switch *now*, from
# an explicit `now_ms` the caller reads once.
# ---------------------------------------------------------------------------
CONSUMPTION = ('FRESH', 'EXPIRED', 'UNKNOWN', 'NOT_COMPLETE')
HANDOFF = ('READY', 'EXPIRED', 'UNKNOWN', 'REFUSED', 'NOT_COMPLETE')
NEW_PROOF = ('new proof required: the saved receipt is historical evidence only; start again from prep '
             '(fresh operator dir, new cutoff after DRAINED, current readiness record)')
_EXPIRY = ('cutoff-expired', 'current-readiness-expired')
_CLOCK = ('clock-reversal', 'future-readiness-clock', 'future-current-readiness-clock')


def consumption(r, now_ms):
    """Whether a decoded, passed receipt is still fresh at `now_ms`.

    Requires cutoff <= snapshot <= now (within CLOCK_TOLERANCE_MS) and now
    minus the cutoff within max_cutoff_age_seconds. The bound readiness record
    was judged fresh at the snapshot; the holder's state *now* is `handoff`'s
    current record, not this one's age.
    """
    clock(now_ms)
    out = {'status': 'NOT_COMPLETE', 'reasons': ['receipt-not-complete'], 'now_ms': now_ms,
           'cutoff_age_ms': None, 'readiness_age_ms': None}
    if not passed(r):
        return out
    spec, snap = r['run_spec'], r['snapshot']
    cutoff, taken, readiness = spec['cutoff_ms'], snap['snapshot_ms'], spec['readiness']
    out.update(cutoff_age_ms=now_ms - cutoff, readiness_age_ms=now_ms - readiness['observed_ms'])
    reasons = []
    if not cutoff <= taken <= now_ms + CLOCK_TOLERANCE_MS:
        reasons.append('clock-reversal')
    if readiness_future(readiness, now_ms):
        reasons.append('future-readiness-clock')
    if now_ms - cutoff > 1000 * spec['max_cutoff_age_seconds']:
        reasons.append('cutoff-expired')
    out['reasons'] = reasons
    out['status'] = ('UNKNOWN' if any(n in _CLOCK for n in reasons) else 'EXPIRED' if reasons else 'FRESH')
    return out


def handoff(r, current, now_ms):
    """The switch gate, immediately before the S2 secret/deploy step.

    The receipt must be fresh now, and `current` (the holder's readiness record
    read now) must be valid, from the same holder, run and config as the one
    bound into the job, captured after it (resubmitting the bound record, or
    any capture no newer than it, is refused), and pass every readiness
    condition against the job's cutoff with every inner age judged at
    `now_ms`. READY only then.
    """
    out = consumption(r, now_ms)
    if out['status'] == 'NOT_COMPLETE':
        return dict(out, status='NOT_COMPLETE', current_readiness=None)
    reasons = list(out['reasons'])
    spec = r['run_spec']
    bound = spec['readiness']
    digest = None
    if current is None:
        reasons.append('current-readiness-missing')
    else:
        try:
            validate_readiness(current)
        except (ValueError, KeyError, TypeError):
            reasons.append('current-readiness-invalid')
        else:
            digest = readiness_digest(current)
            if current['holder'] != bound['holder']:
                reasons.append('current-readiness-mismatch')
            # The launch-bound record is history; only a newer capture is current.
            if current['observed_ms'] <= bound['observed_ms']:
                reasons.append('current-readiness-not-refreshed')
            if readiness_future(current, now_ms):
                reasons.append('future-current-readiness-clock')
            for name in readiness_failures(current, spec, now_ms):
                reasons.append('current-readiness-expired' if name == 'readiness-expired' else 'current-' + name)
    if any(n in _CLOCK for n in reasons):
        status = 'UNKNOWN'
    elif not reasons:
        status = 'READY'
    elif all(n in _EXPIRY for n in reasons):
        status = 'EXPIRED'
    else:
        status = 'REFUSED'
    return dict(out, status=status, reasons=reasons, current_readiness=digest)
