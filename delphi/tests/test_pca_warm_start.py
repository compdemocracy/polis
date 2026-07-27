#!/usr/bin/env python3
"""
Tests for PCA warm-start threading in 'clojure-legacy' engine mode (PR-B).

Clojure warm-starts the power-iteration PCA with the PREVIOUS tick's
post-normalization unit components (conversation.clj:381-387 passes
:start-vectors (get-in conv [:pca :comps]) into powerit-pca, pca.clj:86-105).
Python already supports start_vectors in powerit_pca, but no production caller
passed them — every tick ran cold. This module verifies:

  1. pca_project_dataframe threads start_vectors into powerit_pca, and refuses
     to run sklearn when warm-start vectors are required (sklearn cannot inject
     start vectors) — it warns and falls back to power iteration.
  2. A second recompute tick feeds tick-1's comps to powerit_pca as
     start_vectors (the engine's only path since the mode collapse; the
     former improved-mode cold recompute is parked:
     POST_CUTOVER_IMPROVEMENTS.md item 8).
  3. Warm-started tick-2 comps stay close in angle to tick-1 (reduced jitter).
"""

import os
import sys

import numpy as np
import pytest

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

import polismath.pca_kmeans_rep.pca as pca_mod
from polismath.pca_kmeans_rep.pca import (
    pca_project_dataframe,
    PCA_IMPL_ENV_VAR,
)
from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR
from polismath.conversation.conversation import Conversation


# ---------------------------------------------------------------------------
# Synthetic two-group data helpers
# ---------------------------------------------------------------------------

def _two_group_votes(pids, tids, group_a):
    """Group A agrees on the first half of tids, disagrees on the second half;
    group B is the mirror image. Gives a clean 1-D PCA separation."""
    votes = []
    half = len(tids) // 2
    for pid in pids:
        in_a = pid in group_a
        for j, tid in enumerate(tids):
            first_half = j < half
            # A: +1 on first half, -1 on second; B: mirror.
            v = 1.0 if (first_half == in_a) else -1.0
            votes.append({'pid': pid, 'tid': tid, 'vote': v})
    return {'votes': votes}


def _spy_powerit(monkeypatch):
    """Wrap pca.powerit_pca to record the start_vectors of every call while
    still running the real computation."""
    recorded = []
    real = pca_mod.powerit_pca

    def spy(matrix, n_comps=2, iters=100, start_vectors=None):
        recorded.append(start_vectors)
        return real(matrix, n_comps=n_comps, iters=iters, start_vectors=start_vectors)

    monkeypatch.setattr(pca_mod, 'powerit_pca', spy)
    return recorded


def _angle_deg(u, v):
    u = np.asarray(u, dtype=float)
    v = np.asarray(v, dtype=float)
    c = np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-300)
    return np.degrees(np.arccos(np.clip(abs(c), -1.0, 1.0)))


# ---------------------------------------------------------------------------
# 1. pca_project_dataframe: start_vectors threading + sklearn conflict
# ---------------------------------------------------------------------------

class TestDataframeStartVectors:

    def _df(self):
        import pandas as pd
        rng = np.random.default_rng(0)
        # 8 ptpts x 5 comments, two clear blocks.
        block = np.vstack([np.ones((4, 5)), -np.ones((4, 5))])
        block[:, 2] *= -1  # break perfect collinearity a bit
        noise = rng.normal(scale=0.01, size=block.shape)
        return pd.DataFrame(block + noise,
                            index=[f'p{i}' for i in range(8)],
                            columns=[f'c{j}' for j in range(5)])

    def test_start_vectors_reach_powerit(self, monkeypatch):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        recorded = _spy_powerit(monkeypatch)
        df = self._df()
        sv = np.ones((2, 5))
        pca_project_dataframe(df, n_comps=2, start_vectors=sv)
        assert len(recorded) == 1
        assert recorded[0] is not None
        np.testing.assert_array_equal(np.asarray(recorded[0]), sv)

    def test_default_start_vectors_none(self, monkeypatch):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        recorded = _spy_powerit(monkeypatch)
        df = self._df()
        pca_project_dataframe(df, n_comps=2)
        assert recorded == [None]

    def test_require_powerit_overrides_sklearn_with_warning(self, monkeypatch, caplog):
        """When warm-start vectors are supplied but POLISMATH_PCA_IMPL=sklearn,
        the solver must fall back to power iteration (sklearn cannot inject a
        start vector) and log a warning."""
        monkeypatch.setenv(PCA_IMPL_ENV_VAR, 'sklearn')
        recorded = _spy_powerit(monkeypatch)
        df = self._df()
        sv = np.ones((2, 5))
        with caplog.at_level('WARNING'):
            pca_project_dataframe(df, n_comps=2, start_vectors=sv, require_powerit=True)
        # powerit was actually called (sklearn branch would not touch it)
        assert len(recorded) == 1
        assert recorded[0] is not None
        # ... and the fallback was announced (sklearn cannot inject warm start).
        assert any(r.levelname == 'WARNING' and 'cannot inject the provided warm-start' in r.getMessage()
                   for r in caplog.records)

    def test_require_powerit_cold_warning_wording(self, monkeypatch, caplog):
        """Same sklearn conflict on a COLD tick (require_powerit=True, no
        start vectors): the warning must not claim vectors were supplied."""
        monkeypatch.setenv(PCA_IMPL_ENV_VAR, 'sklearn')
        recorded = _spy_powerit(monkeypatch)
        df = self._df()
        with caplog.at_level('WARNING'):
            pca_project_dataframe(df, n_comps=2, require_powerit=True)
        assert len(recorded) == 1
        assert recorded[0] is None
        msgs = [r.getMessage() for r in caplog.records if r.levelname == 'WARNING']
        assert any('require_powerit' in m for m in msgs)
        assert not any('provided warm-start' in m for m in msgs)

    def test_improved_path_byte_identical(self, monkeypatch):
        """No start_vectors + no require_powerit == exactly the pre-PR behavior."""
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        df = self._df()
        base, _ = pca_project_dataframe(df, n_comps=2)
        same, _ = pca_project_dataframe(df, n_comps=2, start_vectors=None,
                                        require_powerit=False)
        np.testing.assert_array_equal(base['comps'], same['comps'])
        np.testing.assert_array_equal(base['center'], same['center'])


