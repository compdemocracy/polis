"""Python replay driver — replay harness Phase H-A (design §6).

Chains :meth:`polismath.conversation.conversation.Conversation.update_votes`
over the schedule's batches, recomputing at each cut point, and records full
per-step state. ``update_votes`` is pure-functional (deepcopy → new object,
conversation.py:255-485, deepcopy at :269), so the driver is a straight fold over
batches — this
same driver is the future R2 forward model (design §1.3).

Verified API facts (read from conversation.py, NOT guessed):

- ``Conversation(zid, last_updated=…)`` — NB ``self.last_updated = last_updated
  or int(time.time()*1000)``: **0 is falsy**, so a 0 base silently falls back to
  wall-clock. The driver seeds a non-zero base (first vote's t_ms) to stay
  deterministic.
- ``update_votes({'votes': [{pid,tid,vote,created}], 'lastVoteTimestamp': ms},
  recompute=bool)`` → new Conversation. Within a batch it keeps the LAST vote
  per (pid,tid); across batches the reindex+where merge overwrites cells, so
  feeding sorted votes gives later-vote-wins. ``last_updated`` becomes
  ``max(lastVoteTimestamp, prev)`` — deterministic given the batch max.
- ``update_moderation({'mod_out_tids','mod_in_tids','meta_tids','mod_out_ptpts'},
  recompute=bool)`` → new Conversation. Quirk: each set is replaced only when
  its list is truthy (conversation.py:616-626), so an EMPTY list cannot clear a
  previously-set set. This seam is BROADER than "all moderation removed": ANY
  single set emptying is silently retained — e.g. un-moderating the LAST mod_out
  tid while mod_in is still active leaves that tid zeroed. The driver passes full
  cumulative (latest-wins) sets and now DETECTS an emptying transition
  (:func:`_guard_moderation_clear`), failing loudly rather than recording a stale
  state. ``meta_tids`` / ``mod_out_ptpts`` are out of H-A scope (never wired by
  this driver); the real clear-semantics fix is a conversation.py change tracked
  on the seam wishlist.
- ``recompute()`` → new Conversation recomputing PCA→clusters→repness→
  priorities→participant-info on the moderation-applied matrix. Standalone
  after an ``update_votes(recompute=False)``.

Vote-sign convention (design §5, D1b journal): export CSVs are ALREADY in
Delphi convention (AGREE=+1) — the raw-DB→export flip lives in
server/src/report.ts. ``VoteEvent.sign`` carries that export sign and
``update_votes`` consumes it AS-IS (no flip). The FUTURE Clojure driver (H-B)
must feed raw-DB signs (flipped); the store records which convention was used.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from typing import Any, Callable

from polismath.conversation.conversation import Conversation
from polismath.replay.schedule import ReplayStep, ScheduleSpec, slice_schedule
from polismath.replay.types import ModEvent, ReplayDataset
from polismath.utils.engine_mode import ENGINE_MODE_LEGACY, resolve_engine_mode

# Vote sign convention recorded in provenance; the future Clojure driver flips.
VOTE_SIGN_CONVENTION = "delphi"  # AGREE=+1 (export convention, no re-flip)


@dataclass
class StepRecord:
    """Everything recorded at one replay step (design §6)."""

    index: int
    prev_slot: int
    cut_slot: int
    batch_size: int
    cut_time_ms: int
    blob: dict[str, Any]  # Conversation.to_dict() — the cross-language surface
    extras: dict[str, Any] = field(default_factory=dict)  # cheap diagnostics


def run_replay(
    dataset: ReplayDataset,
    spec: ScheduleSpec,
    *,
    progress: Callable[[int, int], None] | None = None,
) -> list[StepRecord]:
    """Replay ``dataset`` through the math engine on ``spec``'s schedule.

    Returns one :class:`StepRecord` per cut slot, in order. Deterministic given
    (dataset, spec): PCA power-iteration and k-means are fixed-seeded, and all
    timestamps are data-derived — the only wall-clock field is the blob's
    ``math_tick`` (conversation.py:2226). ``progress(i, total)`` is called
    before each step if provided.
    """
    steps = slice_schedule(dataset, spec)
    total = len(steps)

    # replay.clj CLI parity: restart_after must leave at least one step after
    # the seam (0 <= r <= n_steps-2), else the "restart" would never be
    # observed by any subsequent step — reject rather than silently no-op.
    if spec.restart_after is not None and not (
        0 <= spec.restart_after <= total - 2
    ):
        raise ValueError(
            "restart_after must be a step index with at least one step after "
            f"it; got {spec.restart_after!r} for {total} steps"
        )

    # `or 1`: a first vote at t_ms==0 would seed last_updated=0, which
    # Conversation's `last_updated or now` footgun (conversation.py:205) turns
    # into wall-clock — breaking determinism. Floor to 1 (nonzero).
    base_last_updated = (dataset.votes[0].t_ms or 1) if dataset.votes else 1
    conv = Conversation(spec.dataset, last_updated=base_last_updated)
    # Q12 pinned cold start (CLOJURE_QUIRKS.md): production Clojure draws an
    # UNSEEDED random PCA start vector on the cold tick (rand-starting-vec,
    # pca.clj:79-82); with a small eigengap the 100 power iterations keep a
    # start-dependent residual, so even two Clojure runs differ. Both replay
    # drivers pin the cold start to the ONES vector — the value both engines
    # already pad new-comment columns with (pca.clj:46-49 / pca.py
    # _power_iteration) — via a single-element start that padding expands to
    # all-ones at any width. Warm ticks take the real previous comps from
    # tick 2 on, exactly as before. Mirrors dev/replay.clj
    # certify-cold-start-pca.
    conv.pca = {'center': np.zeros(1), 'comps': np.array([[1.0], [1.0]])}

    # Cumulative latest-wins moderation value per tid across the whole replay
    # (improved-mode path only; legacy mode carries its own mod state on
    # `conv` via `mod_update` — see the branch below).
    mod_state: dict[int, int] = {}
    legacy = resolve_engine_mode() == ENGINE_MODE_LEGACY

    # The restart seam replays woven mods via mod_update — Clojure's (and
    # legacy mode's) reducer semantics. Improved mode moderates through
    # update_moderation (truthy-replace lists); silently applying mod_update
    # at its restart seam would mix semantics (#2656 review, 2026-07-24).
    if spec.restart_after is not None and spec.moderation != "none" and not legacy:
        raise NotImplementedError(
            "restart_after with a moderation-bearing schedule is only "
            "implemented for clojure-legacy engine mode: the restart seam "
            "replays woven mods via mod_update (legacy reducer semantics), "
            "which does not mirror improved mode's update_moderation."
        )

    records: list[StepRecord] = []
    # Mods woven into steps so far — the restart seam replays exactly these
    # (clj restart-conv: (mapcat :mods steps-so-far)), NEVER dataset.mod_events
    # (a new-format comments CSV carries mod events even for schedules that
    # weave none of them).
    woven_mods: list[ModEvent] = []
    for step in steps:
        if progress is not None:
            progress(step.index, total)

        conv = conv.update_votes(_votes_dict(step), recompute=False)

        if legacy:
            # Clojure batch order (:votes :moderation, conv_man.clj:361-371):
            # the votes recompute runs FIRST, on the PRIOR step's mod state.
            # mod_update then touches only sets/watermark for THIS step's
            # blob — NO recompute — so a mod change's effect on the math
            # lands at the NEXT votes recompute (module docstring / conv/
            # mod_update docstring). moderation="none" schedules never reach
            # the `if step.mod_events` branch below, so this is bit-identical
            # to the pre-existing (unconditional) `conv.recompute()` call for
            # every schedule that doesn't request moderation.
            conv = conv.recompute()
            if step.mod_events:
                conv = conv.mod_update(_mod_rows(step.mod_events))
        else:
            if step.mod_events:
                for m in step.mod_events:
                    mod_state[m.tid] = m.mod
                mod = _mod_dict(mod_state)
                _guard_moderation_clear(conv, mod)
                conv = conv.update_moderation(mod, recompute=True)
            else:
                conv = conv.recompute()

        record = StepRecord(
            index=step.index,
            prev_slot=step.prev_slot,
            cut_slot=step.cut_slot,
            batch_size=len(step.vote_events),
            cut_time_ms=step.cut_time_ms,
            blob=conv.to_dict(),
            extras=_step_extras(conv),
        )
        records.append(record)
        woven_mods.extend(step.mod_events)

        if spec.restart_after is not None and step.index == spec.restart_after:
            conv = _restart_conversation(
                dataset, cut_slot=step.cut_slot, cut_time_ms=step.cut_time_ms,
                blob=record.blob, mod_events=tuple(woven_mods),
            )
    return records


def _votes_dict(step: ReplayStep) -> dict[str, Any]:
    """Map a batch of VoteEvents to update_votes' expected payload.

    ``created`` carries each vote's own timestamp; ``lastVoteTimestamp`` is the
    batch max (== the sorted batch's last vote) so ``last_updated`` advances
    deterministically. Signs pass through in Delphi convention (see module doc).
    """
    votes = [
        {"pid": v.pid, "tid": v.tid, "vote": v.sign, "created": v.t_ms}
        for v in step.vote_events
    ]
    return {"votes": votes, "lastVoteTimestamp": step.cut_time_ms}


def _guard_moderation_clear(conv: Conversation, mod: dict[str, list[int]]) -> None:
    """Fail loudly on a moderation-set emptying transition the engine can't apply.

    ``Conversation.update_moderation`` replaces ``mod_out_tids`` / ``mod_in_tids``
    only when the incoming list is TRUTHY (conversation.py:616-626), so an EMPTY
    list can NOT clear a previously-applied set. If the schedule un-moderates the
    LAST tid of a set while the conversation still holds it non-empty, the driver
    would silently record the stale (still-zeroed) tids. Rather than emit a wrong
    recording, raise — this is the H-A moderation-clear seam; the real fix is a
    ``conversation.py`` change (clear on empty), tracked on the seam wishlist.
    (``meta_tids`` / ``mod_out_ptpts`` are out of H-A scope: the driver never
    wires them, so they are not guarded here.)
    """
    stale: list[str] = []
    if not mod["mod_out_tids"] and getattr(conv, "mod_out_tids", None):
        stale.append("mod_out_tids")
    if not mod["mod_in_tids"] and getattr(conv, "mod_in_tids", None):
        stale.append("mod_in_tids")
    if stale:
        raise NotImplementedError(
            "replay driver cannot represent clearing "
            f"{', '.join(stale)}: Conversation.update_moderation ignores an empty "
            "list, so the previously-moderated tids would silently persist. Wire "
            "the real clear semantics (conversation.py update_moderation seam) "
            "before replaying a schedule that empties a moderation set."
        )


def _mod_rows(events: tuple[ModEvent, ...]) -> list[dict[str, Any]]:
    """Map a batch of ModEvents to ``Conversation.mod_update``'s row shape
    (``{tid, is_meta, mod, modified}`` — conversation.clj:846-884 parity)."""
    return [
        {"tid": m.tid, "is_meta": m.is_meta, "mod": m.mod, "modified": m.t_ms}
        for m in events
    ]


def _restart_conversation(
    dataset: ReplayDataset, *, cut_slot: int, cut_time_ms: int, blob: dict[str, Any],
    mod_events: tuple[ModEvent, ...],
) -> Conversation:
    """Rebuild a conversation from its OWN just-recorded step blob — the
    Python mirror of a Clojure worker restart (conv_man.clj load-or-init /
    restructure-json-conv; MOD_RESTART_PORT_SPEC.md "Replay-step semantics").

    ``Conversation.from_dict`` restores the warm state Clojure's
    restructure-json-conv keeps (PCA, moderation sets, repness, tid arrival
    order, …) but — like Clojure resetting raw-rating-mat — leaves BOTH
    rating matrices empty, and never restores the per-k group-clusterings /
    group-k-smoother warm-start state at all (poller/__init__.py's
    documented "load-or-init finding": ``from_dict`` does not restore
    ``raw_rating_mat``/``rating_mat``/``group_clusterings``/
    ``group_k_smoother``). This rebuilds the matrices from the FULL vote
    slice (dataset order, ONE batch, no recompute — mirrors update-nmat over
    every vote with slot <= cut_slot) and replays the WOVEN mod history so
    far via ``mod_update`` — ``mod_events`` is exactly the mods the schedule
    wove into steps up to the seam, in woven order (clj restart-conv:
    ``(mapcat :mods steps-so-far)``, dev/replay.clj), NEVER
    ``dataset.mod_events`` (which a new-format comments CSV populates even
    when the schedule weaves none of them). Empty is fine — still called
    unconditionally, mirroring Clojure's conv-mod-poll 0 at restart;
    ``mod_update`` always sets ``moderation_applied = True``, matching
    Clojure set-ifying mod sets so a post-restart blob emits ``[]`` rather
    than ``null``.
    """
    restored = Conversation.from_dict(blob)

    all_votes = [
        {"pid": v.pid, "tid": v.tid, "vote": v.sign, "created": v.t_ms}
        for v in dataset.votes[:cut_slot]
    ]
    restored = restored.update_votes(
        {"votes": all_votes, "lastVoteTimestamp": cut_time_ms}, recompute=False
    )

    restored = restored.mod_update(_mod_rows(mod_events))
    return restored


def _mod_dict(mod_state: dict[int, int]) -> dict[str, list[int]]:
    """Cumulative moderation sets from latest-wins per-tid mod values.

    -1 → moderated-out, 1 → moderated-in, 0 → unmoderated (absent from both).
    """
    return {
        "mod_out_tids": sorted(t for t, v in mod_state.items() if v == -1),
        "mod_in_tids": sorted(t for t, v in mod_state.items() if v == 1),
    }


def _step_extras(conv: Conversation) -> dict[str, Any]:
    """Cheap, read-only diagnostics (design §6) — NO production-code changes.

    All fields are derived from already-computed conversation state; none add a
    computation seam. ``n_in_conv`` is the clustering in-conv count (may differ
    from the blob's ``in-conv``, which uses the to_dict threshold) — a useful
    localization signal when steps diverge.
    """
    return {
        "n_participants": int(conv.participant_count),
        "n_comments": int(conv.comment_count),
        "n_votes": int(conv.vote_stats.get("n_votes", 0)),
        "n_base_clusters": len(conv.base_clusters or []),
        "n_group_clusters": len(conv.group_clusters or []),
        "n_in_conv": len(conv._get_in_conv_participants()),
        "n_mod_out": len(conv.mod_out_tids),
        "pca_present": conv.pca is not None,
    }
