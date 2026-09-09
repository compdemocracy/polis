"""Locator + no-shadow controls that DO NOT import the implementations, so they run
(and can fail) even when the checkout is absent — keeping the fatal-on-bad-override
signal and the shadow regression visible without aborting the global collection."""

from __future__ import annotations

import importlib
import importlib.util
import os

import pytest


def test_checkout_override_is_usable_when_set() -> None:
    """Astra's fatal-on-bad-override, scoped to this package: an EXPLICIT but
    unusable POLIS_CHECKOUT_DIR is a per-package FAILURE (the conftest records the
    reason), never a session-wide UsageError."""
    fatal = os.environ.get("PROJGATE_LOCATE_FATAL")
    if fatal:
        pytest.fail(fatal)


def test_real_scripts_package_is_not_shadowed() -> None:
    """Regression for the CI collection break: this test package must be named so it
    does NOT shadow the real top-level ``scripts`` namespace package (``delphi/scripts``)
    — `tests/topic_naming/test_job_routing.py` does `from scripts.job_poller import …`."""
    try:
        jp = importlib.import_module("scripts.job_poller")
    except ModuleNotFoundError as exc:
        # `scripts` not on this env's path at all -> not a shadow; skip. But if our
        # own test package were named `scripts`, the submodule would be missing while
        # `scripts` itself imports — treat that as the shadow failure.
        if exc.name == "scripts.job_poller" and importlib.util.find_spec("scripts") is not None:
            pytest.fail("real scripts.job_poller is shadowed: `scripts` resolves but "
                        "`scripts.job_poller` does not")
        pytest.skip(f"real scripts package not importable here ({exc})")
    assert hasattr(jp, "should_process_job"), jp
    resolved = os.path.dirname(os.path.abspath(jp.__file__)).replace(os.sep, "/")
    assert "/tests/" not in resolved, f"scripts.job_poller resolved into the tests tree: {resolved}"
