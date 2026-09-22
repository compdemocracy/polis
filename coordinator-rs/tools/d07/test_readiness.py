"""Missing evidence and unresolved work must not authorize reader rollback."""
import copy
import pytest
from readiness import drained

SAMPLE=dict(ObserverHealthy=1,PollHealthy=1,CurrentPointerHealthy=1,
            PendingOperations=0,UnresolvedOperations=0,WithdrawnPendingOperations=0)
OPERATIONS=[dict(operation_id='public-operation',state='resolved',exact=True)]


def test_complete():
    assert drained(SAMPLE,OPERATIONS)


@pytest.mark.parametrize('key',list(SAMPLE))
def test_absent_signal(key):
    s=dict(SAMPLE);s.pop(key)
    assert not drained(s,OPERATIONS)


@pytest.mark.parametrize('key',list(SAMPLE))
def test_unhealthy_signal(key):
    s=dict(SAMPLE);s[key]=1-s[key]
    assert not drained(s,OPERATIONS)


@pytest.mark.parametrize('state',['pending','unresolved',None])
def test_later_success_does_not_hide_unresolved(state):
    operations=copy.deepcopy(OPERATIONS)
    operations.append(dict(operation_id='older-operation',state=state,exact=False))
    assert not drained(SAMPLE,operations)


@pytest.mark.parametrize('operations',[[],[dict(operation_id='x',state='resolved',exact=False)],
    OPERATIONS+OPERATIONS,[dict(state='resolved',exact=True)]])
def test_missing_or_duplicate_receipt(operations):
    assert not drained(SAMPLE,operations)


def bucket_fixture():
    from types import SimpleNamespace
    data={'base-clusters':{'id':[0],'members':[[0]]},'votes-base':{'0':{'A':[1],'D':[0],'S':[1]}}}
    fold=SimpleNamespace(cells={(0,0):1,(1,0):-1},comments={0},participants={0,1})
    return data,fold


def test_unclustered_voter_is_not_in_bucket():
    from readiness import bucket_counts_match
    data,fold=bucket_fixture()
    assert bucket_counts_match(data,fold)


@pytest.mark.parametrize('defect',['count','missing','duplicate','unknown','sign'])
def test_bad_bucket_aggregation(defect):
    from readiness import bucket_counts_match
    data,fold=bucket_fixture()
    if defect=='count':data['votes-base']['0']['S']=[2]
    if defect=='missing':data['votes-base'].clear()
    if defect=='duplicate':data['base-clusters']['members']=[[0,0]]
    if defect=='unknown':data['base-clusters']['members']=[[4]]
    if defect=='sign':data['votes-base']['0'].update(A=[0],D=[1])
    assert not bucket_counts_match(data,fold)


def empty_bucket_fixture(legacy=False):
    """Contract data comes from the schedule, with real input-side emptiness."""
    import json
    from pathlib import Path
    from types import SimpleNamespace
    schedule=json.loads((Path(__file__).resolve().parents[3]/
        'delphi/scripts/schedules/pc-zerovote-01-empty.json').read_text())
    data={key:value for key,value in schedule['empty_output'].items() if '.' not in key}
    data['base-clusters']={'id':[],'members':[]}
    if legacy:
        for key in schedule['legacy_absent_keys']:
            data.pop(key,None)
    return data,SimpleNamespace(cells={},comments={1,2},participants=set())


@pytest.mark.parametrize('legacy',[False,True])
@pytest.mark.parametrize('comments',[set(),{1,2}])
def test_empty_vote_fold_accepts_declared_or_legacy_missing_buckets(legacy,comments):
    from readiness import bucket_counts_match
    data,fold=empty_bucket_fixture(legacy)
    fold.comments=comments
    assert bucket_counts_match(data,fold)


@pytest.mark.parametrize('value',[None,[],{'1':{'A':[],'D':[],'S':[]}}])
def test_empty_vote_fold_refuses_wrong_present_buckets(value):
    from readiness import bucket_counts_match
    data,fold=empty_bucket_fixture()
    data['votes-base']=value
    assert not bucket_counts_match(data,fold)


@pytest.mark.parametrize('base',[None,{}, {'id':[0],'members':[[]]},
    {'id':[],'members':[[0]]}, {'id':[0],'members':[[0]]}])
def test_empty_vote_fold_does_not_bypass_cluster_evidence(base):
    from readiness import bucket_counts_match
    data,fold=empty_bucket_fixture(True)
    data['base-clusters']=base
    assert not bucket_counts_match(data,fold)


@pytest.mark.parametrize('value',['absent',{},None])
def test_blob_claiming_zero_does_not_override_nonempty_input(value):
    from readiness import bucket_counts_match
    data,fold=bucket_fixture()
    data['n']=0
    if value=='absent':data.pop('votes-base')
    else:data['votes-base']=value
    assert not bucket_counts_match(data,fold)
