"""L1 — exact changepoint dynamic program over the candidate lattice.

Under the prefix-sufficient surrogate model (weights of a segment depend only
on the vote prefix at its left cut), the posterior over schedules factorizes
over segments and admits exact forward-backward recursions in the style of
Fearnhead (2006): the DP below computes the exact normalizer, exact per-slot
cut marginals, the MAP schedule (max-product), and exact posterior samples
(backward simulation). Its correctness contract is *equality with brute-force
enumeration*, enforced in tests/replay/test_dp.py.

Nodes are ``[-1] + lattice.slots`` (``-1`` = "no recompute yet", uniform
weights) plus a terminal covering the tail ``(last cut, n]``. Transitions
spanning a forced slot are forbidden; the count constraint (tick side-info)
adds an optional count dimension.
"""

import math
from dataclasses import dataclass
from typing import Mapping, Optional

import numpy as np

from polismath.replay.emission import AvailabilityIndex, cumulative_loglik
from polismath.replay.physics import CandidateLattice
from polismath.replay.types import ReplayDataset, Schedule
from polismath.replay.weights import (
    era_a_weights,
    era_b_weights,
    prefix_stats_at_slots,
)

NEG_INF = -math.inf


@dataclass
class PriorConfig:
    log_gamma: float = -3.0  # per-cut penalty (geometric prior on cut count)
    t_range: Optional[tuple[int, int]] = None  # inclusive count constraint


@dataclass
class DPResult:
    log_Z: float
    cut_marginals: dict[int, float]
    map_schedule: Schedule
    map_logpost: float


@dataclass
class DPState:
    """Everything backward sampling needs, kept after the forward pass."""

    nodes: list[int]  # [-1] + slots (node values)
    seg: np.ndarray  # (m, m) transition scores; seg[a, b] for a<b else -inf
    term: np.ndarray  # (m,) terminal segment scores (or -inf if invalid)
    log_gamma: float
    t_range: Optional[tuple[int, int]]
    alpha: np.ndarray  # (m,) unconstrained or (T_max+1, m) constrained


def _lse(arr: np.ndarray) -> float:
    m = float(np.max(arr)) if arr.size else NEG_INF
    if m == NEG_INF:
        return NEG_INF
    return m + math.log(float(np.sum(np.exp(arr - m))))


def weights_for_lattice(
    ds: ReplayDataset,
    lattice: CandidateLattice,
    era: str,
    extremity: Optional[Mapping[int, float]] = None,
    meta_tids: frozenset[int] | set[int] = frozenset(),
) -> dict[int, dict[int, float]]:
    """Weight map per left node: sentinel -1 -> uniform, slot -> era weights."""
    stats = prefix_stats_at_slots(ds.votes, lattice.slots)
    out: dict[int, dict[int, float]] = {-1: {}}
    for s in lattice.slots:
        if era == "B":
            out[s] = era_b_weights(stats[s])
        else:
            out[s] = era_a_weights(stats[s], extremity or {}, set(meta_tids))
    return out


def _score_matrices(
    idx: AvailabilityIndex,
    lattice: CandidateLattice,
    weights_at: Mapping[int, Mapping[int, float]],
    eps: float,
) -> tuple[list[int], np.ndarray, np.ndarray]:
    """Segment score matrix and terminal vector over DP nodes."""
    n = idx.n
    nodes = [-1] + list(lattice.slots)
    m = len(nodes)
    forced_sorted = sorted(lattice.forced)

    def next_forced_after(v: int) -> int:
        for f in forced_sorted:
            if f > v:
                return f
        return n + 1  # sentinel: no forced slot after v

    seg = np.full((m, m), NEG_INF)
    term = np.full(m, NEG_INF)
    for a, v_a in enumerate(nodes):
        nf = next_forced_after(v_a)
        left = max(v_a, 0)
        k_stop = n if nf > n else nf
        cum = cumulative_loglik(idx, weights_at[v_a], eps=eps, k_stop=k_stop)
        for b in range(a + 1, m):
            v_b = nodes[b]
            if v_b > nf:
                break  # transitions may not span a forced slot
            seg[a, b] = cum[v_b] - cum[left]
        if nf > n:  # terminal transition valid: no forced slot remains
            term[a] = cum[n] - cum[left]
    return nodes, seg, term


