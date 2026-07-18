#!/usr/bin/env python3
"""
Tests for the in-conv greedy floor + persistent carry in 'clojure-legacy' mode
(PR-E, Clojure :in-conv, conversation.clj:243-269).

Clojure keeps a PERSISTENT in-conv set on the conv and, every tick, (1) unions
the threshold-qualifiers into it and (2) if fewer than 15 are in, greedily
admits the top voters up to 15 — then carries the whole set forward, so admits
never leave. The pre-PR Python pipeline had NEITHER the greedy floor NOR the
carry (only the threshold set). This module verifies:

  1. Improved mode (default) is unchanged: threshold set only, no greedy floor,
     no carry, and self.in_conv is never populated.
  2. Legacy mode admits the top (15 - n) voters when under 15, with ties broken
     by matrix row order (deterministic surrogate for Clojure's hash-order tie).
  3. Legacy greedy admits PERSIST across ticks even once the conversation grows
     past 15 threshold-qualifiers (the carry) — improved mode drops them.
  4. Threshold-qualifiers stay in across ticks in BOTH modes (monotonicity).
"""

import os
import sys

import pytest

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.conversation.conversation import Conversation
from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR
from polismath.pca_kmeans_rep.pca import PCA_IMPL_ENV_VAR


TOTAL_CMNTS = 8  # threshold = min(7, 8) = 7


def _votes(specs):
    """specs: list of (pid, n_votes). Participant idx votes on its first
    n_votes comments (of TOTAL_CMNTS) with a per-idx sign pattern (so rows are
    distinct). A participant with n_votes >= 7 clears the threshold."""
    votes = []
    for idx, (pid, nv) in enumerate(specs):
        for j in range(nv):
            v = 1.0 if ((idx + j) % 2 == 0) else -1.0
            votes.append({'pid': pid, 'tid': f'c{j}', 'vote': v})
    return {'votes': votes}


def _clustered_pids(conv):
    """The participants that actually fed base clustering = the effective
    in-conv set (cluster-step assigns every in-conv row to a base cluster)."""
    return {str(m) for c in conv.base_clusters for m in c['members']}


# 2 high voters (qualify) + 20 low voters (6 votes each, below threshold).
_HIGHS = [(f'H{i}', TOTAL_CMNTS) for i in range(2)]
_LOWS = [(f'L{i}', 6) for i in range(20)]
_TICK1_SPECS = _HIGHS + _LOWS  # row order: H0,H1,L0,L1,...,L19


def _mode(monkeypatch, mode):
    monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
    monkeypatch.setenv(ENGINE_MODE_ENV_VAR, mode)


class TestGreedyFloor:

    def test_improved_has_no_greedy_floor(self, monkeypatch):
        # Current/improved behavior: only the 2 threshold-qualifiers cluster.
        _mode(monkeypatch, 'improved')
        conv = Conversation('g').update_votes(_votes(_TICK1_SPECS))
        assert _clustered_pids(conv) == {'H0', 'H1'}
        assert conv.in_conv == set()  # improved never populates the carry set

    def test_legacy_greedy_fills_to_fifteen(self, monkeypatch):
        _mode(monkeypatch, 'clojure-legacy')
        conv = Conversation('g').update_votes(_votes(_TICK1_SPECS))
        clustered = _clustered_pids(conv)
        assert len(clustered) == 15  # 2 highs + 13 greedy admits
        assert {'H0', 'H1'}.issubset(clustered)
        assert conv.in_conv == clustered  # persisted

    def test_legacy_greedy_tie_break_is_row_order(self, monkeypatch):
        # All 20 lows tie at 6 votes; greedy admits the FIRST 13 by row order
        # (L0..L12), not L13..L19 (Clojure sort-by is stable; we key ties on
        # matrix row order deterministically).
        _mode(monkeypatch, 'clojure-legacy')
        conv = Conversation('g').update_votes(_votes(_TICK1_SPECS))
        clustered = _clustered_pids(conv)
        assert {f'L{i}' for i in range(13)}.issubset(clustered)   # L0..L12 in
        assert not any(f'L{i}' in clustered for i in range(13, 20))  # L13..L19 out


