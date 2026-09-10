"""Emit an honest CO07 inventory; missing contract stages block certification."""
import json
import hashlib
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
    'CO08/D4: candidate coherent-read atomicity and the production reader local slice are'
    ' recorded; BOARD[633] accepts the production implementation and public1265/0/2 replay.'
    ' O1 remains partial: required pinned-module CI with exact case inventory/zero skips'
    ' and the combined S5 build/corpus campaigns remain open',
    'CO08/D4: the combined immutable-build/full-app/auth/report/CSV campaign and private'
    ' served corpus remain open; accepted public reader evidence does not complete S5',
    'CO08/D4 (server owner): the getPca(zid, undefined) cold generation-zero miss is fixed'
    ' upstream by #2732 (merged to edge), so the cold call now finds generation zero and pca2'
    ' serves it with 200 / ETag "0" / conditional 304; the combined-build full-app coverage of'
    ' generation zero across all callers is still outstanding',
    'C7 / polis-empty-served/1: the Python comparison writer publishes no row for a zero-vote'
    ' conversation, the server synthesizes the approved-comment listing with a'
    ' request-clock lastVoteTimestamp, and a published empty generation lists no tids;'
    ' the transition must preserve comment ownership; the comparison clock is admitted'
    ' (plan rev2 C2: freeze the logical request clock, advance it, preserve the response'
    ' dependency), and the empty-transition campaign that exercises it is still open',
    'CO01: the incremental probe is a hint bounded by P026_RECONCILE_SECONDS, measured'
    ' from before the source read; the interval makes a conversation eligible for'
    ' reconciliation and is not a deadline, and no pass/service budget has been measured',
    'CO02/CO06: persisted payloads become eligible for revalidation once the ceiling'
    ' elapses, not on every pass; resident-cache reconciliation is single-threaded and'
    ' no multi-worker or warm-worker cache campaign exists',
    'P-031: this crate implements none of A01 PollHealthy, A02 PublishLagSeconds or'
    ' A03 ObserverHealthy, has no deployed publisher and no delivery proof; the optional'
    ' synchronous sink can still block when enabled',
    'O8 remains OPEN and is at most PARTIAL: polis-candidate-input/1 is claimed locally as a'
    ' candidate profile, not a G01-G16 certificate. S1 records the distinct candidate schema id,'
    ' strict adapter admission, original-byte digests with decoded correspondence, and the'
    ' worker/engine pins; still outstanding are all applicable G01-G16 cases with their required'
    ' negative controls, an immutable manifest, the distinction between fresh rebuild, exact'
    ' resume and warm incremental output schedules, and a non-vacuous P-023 compensated pair with'
    ' raw C9 validation']
# S1 records part of the local candidate-identity/storage obligation. It does not
# close O8: the plan's O8 row also requires the G01-G16 case set, an immutable
# manifest, the three output schedules and the P-023 pair, none of which S1
# delivers. So the standing G01-G16 disclaimer above is never removed, and the
# best state this script will ever write for O8 is PARTIAL.
#
# Reproducibility: the closure may pin only committed repository inputs — source,
# migration, schemas, tests. Build outputs under coordinator-rs/target/ and run
# logs under coordinator-rs/artifacts/ are gitignored, so hash-gating on them
# would make the committed inventory verifiable on exactly one machine and
# self-invalidating everywhere else. Those hashes are still recorded, but as an
# informational `run_pins` block that this gate deliberately does not check.
IGNORED_PREFIXES = ('coordinator-rs/target/', 'coordinator-rs/artifacts/')
condition_states = {f'O{i}': 'OPEN' for i in range(1, 9)}
partial_conditions = []
closure_path = root/'coordinator-rs/evidence/s1-closure.json'
if closure_path.exists():
    closure = json.loads(closure_path.read_text())
    try:
        assert closure['id'] == 'O8' and closure['scope'] == 'P-026 step-4 S1 candidate identity and original-byte custody'
        assert closure['state'] == 'PARTIAL' and closure['g01_g16_certified'] is False
        assert closure['remaining_obligations'], 'a PARTIAL record must name what is still open'
        required_pins = {
            'coordinator-rs/src/engine.rs', 'coordinator-rs/src/store.rs', 'coordinator-rs/src/main.rs',
            'coordinator-rs/migration.sql', 'coordinator-rs/Cargo.lock', 'coordinator-rs/rust-toolchain.toml',
            'coordinator-rs/schemas/candidate-admission.schema.json',
            'delphi/polismath/engine_adapter.py', 'delphi/tests/coordinator/test_s1_identity.py',
            'delphi/tests/coordinator/test_adapter.py', 'delphi/tests/coordinator/audit_stages.py',
            'coordinator-rs/tests/s1_admission.rs', 'coordinator-rs/tools/record_s1.py',
        }
        assert required_pins <= closure['sha256'].keys(), 'missing S1 source pins'
        for name, expected in sorted(closure['sha256'].items()):
            assert not name.startswith(IGNORED_PREFIXES), f'gitignored build output pinned as a source: {name}'
            assert hashlib.sha256((root/name).read_bytes()).hexdigest() == expected, name
        partial_conditions.append(dict(id='O8', state='PARTIAL',
            standing_condition=open_conditions[-1], evidence=str(closure_path.relative_to(root)),
            scope=closure['scope'], recorded=closure['recorded'],
            remaining_obligations=closure['remaining_obligations'],
            g01_g16_certified=False, run_pins_verified_here=False))
        condition_states['O8'] = 'PARTIAL (S1 identity/custody recorded; G01-G16 open)'
    except (AssertionError, KeyError, OSError, ValueError) as error:
        print(f'S1 partial record refused: {error}', file=sys.stderr)

