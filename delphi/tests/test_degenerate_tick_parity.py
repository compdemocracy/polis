#!/usr/bin/env python3
"""
Degenerate-tick Clojure parity (approved port, journal 2026-07-21 verdict).

Clojure's graph has NO guard for <2 base clusters or <2 in-conv participants
past the truly-empty short-circuit (conversation.clj:807-811). Its
:group-clusterings node recomputes EVERY tick, unconditionally
(conversation.clj:433-445): max-k-fn = min(max-k, 2 + n_base//12) >= 2 always
(conversation.clj:274-279), so a degenerate tick still runs kmeans at k=2 on
however many base-cluster centers exist (possibly one), stores the fresh
(possibly 1-cluster) value on the conv, and the NEXT tick warm-starts from it —
recovery splits mint ids via `(inc (apply max ids))` (clean-start-clusters,
clusters.clj:267).

Python legacy mode used to early-return on both edges, keeping the last
NON-degenerate group_clusterings as the warm seed — different seeds, different
cluster ids across a degenerate episode. These tests pin the Clojure semantics
in 'clojure-legacy' mode and pin that 'improved' mode keeps its guards
byte-for-byte.
"""

import os
import sys

import pytest

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.pca_kmeans_rep.pca import PCA_IMPL_ENV_VAR
from polismath.conversation.conversation import Conversation


# ---------------------------------------------------------------------------
# Vote builders. Sign convention doesn't matter here — only bloc separation.
# ---------------------------------------------------------------------------

N_CMTS = 8
BLOC_A = [f'a{i}' for i in range(6)]
BLOC_B = [f'b{i}' for i in range(6)]


def _bloc_votes(pids, agree_first_half):
    votes = []
    for pid in pids:
        for t in range(N_CMTS):
            first_half = t < N_CMTS // 2
            vote = 1.0 if (first_half == agree_first_half) else -1.0
            votes.append({'pid': pid, 'tid': f'c{t}', 'vote': vote})
    return votes


def _two_bloc_votes():
    """Two well-separated blocs -> >=2 base clusters, 2 group clusters."""
    return {'votes': _bloc_votes(BLOC_A, True) + _bloc_votes(BLOC_B, False)}


def _collapse_votes():
    """Bloc B revotes to match bloc A exactly -> every vote row identical ->
    all projections identical -> a single base cluster (degenerate tick)."""
    return {'votes': _bloc_votes(BLOC_B, True)}


def _recover_votes():
    """Bloc B revotes back to full opposition -> two blocs again."""
    return {'votes': _bloc_votes(BLOC_B, False)}


def _single_ptpt_votes():
    return {'votes': [{'pid': 'solo', 'tid': f'c{t}', 'vote': 1.0}
                      for t in range(3)]}


@pytest.fixture
def legacy_mode(monkeypatch):
    monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)


@pytest.fixture
def improved_mode(monkeypatch):
    monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
    monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'improved')


# ---------------------------------------------------------------------------
# Legacy mode: degenerate tick recomputes and threads group_clusterings
# ---------------------------------------------------------------------------

