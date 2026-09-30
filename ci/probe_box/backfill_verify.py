"""P-070 backfill completeness proof: closed run-spec, projection, switch condition and receipt.

Dependency-free: the supervisor, the operator and all three images import it.
Nothing here reads a database, a file or the wall clock. The receipt carries
counts, integer millisecond clocks, fixed condition names and digests: no
conversation ids, payloads or text.

Two gates, kept apart (design (b), review [1459]):

1. The HISTORICAL proof, the receipt. A shape and coverage proof at one
   cutoff, taken from one REPEATABLE READ snapshot through the shipped
   verification SQL (bound by digest), plus the holder's history bound into
   the job at launch: one primary holder, one run/config across its lines,
   sweep and drain, a clean sweep and DRAINED before the cutoff. The history
   record (`run_spec.readiness`, schema polis-backfill-readiness/2) is judged
   at its own observation, never at the snapshot, so probe boot and image-load
   latency never set the age of evidence; its age is bounded by the cutoff
   instead (observed at or after the cutoff, and the cutoff within
   max_cutoff_age_seconds of the snapshot). BACKFILL-COMPLETE means
   completeness proven, `coverage.readiness: HISTORICAL`. It is never switch
   readiness, and it is not numerical certification of the backfilled
   conversations.

2. CURRENT SWITCH READINESS, asserted only by `handoff`, immediately before
   the S2 switch step, from a record collected after the proof is available
   (schema polis-backfill-current-readiness/1): the same admitted holder,
   source, run and config as the bound history, a newer capture with an
   advanced readiness sequence, discovery within max_discovery_gap_seconds
   (at most 120 s) of now, pending and parked work aged to now, the latest
   clean sweep and the same DRAINED, alarms OK now and the alert-test
   evidence (math_poller.alert_test_evidence/2) checked structurally, the
   cutoff still inside its bound, and no intervening change (the same job
   and receipt, no other receipt, no newer hand-off). READY exists only
   there; a stopped or restarted holder cannot inherit it from the history.
   Every hand-off attempt, refusals included, enters the proof's attempt
   ledger (polis-backfill-handoff-attempt/1, one create-only private file
   each, chained by digest), and each later attempt is judged against it: no
   input that is not newer than the latest observation, an observed
   holder/run/config or drain change invalidates the proof, and at most one
   READY per proof (review [1463]).

What the snapshot cannot see, and so never claims:

- Poller progress. The newest `math_ticks.modified` per label is reported as
  the newest *published* tick (catch-up evidence), not liveness: a stopped
  poller in a quiet database keeps an old tick forever, and a healthy idle
  one publishes nothing. The receipt marks `poller_progress: NOT_COLLECTED`.
- The poller's sweep (saved refusals, exhausted retries, parked live work).
  Persisted failures can remain while a valid target exists and lags live
  (the P-070 reconciliation contract), so the SQL's counts do not imply an
  empty unresolved set. The receipt marks `poller_sweep: NOT_COLLECTED`.

Both are covered by the bound history (for the proof) and the current record
(for the switch). Missing, mismatched, malformed or future-dated history is
never ignored: BACKFILL-COMPLETE needs it present and passing, otherwise the
verdict is BACKFILL-INCOMPLETE and names the reason. A clock from the future
(a published tick or any history stamp beyond the snapshot plus
CLOCK_TOLERANCE_MS, the tolerances never compounded) makes the snapshot's
clocks UNKNOWN and the verdict INCOMPLETE; it is never clamped to fresh.

The receipt is archival: decoding it is deterministic and never consults the
current time. Whether a saved receipt may still be used is a separate check,
`consumption` (at the operator's receipt phase: the cutoff is still inside
its bound) and `handoff` (the switch gate above), both against an explicit
current time.
"""
from __future__ import annotations
import hashlib
import json
import re

from backfill_verify_queries import (EXTRA, READ_TABLES, SETTINGS, SHIPPED, SOURCE, SQL_SHA256, TABLES,
                                     TARGET)

KIND = 'backfill-verify'
LIMIT = 16384
# BACKFILL-COMPLETE is completeness proven with historical holder evidence;
# READY exists only in the hand-off (HANDOFF), never in a receipt.
VERDICTS = ('BACKFILL-COMPLETE', 'BACKFILL-INCOMPLETE', 'INCOMPLETE')
ACCEPTANCE = ('shape and coverage at one cutoff with historical holder evidence; '
              'not switch readiness; not numerical certification')
# COMPLETE, or why the snapshot produced no evidence. Never a zero count.
STATUS = ('COMPLETE', 'NOT_VISIBLE', 'TIMEOUT', 'QUERY_FAILED', 'LIMIT_EXCEEDED', 'SQL_MISMATCH')
# Only the default disposition exists until Colin rules on source-ahead (P-070 section 11).
RULINGS = ('unresolved',)
COVERAGE = {'status': None, 'tables': list(READ_TABLES), 'poller_sweep': 'NOT_COLLECTED',
            'poller_progress': 'NOT_COLLECTED', 'readiness': 'HISTORICAL', 'switch_readiness': 'HANDOFF_ONLY',
            'numerical': 'NOT_EVALUATED'}
