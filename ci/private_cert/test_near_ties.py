import copy
import json
import sys
from pathlib import Path
sys.path[:0]=[str(Path(__file__).parent/'images'),str(Path(__file__).parents[2]/'delphi')]
import pytest
import near_ties
from polismath.replay import decision_ties


def doc(selected='a',scores=(1.,1.+1e-8)):
    return dict(schema='polis-decision-trace/1',complete=True,checkpoint=0,record_sha256='0'*64,outcomes=[],events=[dict(
        scope='base',call=1,cluster_bound=2,kind='min-last',subject='0',candidates=['a','b'],
        scores=list(scores),selected=selected,threshold=None)])


def test_tie_is_named_at_its_checkpoint():
    assert near_ties.first_tie(doc(),doc('b',(1.+1e-8,1.)),0)==dict(
        checkpoint=0,name='accepted-tie-cluster-assignment',scope='base')


@pytest.mark.parametrize('field,value',[('complete',False),('checkpoint',True),('schema','other'),('events',None)])
def test_missing_or_bad_evidence_cannot_grant(field,value):
    a=doc();a[field]=value
    with pytest.raises(ValueError):near_ties.first_tie(a,doc(),0)


def test_earlier_non_tolerant_quantity_prevents_later_tie():
    a,b=doc(),doc('b',(1.+1e-8,1.))
    prefix=copy.deepcopy(a['events'][0]);prefix['scores']=[2.,3.]
    a['events'].insert(0,prefix)
    other=copy.deepcopy(prefix);other['scores']=[4.,5.]
    b['events'].insert(0,other)
    assert near_ties.first_tie(a,b,0) is None


@pytest.mark.parametrize('field,value',[('subject','1'),('call',2),('cluster_bound',3),('scope','group')])
def test_changed_decision_context_is_not_a_tie(field,value):
    a,b=doc(),doc('b',(1.+1e-8,1.));b['events'][0][field]=value
    assert near_ties.first_tie(a,b,0) is None


def test_unchanged_choices_do_not_create_an_exception():
    assert near_ties.first_tie(doc(),doc(),0) is None


def test_wrong_winner_is_not_a_tie():
    with pytest.raises(ValueError,match='CHOICE'):
        near_ties.first_tie(doc(),doc('b'),0)


def test_non_tie_valid_change_is_refused():
    assert near_ties.first_tie(doc(),doc('b',(4.,1.)),0) is None


@pytest.mark.parametrize('scope,covered',[('base',True),('group',False)])
def test_scope_keeps_pca_counts_and_unknown_fields(scope,covered):
    left={'pca':{'center':[1.],'comps':[[2.]]},'n':10,'base-clusters':{'id':[0]},
          'group-votes':{'0':{}},'unknown':1}
    right={'pca':{'center':[2.],'comps':[[3.]]},'n':11,'base-clusters':{'id':[1]},
           'group-votes':{'1':{}},'unknown':2}
    original=copy.deepcopy(right)
    _,r=decision_ties.reconcile(left,right,dict(scope=scope))
    assert r['pca']==right['pca'] and r['n']==11 and r['unknown']==2
    assert (r['base-clusters']==left['base-clusters'])==covered
    assert r['group-votes']==left['group-votes'] and right==original


def test_onset_is_forward_and_not_bool():
    assert not decision_ties.active(0,dict(checkpoint=1,scope='base'))
    assert decision_ties.active(1,dict(checkpoint=1,scope='base'))
    assert not decision_ties.active(1,dict(checkpoint=True,scope='base'))


def test_source_closure_contains_both_observers_and_classifier():
    import gate,recipe
    files=recipe.source_files(gate.REPO)
    assert {'math/dev/tie_observer.clj','ci/private_cert/images/near_ties.py',
            'delphi/polismath/replay/tie_capture.py','delphi/polismath/replay/decision_ties.py'}<=set(files)


@pytest.mark.parametrize('engine', ['clj', 'py'])
@pytest.mark.parametrize('value', [None, [], 1, True, 'invalid'])
def test_non_object_sidecar_does_not_abort_verification(tmp_path, engine, value):
    for name in ('clj', 'py'):
        directory = tmp_path / (name + '-decisions')
        directory.mkdir()
        (directory / 'step-000.json').write_text(json.dumps(value if name == engine else doc()))
    observations = [dict(checkpoint=0, folded_matrix='equal',
                         moderated_matrix='equal', person_projection='pass')]
    assert near_ties.measure_recording(tmp_path, observations) is None


