"""Tests for `Conversation._compute_group_votes`.

`_compute_group_votes` runs twice per math tick — once from
`_compute_comment_priorities` inside `recompute()`, once from
`_compute_group_aware_consensus` on the DynamoDB write path — so it has to
produce exactly the per-group A/D/S counts the Clojure `group-votes` did,
and it has to do it without rescanning the vote matrix once per comment
(#2587).
"""

import os
import sys

import numpy as np
import pandas as pd

# Add parent to path
sys.path.append(os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from polismath.conversation.conversation import Conversation


class FakeConversation:
    """Carries only the state `_compute_group_votes` reads.

    Building the real thing through `recompute()` would pin group membership
    to whatever k-means picks; these tests need known memberships and known
    vote patterns.
    """

    def __init__(self, rating_mat, groups):
        self.rating_mat = rating_mat
        self.group_clusters = [{'id': g['id']} for g in groups]
        self._groups = groups

    def _unfolded_group_clusters(self):
        return self._groups


def reference_group_votes(conv):
    """Straightforward per-group, per-comment A/D/S counts."""
    result = {}
    for group in conv._unfolded_group_clusters():
        votes = {}
        for comment_id in conv.rating_mat.columns:
            column = conv.rating_mat.loc[group['members'], comment_id]
            votes[comment_id] = {
                'A': int((column == 1.0).sum()),
                'D': int((column == -1.0).sum()),
                'S': int(column.notna().sum()),
            }
        result[str(group['id'])] = {
            'n-members': len(group['members']),
            'votes': votes,
        }
    return result


def make_conversation(n_participants, n_comments, n_groups, seed=0):
    rng = np.random.default_rng(seed)
    values = rng.choice([-1.0, 0.0, 1.0, np.nan],
                        size=(n_participants, n_comments),
                        p=[0.25, 0.3, 0.1, 0.35])
    rating_mat = pd.DataFrame(values,
                              index=list(range(n_participants)),
                              columns=list(range(n_comments)))
    assignment = rng.integers(0, n_groups, size=n_participants)
    groups = [
        {'id': gid,
         'members': [int(pid) for pid in np.flatnonzero(assignment == gid)]}
        for gid in range(n_groups)
    ]
    return FakeConversation(rating_mat, groups)


def count_index_lookups(monkeypatch, conv):
    """Run `_compute_group_votes` and return the `Index.get_loc` call count."""
    calls = []
    real_get_loc = pd.Index.get_loc

    def counting_get_loc(self, key, *args, **kwargs):
        calls.append(key)
        return real_get_loc(self, key, *args, **kwargs)

    monkeypatch.setattr(pd.Index, 'get_loc', counting_get_loc)
    Conversation._compute_group_votes(conv)
    monkeypatch.undo()
    return len(calls)


def test_group_votes_match_reference_counts():
    """A/D/S per group and comment agree with a direct count."""
    conv = make_conversation(60, 25, 3)

    assert Conversation._compute_group_votes(conv) == reference_group_votes(conv)


def test_group_votes_count_pass_in_s_but_not_in_a_or_d():
    """S counts every cast vote, PASS included; A and D count only ±1."""
    rating_mat = pd.DataFrame(
        [[1.0, -1.0, 0.0, np.nan]],
        index=[0],
        columns=[10, 11, 12, 13],
    )
    conv = FakeConversation(rating_mat, [{'id': 0, 'members': [0]}])

    votes = Conversation._compute_group_votes(conv)['0']['votes']

    assert votes[10] == {'A': 1, 'D': 0, 'S': 1}
    assert votes[11] == {'A': 0, 'D': 1, 'S': 1}
    assert votes[12] == {'A': 0, 'D': 0, 'S': 1}
    assert votes[13] == {'A': 0, 'D': 0, 'S': 0}


def test_group_votes_with_no_members_are_all_zero():
    """A group nobody landed in still reports every comment, at zero."""
    rating_mat = pd.DataFrame([[1.0, -1.0]], index=[0], columns=[10, 11])
    conv = FakeConversation(rating_mat, [{'id': 0, 'members': [0]},
                                         {'id': 1, 'members': []}])

    empty = Conversation._compute_group_votes(conv)['1']

    assert empty['n-members'] == 0
    assert empty['votes'] == {10: {'A': 0, 'D': 0, 'S': 0},
                              11: {'A': 0, 'D': 0, 'S': 0}}


def test_group_votes_counts_are_plain_ints():
    """Counts are serialized downstream, so numpy scalars must not leak."""
    conv = make_conversation(20, 5, 2)

    for group in Conversation._compute_group_votes(conv).values():
        for counts in group['votes'].values():
            assert all(type(n) is int for n in counts.values())


def test_group_votes_resolves_member_rows_once_per_group(monkeypatch):
    """Member row lookup is hoisted out of the per-comment loop (#2587).

    The pre-vectorization implementation resolved every member's row inside
    a per-(comment, vote-type) helper, so `Index.get_loc` ran
    `3 x groups x comments x members` times and the matrix was rescanned for
    every comment. Counting the lookups pins the complexity without
    depending on wall-clock time.
    """
    conv = make_conversation(40, 30, 2)
    n_members = sum(len(g['members']) for g in conv._unfolded_group_clusters())

    assert count_index_lookups(monkeypatch, conv) == n_members


def test_group_votes_cost_is_independent_of_comment_count(monkeypatch):
    """Quadrupling the comments must not multiply the index lookups."""
    few = make_conversation(30, 10, 2)
    many = make_conversation(30, 40, 2)

    assert (count_index_lookups(monkeypatch, few)
            == count_index_lookups(monkeypatch, many)
            == 30)
