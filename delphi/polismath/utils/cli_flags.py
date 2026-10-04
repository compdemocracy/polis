"""Command-line flag parsing shared by the Delphi job scripts.

``argparse``'s ``type=bool`` calls ``bool(text)``, and every non-empty string is
true, so ``--include_moderation=False`` used to parse as True. The job poller
passes these flags as ``--flag=True`` / ``--flag=False`` (Python's ``str`` of a
JSON boolean), so the scripts must read the text, not its truthiness.
"""

from __future__ import annotations

import argparse
from typing import Any

_TRUE = frozenset({"true", "1", "yes", "y", "on"})
_FALSE = frozenset({"false", "0", "no", "n", "off"})


def parse_bool_flag(value: Any) -> bool:
    """Parse a boolean flag value; refuse anything that is not clearly one.

    Accepts a real ``bool`` unchanged, and the strings true/false, 1/0, yes/no,
    y/n and on/off in any case. Anything else (including the empty string and
    ``None``) raises ``argparse.ArgumentTypeError`` rather than guessing.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
    raise argparse.ArgumentTypeError(
        f"expected a boolean (true/false), got {value!r}")