MS_FLOOR, MS_CEILING = 1_500_000_000_000, 4_000_000_000_000
CUTOFF_AGE = (300, 86400)
READINESS_AGE = (60, 3600)
# Never above 120 s: the gap is also the current gate's bound at the hand-off,
# so a wider gap (option (a) of review [1459]) is refused, not configurable.
DISCOVERY_GAP = (10, 120)
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
# A readiness record's conditions, in fixed order. The history (bound at
# launch, judged at its own observation) never has an age of its own beyond
# the cutoff's; `expired` applies only against a decision time (launch, hand-off).
CONDITIONS = ('holder-not-primary', 'run-mismatch', 'sweep-unresolved', 'not-drained', 'before-cutoff',
              'discovery-stale', 'queue-stuck', 'monitoring-not-ok', 'expired')
HISTORY_BLOCKING = ('history-missing',) + tuple('history-' + n for n in CONDITIONS if n != 'expired')
FUTURE = ('future-publication-clock', 'future-history-clock')
BLOCKING = (tuple(n for _, names in ZERO for n in names) + ('complete-short',)
            + tuple('without-target-' + t for t in TABLES) + HISTORY_BLOCKING + FUTURE)
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
    # History and clock vectors (review [1453] R1), built from the job's own
    # limits (review [1459]): history judged at its observation, never at the snapshot.
    'history-missing-blocks', 'history-mismatch-blocks', 'history-stale-blocks', 'standby-holder-blocks',
    'long-launch-history-allowed', 'old-publication-not-liveness', 'future-clock-incomplete')
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
# Readiness record: the admitted holder's own evidence, closed: counts,
# clocks, closed labels and digests; the verbatim lines stay with the operator
# and are bound by lines_sha256. The same shape serves twice: bound into the
# job at launch as the history (after DRAINED and after the cutoff), and
# inside the current record at the hand-off (review [1459], design (b)).
# `seq` is the holder's readiness-line sequence (monotonic per process run);
# `queue.parked` counts parked live work, which ages like pending work.
# ---------------------------------------------------------------------------
READINESS_SCHEMA = 'polis-backfill-readiness/2'
READINESS = ('schema', 'observed_ms', 'seq', 'holder', 'discovery', 'queue', 'sweep', 'drain', 'monitoring',
             'lines_sha256')
HOLDER = ('role', 'instance_sha256', 'source_commit', 'run', 'config')
HOLDER_ROLES = ('primary', 'standby', 'report')
DISCOVERY = ('last_success_ms', 'successes', 'failures_since_success')
QUEUE = ('pending', 'parked', 'oldest_work_age_ms')
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
    integer(v['seq'])
    hexdigest(v['lines_sha256'])
    validate_holder(v['holder'])
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
    validate_drain(v['drain'])
    m = closed(v['monitoring'], MONITORING)
    if m['alarm'] not in ALARMS:
        fail('VERIFY_READINESS')
    clock(m['evaluated_ms'])
    if m['alert_test_sha256'] is not None:
        hexdigest(m['alert_test_sha256'])
    return v


def validate_holder(h):
    closed(h, HOLDER)
    if h['role'] not in HOLDER_ROLES:
        fail('VERIFY_READINESS')
    hexdigest(h['instance_sha256'])
    hexdigest(h['source_commit'], width=40)
    hexdigest(h['run'], width=12)
    hexdigest(h['config'], width=12)
    return h


def validate_drain(dr):
    closed(dr, DRAIN)
    hexdigest(dr['run'], width=12)
    if dr['drained_ms'] is not None:
        clock(dr['drained_ms'])
    return dr


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


def readiness_failures(v, spec, reference_ms=None):
    """Failed CONDITIONS for record `v`, in fixed order.

    Without `reference_ms` the record is history: every inner age (discovery
    success, queued work, monitoring evaluation) is judged at its own
    observation, and `expired` never applies; the cutoff bounds its age
    (observed at or after the cutoff; the cutoff inside max_cutoff_age_seconds
    of the snapshot). That is how the verdict judges the bound history, so probe
    launch latency never decides it (review [1459]).

    With `reference_ms` (launch and the hand-off, the current time) every inner
    age is also judged against it: discovery within the gap of now, pending or
    parked work aged by the time since capture (an empty queue does not age),
    the alarm evaluation within the readiness bound of now, and the record-age
    bound (`expired`) as an additional check (review [1455] R1).
    """
    failed = set()
    h, d, qu, s, dr, m = (v[k] for k in ('holder', 'discovery', 'queue', 'sweep', 'drain', 'monitoring'))
    observed, cutoff = v['observed_ms'], spec['cutoff_ms']
    gap = 1000 * spec['max_discovery_gap_seconds']
    bound = 1000 * spec['max_readiness_age_seconds']
    at = (observed,) if reference_ms is None else (observed, reference_ms)
    # Time since capture: the record's own clock may lead the reference by the tolerance.
    waited = 0 if reference_ms is None else max(0, reference_ms - observed)
    # A standby or report process never satisfies the holder's liveness.
    if h['role'] != 'primary':
        failed.add('holder-not-primary')
    # Sweep, drain and liveness all from the admitted holder's one run/config.
    if s['run'] != h['run'] or s['config'] != h['config'] or dr['run'] != h['run']:
        failed.add('run-mismatch')
    if s['status'] != 'COMPLETE' or s['unresolved'] or s['parked_live'] or s['in_flight']:
        failed.add('sweep-unresolved')
    # The cutoff is taken after DRAINED.
    if dr['drained_ms'] is None or dr['drained_ms'] > cutoff:
        failed.add('not-drained')
    if observed < cutoff:
        failed.add('before-cutoff')
    # Genuine discovery-loop progress after the cutoff (empty successful polls
    # count; publications do not), with no failure since the last success.
    last = d['last_success_ms']
    if d['successes'] == 0 or d['failures_since_success'] or last < cutoff or any(t - last > gap for t in at):
        failed.add('discovery-stale')
    # Pending or parked work keeps ageing while the record waits; an empty queue does not.
    work = qu['pending'] or qu['parked'] or qu['oldest_work_age_ms']
    if qu['oldest_work_age_ms'] > gap or (work and qu['oldest_work_age_ms'] + waited > gap):
        failed.add('queue-stuck')
    if m['alarm'] != 'OK' or m['alert_test_sha256'] is None or any(t - m['evaluated_ms'] > bound for t in at):
        failed.add('monitoring-not-ok')
    if reference_ms is not None and reference_ms - observed > bound:
        failed.add('expired')
    return [n for n in CONDITIONS if n in failed]


