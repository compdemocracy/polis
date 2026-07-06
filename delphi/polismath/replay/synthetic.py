"""Synthetic conversation generator with ground-truth schedules.

Event-driven simulation of the production data-generating process:

- **Participants** arrive, then loop serve → think → vote, quitting
  stochastically or when nothing is servable (censoring). Serves are
  Plackett-Luce draws over available, not-yet-voted comments using the
  *currently servable* weights — comments unknown to the last recompute
  default to weight 1, mirroring ``priorities[tid] || 1``.
- **The worker** polls every ``poll_interval_s`` while up and idle; when new
  votes exist at a poll it ingests them all (a *cut*), recomputes for
  ``compute_time_s`` (blocking, like the conv-man actor), and the new weights
  become servable ``cache_lag_s`` after compute ends (server cache lag).
  Downtime windows suppress polling; restarts add load ticks.
- **Revotes** are injected outside the serve flow (participants going back),
  matching production where revotes cannot be serve-generated.
- **Moderation** events make comments unavailable from their timestamp.

The returned ground truth: cut slots in *sorted-vote-index* space (exactly
the object R2 infers), cut wall-clock times, the tick count (cuts + initial
load + restarts), and the post-cut weight map per segment.
"""

import heapq
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from polismath.replay.types import (
    CommentMeta,
    ModEvent,
    ReplayDataset,
    Schedule,
    VoteEvent,
)
from polismath.replay.weights import PrefixStats, era_a_weights, era_b_weights

_SIGN_VALUES = (1, -1, 0)  # agree, disagree, pass
_SIGN_PROBS = (0.60, 0.25, 0.15)
_MAX_EVENTS = 2_000_000


@dataclass
class SimConfig:
    era: str = "B"  # "A" | "B"
    n_participants: int = 30
    n_comments: int = 20
    mean_votes_per_participant: float = 12.0
    duration_s: float = 3600.0
    poll_interval_s: float = 1.0
    compute_time_s: float = 5.0
    cache_lag_s: float = 0.0
    downtime: list[tuple[float, float]] = field(default_factory=list)
    restarts: list[float] = field(default_factory=list)
    session_quit_prob: Optional[float] = None  # None -> 1/mean_votes_per_participant
    revote_prob: float = 0.01
    meta_frac: float = 0.0
    mod_out: list[tuple[float, int]] = field(default_factory=list)  # (t_s, tid)
    extremity: Optional[dict[int, float]] = None  # era A only
    arrival_rate_per_s: Optional[float] = 0.02  # None -> everyone arrives in 1st second
    think_time_s: float = 20.0
    seed: int = 0


@dataclass
class SimResult:
    dataset: ReplayDataset
    true_schedule: Schedule
    true_cut_times_ms: list[int]
    tick_count: int
    weights_by_segment: list[dict[int, float]]


