#!/usr/bin/env python3
"""Kernel process kill while staging, followed by a retry on the same served scope."""
import shutil
from prove import *

def main():
    # Reuse the first proof's E through the actual served-bundle reader.
    before=rpc('pd_graph_served',"'proof'",'1',"'retry'")
    original=next(a for a in before['bundle']['artifacts'] if a['schema_version']=='graph_embed/1')
    declared_sha=sql(f"SELECT pd_graph_hash(declared) FROM delphi_graph_nodes WHERE job_id={lit(original['job_id'])}")
    s=spec();s['nodes']=s['nodes'][1:]
    s['nodes'][0]['inputs']=[dict(artifact_id=original['artifact_id'],sha256=original['content_sha'],contract_sha256=declared_sha,role='embeddings')]
    rpc('pd_graph_reconcile',"'proof'")
    g=graph('retry',s,'kernel-rebuild');ns=nodes(g)
    (OUT/'control.json').write_text(json.dumps(dict(hold_stage='graph_cluster')))
    worker=start('held-writer')
    until=time.monotonic()+30
    while not (OUT/'held-child.json').exists() and time.monotonic()<until:time.sleep(.1)
    child=json.loads((OUT/'held-child.json').read_text());assert child['job_id']==ns['c']['job_id']
    os.kill(child['pid'],signal.SIGKILL)  # exact PID created by this fixture
    ns=wait(g,lambda x:state(x['c'])=='retry_wait');stop(worker)
    assert ns['c']['artifact'] is None and ns['n']['attempts']==0
    assert rpc('pd_graph_served',"'proof'",'1',"'retry'")==before
    # Destroy this worker's private files; the next worker gets inputs only from PG.
    shutil.rmtree(OUT/'held-writer'/'work')
    control(0);worker=start('replacement-writer');ns=wait(g,lambda x:all(state(n)=='succeeded' for n in x.values()));stop(worker)
    assert count(ns['c'])==2 and count(ns['n'])==1
    result=rpc('pd_graph_publish',"'proof'",lit(g['graph_id']),lit(ns['n']['job_id']),'1')
    assert result['generation']==2 and original in result['bundle']['artifacts']
    assert rpc('pd_graph_publish',"'proof'",lit(g['graph_id']),lit(ns['n']['job_id']),'1')['outcome']=='conflict'
    record('P04_P09_P12_real_SIGKILL_worker_files_removed_old_served_preserved',before=before,after=result,starts=dict(cluster=2,narrative=1))

if __name__=='__main__':
    try:main()
    finally:
        for p in workers:stop(p)