def test_nearest_identity_flip_alone_never_grants_tie():
    a,b=doc(),doc('b',(1.+1e-8,1.))
    for d in (a,b):d['events'][0]['subject']='distal-nearest:0'
    assert near_ties.first_tie(a,b,0) is None
    # Keep looking: the ignored identity must not hide a later real choice.
    a['events'].append(doc()['events'][0])
    b['events'].append(doc('b',(1.+1e-8,1.))['events'][0])
    assert near_ties.first_tie(a,b,0)['name']=='accepted-tie-cluster-assignment'
    a['events'][0]['scores']=[1.,10.]
    assert near_ties.first_tie(a,b,0) is None


def recording(tmp_path):
    import hashlib
    blob={'base-clusters':{'id':[0], 'members':[[0,1]]},
          'group-clusters':[{'id':0,'members':[0]}]}
    for engine,d in [('clj',doc()),('py',doc('b',(1.+1e-8,1.)))]:
        d['outcomes']=[dict(scope='base',call=1,clusters=[dict(id='0',members=['0','1'])]),
                       dict(scope='group',call=2,clusters=[dict(id='0',members=['0'])])]
        (tmp_path/engine).mkdir()
        raw=json.dumps(blob if engine=='clj' else {'blob':blob}).encode()
        name='step-000.blob.json' if engine=='clj' else 'step-000.json'
        (tmp_path/engine/name).write_bytes(raw)
        d['record_sha256']=hashlib.sha256(raw).hexdigest()
        (tmp_path/(engine+'-decisions')).mkdir()
        (tmp_path/(engine+'-decisions')/'step-000.json').write_text(json.dumps(d))
    return [dict(checkpoint=0,folded_matrix='equal',moderated_matrix='equal',person_projection='pass')]


@pytest.mark.parametrize('fault',['stale','missing','assignments','outcomes','incomplete'])
@pytest.mark.parametrize('engine',['clj','py'])
def test_uncorroborated_evidence_cannot_grant(tmp_path,fault,engine):
    observations=recording(tmp_path)
    assert near_ties.measure_recording(tmp_path,observations,accept_tie=lambda t:True)
    path=tmp_path/(engine+'-decisions')/'step-000.json'; d=json.loads(path.read_text())
    if fault=='missing':path.unlink()
    else:
        if fault=='stale':d['record_sha256']='0'*64
        if fault=='assignments':d['outcomes'][0]['clusters'][0]['members']=['99']
        if fault=='outcomes':d['outcomes']=[]
        if fault=='incomplete':d['complete']=False
        path.write_text(json.dumps(d))
    assert near_ties.measure_recording(tmp_path,observations,accept_tie=lambda t:True) is None


def test_no_effect_or_no_effect_check_cannot_grant(tmp_path):
    observations=recording(tmp_path)
    assert near_ties.measure_recording(tmp_path,observations) is None
    assert near_ties.measure_recording(tmp_path,observations,accept_tie=lambda t:False) is None


@pytest.mark.parametrize('subject',['unknown','distal-ignored','split-ignored'])
def test_unknown_decision_cannot_grant(subject):
    a=doc();a['events'][0]['subject']=subject
    with pytest.raises(ValueError,match='SUBJECT'):near_ties.first_tie(a,doc(),0)


SPLIT={'id':[0,1],'members':[[0,1],[2]],'count':[2,1],'x':[0.,1.],'y':[0.,1.]}
GROUPS=[{'id':0,'members':[0],'center':[1.,1.]}]


