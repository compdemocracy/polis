"""The selection a Delphi run lays out, clusters and names when its admission
names one (``run_pipeline.py --selection``).

A run that names a selection embeds every comment of its conversation, then
lays out (UMAP), clusters (EVoC), labels and stores only the comments the
selection keeps. ``participant_visible/1`` keeps what participants are shown:
the rule of the comment list the server gives participants,
``participantVisibleClause`` in ``server/src/comment.ts`` (lines 74-81), which
its plain list and that list's count apply as well. Active, not muted
(velocity above 0), and accepted under strict moderation or not rejected
otherwise. This is the one Python statement of the rule; the Rust one is
``participant_visible`` in ``queue-rs/polis-contracts/src/delphi_input_bundle.rs``,
and ``tests/fixtures/selection/participant_visible.json`` (written by the Rust
contract test) holds both to the same comments and the same digest.

The digest: sha256 over the header line, the selection's name line, then one
line per kept comment ordered by tid, ``tid\\tsha256(txt)\\n``. A moderation
that keeps the same comments leaves it as it was; one that keeps or drops
another comment changes it. Standard library only.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Tuple

PARTICIPANT_VISIBLE = "participant_visible/1"
#: Every selection an admission may name.
SELECTIONS = (PARTICIPANT_VISIBLE,)
SELECTION_FORMAT = "polis-jobs.selection/1"

#: ``comments.mod`` of a comment a moderator accepted (``polisTypes.mod.ok``).
MOD_ACCEPTED = 1
#: ``comments.mod`` of a comment a moderator rejected (``polisTypes.mod.ban``).
MOD_REJECTED = -1

#: Why a comment is left out, in the order the rule tests: the first that holds.
REASONS = ("inactive", "muted", "rejected", "unaccepted")


def participant_visible(active: Any, velocity: float, mod: int, strict_moderation: bool) -> bool:
    """Whether participants are shown a comment (``server/src/comment.ts:74-81``)."""
    if strict_moderation:
        moderated = mod == MOD_ACCEPTED
    else:
        moderated = mod != MOD_REJECTED
    return bool(active) and velocity > 0 and moderated


def _reason(comment: Mapping[str, Any], strict_moderation: bool) -> str:
    if not comment["active"]:
        return "inactive"
    if not comment["velocity"] > 0:
        return "muted"
    if int(comment["mod"]) == MOD_REJECTED:
        return "rejected"
    return "unaccepted"


@dataclass(frozen=True)
class Selection:
    """The comments one selection keeps."""

    name: str
    #: The kept comments' ids, ascending.
    tids: Tuple[int, ...]
    sha256: str
    #: How many comments were left out, by the first reason that held.
    left_out: Dict[str, int] = field(default_factory=dict)


def select(name: str, comments: Iterable[Mapping[str, Any]], strict_moderation: bool) -> Selection:
    """The selection ``name`` makes of ``comments`` (every comment of one
    conversation, each with its ``velocity``) under the conversation's
    ``strict_moderation``. A name that is not a selection, or a comment
    without its velocity, raises ValueError."""
    if name not in SELECTIONS:
        raise ValueError(f"selection {name!r} is not one of {', '.join(SELECTIONS)}")
    strict = bool(strict_moderation)
    kept: List[Mapping[str, Any]] = []
    left_out = {reason: 0 for reason in REASONS}
    for comment in comments:
        if comment.get("velocity") is None:
            raise ValueError(f"comment {comment.get('tid')!r} has no velocity: the selection needs it")
        if participant_visible(comment["active"], comment["velocity"], int(comment["mod"]), strict):
            kept.append(comment)
        else:
            left_out[_reason(comment, strict)] += 1
    kept.sort(key=lambda c: int(c["tid"]))
    h = hashlib.sha256()
    h.update(f"{SELECTION_FORMAT}\n{name}\n".encode("utf-8"))
    for comment in kept:
        text = hashlib.sha256((comment.get("txt") or "").encode("utf-8")).hexdigest()
        h.update(f"{int(comment['tid'])}\t{text}\n".encode("utf-8"))
    return Selection(name, tuple(int(c["tid"]) for c in kept), h.hexdigest(), left_out)