def history_failures(v, spec):
    """The bound history's failed HISTORY_BLOCKING names, judged at its own observation."""
    if v is None:
        return ['history-missing']
    return ['history-' + n for n in readiness_failures(v, spec)]


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
    integer(v['max_discovery_gap_seconds'], 0, 2**31 - 1, 'VERIFY_RUN_SPEC')
    # The gap is the current gate's bound too: widening it for probe latency
    # (option (a), review [1459]) is refused by name, never silently accepted.
    if not DISCOVERY_GAP[0] <= v['max_discovery_gap_seconds'] <= DISCOVERY_GAP[1]:
        fail('VERIFY_DISCOVERY_GAP')
    if type(v['source_ahead_ruling']) is not str or v['source_ahead_ruling'] not in RULINGS:
        fail('VERIFY_RULING')
    # The job names the reviewed SQL; any other digest is refused before a read.
    if v['verification_sql_sha256'] != SQL_SHA256:
        fail('VERIFY_SQL_DIGEST')
    # Absent history is allowed and reported (history-missing), never assumed.
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
    publication or history clock makes `clock` UNKNOWN. `history_age_ms` is
    reported, not judged: the history's age is bounded by the cutoff's.
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
            'history_age_ms': None if readiness is None else snapshot_ms - readiness['observed_ms'],
            'clock': 'UNKNOWN' if future_pub or readiness_future(readiness, snapshot_ms) else 'PLAUSIBLE'}


def blocking(results, snap, spec):
    """The failed switch conditions, in the fixed BLOCKING order."""
    failed = [n for group, names in ZERO for n in names if results[group][n]]
    c = results['conversations']
    if c['complete'] != c['source_conversations']:
        failed.append('complete-short')
    failed += ['without-target-' + t for t in TABLES if results['without_target'][t]]
    # Poller progress is not in the snapshot: the bound history carries it,
    # judged at its own observation (review [1459]); never current readiness.
    failed += history_failures(spec['readiness'], spec)
    limit = snap['snapshot_ms'] + CLOCK_TOLERANCE_MS
    if any(t is not None and t > limit for t in results['published'].values()):
        failed.append('future-publication-clock')
    if readiness_future(spec['readiness'], snap['snapshot_ms']):
        failed.append('future-history-clock')
    return failed


def usable(snap, results, spec):
    """Evidence a verdict can rest on: plausible clocks and a fresh cutoff, not in
    the future, over a non-empty source set."""
    age = snap['cutoff_age_ms']
    return (snap['clock'] == 'PLAUSIBLE' and 0 <= age <= 1000 * spec['max_cutoff_age_seconds']
            and results['conversations']['source_conversations'] > 0)


POLICY = {'schema': 'polis-backfill-verify-policy/3', 'source': SOURCE, 'target': TARGET,
          'verification_sql': SQL_SHA256, 'shipped': [[n, list(c), k] for n, c, k in SHIPPED],
          'tables': list(TABLES), 'read_tables': list(READ_TABLES), 'status': list(STATUS),
          'rulings': list(RULINGS), 'blocking': list(BLOCKING), 'controls': list(CONTROLS),
          'verdicts': list(VERDICTS), 'acceptance': ACCEPTANCE, 'coverage': COVERAGE,
          'cutoff_age_seconds': list(CUTOFF_AGE), 'readiness_age_seconds': list(READINESS_AGE),
          'discovery_gap_seconds': list(DISCOVERY_GAP), 'clock_tolerance_ms': CLOCK_TOLERANCE_MS,
          'readiness_schema': READINESS_SCHEMA, 'holder_roles': list(HOLDER_ROLES), 'conditions': list(CONDITIONS),
          'max_bytes': LIMIT}
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
            'newest_published_target_age_ms', 'history_age_ms', 'clock')


