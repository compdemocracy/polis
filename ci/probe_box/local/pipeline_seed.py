"""Public conversation population for the real survey/extract worker path."""
from __future__ import annotations
import copy
import csv
import hashlib
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[3]
BASE_MS=1704067200000


def exported(alias):
    root=next((ROOT/'delphi/real_data').glob('*-'+alias))
    path=next(root.glob('*votes.csv'))
    with path.open(newline='') as stream:
        rows=list(csv.DictReader(stream))
    # Rebase public CSV identities/timestamps to local fixture coordinates;
    # preserve relative row order and raw storage sign (CSV sign is opposite).
    pids={n:i for i,n in enumerate(sorted({int(r['voter-id']) for r in rows}))}
    tids={n:i for i,n in enumerate(sorted({int(r['comment-id']) for r in rows}))}
    votes=[dict(pid=pids[int(r['voter-id'])],tid=tids[int(r['comment-id'])],
                vote=-int(r['vote']),weight_x_32767=0,created=BASE_MS+i+1000)
           for i,r in enumerate(rows)]
    comments=[dict(tid=t,pid=0,created=BASE_MS+t,modified=BASE_MS+t,mod=0,is_meta=False) for t in tids.values()]
    participants=[dict(pid=p,mod=0,created=BASE_MS+p) for p in pids.values()]
    return (votes,comments,participants),{'alias':alias,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'votes':len(votes)}


def population(*, dense=True):
    sys.path.insert(0,str(ROOT/'delphi'))
    from polismath.replay.fixture_generate import build_case_rows,case_rng
    config=json.loads((ROOT/'delphi/scripts/certify_datasets.probe.json').read_bytes())
    vw,vw_source=exported('vw');bio,bio_source=exported('biodiversity')
    rows=[]
    def add(label,data):rows.append((len(rows)+1,label,copy.deepcopy(data)))
    add('public-small',vw);add('public-mid',bio)
    revote=copy.deepcopy(vw)
    revote[0].extend({**v,'created':v['created']+len(vw[0])} for v in vw[0])
    add('public-revote',revote)
    banned=copy.deepcopy(vw);banned[2][0]['mod']=-1;add('public-banned',banned)
    add('public-empty',([],[dict(tid=0,pid=0,created=BASE_MS,modified=BASE_MS,mod=0,is_meta=False)],
                       [dict(pid=0,mod=0,created=BASE_MS)]))
    for label,field,fraction in [('public-moderated','mod',3),('public-meta-cold','is_meta',3),('public-meta-warm','is_meta',7)]:
        data=copy.deepcopy(vw)
        for i,c in enumerate(data[1]):
            if i%fraction==0:c[field]=-1 if field=='mod' else True
        add(label,data)
    # V>=50k and sixteen distinct candidates are required by the largest rank.
    # Copy the complete public event stream twice; duplicates remain real revotes.
    for i in range(16):
        large=copy.deepcopy(bio)
        large[0].extend({**v,'created':v['created']+len(bio[0])} for v in bio[0])
        add('public-large-'+str(i+1),large)
    generated=config['generated']
    case=next(c for c in generated['cases'] if c['id']=='gen-v1-ptpt-10000')
    add('public-participant-boundary',build_case_rows(case,case_rng(generated,case['id'])))
    if dense:
        case=next(c for c in generated['cases'] if c['id']=='gen-v1-dense-stress')
        add('public-dense-boundary',build_case_rows(case,case_rng(generated,case['id'])))
    return rows,{'schema':'polis-public-pipeline-seed/1','database_origin':'PUBLIC_FIXTURE_ONLY','sources':[vw_source,bio_source],
        'derived':'public row order/sign retained; local IDs/timeline and declared flag/revote variants',
        'generated_cases':['gen-v1-ptpt-10000']+(['gen-v1-dense-stress'] if dense else []),'conversations':len(rows),'votes':sum(len(data[0]) for _,_,data in rows),
        'dense_replacements':config['accepted_public_fixture_replacements']}


