
import pytest
import os
import sys

# Add parent to path
sys.path.append(os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from polismath.conversation.conversation import Conversation

def test_empty_votes():
    """
    Tests that the system can handle an empty list of votes.
    """
    conv = Conversation("test_conv")
    votes = {'votes': []}
    conv = conv.update_votes(votes)
    assert conv.participant_count == 0
    assert conv.comment_count == 0
    conv = conv.recompute()
    assert conv.pca is None
    assert conv.group_clusters == []
    assert conv.repness is None

def test_malformed_votes():
    """
    Tests that the system can handle votes with missing or invalid fields.
    """
    conv = Conversation("test_conv")
    votes = {
        'votes': [
            {'pid': 'p1', 'tid': 'c1', 'vote': 1},
            {'pid': 'p2', 'tid': 'c2'},  # Missing 'vote'
            {'pid': 'p3', 'vote': -1},  # Missing 'tid'
            {'tid': 'c4', 'vote': 1},  # Missing 'pid'
            {} # Empty vote
        ]
    }
    conv = conv.update_votes(votes)
    # Only 1 valid vote (p1, c1) - malformed votes should be skipped
    assert conv.participant_count == 1
    assert conv.comment_count == 1

def test_insufficient_data_for_pca():
    """
    Tests that the system handles cases where there is not enough data for PCA.
    """
    conv = Conversation("test_conv")
    votes = {
        'votes': [
            {'pid': 'p1', 'tid': 'c1', 'vote': 1},
        ]
    }
    conv = conv.update_votes(votes)
    conv = conv.recompute()
    assert conv.pca is not None
    assert conv.pca['comps'].shape == (2, 1)
    assert conv.repness is not None
    assert conv.repness['group_repness'] == {0: []}
