#!/usr/bin/env python3
"""
Tests for the group-K smoother (PR-D smoother part).

Port of Clojure :group-k-smoother (conversation.clj:454-478), which damps the
number-of-opinion-groups (K) so it only switches to a new best value after
`:group-k-buffer` (4, conversation.clj:154) consecutive ticks agree on it.

Two layers:
  1. Pure-function unit tests (buffer counting, reset-on-change, clamp,
     first-tick, higher-k tie-break) — fast, deterministic.
  2. A chained-update_votes integration test proving the smoother is threaded
     across ticks in 'clojure-legacy' mode (no flicker on brief alternation,
     switch after 4 consecutive) and is inert in 'improved' mode.
"""

import os
import sys

import pytest

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.pca_kmeans_rep.group_k_smoother import (
    group_k_smoother_update,
    GROUP_K_BUFFER,
)
from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR
from polismath.pca_kmeans_rep.pca import PCA_IMPL_ENV_VAR
import polismath.conversation.conversation as conv_mod
from polismath.conversation.conversation import Conversation


# ---------------------------------------------------------------------------
# Pure-function unit tests
# ---------------------------------------------------------------------------

def _sils(chosen, ks=(2, 3)):
    """Silhouettes that make `chosen` the unique argmax over ks."""
    return {k: (1.0 if k == chosen else 0.0) for k in ks}


def _drive(this_k_seq, ks=(2, 3), buffer=GROUP_K_BUFFER):
    """Chain the smoother over a sequence of desired this_k values, returning
    the list of smoothed_k emitted at each tick."""
    state = {}
    out = []
    for chosen in this_k_seq:
        state, sm = group_k_smoother_update(state, _sils(chosen, ks), buffer=buffer)
        out.append(sm)
    return out


class TestGroupKSmootherPure:

    def test_default_buffer_is_four(self):
        assert GROUP_K_BUFFER == 4  # Clojure :group-k-buffer, conversation.clj:154

    def test_first_tick_accepts_best_k(self):
        state, sm = group_k_smoother_update({}, {2: 0.1, 3: 0.9})
        assert sm == 3
        assert state == {'last_k': 3, 'last_k_count': 1, 'smoothed_k': 3}

    def test_first_tick_accepts_best_k_none_state(self):
        _, sm = group_k_smoother_update(None, {2: 0.9, 3: 0.1})
        assert sm == 2

    def test_switch_only_after_four_consecutive(self):
        # smoothed_k established at 2, then this_k flips to 3 and must wait 4
        # consecutive ticks before smoothed_k follows.
        out = _drive([2, 2, 2, 2, 3, 3, 3, 3])
        assert out == [2, 2, 2, 2, 2, 2, 2, 3]

    def test_reset_on_change(self):
        # A single interrupting this_k=2 (tick index 6) resets the 3-streak, so
        # the switch is delayed until 4 fresh consecutive 3's accumulate.
        out = _drive([2, 2, 2, 2, 3, 3, 2, 3, 3, 3, 3])
        assert out == [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3]
        # Interrupt really did reset the counter (would have switched at index 7
        # without the reset).
        assert out[7] == 2

    def test_brief_alternation_does_not_flicker(self):
        # this_k alternates but never reaches 4-in-a-row -> smoothed_k pinned.
        out = _drive([2, 3, 2, 3, 2, 3])
        assert out == [2, 2, 2, 2, 2, 2]

    def test_clamp_missing_carried_smoothed_falls_back_to_this_k(self):
        # Carried smoothed_k=5 no longer exists among {2,3} -> fall back to
        # this_k, never KeyError (Clojure clamp #2536, conversation.clj:469-478).
        prev = {'last_k': 5, 'last_k_count': 10, 'smoothed_k': 5}
        state, sm = group_k_smoother_update(prev, {2: 0.9, 3: 0.1})
        assert sm == 2  # this_k
        assert state['smoothed_k'] == 2

    def test_clamp_present_carried_smoothed_is_kept(self):
        prev = {'last_k': 3, 'last_k_count': 1, 'smoothed_k': 3}
        # this_k=2 but not yet 4-in-a-row, so smoothed_k should stay carried 3
        # (which IS present) rather than flip.
        _, sm = group_k_smoother_update(prev, {2: 0.9, 3: 0.1})
        assert sm == 3

    def test_empty_silhouettes_raises(self):
        """The contract guarantees smoothed_k is a key of silhouettes_by_k —
        impossible for an empty dict, so fail fast instead of returning None."""
        with pytest.raises(ValueError, match="non-empty"):
            group_k_smoother_update({}, {})

    def test_tie_break_higher_k_wins(self):
        # Clojure max-key returns the LAST maximal arg; keys iterate ascending
        # -> higher k wins ties (conversation.clj:461).
        _, sm = group_k_smoother_update({}, {2: 0.5, 3: 0.5})
        assert sm == 3

    def test_tie_break_higher_k_wins_among_partial_ties(self):
        _, sm = group_k_smoother_update({}, {2: 0.5, 3: 0.5, 4: 0.2})
        assert sm == 3
        _, sm = group_k_smoother_update({}, {2: 0.2, 3: 0.5, 4: 0.5})
        assert sm == 4


