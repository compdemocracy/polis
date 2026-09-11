"""Closed D06 local receipt; operational delivery can never be inferred here."""
import json
import math
from pathlib import Path
import sys

CATCHES = {'observer': ['ADMITTED_UNPUBLISHED', 'POLL_MISSING', 'POLL_STALE', 'OBSERVER_QUERY',
                       'TICK_ONLY_INVALIDATION', 'MAIN_AHEAD', 'MISSING_TICKS', 'BUNDLE_POINTER_MISMATCH']}
LIMITS = {'observer': ['MISSED_SOURCE_INPUT', 'PAYLOAD_CONTENT', 'ALARM_DESTINATION_DELIVERY']}
POINTER = {'CurrentBehind', 'CurrentAhead', 'CurrentMissingTicks', 'CurrentBundleMismatch', 'CurrentPointerHealthy'}
BASE = {'schema', 'Environment', 'MathEnv', 'ObserverHealthy', 'code'}
HEALTHY = BASE | POINTER | {'PollHealthy', 'PublishLagSeconds', 'AdmittedLagSeconds', 'CurrentLagSeconds',
                           'PendingOperations', 'WithdrawnPendingOperations', 'Transitions', 'UnresolvedOperations'}


def verify(r):
    fields = {'schema', 'runtime_scope', 'crosscheck_scope', 'alarm_delivery', 'catches', 'cannot_catch',
              'pending', 'published_unreconciled', 'transition', 'tick_fault', 'main_ahead'}
    if type(r) is not dict or set(r) != fields: raise ValueError('D06_RECEIPT_SCHEMA')
    if (r['schema'] != 'polis-d06-receipt/2' or r['runtime_scope'] != 'metadata_and_current_tables'
        or r['crosscheck_scope'] != 'continuous_observer_login'
        or r['alarm_delivery'] != 'OPERATOR_NOT_EVALUATED'): raise ValueError('D06_SCOPE')
    if r['catches'] != CATCHES: raise ValueError('D06_COVERAGE')
    if r['cannot_catch'] != LIMITS: raise ValueError('D06_LIMITS')
    for name in ('pending', 'published_unreconciled', 'transition', 'tick_fault', 'main_ahead'):
        sample = r[name]
        keys = BASE | POINTER if name == 'main_ahead' else HEALTHY
        if type(sample) is not dict or set(sample) != keys: raise ValueError('D06_SAMPLE_SCHEMA')
        if (sample['schema'] != 'polis-observer/1' or sample['Environment'] != 'public-fixture'
            or sample['MathEnv'] != 'rustproto'): raise ValueError('D06_SAMPLE_SCOPE')
        for key in keys - {'schema', 'Environment', 'MathEnv', 'code'}:
            if type(sample[key]) not in (int, float) or not math.isfinite(sample[key]) or sample[key] < 0:
                raise ValueError('D06_VALUE')
            if not key.endswith('LagSeconds') and type(sample[key]) is not int: raise ValueError('D06_COUNT')
        if sample['ObserverHealthy'] != int(name != 'main_ahead'): raise ValueError('D06_HEALTH')
        if name == 'main_ahead':
            if sample['code'] != 'OBSERVER_CURRENT' or sample['CurrentAhead'] != 1 or sample['CurrentPointerHealthy'] != 0:
                raise ValueError('D06_CURRENT_REFUSAL')
        else:
            if (sample['code'] not in ('OK', 'POLL_MISSING', 'POLL_STALE', 'POLL_FAILED')
                or sample['PollHealthy'] != int(sample['code'] == 'OK')): raise ValueError('D06_CODE')
            if sample['PublishLagSeconds'] != max(sample['AdmittedLagSeconds'], sample['CurrentLagSeconds']):
                raise ValueError('D06_LAG')
            if any(sample[k] for k in ('CurrentAhead', 'CurrentMissingTicks', 'CurrentBundleMismatch')):
                raise ValueError('D06_POINTER')
            if sample['CurrentPointerHealthy'] != int(sample['CurrentBehind'] == 0): raise ValueError('D06_POINTER')
    if r['pending']['PendingOperations'] != 1 or r['pending']['AdmittedLagSeconds'] < 901:
        raise ValueError('D06_PENDING')
    if r['published_unreconciled']['PendingOperations'] != 0 or r['published_unreconciled']['PublishLagSeconds'] != 0:
        raise ValueError('D06_PUBLICATION')
    tick = r['tick_fault']
    if tick['PendingOperations'] != 0 or tick['CurrentBehind'] != 1 or tick['CurrentLagSeconds'] < 900:
        raise ValueError('D06_CURRENT_LAG')
    if r['transition']['Transitions'] != 1: raise ValueError('D06_TRANSITION')
    return {'local_observer': 'PASS', 'runtime_scope': 'metadata_and_current_tables',
            'alarm_delivery': 'OPERATOR_NOT_EVALUATED'}


if __name__ == '__main__':
    print(json.dumps(verify(json.loads(Path(sys.argv[1]).read_bytes())), sort_keys=True))
