"""Public late-column revotes against independently recorded Clojure PCA."""
import json
from pathlib import Path

import numpy as np
import pytest

from polismath.conversation.conversation import Conversation

FIXTURE = json.loads((Path(__file__).parent / 'replay_harness/fixtures/revote_column_order.json').read_text())


def assert_g12(actual, expected):
    actual, expected = np.asarray(actual), np.asarray(expected)
    assert actual.shape == expected.shape
    assert np.all(np.abs(actual-expected) <= 1e-6 + 1e-4*np.maximum(np.abs(actual),np.abs(expected)))


def batch(rows):
    # Fixture signs are raw storage; the Python ingress negates them.
    return {'votes': [dict(pid=p, tid=t, vote=-v, created=ms) for p, t, v, ms in rows]}


@pytest.mark.parametrize('case', FIXTURE['cases'], ids=lambda case: str(case['seed']))
def test_cross_cut_revotes_match_recorded_components(case):
    conv = Conversation('public-column-order', last_updated=case['votes'][0][3])
    conv.pca = {'center': np.zeros(1), 'comps': np.ones((2, 1))}
    previous = 0
    for cut, expected in zip(case['cuts'], case['expected']):
        conv = conv.update_votes(batch(case['votes'][previous:cut]), recompute=False).recompute()
        blob = conv.to_dict()
        assert blob['tids'] == expected['tids']
        assert list(conv.rating_mat.columns) == expected['tids']
        assert_g12(blob['pca']['comps'], expected['pca']['comps'])
        # Output polarity can differ only in the sign of a zero center.
        np.testing.assert_array_equal(blob['pca']['center'], expected['pca']['center'])
        assert_g12(blob['pca']['comment-projection'], expected['pca']['comment-projection'])
        previous = cut


def test_restored_components_keep_the_recorded_column_positions():
    case = FIXTURE['cases'][1]
    first = case['expected'][1]
    conv = Conversation.from_dict({'conversation_id': 'public-restored',
                                   'tids': first['tids'], 'pca': first['pca']})
    # Rebuild votes to the next cut, preserving the loaded warm component order.
    conv = conv.update_votes(batch(case['votes'][:case['cuts'][2]]), recompute=False)
    conv._compute_pca(prev_pca=conv.pca)
    assert_g12(conv.pca['comps'], case['expected'][2]['pca']['comps'])


def test_null_and_duplicate_votes_do_not_move_column_positions():
    conv = Conversation('public-null-columns', last_updated=1)
    conv = conv.update_votes({'votes': [dict(pid=0, tid=8, vote=1, created=1),
                                        dict(pid=0, tid=2, vote=None, created=2),
                                        dict(pid=0, tid=8, vote=-1, created=3)]}, recompute=False)
    assert list(conv.raw_rating_mat.columns) == [8, 2]
    conv = conv.update_votes({'votes': [dict(pid=0, tid=1, vote=0, created=4),
                                        dict(pid=0, tid=2, vote=1, created=5)]}, recompute=False)
    assert list(conv.raw_rating_mat.columns) == [8, 2, 1]
    assert conv.raw_rating_mat.loc[0].tolist() == [-1, 1, 0]
