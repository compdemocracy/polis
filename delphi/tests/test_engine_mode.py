#!/usr/bin/env python3
"""
Tests for the POLISMATH_ENGINE_MODE switch (Clojure-parity warm-start vs
improved cold-recompute) and the cold-start invariance guard.

The engine mode selects between two families of behavior:
  - 'improved'       (default): full cold recompute every tick — today's behavior.
  - 'clojure-legacy'         : threads warm-start state across ticks, matching
                               Clojure (PCA :start-vectors, group-k-smoother).

On the FIRST tick (cold start) the two modes MUST coincide, because Clojure's
warm-start state is empty on the first tick (no previous comps, no smoother
state). This module asserts:
  1. Flag resolution semantics (default, valid, invalid, case/whitespace,
     read-at-call-time) — mirrors tests/test_powerit_pca.py::TestPcaImplFlag.
  2. Cold-start invariance: a single-shot vw pipeline run is identical under
     both modes (guards the warm-start commits from diverging on the first tick).

     Since PR-C the legacy clustering computes cluster CENTERS via the ported
     Clojure weighted-mean (np.average) instead of sklearn's centroid. On vw the
     cold clustering STRUCTURE is bit-identical across modes (same base/group
     memberships, ids, counts, and all downstream repness/priorities/group-votes)
     but the center COORDINATES differ at floating-point precision (~1e-13:
     e.g. group center y 2.0147429038868094 vs 2.01474290388681). The invariance
     check therefore compares numbers with a tight tolerance and everything else
     (ids, memberships, strings) exactly — a real structural regression (a moved
     participant, a relabelled cluster) still fails.
"""

import os
import sys

import pytest

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.utils.engine_mode import (
    ENGINE_MODE_ENV_VAR,
    ENGINE_MODE_LEGACY,
    ENGINE_MODE_IMPROVED,
    ENGINE_MODE_DEFAULT,
    ENGINE_MODE_CHOICES,
    resolve_engine_mode,
)


# ---------------------------------------------------------------------------
# POLISMATH_ENGINE_MODE flag resolution
# ---------------------------------------------------------------------------

class TestEngineModeFlag:

    def test_default_is_improved(self, monkeypatch):
        """Unset env var -> 'improved' (today's behavior is the default)."""
        monkeypatch.delenv(ENGINE_MODE_ENV_VAR, raising=False)
        assert resolve_engine_mode() == ENGINE_MODE_IMPROVED
        assert ENGINE_MODE_DEFAULT == ENGINE_MODE_IMPROVED

    def test_legacy_flag_selects_legacy(self, monkeypatch):
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, ENGINE_MODE_LEGACY)
        assert resolve_engine_mode() == ENGINE_MODE_LEGACY

    def test_improved_flag_selects_improved(self, monkeypatch):
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, ENGINE_MODE_IMPROVED)
        assert resolve_engine_mode() == ENGINE_MODE_IMPROVED

    def test_invalid_flag_value_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'not-a-mode')
        assert resolve_engine_mode() == ENGINE_MODE_DEFAULT

    def test_case_and_whitespace_insensitive(self, monkeypatch):
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, '  Clojure-Legacy  ')
        assert resolve_engine_mode() == ENGINE_MODE_LEGACY

    def test_flag_read_at_call_time(self, monkeypatch):
        """Env var read per call, not cached at import time."""
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, ENGINE_MODE_LEGACY)
        assert resolve_engine_mode() == ENGINE_MODE_LEGACY
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, ENGINE_MODE_IMPROVED)
        assert resolve_engine_mode() == ENGINE_MODE_IMPROVED

    def test_choices_are_exactly_the_two_modes(self):
        assert set(ENGINE_MODE_CHOICES) == {ENGINE_MODE_LEGACY, ENGINE_MODE_IMPROVED}


# ---------------------------------------------------------------------------
# Cold-start invariance: improved vs clojure-legacy must coincide on tick 1
# ---------------------------------------------------------------------------

def _strip_volatile(d):
    """Remove wall-clock fields that legitimately differ between two runs.

    `math_tick` is `25000 + (time_ms % 10000)` (conversation.py:1985) and
    `last_updated` is a wall-clock timestamp — both are version counters, not
    math output, so they are expected to differ between two independent runs.
    """
    d = dict(d)
    d.pop('last_updated', None)
    d.pop('math_tick', None)
    return d