# S2 production implementation/local proof is closed by BOARD[633].
# O1 remains PARTIAL: required CI and combined S5 campaigns are not certified.
s2_closure_path = root/'coordinator-rs/evidence/s2-closure.json'
if s2_closure_path.exists():
    closure = json.loads(s2_closure_path.read_text())
    try:
        assert closure['id'] == 'O1' and closure['scope'] == 'P-026 step-4 S2 reader: candidate loadBundle whole-Bundle atomicity'
        assert closure['state'] == 'PARTIAL' and closure['production_loadbundle_certified'] is False
        assert closure['remaining_obligations'], 'a PARTIAL record must name what is still open'
        assert closure['production_reader_obligation_state'] == 'CLOSED'
        assert closure['production_reader_evidence'] == 'coordinator-rs/evidence/s2-production-reader.json'
        required_pins = {
            'coordinator-rs/tools/bundle_reader.cjs', 'coordinator-rs/tools/record_s2.py',
            'coordinator-rs/evidence/s2-production-reader.json', 'coordinator-rs/tools/record_s2_production.py',
            'delphi/tests/coordinator/test_bundle_reader.py', 'delphi/tests/coordinator/test_node_reader.py',
            'delphi/tests/coordinator/_node_gate.py', 'delphi/tests/coordinator/audit_stages.py',
        }
        assert required_pins <= closure['sha256'].keys(), 'missing S2 source pins'
        for name, expected in sorted(closure['sha256'].items()):
            assert not name.startswith(IGNORED_PREFIXES), f'gitignored build output pinned as a source: {name}'
            assert hashlib.sha256((root/name).read_bytes()).hexdigest() == expected, name
        partial_conditions.append(dict(id='O1', state='PARTIAL',
            standing_condition=open_conditions[0], evidence=str(s2_closure_path.relative_to(root)),
            scope=closure['scope'], recorded=closure['recorded'],
            remaining_obligations=closure['remaining_obligations'],
            production_loadbundle_certified=False, production_reader_obligation_state="CLOSED",
            production_reader_evidence=closure["production_reader_evidence"], run_pins_verified_here=False))
        condition_states['O1'] = 'PARTIAL (S2 production reader locally proven; required CI and combined S5 open)'
    except (AssertionError, KeyError, OSError, ValueError) as error:
        print(f'S2 partial record refused: {error}', file=sys.stderr)

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
    condition_states=condition_states,closed_conditions=[],partial_conditions=partial_conditions,
    full_contract_gate='FAIL',
    profile='Rust coordinator + Python worker + CLI Bundle reader, the real Node '
            'getPca/getBidIndexToPidMapping reader in-process, the real pca2 route '
            'over loopback HTTP, and a candidate coherent-read loadBundle atomicity '
            'witness in the D4 harness; production reader local proof accepted; no combined S5/private certificate')
path=root/'coordinator-rs/evidence/stage-inventory.json'
path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='stages'}))
sys.exit(1 if result['full_contract_gate']=='FAIL' else 0)
