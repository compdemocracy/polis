"""Emit an honest CO07 inventory; missing contract stages block certification."""
import json
import hashlib
import xml.etree.ElementTree as ET
from pathlib import Path
import subprocess
import sys

root=Path(__file__).resolve().parents[3]
artifacts=root/'coordinator-rs/artifacts'
compiled=json.loads(subprocess.check_output([str(root/'coordinator-rs/target/fault/debug/polis-coordinator'),'stages'],text=True))
required=['after_source_selection','after_input_checkpoint','before_worker_apply','after_worker_compute',
    'after_lease','before_ticks','after_ticks','before_bidtopid','after_bidtopid','before_ptptstats','after_ptptstats',
    'before_main','after_main','before_commit','after_commit','after_ack','before_restore','after_restore',
    'before_cursor','after_cursor','before_sweep','after_sweep','bundle_pinned','before_companion_join',
    'cache_eviction_contends_with_same_zid_update']
rows=[]
for stage in required:
    file=artifacts/f'stage-{stage}.json'
    if stage in compiled and file.exists():
        evidence=json.loads(file.read_text())
        assert evidence['ack']['stage']==stage
        assert evidence['ack']['state']=='reached-and-blocked'
        assert evidence.get('postcondition')
        rows.append(dict(stage=stage,status='reached-and-blocked',evidence=evidence))
    else:
        rows.append(dict(stage=stage,status='required-but-unreached',reason='no evidence artifact for a compiled, contract-required stage'))
assert not set(compiled)-set(required), 'unreviewed compiled marker'
# The stage inventory and the full contract gate are separate verdicts: reaching
# every fault stage does not certify CO08/D4, which need the actual Node route.
open_conditions=[
    'CO08/D4: the real Node reader (getPca + getBidIndexToPidMapping + getPidsForGid) serves'
    ' identical Rust/Python bytes at generation one, and the real pca2 route serves'
    ' generation zero, but CO04\'s loadBundle/Bundle cache-unit rewrite does not exist in'
    ' the server and is untested here',
    'CO08/D4: application boot, auth, report.ts/doFamousQuery and the private 2,884-case'
    ' served corpus are not executed; the empty presentation is compared synthetically',
    'CO08/D4 reader defect (server owner): getPca(zid, undefined) misses a cold committed'
    ' generation zero and finds it once the route warms the cache; the route itself,'
    ' which passes math_tick=-1, serves it with 200 and ETag "0"',
    'C7 / polis-empty-served/1: the Python comparison writer publishes no row for a zero-vote'
    ' conversation, the server synthesizes the approved-comment listing with a'
    ' request-clock lastVoteTimestamp, and a published empty generation lists no tids;'
    ' the transition must preserve comment ownership; the contract owner must still'
    ' admit a frozen clock or path-specific clock normalization before this gate closes',
    'CO01: the incremental probe is a hint bounded by P026_RECONCILE_SECONDS, measured'
    ' from before the source read; the interval makes a conversation eligible for'
    ' reconciliation and is not a deadline, and no pass/service budget has been measured',
    'CO02/CO06: persisted payloads become eligible for revalidation once the ceiling'
    ' elapses, not on every pass; resident-cache reconciliation is single-threaded and'
    ' no multi-worker or warm-worker cache campaign exists',
    'P-031: this crate implements none of A01 PollHealthy, A02 PublishLagSeconds or'
    ' A03 ObserverHealthy, has no deployed publisher and no delivery proof; the optional'
    ' synchronous sink can still block when enabled',
    'polis-input/1 is claimed locally as a candidate profile, not a G01-G16 certificate']