def expected_verdict(r):
    if r['coverage']['status'] != 'COMPLETE' or not all(r['controls'].values()):
        return 'INCOMPLETE'
    if not usable(r['snapshot'], r['counts'], r['run_spec']):
        return 'INCOMPLETE'
    return 'BACKFILL-INCOMPLETE' if r['blocking'] else 'BACKFILL-COMPLETE'


def passed(r):
    """Completeness proven at the cutoff (historical); never switch readiness, which only `handoff` asserts."""
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
# Current time (reviews [1453] R2, [1459] design (b)). Never part of decoding:
# a saved receipt stays valid historical evidence at any later time. These
# answer different questions from an explicit `now_ms` the caller reads once:
# `consumption`, whether the proof's cutoff is still inside its bound (the
# receipt phase), and `handoff`, the only gate that may say READY.
# ---------------------------------------------------------------------------
CONSUMPTION = ('FRESH', 'EXPIRED', 'UNKNOWN', 'NOT_COMPLETE')
HANDOFF = ('READY', 'EXPIRED', 'UNKNOWN', 'REFUSED', 'NOT_COMPLETE')
NEW_PROOF = ('new proof required: the saved receipt is historical evidence only; start again from prep '
             '(fresh operator dir, new cutoff after DRAINED, history record bound at launch)')


def consumption(r, now_ms):
    """Whether a decoded, passed receipt's cutoff is still fresh at `now_ms`.

    Requires cutoff <= snapshot <= now (within CLOCK_TOLERANCE_MS) and now
    minus the cutoff within max_cutoff_age_seconds. FRESH is not switch
    readiness: the holder's state *now* is `handoff`'s current record.
    """
    clock(now_ms)
    out = {'status': 'NOT_COMPLETE', 'reasons': ['receipt-not-complete'], 'now_ms': now_ms,
           'cutoff_age_ms': None, 'history_age_ms': None}
    if not passed(r):
        return out
    spec, snap = r['run_spec'], r['snapshot']
    cutoff, taken, readiness = spec['cutoff_ms'], snap['snapshot_ms'], spec['readiness']
    out.update(cutoff_age_ms=now_ms - cutoff, history_age_ms=now_ms - readiness['observed_ms'])
    reasons = []
    if not cutoff <= taken <= now_ms + CLOCK_TOLERANCE_MS:
        reasons.append('clock-reversal')
    if readiness_future(readiness, now_ms):
        reasons.append('future-history-clock')
    if now_ms - cutoff > 1000 * spec['max_cutoff_age_seconds']:
        reasons.append('cutoff-expired')
    out['reasons'] = reasons
    out['status'] = ('UNKNOWN' if any(n in _CLOCK for n in reasons) else 'EXPIRED' if reasons else 'FRESH')
    return out


# The proof is available: written create-only by the receipt phase once the
# receipt is saved, passed and FRESH. The current record must postdate it.
PROOF_SCHEMA = 'polis-backfill-proof/1'
PROOF = ('schema', 'run_id', 'job_sha256', 'receipt_sha256', 'verdict', 'readiness', 'cutoff_ms', 'snapshot_ms',
         'available_ms')


def proof_record(r, receipt_sha256, available_ms):
    """The proof-available record for a passed receipt, saved at `available_ms`."""
    if not passed(r):
        fail('VERIFY_NOT_COMPLETE')
    return validate_proof({'schema': PROOF_SCHEMA, 'run_id': r['run_id'], 'job_sha256': r['job_sha256'],
                           'receipt_sha256': receipt_sha256, 'verdict': 'BACKFILL-COMPLETE',
                           'readiness': 'HISTORICAL', 'cutoff_ms': r['run_spec']['cutoff_ms'],
                           'snapshot_ms': r['snapshot']['snapshot_ms'], 'available_ms': available_ms})


def validate_proof(v):
    closed(v, PROOF)
    if v['schema'] != PROOF_SCHEMA or v['verdict'] != 'BACKFILL-COMPLETE' or v['readiness'] != 'HISTORICAL':
        fail('VERIFY_PROOF')
    hexdigest(v['run_id'], width=32)
    hexdigest(v['job_sha256'])
    hexdigest(v['receipt_sha256'])
    for k in ('cutoff_ms', 'snapshot_ms', 'available_ms'):
        clock(v[k])
    return v


# The alert-test evidence as P-072's collector writes it (schema /2), checked
# structurally here; the collector checks it against CloudWatch. Only its
# digest enters the readiness record (monitoring.alert_test_sha256).
ALERT_TEST_SCHEMA = 'math_poller.alert_test_evidence/2'
ALERT_TEST = ('schema', 'nonce', 'tested_run', 'tested_run_primary', 'holder_runs', 'emitted_ms', 'silence_s',
              'test_line_sha256', 'transitions', 'notifications', 'topic_arn', 'alarm_config_sha256',
              'receipt_sha256')
STALE_ALARM, HEARTBEAT_ALARM = 'Polis-MathPoller-DiscoveryStale', 'Polis-MathPoller-HeartbeatMissing'
ALERT_STATES = ('OK', 'ALARM', 'INSUFFICIENT_DATA')
TOPIC_ARN = r'arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}'
MAX_ALERT_ITEMS = 64