def simulate(cfg: SimConfig) -> SimResult:
    rng = np.random.default_rng(cfg.seed)
    quit_prob = (
        cfg.session_quit_prob
        if cfg.session_quit_prob is not None
        else 1.0 / cfg.mean_votes_per_participant
    )

    # --- comments -----------------------------------------------------------
    n_meta = int(round(cfg.meta_frac * cfg.n_comments))
    meta_tids = set(range(n_meta))
    created_s: dict[int, float] = {}
    n_seed = min(3, cfg.n_comments)
    for tid in range(n_seed):
        created_s[tid] = 0.0
    for tid in range(n_seed, cfg.n_comments):
        created_s[tid] = float(rng.uniform(0.0, cfg.duration_s * 0.5))
    extremity = cfg.extremity or {}

    # --- event queue --------------------------------------------------------
    # entries: (t, seq, kind, payload); seq keeps ordering deterministic
    heap: list[tuple[float, int, str, tuple]] = []
    seq = 0

    def push(t: float, kind: str, payload: tuple = ()) -> None:
        nonlocal seq
        heapq.heappush(heap, (t, seq, kind, payload))
        seq += 1

    # participant arrivals
    if cfg.arrival_rate_per_s is None:
        arrivals = rng.uniform(0.0, 1.0, size=cfg.n_participants)
    else:
        arrivals = rng.uniform(0.0, cfg.duration_s * 0.8, size=cfg.n_participants)
    for pid, t in enumerate(sorted(arrivals.tolist())):
        push(t, "serve", (pid,))

    for t_s, tid in cfg.mod_out:
        push(t_s, "mod", (tid,))
    for t_s in cfg.restarts:
        push(t_s, "restart", ())

    horizon = cfg.duration_s * 2.0

    def in_downtime(t: float) -> Optional[float]:
        for start, end in cfg.downtime:
            if start <= t < end:
                return end
        return None

    def next_poll_after(t: float) -> float:
        p = cfg.poll_interval_s
        cand = (np.floor(t / p) + 1.0) * p
        while (end := in_downtime(cand)) is not None:
            cand = (np.floor(end / p) + 1.0) * p
        return float(cand)

    push(next_poll_after(0.0), "poll", ())

    # --- state ---------------------------------------------------------------
    votes: list[tuple[float, int, int, int]] = []  # (t_s, pid, tid, sign)
    voted: dict[int, set[int]] = {pid: set() for pid in range(cfg.n_participants)}
    mod_outed: set[int] = set()
    stats = PrefixStats.empty()
    ingested = 0
    weights_servable: dict[int, float] = {}
    cuts: list[tuple[int, float]] = []  # (slot, t_s)
    weights_by_segment: list[dict[int, float]] = [{}]
    restart_ticks = 0

    def compute_weights() -> dict[int, float]:
        if cfg.era == "B":
            return era_b_weights(stats)
        return era_a_weights(stats, extremity, meta_tids)

    def draw_sign() -> int:
        return int(rng.choice(_SIGN_VALUES, p=_SIGN_PROBS))

    def available_for(pid: int, t: float) -> list[int]:
        return [
            tid
            for tid in range(cfg.n_comments)
            if created_s[tid] <= t and tid not in mod_outed and tid not in voted[pid]
        ]

    events = 0
    while heap:
        events += 1
        if events > _MAX_EVENTS:
            raise RuntimeError("synthetic simulation exceeded event budget")
        t, _, kind, payload = heapq.heappop(heap)

        if kind == "mod":
            mod_outed.add(payload[0])

        elif kind == "restart":
            restart_ticks += 1

        elif kind == "servable":
            weights_servable = payload[0]

        elif kind == "poll":
            if t > horizon:
                continue  # stop the poll chain
            if len(votes) > ingested:
                # cut: ingest everything, recompute
                slot = len(votes)
                for t_v, pid, tid, sign in votes[ingested:]:
                    is_revote = (pid, tid) in stats.latest
                    stats.push(
                        VoteEvent(
                            k=0, t_ms=int(round(t_v * 1000)), pid=pid, tid=tid,
                            sign=sign, is_revote=is_revote,
                        )
                    )
                ingested = slot
                w = compute_weights()
                cuts.append((slot, t))
                weights_by_segment.append(w)
                compute_end = t + cfg.compute_time_s
                push(compute_end + cfg.cache_lag_s, "servable", (w,))
                push(next_poll_after(compute_end), "poll", ())
            else:
                push(next_poll_after(t), "poll", ())

        elif kind == "serve":
            (pid,) = payload
            avail = available_for(pid, t)
            if not avail:
                continue  # session ends (censoring by exhaustion)
            w = np.array(
                [weights_servable.get(tid, 1.0) for tid in avail], dtype=float
            )
            tid = int(rng.choice(avail, p=w / w.sum()))
            push(t + float(rng.exponential(cfg.think_time_s)), "vote", (pid, tid))

        elif kind == "vote":
            pid, tid = payload
            if tid in voted[pid]:
                continue  # defensive: never double-vote via the serve flow
            votes.append((t, pid, tid, draw_sign()))
            voted[pid].add(tid)
            if voted[pid] and rng.random() < cfg.revote_prob:
                prior = sorted(voted[pid])
                r_tid = int(prior[int(rng.integers(len(prior)))])
                push(t + float(rng.exponential(30.0)), "revote", (pid, r_tid))
            if rng.random() >= quit_prob:
                push(t + float(rng.exponential(1.0)), "serve", (pid,))

        elif kind == "revote":
            pid, tid = payload
            if tid in voted[pid]:  # only genuine revotes
                votes.append((t, pid, tid, draw_sign()))

    # --- package -------------------------------------------------------------
    raw = [(int(round(t_v * 1000)), pid, tid, sign) for t_v, pid, tid, sign in votes]
    comments = {
        tid: CommentMeta(
            tid=tid, created_ms=int(round(created_s[tid] * 1000)),
            is_meta=tid in meta_tids,
        )
        for tid in range(cfg.n_comments)
    }
    mod_events = [
        ModEvent(t_ms=int(round(t_s * 1000)), tid=tid, mod=-1)
        for t_s, tid in cfg.mod_out
    ]
    dataset = ReplayDataset.build(raw, comments=comments, mod_events=mod_events)

    return SimResult(
        dataset=dataset,
        true_schedule=tuple(slot for slot, _ in cuts),
        true_cut_times_ms=[int(round(t_c * 1000)) for _, t_c in cuts],
        tick_count=len(cuts) + 1 + restart_ticks,
        weights_by_segment=weights_by_segment,
    )
