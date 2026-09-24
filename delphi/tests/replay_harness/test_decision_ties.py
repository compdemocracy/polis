from dataclasses import replace
import math
import pytest
from polismath.replay.decision_ties import Decision, is_near_tie


def pair(kind='min-last'):
    a = Decision(kind, ('a', 'b'), (1., 1. + 1e-8), 'a')
    b = Decision(kind, ('a', 'b'), (1. + 1e-8, 1.), 'b')
    if kind.startswith('max'):
        a, b = replace(a, selected='b'), replace(b, selected='a')
    return a, b


@pytest.mark.parametrize('kind',['min-last','max-last','max-first'])
def test_paired_small_valid_margin(kind):
    a,b=pair(kind)
    assert is_near_tie(a,b) and is_near_tie(b,a)


@pytest.mark.parametrize('kind',['lt','gt'])
@pytest.mark.parametrize('threshold',[0.,.01,1.])
def test_threshold_crossing(kind,threshold):
    a=Decision(kind,(),(threshold-1e-8,),kind=='lt',threshold)
    b=Decision(kind,(),(threshold+1e-8,),kind=='gt',threshold)
    assert is_near_tie(a,b)


@pytest.mark.parametrize('mutation',[
    {'selected':'a'}, {'candidates':('b','a')}, {'candidates':('a','c')},
    {'candidates':('a','a')}, {'scores':(2.,1.)}, {'scores':(math.nan,1.)},
    {'scores':(math.inf,1.)}, {'scores':(True,1.)}, {'scores':('1',1.)},
    {'scores':(1.,)}, {'kind':'unknown'}, {'threshold':0.}, {'selected':True},
    {'scores':()}, {'candidates':['a','b']}, {'scores':[1.,1.]},
])
def test_invalid_or_non_tie_decision_refused(mutation):
    a,b=pair();assert not is_near_tie(a,replace(b,**mutation))


def test_same_scores_cannot_excuse_wrong_tiebreak():
    a=Decision('min-last',('a','b'),(0.,0.),'b')
    assert not is_near_tie(a,replace(a,selected='a'))


def test_zero_scale_cancellation_tie():
    a=Decision('min-last',('a','b'),(0.,0.),'b')
    b=Decision('min-last',('a','b'),(0.,1e-8),'a')
    assert is_near_tie(a,b)


def test_large_common_offset_is_not_tolerance_on_the_difference():
    a=Decision('min-last',('a','b'),(1e6,1e6+1.),'a')
    b=Decision('min-last',('a','b'),(1e6+1.,1e6),'b')
    assert is_near_tie(a,b) # G12 units are the actual decision quantities.


def test_threshold_must_match_and_be_finite():
    a=Decision('lt',(),(.01-1e-8,),True,.01)
    for t in (math.inf,math.nan,True,.02):
        assert not is_near_tie(a,Decision('lt',(),(.01+1e-8,),False,t))


def test_distant_threshold_crossing_is_not_tie():
    assert not is_near_tie(Decision('lt',(),(.009,),True,.01),
                           Decision('lt',(),(.011,),False,.01))


@pytest.mark.parametrize('when',['enter','exit'])
def test_observer_failure_does_not_drop_or_duplicate_science(when):
    from contextlib import contextmanager
    from unittest.mock import Mock, patch
    from polismath.replay import tie_capture
    result=object();conv=Mock();conv.recompute.return_value=result
    @contextmanager
    def broken(enabled):
        if when=='enter':raise ValueError('observer')
        yield {}
        raise ValueError('observer')
    with patch.object(tie_capture,'capture',broken):
        actual,doc=tie_capture.observed_recompute(conv,True)
    assert actual is result and doc['complete'] is False
    conv.recompute.assert_called_once()


def test_science_error_is_not_retried_or_hidden():
    from unittest.mock import Mock
    from polismath.replay.tie_capture import observed_recompute
    conv=Mock();conv.recompute.side_effect=ValueError('science')
    with pytest.raises(ValueError,match='science'):observed_recompute(conv,False)
    conv.recompute.assert_called_once()


def test_overlarge_cluster_request_is_exactly_row_capped():
    import numpy as np
    from polismath.pca_kmeans_rep import legacy_kmeans as km
    from polismath.replay.tie_capture import capture
    data=km._NamedData([0,1,2],np.array([[0.,0.],[1.,1.],[1.,1.]]))
    outputs=[]
    for requested in (3,100):
        with capture(True) as doc:
            result=km.kmeans(data,requested)
        assert doc['complete'] and all(e['cluster_bound']==3 for e in doc['events'])
        outputs.append([(c['id'],c['members'],c['center'].tolist()) for c in result])
    assert outputs[0]==outputs[1]


@pytest.mark.parametrize('field',['id','clst_id','dist'])
def test_distal_observer_checks_actual_engine_result(field):
    from unittest.mock import patch
    import numpy as np
    from polismath.pca_kmeans_rep import legacy_kmeans as km
    from polismath.replay.tie_capture import capture
    data=km._NamedData([0,1],np.array([[0.,0.],[2.,2.]]))
    clusters=[dict(id=0,center=np.array([0.,0.]),members=[0,1])]
    actual=km.most_distal(data,clusters)
    wrong=dict(actual);wrong[field]=999
    with patch.object(km,'most_distal',return_value=wrong),capture(True) as doc:
        result=km.most_distal(data,clusters)
    assert result is wrong and not doc['complete']


@pytest.mark.parametrize('actual',[True,False])
def test_convergence_observer_checks_actual_engine_boolean(actual):
    from unittest.mock import patch
    import numpy as np
    from polismath.pca_kmeans_rep import legacy_kmeans as km
    from polismath.replay.tie_capture import capture
    a=[dict(center=np.array([0.,0.]))]
    b=[dict(center=np.array([1.,1.] if actual else [0.,0.]))]
    with patch.object(km,'same_clustering',return_value=actual),capture(True) as doc:
        result=km.same_clustering(a,b)
    assert result is actual and not doc['complete']
