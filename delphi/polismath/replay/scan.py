"""L1a — candidate-cut proposals, and the end-to-end inference pipeline.

Proposal sources (approximate, used only to build the lattice — never to
force):

- the first-vote slot of every comment: a comment enters the weight domain at
  the first cut at/after its first ingested vote, so its serve-rate step is
  localized there (in era B this is the *only* emission signal);
- slots at moderation-event times (availability changes cluster near cuts in
  production);
- physics filler comes from :func:`polismath.replay.physics.build_lattice`.

``infer_schedule`` wires the full L0 → L1a → L1 pipeline.
"""

from bisect import bisect_left
from dataclasses import dataclass
from typing import Mapping, Optional, Sequence

from polismath.replay.dp import (
    DPResult,
    DPState,
    PriorConfig,
    run_dp,
    weights_for_lattice,
)
from polismath.replay.emission import AvailabilityIndex
from polismath.replay.physics import CandidateLattice, build_lattice, forced_slots
from polismath.replay.types import ReplayDataset


@dataclass
class InferenceResult:
    dp: DPResult
    state: DPState
    lattice: CandidateLattice
    weights_at: dict[int, dict[int, float]]


def propose_candidates(ds: ReplayDataset) -> set[int]:
    out: set[int] = set()
    seen: set[int] = set()
    for v in ds.votes:
        if not v.is_revote and v.tid not in seen:
            seen.add(v.tid)
            out.add(v.k)  # cut right after this vote flips the tid into dom
            if v.k > 1:
                out.add(v.k - 1)  # and the slot just before (flip not yet visible)
    vote_times = [v.t_ms for v in ds.votes]
    for me in ds.mod_events:
        k = bisect_left(vote_times, me.t_ms)
        if 1 <= k <= ds.n:
            out.add(k)
    return out


def infer_schedule(
    ds: ReplayDataset,
    *,
    era: str,
    poll_interval_ms: int = 1000,
    compute_ms: int = 5000,
    downtime_ms: Sequence[tuple[int, int]] = (),
    extremity: Optional[Mapping[int, float]] = None,
    meta_tids: frozenset[int] | set[int] = frozenset(),
    prior: Optional[PriorConfig] = None,
    eps: float = 0.02,
    max_slots: int = 400,
    burst_stride: int = 8,
    min_spacing_ms: Optional[int] = None,
    emission_delay_ms: Optional[int] = None,
    compute_jitter: float = 0.3,
    idle_lambda_per_s: float = 0.0,
) -> InferenceResult:
    """L0 physics -> L1a proposals -> lattice -> exact DP.

    ``compute_ms`` is the point estimate of the worker's recompute duration;
    ``compute_jitter`` its relative uncertainty. Derived physics (all
    overridable):

    - ``min_spacing_ms`` (default ``(1-jitter) * compute_ms``): two
      recomputes cannot be closer in wall time than one fastest compute.
    - ``emission_delay_ms`` (default ``compute_ms``): votes cast while a
      recompute runs (+ cache refresh) are served under the previous weights.
    - ``idle_lambda_per_s`` (default 0 = off): soft renewal prior penalizing
      worker idleness beyond ``(1+jitter) * compute_ms + poll`` while votes
      are pending — pins cuts in emission-flat stretches without ever
      excluding a schedule (robust to unknown stalls/downtime).
    """
    forced = forced_slots(
        ds, poll_interval_ms=poll_interval_ms, compute_ms=compute_ms,
        downtime_ms=downtime_ms,
    )
    extra = propose_candidates(ds)
    prior = prior or PriorConfig()
    lattice = build_lattice(
        ds, forced=forced, extra=extra, max_slots=max_slots,
        burst_stride=burst_stride,
    )
    if prior.t_range is not None:
        # Count-constrained inference always uses the dense lattice: the
        # count + min-spacing constraints interact with thinning to create
        # spurious infeasibility (representative slots stand in for exact cut
        # positions, but the spacing test uses exact slot times). Dense
        # lattices are fine at count-constrained scale (n up to a few
        # thousand); large-n inference should use the unconstrained prior.
        lattice = build_lattice(
            ds, forced=forced, extra=extra,
            max_slots=max(max_slots, ds.n), burst_stride=1,
        )
    weights_at = weights_for_lattice(
        ds, lattice, era=era, extremity=extremity, meta_tids=meta_tids
    )
    idx = AvailabilityIndex(ds)
    dp_result, state = run_dp(
        idx, lattice, weights_at, prior, eps=eps,
        min_spacing_ms=(
            int((1.0 - compute_jitter) * compute_ms)
            if min_spacing_ms is None
            else min_spacing_ms
        ),
        emission_delay_ms=(
            compute_ms if emission_delay_ms is None else emission_delay_ms
        ),
        idle_lambda_per_s=idle_lambda_per_s,
        renewal_compute_ms=int((1.0 + compute_jitter) * compute_ms),
        poll_ms=poll_interval_ms,
    )
    return InferenceResult(
        dp=dp_result, state=state, lattice=lattice, weights_at=weights_at
    )
