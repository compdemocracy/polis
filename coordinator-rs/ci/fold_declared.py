"""The declared-sign adapter of the frozen fold oracle (P-078 §1d, PR-G).

The independent reference fold
``coordinator-rs/ci/pinned/aaaf7ca5…/delphi/tests/poller/recovery/fold.py.txt``
is immutable by its own rule (``pinned/README.md``) and states its storage sign
as a literal: ``RAW_AGREE = -1``. Its callers used to hand it rows straight from
``votes`` and let that literal decide what they mean, which is right only while
the database stores agree as -1.

This adapter does not edit the oracle. It loads the pinned bytes through
``reference_assets.load_asset`` (which refuses a changed or missing file), takes
the convention the rows were stored under as a DECLARATION, and feeds the oracle
the same votes re-expressed at the oracle's own sign
(``semantic × oracle.RAW_AGREE``), whatever the database convention is. The
oracle then folds exactly as it always has. Every caller of the oracle in the
repository goes through :func:`fold_votes_declared`; the oracle is retired when
the Rust fold replaces it.

Like the oracle, this module imports nothing from ``polismath``: it must not
inherit a sign from the code the oracle checks. Its agreement with
``polismath.utils.vote_convention`` is asserted by the gate's tests
(``ci/vote_convention/test_fixtures_declared.py``).
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = "aaaf7ca5c93f9a758b28e7a361c3b9544e24305a"
SOURCE = "delphi/tests/poller/recovery/fold.py"

#: The meanings a stored vote can carry, as the oracle's ENGINE values.
_SEMANTIC = (1, -1, 0)

_ORACLE: Optional[types.ModuleType] = None


def oracle() -> types.ModuleType:
    """The pinned fold module, loaded once from its checked bytes."""
    global _ORACLE
    if _ORACLE is None:
        here = str(Path(__file__).resolve().parent)
        if here not in sys.path:
            sys.path.insert(0, here)
        from reference_assets import load_asset

        module = types.ModuleType("pinned_fold")
        sys.modules["pinned_fold"] = module  # its dataclasses resolve their module by name
        exec(compile(load_asset(ROOT, REFERENCE, SOURCE), "pinned-fold.py", "exec"), module.__dict__)
        _ORACLE = module
    return _ORACLE


def declared(value: Any) -> int:
    """A storage convention: exactly the integer -1 or +1 (never a bool)."""
    if type(value) is not int or value not in (-1, 1):
        raise ValueError(f"storage_agree_value must be the integer -1 or +1, got {value!r}")
    return value


def oracle_rows(events: List[Dict[str, Any]], *, storage_agree_value: int,
                fold: Optional[types.ModuleType] = None) -> List[Dict[str, Any]]:
    """``events`` (stored under ``storage_agree_value``) re-expressed at the
    oracle's own sign. NULL and any value outside {-1, 0, +1} are refused: the
    oracle has no NULL policy and would read 2 as a disagree."""
    stored = declared(storage_agree_value)
    fold = fold or oracle()
    rows = []
    for ev in events:
        raw = ev["vote"]
        if raw is None:
            raise ValueError(f"NULL vote at pid={ev['pid']} tid={ev['tid']}: no declared NULL policy")
        if type(raw) is bool or int(raw) != raw or int(raw) not in _SEMANTIC:
            raise ValueError(f"vote {raw!r} at pid={ev['pid']} tid={ev['tid']} is not a stored vote")
        semantic = int(raw) * stored
        rows.append({**ev, "vote": semantic * fold.RAW_AGREE})
    return rows


def fold_votes_declared(events: List[Dict[str, Any]], *, storage_agree_value: int,
                        fold: Optional[types.ModuleType] = None):
    """Fold rows stored under ``storage_agree_value`` with the pinned oracle.

    ``fold`` is an already-loaded copy of the oracle (a caller that also uses its
    other functions passes its own); by default the one loaded here."""
    fold = fold or oracle()
    return fold.fold_votes(oracle_rows(events, storage_agree_value=storage_agree_value, fold=fold))


def fold_summary(fold) -> Dict[str, Any]:
    """The two math_main shapes the oracle exposes, keyed for stable bytes."""
    return {
        "per_comment_totals": {str(t): v for t, v in sorted(fold.per_comment_totals().items())},
        "user_vote_counts": {str(p): n for p, n in sorted(fold.user_vote_counts().items())},
        "event_count": fold.event_count,
        "last_vote_timestamp": fold.last_vote_timestamp,
        "ambiguous": sorted([list(c) for c in fold.ambiguous]),
    }
