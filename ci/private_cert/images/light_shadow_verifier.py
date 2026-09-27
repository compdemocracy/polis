"""Recompute every class from the reader projection; only this image writes the receipt.

The verifier does not import producer code. It re-runs the certified
comparison on the original reader rows in its own image, requires the
producer's evidence to equal it exactly, runs the live checks and fixed
negative controls, and reduces everything to the light-shadow receipt:
fixed tokens, counts and worst deltas, with no zid, row payload or text.
"""
from __future__ import annotations
import copy
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'probe_box'))
from light_shadow_compare import (classify, classify_projection, empty_output, fixture_blob, fixture_variants,
                                  structural_variants)
from light_shadow import (ACCEPTANCE, CERTIFICATION_POLICY, CONTROLS, COVERED, EMPTY_DEFECT, EVIDENCE, EXCLUDED_FIELDS,
                          KIND, LIMIT, LIVE_CONTROLS, POLICY_SHA, PROD, PROJECTION_SCHEMA, UNCOVERED_TABLES,
                          decode, encoded, expected_verdict, fail, python_shape, tally, validate_entry,
                          triage_digest, validate_projection, validate_receipt, worst)
from receipt import sha


def entries(projection, evidence, spec):
    """Receipt entries: evidence minus zid, plus created-after-start; content order."""
    out = []
    for conversation, row in zip(projection['conversations'], evidence):
        validate_entry(row, EVIDENCE)
        if row['zid'] != conversation['zid']:
            fail('SHADOW_RECONSTRUCTION')
        entry = {k: v for k, v in row.items() if k != 'zid'}
        created = conversation['created']
        entry['created_after_start'] = created is not None and created > spec['shadow_started_ms']
        out.append(entry)
    return sorted(out, key=encoded)


def live_controls(projection, spec):
    """Only what the snapshot observes; see light_shadow.CONTROLS for the limits."""
    catalog = projection['catalog']
    complete = projection['status'] == 'COMPLETE'
    shape = sum(python_shape(c['prod']) for c in projection['conversations'])
    return {'reader-no-write': complete and catalog['no_write'],
            'prod-count-not-decreased': complete and catalog['prod_main_after'] >= catalog['prod_main']
            and catalog['prod_ticks_after'] >= catalog['prod_ticks'],
            'shadow-label-not-prod': (spec['shadow_env'] != PROD and projection['shadow_env'] == spec['shadow_env']
                                      and shape == 0)}


def receipt(projection, produced, job, source_commit, declared=None):
    spec = job['run_spec']
    validate_projection(projection, spec)
    if projection['source_commit'] != source_commit:
        fail('SHADOW_RECONSTRUCTION')
    expected = classify_projection(projection, declared)
    if produced != expected:
        fail('SHADOW_RECONSTRUCTION')
    listed = entries(projection, expected, spec)
    catalog = projection['catalog']
    # The triage set stays on the box; the receipt binds it by digest.
    flagged = [[row['zid'], *(c['shadow'].get(k) for k in ('lastVoteTimestamp', 'lastModTimestamp'))]
               for c, row in zip(projection['conversations'], expected)
               if row['outcome'] in ('NEAR-TIE-CANDIDATE', 'HISTORY-DIVERGENCE')]
    r = {'schema': 'polis-probe-receipt/3', 'kind': KIND, 'run_id': job['run_id'], 'job_sha256': sha(job),
         'verdict': 'INCOMPLETE', 'acceptance': ACCEPTANCE,
         'bindings': dict(source_commit=source_commit, query_policy=POLICY_SHA,
                          certification_policy=CERTIFICATION_POLICY,
                          server_version_num=projection['server_version_num'],
                          **{k: job[k]['image'].split('@sha256:')[1] for k in ('reader', 'producer', 'verifier')}),
         'run_spec': dict(spec), 'window': projection['window'],
         'coverage': {'status': projection['status'], 'covered': list(COVERED),
                      'uncovered_tables': list(UNCOVERED_TABLES), 'excluded_fields': list(EXCLUDED_FIELDS)},
         'rows': dict({k: v for k, v in catalog.items() if k != 'no_write'},
                      prod_python_shape=sum(python_shape(c['prod']) for c in projection['conversations'])),
         'totals': tally(listed), 'worst': worst(listed),
         'triage': {'required': len(flagged), 'sha256': triage_digest(flagged), 'ids': 'ON-BOX-ONLY'},
         'conversations': listed,
         'controls': dict(dict.fromkeys(CONTROLS, False), **live_controls(projection, spec))}
    r['verdict'] = expected_verdict(r)
    return r


