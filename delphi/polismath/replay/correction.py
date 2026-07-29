"""L2 — self-normalized importance-sampling correction of the L1 posterior.

The L1 DP samples schedules exactly from the prefix-sufficient surrogate
posterior q. The full model differs by (a) chain-dependent emission effects
the surrogate ignores (warm-start state entering the weights) and (b) the
endpoint potential matching the recorded final blob. Since draws come exactly
from q, the self-normalized IS weight of a draw is::

    log w(σ) = delta(σ) + endpoint(σ)

where ``delta = log p_true_emission(σ) - log p_surrogate_emission(σ)`` is
returned by the engine (0 when chain effects are negligible) and
``endpoint(σ) = -||features(σ) - obs||² / (2 · scale²)``. No density
evaluation of q is needed — the common factor cancels in self-normalization.

This is deliberately not SMC and not MCMC: exact sampling from an exact,
well-matched proposal, one ESS diagnostic, no tuning. Escalate to the
discrete particle filter only if ESS collapses (see the R2 design document
§8-9).
"""

from dataclasses import dataclass
from typing import Optional, Protocol

import numpy as np

from polismath.replay.dp import DPState, sample_schedules
from polismath.replay.types import ReplayDataset, Schedule


class EngineForward(Protocol):
    def forward(
        self, ds: ReplayDataset, schedule: Schedule
    ) -> tuple[float, np.ndarray]:
        """Return (emission log-lik correction vs surrogate, endpoint features)."""
        ...


@dataclass
class ISResult:
    schedules: list[Schedule]
    log_weights: np.ndarray  # unnormalized log w(σ_i)
    ess: float  # effective sample size (Kish)

    def weighted_marginals(self) -> dict[int, float]:
        """Posterior cut marginals under the corrected model."""
        w = np.exp(self.log_weights - np.max(self.log_weights))
        w = w / w.sum()
        out: dict[int, float] = {}
        for wi, sched in zip(w, self.schedules):
            for s in sched:
                out[s] = out.get(s, 0.0) + float(wi)
        return out


def is_correct(
    ds: ReplayDataset,
    state: DPState,
    engine: EngineForward,
    n_samples: int,
    rng: np.random.Generator,
    endpoint_obs: Optional[np.ndarray] = None,
    endpoint_scale: float = 1.0,
) -> ISResult:
    """Draw from the L1 posterior and reweight toward the full model."""
    schedules = sample_schedules(state, n_samples, rng)
    log_w = np.zeros(len(schedules))
    for i, sched in enumerate(schedules):
        delta, feats = engine.forward(ds, sched)
        lw = float(delta)
        if endpoint_obs is not None:
            diff = np.asarray(feats, dtype=float) - np.asarray(
                endpoint_obs, dtype=float
            )
            lw += float(-np.dot(diff, diff) / (2.0 * endpoint_scale**2))
        log_w[i] = lw
    # Kish ESS on self-normalized weights
    w = np.exp(log_w - np.max(log_w))
    w_norm = w / w.sum()
    ess = float(1.0 / np.sum(w_norm**2))
    return ISResult(schedules=schedules, log_weights=log_w, ess=ess)
