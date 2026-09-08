"""Emit an honest CO07 inventory; missing contract stages block certification."""
import json
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
    ' identical bytes for both writers at generation one, and the real pca2 route serves'
    ' generation zero, but CO04\'s loadBundle/Bundle cache-unit rewrite does not exist in'
    ' the server and is untested here',
    'CO08/D4: application boot, auth, report.ts/doFamousQuery and the private 2,884-case'
    ' served corpus are not executed; the empty presentation is compared synthetically',
    'CO08/D4 reader defect (server owner): getPca(zid, undefined) misses a cold committed'
    ' generation zero and finds it once the route warms the cache; the route itself,'
    ' which passes math_tick=-1, serves it with 200 and ETag "0"',
    'C7 / polis-empty-served/1: the reference writer publishes no row for a zero-vote'
    ' conversation, the server synthesizes the approved-comment listing with a'
    ' request-clock lastVoteTimestamp, and a published empty generation lists no tids;'
    ' the transition must satisfy G\'s existing comment and clock preservation ruling,'
    ' which is decided and is not reopened here',
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
    full_contract_gate='FAIL',
    profile='Rust coordinator + Python worker + CLI Bundle reader, the real Node '
            'getPca/getBidIndexToPidMapping reader in-process, and the real pca2 route '
            'over loopback HTTP; no loadBundle, no application boot')
path=root/'coordinator-rs/evidence/stage-inventory.json'
path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='stages'}))
sys.exit(1 if result['full_contract_gate']=='FAIL' else 0)
