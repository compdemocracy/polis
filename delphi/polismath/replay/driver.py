"""Python replay driver — replay harness Phase H-A (design §6).

Chains :meth:`polismath.conversation.conversation.Conversation.update_votes`
over the schedule's batches, recomputing at each cut point, and records full
per-step state. ``update_votes`` is pure-functional (deepcopy → new object,
conversation.py:177-211), so the driver is a straight fold over batches — this
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
  its list is truthy, so an EMPTY list cannot clear a previously-set set. The
  driver passes full cumulative (latest-wins) sets; the only unreachable
  transition is "all moderation removed" (documented seam).
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
from typing import Any, Callable

from polismath.conversation.conversation import Conversation
from polismath.replay.schedule import ReplayStep, ScheduleSpec, slice_schedule
from polismath.replay.types import ReplayDataset

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
    ``math_tick`` (conversation.py:1942). ``progress(i, total)`` is called
    before each step if provided.
    """
    steps = slice_schedule(dataset, spec)
    total = len(steps)

    base_last_updated = dataset.votes[0].t_ms if dataset.votes else 1
    conv = Conversation(spec.dataset, last_updated=base_last_updated)

    # Cumulative latest-wins moderation value per tid across the whole replay.
    mod_state: dict[int, int] = {}

    records: list[StepRecord] = []
    for step in steps:
        if progress is not None:
            progress(step.index, total)

        conv = conv.update_votes(_votes_dict(step), recompute=False)

        if step.mod_events:
            for m in step.mod_events:
                mod_state[m.tid] = m.mod
            conv = conv.update_moderation(_mod_dict(mod_state), recompute=True)
        else:
            conv = conv.recompute()

        records.append(
            StepRecord(
                index=step.index,
                prev_slot=step.prev_slot,
                cut_slot=step.cut_slot,
                batch_size=len(step.vote_events),
                cut_time_ms=step.cut_time_ms,
                blob=conv.to_dict(),
                extras=_step_extras(conv),
            )
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
