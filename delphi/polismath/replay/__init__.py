"""Replay harness + R2 schedule inference (``polismath.replay``).

Two overlapping efforts share this package:

- **Replay harness (Phase H-A, this branch)** — replay a conversation's vote
  history through the math engine at explicitly-chosen recompute points
  ("schedules"), recording full per-step state for step-by-step comparison.
  See ``delphi/docs/REPLAY_HARNESS_DESIGN.md``. Modules: :mod:`schedule`,
  :mod:`driver`, :mod:`store`, :mod:`stepcompare`.
- **R2 schedule inference** — posterior inference of the *latent* recompute
  schedule of a historic conversation. Modules (added on the R2 branch): dp,
  emission, correction, scan, physics, weights, synthetic, experiments.

The shared foundation is :mod:`types` (event/dataset types) and
:mod:`real_data` (export-CSV loader), lifted verbatim from the R2 branch so a
later rebase dedups cleanly.
"""

from polismath.replay.types import (
    CommentMeta,
    ModEvent,
    ReplayDataset,
    Schedule,
    Vote,
    VoteEvent,
)

__all__ = [
    "CommentMeta",
    "ModEvent",
    "ReplayDataset",
    "Schedule",
    "Vote",
    "VoteEvent",
]
