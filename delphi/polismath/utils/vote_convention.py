"""The ONE authoritative Python definition of the raw vote-storage convention.

P-022-G rev4 ("Input contract", the polarity paragraph) requires exactly one
Python definition of the raw storage sign of AGREE, living at
``polismath/utils/vote_convention.py::STORAGE_AGREE_VALUE``, with every
extractor, manifest, converter and ingress consuming it through a *validated
configuration argument* rather than restating the literal. P-023's first slice
lands that definition, because until a configurable ``s`` exists the compensated
polarity pair ``E(V, s) == E(-V, -s)`` cannot even be EXPRESSED: no code path
reads anything but a hard-coded ``-1``.

Three distinct conventions live in this codebase and they must never be
conflated:

- **storage** — the raw ``votes.vote`` column. Today AGREE is ``-1``
  (``server/postgres/migrations/000000_initial.sql``: "-1 = Agree, 1 =
  Disagree, 0 = Pass/Unsure"). :data:`STORAGE_AGREE_VALUE` is the authoritative
  default and it stays ``-1`` until a separately approved DB migration; a
  caller may nonetheless *declare* ``+1`` for a derived paired fixture, which is
  exactly what makes the polarity property testable ahead of the migration.
- **semantic** — what a vote MEANS: ``+1`` agree, ``-1`` disagree, ``0`` pass.
  This is NOT configurable; it is the fixed meaning both engines compute on
  (Delphi's internal convention) and the convention the export CSV carries.
  ``semantic = raw_vote × storage_agree_value``.
- **export** — the tagged CSV format (``report.ts``'s ``String(-row.vote)``).
  It is semantic by construction and :data:`EXPORT_AGREE_VALUE` stays ``+1``
  through any storage flip. Never negate twice: an export row is already
  semantic input, never raw storage input.

NULL is a fourth storage state, neither pass nor missing, and it is NOT
convertible: :func:`semantic_vote` refuses it loudly rather than letting
``None * -1`` raise ``TypeError`` from somewhere deeper, and never turns it
into ``0``.

This module deliberately has no imports from the rest of ``polismath``: the
independent reference fold, the manifest gate and the extractor all read it
without dragging in the candidate converter.
"""

from __future__ import annotations

from typing import Any, Union

Number = Union[int, float]

#: Raw storage sign of an AGREE vote — the authoritative default and the only
#: value production extraction may declare before the P-023 storage migration.
STORAGE_AGREE_VALUE: int = -1

#: The two admissible storage conventions. Exactly the integers -1 and +1:
#: ``bool`` is excluded (``True == 1`` in Python, and a convention carrying
#: ``True`` is a typing accident, not a declaration), and so are ``0``, floats,
#: strings and ``None``.
ADMISSIBLE_STORAGE_AGREE_VALUES: tuple[int, int] = (-1, 1)

#: Semantic vote meaning. FIXED — not a convention a manifest may declare.
SEMANTIC_AGREE: int = 1
SEMANTIC_DISAGREE: int = -1
SEMANTIC_PASS: int = 0

#: Sign of AGREE in the export CSV format. A separate, tagged format whose
#: convention is independent of storage and unchanged by a storage flip.
EXPORT_AGREE_VALUE: int = 1


class VoteConventionError(ValueError):
    """A declared convention or a raw vote value is not admissible."""


def validate_storage_agree_value(
    value: Any, *, field: str = "storage_agree_value",
) -> int:
    """Return ``value`` iff it is exactly the integer ``-1`` or ``+1``.

    ``type(value) is int`` rather than ``isinstance``: ``bool`` is a subclass of
    ``int``, so ``isinstance(True, int)`` admits ``True`` as ``+1`` — a
    convention that was never declared. A float ``-1.0``, the string ``"-1"``,
    ``0`` and ``None`` are all refused for the same reason: the convention is a
    declaration, not a value to coerce.
    """
    if type(value) is not int:
        raise VoteConventionError(
            f"{field} must be the integer -1 or +1, got "
            f"{type(value).__name__} {value!r} (bool, float, str and None are "
            f"not conventions)")
    if value not in ADMISSIBLE_STORAGE_AGREE_VALUES:
        raise VoteConventionError(
            f"{field} must be -1 or +1, got {value!r}")
    return value


def flipped(storage_agree_value: int) -> int:
    """The other convention. ``T(V, s) = (-V, -s)`` is its own inverse, so this
    is too: ``flipped(flipped(s)) == s``."""
    return -validate_storage_agree_value(storage_agree_value)


def semantic_vote(
    raw_vote: Number, storage_agree_value: int = STORAGE_AGREE_VALUE,
) -> Number:
    """``raw_vote × storage_agree_value`` — the ONE formula.

    ``+1`` agree, ``-1`` disagree, ``0`` pass, independent of which storage
    convention produced it. ``0`` (pass) is invariant: it is the literal zero on
    both sides of the involution, never a sign to flip.

    NULL (``None``) is refused: it is a distinct storage state, not a pass, and
    silently mapping it onto ``0`` would fabricate a vote. ``bool`` is refused
    for the same reason :func:`validate_storage_agree_value` refuses it.
    """
    s = validate_storage_agree_value(storage_agree_value)
    if raw_vote is None:
        raise VoteConventionError(
            "votes.vote is NULL: NULL is a distinct storage state, neither "
            "pass nor missing, and has no semantic vote. Apply an explicit "
            "declared NULL policy before conversion; never coerce it to 0.")
    if isinstance(raw_vote, bool):
        raise VoteConventionError(
            f"raw vote must be a number, got bool {raw_vote!r}")
    if not isinstance(raw_vote, (int, float)):
        raise VoteConventionError(
            f"raw vote must be a number, got {type(raw_vote).__name__} "
            f"{raw_vote!r}")
    return raw_vote * s


def storage_vote(
    semantic: Number, storage_agree_value: int = STORAGE_AGREE_VALUE,
) -> Number:
    """The inverse of :func:`semantic_vote`. Multiplication by ``s`` is its own
    inverse (``s² == 1``), so this is the same arithmetic — spelled separately
    because the two directions mean different things at a boundary, and a
    reader must never have to work out which way a bare ``* -1`` points."""
    return semantic_vote(semantic, storage_agree_value)