def run_dp(
    idx: AvailabilityIndex,
    lattice: CandidateLattice,
    weights_at: Mapping[int, Mapping[int, float]],
    prior: PriorConfig,
    eps: float = 0.02,
) -> tuple[DPResult, DPState]:
    nodes, seg, term = _score_matrices(idx, lattice, weights_at, eps)
    m = len(nodes)
    lg = prior.log_gamma

    if prior.t_range is None:
        # ---- unconstrained: alpha over nodes -------------------------------
        alpha = np.full(m, NEG_INF)
        alpha[0] = 0.0
        for b in range(1, m):
            alpha[b] = _lse(alpha[:b] + seg[:b, b] + lg)
        log_z = _lse(alpha + term)

        beta = np.full(m, NEG_INF)
        for a in range(m - 1, -1, -1):
            parts = [term[a]]
            if a + 1 < m:
                parts.append(_lse(seg[a, a + 1 :] + lg + beta[a + 1 :]))
            beta[a] = _lse(np.array(parts))
        assert abs((alpha[0] + beta[0]) - log_z) < 1e-6, "forward/backward mismatch"

        marginals = {
            nodes[b]: float(np.exp(alpha[b] + beta[b] - log_z)) for b in range(1, m)
        }

        # ---- MAP (max-product) ---------------------------------------------
        delta = np.full(m, NEG_INF)
        psi = np.full(m, -1, dtype=int)
        delta[0] = 0.0
        for b in range(1, m):
            cand = delta[:b] + seg[:b, b] + lg
            psi[b] = int(np.argmax(cand))
            delta[b] = float(cand[psi[b]])
        totals = delta + term
        end = int(np.argmax(totals))
        map_logpost = float(totals[end])
        sched: list[int] = []
        a = end
        while a != 0:
            sched.append(nodes[a])
            a = int(psi[a])
        map_schedule = tuple(reversed(sched))

        state = DPState(
            nodes=nodes, seg=seg, term=term, log_gamma=lg, t_range=None, alpha=alpha
        )
        return (
            DPResult(
                log_Z=float(log_z),
                cut_marginals=marginals,
                map_schedule=map_schedule,
                map_logpost=map_logpost,
            ),
            state,
        )

    # ---- constrained: count dimension --------------------------------------
    t_min, t_max = prior.t_range
    t_max = min(t_max, m - 1)
    if t_min > t_max:
        raise ValueError(f"infeasible t_range {prior.t_range} with {m - 1} slots")
    alpha_c = np.full((t_max + 1, m), NEG_INF)
    alpha_c[0, 0] = 0.0
    for t in range(1, t_max + 1):
        for b in range(1, m):
            alpha_c[t, b] = _lse(alpha_c[t - 1, :b] + seg[:b, b] + lg)

    z_parts = [
        alpha_c[t] + term
        for t in range(t_min, t_max + 1)
    ]
    log_z = _lse(np.concatenate(z_parts))

    beta_c = np.full((t_max + 2, m), NEG_INF)  # beta_c[t, a]: completions given t cuts so far
    for t in range(t_max, -1, -1):
        for a in range(m - 1, -1, -1):
            parts = []
            if t_min <= t <= t_max:
                parts.append(np.array([term[a]]))
            if a + 1 < m and t + 1 <= t_max:
                parts.append(seg[a, a + 1 :] + lg + beta_c[t + 1, a + 1 :])
            beta_c[t, a] = _lse(np.concatenate(parts)) if parts else NEG_INF
    assert abs((alpha_c[0, 0] + beta_c[0, 0]) - log_z) < 1e-6

    marginals = {}
    for b in range(1, m):
        mass = _lse(
            np.array([alpha_c[t, b] + beta_c[t, b] for t in range(1, t_max + 1)])
        )
        marginals[nodes[b]] = float(np.exp(mass - log_z))

    delta_c = np.full((t_max + 1, m), NEG_INF)
    psi_c = np.full((t_max + 1, m), -1, dtype=int)
    delta_c[0, 0] = 0.0
    for t in range(1, t_max + 1):
        for b in range(1, m):
            cand = delta_c[t - 1, :b] + seg[:b, b] + lg
            psi_c[t, b] = int(np.argmax(cand))
            delta_c[t, b] = float(cand[psi_c[t, b]])
    best = (NEG_INF, 0, 0)
    for t in range(t_min, t_max + 1):
        totals = delta_c[t] + term
        b = int(np.argmax(totals))
        if float(totals[b]) > best[0]:
            best = (float(totals[b]), t, b)
    map_logpost, t_star, b = best
    sched = []
    t = t_star
    while t > 0:
        sched.append(nodes[b])
        b = int(psi_c[t, b])
        t -= 1
    map_schedule = tuple(reversed(sched))

    state = DPState(
        nodes=nodes, seg=seg, term=term, log_gamma=lg,
        t_range=(t_min, t_max), alpha=alpha_c,
    )
    return (
        DPResult(
            log_Z=float(log_z),
            cut_marginals=marginals,
            map_schedule=map_schedule,
            map_logpost=float(map_logpost),
        ),
        state,
    )


