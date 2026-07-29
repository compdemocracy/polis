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


class InfeasibleScheduleError(ValueError):
    """No schedule satisfies the lattice, forced, count and spacing constraints."""


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


def _emission_shift(
    idx: AvailabilityIndex, emission_delay_ms: int
) -> "np.ndarray":
    """Map cut slot -> first vote index scored under the NEW weights.

    A recompute at slot ``s`` (wall time ~``t_s``) only reaches the router
    after compute + cache lag; votes in between are served under the previous
    weights. ``shift[s]`` = number of votes with ``t <= t_s + delay``, i.e.
    votes ``(s, shift[s]]`` still score under the *old* segment's weights.
    ``shift[0] = 0`` (sentinel node -1: uniform weights active from the
    start). Monotone; identity when delay is 0.
    """
    t_ms = np.array([v.t_ms for v in idx.ds.votes], dtype=np.int64)
    shift = np.zeros(idx.n + 1, dtype=np.int64)
    if idx.n:
        shift[1:] = np.searchsorted(t_ms, t_ms + emission_delay_ms, side="right")
    return shift


def _score_matrices(
    idx: AvailabilityIndex,
    lattice: CandidateLattice,
    weights_at: Mapping[int, Mapping[int, float]],
    eps: float,
    min_spacing_ms: Optional[int] = None,
    emission_delay_ms: int = 0,
    idle_lambda_per_s: float = 0.0,
    renewal_compute_ms: int = 0,
    poll_ms: int = 1000,
) -> tuple[list[int], np.ndarray, np.ndarray]:
    """Segment score matrix and terminal vector over DP nodes.

    Besides the emission scores, transitions carry the *renewal idle
    penalty*: an up worker with pending votes recomputes at the first free
    poll, so wall-clock idleness beyond ``renewal_compute_ms + poll_ms``
    after the previous cut is exponentially penalized at
    ``idle_lambda_per_s`` per second. Soft — never -inf — because real
    workers do stall (GC, restarts, deploys); soundness is preserved while
    emission-flat stretches still get pinned near the physics (see the R2
    design document's schedule prior).
    """
    n = idx.n
    nodes = [-1] + list(lattice.slots)
    m = len(nodes)
    forced_sorted = sorted(lattice.forced)
    t_ms = [v.t_ms for v in idx.ds.votes]
    shift = _emission_shift(idx, emission_delay_ms)

    def idle_penalty(v_a: int, v_b_time_ms: float) -> float:
        # earliest the worker could have been forced busy again after the cut
        # at v_a: the next vote arrives, worker computes, next poll fires
        if idle_lambda_per_s <= 0.0:
            return 0.0
        if v_a < 0:
            ready = t_ms[0] + poll_ms if n else 0.0
        elif v_a >= n:
            return 0.0
        else:
            ready = max(t_ms[v_a], t_ms[v_a - 1] + renewal_compute_ms) + poll_ms
        idle_ms = max(0.0, v_b_time_ms - ready)
        return -idle_lambda_per_s * idle_ms / 1000.0

    def e(v: int) -> int:
        return 0 if v < 0 else int(shift[v])

    def next_forced_after(v: int) -> int:
        for f in forced_sorted:
            if f > v:
                return f
        return n + 1  # sentinel: no forced slot after v

    def spacing_feasible(v_a: int, v_b: int) -> bool:
        # A cut at slot s occurs at wall time in [t_s, t_{s+1}). The maximal
        # spacing between cuts at v_a < v_b is t_{v_b+1} - t_{v_a} (+inf when
        # v_b is the last vote). Forbid only when even that cannot reach
        # min_spacing_ms — sound: never excludes the true schedule.
        if min_spacing_ms is None or v_a < 0 or v_b >= n:
            return True
        max_spacing = t_ms[v_b] - t_ms[v_a - 1]  # t_{v_b+1} - t_{v_a}, 0-indexed
        return max_spacing > min_spacing_ms

    seg = np.full((m, m), NEG_INF)
    term = np.full(m, NEG_INF)
    for a, v_a in enumerate(nodes):
        nf = next_forced_after(v_a)
        left = e(v_a)
        k_stop = n if nf > n else min(n, e(nf))
        cum = cumulative_loglik(idx, weights_at[v_a], eps=eps, k_stop=k_stop)
        for b in range(a + 1, m):
            v_b = nodes[b]
            if v_b > nf:
                break  # transitions may not span a forced slot
            if not spacing_feasible(v_a, v_b):
                continue
            seg[a, b] = cum[e(v_b)] - cum[left] + idle_penalty(v_a, t_ms[v_b - 1])
        if nf > n:  # terminal transition valid: no forced slot remains
            # tail idleness: votes after the last cut were pending forever
            tail_pen = idle_penalty(v_a, t_ms[n - 1]) if n else 0.0
            term[a] = cum[n] - cum[left] + tail_pen
    return nodes, seg, term