def fixture_projection(spec, declared):
    """Constructed public rows: one conversation per pairing state and outcome."""
    variants = fixture_variants()
    rows = [{'zid': i, 'created': spec['shadow_started_ms'] + (1 if name == 'pass' else -1),
             'prod': p, 'shadow': s} for i, (name, (p, s)) in enumerate(sorted(variants.items()), 1)]
    end = 1_900_000_000_000
    catalog = {'prod_main': 8, 'shadow_main': 8, 'prod_ticks': 8, 'shadow_ticks': 8, 'active': len(rows),
               'prod_main_after': 8, 'prod_ticks_after': 8, 'no_write': True}
    return {'schema': PROJECTION_SCHEMA, 'source_commit': '1' * 40, 'query_policy': POLICY_SHA,
            'server_version_num': 170000, 'status': 'COMPLETE', 'shadow_env': spec['shadow_env'],
            'window': {'start_ms': end - 1000 * spec['window_seconds'], 'end_ms': end},
            'catalog': catalog, 'conversations': rows}


def refused(check):
    try:
        check()
    except (ValueError, KeyError, TypeError):
        return True
    return False


def controls(job, declared=None):
    """Fixed self-tests; every refusal path must refuse and every vector must classify."""
    from contracts import validate_job
    declared = empty_output() if declared is None else declared
    p = fixture_projection(job['run_spec'], declared)
    evidence = classify_projection(p, declared)
    good = receipt(p, evidence, job, '1' * 40, declared)
    good['controls'] = dict.fromkeys(CONTROLS, True)
    good['verdict'] = expected_verdict(good)
    if good['verdict'] != 'OPERATIONAL-FAIL' or good['totals']['FAIL'] != 1:
        fail('SHADOW_CONTROL_FIXTURE')
    validate_receipt(good, job)

    def mutated(mutate):
        bad = copy.deepcopy(good)
        mutate(bad)
        return lambda: validate_receipt(bad, job)

    def empty_refused():
        # A complete snapshot with no active conversation stays INCOMPLETE,
        # and a receipt claiming PASS for it is refused.
        q = dict(p, conversations=[], catalog=dict(p['catalog'], active=0))
        r = receipt(q, [], job, '1' * 40, declared)
        r['controls'] = dict.fromkeys(CONTROLS, True)
        r['verdict'] = expected_verdict(r)
        if r['verdict'] != 'INCOMPLETE':
            return False
        validate_receipt(r, job)
        return refused(lambda: validate_receipt(dict(r, verdict='OPERATIONAL-PASS'), job))

    def low_coverage_refused():
        # One pair among mostly missing shadows stays INCOMPLETE.
        rows = [{'zid': z, 'created': None, 'prod': fixture_blob(), 'shadow': fixture_blob() if z == 1 else None}
                for z in range(1, 4)]
        q = dict(p, conversations=rows, catalog=dict(p['catalog'], active=3))
        r = receipt(q, classify_projection(q, declared), job, '1' * 40, declared)
        r['controls'] = dict.fromkeys(CONTROLS, True)
        r['verdict'] = expected_verdict(r)
        if r['verdict'] != 'INCOMPLETE' or r['totals']['PAIRED'] != 1:
            return False
        validate_receipt(r, job)
        return refused(lambda: validate_receipt(dict(r, verdict='OPERATIONAL-PASS'), job))

    def forged_evidence():
        tampered = copy.deepcopy(evidence)
        tampered[0]['outcome'] = 'PASS' if tampered[0]['outcome'] != 'PASS' else 'FAIL'
        receipt(p, tampered, job, '1' * 40, declared)

    def forged_projection():
        q = copy.deepcopy(p)
        q['conversations'].append(copy.deepcopy(q['conversations'][-1]))
        q['catalog']['active'] += 1
        receipt(q, classify_projection(q, declared), job, '1' * 40, declared)

    outcomes = {
        'empty-result-refused': empty_refused(),
        'low-coverage-refused': low_coverage_refused(),
        'forged-evidence-refused': refused(forged_evidence),
        'forged-projection-refused': refused(forged_projection)
            and refused(lambda: receipt(dict(p, query_policy='0' * 64), evidence, job, '1' * 40, declared))
            and refused(lambda: receipt(dict(p, shadow_env=PROD), evidence, job, '1' * 40, declared)),
        'prod-label-refused': refused(lambda: validate_job(dict(job, run_spec=dict(job['run_spec'], shadow_env=PROD)))),
        'identifier-field-refused': refused(mutated(lambda v: v['conversations'][0].update(zid=1))),
        'content-field-refused': refused(mutated(lambda v: v['conversations'][0].update(differing=['topic text'])))
            and refused(mutated(lambda v: v.update(note='free text'))),
        'wrong-kind-refused': refused(mutated(lambda v: v.update(kind='roles-census'))),
        'wrong-image-refused': refused(mutated(lambda v: v['bindings'].update(reader='0' * 64))),
        'wrong-policy-refused': refused(mutated(lambda v: v['bindings'].update(query_policy='0' * 64))),
        'false-pass-refused': refused(mutated(lambda v: v.update(verdict='OPERATIONAL-PASS')))
            and refused(mutated(lambda v: v.update(verdict='PASS')))
            and refused(mutated(lambda v: v['triage'].update(required=0, sha256=None))),
        'count-mismatch-refused': refused(mutated(lambda v: v['totals'].update(PASS=v['totals']['PASS'] + 1)))
            and refused(mutated(lambda v: v['rows'].update(active=v['rows']['active'] + 1))),
    }
    variants = fixture_variants()
    vectors = {'pair-timestamps': ('timestamps', ('UNPAIRED', 'TIMESTAMPS', None)),
               'pair-totals': ('totals', ('UNPAIRED', 'TOTALS', None)),
               'class-pass': ('pass', ('PAIRED', None, 'PASS')),
               'class-near-tie': ('near-tie', ('PAIRED', None, 'NEAR-TIE-CANDIDATE')),
               'class-history': ('history', ('PAIRED', None, 'HISTORY-DIVERGENCE')),
               'class-fail': ('fail', ('PAIRED', None, 'FAIL')),
               'class-legacy-empty': ('legacy-empty', ('PAIRED', None, 'PASS'))}
    for name, (variant, want) in vectors.items():
        row = classify(1, *variants[variant], declared)
        outcomes[name] = (row['pairing'], row['unpaired'], row['outcome']) == want
    outcomes['class-legacy-empty'] &= classify(1, *variants['legacy-empty'], declared)['legacy_defect'] == EMPTY_DEFECT
    structural = structural_variants()

    def fails(*names):
        return all(classify(1, *structural[n], declared)['outcome'] == 'FAIL' for n in names)
    outcomes['missing-pairing-fails'] = fails('missing-pairing')
    outcomes['empty-objects-fail'] = fails('empty-objects')
    outcomes['missing-field-fails'] = fails('missing-pca', 'missing-group-clusters', 'missing-repness')
    outcomes['truncated-pca-fails'] = fails('truncated-pca')
    assert set(outcomes) | set(LIVE_CONTROLS) == set(CONTROLS)
    return outcomes


