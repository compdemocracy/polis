"""What the math engine consumed for one published tick (PROPENSITY-LOGGING-DESIGN.md §9).

:class:`TickInputs` is the single source of a ``math_recompute_log`` row: the
live poller builds one from the database for every generation it publishes,
:func:`polismath.poller.compute_tick.compute_tick` computes the generation from
it, and the writer stores :meth:`TickInputs.to_row` in the publication
transaction. Replay (:mod:`polismath.replay.tick_replay`) reads the rows back
with :meth:`TickInputs.from_row` and calls the same ``compute_tick``. A test
compares the dataclass's fields with the columns of migration 000044, so an
input cannot be added on one side only.

Three start modes:

* ``incremental`` — the cached state of tick ``prev_math_tick`` plus the votes
  the poll window delivered for this tick (``vote_*``, in delivery order) and,
  when the batch carried a moderation message, the moderation as re-read
  (``mod_read``), in canonical (sorted) order.
* ``warm_restore`` — the ``math_main`` blob of ``prev_math_tick`` restored,
  then the full vote history replayed (a restart, an eviction, a forced
  rebuild).
* ``cold`` — no usable persisted row: a fresh conversation plus the full
  history.

A rebuild does not store its votes: it stores a descriptor of the full-history
read (``rebuild_through_created``, ``rebuild_n_votes``, ``rebuild_digest``,
sha256 over ``tid,pid,created,vote`` lines in read order, which is the
canonical ``ORDER BY zid, tid, pid, created``). Replay re-reads the ``votes``
table and refuses when the digest differs and the votes later ticks
delivered do not explain it (a vote committed late and never delivered, or a
vote deleted, since the tick was computed). A NULL ``created`` is in the read
and the digest (as ``None``) but does not bound ``rebuild_through_created``.

The four moderation sets are held in full in memory (the engine needs them)
and stored as deltas against ``mod_base``, the previous read of the same
chain (a rebuild's against the empty sets): ``to_row`` emits the deltas,
``from_row(row, base)`` folds them back.

``last_vote_timestamp`` and ``n_comments`` are outputs, filled by the writer
at publication from the generation it publishes.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import os
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, fields
from typing import Any

INCREMENTAL = "incremental"
WARM_RESTORE = "warm_restore"
COLD = "cold"
START_MODES = (INCREMENTAL, WARM_RESTORE, COLD)

#: ``poll_moderation`` keys, in the order of the TickInputs fields that hold them.
_MOD_KEYS = (("mod_out_tids", "mod_out_tids"), ("mod_in_tids", "mod_in_tids"),
             ("meta_tids", "meta_tids"), ("mod_out_pids", "mod_out_ptpts"))
MOD_SETS = tuple(f for f, _ in _MOD_KEYS)
#: The log stores each moderation set as a delta against the chain's previous
#: read (a rebuild's against the empty sets): the full sets on every read
#: would grow as comments squared on a strictly moderated conversation.
MOD_DELTA_COLUMNS = tuple(f"{m}_{k}" for m in MOD_SETS for k in ("added", "removed"))
#: TickInputs fields that are not columns: the full sets as read (sorted), and
#: the chain's previous read the deltas are taken against.
IN_MEMORY_FIELDS = MOD_SETS + ("mod_base",)
_VOTE_ARRAYS = ("vote_pids", "vote_tids", "vote_values", "vote_created")

IntTuple = tuple[int, ...]
#: The four sets as read: (mod_out_tids, mod_in_tids, meta_tids, mod_out_pids).
ModSets = tuple[IntTuple, IntTuple, IntTuple, IntTuple]
EMPTY_MOD_SETS: ModSets = ((), (), (), ())


def rebuild_digest(votes: Iterable[Mapping[str, Any]]) -> str:
    """sha256 hex over one ``tid,pid,created,vote`` line per vote, in the
    order given (the full-history read's order)."""
    h = hashlib.sha256()
    for v in votes:
        h.update(f"{v['tid']},{v['pid']},{v['created']},{v['vote']}\n".encode())
    return h.hexdigest()


def _usable(value: str | None) -> str | None:
    value = (value or "").strip()
    return None if value in ("", "unknown") else value


def engine_version() -> str | None:
    """The running engine's version, for ``math_recompute_log.engine_version``.

    ``POLIS_GIT_HASH`` (baked into the image from the ``GIT_HASH`` build arg,
    ``delphi/Dockerfile``) first, as ``<tag>+<hash>`` when ``POLIS_BUILD_TAG``
    is set too; the Dockerfile's ``unknown`` placeholder counts as unset. Then
    the installed package's version (``polismath``, else the distribution that
    ships it, ``delphi-polis``), as ``<dist>==<version>``. None when neither is
    known.
    """
    git_hash = _usable(os.environ.get("POLIS_GIT_HASH"))
    tag = _usable(os.environ.get("POLIS_BUILD_TAG"))
    if git_hash:
        return f"{tag}+{git_hash}" if tag else git_hash
    if tag:
        return tag
    names = ["polismath"]
    try:
        names += list(importlib.metadata.packages_distributions().get("polismath", []))
    except Exception:  # noqa: BLE001 - metadata is best effort
        names = ["polismath"]
    for name in names:
        try:
            return f"{name}=={importlib.metadata.version(name)}"
        except importlib.metadata.PackageNotFoundError:
            continue
        except Exception:  # noqa: BLE001
            return None
    return None


def _ints(values: Iterable[Any] | None) -> IntTuple | None:
    return None if values is None else tuple(int(v) for v in values)


def _stamps(values: Iterable[Any] | None) -> tuple[int | None, ...] | None:
    """``votes.created`` values: nullable, so None is kept as None."""
    return None if values is None else tuple(None if v is None else int(v) for v in values)


def _canonical(values: Iterable[Any]) -> IntTuple:
    return tuple(sorted({int(v) for v in values}))


@dataclass(frozen=True)
class TickInputs:
    """Everything ``compute_tick`` consumes for one tick. Every field is a
    ``math_recompute_log`` column (minus zid, math_env, math_tick, created)
    except :data:`IN_MEMORY_FIELDS`: the four moderation sets as read, which
    the row stores as deltas against ``mod_base``, the chain's previous read
    (:data:`MOD_DELTA_COLUMNS`). :data:`COLUMNS` lists the row's columns."""

    start_mode: str
    prev_math_tick: int | None
    last_vote_timestamp: int | None
    n_votes: int | None
    n_comments: int | None
    vote_pids: IntTuple | None
    vote_tids: IntTuple | None
    vote_values: IntTuple | None
    vote_created: tuple[int | None, ...] | None
    rebuild_through_created: int | None
    rebuild_n_votes: int | None
    rebuild_digest: str | None
    mod_read: bool
    mod_out_tids: IntTuple | None
    mod_in_tids: IntTuple | None
    meta_tids: IntTuple | None
    mod_out_pids: IntTuple | None
    engine_version: str | None
    #: The chain's previous moderation read (None: the empty sets, as for a
    #: rebuild). Not compared: two inputs are equal when the engine sees the
    #: same thing.
    mod_base: ModSets | None = field(default=None, compare=False)

    def __post_init__(self) -> None:
        if self.start_mode not in START_MODES:
            raise ValueError(f"start_mode must be one of {START_MODES}, not {self.start_mode!r}")
        mods = [getattr(self, f) for f, _ in _MOD_KEYS]
        if self.mod_read != all(m is not None for m in mods) or (
                not self.mod_read and any(m is not None for m in mods)):
            raise ValueError("mod_read must be true exactly when all four moderation "
                             "arrays are present")
        if self.start_mode != INCREMENTAL and not self.mod_read:
            raise ValueError("a rebuild always reads moderation (mod_read)")
        arrays = [getattr(self, f) for f in _VOTE_ARRAYS]
        if self.start_mode == INCREMENTAL:
            if any(a is None for a in arrays) or {len(a) for a in arrays} != {self.n_votes}:
                raise ValueError("an incremental tick needs four vote arrays of n_votes each")
        elif any(a is not None for a in arrays):
            raise ValueError("a rebuild records a descriptor, not vote arrays")

    # -- construction (live path) ------------------------------------------ #
    @staticmethod
    def _moderation_fields(moderation: Mapping[str, Any] | None) -> dict[str, Any]:
        if moderation is None:
            return {"mod_read": False, **{f: None for f, _ in _MOD_KEYS}}
        # Canonical order (the read is ORDER BY tid / pid as well): the engine
        # builds its sets from these lists, so their iteration order, which the
        # blob's mod-out / mod-in / meta-tids lists follow, is reproducible from
        # the deltas.
        return {"mod_read": True,
                **{f: _canonical(moderation.get(key, [])) for f, key in _MOD_KEYS}}

    @classmethod
    def incremental(cls, *, prev_math_tick: int | None,
                    votes: Sequence[Mapping[str, Any]],
                    moderation: Mapping[str, Any] | None,
                    version: str | None,
                    mod_base: ModSets | None = None) -> TickInputs:
        """The cached state plus the delivered batch (delivery order kept);
        ``moderation`` is ``poll_moderation``'s result when this tick re-read
        it, None when the engine kept its cached sets; ``mod_base`` is the
        chain's previous read."""
        return cls(
            start_mode=INCREMENTAL, prev_math_tick=prev_math_tick,
            last_vote_timestamp=None, n_votes=len(votes), n_comments=None,
            vote_pids=_ints(v["pid"] for v in votes),
            vote_tids=_ints(v["tid"] for v in votes),
            vote_values=_ints(v["vote"] for v in votes),
            vote_created=_stamps(v["created"] for v in votes),
            rebuild_through_created=None, rebuild_n_votes=None, rebuild_digest=None,
            engine_version=version, mod_base=mod_base,
            **cls._moderation_fields(moderation))

    @classmethod
    def rebuild(cls, start_mode: str, *, prev_math_tick: int | None,
                votes: Sequence[Mapping[str, Any]], moderation: Mapping[str, Any],
                version: str | None) -> TickInputs:
        """A full-history rebuild (``warm_restore`` or ``cold``) from the
        votes as read (canonical order) and the moderation as read."""
        # votes.created is nullable; such rows are in the read (and the digest)
        # but cannot bound it.
        created = [v["created"] for v in votes if v["created"] is not None]
        return cls(
            start_mode=start_mode, prev_math_tick=prev_math_tick,
            last_vote_timestamp=None, n_votes=None, n_comments=None,
            vote_pids=None, vote_tids=None, vote_values=None, vote_created=None,
            rebuild_through_created=max(created) if created else None,
            rebuild_n_votes=len(votes), rebuild_digest=rebuild_digest(votes),
            engine_version=version, **cls._moderation_fields(moderation))

    @classmethod
    def unrecorded(cls) -> TickInputs:
        """The row of a publication whose inputs were not recorded (a direct
        ``MathWriter`` call outside the poller): ``warm_restore`` with no
        rebuild descriptor, which replay refuses, like a promoted generation
        that predates the log (``COPY_RECOMPUTE_LOG_SQL``)."""
        return cls(
            start_mode=WARM_RESTORE, prev_math_tick=None, last_vote_timestamp=None,
            n_votes=None, n_comments=None, vote_pids=None, vote_tids=None,
            vote_values=None, vote_created=None, rebuild_through_created=None,
            rebuild_n_votes=None, rebuild_digest=None, mod_read=True,
            mod_out_tids=(), mod_in_tids=(), meta_tids=(), mod_out_pids=(),
            engine_version=engine_version())

    @property
    def replayable(self) -> bool:
        """False for a rebuild row without a descriptor (unrecorded, or
        synthesised for a promotion)."""
        return self.start_mode == INCREMENTAL or self.rebuild_digest is not None

    # -- what the engine is given ------------------------------------------ #
    def votes(self) -> list[dict[str, Any]]:
        """The delivered votes as engine rows, in delivery order."""
        if self.vote_pids is None:
            return []
        assert self.vote_tids is not None and self.vote_values is not None
        assert self.vote_created is not None
        return [{"pid": p, "tid": t, "vote": v, "created": c} for p, t, v, c in
                zip(self.vote_pids, self.vote_tids, self.vote_values, self.vote_created)]

    def mod_sets(self) -> ModSets | None:
        """The four sets as read, or None when this tick did not read them."""
        if not self.mod_read:
            return None
        return (self.mod_out_tids or (), self.mod_in_tids or (), self.meta_tids or (),
                self.mod_out_pids or ())

    def moderation(self) -> dict[str, list[int]] | None:
        """The moderation as read, in ``poll_moderation``'s shape, or None
        when this tick did not read it."""
        if not self.mod_read:
            return None
        return {key: list(getattr(self, f)) for f, key in _MOD_KEYS}

    # -- the log row ---------------------------------------------------------- #
    def to_row(self) -> dict[str, Any]:
        """Column -> value for ``math_recompute_log`` (arrays as lists), the
        moderation as deltas against ``mod_base``."""
        row: dict[str, Any] = {}
        for f in fields(self):
            if f.name in IN_MEMORY_FIELDS:
                continue
            value = getattr(self, f.name)
            row[f.name] = list(value) if isinstance(value, tuple) else value
        sets = self.mod_sets()
        base = self.mod_base or EMPTY_MOD_SETS
        for i, name in enumerate(MOD_SETS):
            if sets is None:
                row[f"{name}_added"] = row[f"{name}_removed"] = None
            else:
                now, before = set(sets[i]), set(base[i])
                row[f"{name}_added"] = sorted(now - before)
                row[f"{name}_removed"] = sorted(before - now)
        return row

    @classmethod
    def from_row(cls, row: Mapping[str, Any], base: ModSets | None = None) -> TickInputs:
        """The inverse of :meth:`to_row`: ``base`` is the chain's previous
        moderation read (None: the empty sets, for a rebuild row). Extra keys
        (zid, math_env, math_tick, created) are ignored. Raises ValueError when
        a delta does not fit ``base``."""
        values: dict[str, Any] = {}
        for f in fields(cls):
            if f.name in IN_MEMORY_FIELDS:
                continue
            value = row[f.name]
            if f.name == "vote_created":
                value = _stamps(value)
            elif f.name in _VOTE_ARRAYS:
                value = _ints(value)
            values[f.name] = value
        start = base or EMPTY_MOD_SETS
        for i, name in enumerate(MOD_SETS):
            if not values["mod_read"]:
                values[name] = None
                continue
            added = set(_ints(row[f"{name}_added"]) or ())
            removed = set(_ints(row[f"{name}_removed"]) or ())
            before = set(start[i])
            if not removed <= before or added & before:
                raise ValueError(
                    f"tick {row.get('math_tick')}: {name} deltas (+{sorted(added)} "
                    f"-{sorted(removed)}) do not fit the previous read {sorted(before)}")
            values[name] = tuple(sorted((before - removed) | added))
        return cls(**values, mod_base=base)


#: The ``math_recompute_log`` columns a TickInputs row fills.
COLUMNS: tuple[str, ...] = tuple(
    f.name for f in fields(TickInputs) if f.name not in IN_MEMORY_FIELDS) + MOD_DELTA_COLUMNS
