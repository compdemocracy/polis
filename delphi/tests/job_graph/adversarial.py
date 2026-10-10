#!/usr/bin/env python3
"""RPC-boundary and race controls, complement the real daemon scenario in prove.py."""
import concurrent.futures
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess as sp
import time
import uuid
from prove import *


def claim(cls='delphi',stage='graph_embed'):
    return rpc('pd_graph_claim',"'proof'","1::smallint",lit(uuid.uuid4()),lit(uuid.uuid4()),'10',lit(cls),lit(stage))

def ident(c):return ["'proof'",lit(c['job_id']),lit(c['owner_id']),lit(c['attempt_id']),lit(c['lease_epoch'])]
def finish(c,manifest,seq):
    raw=json.dumps(manifest,sort_keys=True,separators=(',',':'))
    sha=hashlib.sha256(raw.encode()).hexdigest()
    sql(f"INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line) VALUES('proof',{lit(c['attempt_id'])},{seq},'manifest',{lit(raw)})",True)
    return rpc('pd_graph_finalize',*ident(c),"'unused'",lit(sha)),sha

def main():
    # Existing output is unaffected by every rejection below.
    served=rpc('pd_graph_served',"'proof'",'1',"'retry'")
    only=spec();only['nodes']=only['nodes'][:1]
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results=list(pool.map(lambda _:graph('concurrent',only),range(2)))
    assert results[0]['graph_id']==results[1]['graph_id']
    record('P07_concurrent_idempotent_admission',responses=results)
    g=results[0];n=nodes(g)['e']
    # The installed membership/edge triggers close owner-control bypasses too.
    sql(f"UPDATE delphi_graphs SET sealed=false WHERE graph_id={lit(g['graph_id'])}",ok=False)
    sql(f"UPDATE delphi_graph_nodes SET declared='{{}}' WHERE job_id={lit(n['job_id'])}",ok=False)
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        cs=list(pool.map(lambda _:claim(),range(2)))
    assert sorted(c['outcome'] for c in cs)==['none','owned'];c=next(x for x in cs if x['outcome']=='owned')
    # No process was spawned for this RPC control: exit proof is honest.
    rpc('pq_end_attempt',*ident(c),"'confirm_exit'","NULL",'true')
    module_spec=importlib.util.spec_from_file_location('stage',ROOT/'delphi/scripts/job_graph_stage.py')
    module=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(module)
    frame=dict(schema='polis-job-stage-frame/1',job_id=c['job_id'],run_id=c['run_id'],attempt_id=c['attempt_id'],stage=c['stage'],input=c['graph_input'],input_sha256=c['graph_input_sha'],input_json=c['graph_input_wire'])
    manifest=module.run(frame)
    for i,(field,value) in enumerate([('input_sha256','0'*64),('run_id',str(uuid.uuid4())),('attempt_id',str(uuid.uuid4()))]):
        bad=copy.deepcopy(manifest);bad[field]=value
        assert finish(c,bad,i)[0]['outcome']=='invalid_output'
    bad=copy.deepcopy(manifest);bad['output']['sha256']='0'*64
    assert finish(c,bad,3)[0]['outcome']=='invalid_output'
    good,sha=finish(c,manifest,4);assert good['outcome']=='succeeded'
    assert rpc('pd_graph_finalize',*ident(c),"'lost-reply'",lit(sha))['outcome']=='already_succeeded'
    badid=ident(c);badid[2]=lit(uuid.uuid4())
    assert rpc('pd_graph_finalize',*badid,"'stale'",lit(sha))['outcome']=='fenced'
    assert sql(f"SELECT count(*) FROM delphi_artifacts WHERE job_id={lit(c['job_id'])}")=='1'
    sql(f"UPDATE delphi_artifacts SET run_id={lit(uuid.uuid4())} WHERE job_id={lit(c['job_id'])}",ok=False)
    record('P08_P09_wrong_bindings_lost_finalize_ack_stale_owner_single_artifact')
    rpc('pd_graph_reconcile',"'proof'")
    # An uncommitted admitted graph is invisible to claims; after seal+commit
    # only its root may run and both dependency edges are already visible.
    s=spec();query=f"BEGIN;SET ROLE polis_queue_executor;SELECT pd_graph_admit('proof',1,'seal-race','first',{js(s)},NULL);SELECT pg_sleep(2);COMMIT;"
    proc=sp.Popen(C+['exec','-T','postgres','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',DB],stdin=sp.PIPE,stdout=sp.PIPE,stderr=sp.PIPE,text=True)
    proc.stdin.write(query);proc.stdin.close();time.sleep(.5)
    assert claim()['outcome']=='none'
    out=proc.stdout.read();err=proc.stderr.read();assert proc.wait()==0,err
    race=json.loads(next(l for l in out.splitlines() if l.startswith('{')));rn=nodes(race)
    c=claim();assert c['job_id']==rn['e']['job_id'];assert claim(stage='graph_cluster,graph_narrative')['outcome']=='none'
    # A closed edge cannot be removed, nor a late dependency appended.
    sql(f"DELETE FROM delphi_graph_edges WHERE consumer={lit(rn['c']['job_id'])}",ok=False)
    sql(f"UPDATE delphi_jobs SET parent_job_id={lit(rn['n']['job_id'])} WHERE job_id={lit(rn['e']['job_id'])}",ok=False)
    rpc('pq_fail',*ident(c),'true',"'negative-control'",'true')
    record('P07_seal_claim_race_and_late_mutation_refusal')
    # Durable provider intent, lost submission ACK, no duplicate execution.
    provider=graph('provider-unknown',only);c=claim();assert c['job_id']==nodes(provider)['e']['job_id']
    request=str(uuid.uuid4())
    rpc('pd_provider_intent',*ident(c),lit(request),"'local-provider-fixture'","decode(repeat('a',64),'hex')")
    rpc('pd_provider_update',*ident(c),lit(request),"'submission_unknown'",'NULL')
    parked=rpc('pq_fail',*ident(c),'false',"'lost_provider_ack'",'true');assert parked['state']=='parked'
    assert claim()['outcome']=='none'
    assert sql(f"SELECT count(*) FROM delphi_provider_requests WHERE job_id={lit(c['job_id'])}")=='1'
    record('P10_unknown_provider_intent_stays_parked_no_reclaim',job=c['job_id'])
    # Expired ownership with an unconfirmed child cannot gain another owner.
    stale=graph('stale-lease',only);c=claim();assert c['job_id']==nodes(stale)['e']['job_id']
    sql(f"UPDATE polis_queue_jobs SET locked_until=clock_timestamp()-interval '1 second' WHERE job_id={lit(c['job_id'])}")
    rpc('pq_reap',"'proof'",'NULL','100',"'delphi'")
    assert claim()['outcome']=='none'
    assert rpc('pd_graph_finalize',*ident(c),"'stale'",lit('0'*64))['outcome']=='fenced'
    record('P09_expired_lease_requires_exit_proof')
    assert rpc('pd_graph_served',"'proof'",'1',"'retry'")==served
    record('P12_old_served_bundle_survives_all_controls')

if __name__=='__main__':main()
