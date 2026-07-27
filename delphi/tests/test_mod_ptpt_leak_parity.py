#!/usr/bin/env python3
"""
Participant-ban (participants.mod = -1) leak replication — CLOJURE_QUIRKS Q1.

The Clojure math worker NEVER honored participant bans: its ingest path has no
participants.mod filter, so mod_out_ptpts never reaches the conv and banned
participants keep influencing user-vote-counts, in-conv, PCA, clustering and
repness. Python gained a real ban feature (mod_out_ptpts row drop in
_apply_moderation, 2026-06-10) — correct, but a certification divergence.

Per Q1 + the mode collapse (2026-07-27, bans dropped as a feature): the
engine LEAKS the ban exactly like Clojure (rows kept everywhere). This
supersedes #2623's TestCarryPruneOnParticipantBan (banning can no longer
shrink the clustering pool, so the carry-prune scenario cannot arise).
"""

import os
import sys

import pytest

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.pca_kmeans_rep.pca import PCA_IMPL_ENV_VAR
from polismath.conversation.conversation import Conversation


N_CMTS = 8


def _bloc_votes():
    """Two blocs of 6, everyone votes all comments (all above threshold)."""
    votes = []
    for i in range(6):
        for t in range(N_CMTS):
            votes.append({'pid': f'a{i}', 'tid': f'c{t}',
                          'vote': 1.0 if t < 4 else -1.0})
            votes.append({'pid': f'b{i}', 'tid': f'c{t}',
                          'vote': -1.0 if t < 4 else 1.0})
    return {'votes': votes}


def _clustered_pids(conv):
    return {m for bc in conv.base_clusters for m in bc['members']}


@pytest.fixture
def legacy_mode(monkeypatch):
    monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)


class TestLegacyBanLeak:

    def test_banned_participant_rows_kept(self, legacy_mode):
        conv = Conversation('leak').update_votes(_bloc_votes())
        conv = conv.update_moderation({'mod_out_ptpts': ['a0', 'b0']})
        # The ban is STORED (payload bookkeeping unchanged) ...
        assert conv.mod_out_ptpts == {'a0', 'b0'}
        # ... but NOT applied: Clojure's worker never drops banned rows.
        assert 'a0' in conv.rating_mat.index
        assert 'b0' in conv.rating_mat.index

    def test_banned_participant_still_clustered(self, legacy_mode):
        conv = Conversation('leak').update_votes(_bloc_votes())
        conv = conv.update_moderation({'mod_out_ptpts': ['a0', 'b0']})
        clustered = _clustered_pids(conv)
        assert {'a0', 'b0'}.issubset(clustered)
        # And they stay through a subsequent vote tick.
        conv = conv.update_votes({'votes': [
            {'pid': 'a1', 'tid': 'c0', 'vote': 1.0}]})
        assert {'a0', 'b0'}.issubset(_clustered_pids(conv))

    def test_banned_participant_counted_in_user_vote_counts(self, legacy_mode):
        conv = Conversation('leak').update_votes(_bloc_votes())
        conv = conv.update_moderation({'mod_out_ptpts': ['a0']})
        assert conv._compute_user_vote_counts().get('a0') == N_CMTS

    def test_banned_participant_stays_in_conv(self, legacy_mode):
        conv = Conversation('leak').update_votes(_bloc_votes())
        conv = conv.update_moderation({'mod_out_ptpts': ['a0']})
        assert 'a0' in conv.in_conv


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
