"""The `polis-backfill-readiness/2`, proof and current-readiness validators,
vendored from the verification job (P-071, design (b)).

Source: ``ci/probe_box/backfill_verify.py`` at commit 3bac04c11 (branch
``probe-backfill-verify``), sha256 of that file:
d4cbbb7926ece3215eda6b52b1ef9ea167b4a0d7a0d7f8d020243c1443bcdc52.

The collector (``collect_readiness.py``) prefers the real module when the
repository has it (``ci/probe_box/backfill_verify.py`` importable) and falls
back to this copy otherwise. Each block between ``# vendored-block`` markers is
a byte-for-byte copy of the upstream source; ``BLOCK_SHA256`` pins them, the
module refuses to import if any block was edited, and the test suite checks
every block still appears verbatim in the upstream file whenever that file (or
its git object) is available. Do not edit the blocks: re-vendor instead.

Vendored: the clock/count/digest helpers, the readiness record (/2) with its
conditions and ``readiness_future``, the proof record (``polis-backfill-proof/1``),
the alert-test document (``math_poller.alert_test_evidence/3``, with its bound
provenance) and the current record (``polis-backfill-current-readiness/1``). Not
vendored: the receipt, the hand-off and everything that reads the snapshot.
"""

from __future__ import annotations

import hashlib
import json
import re

UPSTREAM = '3bac04c11:ci/probe_box/backfill_verify.py'
UPSTREAM_SHA256 = 'd4cbbb7926ece3215eda6b52b1ef9ea167b4a0d7a0d7f8d020243c1443bcdc52'
BLOCK_SHA256 = (
    '669bac6bc9e6f37ce5999bc53b9c66ab956393b4489df6979b5ff425876f91d3',
    '73c350740077b8ec218f1f7bff7e122ce5b158c0df786861c570ee573234b84b',
    '63dc3ba94df3734fa3270e113691695c524aa84887b775a0bf352c223f000d25',
    '5c29ce1b43124073ae12a6fce422c74be7130d87fabfa8d0ac03e4f476b3d22a',
    'b3ec8c2b740a22c8826aebca0452569a3bd7f8097b2198014e71e258f078ef9a',
    '5c84dd2893b76951ece8e9810a889a120917a80b9db5f844cc6a0a48fcaef405',
    'f37872eb0520b198c59086d226b68126b36cc75214a2587e53dafc1b03ad8c96',
)

# vendored-block 0 begin
MS_FLOOR, MS_CEILING = 1_500_000_000_000, 4_000_000_000_000
CUTOFF_AGE = (300, 86400)
READINESS_AGE = (60, 3600)
# Never above 120 s: the gap is also the current gate's bound at the hand-off,
# so a wider gap (option (a) of review [1459]) is refused, not configurable.
DISCOVERY_GAP = (10, 120)
# Allowed disagreement between the database, holder and operator clocks.
CLOCK_TOLERANCE_MS = 5_000
# vendored-block 0 end

# vendored-block 1 begin
# A readiness record's conditions, in fixed order. The history (bound at
# launch, judged at its own observation) never has an age of its own beyond
# the cutoff's; `expired` applies only against a decision time (launch, hand-off).
CONDITIONS = ('holder-not-primary', 'run-mismatch', 'sweep-unresolved', 'not-drained', 'before-cutoff',
              'discovery-stale', 'queue-stuck', 'monitoring-not-ok', 'expired')
HISTORY_BLOCKING = ('history-missing',) + tuple('history-' + n for n in CONDITIONS if n != 'expired')
# vendored-block 1 end

