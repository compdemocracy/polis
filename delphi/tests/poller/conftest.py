"""Shared fixtures for the poller test suite.

Test-isolation guard: `MathPollerService.apply_engine_mode()` writes
`POLISMATH_ENGINE_MODE` into `os.environ` for the life of the process (the
service is a long-running daemon in production, so it has no reason to restore
it). Under pytest's single serial process, any poller test that constructs a
service with `engine_mode="clojure-legacy"` would otherwise leak legacy mode
into every later-collected test — flipping e.g. the in-conv greedy floor on
tests that assume the default 'improved' mode (this exact leak broke
TestD2cVoteCountSource in CI once #2637 made the postgres integration test run
there instead of skipping).
"""

import os

import pytest

from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR


@pytest.fixture(autouse=True)
def _restore_engine_mode_env():
    """Snapshot and restore POLISMATH_ENGINE_MODE around every poller test."""
    was_set = ENGINE_MODE_ENV_VAR in os.environ
    saved = os.environ.get(ENGINE_MODE_ENV_VAR, "")
    yield
    if was_set:
        os.environ[ENGINE_MODE_ENV_VAR] = saved
    else:
        os.environ.pop(ENGINE_MODE_ENV_VAR, None)
