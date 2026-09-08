import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
import pytest
from coordinator.conftest import ROOT, ARTIFACTS, FOLD, MAPPING, seed, connect, rows, assert_coherent
from polismath.replay.crosslang import canonicalize_blob


def canonical(tables):
    result={}
    for table in ("math_main","math_bidtopid","math_ptptstats"):
        blob=dict(tables[table]["data"])
        if table=="math_main":blob.pop("math_tick",None) # declared engine wall-clock metadata
        result[table]=canonicalize_blob(blob) if table=="math_main" else blob
    return result


def hash_blob(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()


def diff(a,b,path=""):
    out=[]
    if isinstance(a,dict) and isinstance(b,dict):
        for key in sorted(a.keys()|b.keys()):
            if key not in a or key not in b:out.append(dict(path=path+'/'+key,a=a.get(key),b=b.get(key)))
            else:out.extend(diff(a[key],b[key],path+'/'+key))
    elif isinstance(a,list) and isinstance(b,list) and len(a)==len(b):
        for i,(x,y) in enumerate(zip(a,b)):out.extend(diff(x,y,path+'/'+str(i)))
    elif a!=b:out.append(dict(path=path,a=a,b=b))
    return out


@pytest.mark.parametrize("fixture",["synthetic","vw","biodiversity"])
def test_polarity_through_actual_database_ingress(db,launch,fixture):
    if fixture=="synthetic":seed(db)
    else:seed_vw(db,slug=fixture)
    launch(db).done()
    a=canonical(rows(db))
    c=connect(db)
    with c.cursor() as cur:cur.execute("UPDATE votes SET vote=-vote")
    c.close()
    launch(db,env="positive",extra={"STORAGE_AGREE_VALUE":"1"}).done()
    b=canonical(rows(db,env="positive"))
    launch(db,env="negative").done()
    negative=canonical(rows(db,env="negative"))
    delta=diff(a,b)
    (ARTIFACTS/f"polarity-{fixture}.json").write_text(json.dumps({"fixture":fixture,"a":hash_blob(a),"b":hash_blob(b),"negative":hash_blob(negative),"deltas":delta},indent=2))
    assert delta==[]
    assert hash_blob(a)==hash_blob(b)
    assert hash_blob(a)!=hash_blob(negative)


def vw_events(slug="vw"):
    from polismath.replay.real_data import load_export_votes
    return load_export_votes(slug).votes


def seed_vw(db,limit=None,slug="vw"):
    events=vw_events(slug)
    pids=sorted({v.pid for v in events});tids=sorted({v.tid for v in events})
    seed(db,n_ptpts=0,n_cmts=0,votes=False)
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("SET session_replication_role=replica")
        for p in pids:cur.execute("INSERT INTO participants(zid,pid,uid,mod) VALUES(1,%s,%s,0)",(p,100000+p))
        for t in tids:cur.execute("INSERT INTO comments(zid,tid,pid,uid,txt,mod,is_meta,created,modified) VALUES(1,%s,0,100000,%s,0,false,1000,1000)",(t,f'Synthetic comment {t}'))
    c.close()
    insert_events(db,events[:limit] if limit is not None else events)
    return events


def insert_events(db,events):
    c=connect(db)
    with c.cursor() as cur:
        cur.executemany("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,%s,%s,%s,%s)",[(v.pid,v.tid,-v.sign,v.t_ms) for v in events])
    c.close()


def python_checkpoint(db):
    env=dict(os.environ,DATABASE_URL=db,PYTHONPATH=str(ROOT/'delphi'),MATH_ENV='python',MATH_PYTHON_ENV='python',
             OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1')
    r=subprocess.run([sys.executable,str(Path(__file__).with_name('reference_child.py'))],env=env,cwd=ROOT/'delphi',capture_output=True,text=True,timeout=150)
    assert r.returncode==0,(r.stdout,r.stderr)


def test_vw_dual_namespace_live_equivalence(db,launch):
    events=seed_vw(db,0)
    cuts=[len(events)//4,len(events)//2,len(events)]
    inventory=[];previous=0;observer_errors=[];observations=[0];stop=threading.Event()
    def observer():
        while not stop.is_set():
            for env in ('python','rustproto'):
                snapshot=rows(db,env=env)
                if snapshot['math_main']:
                    if any(snapshot[t] is None for t in snapshot):observer_errors.append('missing table');continue
                    if len({r['math_tick'] for r in snapshot.values()})!=1:observer_errors.append('mixed ticks')
                    a,b,p=[snapshot[t]['data'] for t in ('math_main','math_bidtopid','math_ptptstats')]
                    observer_errors.extend(MAPPING(a,b,p));observations[0]+=1
            stop.wait(.02)
    thread=threading.Thread(target=observer);thread.start()
    try:
        for cut in cuts:
            insert_events(db,events[previous:cut]);previous=cut
            # Both actual processes operate against one visibility checkpoint.
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                reference=pool.submit(python_checkpoint,db)
                launch(db).done();reference.result()
            a=rows(db);b=rows(db,env='python')
            assert a['math_main']['math_tick']==b['math_main']['math_tick']
            ca,cb=canonical(a),canonical(b)
            deltas=diff(ca,cb)
            fold=FOLD.fold_votes([dict(pid=v.pid,tid=v.tid,vote=-v.sign,created=v.t_ms) for v in events[:cut]])
            fold_errors={env:FOLD.check_published_against_fold(t['math_main']['data'],fold,require_all_clustered=False) for env,t in [('rustproto',a),('python',b)]}
            clustered={env:{pid for bucket in t['math_bidtopid']['data']['bidToPid'] for pid in bucket} for env,t in [('rustproto',a),('python',b)]}
            for env,tables in [('rustproto',a),('python',b)]:
                main=tables['math_main']['data']
                for index,members in enumerate(tables['math_bidtopid']['data']['bidToPid']):
                    member_set=set(members)
                    subset=FOLD.fold_votes([dict(pid=v.pid,tid=v.tid,vote=-v.sign,created=v.t_ms) for v in events[:cut] if v.pid in member_set])
                    totals=subset.per_comment_totals()
                    for tid,buckets in main['votes-base'].items():
                        expected=totals.get(int(tid),{'A':0,'D':0,'S':0})
                        actual={key:buckets[key][index] for key in ('A','D','S')}
                        if actual!=expected:fold_errors[env].append(dict(tid=tid,bucket=index,actual=actual,expected=expected))
            inventory.append(dict(cut=cut,tick=a['math_main']['math_tick'],rust=hash_blob(ca),python=hash_blob(cb),deltas=deltas,fold_errors=fold_errors,
                unclustered_participants={env:len(fold.participants-members) for env,members in clustered.items()},
                fold_scope='all-voter counts/timestamps/events plus independent latest-cell A/D/S per emitted bucket; no independent eligibility certificate'))
    finally:
        stop.set();thread.join()
        (ARTIFACTS/'vw-equivalence.json').write_text(json.dumps(dict(checkpoints=inventory,observer_errors=observer_errors,observations=observations[0],profile='rebuild-prefix at each checkpoint; static unmoderated comment snapshot'),indent=2))
    assert not observer_errors
    assert len(inventory)==3
    assert all(not x['deltas'] for x in inventory)
    assert all(not e for x in inventory for e in x['fold_errors'].values())


def test_polarity_rebuild_schedule_with_revotes(db,launch):
    seed(db,votes=False)
    def write(sign,events):
        c=connect(db)
        with c.cursor() as cur:
            cur.execute('DELETE FROM votes WHERE zid=1')
            cur.executemany('INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,%s,%s,%s,%s)',[(p,t,v*sign,stamp) for p,t,v,stamp in events])
        c.close()
    events=[(p,t,(-1 if p%2==0 else 1),1000+p*4+t) for p in range(6) for t in range(4)]
    variants=[]
    for step in range(3):
        if step:events.append((0,0,step-1,2000+step))
        write(1,events);launch(db).done();a=canonical(rows(db))
        write(-1,events);launch(db,env='positive',extra={'STORAGE_AGREE_VALUE':'1'}).done();b=canonical(rows(db,env='positive'))
        launch(db,env='negative').done();n=canonical(rows(db,env='negative'))
        assert hash_blob(a)==hash_blob(b)
        assert hash_blob(a)!=hash_blob(n)
        variants.append(dict(step=step,positive=hash_blob(a),paired=hash_blob(b),negative=hash_blob(n)))
    (ARTIFACTS/'polarity-rebuild-schedule.json').write_text(json.dumps(variants,indent=2))


def test_semantic_tie_key_is_a_declared_contract_term(db,launch):
    """Rev5 item 1. Two vote rows share (tid,pid,created) and differ only in the
    raw sign, so the published generation is decided by the trailing tie term.
    Ordering on the semantic vote (raw x storage_agree_value) keeps the mirrored
    conversation identical; ordering on the raw sign would reverse that pair and
    break the polarity property. The declaration and its census are recorded."""
    seed(db)
    c=connect(db)
    with c.cursor() as cur:
        cur.execute('SET session_replication_role=replica')
        cur.execute('DELETE FROM votes WHERE zid=1 AND pid=0 AND tid=0')
        for value in (1,-1):
            cur.execute('INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,%s,1500)',(value,))
    c.close()
    launch(db).done()
    a=canonical(rows(db))
    declared=rows(db)['math_ticks']['input_checkpoint']['ordering']
    assert declared['schema']=='polis-order/1'
    assert declared['semantic_vote']=='raw_vote * storage_agree_value'
    assert declared['storage_agree_value']==-1 and declared['algorithm_digest']
    assert [t['name'] for t in declared['terms']]==['tid','pid','created_ms','semantic_vote','weight_x_32767']
    assert declared['terms'][-1]['nulls']=='first'
    census=declared['equal_time_census']
    assert census['tied_groups']==1 and census['tied_rows']==2
    assert census['key']==['tid','pid','created_ms']
    assert census['resolved_by']==['semantic_vote','weight_x_32767']
    c=connect(db)
    with c.cursor() as cur:cur.execute('UPDATE votes SET vote=-vote WHERE zid=1')
    c.close()
    launch(db,env='positive',extra={'STORAGE_AGREE_VALUE':'1'}).done()
    b=canonical(rows(db,env='positive'))
    launch(db,env='negative').done()
    negative=canonical(rows(db,env='negative'))
    mirrored=rows(db,env='positive')['math_ticks']['input_checkpoint']['ordering']
    assert mirrored['storage_agree_value']==1
    # The pinned ordering algorithm is polarity-bound, so the two conventions
    # cannot silently share one declaration.
    assert mirrored['algorithm_digest']!=declared['algorithm_digest']
    assert mirrored['equal_time_census']==census
    (ARTIFACTS/'semantic-tie-key.json').write_text(json.dumps(dict(
        declared=declared,mirrored_digest=mirrored['algorithm_digest'],
        a=hash_blob(a),b=hash_blob(b),negative=hash_blob(negative),deltas=diff(a,b)),indent=2))
    assert diff(a,b)==[]
    assert hash_blob(a)==hash_blob(b)
    assert hash_blob(a)!=hash_blob(negative)
