"""L0 — deterministic cut backbone from poller physics.

The production worker polls every second and blocks while recomputing
(poller.clj:12-37, conv_man.clj take-all!). Consequently, if the worker was
up throughout a gap between consecutive votes longer than
``poll_interval + compute_time``, it MUST have ingested everything up to the
earlier vote and recomputed — a **forced cut** at exactly that slot. Forced
cuts are hard constraints in the DP (transitions spanning them are
forbidden), so soundness matters more than completeness: when in doubt
(downtime), do not force.

The candidate lattice is the DP's search space: forced slots, proposal slots
from the L1a scans, and stride-thinned filler inside long candidate-free
runs (bursts), capped at ``max_slots`` with forced slots always retained.
"""

from dataclasses import dataclass
from typing import Iterable, Sequence

from polismath.replay.types import ReplayDataset


@dataclass
class CandidateLattice:
    slots: list[int]  # sorted, unique, subset of 1..n
    forced: set[int]  # subset of slots


def forced_slots(
    ds: ReplayDataset,
    poll_interval_ms: int,
    compute_ms: int,
    downtime_ms: Sequence[tuple[int, int]] = (),
) -> set[int]:
    """Slots where the worker must have cut, assuming it was up."""
    threshold = poll_interval_ms + compute_ms

    def overlaps_downtime(t0: int, t1: int) -> bool:
        return any(start < t1 and t0 < end for start, end in downtime_ms)

    forced: set[int] = set()
    votes = ds.votes
    for i in range(len(votes) - 1):
        t0, t1 = votes[i].t_ms, votes[i + 1].t_ms
        if t1 - t0 > threshold and not overlaps_downtime(t0, t1):
            forced.add(votes[i].k)
    return forced


def build_lattice(
    ds: ReplayDataset,
    forced: set[int],
    extra: Iterable[int],
    max_slots: int = 400,
    burst_stride: int = 8,
) -> CandidateLattice:
    """Assemble the candidate slot lattice."""
    n = ds.n
    candidates = {s for s in forced if 1 <= s <= n}
    candidates |= {s for s in extra if 1 <= s <= n}

    # stride-thinned filler across candidate-free runs (bursts)
    anchors = sorted(candidates | {0, n + 1})
    for a, b in zip(anchors, anchors[1:]):
        s = a + burst_stride
        while s < b and s <= n:
            if s >= 1:
                candidates.add(s)
            s += burst_stride

    if len(candidates) > max_slots:
        others = sorted(candidates - forced)
        budget = max(max_slots - len(forced), 0)
        if budget and others:
            step = len(others) / budget
            kept = {others[int(i * step)] for i in range(budget)}
        else:
            kept = set()
        candidates = set(forced) | kept

    return CandidateLattice(slots=sorted(candidates), forced=set(forced) & candidates)
