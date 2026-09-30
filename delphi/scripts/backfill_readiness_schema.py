"""The `polis-backfill-readiness/1` validator, vendored from the verification job.

Source: ``ci/probe_box/backfill_verify.py`` at commit a5db44bca (branch
``probe-backfill-verify``), sha256 of that file:
d15b83ac262f613f47010a1d1ebc7bf6c765e4a899926adccdd69ab0a3a52bb9.

The collector (``collect_readiness.py``) prefers the real module when the
repository has it (``ci/probe_box/backfill_verify.py`` importable) and falls
back to this copy otherwise. Each block between ``# vendored-block`` markers is
a byte-for-byte copy of the upstream source; ``BLOCK_SHA256`` pins them, the
module refuses to import if any block was edited, and the test suite checks
every block still appears verbatim in the upstream file whenever that file (or
its git object) is available. Do not edit the blocks: re-vendor instead.
"""

from __future__ import annotations

import hashlib
import json
import re

UPSTREAM = 'a5db44bca:ci/probe_box/backfill_verify.py'
UPSTREAM_SHA256 = 'd15b83ac262f613f47010a1d1ebc7bf6c765e4a899926adccdd69ab0a3a52bb9'
BLOCK_SHA256 = (
    'fe1d8d66d1e92247ce5533f82c39b0df96b105606b6dd95d54899feaf7959900',
    '75ebee6fa1961e8c070d37db810127f3a647271b1449e885ce1c9c863037e20e',
    '63dc3ba94df3734fa3270e113691695c524aa84887b775a0bf352c223f000d25',
    '31fa64a596f725a9e82e26fffbc195c774f8e606473ff8325accb7c52d465e82',
)

# vendored-block 0 begin
MS_FLOOR, MS_CEILING = 1_500_000_000_000, 4_000_000_000_000
CUTOFF_AGE = (300, 86400)
READINESS_AGE = (60, 3600)
DISCOVERY_GAP = (10, 900)
# Allowed disagreement between the database, holder and operator clocks.
CLOCK_TOLERANCE_MS = 5_000
# vendored-block 0 end

# vendored-block 1 begin
READINESS_BLOCKING = ('readiness-missing', 'readiness-holder-not-primary', 'readiness-run-mismatch',
                      'readiness-sweep-unresolved', 'readiness-not-drained', 'readiness-before-cutoff',
                      'readiness-discovery-stale', 'readiness-queue-stuck', 'readiness-monitoring-not-ok',
                      'readiness-expired')
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
    """A readiness clock beyond the reference (snapshot or now), or beyond its own observation."""
    if v is None:
        return False
    observed = v['observed_ms']
    inner = (v['discovery']['last_success_ms'], v['sweep']['finished_ms'], v['drain']['drained_ms'],
             v['monitoring']['evaluated_ms'])
    return (observed > reference_ms + CLOCK_TOLERANCE_MS
            or any(t is not None and t > observed + CLOCK_TOLERANCE_MS for t in inner))


def readiness_failures(v, spec, reference_ms):
    """Failed READINESS_BLOCKING names for record `v` judged at `reference_ms` (the snapshot, or now)."""
    if v is None:
        return ['readiness-missing']
    failed = set()
    h, d, qu, s, dr, m = (v[k] for k in ('holder', 'discovery', 'queue', 'sweep', 'drain', 'monitoring'))
    observed, cutoff = v['observed_ms'], spec['cutoff_ms']
    gap = 1000 * spec['max_discovery_gap_seconds']
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
    # count; publications do not), with no failure since the last success.
    if (d['successes'] == 0 or d['failures_since_success'] or d['last_success_ms'] < cutoff
            or observed - d['last_success_ms'] > gap):
        failed.add('readiness-discovery-stale')
    if qu['oldest_work_age_ms'] > gap:
        failed.add('readiness-queue-stuck')
    if (m['alarm'] != 'OK' or m['alert_test_sha256'] is None
            or observed - m['evaluated_ms'] > 1000 * spec['max_readiness_age_seconds']):
        failed.add('readiness-monitoring-not-ok')
    if reference_ms - observed > 1000 * spec['max_readiness_age_seconds']:
        failed.add('readiness-expired')
    return [n for n in READINESS_BLOCKING if n in failed]
# vendored-block 3 end


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