def run_dp(
    idx: AvailabilityIndex,
    lattice: CandidateLattice,
    weights_at: Mapping[int, Mapping[int, float]],
    prior: PriorConfig,
    eps: float = 0.02,
    min_spacing_ms: Optional[int] = None,
    emission_delay_ms: int = 0,
    idle_lambda_per_s: float = 0.0,
    renewal_compute_ms: int = 0,
    poll_ms: int = 1000,
) -> tuple[DPResult, DPState]:
    nodes, seg, term = _score_matrices(
        idx, lattice, weights_at, eps,
        min_spacing_ms=min_spacing_ms, emission_delay_ms=emission_delay_ms,
        idle_lambda_per_s=idle_lambda_per_s,
        renewal_compute_ms=renewal_compute_ms, poll_ms=poll_ms,
    )
    m = len(nodes)
    lg = prior.log_gamma

    if prior.t_range is None:
        # ---- unconstrained: alpha over nodes -------------------------------
        alpha = np.full(m, NEG_INF)
        alpha[0] = 0.0
        for b in range(1, m):
            alpha[b] = _lse(alpha[:b] + seg[:b, b] + lg)
        log_z = _lse(alpha + term)
        if log_z == NEG_INF:
            raise InfeasibleScheduleError(
                "no feasible schedule on this lattice (forced/spacing constraints)"
            )

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
    if log_z == NEG_INF:
        raise InfeasibleScheduleError(
            f"no feasible schedule with {prior.t_range} cuts on this lattice "
            "(count/forced/spacing constraints)"
        )

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
    min_spacing_ms: Optional[int] = None,
    emission_delay_ms: int = 0,
    idle_lambda_per_s: float = 0.0,
    renewal_compute_ms: int = 0,
    poll_ms: int = 1000,
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
    if min_spacing_ms is not None:
        t_ms = [v.t_ms for v in idx.ds.votes]
        for s_a, s_b in zip(schedule, schedule[1:]):
            if s_b < idx.n and t_ms[s_b] - t_ms[s_a - 1] <= min_spacing_ms:
                return NEG_INF

    shift = _emission_shift(idx, emission_delay_ms)
    t_ms = [v.t_ms for v in idx.ds.votes]
    n = idx.n

    def e(v: int) -> int:
        return 0 if v < 0 else int(shift[v])

    def idle_penalty(v_a: int, until_ms: float) -> float:
        if idle_lambda_per_s <= 0.0:
            return 0.0
        if v_a < 0:
            ready = t_ms[0] + poll_ms if n else 0.0
        elif v_a >= n:
            return 0.0
        else:
            ready = max(t_ms[v_a], t_ms[v_a - 1] + renewal_compute_ms) + poll_ms
        return -idle_lambda_per_s * max(0.0, until_ms - ready) / 1000.0

    total = len(schedule) * prior.log_gamma
    pairs = list(zip([-1, *schedule], [*schedule, n]))
    for i, (v_a, v_b) in enumerate(pairs):
        is_tail = i == len(pairs) - 1
        hi = n if is_tail else e(v_b)
        cum = cumulative_loglik(idx, weights_at[v_a], eps=eps, k_stop=hi)
        total += float(cum[hi] - cum[e(v_a)])
        if n:
            until = t_ms[n - 1] if is_tail else t_ms[v_b - 1]
            total += idle_penalty(v_a, until)
    return total
