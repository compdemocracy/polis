"""The votes of the pca2 fixture conversations, by meaning (P-078 PR-G).

One definition of the draw, shared by the seed (``seed-pca2.py``) and the
two-convention gate (``ci/vote_convention/fixtures.py``), so the two can never
drift apart.

Each (pid, tid) cell of a fixture in ``pca2-fixtures.json`` is drawn with
``np.random.RandomState(seed).choice(DRAW, p=DRAW_P)``. Since the fixtures were
first recorded, that draw has been written into ``votes`` verbatim, so it is a
draw of STORED values under the convention declared in ``pca2-fixtures.sign.json``
(agree = -1). This module turns each draw into a semantic vote through that
declaration; the seed then stores it at the database's convention. At agree = -1
every stored byte, and so every pca2 recording, is unchanged.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Iterator, List, Tuple

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
COMPANION = HERE / "pca2-fixtures.sign.json"

#: The draw's support and weights, exactly as recorded (stored values).
DRAW = (-1, 0, 1)
DRAW_P = (0.45, 0.1, 0.45)


def _vote_fixtures():
    tests = str(ROOT / "delphi" / "tests")
    if tests not in sys.path:
        sys.path.insert(0, tests)
    import vote_fixtures

    return vote_fixtures


def declared_storage_agree_value() -> int:
    """The convention the draw is declared in (checked against the fixture bytes)."""
    return _vote_fixtures().declaration(COMPANION)["storage_agree_value"]


def fixtures() -> List[dict]:
    return json.loads((HERE / "pca2-fixtures.json").read_text())


def semantic_votes(fixture: dict) -> Iterator[Tuple[int, int, int]]:
    """(pid, tid, semantic vote) for every cell, in the seed's draw order."""
    import numpy as np

    vf = _vote_fixtures()
    declared = declared_storage_agree_value()
    rng = np.random.RandomState(fixture["seed"])
    for pid in range(fixture["participants"]):
        for tid in range(fixture["comments"]):
            drawn = int(rng.choice(list(DRAW), p=list(DRAW_P)))
            yield pid, tid, vf.read_vote(drawn, declared)
