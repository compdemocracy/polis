"""Decision-local near-tie predicates, independent of receipt or engine claims.

This module classifies paired *decision-time* quantities. It does not grant an
entry exception: a caller must bind evidence to an admitted execution and prove
its causal scope. Final clustering blobs alone cannot provide that proof.
"""
from dataclasses import dataclass
import math
from typing import Sequence

ABSOLUTE = 1e-6
RELATIVE = 1e-4


@dataclass(frozen=True)
class Decision:
    """Ordered candidate scores, or one score and a threshold for a predicate."""
    kind: str
    candidates: tuple[str, ...]
    scores: tuple[float, ...]
    selected: str | bool
    threshold: float | None = None


def close(a: float, b: float) -> bool:
    return (math.isfinite(a) and math.isfinite(b)
            and abs(a - b) <= ABSOLUTE + RELATIVE * max(abs(a), abs(b)))


def _finite(x):
    return type(x) in (int, float) and math.isfinite(x)


def _valid(d: Decision) -> bool:
    if not isinstance(d, Decision) or type(d.kind) is not str:
        return False
    if type(d.candidates) is not tuple or type(d.scores) is not tuple:
        return False
    if not d.scores or any(not _finite(x) for x in d.scores):
        return False
    if d.kind in {'min-last', 'max-last', 'max-first'}:
        if (d.threshold is not None or len(d.candidates) != len(d.scores)
                or any(type(x) is not str for x in d.candidates)
                or len(set(d.candidates)) != len(d.candidates)):
            return False
        optimum = min(d.scores) if d.kind == 'min-last' else max(d.scores)
        winners = [i for i, x in enumerate(d.scores) if x == optimum]
        winner = winners[0] if d.kind == 'max-first' else winners[-1]
        return type(d.selected) is str and d.selected == d.candidates[winner]
    if d.kind in {'lt', 'gt'}:
        if (d.candidates or len(d.scores) != 1 or not _finite(d.threshold)
                or type(d.selected) is not bool):
            return False
        return d.selected == (d.scores[0] < d.threshold if d.kind == 'lt'
                              else d.scores[0] > d.threshold)
    return False


def is_near_tie(left: Decision, right: Decision) -> bool:
    """Both legitimate choices differ solely across a G12-small boundary.

    Every paired score must be G12-close. Both winning margins (or distances
    to the identical threshold) must separately be G12-small. An invalid
    winner, unknown comparator, changed candidate inventory/order, nonfinite
    quantity or an unchanged decision cannot authorize a tie.
    """
    if (not _valid(left) or not _valid(right) or left.kind != right.kind
            or left.candidates != right.candidates or left.threshold != right.threshold
            or left.selected == right.selected or len(left.scores) != len(right.scores)
            or not all(close(a, b) for a, b in zip(left.scores, right.scores))):
        return False
    if left.kind in {'lt', 'gt'}:
        return close(left.scores[0], left.threshold) and close(right.scores[0], right.threshold)
    i, j = left.candidates.index(left.selected), left.candidates.index(right.selected)
    return close(left.scores[i], left.scores[j]) and close(right.scores[i], right.scores[j])


# The graph starts at a discrete clustering decision, so PCA is never covered.
BASE_PATHS = frozenset({'base-clusters','group-clusters','votes-base','group-votes',
                        'repness','group-aware-consensus','comment-priorities'})
GROUP_PATHS = BASE_PATHS - {'base-clusters','votes-base'}
# The field each scope's decisions directly produce. A tie must change it.
ROOTS = {'base':'base-clusters','group':'group-clusters'}


def active(checkpoint, tie):
    return (type(tie) is dict and type(tie.get('checkpoint')) is int
            and 0 <= tie['checkpoint'] <= checkpoint and tie.get('scope') in ('base','group'))


def reconcile(left, right, tie):
    from copy import deepcopy
    result = deepcopy(right)
    paths = BASE_PATHS if tie['scope']=='base' else GROUP_PATHS
    # Verifier-only effect probe: leave named paths compared.
    paths = paths - frozenset(tie.get('hold', ()))
    for key in paths & left.keys() & right.keys():
        result[key]=deepcopy(left[key])
    return left,result
