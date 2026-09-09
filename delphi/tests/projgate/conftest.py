"""Checkout locator for the projection-gate scripts tests.

The implementations live in ``delphi/scripts/`` (``projection_gate.py``,
``projection_inventory.py``; the Node witness is ``server/scripts/projection-gate-witness.mjs``).
The Delphi CI job does NOT copy those into ``/app/tests`` (it copies only
``delphi/tests``), so these test modules need a real polis CHECKOUT. This conftest
locates it (``POLIS_CHECKOUT_DIR`` override, else walk up for
``delphi/scripts/projection_inventory.py``) and puts ``<checkout>/delphi/scripts`` on
``sys.path`` so the modules import.

This package is named ``projgate`` (NOT ``scripts``) so it does not shadow the real
top-level ``scripts`` namespace package (``delphi/scripts``, e.g.
``from scripts.job_poller import …`` in ``tests/topic_naming``), and not
``projection_gate`` (which would collide with the implementation module).

It NEVER aborts the global pytest session: when no checkout is found it does nothing
(each module fails closed to a per-test skip via its guarded import); when an
EXPLICIT ``POLIS_CHECKOUT_DIR`` is set but unusable it records the reason in an env
var that ``test_checkout_locator.py`` turns into a per-package FAILURE — the second
reviewer's fatal-on-bad-override requirement, scoped to this package rather than a session-wide
``UsageError``.
"""

import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve()
_MARKER = "delphi/scripts/projection_inventory.py"
FATAL_ENV = "PROJGATE_LOCATE_FATAL"


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

# Signal a bad EXPLICIT override to test_checkout_locator.py (a per-package failure),
# rather than raising and aborting the whole Delphi collection. Clear it otherwise so
# a stale value from a prior invocation cannot leak in.
if _FATAL:
    os.environ[FATAL_ENV] = _FATAL
else:
    os.environ.pop(FATAL_ENV, None)
