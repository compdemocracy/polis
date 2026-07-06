"""Plackett-Luce mark likelihood over a fixed weight map.

The mark likelihood of vote ``k`` (non-revote) under weight map ``w`` is::

    log[ (1-eps) * w(c_k) / sum_{c in S_k} w(c)  +  eps / |S_k| ]

where the choice set ``S_k`` contains every comment that is *available* at
``t_k`` (created, moderation-gate satisfied) and not yet voted by the vote's
participant. ``S_k`` is schedule-independent — only the weights change with
the candidate schedule — which is what makes one O(n) sweep per DP left node
possible.

Availability bookkeeping is incremental:

- ``total_w`` / ``n_avail`` track the weight-sum and count of available
  comments, updated at availability *toggles* (comment creation, moderation
  changes) that are precomputed once per dataset and anchored to the first
  vote index they precede.
- per-participant ``voted_w`` / ``voted_n`` track the weight-sum and count of
  comments the participant has voted **among currently available comments**;
  each toggle carries the list of participants who had already voted that
  comment so the per-participant sums stay consistent (no double-subtraction
  when a voted comment is moderated out).

Guard: the voted comment itself is always restored into its own choice set if
the availability model says it was unavailable (data inconsistency — logged
once per comment).
"""

import logging
from bisect import bisect_left
from collections import defaultdict
from typing import Mapping

import numpy as np

from polismath.replay.types import ReplayDataset

logger = logging.getLogger(__name__)

DEFAULT_WEIGHT = 1.0


class AvailabilityIndex:
    """Schedule-independent availability structure for one dataset."""

    def __init__(self, ds: ReplayDataset):
        self.ds = ds
        self.n = ds.n
        vote_times = [v.t_ms for v in ds.votes]

        # First (non-revote) vote index of each (pid, tid) pair, and the
        # ordered list of (first_vote_k, pid) per tid, for toggle adjustment.
        first_vote_of_tid: dict[int, list[tuple[int, int]]] = defaultdict(list)
        for v in ds.votes:
            if not v.is_revote:
                first_vote_of_tid[v.tid].append((v.k, v.pid))

        # Availability transitions per tid over time.
        mod_ok = (lambda m: m > 0) if ds.strict_moderation else (lambda m: m >= 0)
        events_by_tid: dict[int, list[tuple[int, int, str]]] = defaultdict(list)
        for cm in ds.comments.values():
            events_by_tid[cm.tid].append((cm.created_ms, 0, "create"))
        for order, me in enumerate(ds.mod_events, start=1):
            events_by_tid[me.tid].append((me.t_ms, order, f"mod:{me.mod}"))

        # toggles[k] = list of (tid, delta) applied before scoring vote k,
        # in chronological order; each with the pids who voted tid earlier.
        self.toggles: dict[int, list[tuple[int, int, list[int]]]] = defaultdict(list)
        raw_toggles: list[tuple[int, int, int, int]] = []  # (t, order, tid, delta)
        for tid, evs in events_by_tid.items():
            created = False
            mod_state = 0
            avail = False
            for t, order, kind in sorted(evs):
                if kind == "create":
                    created = True
                else:
                    mod_state = int(kind.split(":")[1])
                now = created and mod_ok(mod_state)
                if now != avail:
                    raw_toggles.append((t, order, tid, +1 if now else -1))
                    avail = now

        for t, order, tid, delta in sorted(raw_toggles):
            k = bisect_left(vote_times, t) + 1  # first vote with t_k >= t
            if k > self.n:
                continue  # after the last vote: never observed
            prior_voters = [pid for fk, pid in first_vote_of_tid[tid] if fk < k]
            self.toggles[k].append((tid, delta, prior_voters))

        self._warned_tids: set[int] = set()


def cumulative_loglik(
    idx: AvailabilityIndex,
    weights: Mapping[int, float],
    eps: float = 0.02,
    k_stop: int | None = None,
) -> np.ndarray:
    """``cum[k] = sum of mark log-lik of votes 1..k`` under ``weights``.

    ``cum`` has length ``n+1`` with ``cum[0] = 0``; the segment score of
    votes ``(i, j]`` is ``cum[j] - cum[i]`` (left-sentinel node -1 maps to
    index 0). When ``k_stop`` is given the sweep ends there and later
    entries are padded with ``cum[k_stop]`` — callers (the DP) must not read
    beyond ``k_stop``; the padding is defensive only. Sweeping only to the
    next forced cut is what keeps the DP linear per left node.
    """
    ds = idx.ds
    cum = np.zeros(idx.n + 1)
    total_w = 0.0
    n_avail = 0
    avail: set[int] = set()
    voted_w: defaultdict[int, float] = defaultdict(float)
    voted_n: defaultdict[int, int] = defaultdict(int)

    def w_of(tid: int) -> float:
        return weights.get(tid, DEFAULT_WEIGHT)

    stop = idx.n if k_stop is None else min(k_stop, idx.n)
    for k in range(1, stop + 1):
        for tid, delta, prior_voters in idx.toggles.get(k, ()):
            wt = w_of(tid)
            if delta > 0:
                avail.add(tid)
                total_w += wt
                n_avail += 1
                for pid in prior_voters:
                    voted_w[pid] += wt
                    voted_n[pid] += 1
            else:
                avail.discard(tid)
                total_w -= wt
                n_avail -= 1
                for pid in prior_voters:
                    voted_w[pid] -= wt
                    voted_n[pid] -= 1

        v = ds.votes[k - 1]
        term = 0.0
        if not v.is_revote:
            wt_c = w_of(v.tid)
            denom = total_w - voted_w[v.pid]
            n_eff = n_avail - voted_n[v.pid]
            if v.tid not in avail:
                if v.tid not in idx._warned_tids:
                    logger.warning(
                        "vote k=%d by pid=%d on unavailable tid=%d; "
                        "guard restores it into its own choice set",
                        k,
                        v.pid,
                        v.tid,
                    )
                    idx._warned_tids.add(v.tid)
                denom += wt_c
                n_eff += 1
            # numerical floors (float drift, degenerate data)
            denom = max(denom, wt_c)
            n_eff = max(n_eff, 1)
            term = float(np.log((1.0 - eps) * wt_c / denom + eps / n_eff))
            # participant has now voted this comment
            if v.tid in avail:
                voted_w[v.pid] += wt_c
                voted_n[v.pid] += 1
        cum[k] = cum[k - 1] + term
    if stop < idx.n:
        cum[stop + 1 :] = cum[stop]
    return cum


def segment_loglik(
    idx: AvailabilityIndex,
    weights: Mapping[int, float],
    i: int,
    j: int,
    eps: float = 0.02,
) -> float:
    """Mark log-likelihood of votes ``(i, j]`` under ``weights``.

    Convenience wrapper (one full sweep); DP code uses
    :func:`cumulative_loglik` arrays directly.
    """
    cum = cumulative_loglik(idx, weights, eps=eps)
    return float(cum[j] - cum[i])