# ---------------------------------------------------------------------------
# Pipeline integration: smoother threaded across chained update_votes
# ---------------------------------------------------------------------------

class _SilStub:
    """Deterministic silhouette stub keyed on CALL INDEX, not label counts, so
    it is robust to empty clusters. The group loop calls silhouette once per k
    in ascending order (k=2 then k=3) every tick, so call 2*t is the k=2 call
    of tick t and call 2*t+1 is the k=3 call. Returns 1.0 for the tick's
    preferred k and 0.0 otherwise."""

    def __init__(self, prefs):
        self.prefs = prefs
        self.n = 0

    def __call__(self, X, labels):
        idx = self.n
        self.n += 1
        tick = idx // 2
        this_call_k = 2 if (idx % 2 == 0) else 3
        pref = self.prefs[min(tick, len(self.prefs) - 1)]
        return 1.0 if this_call_k == pref else 0.0


def _many_ptpt_votes(n_ptpts=18, n_cmnts=8):
    """18 DISTINCT ternary vote rows over 8 comments (3 group signatures + 5
    unique bits), so base k-means yields 18 singleton base clusters and
    max-k = min(5, 2 + 18//12) = 3 -> group clusterings for k in {2, 3}."""
    votes = []
    for i in range(n_ptpts):
        g = i % 3
        for j in range(n_cmnts):
            if j < 3:
                v = 1.0 if j == g else -1.0
            else:
                v = 1.0 if ((i >> (j - 3)) & 1) else -1.0
            votes.append({'pid': f'p{i}', 'tid': f'c{j}', 'vote': v})
    return {'votes': votes}


# A repeat of p0's c0 vote (g=0 -> j==0 -> +1): unchanged matrix, but still
# triggers a recompute tick.
_REPEAT_VOTE = {'votes': [{'pid': 'p0', 'tid': 'c0', 'vote': 1.0}]}