# S1 closes the local candidate-identity/storage hole, not G01-G16 conformance.
# Missing/stale/failed evidence leaves O8 open; a self-declared schema alone does
# not discharge it. Source, binaries, and the actual gate logs are hash-bound.
condition_states = {f'O{i}': 'OPEN' for i in range(1, 9)}
closed_conditions = []
closure_path = root/'coordinator-rs/evidence/s1-closure.json'
if closure_path.exists():
    closure = json.loads(closure_path.read_text())
    try:
        assert closure['id'] == 'O8' and closure['scope'] == 'P-026 step-4 S1 candidate identity and original-byte custody'
        assert closure['g01_g16_certified'] is False
        required_pins = {
            'coordinator-rs/src/engine.rs', 'coordinator-rs/src/store.rs', 'coordinator-rs/migration.sql',
            'coordinator-rs/schemas/candidate-admission.schema.json',
            'delphi/polismath/engine_adapter.py', 'delphi/tests/coordinator/test_s1_identity.py',
            'coordinator-rs/tests/s1_admission.rs', 'coordinator-rs/target/release/polis-coordinator',
            'coordinator-rs/target/fault/debug/polis-coordinator', closure['junit'],
        } | {f'coordinator-rs/artifacts/{name}' for name in (
            's1-cargo-default.log', 's1-cargo-fault.log', 's1-clippy-default.log',
            's1-clippy-fault.log', 's1-release.log', 's1-fault-build.log')}
        assert required_pins <= closure['sha256'].keys(), 'missing S1 evidence pins'
        for name, expected in closure['sha256'].items():
            assert hashlib.sha256((root/name).read_bytes()).hexdigest() == expected, name
        suites = ET.parse(root/closure['junit']).getroot().findall('testsuite')
        assert suites and sum(int(s.attrib['tests']) for s in suites) == closure['python_tests']
        assert all(int(s.attrib[k]) == 0 for s in suites for k in ('failures', 'errors', 'skipped'))
        for name in ('s1-cargo-default.log', 's1-cargo-fault.log'):
            log = (artifacts/name).read_text()
            assert '12 passed; 0 failed' in log and '19 passed; 0 failed' in log
        for name in ('s1-clippy-default.log', 's1-clippy-fault.log', 's1-release.log', 's1-fault-build.log'):
            log = (artifacts/name).read_text()
            assert 'Finished ' in log and 'error:' not in log
        closed_conditions.append(dict(id='O8', prior_condition=open_conditions.pop(), evidence=str(closure_path.relative_to(root)),
            scope=closure['scope'], g01_g16_certified=False))
        condition_states['O8'] = 'CLOSED (S1 scope; no G01-G16 certificate)'
    except (AssertionError, KeyError, OSError, ValueError) as error:
        print(f'S1 closure refused: {error}', file=sys.stderr)

metrics=json.loads(subprocess.check_output([str(root/'coordinator-rs/target/fault/debug/polis-coordinator'),'metrics'],text=True))
assert metrics['namespace']=='Polis/Math' and metrics['dimensions']==['Environment','MathEnv']
# Rev7 observability admission: no row may claim a P-031 alarm this crate does not implement.
assert metrics['p031_status']['coverage_claimed']==[]
assert all(m['p031_alarm']=='' for m in metrics['metrics'])
unreached=[r['stage'] for r in rows if r['status']!='reached-and-blocked']
result=dict(protocol='polis-fault-control/1',compiled_stages=len(compiled),required_stages=len(required),
    metrics_namespace=metrics['namespace'],declared_metrics=len(metrics['metrics']),
    reached=sum(r['status']=='reached-and-blocked' for r in rows),stages=rows,unreached=unreached,
    stage_inventory_gate='FAIL' if unreached else 'PASS',
    open_conditions=open_conditions,
    condition_states=condition_states,closed_conditions=closed_conditions,
    full_contract_gate='FAIL',
    profile='Rust coordinator + Python worker + CLI Bundle reader, the real Node '
            'getPca/getBidIndexToPidMapping reader in-process, and the real pca2 route '
            'over loopback HTTP; no loadBundle, no application boot')
path=root/'coordinator-rs/evidence/stage-inventory.json'
path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='stages'}))
sys.exit(1 if result['full_contract_gate']=='FAIL' else 0)
