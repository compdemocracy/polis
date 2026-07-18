#!/usr/bin/env python3
"""
Tests for the POLISMATH_ENGINE_MODE switch (Clojure-parity warm-start vs
improved cold-recompute) and the cold-start invariance guard.

The engine mode selects between two families of behavior:
  - 'improved'       (default): full cold recompute every tick — today's behavior.
  - 'clojure-legacy'         : threads warm-start state across ticks, matching
                               Clojure (PCA :start-vectors, group-k-smoother).

On the FIRST tick (cold start) the two modes MUST coincide bit-for-bit, because
Clojure's warm-start state is empty on the first tick (no previous comps, no
smoother state). This module asserts:
  1. Flag resolution semantics (default, valid, invalid, case/whitespace,
     read-at-call-time) — mirrors tests/test_powerit_pca.py::TestPcaImplFlag.
  2. Cold-start invariance: a single-shot vw pipeline run is identical under
     both modes (guards commits 2 and 3 from diverging on the first tick).
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


class TestColdStartInvariance:
    """A single-shot (first-tick) pipeline run must be byte-identical under
    both engine modes. This is the hard gate protecting 'improved' mode from
    any drift introduced by the legacy warm-start plumbing."""

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
        assert improved == legacy, (
            "Cold-start (first-tick) vw run diverged between 'improved' and "
            "'clojure-legacy' engine modes; warm-start state must be empty on "
            "tick 1 so the two modes must coincide bit-for-bit."
        )
