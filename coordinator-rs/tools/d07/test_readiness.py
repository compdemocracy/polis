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
