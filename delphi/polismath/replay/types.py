"""Core event and dataset types for replay schedule inference.

Normative conventions (docs/plans/2026-07-06-r2-schedule-inference.md):

- Votes are sorted by ``(t_ms, input order)`` and 1-indexed by ``k``.
- A *revote* is a later occurrence of an already-seen ``(pid, tid)`` pair in
  sorted order. Revotes are excluded from the mark likelihood (they cannot be
  serve-generated) but still update prefix statistics (latest-vote-wins).
- A *cut slot* ``i`` in ``1..n`` means "a recompute fired after ingesting
  votes ``1..i``". A :data:`Schedule` is a strictly increasing tuple of slots.
- ``segments(schedule)`` partitions the vote index range into half-open
  segments ``(left, right]`` where ``left`` is the previous cut slot (sentinel
  ``-1`` before any cut — production serves with all-default weights until the
  first recompute lands) and the final segment runs to ``n`` (the tail after
  the last cut; possibly empty).
"""

from dataclasses import dataclass, field
from enum import IntEnum


class Vote(IntEnum):
    """Semantic vote signs.

    These are *internal* semantics. Adapters that ingest external data own
    the mapping: the polis DB stores agree as -1, and export CSVs flip signs
    relative to the DB (see math/src/polismath/darwin/export.clj:106-113).
    """

    AGREE = 1
    DISAGREE = -1
    PASS = 0


@dataclass(frozen=True)
class VoteEvent:
    """One vote, in sorted order. ``k`` is its 1-based index."""

    k: int
    t_ms: int
    pid: int
    tid: int
    sign: int
    is_revote: bool


@dataclass(frozen=True)
class CommentMeta:
    """Static comment metadata relevant to routing."""

    tid: int
    created_ms: int
    is_meta: bool = False


@dataclass(frozen=True)
class ModEvent:
    """A moderation change at ``t_ms`` setting ``comments.mod`` for ``tid``.

    ``mod`` uses the production convention: -1 moderated-out, 0 unmoderated,
    1 moderated-in. ``is_meta`` mirrors ``comments.is_meta`` (MOD_RESTART_PORT_
    SPEC.md "Python ports" item 2) — additive, defaults False so every existing
    caller (bare ``ModEvent(t_ms, tid, mod)``) is unaffected. Consumed by
    ``Conversation.mod_update`` (conversation.clj:846-884 parity): an is_meta
    row lands in BOTH mod-out and mod-in regardless of ``mod``.
    """

    t_ms: int
    tid: int
    mod: int
    is_meta: bool = False


Schedule = tuple[int, ...]
"""Strictly increasing tuple of cut slots in ``1..n``."""


@dataclass
class ReplayDataset:
    """A conversation's event stream, prepared for schedule inference."""

    votes: list[VoteEvent]
    comments: dict[int, CommentMeta]
    mod_events: list[ModEvent] = field(default_factory=list)
    strict_moderation: bool = False
    # Provenance counter (MOD_RESTART_PORT_SPEC.md "Data" bullet): rows in the
    # source comments CSV that carried no ``modified`` timestamp and therefore
    # could not be woven into a replay schedule as a ModEvent. Populated by
    # :func:`polismath.replay.real_data.load_export_votes`; 0 for datasets with
    # no moderation-history columns at all (nothing was skipped — there was
    # nothing to parse).
    mod_events_skipped: int = 0

    @property
    def n(self) -> int:
        return len(self.votes)

    @classmethod
    def build(
        cls,
        raw_votes: list[tuple[int, int, int, int]],
        comments: dict[int, CommentMeta] | None = None,
        mod_events: list[ModEvent] | tuple[ModEvent, ...] = (),
        strict_moderation: bool = False,
    ) -> "ReplayDataset":
        """Build a dataset from raw ``(t_ms, pid, tid, sign)`` rows.

        Sorts votes stably by time, assigns 1-based ``k``, flags revotes.
        When ``comments`` is None, each comment's creation time is inferred
        as its first (sorted) vote time — a lower bound adequate for
        availability modelling when the comments table is absent.
        """
        indexed = sorted(enumerate(raw_votes), key=lambda p: (p[1][0], p[0]))
        votes: list[VoteEvent] = []
        seen: set[tuple[int, int]] = set()
        first_vote_ms: dict[int, int] = {}
        for k, (_, (t_ms, pid, tid, sign)) in enumerate(indexed, start=1):
            pair = (pid, tid)
            votes.append(
                VoteEvent(
                    k=k,
                    t_ms=t_ms,
                    pid=pid,
                    tid=tid,
                    sign=sign,
                    is_revote=pair in seen,
                )
            )
            seen.add(pair)
            first_vote_ms.setdefault(tid, t_ms)

        if comments is None:
            comments = {
                tid: CommentMeta(tid=tid, created_ms=t)
                for tid, t in first_vote_ms.items()
            }
        else:
            missing = sorted(set(first_vote_ms) - set(comments))
            if missing:
                raise ValueError(
                    f"comments table missing voted tid {missing[0]}"
                    + (f" (+{len(missing) - 1} more)" if len(missing) > 1 else "")
                )

        return cls(
            votes=votes,
            comments=dict(comments),
            mod_events=sorted(mod_events, key=lambda m: m.t_ms),
            strict_moderation=strict_moderation,
        )

    def validate_schedule(self, schedule: Schedule) -> None:
        prev = 0
        for s in schedule:
            if not 1 <= s <= self.n:
                raise ValueError(f"cut slot {s} outside 1..{self.n}")
            if s <= prev:
                raise ValueError(f"schedule not strictly increasing at slot {s}")
            prev = s

    def segments(self, schedule: Schedule) -> list[tuple[int, int]]:
        """Partition vote indices into ``(left, right]`` scoring segments."""
        self.validate_schedule(schedule)
        lefts = [-1, *schedule]
        rights = [*schedule, self.n]
        return list(zip(lefts, rights))