class TestLegacyDegenerateTickOverwrite:

    def test_degenerate_tick_overwrites_group_clusterings(self, legacy_mode):
        conv = Conversation('deg').update_votes(_two_bloc_votes())
        # Healthy tick sanity: a real multi-cluster clustering exists for k=2.
        assert len(conv.group_clusterings.get(2, [])) == 2
        pre_collapse = conv.group_clusterings

        conv = conv.update_votes(_collapse_votes())
        assert len(conv.base_clusters) == 1, "scenario must be degenerate"
        # Clojure recomputes :group-clusterings unconditionally: the stored map
        # must be THIS tick's degenerate result (k range collapses to {2},
        # single cluster), not the stale pre-collapse map.
        assert set(conv.group_clusterings.keys()) == {2}
        assert len(conv.group_clusterings[2]) == 1
        assert conv.group_clusterings is not pre_collapse

    def test_degenerate_group_cluster_covers_the_base_cluster(self, legacy_mode):
        conv = Conversation('deg').update_votes(_two_bloc_votes())
        conv = conv.update_votes(_collapse_votes())
        [base] = conv.base_clusters
        [cluster] = conv.group_clusterings[2]
        assert cluster['members'] == [base['id']]
        # And the production selection is that same degenerate clustering.
        assert [c['id'] for c in conv.group_clusters] == [cluster['id']]

    def test_recovery_tick_mints_inc_max_id(self, legacy_mode):
        conv = Conversation('deg').update_votes(_two_bloc_votes())
        conv = conv.update_votes(_collapse_votes())
        [degenerate_cluster] = conv.group_clusterings[2]
        x = degenerate_cluster['id']

        conv = conv.update_votes(_recover_votes())
        assert len(conv.base_clusters) >= 2, "recovery must de-degenerate"
        # Warm start from the DEGENERATE seed {2: [X]}: clean-start splits the
        # most distal point into a NEW cluster with id (inc (apply max ids))
        # (clusters.clj:267) -> ids {X, X+1}. The old early-return would have
        # warm-started from the stale pre-collapse clustering instead.
        assert sorted(c['id'] for c in conv.group_clusterings[2]) == [x, x + 1]

    def test_degenerate_tick_still_advances_smoother(self, legacy_mode):
        # P6a semantics preserved through the port: silhouette of the
        # single-cluster clustering is 0.0 (Clojure singleton rule,
        # clusters.clj:350-353), fed to the smoother as {2: 0.0}.
        conv = Conversation('deg').update_votes(_two_bloc_votes())
        pre_state = dict(conv.group_k_smoother)
        conv = conv.update_votes(_collapse_votes())
        assert conv.group_k_smoother.get('last_k') == 2
        expected_count = (pre_state.get('last_k_count', 0) + 1
                          if pre_state.get('last_k') == 2 else 1)
        assert conv.group_k_smoother.get('last_k_count') == expected_count


# ---------------------------------------------------------------------------
# Legacy mode: the <2-in-conv-participants edge runs the full chain
# ---------------------------------------------------------------------------

class TestLegacySingleParticipant:

    def test_single_participant_runs_full_chain(self, legacy_mode):
        conv = Conversation('solo').update_votes(_single_ptpt_votes())
        # Clojure has no <2-participants guard: one in-conv participant yields
        # one base cluster, group-clusterings {2: [one cluster]}, and an
        # advanced smoother — not empty structures.
        assert len(conv.base_clusters) == 1
        assert conv.base_clusters[0]['members'] == ['solo']
        assert set(conv.group_clusterings.keys()) == {2}
        assert len(conv.group_clusterings[2]) == 1
        assert len(conv.group_clusters) == 1
        assert conv.group_k_smoother.get('last_k') == 2
        assert conv.group_k_smoother.get('last_k_count') == 1


# ---------------------------------------------------------------------------
# Improved mode: both guards keep their existing behavior byte-for-byte
# ---------------------------------------------------------------------------

class TestImprovedGuardsUnchanged:

    def test_single_participant_early_return(self, improved_mode):
        conv = Conversation('solo').update_votes(_single_ptpt_votes())
        assert conv.base_clusters == []
        assert conv.group_clusters == []
        assert conv.group_clusterings == {}
        assert conv.group_k_smoother == {}

    def test_degenerate_tick_keeps_synthesized_cluster(self, improved_mode):
        conv = Conversation('deg').update_votes(_two_bloc_votes())
        conv = conv.update_votes(_collapse_votes())
        assert len(conv.base_clusters) == 1
        [base] = conv.base_clusters
        # Improved keeps the synthesized id-0 wrapper and stateless smoother.
        assert conv.group_clusters == [{
            'id': 0,
            'center': base['center'],
            'members': [base['id']],
        }]
        assert conv.group_clusterings == {}
        assert conv.group_k_smoother == {}


class TestImprovedStaleStateReset:
    """#2642 review finding: the <2-in-conv-participants early return resets
    base_clusters/group_clusters/subgroup_clusters but used to leave
    group_clusterings/group_k_smoother untouched. In 'improved' mode there is
    no warm-start use for that state (unlike 'clojure-legacy'), so a stale
    value set before a guarded tick would otherwise leak forward into the
    result unchanged instead of being reset to {}."""

    def test_single_participant_resets_stale_group_state(self, improved_mode):
        conv = Conversation('solo')
        conv.group_clusterings = {2: "SENTINEL"}
        conv.group_k_smoother = {"k": 1}

        result = conv.update_votes(_single_ptpt_votes())

        assert result.base_clusters == [], "sanity: must hit the early-return path"
        assert result.group_clusterings == {}
        assert result.group_k_smoother == {}


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
