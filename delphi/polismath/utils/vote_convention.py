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

**Where the storage sign comes from (P-078).** Every function here that needs
the storage sign and is not handed one asks the injectable
:class:`ConventionSource` (:func:`storage_agree_value`). The default source is
:class:`ConstantConventionSource` at :data:`STORAGE_AGREE_VALUE`, so nothing
changes at today's convention. :class:`RowConventionSource` takes a callable
returning the database row ``(version, agree_value)`` and caches it until the
next :meth:`~RowConventionSource.begin_cycle` (one read per poll cycle); a
database without the row is version 0 at :data:`STORAGE_AGREE_VALUE` by
definition. A row read in the same statement as the votes it governs
(:data:`CONVENTION_JOIN_SQL`) carries its own declaration, and
:func:`load_semantic_votes` converts it by that, never by a cached value.

**NULL (P-078 §1b, chokepoint 3).** A NULL ``votes.vote`` is not a vote: the
loaders skip it (``null_policy="skip"``; the poller's SQL also filters
``vote IS NOT NULL``) and it neither clears nor overwrites an earlier vote.
:func:`semantic_vote` itself still refuses NULL, so a caller without a policy
fails loudly instead of inventing a pass.

**The geometry axis (P-078 §1f).** The engine computes PCA on semantic votes;
the served (kebab-case) geometry of ``math_main`` is emitted in the axis the
legacy client expects, that of a matrix whose agree is the wire value
:data:`WIRE_AGREE_VALUE`. :func:`emit_axis` and :func:`restore_axis` are the one
pair that converts between the two. The served axis is keyed to the wire, which
is frozen, never to storage: an un-flip of storage changes no served byte.

This module deliberately has no imports from the rest of ``polismath``: the
independent reference fold, the manifest gate and the extractor all read it
without dragging in the candidate converter.
"""

from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import (
    Any, Callable, Iterable, Iterator, Literal, Mapping, Optional, Protocol,
    Sequence, Tuple, Union,
)

Number = Union[int, float]

logger = logging.getLogger(__name__)

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

#: Sign of AGREE on the numeric wire (POST /api/v3/votes, GET /votes). Frozen
#: at -1 (P-078 ruling R-wire), independent of storage.
WIRE_AGREE_VALUE: int = -1

#: The axis the served kebab-case geometry of ``math_main`` is emitted in
#: (``pca.center``, ``pca.comment-projection``, ``base-clusters`` x/y,
#: ``group-clusters`` centers): that of a rating matrix whose agree is
#: :data:`WIRE_AGREE_VALUE`. Keyed to the wire, never to storage.
GEOMETRY_AXIS_AGREE_VALUE: int = WIRE_AGREE_VALUE


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


# --- where the storage sign comes from ------------------------------------------


@dataclass(frozen=True)
class StorageConvention:
    """One answer to "which sign does storage use": the agree value, the
    version of the ``vote_convention`` row it came from, and where it came
    from (``"constant"``, ``"database"``, ``"database-absent"`` or
    ``"declared"``). ``version`` is ``None`` when no database was asked."""

    agree_value: int
    version: Optional[int] = None
    origin: str = "constant"

    def __post_init__(self) -> None:
        validate_storage_agree_value(self.agree_value, field="agree_value")
        if self.version is not None and (type(self.version) is not int or self.version < 0):
            raise VoteConventionError(
                f"convention version must be a non-negative integer or None, got {self.version!r}")


class ConventionSource(Protocol):
    """Where the vote-reading code obtains the storage convention."""

    def current(self) -> StorageConvention:
        """The convention in force for the current cycle."""

    def begin_cycle(self) -> None:
        """Forget any cached answer; the next :meth:`current` asks again."""


class ConstantConventionSource:
    """A convention fixed in code. The module default is this at
    :data:`STORAGE_AGREE_VALUE`, which is today's behaviour."""

    def __init__(self, agree_value: int = STORAGE_AGREE_VALUE, *,
                 version: Optional[int] = None, origin: str = "constant") -> None:
        self._convention = StorageConvention(agree_value, version, origin)

    def current(self) -> StorageConvention:
        return self._convention

    def begin_cycle(self) -> None:
        pass

    def __repr__(self) -> str:
        return f"ConstantConventionSource({self._convention!r})"


#: What a row fetcher returns: ``(version, agree_value)`` from the
#: ``vote_convention`` row, or ``None`` when the database has no such row.
ConventionRow = Optional[Tuple[int, int]]

#: The convention of a database that carries no ``vote_convention`` row: every
#: database before P-078 PR-A, and every copy restored from one. Version 0 at
#: the code fallback, by definition (P-078 §2c.7).
ABSENT_CONVENTION = StorageConvention(STORAGE_AGREE_VALUE, 0, "database-absent")


