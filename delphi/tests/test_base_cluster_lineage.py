#!/usr/bin/env python3
"""
Integration tests for base-cluster lineage + warm start in 'clojure-legacy'
mode (PR-C).

Clojure threads the previous tick's clusters back into k-means as
``:last-clusters`` at BOTH levels (conversation.clj:403-410 base,
conversation.clj:433-445 group), giving clusters STABLE ids across ticks. The
pre-PR Python legacy branch recomputed clusters COLD every tick (kmeans_sklearn
with no warm start), so no lineage was threaded. This module verifies:

  1. Cold first tick: legacy base + group partitions equal improved mode
     (the cold-start invariant — measured identical on vw and synthetic data).
  2. Warm-start threading: in legacy mode the ported legacy_kmeans is called
     with the prior tick's clusters as last_clusters (base and per-k group); in
     improved mode it is never called.
  3. self.group_clusterings holds id-carrying cluster dicts (legacy value type),
     not the (labels, centers, member_lists, silhouette) tuple.
  4. Base-cluster ids are stable across chained update_votes and new
     participants receive strictly larger ids (lineage).
"""

import os
import sys

import numpy as np
import pytest

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

import polismath.conversation.conversation as conv_mod
from polismath.conversation.conversation import Conversation
from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR
from polismath.pca_kmeans_rep.pca import PCA_IMPL_ENV_VAR


def _many_ptpt_votes(n_ptpts=18, n_cmnts=8):
    """18 distinct ternary vote rows (3 group signatures + unique bits) -> base
    k-means yields singleton base clusters and group clusterings for k in {2,3}
    (mirrors the fixture in test_group_k_smoother.py)."""
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


def _partition(clusters):
    return sorted(sorted(str(m) for m in c['members']) for c in clusters)


def _pid_to_base_id(conv):
    return {str(m): c['id'] for c in conv.base_clusters for m in c['members']}


# ---------------------------------------------------------------------------
# 1. Cold-start invariance gate (base + group)
# ---------------------------------------------------------------------------

class TestColdStartInvariance:

    def _run(self, monkeypatch, mode):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)  # default (powerit) both modes
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, mode)
        return Conversation('cold').update_votes(_many_ptpt_votes())

    def test_legacy_base_is_clojure_faithful_up_to_q11_merges(self, monkeypatch):
        # base-k (=100) >= n_ptpts, so every DISTINCT projection becomes its own
        # base cluster — EXCEPT near-duplicates whose vectorz-formula distance
        # cancels to exactly 0.0: those TIE against multiple clusters and merge
        # into the later one (CLOJURE_QUIRKS.md Q11; this fixture's
        # near-duplicate pair does cancel). The pre-Q11 version of this test
        # asserted all-singletons, believing that was the Clojure behavior —
        # the in-process probe of 2026-07-22 showed Clojure merges. Assertion:
        # no empty clusters, every participant clustered exactly once, and any
        # multi-member cluster holds only points at Q11-distance 0.0 from each
        # other (a merge is only ever the Q11 tie, never a real collapse).
        from polismath.pca_kmeans_rep.legacy_kmeans import _euclidean

        leg = self._run(monkeypatch, 'clojure-legacy')
        assert all(c['members'] for c in leg.base_clusters)  # no empty clusters
        all_members = [m for c in leg.base_clusters for m in c['members']]
        assert sorted(all_members) == sorted(f'p{i}' for i in range(18))
        assert any(len(c['members']) > 1 for c in leg.base_clusters), (
            "fixture must exercise at least one Q11 merge, or this test passes vacuously"
        )
        pos = {pid: np.asarray(proj) for pid, proj in leg.proj.items()}
        for c in leg.base_clusters:
            for m1 in c['members']:
                for m2 in c['members']:
                    assert _euclidean(pos[m1], pos[m2]) == 0.0

    def test_group_clustering_is_deterministic_in_legacy(self, monkeypatch):
        # NOTE (semantic finding): the GROUP level runs real k-means (k<<n_base),
        # so the ported legacy_kmeans and sklearn can reach different Lloyd fixed
        # points on degenerate data (this 18-ptpt set has near-duplicate points).
        # They matched on vw (k=2..5) but need NOT match here — and legacy is the
        # Clojure-faithful one, so we do NOT assert legacy==improved at the group
        # level. We DO assert legacy group clustering is deterministic run-to-run.
        leg1 = self._run(monkeypatch, 'clojure-legacy')
        leg2 = self._run(monkeypatch, 'clojure-legacy')
        assert _partition(leg1.group_clusters) == _partition(leg2.group_clusters)


# ---------------------------------------------------------------------------
# 2/3. Warm-start threading of legacy_kmeans
# ---------------------------------------------------------------------------

class _KmeansSpy:
    """Wrap conv_mod.legacy_kmeans, recording (weights_is_none, last_is_none)
    per call while running the real port. Base-level calls pass weights=None;
    group-level calls pass a weights dict."""

    def __init__(self, real):
        self.real = real
        self.calls = []  # list of dicts: {'level', 'last_is_none'}

    def __call__(self, data, k, last_clusters=None, weights=None, max_iters=20):
        level = 'base' if weights is None else 'group'
        self.calls.append({'level': level, 'last_is_none': last_clusters is None})
        return self.real(data, k, last_clusters=last_clusters,
                         weights=weights, max_iters=max_iters)