def validate_alert_test(doc):
    """The closed alert-test document {evidence, sha256}; returns its sha256.

    Requires a DiscoveryStale ALARM transition and a successful SNS action on
    the evidence's own topic at or after the test line; a heartbeat drill
    (silence_s > 0) also needs the HeartbeatMissing transition and action,
    and the tested run among the holder runs.
    """
    closed(doc, ('evidence', 'sha256'))
    ev = closed(doc['evidence'], ALERT_TEST)
    if ev['schema'] != ALERT_TEST_SCHEMA:
        fail('VERIFY_ALERT_TEST')
    if type(ev['nonce']) is not str or not re.fullmatch('[a-f0-9]{16,64}', ev['nonce']):
        fail('VERIFY_ALERT_TEST')
    hexdigest(ev['tested_run'], width=12)
    if type(ev['tested_run_primary']) is not bool or type(ev['holder_runs']) is not list:
        fail('VERIFY_ALERT_TEST')
    for run in ev['holder_runs']:
        hexdigest(run, width=12)
    if ev['holder_runs'] != sorted(set(ev['holder_runs'])) or len(ev['holder_runs']) > MAX_ALERT_ITEMS:
        fail('VERIFY_ALERT_TEST')
    if ev['tested_run_primary'] != (ev['tested_run'] in ev['holder_runs']):
        fail('VERIFY_ALERT_TEST')
    since = clock(ev['emitted_ms'])
    integer(ev['silence_s'], 0, 3600)
    for k in ('test_line_sha256', 'alarm_config_sha256', 'receipt_sha256'):
        hexdigest(ev[k])
    if type(ev['topic_arn']) is not str or not re.fullmatch(TOPIC_ARN, ev['topic_arn']):
        fail('VERIFY_ALERT_TEST')
    items = (ev['transitions'], ev['notifications'])
    if any(type(x) is not list or not x or len(x) > MAX_ALERT_ITEMS for x in items):
        fail('VERIFY_ALERT_TEST')
    for t in ev['transitions']:
        closed(t, ('alarm', 'at_ms', 'from', 'to'))
        if (t['alarm'] not in (STALE_ALARM, HEARTBEAT_ALARM) or t['to'] != 'ALARM'
                or (t['from'] is not None and t['from'] not in ALERT_STATES) or clock(t['at_ms']) < since):
            fail('VERIFY_ALERT_TEST')
    for n in ev['notifications']:
        closed(n, ('alarm', 'at_ms', 'summary', 'data'))
        if (n['alarm'] not in (STALE_ALARM, HEARTBEAT_ALARM) or clock(n['at_ms']) < since
                or n['summary'] != 'Successfully executed action ' + ev['topic_arn'] or type(n['data']) is not str):
            fail('VERIFY_ALERT_TEST')
    need = (STALE_ALARM, HEARTBEAT_ALARM) if ev['silence_s'] else (STALE_ALARM,)
    for alarm in need:
        if not any(x['alarm'] == alarm for x in ev['transitions']) or not any(
                x['alarm'] == alarm for x in ev['notifications']):
            fail('VERIFY_ALERT_TEST')
    if ev['silence_s'] and not ev['tested_run_primary']:
        fail('VERIFY_ALERT_TEST')
    digest = hashlib.sha256(encoded(ev)).hexdigest()
    if hexdigest(doc['sha256']) != digest:
        fail('VERIFY_ALERT_TEST')
    return digest


def alert_test_future(doc, reference_ms):
    ev = doc['evidence']
    stamps = [ev['emitted_ms']] + [x['at_ms'] for x in ev['transitions'] + ev['notifications']]
    return any(t > reference_ms + CLOCK_TOLERANCE_MS for t in stamps)


# The current record, collected after the proof is available and passed to
# `launch-verify.sh ready`: it names the proven receipt, carries the holder's
# readiness record read now and the alert-test evidence that record binds.
CURRENT_SCHEMA = 'polis-backfill-current-readiness/1'
CURRENT = ('schema', 'receipt_sha256', 'readiness', 'alert_test')


def validate_current(v):
    closed(v, CURRENT)
    if v['schema'] != CURRENT_SCHEMA:
        fail('VERIFY_CURRENT')
    hexdigest(v['receipt_sha256'])
    validate_readiness(v['readiness'])
    if validate_alert_test(v['alert_test']) != v['readiness']['monitoring']['alert_test_sha256']:
        fail('VERIFY_ALERT_TEST')
    return v


# The hand-off record: evidence of one READY decision, never a reusable authorization.
HANDOFF_SCHEMA = 'polis-backfill-handoff/2'
HANDOFF_RECORD = ('schema', 'decision', 'run_id', 'job_sha256', 'receipt_sha256', 'proof_sha256', 'cutoff_ms',
                  'history', 'current', 'current_seq', 'current_observed_ms', 'alert_test_sha256', 'now_ms')


