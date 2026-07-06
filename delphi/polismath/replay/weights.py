"""Prefix statistics and the era A / era B priority-weight formulas.

The serve-time weight of a comment is a deterministic function of the vote
prefix ingested at the last recompute (the "prefix-sufficiency" property that
makes the exact changepoint DP valid — see the R2 design document §6.2):

- **Era A** (production before 2025-03-20): the intended priority-metric of
  ``math/src/polismath/math/conversation.clj``::

      w = [ (1 - p_hat) * (E + 1) * a_hat * (1 + 8 * 2^(-S/5)) ]^2
      p_hat = (P + 1) / (S + 2),   a_hat = (A + 1) / (S + 2),   S = A + D + P

  with meta comments pinned to ``7^2 = 49``. ``E`` (comment extremity) comes
  from the PCA and is supplied by an engine adapter.

- **Era B** (after commit ``dff835d7e``, 2025-03-20): the truthy-0 regression
  sends *every* comment down the meta branch — every tid in the priorities
  domain gets exactly 49. Comments absent from the domain (no vote ingested
  yet at the last recompute) default to 1.0 at the caller, exactly like the
  server's ``priorities[tid] || 1`` (server/src/nextComment.ts:119).

Counts follow the rating matrix: latest-vote-wins per ``(pid, tid)``; a
revote replaces the participant's previous sign and does not inflate ``S``.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from polismath.replay.types import Vote, VoteEvent

DEFAULT_WEIGHT = 1.0
META_WEIGHT = 49.0


@dataclass
class PrefixStats:
    """Latest-vote-wins A/D/P counts per tid over an ingested vote prefix."""

    A: defaultdict[int, int] = field(default_factory=lambda: defaultdict(int))
    D: defaultdict[int, int] = field(default_factory=lambda: defaultdict(int))
    P: defaultdict[int, int] = field(default_factory=lambda: defaultdict(int))
    latest: dict[tuple[int, int], int] = field(default_factory=dict)
    dom: set[int] = field(default_factory=set)

    @classmethod
    def empty(cls) -> "PrefixStats":
        return cls()

    def _counter_for(self, sign: int) -> defaultdict[int, int]:
        if sign == Vote.AGREE:
            return self.A
        if sign == Vote.DISAGREE:
            return self.D
        if sign == Vote.PASS:
            return self.P
        raise ValueError(f"unknown vote sign {sign!r}")

    def push(self, v: VoteEvent) -> None:
        pair = (v.pid, v.tid)
        prev = self.latest.get(pair)
        if prev is not None:
            self._counter_for(prev)[v.tid] -= 1
        self._counter_for(v.sign)[v.tid] += 1
        self.latest[pair] = v.sign
        self.dom.add(v.tid)

    def S(self, tid: int) -> int:
        """Seen count: number of participants with a current vote on tid."""
        return self.A[tid] + self.D[tid] + self.P[tid]

    def snapshot(self) -> "PrefixStats":
        return PrefixStats(
            A=defaultdict(int, self.A),
            D=defaultdict(int, self.D),
            P=defaultdict(int, self.P),
            latest=dict(self.latest),
            dom=set(self.dom),
        )


def era_b_weights(stats: PrefixStats) -> dict[int, float]:
    """Post-2025-03-20 weights: every domain tid is exactly 49."""
    return {tid: META_WEIGHT for tid in stats.dom}


def era_a_weights(
    stats: PrefixStats,
    extremity: Mapping[int, float],
    meta_tids: set[int],
) -> dict[int, float]:
    """Pre-2025-03-20 priority-metric weights for every domain tid."""
    weights: dict[int, float] = {}
    for tid in stats.dom:
        if tid in meta_tids:
            weights[tid] = META_WEIGHT
            continue
        a, p = stats.A[tid], stats.P[tid]
        s = stats.S(tid)
        p_hat = (p + 1) / (s + 2)
        a_hat = (a + 1) / (s + 2)
        e = extremity.get(tid, 0.0)
        importance = (1.0 - p_hat) * (e + 1.0) * a_hat
        boost = 1.0 + 8.0 * 2.0 ** (-s / 5.0)
        weights[tid] = (importance * boost) ** 2
    return weights


def prefix_stats_at_slots(
    votes: Sequence[VoteEvent], slots: Sequence[int]
) -> dict[int, PrefixStats]:
    """One-pass snapshots of prefix statistics at each requested cut slot."""
    wanted = sorted(set(slots))
    out: dict[int, PrefixStats] = {}
    if not wanted:
        return out
    st = PrefixStats.empty()
    it = iter(wanted)
    next_slot = next(it)
    for v in votes:
        st.push(v)
        while next_slot is not None and v.k == next_slot:
            out[next_slot] = st.snapshot()
            next_slot = next(it, None)
        if next_slot is None:
            break
    return out
