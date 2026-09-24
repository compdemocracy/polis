from types import SimpleNamespace
import numpy as np
import pandas as pd
import pytest
from polismath.conversation.conversation import Conversation
from polismath.conversation.group_vote_counts import group_vote_counts
from typing import Dict, Any

def _compute_group_votes(self) -> Dict[str, Any]:
    """
        Compute group votes structure which maps group IDs to vote statistics by comment.
        This matches the Clojure conversation.clj group-votes implementation.
        
        Returns:
            Dictionary mapping group IDs to vote statistics
        """
    if not self.group_clusters:
        return {}
    unfolded = self._unfolded_group_clusters()
    tally_mat = self.raw_rating_mat
    group_votes = {}

    def count_votes_for_group(group_id: Any, comment_id: Any, vote_type: str) -> int:
        group = next((g for g in unfolded if g.get('id') == group_id), None)
        if not group:
            return 0
        members = group.get('members', [])
        if not members:
            return 0
        row_indices = []
        for member in members:
            try:
                member_idx = tally_mat.index.get_loc(member)
                row_indices.append(member_idx)
            except ValueError:
                continue
        try:
            col_idx = tally_mat.columns.get_loc(comment_id)
        except ValueError:
            return 0
        votes = tally_mat.values[row_indices, col_idx]
        if vote_type == 'A':
            return int(np.sum(np.abs(votes - 1.0) < 0.001))
        elif vote_type == 'D':
            return int(np.sum(np.abs(votes + 1.0) < 0.001))
        elif vote_type == 'S':
            return int(np.sum(~np.isnan(votes)))
        else:
            return 0
    for group in unfolded:
        group_id = group.get('id')
        if group_id is None:
            continue
        n_members = len(group.get('members', []))
        votes = {}
        for comment_id in self.rating_mat.columns:
            votes[comment_id] = {'A': count_votes_for_group(group_id, comment_id, 'A'), 'D': count_votes_for_group(group_id, comment_id, 'D'), 'S': count_votes_for_group(group_id, comment_id, 'S')}
        group_votes[str(group_id)] = {'n-members': n_members, 'votes': votes}
    return group_votes

REFERENCE = _compute_group_votes
hoisted = Conversation._compute_group_votes

@pytest.mark.parametrize('dtype',[np.float32,np.float64])
@pytest.mark.parametrize('groups',[
 [],[{'id':None,'members':[0]}],[{'id':0,'members':[]}],
 [{'id':0,'members':[1,1,2]}],
 [{'id':0,'members':[0,1]},{'id':0,'members':[2]}],
 [{'id':0,'members':[0,1]},{'id':'0','members':[2]}],
 [{'id':0,'members':[0,1,2]},{'id':1,'members':[3,4,5]}]])
def test_exact_counts_thresholds_duplicates_and_empty_groups(dtype,groups):
 values=np.array([[-1.,-1.0009,-.9991,0.,1.,1.0009,.9991,np.nan,np.inf,-np.inf]]*6,dtype=dtype)
 mat=pd.DataFrame(values)
 conv=SimpleNamespace(group_clusters=groups,raw_rating_mat=mat,rating_mat=mat.iloc[:,::-1],_unfolded_group_clusters=lambda:groups)
 assert hoisted(conv)==REFERENCE(conv)

@pytest.mark.parametrize('fault',['row','column'])
def test_missing_label_refusals_match(fault):
 mat=pd.DataFrame(np.ones((3,3)));groups=[dict(id=0,members=[0,1,9] if fault=='row' else [0,1])]
 rating=mat if fault=='row' else pd.DataFrame(np.ones((3,4)))
 conv=SimpleNamespace(group_clusters=groups,raw_rating_mat=mat,rating_mat=rating,_unfolded_group_clusters=lambda:groups)
 for fn in (hoisted,REFERENCE):
  with pytest.raises(KeyError):fn(conv)

@pytest.mark.parametrize('axis',['rows','columns'])
def test_duplicate_matrix_labels_use_original_behavior(axis):
 mat=pd.DataFrame(np.arange(9.).reshape(3,3));groups=[dict(id=0,members=[0,1])]
 if axis=='rows':mat.index=[0,0,1]
 else:mat.columns=[0,0,1]
 conv=SimpleNamespace(group_clusters=groups,raw_rating_mat=mat,rating_mat=mat,_unfolded_group_clusters=lambda:groups)
 try:expected=REFERENCE(conv)
 except Exception as exc:
  with pytest.raises(type(exc)):hoisted(conv)
 else:assert hoisted(conv)==expected


def test_nan_group_id_matches_no_group():
    mat = pd.DataFrame(np.ones((3, 2)))
    groups = [dict(id=float('nan'), members=[0])]
    conv = SimpleNamespace(group_clusters=groups, raw_rating_mat=mat, rating_mat=mat,
                           _unfolded_group_clusters=lambda: groups)
    assert hoisted(conv) == REFERENCE(conv)


def test_no_comments_never_resolves_members():
    mat = pd.DataFrame(np.ones((3, 2)))
    groups = [dict(id=0, members=[99])]
    conv = SimpleNamespace(group_clusters=groups, raw_rating_mat=mat, rating_mat=mat.iloc[:, :0],
                           _unfolded_group_clusters=lambda: groups)
    assert hoisted(conv) == REFERENCE(conv)


def test_chunked_counts_equal_unchunked_across_partial_chunk():
    rng = np.random.default_rng(7)
    values = rng.choice([1., -1., 0., np.nan], size=(40, 150))
    mat = pd.DataFrame(values)
    groups = [dict(id=0, members=list(range(0, 40, 2))), dict(id=1, members=list(range(1, 40, 2)))]
    comments = mat.columns[::-1]
    chunked = group_vote_counts(mat, comments, groups)
    unchunked = group_vote_counts(mat, comments, groups, chunk=len(comments))
    assert chunked == unchunked
    assert [list(g['votes']) for g in chunked.values()] == [list(g['votes']) for g in unchunked.values()]
    assert all(type(c) is int for g in chunked.values() for v in g['votes'].values() for c in v.values())
    conv = SimpleNamespace(group_clusters=groups, raw_rating_mat=mat, rating_mat=mat.iloc[:, ::-1],
                           _unfolded_group_clusters=lambda: groups)
    assert hoisted(conv) == REFERENCE(conv)