class TestPersistentCarry:

    def _tick2_new_qualifiers(self):
        # 20 brand-new participants that each clear the threshold.
        return _votes([(f'Q{i}', TOTAL_CMNTS) for i in range(20)])

    def test_legacy_greedy_admits_persist_after_growth(self, monkeypatch):
        _mode(monkeypatch, 'clojure-legacy')
        conv = Conversation('carry').update_votes(_votes(_TICK1_SPECS))
        admitted_lows = {f'L{i}' for i in range(13)}
        assert admitted_lows.issubset(conv.in_conv)

        # Grow well past 15 threshold-qualifiers; greedy floor no longer fires.
        conv = conv.update_votes(self._tick2_new_qualifiers())
        clustered = _clustered_pids(conv)
        # The tick-1 greedy admits are STILL in, purely via the carry.
        assert admitted_lows.issubset(conv.in_conv)
        assert admitted_lows.issubset(clustered)
        # And the new qualifiers are in too.
        assert {f'Q{i}' for i in range(20)}.issubset(clustered)

    def test_improved_drops_non_qualifiers_after_growth(self, monkeypatch):
        _mode(monkeypatch, 'improved')
        conv = Conversation('carry').update_votes(_votes(_TICK1_SPECS))
        conv = conv.update_votes(self._tick2_new_qualifiers())
        clustered = _clustered_pids(conv)
        # No carry, no greedy: the below-threshold lows are NOT clustered.
        assert not any(f'L{i}' in clustered for i in range(20))
        # Only the threshold-qualifiers (H0,H1 + Q0..Q19) cluster.
        assert clustered == {'H0', 'H1'} | {f'Q{i}' for i in range(20)}


class TestSerializedInConv:

    def test_legacy_blob_in_conv_includes_greedy_admits(self, monkeypatch):
        _mode(monkeypatch, 'clojure-legacy')
        conv = Conversation('blob').update_votes(_votes(_TICK1_SPECS))
        blob_in_conv = {str(p) for p in conv.to_dict()['in-conv']}
        assert len(blob_in_conv) == 15
        assert {'H0', 'H1'}.issubset(blob_in_conv)
        assert {f'L{i}' for i in range(13)}.issubset(blob_in_conv)  # greedy admits

    def test_improved_blob_in_conv_is_threshold_only(self, monkeypatch):
        _mode(monkeypatch, 'improved')
        conv = Conversation('blob').update_votes(_votes(_TICK1_SPECS))
        blob_in_conv = {str(p) for p in conv.to_dict()['in-conv']}
        assert blob_in_conv == {'H0', 'H1'}  # no greedy floor in improved


class TestThresholdMonotonicity:

    @pytest.mark.parametrize('mode', ['improved', 'clojure-legacy'])
    def test_qualifier_stays_in_across_ticks(self, monkeypatch, mode):
        _mode(monkeypatch, mode)
        conv = Conversation('mono').update_votes(_votes(_TICK1_SPECS))
        assert 'H0' in _clustered_pids(conv)
        # A later tick (new participants) never evicts an existing qualifier.
        conv = conv.update_votes(_votes([(f'Q{i}', TOTAL_CMNTS) for i in range(3)]))
        assert 'H0' in _clustered_pids(conv)


class TestCarryUnderParticipantBan:
    """Q1 leak replication (2026-07-22) SUPERSEDES #2623's T1 scenario: in
    clojure-legacy mode a ban is stored but NOT applied (Clojure's worker never
    honored participants.mod = -1), so banning can no longer shrink the
    legacy-mode clustering pool and the stale-carry trap T1 fixed cannot arise.
    The vote_counts intersection in _get_in_conv_participants stays as
    belt-and-braces (see its comment). This test pins the new semantics:
    carry and clustering are ban-invariant in legacy mode."""

    def test_ban_after_carry_changes_nothing(self, monkeypatch):
        _mode(monkeypatch, 'clojure-legacy')
        # Tick 1: greedy floor fills to 15 (H0,H1 + L0..L12) and persists them.
        conv = Conversation('ban').update_votes(_votes(_TICK1_SPECS))
        assert len(conv.in_conv) == 15
        banned = {'L0', 'L1', 'L2', 'L3', 'L4'}
        assert banned.issubset(conv.in_conv)  # all 5 are carried greedy admits

        # Ban 5 of the 15 carried participants. Q1 leak: the set is stored but
        # the pool, carry and clustering are unchanged — exactly as if Clojure
        # had processed the same stream.
        conv2 = conv.update_moderation({'mod_out_ptpts': list(banned)})

        assert conv2.mod_out_ptpts == banned     # stored ...
        clustered = _clustered_pids(conv2)
        assert banned.issubset(clustered)        # ... but still clustered
        assert conv2.in_conv == conv.in_conv     # carry untouched
        assert len(clustered) == 15              # pool unchanged, floor idle
