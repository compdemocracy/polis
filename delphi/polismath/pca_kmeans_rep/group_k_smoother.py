"""
Group-K smoother: port of Clojure :group-k-smoother (conversation.clj:454-478).

Damps flicker in K (the number of opinion groups). Left un-smoothed, K would
jump every tick to whatever k currently maximizes the silhouette; the smoother
only lets K switch to a new best value after `:group-k-buffer` (= 4,
conversation.clj:154) consecutive ticks agree on it.

The state {last_k, last_k_count, smoothed_k} is threaded ON THE CONV across
conv-update ticks (conversation.clj:457) and is NOT persisted (Clojure's
math_main whitelist omits it, conv_man.clj:52-74). This module is a pure
function so it can be unit-tested in isolation and reused by
Conversation._compute_clusters.

NOTE: Python has no subgroups (conversation.py hardcodes subgroup_clusters =
{}), so ONLY the top-level group-k-smoother is ported here — the parallel
subgroup smoother (conversation.clj:520-560) is intentionally not.
"""

from typing import Any, Dict, Mapping, Optional, Tuple

# Clojure :group-k-buffer default (conversation.clj:154): switch K only after
# this many consecutive ticks agree on a new best-K.
GROUP_K_BUFFER = 4


def _argmax_silhouette_higher_k_wins(silhouettes_by_k: Mapping[int, float]) -> Optional[int]:
    """
    argmax_k silhouette[k], breaking ties toward the HIGHER k.

    Clojure computes this as
        (apply max-key group-clusterings-silhouettes (keys group-clusterings))
    (conversation.clj:461). Clojure's `max-key` returns the LAST argument among
    equal-valued maxima, and the group-clusterings map (built by
    `plmb/map-from-keys` over `(range 2 (inc max-k))`) iterates its keys in
    ASCENDING order for the small array-maps used here. So on a silhouette tie
    the HIGHER k is kept. We reproduce that by scanning k ascending and
    replacing the incumbent on `>=` (not strict `>`).

    Returns None only if `silhouettes_by_k` is empty (the caller guarantees at
    least k=2 is present, conversation.py group loop over range(2, max_k+1)
    with max_k >= 2).
    """
    best_k: Optional[int] = None
    best_score: Optional[float] = None
    for k in sorted(silhouettes_by_k):
        score = silhouettes_by_k[k]
        if best_score is None or score >= best_score:
            best_k = k
            best_score = score
    return best_k


def group_k_smoother_update(
    prev_state: Optional[Mapping[str, Any]],
    silhouettes_by_k: Mapping[int, float],
    buffer: int = GROUP_K_BUFFER,
) -> Tuple[Dict[str, Any], int]:
    """
    Advance the group-K smoother by one tick. Pure function.

    Port of Clojure :group-k-smoother (conversation.clj:454-478).

    State carried on the conv across ticks (conversation.clj:457):
      last_k        - the best-K from the previous tick (None on the first tick)
      last_k_count  - consecutive ticks this_k has equalled last_k
                      (Clojure `:or {last-k-count 0}`, conversation.clj:457)
      smoothed_k    - the K actually used last tick (None on the first tick)

    Update rule (conversation.clj:461-478):
      this_k       = argmax_k silhouette   (ties -> higher k; see helper)
      same         = last_k is not None and this_k == last_k
      this_k_count = last_k_count + 1 if same else 1
      smoothed_k   = this_k                          if this_k_count >= buffer
                     else (prev smoothed_k if not None else this_k)
      clamp (#2536, conversation.clj:469-478): if smoothed_k is not among the
             current clusterings' k-values, fall back to this_k.

    First tick (smoothed_k is None): accepts this_k immediately — the
    cold-start invariant that makes 'improved' and 'clojure-legacy' coincide on
    tick 1.

    Args:
        prev_state: previous {last_k, last_k_count, smoothed_k}; None/{} on the
            first tick.
        silhouettes_by_k: {k: silhouette} for THIS tick's clusterings. Its keys
            are the valid k-values used by the clamp.
        buffer: consecutive-agreement threshold before switching K
            (Clojure :group-k-buffer, default 4).

    Returns:
        (new_state, smoothed_k). `smoothed_k` is guaranteed to be a key of
        `silhouettes_by_k`, so `clusterings[smoothed_k]` never KeyErrors.
    """
    state = prev_state or {}
    last_k = state.get('last_k')                  # None if absent
    last_k_count = state.get('last_k_count', 0)   # Clojure :or {last-k-count 0}
    prev_smoothed_k = state.get('smoothed_k')     # None if absent

    this_k = _argmax_silhouette_higher_k_wins(silhouettes_by_k)

    same = last_k is not None and this_k == last_k
    this_k_count = last_k_count + 1 if same else 1

    if this_k_count >= buffer:
        smoothed_k = this_k
    else:
        smoothed_k = prev_smoothed_k if prev_smoothed_k is not None else this_k

    # Clamp (#2536, conversation.clj:469-478): a carried smoothed_k that no
    # longer exists this tick (e.g. the base-cluster count shrank so max-k
    # dropped) falls back to the current best available k.
    if smoothed_k not in silhouettes_by_k:
        smoothed_k = this_k

    new_state = {
        'last_k': this_k,
        'last_k_count': this_k_count,
        'smoothed_k': smoothed_k,
    }
    return new_state, smoothed_k
