"""Declared-sign companion of the frozen fold oracle (P-078 1d).

The independent reference fold
``coordinator-rs/ci/pinned/aaaf7ca5…/delphi/tests/poller/recovery/fold.py.txt``
is immutable by its own rule (``coordinator-rs/ci/pinned/README.md``) and states
its storage sign as a literal: ``RAW_AGREE = -1``. Every caller today hands it raw
rows and lets that literal decide what they mean. This companion does not edit
it: it loads the pinned bytes through ``reference_assets.load_asset`` (which
refuses a changed or missing file), takes the convention the rows were stored
under as a declaration, and feeds the oracle the same votes re-expressed in the
oracle's own declared sign. The oracle then runs exactly as its callers run it.

Like the oracle, this file imports nothing from ``polismath``; it is checked
against ``polismath.utils.vote_convention`` only by the gate's results.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = "aaaf7ca5c93f9a758b28e7a361c3b9544e24305a"
SOURCE = "delphi/tests/poller/recovery/fold.py"

_ORACLE = None


def oracle() -> types.ModuleType:
    """The pinned fold module, loaded once from its checked bytes."""
    global _ORACLE
    if _ORACLE is None:
        sys.path.insert(0, str(ROOT / "coordinator-rs/ci"))
        from reference_assets import load_asset

        module = types.ModuleType("pinned_fold")
        sys.modules["pinned_fold"] = module  # its dataclasses resolve their module by name
        exec(compile(load_asset(ROOT, REFERENCE, SOURCE), "pinned-fold.py", "exec"), module.__dict__)
        _ORACLE = module
    return _ORACLE


def _declared(value: Any) -> int:
    if type(value) is not int or value not in (-1, 1):
        raise ValueError(f"storage_agree_value must be the integer -1 or +1, got {value!r}")
    return value


def fold_votes_declared(events: List[Dict[str, Any]], *, storage_agree_value: int):
    """Fold rows stored under ``storage_agree_value``.

    Each raw vote becomes semantic (``raw × storage_agree_value``), then the
    oracle's raw form (``semantic × oracle.RAW_AGREE``). NULL is refused, as the
    oracle itself would fail on it.
    """
    stored = _declared(storage_agree_value)
    fold = oracle()
    rows = []
    for ev in events:
        if ev["vote"] is None:
            raise ValueError(f"NULL vote at pid={ev['pid']} tid={ev['tid']}: no declared NULL policy")
        semantic = int(ev["vote"]) * stored
        rows.append({**ev, "vote": semantic * fold.RAW_AGREE})
    return fold.fold_votes(rows)


def fold_summary(fold) -> Dict[str, Any]:
    """The two math_main shapes the oracle exposes, keyed for stable bytes."""
    return {
        "per_comment_totals": {str(t): v for t, v in sorted(fold.per_comment_totals().items())},
        "user_vote_counts": {str(p): n for p, n in sorted(fold.user_vote_counts().items())},
        "event_count": fold.event_count,
        "last_vote_timestamp": fold.last_vote_timestamp,
        "ambiguous": sorted([list(c) for c in fold.ambiguous]),
    }