def _draw(rng: np.random.Generator, logits: np.ndarray) -> int:
    z = _lse(logits)
    p = np.exp(logits - z)
    p = p / p.sum()
    return int(rng.choice(len(logits), p=p))


def sample_schedules(
    state: DPState, n: int, rng: np.random.Generator
) -> list[Schedule]:
    """Exact posterior samples via backward simulation."""
    out: list[Schedule] = []
    m = len(state.nodes)
    lg = state.log_gamma
    for _ in range(n):
        sched: list[int] = []
        if state.t_range is None:
            alpha = state.alpha
            b = _draw(rng, alpha + state.term)
            while b != 0:
                sched.append(state.nodes[b])
                b = _draw(rng, alpha[:b] + state.seg[:b, b] + lg)
        else:
            t_min, t_max = state.t_range
            alpha_c = state.alpha
            # joint draw of (t, last node)
            logits = np.full((t_max + 1, m), NEG_INF)
            for t in range(t_min, t_max + 1):
                logits[t] = alpha_c[t] + state.term
            flat = _draw(rng, logits.ravel())
            t, b = divmod(flat, m)
            while t > 0:
                sched.append(state.nodes[b])
                b = _draw(rng, alpha_c[t - 1, :b] + state.seg[:b, b] + lg)
                t -= 1
        out.append(tuple(reversed(sched)))
    return out


def log_posterior(
    idx: AvailabilityIndex,
    lattice: CandidateLattice,
    weights_at: Mapping[int, Mapping[int, float]],
    prior: PriorConfig,
    schedule: Schedule,
    eps: float = 0.02,
) -> float:
    """Direct (non-DP) score of one schedule; the enumeration/IS work-horse."""
    slots = set(lattice.slots)
    if not set(schedule) <= slots:
        return NEG_INF
    if not lattice.forced <= set(schedule):
        return NEG_INF
    if list(schedule) != sorted(set(schedule)):
        return NEG_INF
    if prior.t_range is not None:
        t_min, t_max = prior.t_range
        if not t_min <= len(schedule) <= t_max:
            return NEG_INF

    total = len(schedule) * prior.log_gamma
    lefts = [-1, *schedule]
    rights = [*schedule, idx.n]
    for v_a, v_b in zip(lefts, rights):
        cum = cumulative_loglik(idx, weights_at[v_a], eps=eps, k_stop=v_b)
        total += float(cum[v_b] - cum[max(v_a, 0)])
    return total
