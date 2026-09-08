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
    'CO08/D4: the real Node reader (getPca + getBidIndexToPidMapping + getPidsForGid) now'
    ' serves identical bytes for both writers, but CO04\'s loadBundle/Bundle cache-unit'
    ' rewrite does not exist in the server and is untested here',
    'CO08/D4: HTTP routes, ETag/304 handling and the private 2,884-case served corpus are'
    ' not executed; the empty presentation is compared synthetically only',
    'CO08/D4 finding: a committed generation of 0 is not served at all by the real reader'
    ' (pca.ts guards the column override with a falsy 0, then drops the row)',
    'C7: a published empty math blob lists no tids while the server synthesizes the'
    ' approved-comment listing; polis-empty-served/1 must rule on the difference',
    'CO01: the incremental probe is a hint bounded by P026_RECONCILE_SECONDS; no proven'
    ' change token covers every transaction, so the ceiling is what carries completeness',
    'CO02/CO06: resident-cache integrity reconciliation is per-pass and single-threaded;'
    ' a multi-worker / warm-worker cache campaign is absent',
    'polis-input/1 is claimed locally as a candidate profile, not a G01-G16 certificate']
metrics=json.loads(subprocess.check_output([str(root/'coordinator-rs/target/fault/debug/polis-coordinator'),'metrics'],text=True))
assert metrics['namespace']=='Polis/Math' and metrics['dimensions']==['Environment','MathEnv']
unreached=[r['stage'] for r in rows if r['status']!='reached-and-blocked']
result=dict(protocol='polis-fault-control/1',compiled_stages=len(compiled),required_stages=len(required),
    metrics_namespace=metrics['namespace'],declared_metrics=len(metrics['metrics']),
    reached=sum(r['status']=='reached-and-blocked' for r in rows),stages=rows,unreached=unreached,
    stage_inventory_gate='FAIL' if unreached else 'PASS',
    open_conditions=open_conditions,
    full_contract_gate='FAIL',
    profile='Rust coordinator + Python worker + CLI Bundle reader + the real Node '
            'getPca/getBidIndexToPidMapping reader in-process; no HTTP route, no loadBundle')
path=root/'coordinator-rs/evidence/stage-inventory.json'
path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='stages'}))
sys.exit(1 if result['full_contract_gate']=='FAIL' else 0)