def measured(data,zid):
    from polismath.replay.fixture_survey import derive_metrics
    votes,comments,participants=data
    eligible={r['tid'] for r in comments if r['mod']!=-1 and not r['is_meta']}
    banned={r['pid'] for r in participants if r['mod']==-1}
    return derive_metrics(dict(zid=zid,v_events=len(votes),u_cells=len({(v['pid'],v['tid']) for v in votes}),
        p_voters=len({v['pid'] for v in votes}),c_voted_comments=len({v['tid'] for v in votes}),
        registered_participants=len(participants),all_comments=len(comments),
        mod_out_comments=sum(c['mod']==-1 for c in comments),meta_comments=sum(c['is_meta'] for c in comments),
        math_eligible_comments=len(eligible),mod_out_or_meta_comments=sum(c['mod']==-1 or c['is_meta'] for c in comments),
        eligible_participants=len({v['pid'] for v in votes if v['tid'] in eligible}),
        banned_voters=len({v['pid'] for v in votes if v['pid'] in banned})))


def build(output, *, dense=True):
    sys.path.insert(0,str(ROOT/'delphi'))
    from polismath.replay.fixture_survey import coverage_report,resolve_roles
    rows,report=population(dense=dense)
    config=json.loads((ROOT/'delphi/scripts/certify_datasets.probe.json').read_bytes())
    metrics=[measured(data,zid) for zid,_,data in rows]
    coverage=coverage_report(config,metrics)
    selections=resolve_roles(config,metrics,accept_public_fixture=config['accepted_public_fixture_replacements'])
    report['roles']=[{'slug':r.slug,'source':'GENERATED_REPLACEMENT' if r.zid is None else 'PUBLIC_DATABASE',
                      'replacement':r.public_fixture_replacement,'candidates':r.n_candidates} for r in selections]
    report['coverage']=coverage
    sql=output/'pipeline-seed.sql'
    with sql.open('w') as stream:
        stream.write('BEGIN;\n')
        # The unchanged initial migration supplies the real source column types,
        # constraints and physical no-key vote order. Only ID-allocating USER
        # triggers are disabled while loading explicit fixture coordinates.
        stream.write((ROOT/'server/postgres/migrations/000000_initial.sql').read_text())
        stream.write('\nALTER TABLE participants DISABLE TRIGGER USER;\nALTER TABLE comments DISABLE TRIGGER USER;\n')
        max_pid=max(p['pid'] for _,_,(_,_,ps) in rows for p in ps)
        stream.write(f'INSERT INTO users(uid) SELECT generate_series(1,{max_pid+1});\n')
        def copy_rows(table,columns,values):
            stream.write('COPY '+table+' ('+','.join(columns)+') FROM STDIN WITH (FORMAT csv);\n')
            writer=csv.writer(stream,lineterminator='\n')
            writer.writerows(values);stream.write('\\.\n')
        copy_rows('conversations',['zid','owner','created'],[(zid,1,BASE_MS) for zid,_,_ in rows])
        copy_rows('participants',['zid','pid','uid','mod','created'],
                  ((zid,p['pid'],p['pid']+1,p['mod'],p['created']) for zid,_,(_,_,ps) in rows for p in ps))
        copy_rows('comments',['zid','tid','pid','uid','txt','created','modified','mod','is_meta'],
                  ((zid,c['tid'],0,1,'public comment '+str(c['tid']),c['created'],c['modified'],c['mod'],str(c['is_meta']).lower()) for zid,_,(_,cs,_) in rows for c in cs))
        copy_rows('votes',['zid','pid','tid','vote','weight_x_32767','created'],
                  ((zid,v['pid'],v['tid'],v['vote'],v['weight_x_32767'],v['created']) for zid,_,(vs,_,_) in rows for v in vs))
        stream.write('ALTER TABLE participants ENABLE TRIGGER USER;\nALTER TABLE comments ENABLE TRIGGER USER;\n')
        stream.write('COMMIT;\nANALYZE;\n')
    report['sql_sha256']=hashlib.sha256(sql.read_bytes()).hexdigest()
    (output/'pipeline-seed.json').write_text(json.dumps(report,indent=2)+'\n')
    return sql