@pytest.mark.parametrize('changes,scope,onset,accepted',[
    ([], 'base', None, False),
    ([('repness',{'0':[{'tid':0,'p':.9}]},2)], 'base', None, False),
    ([('repness',{'0':[{'tid':0,'p':.9}]},0)], 'base', None, False),
    # Re-converged choice: root clustering identical, unrelated closure defect.
    ([('repness',{'0':[{'tid':0,'p':.9}]},1)], 'base', None, False),
    ([('repness',{'0':[{'tid':0,'p':.9}]},1)], 'group', None, False),
    ([('base-clusters',SPLIT,1)], 'base', None, True),
    ([('base-clusters',SPLIT,1),('repness',{'0':[{'tid':0,'p':.9}]},1)], 'base', None, True),
    ([('base-clusters',SPLIT,1)], 'base', 1, False),
    ([('base-clusters',SPLIT,1)], 'group', None, False),
    ([('group-clusters',GROUPS,1)], 'group', None, True),
    ([('group-clusters',GROUPS,1),('consensus',{'0':.9},1)], 'group', None, False),
    ([('repness',{'0':[{'tid':0,'p':.9}]},1),('consensus',{'0':.9},1)], 'base', None, False),
    ([('repness',{'0':[{'tid':0,'p':.9}]},1),('pca.center',[3.,3.],1)], 'base', None, False),
    ([('votes-base',{'0':{'A':[2],'D':[1],'S':[3]}},1)], 'group', None, False),
    ([('votes-base',{'0':{'A':[2],'D':[1],'S':[3]}},1)], 'base', None, False),
])
def test_effect_requires_onset_failure_only_in_its_closure(changes,scope,onset,accepted):
    import gate
    from test_legacy_pca_restart import RestartTests
    case=RestartTests();case.setUp()
    try:
        for path,value,index in changes:case.change(path,value,index=index)
        case.write()
        tie=dict(checkpoint=1,scope=scope,name='accepted-tie-cluster-assignment')
        assert gate.tie_has_effect(case.rec,case.expected,case.root/'effect-cache',onset,tie)==accepted
    finally:case.doCleanups()


@pytest.mark.parametrize('case_name,verdict,named',[
    ('no-effect','PASS',False),('later-failure','FAIL',False),
    ('onset-failure','PASS',True),('outside-closure','FAIL',False),
    ('nearest-only','FAIL',False),('reconverged-repness','FAIL',False),
])
def test_real_gate_records_only_effectful_supported_ties(case_name,verdict,named):
    import hashlib
    from unittest.mock import patch
    import attribution, gate
    from test_legacy_pca_restart import RestartTests
    case=RestartTests();case.setUp()
    try:
        if case_name in ('later-failure','nearest-only'):
            case.change('repness',{'0':[{'tid':0,'p':.9}]},index=2)
        split=case_name in ('onset-failure','outside-closure')
        if split:case.change('base-clusters',SPLIT,index=1)
        if case_name in ('onset-failure','outside-closure','reconverged-repness'):
            case.change('repness',{'0':[{'tid':0,'p':.9}]},index=1)
        if case_name=='outside-closure':case.change('consensus',{'0':.9},index=1)
        case.write()
        for engine in ('clj','py'):
            d=doc() if engine=='clj' else doc('b',(1.+1e-8,1.))
            d['checkpoint']=1
            if case_name=='nearest-only':d['events'][0]['subject']='distal-nearest:0'
            base=([dict(id='0',members=['0','1']),dict(id='1',members=['2'])] if split and engine=='py'
                  else [dict(id='0',members=['0','1','2'])])
            d['outcomes']=[dict(scope='base',call=1,clusters=base),
                           dict(scope='group',call=2,clusters=[dict(id='0',members=['0'])])]
            raw=case.rec/engine/('step-001.blob.json' if engine=='clj' else 'step-001.json')
            d['record_sha256']=hashlib.sha256(raw.read_bytes()).hexdigest()
            target=case.rec/(engine+'-decisions')/'step-001.json'
            target.parent.mkdir();target.write_text(json.dumps(d))
        observations=[dict(attribution.unavailable(i),folded_matrix='equal',
                           moderated_matrix='equal',person_projection='pass') for i in range(3)]
        with patch.object(attribution,'measure_recording',return_value=observations):
            report=case.verify()
        assert report['verdict']==verdict
        assert ('decision_tie' in report['entries'][0])==named
        assert any(d['name'].startswith('accepted-tie-')
                   for d in report['entries'][0].get('legacy_defects',[]))==named
    finally:case.doCleanups()
