#!/usr/bin/env python3
"""M28 real-Postgres negative controls, on the graph proof's local database."""
import hashlib
import json
import sys
import uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from polismath.delphi_storage.postgres import family_files
from polismath.delphi_storage.codec import encode_family,item_from_python
from prove import graph, spec, nodes, rpc, sql, lit, js, record
from adversarial import claim, ident, finish

FAMILY = 'Delphi_CommentEmbeddings'


def row(value='first'):
    return dict(conversation_id='1', comment_id=0, text=value, embedding=[])


def make_manifest(c, payload):
    wire=json.dumps(payload, sort_keys=True, separators=(',', ':'))
    return dict(schema='polis-job-artifact-manifest/1', job_id=c['job_id'],run_id=c['run_id'],
                attempt_id=c['attempt_id'],stage=c['stage'],input_sha256=c['graph_input_sha'],
                outcome='succeeded',output=dict(role='result',schema=c['stage']+'/1',payload=wire,
                sha256=hashlib.sha256(wire.encode()).hexdigest()))


def main():
    sql("INSERT INTO users(uid,hname) VALUES(1,'generated result owner') ON CONFLICT DO NOTHING; INSERT INTO conversations(zid,owner,topic) VALUES(1,1,'generated result proof') ON CONFLICT DO NOTHING")
    scope='result-proof-'+uuid.uuid4().hex[:8]
    publish_scope='result-publish-'+uuid.uuid4().hex[:8]
    single=spec();single['nodes']=single['nodes'][:1]
    g=graph(scope,single)
    c=claim();assert c['job_id']==nodes(g)['e']['job_id']
    wire=family_files({FAMILY:[row()]})[FAMILY]
    put=lambda token, data: rpc('pd_result_put_family',*token,lit(FAMILY),lit(data))
    invalid = wire.replace('"text":{"S":"first"}', '"text":{"N":"01"}')
    assert 'invalid result row' in sql('SELECT pd_result_put_family('+','.join([*ident(c),lit(FAMILY),lit(invalid)])+')',True,False)
    wrong_zid = family_files({FAMILY:[{**row(),'conversation_id':'2'}]})[FAMILY]
    assert 'conversation mismatch' in sql('SELECT pd_result_put_family('+','.join([*ident(c),lit(FAMILY),lit(wrong_zid)])+')',True,False)
    written=put(ident(c),wire)
    assert written['row_count']==1 and put(ident(c),wire)==written
    bad=ident(c);bad[2]=lit(uuid.uuid4())
    denied=sql('SELECT pd_result_put_family('+','.join([*bad,lit(FAMILY),lit(wire)])+')',True,False)
    assert 'fenced' in denied
    changed=family_files({FAMILY:[row('different')]})[FAMILY]
    assert 'conflict' in sql('SELECT pd_result_put_family('+','.join([*ident(c),lit(FAMILY),lit(changed)])+')',True,False)
    record('R01_result_fencing_idempotence_conflict')
    ref=rpc('pd_result_seal',*ident(c))
    assert ref==rpc('pd_result_seal',*ident(c))
    assert sql(f"SELECT count(*) FROM delphi_result_current_rows WHERE env='proof' AND scope_key={lit(scope)}",True)=='0'
    rpc('pq_end_attempt',*ident(c),"'confirm_exit'",'NULL','true')
    badref={**ref,'sha256':'0'*64}
    invalid=make_manifest(c,{'results':badref})
    raw=json.dumps(invalid,sort_keys=True,separators=(',',':')); sha=hashlib.sha256(raw.encode()).hexdigest()
    sql(f"INSERT INTO polis_queue_logs(env,attempt_id,seq,stream,line) VALUES('proof',{lit(c['attempt_id'])},0,'manifest',{lit(raw)})",True)
    assert 'binding' in sql('SELECT pd_graph_finalize('+','.join([*ident(c),"'unused'",lit(sha)])+')',True,False)
    assert sql(f"SELECT count(*) FROM delphi_artifacts WHERE job_id={lit(c['job_id'])}")=='0'
    reply,_=finish(c,make_manifest(c,{'results':ref}),1);assert reply['outcome']=='succeeded'
    aid=nodes(g)['e']['artifact']['artifact_id']
    exact=rpc('pd_result_artifact_wire',"'proof'",lit(aid),lit(FAMILY))
    assert exact['wire']==wire and exact['sha256']==written['sha256'] and exact['batch_sha256']==ref['sha256']
    read=rpc('pd_result_artifact_family',"'proof'",lit(aid),lit(FAMILY))
    assert read[0]['text']=={'S':'first'} and len(read)==1
    assert rpc('pd_result_artifact_family',"'other-environment'",lit(aid),lit(FAMILY))==[]
    record('R02_manifest_binding_atomic_rollback_and_environment_isolation')
    sql(f"UPDATE delphi_result_rows SET item='{{}}' WHERE batch_id={lit(c['attempt_id'])}",ok=False)
    sql(f"DELETE FROM delphi_result_families WHERE batch_id={lit(c['attempt_id'])}",ok=False)
    sql('SELECT * FROM delphi_result_rows',True,False)
    record('R03_results_immutable_and_base_tables_denied')
    # Build a real three-node graph with inline rows, then publish via the existing CAS.
    graph2=graph(publish_scope,spec())
    for stage in ['graph_embed','graph_cluster','graph_narrative']:
        token=claim(stage=stage)
        assert token['job_id'] in {x['job_id'] for x in nodes(graph2).values()}
        rpc('pq_end_attempt',*ident(token),"'confirm_exit'",'NULL','true')
        payload={'family_files':family_files({FAMILY:[] if stage=='graph_narrative' else [row(stage)]})}
        if stage=='graph_narrative':
            archived_wire=encode_family('Delphi_JobQueue',[item_from_python(dict(job_id='generated-legacy',conversation_id='1',logs='before\0after',status='PROCESSING'))]).decode()
            payload['legacy_control_files']={'Delphi_JobQueue':archived_wire}
        assert finish(token,make_manifest(token,payload),0)[0]['outcome']=='succeeded'
    assert sql(f"SELECT pd_result_served_bundle('proof',1,{lit(publish_scope)}) IS NULL",True)=='t'
    n=nodes(graph2)['n']
    assert rpc('pd_graph_publish',"'proof'",lit(graph2['graph_id']),lit(n['job_id']),'0')['outcome']=='published'
    bundle=rpc('pd_result_served_bundle',"'proof'",'1',lit(publish_scope))
    assert bundle=={'generation':1,'families':{}} or bundle=={'generation':1,'families':{FAMILY:[]}}
    # Explicit empty root family shadows ancestor rows; no stale rows resurface.
    assert rpc('pd_result_served',"'proof'",'1',lit(publish_scope),lit(FAMILY))==[]
    assert rpc('pd_graph_publish',"'proof'",lit(graph2['graph_id']),lit(n['job_id']),'0')['outcome']=='conflict'
    record('R04_coherent_publication_CAS_and_explicit_empty_shadows_old_rows')
    archived=json.loads(sql(f"SELECT row_to_json(c) FROM delphi_result_legacy_controls c WHERE env='proof' AND scope_key={lit(publish_scope)}",True))
    assert archived['codec_wire']==archived_wire and archived['family']=='Delphi_JobQueue'
    assert sql(f"SELECT job_id FROM delphi_result_publications WHERE env='proof' AND scope_key={lit(publish_scope)}",True)==n['job_id']
    assert sql("SELECT count(*) FROM delphi_result_jobs WHERE job_id='generated-legacy'",True)=='0'
    record('R05_legacy_control_wire_NUL_and_published_root_metadata_without_activation')
    # M29 extends actual stage models, but must not restore deferred graph features.
    rejected_scope='result-deferred-'+uuid.uuid4().hex[:8]
    assert 'superseding dead branches is not supported' in graph(
        rejected_scope,spec(),sup=graph2['graph_id'],ok=False)
    assert sql(f"SELECT count(*) FROM delphi_graphs WHERE env='proof' AND scope_key={lit(rejected_scope)}")=='0'
    assert sql("""SELECT to_regclass('public.delphi_graph_breakers') IS NULL
        AND to_regclass('public.delphi_graph_provider_resolutions') IS NULL
        AND to_regprocedure('public.pd_graph_breaker_event()') IS NULL
        AND to_regprocedure('public.pd_graph_resolve_provider(text,uuid,text,text,jsonb)') IS NULL""")=='t'
    assert rpc('pd_result_served_bundle',"'proof'",'1',lit(publish_scope))==bundle
    record('R06_deferred_features_absent_and_superseding_admission_refused_after_M29')


if __name__=='__main__':
    main()
