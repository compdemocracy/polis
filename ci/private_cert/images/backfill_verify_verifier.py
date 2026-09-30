"""Recompute the switch condition from the reader's counts; only this image writes the receipt.

The verifier does not import producer code. It re-derives the evidence from
the original projection, requires the producer's evidence to equal it
exactly, runs the live checks and fixed self-tests, and reduces everything
to the backfill-verify receipt: counts, clocks, condition names and digests,
with no zid, payload or text.
"""
from __future__ import annotations
import copy
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'probe_box'))
from backfill_verify import (ACCEPTANCE, BLOCKING, CONTROLS, COVERAGE, KIND, LIMIT, LIVE_CONTROLS, POLICY_SHA,
                             PROJECTION_SCHEMA, assess, decode, encoded, expected_verdict, fail,
                             validate_projection, validate_receipt, validate_run_spec)
from backfill_verify_queries import SQL_SHA256, TABLES, shipped_statements
from receipt import sha


def receipt(projection, produced, job, source_commit):
    spec = validate_run_spec(job['run_spec'])
    validate_projection(projection, spec)
    if projection['source_commit'] != source_commit:
        fail('VERIFY_RECONSTRUCTION')
    expected = assess(projection, spec)
    if produced != expected:
        fail('VERIFY_RECONSTRUCTION')
    complete = projection['status'] == 'COMPLETE'
    r = {'schema': 'polis-probe-receipt/3', 'kind': KIND, 'run_id': job['run_id'], 'job_sha256': sha(job),
         'verdict': 'INCOMPLETE', 'acceptance': ACCEPTANCE,
         'bindings': dict(source_commit=source_commit, query_policy=POLICY_SHA,
                          verification_sql=spec['verification_sql_sha256'],
                          server_version_num=projection['server_version_num'],
                          **{k: job[k]['image'].split('@sha256:')[1] for k in ('reader', 'producer', 'verifier')}),
         'run_spec': dict(spec), 'coverage': dict(COVERAGE, status=projection['status']),
         'snapshot': expected['snapshot'], 'counts': copy.deepcopy(projection['results']) if complete else None,
         'blocking': expected['blocking'],
         'controls': dict(dict.fromkeys(CONTROLS, False), **live_controls(projection, spec))}
    r['verdict'] = expected_verdict(r)
    return r


def live_controls(projection, spec):
    complete = projection['status'] == 'COMPLETE'
    return {'reader-no-write': complete and projection['no_write'],
            'sql-digest-bound': (projection['verification_sql'] == spec['verification_sql_sha256'] == SQL_SHA256)}


SNAPSHOT_MS = 1_900_000_000_000


def fixture_results(n=10):
    """A clean backfill: every source conversation has a complete target."""
    return {'rows': {t: {'source': n, 'target': n} for t in TABLES},
            'conversations': dict(source_conversations=n, missing_main=0, missing_bidtopid=0, missing_ptptstats=0,
                                  missing_ticks=0, unequal_generation=0, uninitialized_generation=0,
                                  invalid_payload=0, behind_source_stale=0, live_lag=0, source_ahead=0, complete=n),
            'orphans': dict(target_only_main=0, orphan_bidtopid=0, orphan_ptptstats=0, orphan_ticks=0),
            'payloads': dict(checked=n, main_not_object=0, main_missing_keys=0, main_zid_unbound=0,
                             main_timestamp_unbound=0, bidtopid_malformed=0, ptptstats_malformed=0,
                             companion_timestamp_unbound=0, empty_shape=min(n, 1), invalid_payload=0),
            'cutoff': dict(behind_input_at_cutoff=0, source_ahead_of_input=0, live_tail_after_cutoff=0),
            'without_target': dict.fromkeys(TABLES, 0),
            'ticks': ({'source_max_ms': SNAPSHOT_MS - 5000, 'target_max_ms': SNAPSHOT_MS - 4000} if n else
                      {'source_max_ms': None, 'target_max_ms': None})}


def fixture_projection(results, status='COMPLETE'):
    complete = status == 'COMPLETE'
    return {'schema': PROJECTION_SCHEMA, 'source_commit': '1' * 40, 'query_policy': POLICY_SHA,
            'verification_sql': SQL_SHA256, 'server_version_num': 170004, 'status': status,
            'snapshot_ms': SNAPSHOT_MS if complete else None, 'results': results if complete else None,
            'no_write': complete}