class TestSmootherPipeline:

    def _setup(self, monkeypatch, mode, prefs):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)  # default powerit
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, mode)
        stub = _SilStub(prefs)
        monkeypatch.setattr(conv_mod, 'calculate_silhouette_sklearn', stub)
        return stub

    def test_legacy_no_flicker_then_switch_after_four(self, monkeypatch):
        # this_k schedule: 2,2,3,2,3,3,3,3,3  (the isolated 3 at tick 2 is brief
        # noise; 3 becomes stable from tick 4 -> switch on the 4th consecutive).
        prefs = [2, 2, 3, 2, 3, 3, 3, 3, 3]
        self._setup(monkeypatch, 'clojure-legacy', prefs)

        conv = Conversation('smooth').update_votes(_many_ptpt_votes())
        # Sanity: the two-tick group clusterings really exist for k in {2,3}.
        assert set(conv.group_clusterings.keys()) == {2, 3}

        smoothed = [conv.group_k_smoother['smoothed_k']]
        for _ in range(1, len(prefs)):
            conv = conv.update_votes(_REPEAT_VOTE)
            smoothed.append(conv.group_k_smoother['smoothed_k'])

        assert smoothed == [2, 2, 2, 2, 2, 2, 2, 3, 3], smoothed
        # Brief alternation (tick 2) did not flip; switch happened only on the
        # 4th consecutive this_k=3 (tick 7), not the 3rd (tick 6).
        assert smoothed[6] == 2 and smoothed[7] == 3
        # group_clusters is picked from the smoothed k and is never None/empty.
        assert conv.group_clusters, "group_clusters must be populated"

    def test_mode_switch_to_improved_clears_legacy_state(self, monkeypatch):
        """After a clojure-legacy tick populated the warm-start state, a tick
        under improved mode must CLEAR it (not silently retain stale memory)."""
        prefs = [2, 2]
        self._setup(monkeypatch, 'clojure-legacy', prefs)
        conv = Conversation('smooth').update_votes(_many_ptpt_votes())
        assert conv.group_clusterings and conv.group_k_smoother

        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'improved')
        conv = conv.update_votes(_REPEAT_VOTE)
        assert conv.group_k_smoother == {}
        assert conv.group_clusterings == {}
        assert conv.group_clusters, "group_clusters must be populated"

    def test_improved_mode_leaves_smoother_inert(self, monkeypatch):
        prefs = [3, 3, 3, 3]
        self._setup(monkeypatch, 'improved', prefs)
        conv = Conversation('smooth').update_votes(_many_ptpt_votes())
        # Improved mode never touches the smoother/clusterings state.
        assert conv.group_k_smoother == {}
        assert conv.group_clusterings == {}
        # But still produces group clusters via the untouched best_k path.
        assert conv.group_clusters, "group_clusters must be populated"


def _degenerate_votes(n_ptpts=20, n_cmts=8):
    """All participants vote identically -> a single base cluster (degenerate)."""
    return {'votes': [{'pid': f'p{i}', 'tid': f'c{t}', 'vote': 1.0}
                      for i in range(n_ptpts) for t in range(n_cmts)]}


class TestDegenerateTickSmoother:
    """P6a: on a <2-base-cluster degenerate tick with a NON-empty conv, Clojure's
    max-k-fn is still >= 2 (conversation.clj:273-279), so its graph feeds this_k=2
    to the group-k smoother and ADVANCES it. Legacy mode must mirror that instead
    of freezing the smoother memory. Improved mode carries no smoother state."""

    def _mode(self, monkeypatch, mode):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, mode)

    def test_legacy_degenerate_tick_advances_smoother(self, monkeypatch):
        self._mode(monkeypatch, 'clojure-legacy')
        conv = Conversation('deg').update_votes(_degenerate_votes())
        assert len(conv.base_clusters) < 2, "scenario must be degenerate"
        # Smoother ADVANCED (this_k=2), not frozen at {}.
        assert conv.group_k_smoother.get('last_k') == 2
        assert conv.group_k_smoother.get('smoothed_k') == 2
        assert conv.group_k_smoother.get('last_k_count') == 1

    def test_legacy_degenerate_tick_accumulates_count_across_ticks(self, monkeypatch):
        self._mode(monkeypatch, 'clojure-legacy')
        conv = Conversation('deg').update_votes(_degenerate_votes())
        # A second still-degenerate tick keeps this_k=2 -> consecutive count grows
        # (this is precisely the smoother advance Clojure performs each tick).
        conv = conv.update_votes({'votes': [{'pid': 'p0', 'tid': 'c0', 'vote': 1.0}]})
        assert len(conv.base_clusters) < 2
        assert conv.group_k_smoother.get('last_k') == 2
        assert conv.group_k_smoother.get('last_k_count') == 2

    def test_improved_degenerate_tick_leaves_smoother_inert(self, monkeypatch):
        self._mode(monkeypatch, 'improved')
        conv = Conversation('deg').update_votes(_degenerate_votes())
        assert len(conv.base_clusters) < 2
        assert conv.group_k_smoother == {}  # improved carries no smoother state
