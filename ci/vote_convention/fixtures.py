"""The semantic fixture set of the two-convention gate (P-078 PR-F).

Every source declares the sign its committed bytes were written in. The loader
turns each raw value into a SEMANTIC vote (+1 agree, -1 disagree, 0 pass) with
``polismath.utils.vote_convention.semantic_vote`` and the source's declaration,
and later writes it back in the storage convention under test with
``storage_vote``. No fixture byte is rewritten; nothing here restates a sign.

Sources:

* ``pca2``: the 60 conversations of ``server/characterization/pca2-fixtures.json``,
  from the one definition of their draw (``server/characterization/pca2_votes.py``,
  shared with ``seed-pca2.py``) through its declaration ``pca2-fixtures.sign.json``.
* ``near_tie``, ``revote/<seed>``: the replay harness fixtures, through their
  ``*.sign.json`` companions (``delphi/tests/vote_fixtures.load_declared``).
* ``battery/<name>``: the two real conversations of the public battery. Their
  ``*-votes.csv`` files are exports, already in the export sign (agree = +1,
  ``EXPORT_AGREE_VALUE``) and stay valid as committed.
"""
from __future__ import annotations

import csv
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "server/characterization"), str(ROOT / "delphi/tests")]

from polismath.utils.vote_convention import (  # noqa: E402  (PYTHONPATH=delphi)
    EXPORT_AGREE_VALUE,
    semantic_vote,
)
import pca2_votes  # noqa: E402  (the pca2 draw, declared)
from vote_fixtures import load_declared, read_vote  # noqa: E402  (the fixture vote helper)

CLOCK = 1700000000000  # seed-pca2.py's pinned clock
GATE_MATH_ENV = "p027"  # the server reads this math_env; pca2 rows keep their own


@dataclass
class Conversation:
    zid: int
    source: str
    owner: int
    topic: str
    created: int
    participants: int  # pids 0..participants-1 exist
    comments: List[Tuple[int, int, int, int]]  # (tid, author_pid, mod, created)
    votes: List[Tuple[int, int, int, int]]  # (pid, tid, SEMANTIC vote, created)
    capability: Optional[str] = None
    math_env: Optional[str] = None  # None: no math row is computed
    math_publications: int = 1
    replay: Optional[dict] = None  # recorded expectations, for the replay check
    uids: List[int] = field(default_factory=list)
    comment_txt: Dict[int, str] = field(default_factory=dict)


def _semantic_rows(rows, agree_value: int):
    return [(int(p), int(t), read_vote(v, agree_value), int(c)) for p, t, v, c in rows]


def pca2() -> List[Conversation]:
    out = []
    for f in pca2_votes.fixtures():
        zid, nc, npart = f["zid"], f["comments"], f["participants"]
        votes = [(pid, tid, vote, CLOCK) for pid, tid, vote in pca2_votes.semantic_votes(f)]
        mod = 0 if f["shape"] == "zero-approved" else 1
        out.append(Conversation(
            zid=zid, source="pca2", owner=4 if f["shape"] == "foreign" else 1,
            topic=f"Generated PCA fixture {zid}", created=CLOCK + zid * 1000, participants=npart,
            comments=[(tid, 0, mod, CLOCK) for tid in range(nc)], votes=votes,
            capability=f["capability"], math_env=f["rowMathEnv"], math_publications=2,
            uids=[1, 2, 3] + [zid * 100 + i for i in range(3, npart)],
            comment_txt={tid: f"Generated fixture {zid} statement {tid}" for tid in range(nc)}))
    return out


def _stream(zid: int, source: str, rows, replay=None) -> Conversation:
    pids = {p for p, _, _, _ in rows}
    tids = {t for _, t, _, _ in rows}
    first = min(c for _, _, _, c in rows)
    # The tid_auto trigger numbers comments densely from 0: a tid no vote names
    # is moderated out so it never enters the math.
    comments = [(t, 0, 0 if t in tids else -1, first) for t in range(max(tids) + 1)]
    return Conversation(
        zid=zid, source=source, owner=1, topic=f"Generated replay fixture {source}", created=first,
        participants=max(pids) + 1, comments=comments, votes=rows,
        capability=f"2gate{zid}", math_env=GATE_MATH_ENV, replay=replay,
        uids=[zid * 1000 + p for p in range(max(pids) + 1)],
        comment_txt={t: f"Generated replay statement {t}" for t in range(max(tids) + 1)})


def replay_fixtures() -> List[Conversation]:
    base = ROOT / "delphi/tests/replay_harness/fixtures"
    out = []
    near, s = load_declared(base / "near_tie_votes.sign.json")
    out.append(_stream(9001, "near_tie", _semantic_rows(near["votes"], s), replay={"cuts": near["cuts"]}))
    revote, s = load_declared(base / "revote_column_order.sign.json")
    for i, case in enumerate(revote["cases"]):
        out.append(_stream(9101 + i, f"revote/{case['seed']}", _semantic_rows(case["votes"], s),
                           replay={"cuts": case["cuts"], "expected": case["expected"]}))
    return out


BATTERY = {
    "biodiversity": ("delphi/real_data/r4tykwac8thvzv35jrn53-biodiversity", 9201),
    "vw": ("delphi/real_data/r6vbnhffkxbd7ifmfbdrd-vw", 9202),
}


def battery() -> List[Conversation]:
    out = []
    for name, (rel, zid) in BATTERY.items():
        directory = ROOT / rel
        votes_csv = next(directory.glob("*-votes.csv"))
        comments_csv = next(directory.glob("*-comments.csv"))
        votes = []
        with votes_csv.open(newline="") as fh:
            for row in csv.DictReader(fh):
                # Export file: already semantic (EXPORT_AGREE_VALUE = +1).
                semantic = int(semantic_vote(int(row["vote"]), EXPORT_AGREE_VALUE))
                votes.append((int(row["voter-id"]), int(row["comment-id"]), semantic, int(row["timestamp"]) * 1000))
        comments, txt = {}, {}
        with comments_csv.open(newline="") as fh:
            for row in csv.DictReader(fh):
                tid = int(row["comment-id"])
                comments[tid] = (tid, int(row["author-id"]), int(row["moderated"]), int(row["timestamp"]) * 1000)
                txt[tid] = row["comment-body"]
        voted = {t for _, t, _, _ in votes}
        top = max(set(comments) | voted)
        first = min(c for _, _, _, c in votes)
        for tid in range(top + 1):  # tids are dense in the table; absent ones are moderated out
            if tid not in comments:
                comments[tid] = (tid, 0, -1, first)
                txt[tid] = f"Absent from the export {tid}"
        npart = max([p for p, _, _, _ in votes] + [c[1] for c in comments.values()]) + 1
        out.append(Conversation(
            zid=zid, source=f"battery/{name}", owner=1, topic=f"Public battery {name}", created=first,
            participants=npart, comments=[comments[t] for t in sorted(comments)], votes=votes,
            capability=f"2gate{zid}", math_env=GATE_MATH_ENV,
            uids=[zid * 1000 + p for p in range(npart)], comment_txt=txt))
    return out


def all_conversations() -> List[Conversation]:
    return pca2() + replay_fixtures() + battery()