def finish(r, job, declared=None):
    r['controls'].update(controls(job, declared))
    r['verdict'] = expected_verdict(r)
    return r


def export(projection, produced, job, source_commit, declared=None):
    r = finish(receipt(projection, produced, job, source_commit, declared), job, declared)
    if len(encoded(r)) > LIMIT:
        # Too many entries for the export allowance: an INCOMPLETE receipt
        # without entries, never a truncated PASS.
        cut = dict(projection, status='LIMIT_EXCEEDED', window=None, conversations=[],
                   catalog=dict(projection['catalog'], active=0))
        r = finish(receipt(cut, [], job, source_commit, declared), job, declared)
    return validate_receipt(r, job)


def main():
    if sys.argv[1:] != ['verify']:
        fail('SHADOW_ACTION')
    from contracts import validate_job
    from receipt import decode_json
    recipe = decode_json(Path('/opt/polis-private-image/recipe.json').read_bytes())
    job = validate_job(decode_json(Path('/job/job.json').read_bytes()))
    if job.get('kind') != KIND:
        fail('SHADOW_KIND')
    projection = decode(Path('/input/projection.json').read_bytes())
    produced = decode(Path('/evidence/evidence.json').read_bytes())
    Path('/verdict/receipt.json').write_bytes(encoded(export(projection, produced, job, recipe['sourceCommit'])))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('SHADOW_VERIFIER_FAILED') from None