def validate_handoff_record(v):
    closed(v, HANDOFF_RECORD)
    if v['schema'] != HANDOFF_SCHEMA or v['decision'] != 'READY':
        fail('VERIFY_HANDOFF')
    hexdigest(v['run_id'], width=32)
    for k in ('job_sha256', 'receipt_sha256', 'proof_sha256', 'history', 'current', 'alert_test_sha256'):
        hexdigest(v[k])
    for k in ('cutoff_ms', 'current_observed_ms', 'now_ms'):
        clock(v[k])
    integer(v['current_seq'])
    return v


# Every hand-off reason, in fixed order.
REASONS = (
    'receipt-not-complete',
    # The proof itself, now (consumption).
    'clock-reversal', 'future-history-clock', 'cutoff-expired',
    # No intervening change since the proof was available.
    'proof-missing', 'proof-invalid', 'proof-mismatch', 'future-proof-clock', 'job-changed', 'receipt-changed',
    'newer-receipt-exists', 'handoff-record-invalid', 'attempt-ledger-invalid', 'proof-consumed',
    'proof-invalidated', 'newer-handoff-exists', 'newer-attempt-exists', 'current-reused', 'current-not-newer',
    # The current record: collected after the proof, from the same holder, genuinely newer.
    'current-missing', 'current-invalid', 'current-for-other-receipt', 'current-before-proof',
    'current-holder-mismatch', 'current-sequence-not-advanced', 'current-not-refreshed',
    'current-discovery-not-advanced', 'current-sweep-regressed', 'current-drain-changed',
    'current-alert-test-changed', 'current-monitoring-before-proof', 'future-current-clock')
REASONS = REASONS + tuple('current-' + n for n in CONDITIONS)
_EXPIRY = ('cutoff-expired', 'current-expired')
_CLOCK = ('clock-reversal', 'future-history-clock', 'future-proof-clock', 'future-current-clock')
# The reasons after which this proof can never say READY: start again from prep.
NEW_PROOF_REASONS = ('cutoff-expired', 'attempt-ledger-invalid', 'proof-consumed', 'proof-invalidated',
                     'current-holder-mismatch', 'current-drain-changed')


def handoff_status(reasons):
    """The hand-off status for an ordered reason list (also the attempt ledger's check)."""
    if 'receipt-not-complete' in reasons:
        return 'NOT_COMPLETE'
    if any(n in _CLOCK for n in reasons):
        return 'UNKNOWN'
    if not reasons:
        return 'READY'
    return 'EXPIRED' if all(n in _EXPIRY for n in reasons) else 'REFUSED'


