#!/usr/bin/env python3
"""
Priority un-mirror (D12.6 → resolved) + Q2 prev-tick group-votes.

Clojure's #1961 truthy-0 bug (every tid took the meta branch → all priorities
49) was fixed upstream in #2611 (merged 2026-07-18, `(contains? meta-tids
tid)` at conversation.clj:686). Python's `priority_metric` mirrored the bug
(#2571) and must now un-mirror: the real branching formula is both the
correct behavior AND the Clojure-HEAD-parity behavior, in BOTH engine modes.

Separately (CLOJURE_QUIRKS Q2): Clojure's :comment-priorities node SHADOWS
its current-tick group-votes input with `(:group-votes conv)` — the PREVIOUS
tick's stored value (conversation.clj:658). The engine does the same. (The
former improved-mode current-tick read is parked:
POST_CUTOVER_IMPROVEMENTS.md item 5.)
"""

import os
import sys

import numpy as np
import pytest

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.conversation.conversation import (
    Conversation,
    META_PRIORITY,
    importance_metric,
    priority_metric,
)
from polismath.pca_kmeans_rep.pca import (
    PCA_IMPL_ENV_VAR,
    compute_comment_extremity,
    pca_project_cmnts,
)
from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR


N_CMTS = 6


def _bloc_votes():
    votes = []
    for i in range(6):
        for t in range(N_CMTS):
            votes.append({'pid': f'a{i}', 'tid': f'c{t}',
                          'vote': 1.0 if t < 3 else -1.0})
            votes.append({'pid': f'b{i}', 'tid': f'c{t}',
                          'vote': -1.0 if t < 3 else 1.0})
    return {'votes': votes}


def _tick2_votes():
    """Extra votes that change several tids' A/S totals vs tick 1."""
    return {'votes': [
        {'pid': 'n0', 'tid': f'c{t}', 'vote': 1.0} for t in range(N_CMTS)
    ]}


def _expected_priorities(conv, group_votes):
    """Priorities implied by `group_votes` + `conv`'s CURRENT pca/meta state,
    via the same production formula pieces (formula wiring is pinned by the
    unit tests below; this pins the DATA-FLOW: which tick's group-votes)."""
    center = np.asarray(conv.pca['center'])
    comps = np.asarray(conv.pca['comps'])
    extremity = dict(zip(
        conv.rating_mat.columns,
        compute_comment_extremity(pca_project_cmnts(center, comps))))
    out = {}
    for tid in conv.rating_mat.columns:
        A = D = S = 0
        for gv in group_votes.values():
            v = gv.get('votes', {}).get(tid, {'A': 0, 'D': 0, 'S': 0})
            A += v.get('A', 0)
            D += v.get('D', 0)
            S += v.get('S', 0)
        P = S - (A + D)
        out[tid] = float(priority_metric(
            tid in conv.meta_tids, A, P, S, float(extremity.get(tid, 0))))
    return out


@pytest.fixture
def legacy_mode(monkeypatch):
    monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
    monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'clojure-legacy')




class TestPriorityMetricUnmirrored:
    """The real branching formula, restored (both modes — pure function)."""

    def test_non_meta_uses_importance_times_decay_squared(self):
        A, P, S, E = 20, 3, 20, 0.7
        expected = (importance_metric(A, P, S, E) * (1 + 8 * 2 ** (-S / 5))) ** 2
        assert abs(priority_metric(False, A, P, S, E) - expected) < 1e-10
        # And it is NOT the mirror constant.
        assert priority_metric(False, A, P, S, E) != META_PRIORITY ** 2

    def test_meta_still_constant_49(self):
        assert priority_metric(True, 20, 3, 20, 0.7) == META_PRIORITY ** 2

    def test_zero_votes_formula(self):
        # A=P=S=0: importance = (1 - 1/2) * (E+1) * (1/2); decay = 9.
        E = 0.4
        expected = (0.25 * (E + 1) * 9) ** 2
        assert abs(priority_metric(False, 0, 0, 0, E) - expected) < 1e-10


class TestPrioritiesGroupVotesTick:
    """Q2 data-flow: which tick's group-votes feed the priorities."""

    def test_legacy_uses_prev_tick_group_votes(self, legacy_mode):
        conv1 = Conversation('q2').update_votes(_bloc_votes())
        gv1 = conv1._compute_group_votes()
        conv2 = conv1.update_votes(_tick2_votes())
        gv2 = conv2._compute_group_votes()

        expected_prev = _expected_priorities(conv2, gv1)
        expected_curr = _expected_priorities(conv2, gv2)
        # The scenario must actually distinguish the two ticks.
        assert any(abs(expected_prev[t] - expected_curr[t]) > 1e-9
                   for t in expected_prev), "scenario failed to change A/P/S"

        got = {f'c{k}' if not isinstance(k, str) else k: v
               for k, v in conv2.comment_priorities.items()}
        for tid in expected_prev:
            assert abs(got[tid] - expected_prev[tid]) < 1e-9, (
                f"{tid}: legacy priorities must come from the PREVIOUS "
                f"tick's group-votes (Clojure conversation.clj:658)")

    def test_legacy_first_tick_uses_empty_group_votes(self, legacy_mode):
        conv = Conversation('q2').update_votes(_bloc_votes())
        # Clojure first tick: (:group-votes conv) is nil → A=P=S=0 for every
        # tid; only extremity varies.
        expected = _expected_priorities(conv, {})
        got = {f'c{k}' if not isinstance(k, str) else k: v
               for k, v in conv.comment_priorities.items()}
        for tid in expected:
            assert abs(got[tid] - expected[tid]) < 1e-9

    def test_legacy_stores_group_votes_for_next_tick(self, legacy_mode):
        conv1 = Conversation('q2').update_votes(_bloc_votes())
        assert conv1.group_votes == conv1._compute_group_votes()

if __name__ == '__main__':
    pytest.main([__file__, '-v'])