def refused(check):
    try:
        check()
    except (ValueError, KeyError, TypeError):
        return True
    return False


def controls(job):
    """Fixed self-tests; every refusal path must refuse and every vector must decide as named."""
    from contracts import validate_job
    job = dict(job, run_spec=dict(job['run_spec'], cutoff_ms=SNAPSHOT_MS - 600_000))

    def build(results, status='COMPLETE', spec=None):
        j = job if spec is None else dict(job, run_spec=dict(job['run_spec'], **spec))
        p = fixture_projection(results, status)
        r = receipt(p, assess(p, j['run_spec']), j, '1' * 40)
        r['controls'] = dict.fromkeys(CONTROLS, True)
        r['verdict'] = expected_verdict(r)
        return validate_receipt(r, j), j

    good, _ = build(fixture_results())
    if good['verdict'] != 'BACKFILL-COMPLETE' or good['blocking']:
        fail('VERIFY_CONTROL_FIXTURE')

    def mutated(mutate):
        bad = copy.deepcopy(good)
        mutate(bad)
        return lambda: validate_receipt(bad, job)

    def vector(changes, want, **spec):
        """Apply {group: {name: value}} to a clean fixture; the receipt must block exactly `want`."""
        results = fixture_results()
        for group, values in changes.items():
            for name, value in values.items():
                if group == 'rows':
                    results['rows'][name].update(value)
                else:
                    results[group][name] = value
        r, j = build(results, spec=spec)
        verdict = 'BACKFILL-INCOMPLETE' if want else 'BACKFILL-COMPLETE'
        if r['blocking'] != [n for n in BLOCKING if n in want] or r['verdict'] != verdict:
            return False
        # A blocked receipt claiming completion, or hiding its conditions, is refused.
        return (not want or (refused(lambda: validate_receipt(dict(r, verdict='BACKFILL-COMPLETE'), j))
                             and refused(lambda: validate_receipt(dict(r, blocking=[]), j))))

    def incomplete(results=None, status='COMPLETE', **spec):
        r, j = build(fixture_results() if results is None else results, status, spec or None)
        return (r['verdict'] == 'INCOMPLETE'
                and refused(lambda: validate_receipt(dict(r, verdict='BACKFILL-COMPLETE'), j))
                and refused(lambda: validate_receipt(dict(r, verdict='BACKFILL-INCOMPLETE'), j)))

    p = fixture_projection(fixture_results())
    evidence = assess(p, job['run_spec'])

    def forged_evidence():
        tampered = dict(evidence, blocking=['missing_main'])
        receipt(p, tampered, job, '1' * 40)

    def inconsistent(group, name, value):
        q = copy.deepcopy(p)
        q['results'][group][name] = value
        return lambda: receipt(q, assess(q, job['run_spec']), job, '1' * 40)

    outcomes = {
        'empty-result-incomplete': incomplete(fixture_results(0)),
        'not-visible-incomplete': incomplete(status='NOT_VISIBLE')
            and refused(lambda: validate_projection(dict(fixture_projection(None, 'NOT_VISIBLE'),
                                                         results=fixture_results()), job['run_spec'])),
        'forged-evidence-refused': refused(forged_evidence),
        'forged-projection-refused': refused(inconsistent('conversations', 'missing_main', 1))
            and refused(lambda: receipt(dict(p, query_policy='0' * 64), evidence, job, '1' * 40))
            and refused(lambda: receipt(p, evidence, job, '2' * 40)),
        'wrong-sql-refused': refused(lambda: validate_job(dict(job, run_spec=dict(
                job['run_spec'], verification_sql_sha256='0' * 64))))
            and refused(lambda: receipt(dict(p, verification_sql='0' * 64), evidence, job, '1' * 40))
            and refused(lambda: shipped_statements(b'SELECT 1;'))
            and refused(mutated(lambda v: v['bindings'].update(verification_sql='0' * 64))),
        'wrong-ruling-refused': refused(lambda: validate_job(dict(job, run_spec=dict(
                job['run_spec'], source_ahead_ruling='accept_input')))),
        'identifier-field-refused': refused(mutated(lambda v: v['counts']['conversations'].update(zid=1)))
            and refused(mutated(lambda v: v.update(zids=[1]))),
        'content-field-refused': refused(mutated(lambda v: v['counts']['conversations'].update(complete='ten')))
            and refused(mutated(lambda v: v.update(note='free text')))
            and refused(mutated(lambda v: v['blocking'].append('topic text'))),
        'wrong-kind-refused': refused(mutated(lambda v: v.update(kind='light-shadow-compare'))),
        'wrong-image-refused': refused(mutated(lambda v: v['bindings'].update(reader='0' * 64))),
        'wrong-policy-refused': refused(mutated(lambda v: v['bindings'].update(query_policy='0' * 64))),
        'false-complete-refused': refused(mutated(lambda v: v.update(verdict='PASS')))
            and refused(mutated(lambda v: v.update(verdict='BACKFILL-INCOMPLETE'))),
        'count-mismatch-refused': refused(inconsistent('payloads', 'invalid_payload', 1))
            and refused(mutated(lambda v: v['counts']['rows']['math_main'].update(source=11)))
            and refused(mutated(lambda v: v['snapshot'].update(cutoff_age_ms=0))),
        'stale-cutoff-incomplete': incomplete(cutoff_ms=SNAPSHOT_MS - 3_600_001),
        'future-cutoff-incomplete': incomplete(cutoff_ms=SNAPSHOT_MS + 1),
        'complete-vector': vector({}, ()),
        'missing-blocks': vector({'conversations': {'missing_bidtopid': 1, 'complete': 9},
                                  'payloads': {'checked': 9}, 'rows': {'math_bidtopid': {'target': 9}},
                                  'without_target': {'math_bidtopid': 1}},
                                 ('missing_bidtopid', 'complete-short', 'without-target-math_bidtopid')),
        'invalid-blocks': vector({'conversations': {'invalid_payload': 1, 'complete': 9},
                                  'payloads': {'invalid_payload': 1}},
                                 ('invalid_payload', 'complete-short')),
        'source-ahead-blocks': vector({'conversations': {'source_ahead': 1, 'complete': 9},
                                       'cutoff': {'source_ahead_of_input': 1}},
                                      ('source_ahead', 'complete-short', 'source_ahead_of_input')),
        'orphan-blocks': vector({'orphans': {'orphan_ticks': 1}, 'rows': {'math_ticks': {'target': 11}}},
                                ('orphan_ticks',)),
        'cutoff-proof-blocks': vector({'cutoff': {'behind_input_at_cutoff': 1}}, ('behind_input_at_cutoff',)),
        'without-target-blocks': vector({'without_target': {'math_ptptstats': 1},
                                         'rows': {'math_ptptstats': {'source': 11}}},
                                        ('without-target-math_ptptstats',)),
        'poller-behind-blocks': vector({'ticks': {'target_max_ms': SNAPSHOT_MS - 900_001}}, ('poller-not-live',))
            and vector({'ticks': {'target_max_ms': SNAPSHOT_MS - 900_001,
                                  'source_max_ms': SNAPSHOT_MS - 900_002}}, ()),
        'live-lag-allowed': vector({'conversations': {'live_lag': 1}, 'cutoff': {'live_tail_after_cutoff': 1}}, ()),
    }
    assert set(outcomes) | set(LIVE_CONTROLS) == set(CONTROLS)
    return outcomes


def finish(r, job):
    r['controls'].update(controls(job))
    r['verdict'] = expected_verdict(r)
    return r


def export(projection, produced, job, source_commit):
    r = finish(receipt(projection, produced, job, source_commit), job)
    if len(encoded(r)) > LIMIT:
        # Counts are fixed-size, so this cannot happen for a valid projection;
        # never a truncated completion.
        fail('VERIFY_LIMIT')
    return validate_receipt(r, job)


def main():
    if sys.argv[1:] != ['verify']:
        fail('VERIFY_ACTION')
    from contracts import validate_job
    from receipt import decode_json
    recipe = decode_json(Path('/opt/polis-private-image/recipe.json').read_bytes())
    job = validate_job(decode_json(Path('/job/job.json').read_bytes()))
    if job.get('kind') != KIND:
        fail('VERIFY_KIND')
    projection = decode(Path('/input/projection.json').read_bytes())
    produced = decode(Path('/evidence/evidence.json').read_bytes())
    Path('/verdict/receipt.json').write_bytes(encoded(export(projection, produced, job, recipe['sourceCommit'])))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('VERIFY_VERIFIER_FAILED') from None
