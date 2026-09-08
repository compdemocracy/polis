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
        rows.append(dict(stage=stage,status='required-but-unreached',reason='single-worker rebuild profile has no warm cache; non-applicability needs contract-owner review'))
assert not set(compiled)-set(required), 'unreviewed compiled marker'
result=dict(protocol='polis-fault-control/1',compiled_stages=len(compiled),required_stages=len(required),
    reached=sum(r['status']=='reached-and-blocked' for r in rows),stages=rows,
    full_contract_gate='FAIL' if any(r['status']!='reached-and-blocked' for r in rows) else 'PASS',
    profile='Rust coordinator + Python worker + CLI Bundle reader; actual Node not exercised')
path=root/'coordinator-rs/evidence/stage-inventory.json'
path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='stages'}))
sys.exit(1 if result['full_contract_gate']=='FAIL' else 0)