def handoff(r, current, now_ms, *, proof, receipt_sha256, job_sha256, receipts=None, previous=(), attempts=()):
    """The switch gate, immediately before the S2 secret/deploy step; the only READY.

    `r` is the decoded receipt; `receipt_sha256` and `job_sha256` are the saved
    receipt's and job's digests read now; `proof` the proof-available record;
    `receipts` the digests of every receipt the operator dir holds; `previous`
    the hand-off records already written there; `attempts` the attempt ledger
    there, as (file name, raw bytes) in name order. `current` is the current
    record (CURRENT_SCHEMA), collected after the proof was available.

    READY only when the proof is still fresh and unchanged, nothing newer
    exists, and the current record comes from the same admitted holder
    (identity, source, run, config) with an advanced sequence and a newer
    capture, the same DRAINED and a sweep no older than the bound one, discovery
    that advanced and is within the gap (at most 120 s) of now, pending or
    parked work aged to now, alarms OK and evaluated after the proof, and the
    bound alert test. A stopped or restarted holder (a new run) never passes.

    The ledger remembers every earlier attempt on this proof, refused ones
    included (review [1463] R1): a record that is not newer (sequence and
    capture) than any observation already presented is refused, so an older
    healthy record can never follow a newer adverse one; any observation of
    another holder, run or config or a changed drain, even in a refused
    attempt, invalidates the proof; one READY consumes it. A genuinely newer
    record from the same holder, run and config may recover from a transient
    refusal (an alarm, queued work). A malformed ledger refuses.
    """
    out = consumption(r, now_ms)
    base = dict(current=None, current_seq=None, current_observed_ms=None)
    if out['status'] == 'NOT_COMPLETE':
        return dict(out, **base)
    reasons = set(out['reasons'])
    spec, bound = r['run_spec'], r['run_spec']['readiness']
    available = None
    if proof is None:
        reasons.add('proof-missing')
    else:
        try:
            validate_proof(proof)
        except (ValueError, KeyError, TypeError):
            reasons.add('proof-invalid')
        else:
            available = proof['available_ms']
            if (proof['run_id'] != r['run_id'] or proof['cutoff_ms'] != spec['cutoff_ms']
                    or proof['snapshot_ms'] != r['snapshot']['snapshot_ms']):
                reasons.add('proof-mismatch')
            # The receipt phase accepted a snapshot leading its clock by the tolerance
            # (`consumption`); the same plausibility applies here (review [1463] C1).
            if available < r['snapshot']['snapshot_ms'] - CLOCK_TOLERANCE_MS:
                reasons.add('clock-reversal')
            if available > now_ms + CLOCK_TOLERANCE_MS:
                reasons.add('future-proof-clock')
            if proof['receipt_sha256'] != receipt_sha256:
                reasons.add('receipt-changed')
    if job_sha256 != r['job_sha256'] or (available is not None and proof['job_sha256'] != job_sha256):
        reasons.add('job-changed')
    if receipts is not None and list(receipts) != [receipt_sha256]:
        reasons.add('newer-receipt-exists')
    # The current record postdates both the proof and the snapshot it proves.
    after = None if available is None else max(available, r['snapshot']['snapshot_ms'])
    prior = []
    for p in previous:
        try:
            prior.append(validate_handoff_record(p))
        except (ValueError, KeyError, TypeError):
            reasons.add('handoff-record-invalid')
    for p in prior:
        if (p['run_id'] != r['run_id'] or p['receipt_sha256'] != receipt_sha256
                or p['job_sha256'] != job_sha256):
            reasons.add('proof-mismatch')
        if p['now_ms'] >= now_ms:
            reasons.add('newer-handoff-exists')
    try:
        ledger, _ = validate_ledger(attempts, r['run_id'], receipt_sha256, proof_digest(proof))
    except (ValueError, KeyError, TypeError):
        reasons.add('attempt-ledger-invalid')
        ledger = []
    ready = [a for a in ledger if a['outcome'] == 'READY']
    # Each hand-off record is one READY attempt; one READY consumes the proof.
    if any(not any(a['current'] == p['current'] and a['now_ms'] == p['now_ms'] for a in ready) for p in prior):
        reasons.add('attempt-ledger-invalid')
    if ready or prior:
        reasons.add('proof-consumed')
    if any(a['now_ms'] >= now_ms for a in ledger):
        reasons.add('newer-attempt-exists')
    observed = [a for a in ledger if a['current'] is not None]
    # Another holder, run or config, or a changed drain, seen in any attempt: this proof is spent.
    if any(a['holder'] != bound['holder'] or a['drain'] != bound['drain'] for a in observed):
        reasons.add('proof-invalidated')
    if current is None:
        reasons.add('current-missing')
    else:
        try:
            validate_current(current)
        except (ValueError, KeyError, TypeError):
            reasons.add('current-invalid')
        else:
            v = current['readiness']
            base = dict(current=readiness_digest(current), current_seq=v['seq'], current_observed_ms=v['observed_ms'])
            if current['receipt_sha256'] != receipt_sha256:
                reasons.add('current-for-other-receipt')
            if after is not None and v['observed_ms'] <= after:
                reasons.add('current-before-proof')
            if after is not None and v['monitoring']['evaluated_ms'] < after:
                reasons.add('current-monitoring-before-proof')
            # The same admitted holder; a restart is a new run and needs a new proof.
            if v['holder'] != bound['holder']:
                reasons.add('current-holder-mismatch')
            if v['seq'] <= bound['seq']:
                reasons.add('current-sequence-not-advanced')
            if v['observed_ms'] <= bound['observed_ms']:
                reasons.add('current-not-refreshed')
            d, bd = v['discovery'], bound['discovery']
            if d['successes'] <= bd['successes'] or d['last_success_ms'] <= bd['last_success_ms']:
                reasons.add('current-discovery-not-advanced')
            # The latest applicable sweep is never older than the one the history bound.
            if (v['sweep']['sweep_no'], v['sweep']['finished_ms']) < (bound['sweep']['sweep_no'],
                                                                      bound['sweep']['finished_ms']):
                reasons.add('current-sweep-regressed')
            # Still the same DRAINED.
            if v['drain'] != bound['drain']:
                reasons.add('current-drain-changed')
            if v['monitoring']['alert_test_sha256'] != bound['monitoring']['alert_test_sha256']:
                reasons.add('current-alert-test-changed')
            if readiness_future(v, now_ms) or alert_test_future(current['alert_test'], now_ms):
                reasons.add('future-current-clock')
            reasons.update('current-' + n for n in readiness_failures(v, spec, now_ms))
            for p in prior:
                if (p['current'] == base['current'] or v['seq'] <= p['current_seq']
                        or v['observed_ms'] <= p['current_observed_ms']):
                    reasons.add('current-reused')
            # Never behind anything this proof's gate has already seen, READY or refused.
            for a in observed:
                if a['current'] == base['current']:
                    reasons.add('current-reused')
                elif v['seq'] <= a['current_seq'] or v['observed_ms'] <= a['current_observed_ms']:
                    reasons.add('current-not-newer')
    reasons = [n for n in REASONS if n in reasons]
    return dict(out, status=handoff_status(reasons), reasons=reasons, **base)


def handoff_record(r, h, proof, receipt_sha256, current):
    """The create-only record of one READY decision `h` (from `handoff`)."""
    if h['status'] != 'READY':
        fail('VERIFY_NOT_READY')
    return validate_handoff_record({
        'schema': HANDOFF_SCHEMA, 'decision': 'READY', 'run_id': r['run_id'], 'job_sha256': r['job_sha256'],
        'receipt_sha256': receipt_sha256, 'proof_sha256': hashlib.sha256(encoded(proof)).hexdigest(),
        'cutoff_ms': r['run_spec']['cutoff_ms'], 'history': r['bindings']['readiness'],
        'current': h['current'], 'current_seq': h['current_seq'], 'current_observed_ms': h['current_observed_ms'],
        'alert_test_sha256': current['readiness']['monitoring']['alert_test_sha256'], 'now_ms': h['now_ms']})


