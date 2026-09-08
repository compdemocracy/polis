"""Checkout locator for the projection-gate scripts tests.

The implementations live in ``delphi/scripts/`` (``projection_gate.py``,
``projection_inventory.py``; the Node witness is ``server/scripts/projection-gate-witness.mjs``). The Delphi CI
job does NOT copy into ``/app/tests`` (it copies only ``delphi/tests``). So these
test modules need a real polis CHECKOUT. This conftest locates it
(``POLIS_CHECKOUT_DIR`` override, else walk up for
``delphi/scripts/projection_inventory.py``) and puts ``<checkout>/delphi/scripts`` on
``sys.path`` so the modules import. It NEVER raises during collection: when no
checkout is found it does nothing, and each test module FAILS CLOSED to
``pytest.skip`` (its ``import`` is guarded) with a reason naming what was missing —
so the copied ``/app/tests`` layout skips cleanly instead of erroring at import. An
explicit but unusable ``POLIS_CHECKOUT_DIR`` is a hard ``UsageError``, not a silent
skip. This does NOT shadow the root ``delphi/tests/conftest.py``.
"""

import os
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve()
_MARKER = "delphi/scripts/projection_inventory.py"


def _locate_checkout():
    """Return (root, fatal_reason). Never raises, never exits."""
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    if override:
        root = Path(override).expanduser()
        if (root / _MARKER).is_file():
            return root.resolve(), None
        return None, (
            f"POLIS_CHECKOUT_DIR={override!r} does not contain {_MARKER}; unset it or "
            "point it at a polis checkout"
        )
    for candidate in _HERE.parents:
        if (candidate / _MARKER).is_file():
            return candidate, None
    return None, None


CHECKOUT, _FATAL = _locate_checkout()

if CHECKOUT is not None:
    _scripts = str(CHECKOUT / "delphi" / "scripts")
    if _scripts not in sys.path:
        sys.path.insert(0, _scripts)


def pytest_configure(config):
    # An explicit but unusable override fails the run cleanly rather than skipping.
    if _FATAL:
        raise pytest.UsageError(_FATAL)