class TestWarmStartThreading:

    def _spy(self, monkeypatch):
        spy = _KmeansSpy(conv_mod.legacy_kmeans)
        monkeypatch.setattr(conv_mod, 'legacy_kmeans', spy)
        return spy

    def test_improved_never_calls_legacy_kmeans(self, monkeypatch):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'improved')
        spy = self._spy(monkeypatch)
        Conversation('x').update_votes(_many_ptpt_votes())
        assert spy.calls == []

    def test_legacy_base_warm_start_threaded(self, monkeypatch):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'clojure-legacy')
        spy = self._spy(monkeypatch)
        conv = Conversation('x').update_votes(_many_ptpt_votes())
        base_calls = [c for c in spy.calls if c['level'] == 'base']
        assert len(base_calls) == 1
        assert base_calls[0]['last_is_none'] is True  # cold first tick

        spy.calls.clear()
        conv.update_votes({'votes': [{'pid': 'p0', 'tid': 'c0', 'vote': 1.0}]})
        base_calls = [c for c in spy.calls if c['level'] == 'base']
        assert len(base_calls) == 1
        assert base_calls[0]['last_is_none'] is False  # warm-started from tick 1

    def test_legacy_group_warm_start_threaded(self, monkeypatch):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'clojure-legacy')
        spy = self._spy(monkeypatch)
        conv = Conversation('x').update_votes(_many_ptpt_votes())
        group_calls = [c for c in spy.calls if c['level'] == 'group']
        assert len(group_calls) >= 2  # one per k in {2,3}
        assert all(c['last_is_none'] for c in group_calls)  # tick 1: all cold

        spy.calls.clear()
        conv.update_votes({'votes': [{'pid': 'p0', 'tid': 'c0', 'vote': 1.0}]})
        group_calls = [c for c in spy.calls if c['level'] == 'group']
        assert len(group_calls) >= 2
        # tick 2: each per-k group clustering warm-started from tick-1's k-clustering
        assert all(c['last_is_none'] is False for c in group_calls)

    def test_group_clusterings_are_id_carrying_dicts(self, monkeypatch):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'clojure-legacy')
        conv = Conversation('x').update_votes(_many_ptpt_votes())
        assert set(conv.group_clusterings.keys()) == {2, 3}
        for k, clustering in conv.group_clusterings.items():
            assert isinstance(clustering, list)
            for c in clustering:
                assert set(c.keys()) >= {'id', 'members', 'center'}


# ---------------------------------------------------------------------------
# 4. Base-cluster id lineage across ticks
# ---------------------------------------------------------------------------

class TestBaseIdLineage:

    def _votes(self, indexed_pids, n_cmnts=6):
        """Each (global_index, pid) votes on ALL comments (so threshold
        min(7,n)=n qualifies everyone), with a signature keyed on the GLOBAL
        index so every pid is distinct -> singleton base clusters."""
        votes = []
        for idx, pid in indexed_pids:
            for j in range(n_cmnts):
                v = 1.0 if ((idx >> j) & 1) else -1.0
                votes.append({'pid': pid, 'tid': f'c{j}', 'vote': v})
        return {'votes': votes}

    def test_ids_stable_and_new_participant_gets_larger_id(self, monkeypatch):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'clojure-legacy')

        conv = Conversation('lineage').update_votes(
            self._votes([(i, f'p{i}') for i in range(5)]))
        m1 = _pid_to_base_id(conv)
        assert len(m1) == 5  # 5 singleton base clusters

        # Add one brand-new participant p5 with a distinct signature (index 5).
        conv = conv.update_votes(self._votes([(5, 'p5')]))
        m2 = _pid_to_base_id(conv)

        # Existing participants keep their base-cluster ids (lineage).
        for pid in [f'p{i}' for i in range(5)]:
            assert m2[pid] == m1[pid], (pid, m1[pid], m2.get(pid))
        # The new participant gets a strictly larger id (new lineage id).
        assert m2['p5'] > max(m1.values())


# ---------------------------------------------------------------------------
# 5. vw real-data cold-start invariance (base AND group), the documented gate.
# ---------------------------------------------------------------------------

class TestVwColdStartInvariance:
    """On vw (67 in-conv participants -> 67 singleton base clusters; groups for
    k=2..5), cold legacy clustering was measured bit-identical to improved mode
    at BOTH levels. Locked in here; skips if the committed vw dataset is absent.
    """

    def _vw_conv(self, monkeypatch, mode):
        try:
            from polismath.replay.real_data import load_export_votes
            ds = load_export_votes('vw')
        except (ImportError, FileNotFoundError):
            pytest.skip('vw dataset unavailable')
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, mode)
        votes = [{'pid': v.pid, 'tid': v.tid, 'vote': v.sign, 'created': v.t_ms}
                 for v in ds.votes]
        return Conversation('vw').update_votes({'votes': votes})

    def test_vw_base_and_group_identical_across_modes(self, monkeypatch):
        imp = self._vw_conv(monkeypatch, 'improved')
        leg = self._vw_conv(monkeypatch, 'clojure-legacy')
        assert _partition(imp.base_clusters) == _partition(leg.base_clusters)
        assert _partition(imp.group_clusters) == _partition(leg.group_clusters)