class RowConventionSource:
    """The convention as the database states it, read through ``fetch`` and
    cached until :meth:`begin_cycle`, so a poll cycle asks once.

    ``fetch`` returns ``(version, agree_value)`` or ``None`` (no row: see
    :data:`ABSENT_CONVENTION`). A value outside {-1, +1} or a malformed version
    raises :class:`VoteConventionError` and is never cached.
    """

    def __init__(self, fetch: Callable[[], ConventionRow], *,
                 absent: StorageConvention = ABSENT_CONVENTION) -> None:
        self._fetch = fetch
        self._absent = absent
        self._cached: Optional[StorageConvention] = None
        self._last: Optional[StorageConvention] = None
        self._lock = threading.Lock()

    def current(self) -> StorageConvention:
        with self._lock:
            if self._cached is None:
                row = self._fetch()
                if row is None:
                    convention = self._absent
                else:
                    version, agree_value = row
                    convention = StorageConvention(
                        validate_storage_agree_value(agree_value, field="vote_convention.agree_value"),
                        version, "database")
                previous = self._last
                if previous is not None and previous != convention:
                    logger.warning("vote convention changed: %r -> %r", previous, convention)
                self._cached = self._last = convention
            return self._cached

    def begin_cycle(self) -> None:
        with self._lock:
            self._cached = None

    def __repr__(self) -> str:
        return f"RowConventionSource(cached={self._cached!r})"


#: SQL shared by every database reader (P-078 §1a). ``vote_convention_current()``
#: is created by PR-A; until then ``to_regprocedure`` reports it absent.
CONVENTION_PRESENT_SQL = (
    "SELECT to_regprocedure('public.vote_convention_current()') IS NOT NULL AS present")
CONVENTION_ROW_SQL = "SELECT version, agree_value FROM public.vote_convention_current()"
#: Appended to a ``FROM votes`` clause so the convention is read in the same
#: statement, and so the same snapshot, as the votes. A LEFT JOIN: a missing
#: row yields NULL columns, which :func:`load_semantic_votes` refuses, rather
#: than silently yielding no votes.
CONVENTION_JOIN_SQL = "LEFT JOIN public.vote_convention_current() AS vc ON true"
CONVENTION_COLUMNS_SQL = "vc.version AS convention_version, vc.agree_value AS convention_agree_value"
#: The row keys :data:`CONVENTION_COLUMNS_SQL` produces.
ROW_VERSION_KEY = "convention_version"
ROW_AGREE_KEY = "convention_agree_value"


def database_row_fetcher(
    query: Callable[[str], Sequence[Mapping[str, Any]]],
) -> Callable[[], ConventionRow]:
    """A ``fetch`` for :class:`RowConventionSource` over ``query(sql) -> rows``.
    Exactly one row is required when the function exists."""

    def fetch() -> ConventionRow:
        present = query(CONVENTION_PRESENT_SQL)
        if not present or not present[0]["present"]:
            return None
        rows = query(CONVENTION_ROW_SQL)
        if len(rows) != 1:
            raise VoteConventionError(
                f"vote_convention_current() returned {len(rows)} rows; exactly one is required")
        return rows[0]["version"], rows[0]["agree_value"]

    return fetch


_source: ConventionSource = ConstantConventionSource()
_source_lock = threading.Lock()


def get_convention_source() -> ConventionSource:
    return _source


def set_convention_source(source: ConventionSource) -> ConventionSource:
    """Install ``source`` as the module's source; returns the previous one."""
    global _source
    if not callable(getattr(source, "current", None)):
        raise VoteConventionError(f"not a ConventionSource: {source!r}")
    with _source_lock:
        previous, _source = _source, source
    return previous


@contextmanager
def using_convention_source(source: ConventionSource) -> Iterator[ConventionSource]:
    previous = set_convention_source(source)
    try:
        yield source
    finally:
        set_convention_source(previous)


def current_convention() -> StorageConvention:
    return _source.current()


def storage_agree_value() -> int:
    """The storage sign of AGREE, from the installed :class:`ConventionSource`."""
    return _source.current().agree_value


def resolve_storage_agree_value(value: Optional[int]) -> int:
    """A declared ``value`` (validated), or the source's when ``None``."""
    if value is None:
        return _source.current().agree_value
    return validate_storage_agree_value(value)


