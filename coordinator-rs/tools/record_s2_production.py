"""Carry the reviewed S2 production receipt into closure metadata without rerunning evidence.

This checks recorded counts and source custody. It does not execute a replay or
turn the accepted local slice into required CI or full-contract certification.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RECEIPT = 'coordinator-rs/evidence/s2-production-reader.json'


def apply(closure):
    receipt = json.loads((ROOT / RECEIPT).read_text())
    assert receipt['state'] == 'CLOSED' and receipt['overall_O1'] == 'PARTIAL'
    assert receipt['full_contract_certified'] is False
    replay = receipt['replay']
    assert (replay['cases'], replay['oracle_failures'], replay['differences']) == (1265, 0, 2)
    assert replay['difference_cases'] == ['r19/admin/boundary', 'r20/admin/boundary']
    assert replay['differences_waived'] is False and replay['audit_checks'] == 24
    assert receipt['census'] == {'before': 302, 'after': 302, 'changed_fingerprints': 0,
                                 'ordered_middleware_equal': True}
    assert receipt['remaining_obligations']
    assert {'server/src/utils/mathBundle.ts', 'server/src/utils/pca.ts',
            'server/src/utils/pcaPresentation.ts', 'server/src/server-helpers.ts',
            'server/src/report.ts', 'server/src/routes/math.ts'} <= receipt['sha256'].keys()
    for name, expected in receipt['sha256'].items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == expected, name
    closure['production_reader_obligation_state'] = 'CLOSED'
    closure['production_reader_evidence'] = RECEIPT
    # This older boolean denotes the broader certificate, still not established.
    closure['production_loadbundle_certified'] = False
    closure['recorded'] = [x for x in closure['recorded'] if x not in receipt['recorded']] + receipt['recorded']
    closure['remaining_obligations'] = receipt['remaining_obligations']
    closure['integrity_model'] = ('Candidate atomicity witness plus accepted production-reader local proof; '
                                  'required CI and combined S5 campaigns remain open. No full-contract certificate.')
    paths = [RECEIPT, 'coordinator-rs/tools/record_s2_production.py',
             'coordinator-rs/tools/record_s2.py', 'delphi/tests/coordinator/audit_stages.py']
    closure['sha256'].update(receipt['sha256'])
    closure['sha256'].update({p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths})
    return closure


if __name__ == '__main__':
    path = ROOT / 'coordinator-rs/evidence/s2-closure.json'
    path.write_text(json.dumps(apply(json.loads(path.read_text())), indent=2) + '\n')