# vendored-block 2 begin
def encoded(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def fail(code='VERIFY_SCHEMA'):
    raise ValueError(code)
# vendored-block 2 end

# vendored-block 3 begin
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
# vendored-block 3 end

# vendored-block 4 begin
PROOF_SCHEMA = 'polis-backfill-proof/1'
PROOF = ('schema', 'run_id', 'job_sha256', 'receipt_sha256', 'verdict', 'readiness', 'cutoff_ms', 'snapshot_ms',
         'available_ms')
# vendored-block 4 end

# vendored-block 5 begin
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
# vendored-block 5 end

# vendored-block 6 begin
# The alert-test evidence as P-072's collector writes it (schema /3), checked
# structurally here; the collector checks it against CloudWatch, and on every
# reuse against the private trace, collection manifest and received files the
# document binds. Only its digest enters the readiness record
# (monitoring.alert_test_sha256), and that digest covers the whole bound
# document: two different drill traces never share one (review [1469] R1).
#
# /3 binds the drill's provenance: `trace` (the evaluated interval, the log's
# line count, the test line's log index, the digests of the private verbatim
# trace and of its collection manifest (log index, kind and sha256 per line),
# the clock-order violations seen, and every malformed protocol line in the
# log with its established time bracket, each outside the interval) and
# `receipt` (each received file's sha256, and per fired alarm the selected
# notification's file, offset, sha256, form and own state-change time). /2
# documents (collected before these checks existed) are refused: recollect
# them with the collector's alert-test.
ALERT_TEST_SCHEMA = 'math_poller.alert_test_evidence/3'
ALERT_TEST = ('schema', 'nonce', 'tested_run', 'tested_run_primary', 'holder_runs', 'emitted_ms', 'silence_s',
              'test_line_sha256', 'transitions', 'notifications', 'topic_arn', 'alarm_config_sha256',
              'receipt_sha256', 'trace', 'receipt')
ALERT_TRACE = ('interval_ms', 'lines_total', 'test_line_index', 'lines', 'sha256', 'manifest_sha256',
               'order_violations', 'malformed_total', 'malformed_excluded')
ALERT_MALFORMED = ('index', 'sha256', 'earliest_ms', 'latest_ms')
ALERT_RECEIPT = ('files', 'selected')
ALERT_SELECTED = ('alarm', 'file', 'offset', 'sha256', 'form', 'at_ms', 'seconds')
ALERT_FORMS = ('mail', 'mbox', 'json', 'json-array', 'json-lines')
STALE_ALARM, HEARTBEAT_ALARM = 'Polis-MathPoller-DiscoveryStale', 'Polis-MathPoller-HeartbeatMissing'
ALERT_STATES = ('OK', 'ALARM', 'INSUFFICIENT_DATA')
TOPIC_ARN = r'arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}'
MAX_ALERT_ITEMS = 64
MAX_LOG_LINES = 10_000_000
# A received notification's own state-change time names its transition to
# within this (an e-mail's whole-second time may also lag by its truncation).
ALERT_STATE_MATCH_MS = 1_000


def validate_alert_trace(ev):
    """The /3 `trace` section: the interval covers the test line, the silence
    and every selected transition; every malformed protocol line in the log is
    listed with a bracket that is not inverted and lies outside the interval;
    none is excluded when the log's clocks contradict its order."""
    tr = closed(ev['trace'], ALERT_TRACE)
    iv = tr['interval_ms']
    if type(iv) is not list or len(iv) != 2:
        fail('VERIFY_ALERT_TEST')
    lo, hi = clock(iv[0]), clock(iv[1])
    since = ev['emitted_ms']
    if not lo <= since <= hi or hi < since + 1000 * ev['silence_s'] or any(
            t['at_ms'] > hi for t in ev['transitions']):
        fail('VERIFY_ALERT_TEST')
    total = integer(tr['lines_total'], 1, MAX_LOG_LINES)
    integer(tr['test_line_index'], 0, total - 1)
    integer(tr['lines'], 1, total)
    hexdigest(tr['sha256'])
    hexdigest(tr['manifest_sha256'])
    integer(tr['order_violations'], 0, total)
    bad = integer(tr['malformed_total'], 0, MAX_ALERT_ITEMS)
    excluded = tr['malformed_excluded']
    if type(excluded) is not list or len(excluded) != bad or bad + tr['lines'] > total:
        fail('VERIFY_ALERT_TEST')
    # A bracket is only established under a consistent clock order.
    if bad and tr['order_violations']:
        fail('VERIFY_ALERT_TEST')
    last = -1
    for m in excluded:
        closed(m, ALERT_MALFORMED)
        if integer(m['index'], 0, total - 1) <= last or m['index'] == tr['test_line_index']:
            fail('VERIFY_ALERT_TEST')
        last = m['index']
        hexdigest(m['sha256'])
        a, b = m['earliest_ms'], m['latest_ms']
        a = None if a is None else clock(a)
        b = None if b is None else clock(b)
        if a is not None and b is not None and a > b:
            fail('VERIFY_ALERT_TEST')
        if not ((b is not None and b < lo) or (a is not None and a > hi)):
            fail('VERIFY_ALERT_TEST')
    return tr


def validate_alert_receipt(ev, need):
    """The /3 `receipt` section: the received files' digests (their aggregate
    is `receipt_sha256`) and one selected notification per fired alarm, each
    naming its own file, offset and sha256 and stating its transition's time."""
    rc = closed(ev['receipt'], ALERT_RECEIPT)
    files, selected = rc['files'], rc['selected']
    if type(files) is not list or not files or len(files) > MAX_ALERT_ITEMS:
        fail('VERIFY_ALERT_TEST')
    for f in files:
        hexdigest(f)
    aggregate = files[0] if len(files) == 1 else hashlib.sha256(encoded(files)).hexdigest()
    if ev['receipt_sha256'] != aggregate:
        fail('VERIFY_ALERT_TEST')
    if type(selected) is not list or sorted(s.get('alarm') if type(s) is dict else None
                                            for s in selected) != sorted(need):
        fail('VERIFY_ALERT_TEST')
    for s in selected:
        closed(s, ALERT_SELECTED)
        integer(s['file'], 0, len(files) - 1)
        integer(s['offset'])
        hexdigest(s['sha256'])
        if s['form'] not in ALERT_FORMS or type(s['seconds']) is not bool:
            fail('VERIFY_ALERT_TEST')
        t = next(x for x in ev['transitions'] if x['alarm'] == s['alarm'])
        lag = t['at_ms'] - clock(s['at_ms'])
        if not -ALERT_STATE_MATCH_MS <= lag <= ALERT_STATE_MATCH_MS + (999 if s['seconds'] else 0):
            fail('VERIFY_ALERT_TEST')
    return rc


def validate_alert_test(doc):
    """The closed alert-test document {evidence, sha256}; returns its sha256.

    Requires exactly one DiscoveryStale ALARM transition and one successful
    SNS action on the evidence's own topic at or after the test line; a
    heartbeat drill (silence_s > 0) also needs the HeartbeatMissing
    transition and action, and the tested run among the holder runs. The
    bound provenance (`trace`, `receipt`) must be present and consistent
    (validate_alert_trace, validate_alert_receipt); the digest covers all of it.
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
    # Exactly one transition and one action per fired alarm.
    for x in items:
        if sorted(y['alarm'] for y in x) != sorted(need):
            fail('VERIFY_ALERT_TEST')
    if ev['silence_s'] and not ev['tested_run_primary']:
        fail('VERIFY_ALERT_TEST')
    validate_alert_trace(ev)
    validate_alert_receipt(ev, need)
    digest = hashlib.sha256(encoded(ev)).hexdigest()
    if hexdigest(doc['sha256']) != digest:
        fail('VERIFY_ALERT_TEST')
    return digest


def alert_test_future(doc, reference_ms):
    ev = doc['evidence']
    stamps = ([ev['emitted_ms'], ev['trace']['interval_ms'][1]]
              + [x['at_ms'] for x in ev['transitions'] + ev['notifications'] + ev['receipt']['selected']])
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

# vendored-block 6 end


def _vendored_blocks(text):
    out = []
    for i in range(len(BLOCK_SHA256)):
        start = text.index('# vendored-block %d begin\n' % i) + len('# vendored-block %d begin\n' % i)
        out.append(text[start:text.index('# vendored-block %d end\n' % i)])
    return out


def _self_check():
    with open(__file__, encoding='utf-8') as fh:
        blocks = _vendored_blocks(fh.read())
    got = tuple(hashlib.sha256(b.encode()).hexdigest() for b in blocks)
    if got != BLOCK_SHA256:
        raise ImportError('vendored readiness validator was edited; re-vendor from ' + UPSTREAM)


_self_check()