# Tolerance for cluster-center coordinates (see module docstring): PR-C's ported
# weighted-mean and sklearn's centroid agree to ~1e-13 on identical memberships;
# 1e-6 is far below any real structural divergence yet absorbs the float noise.
_COLD_IDENTITY_TOL = 1e-6


def _almost_equal(a, b, path='', tol=_COLD_IDENTITY_TOL):
    """Deep equality that tolerates float noise in numbers but is EXACT on
    everything else (dict keys, list lengths, strings, ints such as cluster ids).

    Returns (ok, message).
    """
    # bool is an int subclass — treat it as exact, not numeric-tolerant.
    if isinstance(a, bool) or isinstance(b, bool):
        return (a == b, f"{path}: {a!r} != {b!r}")
    # int-vs-int compares EXACTLY (ids, counts): a relative tolerance would
    # accept e.g. two large cluster ids that differ. Mixed int/float (0 vs 0.0
    # from a JSON round-trip) still takes the tolerant branch below.
    if isinstance(a, int) and isinstance(b, int):
        return (a == b, f"{path}: {a!r} != {b!r} (int exact)")
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if abs(float(a) - float(b)) <= tol * max(1.0, abs(a), abs(b)):
            return (True, '')
        return (False, f"{path}: {a!r} != {b!r} (>|tol|)")
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            return (False, f"{path}: dict keys differ {set(a) ^ set(b)}")
        for k in a:
            ok, msg = _almost_equal(a[k], b[k], f"{path}.{k}", tol)
            if not ok:
                return (ok, msg)
        return (True, '')
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        if len(a) != len(b):
            return (False, f"{path}: length {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            ok, msg = _almost_equal(x, y, f"{path}[{i}]", tol)
            if not ok:
                return (ok, msg)
        return (True, '')
    return (a == b, f"{path}: {a!r} != {b!r}")


class TestColdStartInvariance:
    """A single-shot (first-tick) pipeline run must be identical under both
    engine modes UP TO floating-point cluster-center coordinates (see module
    docstring). Structure — every id, membership, count, and all downstream
    outputs — must be bit-identical. This is the hard gate protecting 'improved'
    mode from any structural drift introduced by the legacy warm-start plumbing.
    """

    def _recompute_to_dict(self, monkeypatch, mode):
        from common_utils import create_test_conversation
        monkeypatch.setenv(ENGINE_MODE_ENV_VAR, mode)
        conv = create_test_conversation('vw')
        # Pin last_updated so the two runs share a deterministic value.
        conv.last_updated = 0
        result = conv.recompute()
        return _strip_volatile(result.to_dict())

    def test_vw_cold_run_identical_across_modes(self, monkeypatch):
        improved = self._recompute_to_dict(monkeypatch, ENGINE_MODE_IMPROVED)
        legacy = self._recompute_to_dict(monkeypatch, ENGINE_MODE_LEGACY)
        ok, msg = _almost_equal(improved, legacy)
        assert ok, (
            "Cold-start (first-tick) vw run diverged STRUCTURALLY between "
            "'improved' and 'clojure-legacy' engine modes (beyond float-level "
            f"cluster centers): {msg}"
        )

    def test_vw_cold_structure_bit_identical_ignoring_centers(self, monkeypatch):
        """Belt-and-braces: with cluster CENTER coordinates dropped, the two cold
        blobs are EXACTLY equal — proving the ~1e-13 divergence is confined to
        center coordinates and nothing structural moved."""
        improved = _drop_centers(self._recompute_to_dict(monkeypatch, ENGINE_MODE_IMPROVED))
        legacy = _drop_centers(self._recompute_to_dict(monkeypatch, ENGINE_MODE_LEGACY))
        assert improved == legacy


def _drop_centers(d):
    """Recursively drop cluster-center coordinate fields ('center', 'x', 'y')
    so the remaining structure (ids, members, counts, downstream) is compared
    exactly. base-clusters are folded to {id, members, x, y, count}; group
    clusters carry {id, members, center}."""
    if isinstance(d, dict):
        return {k: _drop_centers(v) for k, v in d.items()
                if k not in ('center', 'x', 'y')}
    if isinstance(d, list):
        return [_drop_centers(v) for v in d]
    return d
