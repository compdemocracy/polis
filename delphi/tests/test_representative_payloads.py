"""Public-fixture source rows through extraction, manifest, plan and independent gate."""
import copy
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from polismath.replay import fixture_bundle as fb, fixture_extract as fx, fixture_samples as samples
from polismath.replay import fixture_selection as selection, fixture_survey as survey
from polismath.replay import event_ingress, schedule
from tests.test_representative_selection import configured, mock_snapshot, SEED
from tests.test_certify_bundle import _generate, _manifest, _selections

ROOT = Path(os.environ.get('POLIS_CHECKOUT_DIR', Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(ROOT / 'ci/private_cert/images'))
import gate
import probe

TIE = dict(available=False, columns=[], method='physical-ctid', order_by='created ASC, ctid ASC',
           guarantee='frozen-extract-order', note='public-fixture')


def raw_rows(n, *, tied=False, late=False):
    return dict(votes=[dict(created=1000 if tied else 1000+i, pid=i%3, tid=i%2,
                           vote=(-1,0,1)[i%3], weight_x_32767=None) for i in range(n)],
                comments=[dict(created=900, modified=(None if i else 5000) if late else 900,
                               pid=0, tid=i, mod=-1 if i else 0, is_meta=bool(i)) for i in range(2)],
                participants=[dict(pid=i, mod=0, created=900) for i in range(4)])


def metrics(raw):
    v=raw['votes'];p=len({r['pid'] for r in v});c=len({r['tid'] for r in v})
    return dict(P=p,V=len(v),C=c,U=len({(r['pid'],r['tid']) for r in v}),matrix_area=p*c,
                registered_participants=len(raw['participants']),all_comments=len(raw['comments']))


def extract_one(payload, root, raw, name, monkeypatch):
    monkeypatch.setattr(fx,'fetch_conversation',lambda *a:raw)
    return fx.extract_conversation(object(),zid=900000001,slug=name,role=name,
        payload_root=payload,guard_root=root,dir_name='opaque-'+name,tie_key=TIE,measured=metrics(raw))


def bundle(root, monkeypatch, n=20):
    """Old role metadata is the existing public-fixture admission factory's stub.

    Both old and sampled payloads are real extractor output, never production
    data. Tiny old-role bytes do not claim production predicate evidence.
    """
    config=configured();payload,generated=_generate(config,root)
    old=_selections(config,payload)
    for row in old:
        size=0 if row['role']==config['coverage_role_map']['pc-zerovote-01'] else 24
        new=extract_one(payload,root,raw_rows(size),row['slug'],monkeypatch)
        row['dir']=new['dir']
        # Remove the old factory's one-line stub, leaving no unused alias copy.
        stub=payload/('aaaaaaaaaaaaaaaa-'+row['slug']);(stub/'events.jsonl').unlink();stub.rmdir()
    sources={900000000+i:raw_rows(i,late=True,tied=True) for i in range(n)}
    selected=selection.select_representative([dict(zid=z,**metrics(raw)) for z,raw in sources.items()],SEED)
    rows=[]
    for chosen in selected.provenance:
        name=samples.slug(chosen['ordinal'])
        row=extract_one(payload,root,sources[chosen['zid']],name,monkeypatch)
        row.update(group='representative',rank=None,source='production');rows.append(row)
    cfg=json.dumps(config).encode()
    manifest=_manifest(config,payload,generated_summaries=generated,selections=old+rows,
                       config_bytes=cfg,representative_report=selected.report)
    fixture=payload.parent
    (fixture/'config.json').write_bytes(cfg);gate.dump(fixture/'manifest.json',manifest)
    return fixture,config,manifest


@pytest.mark.parametrize('n',[1,19,20,24])
def test_complete_sample_payload_census_and_manifest_version(tmp_path,monkeypatch,n):
    fixture,config,manifest=bundle(tmp_path,monkeypatch,n)
    assert manifest['schema_version']==samples.MANIFEST_VERSION
    fb.verify(fixture/'payload',manifest)
    fb.admit_manifest(manifest,config=config,config_bytes=(fixture/'config.json').read_bytes(),payload_root=fixture/'payload')
    assert len(samples.admitted_rules(manifest,config,fixture/'payload'))==min(20,n)
    with pytest.raises(fb.AdmissionError,match='requires payload_root'):
        fb.admit_manifest(manifest,config=config,config_bytes=(fixture/'config.json').read_bytes())


@pytest.mark.parametrize('mutation',['missing','duplicate','shared-dir','wrong-size','bad-seed','extra-report',
                                   'old-version','public-fixture','extra-role','missing-old-role','payload-count'])
def test_sample_manifest_refuses_omitted_or_substituted_obligations(tmp_path,monkeypatch,mutation):
    fixture,config,m=bundle(tmp_path,monkeypatch)
    row=next(r for r in m['roles'] if r['slug']=='sample-001')
    if mutation=='missing':m['roles'].remove(row)
    elif mutation=='duplicate':m['roles'].append(copy.deepcopy(row))
    elif mutation=='shared-dir':next(r for r in m['roles'] if r['slug']=='sample-002')['dir']=row['dir']
    elif mutation=='wrong-size':row['measured_metrics']['V']+=1
    elif mutation=='bad-seed':m['representative']['report']['seed']='02'*32
    elif mutation=='extra-report':m['representative']['report']['zid']='PUBLIC_FIXTURE_PRIVATE'
    elif mutation=='old-version':m['schema_version']='certify-fixture-manifest/3'
    elif mutation=='public-fixture':row['source']='public-fixture-replacement'
    elif mutation=='extra-role':m['roles'].append(dict(row,slug='sample-021'))
    elif mutation=='missing-old-role':m['roles'].pop(0)
    elif mutation=='payload-count':
        path=fixture/'payload'/row['dir']/'participants.csv'
        path.write_text(path.read_text()+'8,0,900\n')
    with pytest.raises(fb.AdmissionError):
        fb.admit_manifest(m,config=config,config_bytes=(fixture/'config.json').read_bytes(),payload_root=fixture/'payload')


@pytest.mark.parametrize('n',[0,1,2,3,5,6,7,19])
def test_ceiling_six_exact_full_stream_and_final_state_even_at_tied_times(tmp_path,monkeypatch,n):
    payload=tmp_path/'.local/payload';payload.mkdir(parents=True)
    row=extract_one(payload,tmp_path,raw_rows(n,tied=True,late=True),'sample-001',monkeypatch)
    ds=event_ingress.load_events(payload/row['dir']/'events.jsonl')
    spec=samples.resolved_spec('sample-001',ds);steps=schedule.slice_schedule(ds,spec)
    expected=sorted({(k*n+5)//6 for k in range(1,7)})
    assert [s.cut_slot for s in steps]==expected and steps[-1].cut_slot==n
    assert sum(len(s.vote_events) for s in steps)==n
    assert all(not s.mod_events for s in steps[:-1])
    assert [(m.t_ms,m.tid,m.mod,m.is_meta) for m in steps[-1].mod_events]==[(5000,0,0,False),(0,1,-1,True)]
    if not n:assert spec.empty_output=={'n':0,'n-cmts':0,'tids':[],'in-conv':[]}


def plan_bundle(tmp_path,monkeypatch):
    # Register restoration even when the variable started absent; the box
    # planner writes it directly as part of its process-local input binding.
    monkeypatch.setenv('POLIS_REPLAY_INPUT_MAP','')
    fixture,config,manifest=bundle(tmp_path,monkeypatch)
    inputs=dict(candidateSha='c'*40,oracleSha='d'*40,policySha256=gate.sha(gate.POLICY))
    prepared,inventory=probe.prepare_fixture_plan(fixture,config,manifest,tmp_path/'private',inputs)
    return fixture,inputs,prepared,inventory


def test_box_freezes_all_34_entries_and_verifier_rederives_full_inventory(tmp_path,monkeypatch):
    fixture,inputs,prepared,inventory=plan_bundle(tmp_path,monkeypatch)
    assert len(prepared)==34
    assert sum(p.entry.dataset.startswith('sample-') for p in prepared)==20
    assert inputs['expectedChecks']==sum(len(p.checkpoints) for p in prepared)
    assert [p.stream_end for p in prepared]==sorted(p.stream_end for p in prepared)
    mid=[i for i,p in enumerate(prepared) if p.entry.dataset=='pc-midmix-01']
    assert len(mid)==2 and mid[1]==mid[0]+1 and prepared[mid[0]].spec.restart_after is None
    scratch=tmp_path/'verify';scratch.mkdir()
    checked,inv=gate.prepare(fixture,inputs,scratch)
    assert inv==inventory and len(checked)==34
    assert not any('provenance' in p.name or 'census' in p.name for p in fixture.rglob('*'))


@pytest.mark.parametrize('mutation',['missing-sample','duplicate-sample','missing-old','missing-checkpoint',
                                   'truncated','moderation','old-schema','public-only','remapped'])
def test_independent_gate_refuses_incomplete_sample_plan(tmp_path,monkeypatch,mutation):
    fixture,inputs,_,_=plan_bundle(tmp_path,monkeypatch)
    plan=gate.read(fixture/'plan.json');row=next(r for r in plan['entries'] if r['dataset'].startswith('sample-') and r['schedule']['cuts']['at'][-1]>6)
    if mutation=='missing-sample':plan['entries'].remove(row)
    elif mutation=='duplicate-sample':plan['entries'].append(copy.deepcopy(row))
    elif mutation=='missing-old':plan['entries'].pop(0)
    elif mutation=='missing-checkpoint':row['schedule']['cuts']['at'].pop(0)
    elif mutation=='truncated':row['schedule']['cuts']['at'][-1]-=1
    elif mutation=='moderation':row['schedule']['moderation']='none'
    elif mutation=='old-schema':plan['schema']='polis-private-paired-plan/1'
    elif mutation=='public-only':plan['scope']='public'
    elif mutation=='remapped':row['directory']=plan['entries'][0]['directory']
    (fixture/'plan.json').write_bytes(gate.encoded(plan))
    scratch=tmp_path/'verify';scratch.mkdir()
    with pytest.raises(ValueError):gate.prepare(fixture,inputs,scratch,bind=False)


def test_whole_snapshot_extracts_overlap_once_but_keeps_each_role(tmp_path,monkeypatch):
    raws={900000000+i:raw_rows(i) for i in range(21)}
    rows=[dict(zid=z,**metrics(raw)) for z,raw in raws.items()]
    mock_snapshot(monkeypatch,rows)
    config=configured();selected=selection.select_representative(rows,SEED)
    zid=selected.provenance[0]['zid'];chosen=next(r for r in rows if r['zid']==zid)
    old=[SimpleNamespace(zid=zid,slug='old-a',role='old-a',group='edge',rank=None,metrics=chosen,n_candidates=21,overlaps_with=[]),
         SimpleNamespace(zid=zid,slug='old-b',role='old-b',group='edge',rank=None,metrics=chosen,n_candidates=21,overlaps_with=[])]
    monkeypatch.setattr(survey,'resolve_roles',lambda *a,**k:old)
    monkeypatch.setattr(survey,'coverage_report',lambda *a:{})
    monkeypatch.setattr(fx,'detect_tie_key',lambda *a:TIE)
    monkeypatch.setattr('polismath.replay.fixture_generate.write_all',lambda *a,**k:[])
    seen=[]
    def fetch(conn,z,tie):seen.append(z);return raws[z]
    monkeypatch.setattr(fx,'fetch_conversation',fetch)
    result=fx.extract_from_config(object(),config=config,payload_root=tmp_path/'.local/payload',guard_root=tmp_path)
    assert len(seen)==len(set(seen))==20
    assert len(result['roles'])==len(result['provenance_rows'])==22
    aliases=[r for r in result['roles'] if r['slug'] in ('old-a','old-b','sample-001')]
    assert len({r['dir'] for r in aliases})==1
    assert all('zid' not in row['measured_metrics'] for row in result['roles'])


def test_sample_bundle_cannot_use_legacy_public_pin_or_object_export(tmp_path,monkeypatch):
    fixture,config,manifest=bundle(tmp_path,monkeypatch)
    with pytest.raises(fb.BundleError,match='BOX_ONLY'):fb.public_pin(manifest)
    class NoStore:
        def __getattr__(self,name):pytest.fail('sample payload reached object store')
    with pytest.raises(fb.BundleError,match='BOX_ONLY'):
        fb.push(NoStore(),bundle_id=manifest['bundle_id'],payload_root=fixture/'payload',manifest=manifest,
                provenance={},admit=False)


@pytest.mark.parametrize('field',['zid','path','rank','topic','alias','blob'])
@pytest.mark.parametrize('level',['report','counts','cell','size'])
def test_receipt_selection_cannot_export_private_fields(field,level):
    from receipt import validate_selection
    report=selection.select_representative([dict(zid=900000001,**metrics(raw_rows(7)))],SEED).report
    validate_selection(report)
    target={'report':report,'counts':report['bucket_counts'],'cell':report['bucket_counts']['cells'][0],
            'size':report['chosen_entry_sizes'][0]}[level]
    target[field]='PUBLIC_FIXTURE_PRIVATE_VALUE'
    with pytest.raises(ValueError) as exc:validate_selection(report)
    assert 'PUBLIC_FIXTURE_PRIVATE_VALUE' not in str(exc.value)


@pytest.mark.parametrize('n',[1,19,20,25])
def test_box_receipt_preserves_exact_seed_and_closed_numeric_census(n):
    from receipt import validate_selection
    report=selection.select_representative([dict(zid=900000000+i,**metrics(raw_rows(i))) for i in range(n)],SEED).report
    assert validate_selection(report)==report


def test_private_payload_capacity_counts_unique_files_and_never_selects_a_subset():
    assert samples.payload_census({'files':[{'size':2},{'size':3}]})==dict(unique_payload_bytes=5,payload_files=2)
    with pytest.raises(selection.SelectionError,match='CAPACITY'):
        samples.payload_census({'files':[{'size':samples.MAX_PAYLOAD_BYTES+1}]})
    with pytest.raises(selection.SelectionError,match='CAPACITY'):
        samples.payload_census({'files':[{'size':0}]*(samples.MAX_PAYLOAD_FILES+1)})


@pytest.mark.parametrize('votes',[[],[(1000,1,1,1)]])
def test_sample_recipe_rejects_compatibility_input_including_empty(votes):
    from polismath.replay.types import ReplayDataset
    dataset=ReplayDataset.build(votes)
    with pytest.raises(selection.SelectionError,match='LOSSLESS'):
        samples.resolved_spec('sample-001',dataset)
    spec=schedule.ScheduleSpec('sample-001',samples.SCHEDULE_ID,
        {'mode':'vote-count','at':[len(votes)],'empty_checkpoint':True},moderation='source-final-state')
    with pytest.raises(ValueError,match='lossless'):
        schedule.slice_schedule(dataset,spec)