# ---------------------------------------------------------------------------
# The attempt ledger (review [1463] R1): one create-only, private file per
# hand-off attempt on a proof, refusals included, chained by the previous
# file's digest and kept apart from the READY records. `handoff` judges each
# new attempt against every earlier one; the operator appends the attempt
# (`attempt_record`) before any READY record, so an interrupted hand-off
# leaves the proof consumed, never reusable. This module writes no file.
# ---------------------------------------------------------------------------
ATTEMPT_SCHEMA = 'polis-backfill-handoff-attempt/1'
ATTEMPT = ('schema', 'attempt', 'previous_sha256', 'run_id', 'receipt_sha256', 'proof_sha256', 'now_ms', 'outcome',
           'reasons', 'current', 'current_seq', 'current_observed_ms', 'holder', 'drain')
ATTEMPT_GLOB = 'verify-attempt-*.json'
MAX_ATTEMPTS = 999_999


def attempt_name(n):
    """The ledger file name of attempt `n` (1-based); name order is attempt order."""
    return 'verify-attempt-%06d.json' % integer(n, 1, MAX_ATTEMPTS, 'VERIFY_ATTEMPT')


def proof_digest(proof):
    """The digest a hand-off binds for a proof record, or None when it is missing or invalid."""
    try:
        return hashlib.sha256(encoded(validate_proof(proof))).hexdigest()
    except (ValueError, KeyError, TypeError):
        return None


def validate_attempt(v):
    closed(v, ATTEMPT)
    if v['schema'] != ATTEMPT_SCHEMA:
        fail('VERIFY_ATTEMPT')
    integer(v['attempt'], 1, MAX_ATTEMPTS, 'VERIFY_ATTEMPT')
    if (v['previous_sha256'] is None) != (v['attempt'] == 1):
        fail('VERIFY_ATTEMPT')
    for k in ('previous_sha256', 'proof_sha256'):
        if v[k] is not None:
            hexdigest(v[k])
    hexdigest(v['run_id'], width=32)
    hexdigest(v['receipt_sha256'])
    clock(v['now_ms'])
    reasons = v['reasons']
    if (type(reasons) is not list or any(type(n) is not str for n in reasons)
            or reasons != [n for n in REASONS if n in reasons] or v['outcome'] != handoff_status(reasons)):
        fail('VERIFY_ATTEMPT')
    seen = ('current', 'current_seq', 'current_observed_ms', 'holder', 'drain')
    if v['current'] is None:
        if any(v[k] is not None for k in seen) or v['outcome'] == 'READY':
            fail('VERIFY_ATTEMPT')
    else:
        hexdigest(v['current'])
        integer(v['current_seq'])
        clock(v['current_observed_ms'])
        validate_holder(v['holder'])
        validate_drain(v['drain'])
    return v


def validate_ledger(entries, run_id, receipt_sha256, proof_sha256):
    """The ordered attempts and the last entry's digest, or ValueError.

    `entries` are (file name, raw bytes) in name order: contiguous from 1, each
    naming its predecessor's digest, all for this run and receipt, and none for
    another proof (an attempt made while the proof was missing names none; a
    missing proof now is refused as proof-missing, not here).
    """
    attempts, head = [], None
    for n, (name, raw) in enumerate(entries, 1):
        if name != attempt_name(n) or type(raw) is not bytes:
            fail('VERIFY_ATTEMPT')
        a = validate_attempt(decode(raw))
        if (a['attempt'] != n or a['previous_sha256'] != head or a['run_id'] != run_id
                or a['receipt_sha256'] != receipt_sha256
                or None not in (a['proof_sha256'], proof_sha256) and a['proof_sha256'] != proof_sha256):
            fail('VERIFY_ATTEMPT')
        attempts.append(a)
        head = hashlib.sha256(raw).hexdigest()
    return attempts, head


def attempt_record(r, h, *, proof, receipt_sha256, current, attempts):
    """The next ledger entry for hand-off result `h`, whatever its status.

    ValueError when the ledger is invalid: it is never extended then, and
    `handoff` has already refused (attempt-ledger-invalid).
    """
    digest = proof_digest(proof)
    ledger, head = validate_ledger(attempts, r['run_id'], receipt_sha256, digest)
    seen = h['current'] is not None
    v = current['readiness'] if seen else None
    return validate_attempt({
        'schema': ATTEMPT_SCHEMA, 'attempt': len(ledger) + 1, 'previous_sha256': head, 'run_id': r['run_id'],
        'receipt_sha256': receipt_sha256, 'proof_sha256': digest, 'now_ms': h['now_ms'], 'outcome': h['status'],
        'reasons': list(h['reasons']), 'current': h['current'], 'current_seq': h['current_seq'],
        'current_observed_ms': h['current_observed_ms'], 'holder': dict(v['holder']) if seen else None,
        'drain': dict(v['drain']) if seen else None})