def semantic_vote(
    raw_vote: Number, storage_agree_value: Optional[int] = None,
) -> Number:
    """``raw_vote × storage_agree_value`` — the ONE formula.

    ``+1`` agree, ``-1`` disagree, ``0`` pass, independent of which storage
    convention produced it. ``0`` (pass) is invariant: it is the literal zero on
    both sides of the involution, never a sign to flip.

    NULL (``None``) is refused: it is a distinct storage state, not a pass, and
    silently mapping it onto ``0`` would fabricate a vote. ``bool`` is refused
    for the same reason :func:`validate_storage_agree_value` refuses it.

    ``storage_agree_value`` omitted means the current source's value
    (:func:`storage_agree_value`).
    """
    s = resolve_storage_agree_value(storage_agree_value)
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
    semantic: Number, storage_agree_value: Optional[int] = None,
) -> Number:
    """The inverse of :func:`semantic_vote`. Multiplication by ``s`` is its own
    inverse (``s² == 1``), so this is the same arithmetic — spelled separately
    because the two directions mean different things at a boundary, and a
    reader must never have to work out which way a bare ``* -1`` points."""
    return semantic_vote(semantic, storage_agree_value)


#: What a loader does with a NULL ``votes.vote``. ``"skip"`` (the documented
#: rule for every live loader, P-078) drops the row: NULL is not a vote, so it
#: neither counts nor clears an earlier vote. ``"refuse"`` raises (via
#: :func:`semantic_vote`). ``"keep"`` leaves ``None`` in place for a consumer
#: that handles it itself (the replay harness).
NullPolicy = Literal["skip", "refuse", "keep"]


def load_semantic_votes(
    rows: Iterable[Mapping[str, Any]],
    *,
    storage_agree_value: Optional[int] = None,
    vote_key: str = "vote",
    null_policy: NullPolicy = "refuse",
) -> list[dict[str, Any]]:
    """Copies of ``rows`` with ``row[vote_key]`` turned from a raw storage
    vote into a semantic vote by :func:`semantic_vote`.

    This is the one place a loader turns database vote rows into semantic
    votes; every other field is copied unchanged. The input rows are not
    modified.

    The sign: a row that carries :data:`ROW_AGREE_KEY` (read in the same
    statement as the vote, :data:`CONVENTION_JOIN_SQL`) is converted by its
    own declaration, and the two convention columns are dropped from the copy;
    a NULL there means the convention row is missing and is refused. Any other
    row uses ``storage_agree_value``, or the source's value when omitted. A
    declared ``storage_agree_value`` that contradicts a row's own is refused.
    """
    declared = (None if storage_agree_value is None
                else validate_storage_agree_value(storage_agree_value))
    if null_policy not in ("skip", "refuse", "keep"):
        raise VoteConventionError(
            f"null_policy must be 'skip', 'refuse' or 'keep', got {null_policy!r}")
    fallback: Optional[int] = declared
    out: list[dict[str, Any]] = []
    skipped = 0
    for row in rows:
        converted = dict(row)
        if ROW_AGREE_KEY in converted:
            s = validate_storage_agree_value(
                converted.pop(ROW_AGREE_KEY), field="vote_convention.agree_value (row)")
            converted.pop(ROW_VERSION_KEY, None)
            if declared is not None and declared != s:
                raise VoteConventionError(
                    f"declared storage_agree_value {declared} contradicts the row's own {s}")
        else:
            if fallback is None:
                fallback = _source.current().agree_value
            s = fallback
        raw = converted.get(vote_key)
        if raw is None:
            if null_policy == "skip":
                skipped += 1
                continue
            if null_policy == "keep":
                converted[vote_key] = None
                out.append(converted)
                continue
        converted[vote_key] = semantic_vote(raw, s)
        out.append(converted)
    if skipped:
        logger.info("skipped %d NULL vote row(s): NULL is not a vote", skipped)
    return out


# --- the geometry axis -----------------------------------------------------------


def _axis_factor(axis_agree_value: int) -> int:
    return validate_storage_agree_value(axis_agree_value, field="axis_agree_value") * SEMANTIC_AGREE


def _scale(values: Any, factor: int) -> Any:
    if isinstance(values, (list, tuple)):
        return [_scale(v, factor) for v in values]
    if factor == 1:
        return values
    return -values


def emit_axis(values: Any, axis_agree_value: int = GEOMETRY_AXIS_AGREE_VALUE) -> Any:
    """Geometry computed on semantic votes (agree = +1) -> the served axis, that
    of a matrix whose agree is ``axis_agree_value``. Numbers, numpy arrays and
    (nested) lists; lists come back as lists."""
    return _scale(values, _axis_factor(axis_agree_value))


def restore_axis(values: Any, axis_agree_value: int = GEOMETRY_AXIS_AGREE_VALUE) -> Any:
    """The inverse of :func:`emit_axis`: served geometry, emitted in the axis of
    ``axis_agree_value``, back to the engine's semantic axis. A blob emitted in
    the other axis restores correctly when that axis is declared here."""
    return _scale(values, _axis_factor(axis_agree_value))
