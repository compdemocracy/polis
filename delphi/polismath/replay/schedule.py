"""Schedule spec (JSON) + slicer + presets — replay harness Phase H-A.

A *schedule* is a first-class INPUT to the harness (REPLAY_HARNESS_DESIGN.md
§4): it declares WHERE a recompute fires along a conversation's **sorted**
event stream. R2 (schedule inference) consumes the same spec object, so the
resolution of cut modes into 1-based vote *slots* is kept consistent with
:meth:`polismath.replay.types.ReplayDataset.validate_schedule` /
:meth:`~polismath.replay.types.ReplayDataset.segments` — a cut slot ``s`` means
"a recompute fired after ingesting votes ``1..s``".

Why sort first (design §5): the export CSVs are NOT pre-sorted (vw has 2136
out-of-order rows). :meth:`ReplayDataset.build` sorts stably by
``(t_ms, input order)`` and flags revotes; this module operates on that sorted
stream so it does NOT inherit ``prepare_votes_data``'s unsorted-file-order
quirk. Revotes are KEPT (no dedup) — later-vote-wins is resolved inside the
engine, not at the source.

Cut modes (design §4):
- ``vote-count``        : ``at`` are absolute vote counts (== slots). ``"end"`` → n.
- ``explicit-event-index``: ``at`` are 1-based sorted vote indices (== slots).
- ``timestamp``         : ``at`` are t_ms values; slot = #votes with ``t_ms <= T``.
- ``fraction``          : ``at`` are fractions in (0, 1]; slot = ``round(f * n)``.

Presets: ``uniform-N``, ``front-loaded``, ``back-loaded``, ``every-vote``
(small datasets only), ``single-cut`` (== today's cold-start), ``per-day``
(day boundaries from the real timestamps).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from polismath.replay.types import ModEvent, ReplayDataset, Schedule, VoteEvent

_END = "end"
_VALID_MODES = frozenset(
    {"vote-count", "explicit-event-index", "timestamp", "fraction"}
)


# ---------------------------------------------------------------------------
# Schedule spec (the JSON input, preserved verbatim for the store).
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ScheduleSpec:
    """A (dataset, schedule) declaration — the verbatim §4 JSON input.

    ``to_dict`` returns exactly the mapping the spec was built from so the store
    can persist ``schedule.json`` byte-faithfully (design §7): any replay is
    re-derivable from (schedule, dataset, commit).
    """

    dataset: str
    schedule_id: str
    cuts: dict[str, Any]
    source: str = "votes-csv"
    # "none" | "interleave-by-timestamp" | explicit list of ModEvent-shaped dicts
    moderation: Any = "none"
    clojure: dict[str, Any] = field(default_factory=lambda: {"warm_start": "chain"})
    notes: str = ""
    # Restart seam (MOD_RESTART_PORT_SPEC.md "Replay-step semantics" / restart
    # plumbing): after recording the step at this index, the driver rebuilds
    # the conversation the way a Clojure worker restart would (see driver.py's
    # `_restart_conversation`). None (default) means no restart — every
    # existing schedule is unaffected.
    restart_after: int | None = None
    coverage: str = "full-stream"
    # Exact required fields in the empty checkpoint's acceptance projection.
    empty_output: dict[str, Any] | None = None
    # Verbatim mapping this spec was loaded from (None → reconstruct on demand).
    _raw: dict[str, Any] | None = field(default=None, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ScheduleSpec":
        """Build from a §4 mapping, retaining it verbatim for round-tripping."""
        if not isinstance(d, dict):
            raise ValueError("schedule must be an object")
        unknown = set(d) - {"dataset", "schedule_id", "cuts", "source", "moderation",
                            "clojure", "notes", "restart_after", "coverage", "empty_output"}
        if unknown:
            raise ValueError(f"unknown schedule fields: {sorted(unknown)}")
        return cls(
            dataset=d["dataset"],
            schedule_id=d["schedule_id"],
            cuts=d["cuts"],
            source=d.get("source", "votes-csv"),
            moderation=d.get("moderation", "none"),
            clojure=d.get("clojure", {"warm_start": "chain"}),
            notes=d.get("notes", ""),
            restart_after=d.get("restart_after"),
            coverage=d.get("coverage", "full-stream"),
            empty_output=d.get("empty_output"),
            _raw=dict(d),
        )

    @classmethod
    def from_json_file(cls, path: str | Path) -> "ScheduleSpec":
        with open(path) as fh:
            return cls.from_dict(json.load(fh))

    def to_dict(self) -> dict[str, Any]:
        """Return the verbatim input mapping (or reconstruct a canonical one)."""
        if self._raw is not None:
            return dict(self._raw)
        return {
            "dataset": self.dataset,
            "schedule_id": self.schedule_id,
            "source": self.source,
            "cuts": self.cuts,
            "moderation": self.moderation,
            "clojure": self.clojure,
            "notes": self.notes,
            "restart_after": self.restart_after,
            "coverage": self.coverage,
            "empty_output": self.empty_output,
        }

    def write_json(self, path: str | Path) -> None:
        with open(path, "w") as fh:
            json.dump(self.to_dict(), fh, indent=2)


# ---------------------------------------------------------------------------
# One replay step: a batch of votes + newly-active moderation, and its cut.
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ReplayStep:
    """A single (batch-ingest → recompute → record) unit (design §2).

    ``prev_slot``/``cut_slot`` are the half-open ``(prev_slot, cut_slot]`` vote
    range (1-based, inclusive right). ``vote_events`` is that batch in sorted
    order; ``mod_events`` are moderation changes that become active in this
    segment (interleave); ``cut_time_ms`` is the wall-clock of the batch's last
    vote (the cut's clock, used to interleave moderation).
    """

    index: int
    prev_slot: int
    cut_slot: int
    vote_events: tuple[VoteEvent, ...]
    mod_events: tuple[ModEvent, ...]
    cut_time_ms: int


# ---------------------------------------------------------------------------
# Cut-mode resolution → strictly-increasing 1-based slots.
# ---------------------------------------------------------------------------
def resolve_cut_slots(dataset: ReplayDataset, cuts: dict[str, Any]) -> Schedule:
    """Resolve a §4 ``cuts`` spec into a validated :data:`Schedule`.

    A zero slot requires ``empty_checkpoint: true``. Duplicate resolved slots
    are errors unless ``deduplicate: true`` explicitly requests collapsing
    them. Order is preserved: decreasing slots are always errors.
    """
    if not isinstance(cuts, dict):
        raise ValueError("cuts must be an object")
    unknown = set(cuts) - {"mode", "at", "empty_checkpoint", "deduplicate"}
    if unknown:
        raise ValueError(f"unknown cut fields: {sorted(unknown)}")
    mode = cuts.get("mode")
    if mode not in _VALID_MODES:
        raise ValueError(
            f"unknown cut mode {mode!r}; expected one of {sorted(_VALID_MODES)}"
        )
    at = cuts.get("at", [])
    if not isinstance(at, list):
        raise ValueError("cuts.at must be a list")
    for flag in ("empty_checkpoint", "deduplicate"):
        if flag in cuts and type(cuts[flag]) is not bool:
            raise ValueError(f"cuts.{flag} must be boolean")
    n = dataset.n

    raw_slots: list[int] = []
    for a in at:
        if a == _END:
            raw_slots.append(n)
        elif mode in ("vote-count", "explicit-event-index"):
            if type(a) is not int:
                raise ValueError(f"vote cut must be an integer, got {a!r}")
            raw_slots.append(int(a))
        elif mode == "fraction":
            f = float(a)
            if not 0.0 < f <= 1.0:
                raise ValueError(f"fraction cut {f} outside (0, 1]")
            raw_slots.append(int(round(f * n)))
        elif mode == "timestamp":
            # slot = number of votes with t_ms <= T (votes are time-sorted).
            raw_slots.append(_count_votes_up_to(dataset.votes, int(a)))

    if any(a > b for a, b in zip(raw_slots, raw_slots[1:])):
        raise ValueError("schedule not strictly increasing: cut order must be preserved")
    if len(set(raw_slots)) != len(raw_slots) and not cuts.get("deduplicate", False):
        raise ValueError("duplicate resolved cut slots; opt in with deduplicate: true")
    slots = tuple(dict.fromkeys(raw_slots))
    if 0 in slots and not cuts.get("empty_checkpoint", False):
        raise ValueError("zero cut requires explicit empty_checkpoint: true")
    schedule: Schedule = slots
    dataset.validate_schedule(schedule, allow_zero=cuts.get("empty_checkpoint", False))
    return schedule


def _count_votes_up_to(votes: list[VoteEvent], t_ms: int) -> int:
    """#votes with ``t_ms <= T`` in a time-sorted list (linear; n is small)."""
    count = 0
    for v in votes:
        if v.t_ms <= t_ms:
            count += 1
        else:
            break
    return count


# ---------------------------------------------------------------------------
# Slicer: schedule spec + dataset → ordered replay steps.
# ---------------------------------------------------------------------------
def slice_schedule(dataset: ReplayDataset, spec: ScheduleSpec) -> list[ReplayStep]:
    """Partition the sorted event stream into :class:`ReplayStep` batches.

    One step per cut slot. The tail after the last cut is intentionally NOT a
    step (recompute fires only at cut points; include ``"end"`` to recompute
    the tail). Moderation events are woven in per ``spec.moderation``:
    ``"none"`` ignores them; ``"interleave-by-timestamp"`` uses the dataset's
    ``mod_events``; an explicit list of ModEvent-shaped dicts overrides. Each
    mod event is attached to the FIRST cut whose ``cut_time_ms`` reaches its
    ``t_ms``; events after the last cut are dropped (like tail votes).
    """
    slots = resolve_cut_slots(dataset, spec.cuts)
    if not slots:
        return []

    mod_events = _resolve_mod_events(dataset, spec)

    steps: list[ReplayStep] = []
    prev = 0
    for i, cut in enumerate(slots):
        batch = tuple(dataset.votes[prev:cut])  # 1-based (prev, cut] → 0-based slice
        cut_time_ms = dataset.votes[cut - 1].t_ms if cut else 0
        prev_time = steps[-1].cut_time_ms if steps else None
        step_mods = tuple(
            m
            for m in mod_events
            if m.t_ms <= cut_time_ms and (prev_time is None or m.t_ms > prev_time)
        )
        steps.append(
            ReplayStep(
                index=i,
                prev_slot=prev,
                cut_slot=cut,
                vote_events=batch,
                mod_events=step_mods,
                cut_time_ms=cut_time_ms,
            )
        )
        prev = cut
    return steps


def _resolve_mod_events(dataset: ReplayDataset, spec: ScheduleSpec) -> list[ModEvent]:
    mode = spec.moderation
    if mode == "none":
        return []
    if mode == "interleave-by-timestamp":
        return sorted(dataset.mod_events, key=lambda m: m.t_ms)
    if isinstance(mode, (list, tuple)):
        parsed = [
            m if isinstance(m, ModEvent) else ModEvent(
                t_ms=int(m["t_ms"]),
                tid=int(m["tid"]),
                mod=int(m["mod"]),
                is_meta=bool(m.get("is_meta", False)),
            )
            for m in mode
        ]
        return sorted(parsed, key=lambda m: m.t_ms)
    raise ValueError(f"unknown moderation spec {mode!r}")


# ---------------------------------------------------------------------------
# Presets — each returns a ready-to-slice ScheduleSpec (design §4).
# ---------------------------------------------------------------------------
def _spec(dataset_name: str, schedule_id: str, cuts: dict[str, Any],
          notes: str = "", moderation: Any = "none") -> ScheduleSpec:
    return ScheduleSpec.from_dict(
        {
            "dataset": dataset_name,
            "schedule_id": schedule_id,
            "source": "votes-csv",
            "cuts": cuts,
            "moderation": moderation,
            "clojure": {"warm_start": "chain"},
            "notes": notes,
        }
    )


def preset_single_cut(dataset_name: str, n: int, *, schedule_id: str = "single-cut") -> ScheduleSpec:
    """One recompute over the whole stream — equivalent to today's cold start."""
    return _spec(dataset_name, schedule_id, {"mode": "vote-count", "at": [_END]},
                 notes="single cold-start recompute over all votes")


def preset_every_vote(dataset_name: str, n: int, *, schedule_id: str = "every-vote") -> ScheduleSpec:
    """Recompute after every vote (small datasets only — n recomputes)."""
    return _spec(dataset_name, schedule_id,
                 {"mode": "vote-count", "at": list(range(1, n + 1))},
                 notes="recompute after every vote (small datasets only)")


def preset_uniform(dataset_name: str, n: int, n_cuts: int, *,
                   schedule_id: str | None = None) -> ScheduleSpec:
    """``n_cuts`` evenly-spaced recomputes; the last lands on ``n``."""
    slots = _preset_slots([round(n * i / n_cuts) for i in range(1, n_cuts + 1)], n)
    return _spec(dataset_name, schedule_id or f"uniform-{n_cuts}",
                 {"mode": "vote-count", "at": slots, "deduplicate": True},
                 notes=f"{n_cuts} evenly-spaced recomputes")


def preset_front_loaded(dataset_name: str, n: int, *, n_cuts: int = 6,
                        schedule_id: str = "front-loaded") -> ScheduleSpec:
    """Recomputes concentrated EARLY (quadratic spacing, denser at the start)."""
    slots = _preset_slots([round(n * (i / n_cuts) ** 2) for i in range(1, n_cuts + 1)], n)
    return _spec(dataset_name, schedule_id, {"mode": "vote-count", "at": slots, "deduplicate": True},
                 notes="front-loads recomputes into the early conversation")


def preset_back_loaded(dataset_name: str, n: int, *, n_cuts: int = 6,
                       schedule_id: str = "back-loaded") -> ScheduleSpec:
    """Recomputes concentrated LATE (mirror of front-loaded)."""
    slots = _preset_slots(
        [round(n * (1 - (1 - i / n_cuts) ** 2)) for i in range(1, n_cuts + 1)], n
    )
    return _spec(dataset_name, schedule_id, {"mode": "vote-count", "at": slots, "deduplicate": True},
                 notes="back-loads recomputes into the late conversation")


def preset_per_day(dataset_name: str, dataset: ReplayDataset, *,
                   schedule_id: str = "per-day") -> ScheduleSpec:
    """One recompute at each UTC-day boundary derived from real timestamps.

    Cut slots are the cumulative vote counts at the end of each day that has
    votes; encoded as explicit event indices so the schedule is stable even if
    the dataset is re-derived. Requires a time-sorted dataset (build() sorts).
    """
    day_ms = 24 * 3600 * 1000
    slots: list[int] = []
    prev_day: int | None = None
    for idx, v in enumerate(dataset.votes, start=1):
        d = v.t_ms // day_ms
        if prev_day is not None and d != prev_day:
            slots.append(idx - 1)  # last vote of the previous day
        prev_day = d
    if dataset.n:
        slots.append(dataset.n)  # close the final day
    slots = _preset_slots(slots, dataset.n)
    return _spec(dataset_name, schedule_id,
                 {"mode": "explicit-event-index", "at": slots},
                 notes="one recompute per UTC day (from real timestamps)")


def _preset_slots(slots: list[int], n: int) -> list[int]:
    """Space preset cuts over available votes; resolution owns explicit dedup.

    Preserve zero on empty datasets so missing empty-checkpoint opt-in fails.
    """
    return [min(n, max(1, int(s))) for s in slots]
