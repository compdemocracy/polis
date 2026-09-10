"""Record the S3 publication telemetry slice; no full S3/O7 closure or cloud claim.

Run after the full gate, record_s1 and record_s2. Require the exact severed-COMMIT
cases in the supplied JUnit, rather than inferring their coverage from a total.
This checks the slice case set, not the outstanding required CI job.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / 'coordinator-rs/evidence'


def main():
    suites = ET.parse(ROOT / 'coordinator-rs/artifacts/s1-pytest.xml').getroot().findall('testsuite')
    assert suites and all(int(s.attrib[k]) == 0 for s in suites for k in ('failures', 'errors', 'skipped'))
    cases = [c for s in suites for c in s.findall('testcase')]
    names = {c.attrib['name'] for c in cases}
    required = {'test_uncertain_commit_readback_binds_publishing_epoch[False]',
                'test_uncertain_commit_readback_binds_publishing_epoch[True]',
                'test_confirmed_commit_emits_no_ambiguous_outcome'}
    required |= {f'test_failed_readback_is_unresolved_and_alarmable[{mode}-{fault}]'
                 for mode in ('once', 'publish-fixture')
                 for fault in ('absent', 'inconsistent', 'reconnect', 'read')}
    assert required <= names, f'missing required outcome cases: {sorted(required - names)}'
    summary_path = EVIDENCE / 'test-summary.json'
    summary = json.loads(summary_path.read_text())
    assert summary['python_full_suite']['passed'] == len(cases)
    assert summary['stage_audit']['full_contract_gate'] == 'FAIL'
    catalog = json.loads(subprocess.check_output(
        [str(ROOT / 'coordinator-rs/target/fault/debug/polis-coordinator'), 'metrics'], text=True))
    assert catalog['publication_readback_alarm']['deployed'] is False
    paths = ['coordinator-rs/src/store.rs', 'coordinator-rs/src/metrics.rs',
             'coordinator-rs/tests/validation.rs', 'coordinator-rs/tools/record_s3.py',
             'delphi/tests/coordinator/test_s1_identity.py',
             'delphi/tests/coordinator/test_publication_metrics.py']
    evidence = dict(scope='S3 publication-outcome telemetry only', required_cases=sorted(required),
                    required_cases_passed=len(required), python_full_suite_passed=len(cases),
                    alarm=catalog['publication_readback_alarm'],
                    observations=['real COMMIT reply severed; exact own identity resolves',
                                  'same tick/content/operation at a replacement epoch stays unresolved',
                                  'absent/inconsistent rows and reconnect/read failures stay unresolved',
                                  'once and publish-fixture emit at operation boundary, without double counting',
                                  'local observer: any unresolved outcome alarms; attempts, missing data and other namespace cannot prove resolution; later own cannot erase lost',
                                  'confirmed COMMIT emits no ambiguous outcome'],
                    intended_writer='certified Python poller, with Clojure fenced before transfer',
                    production_fencing_changed=False, cloud_delivery_verified=False, O7='OPEN',
                    remaining=['bounded nonblocking transport and independent producer/sink observer',
                               'deployed publisher, missing-data alarms and delivery drill',
                               'paced rebuild/transfer rehearsal and writer exclusion proof',
                               'remaining S3 fairness/capacity and full-contract obligations'],
                    sha256={p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths})
    (EVIDENCE / 'metrics-catalog.json').write_text(json.dumps(catalog, separators=(',', ':')) + '\n')
    (EVIDENCE / 's3-publication-telemetry.json').write_text(json.dumps(evidence, indent=2) + '\n')
    summary['s3_publication_telemetry'] = evidence
    summary['uncommitted'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True))
    summary_path.write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(dict(required_cases=len(required), python=len(cases), O7='OPEN', full_contract_gate='FAIL')))


if __name__ == '__main__':
    main()