# ---------------------------------------------------------------------------
# 2/3/4. Two-tick chained recompute through the Conversation pipeline
# ---------------------------------------------------------------------------

class TestChainedWarmStart:

    PIDS = [f'p{i}' for i in range(6)]
    TIDS = [f'c{j}' for j in range(4)]
    GROUP_A = {'p0', 'p1', 'p2'}

    def _tick1(self):
        return _two_group_votes(self.PIDS, self.TIDS, self.GROUP_A)

    def _tick2_new_ptpt(self):
        # A new participant votes on the SAME comments (no new column), so the
        # warm-start vectors line up 1:1 with the current column set.
        return _two_group_votes(['p6'], self.TIDS, self.GROUP_A)

    def _run_two_ticks(self, monkeypatch, mode):
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, mode)
        recorded = _spy_powerit(monkeypatch)
        conv0 = Conversation('warm')
        conv1 = conv0.update_votes(self._tick1())
        conv2 = conv1.update_votes(self._tick2_new_ptpt())
        return conv1, conv2, recorded

    def test_legacy_tick2_receives_tick1_comps(self, monkeypatch):
        conv1, conv2, recorded = self._run_two_ticks(monkeypatch, 'clojure-legacy')
        assert len(recorded) == 2
        # Tick 1 is cold (no previous comps).
        assert recorded[0] is None
        # Tick 2 warm-starts from tick-1's comps.
        assert recorded[1] is not None
        np.testing.assert_allclose(np.asarray(recorded[1]),
                                   np.asarray(conv1.pca['comps']))

    def test_legacy_warm_comps_close_in_angle(self, monkeypatch):
        conv1, conv2, _ = self._run_two_ticks(monkeypatch, 'clojure-legacy')
        # Same column set across ticks, so comps are directly comparable.
        # Two perfectly-separable groups are rank-1, so PC2 is a degenerate
        # zero vector — skip components with ~no variance in either tick.
        comps1 = np.asarray(conv1.pca['comps'])
        comps2 = np.asarray(conv2.pca['comps'])
        checked = 0
        for i in range(len(comps1)):
            if np.linalg.norm(comps1[i]) > 1e-8 and np.linalg.norm(comps2[i]) > 1e-8:
                assert _angle_deg(comps1[i], comps2[i]) < 15.0
                checked += 1
        assert checked >= 1, "no non-degenerate component to compare"

    def test_legacy_prev_pca_without_comps_falls_back_to_cold(self, monkeypatch):
        """A prev_pca whose 'comps' is missing/None must NOT be turned into a
        np.asarray(None) garbage seed — it falls back to the cold draw."""
        monkeypatch.delenv(PCA_IMPL_ENV_VAR, raising=False)
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'clojure-legacy')
        recorded = _spy_powerit(monkeypatch)
        conv = Conversation('warm').update_votes(self._tick1())
        for degenerate in ({'center': None, 'comps': None}, {}):
            conv._compute_pca(prev_pca=degenerate)
            assert recorded[-1] is None, (
                f"prev_pca={degenerate!r} must cold-start, not seed powerit"
            )
