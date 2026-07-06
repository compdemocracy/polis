# polismath.replay — R2 schedule inference

Posterior inference of the **latent recompute schedule** of a historic Polis
conversation from its append-only votes table. Production kept no history of
math states (`math_main` is latest-only), so the sequence of recompute
instants ("cuts") is unobserved; every intermediate state is re-derivable by
replay **once the schedule is known**. This package infers it.

Companion documents: `docs/plans/2026-07-06-r2-schedule-inference.md`
(implementation plan, model conventions) and the R2 design PDF
("R2: Bayesian Inference of the Latent Recompute Schedule in Polis Math
Replay", 2026-07-06) for the full mathematical treatment; the replay-harness
context lives in `docs/REPLAY_HARNESS_DESIGN.md` (parity-stack chain).

## Model in one paragraph

A schedule is a strictly increasing tuple of *cut slots* (vote indices after
which the worker recomputed). The posterior factorizes as
`p(σ | data) ∝ p_physics(σ) · L_marks(σ) · Ψ_endpoint(σ)`: a schedule prior
from poller physics (forced cuts at long gaps, min-spacing = fastest compute,
a soft exponential penalty on unexplained worker idleness), a Cox-style
partial likelihood over *which* comment each vote landed on (Plackett–Luce
weighted sampling with the priorities of the last recompute — era A: the
`priority-metric` formula; era B, post-2025-03-20: all-49 with default-1 for
not-yet-ingested comments), and an optional endpoint potential matching the
recorded final blob. Emissions lag cuts by compute + cache time (the δ-shift).
Because the weights are prefix-sufficient, the posterior admits an **exact**
changepoint DP — no SMC, no MCMC; L2 corrects toward chain-dependent effects
by plain self-normalized importance sampling from exact DP samples.

## Modules

| Module | Role |
|---|---|
| `types` | `VoteEvent`, `CommentMeta`, `ModEvent`, `ReplayDataset`, `Schedule` |
| `weights` | prefix statistics; era A / era B priority weights |
| `emission` | availability index + PL mark log-likelihood (O(1)/vote denominators) |
| `physics` | L0: forced cuts, candidate lattice |
| `scan` | L1a proposals + `infer_schedule` (the pipeline entry point) |
| `dp` | L1: exact forward–backward, MAP, exact posterior sampling |
| `correction` | L2: IS correction (engine delta + endpoint potential), ESS |
| `synthetic` | generative simulator with ground-truth schedules |
| `real_data` | export-CSV loader (slug glob, no report-ids in code) |

## Quick use

```python
from polismath.replay import ReplayDataset
from polismath.replay.dp import PriorConfig, sample_schedules
from polismath.replay.scan import infer_schedule

ds = ReplayDataset.build(raw_votes)          # (t_ms, pid, tid, sign) rows
res = infer_schedule(
    ds, era="B", poll_interval_ms=1000, compute_ms=30_000,
    prior=PriorConfig(log_gamma=0.0, t_range=(T_ticks_lo, T_ticks_hi)),
    compute_jitter=0.3, idle_lambda_per_s=0.1,
)
res.dp.cut_marginals                          # per-slot posterior probability
samples = sample_schedules(res.state, 200, rng)  # exact posterior draws
```

## Validated behaviour (synthetic ground truth, see tests/replay/)

- The DP equals brute-force enumeration (Z, marginals, MAP, sampling) to
  1e-9, in both eras, constrained and unconstrained, with min-spacing and
  emission-delay active.
- Posterior localization of true cuts: **median 1 vote, p90 2 votes** in the
  moderate regime (both eras); on the real vw timing skeleton (bursty,
  median inter-vote gap 0 s): **median ~10 s, p90 ~21 s** — physics-limited
  (the compute-jitter window), which is the honest unit for bursty traffic.
- Physics soundness: forced cuts are never false (`forced ⊆ truth` across
  seeds, with downtime windows respected).
- The MAP is a fragile summary in emission-flat stretches (a single
  insertion cascades in sorted pairing); consume the posterior (marginals /
  samples), not the MAP.

## Era caveats

- **Era A** (pre-2025-03-20): varied weights → information-rich emissions.
  Real export CSVs carry *flipped* signs vs the DB (export-only flip,
  `math/src/polismath/darwin/export.clj:106-113`) — audit the sign mapping
  before era-A weight computation on export data.
- **Era B** (after commit `dff835d7e`): all priorities ≡ 49; the only
  emission signal is the 49-vs-1 contrast for comments not yet ingested at
  the last cut. Physics carries most of the localization.
- Extremity `E` (era A) is engine-supplied; until the certified legacy-mode
  engine adapter lands, `extremity={}` (E=0) is a documented surrogate.

## v1 approximations (documented, revisit as needed)

- Moderation affects availability only, not the weight domain (exact for
  era B; approximation for era A).
- Moderation history is itself partially latent upstream (only the last
  change is recorded); mod events are taken at face value.
- Count-constrained inference densifies the lattice (dense DP), suitable up
  to a few thousand votes; large-n runs should use the unconstrained prior
  (γ per-cut penalty) with the thinned lattice.
- The L2 engine contract is a *delta* (emission log-lik correction vs the
  surrogate); the real Python legacy-mode engine adapter is future work —
  test engines validate the IS identities.
