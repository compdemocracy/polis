"""
Faithful port of the Clojure ``polismath.math.clusters`` k-means WITH lineage.

This is the warm-start k-means Clojure actually threads across conv-update ticks
(``:last-clusters (:base-clusters conv)`` -> ``kmeans`` -> ``clean-start-clusters``,
math/src/polismath/math/conversation.clj:403-410 and clusters.clj:301-312). Its
defining property is CLUSTER-IDENTITY LINEAGE: cluster ids are stable across
ticks, new ids strictly increase, merges keep the larger side's id, and vanished
members are dropped. Base-cluster ids feed group-level clustering and the
serialized blob, so lineage propagates downstream in sequential runs.

This is a DIFFERENT algorithm from the off-production ``clusters.py`` warm start
(split-largest / merge-closest, clusters.py:302-364), which is NOT a port of the
Clojure ``clean-start-clusters``. That module is intentionally left untouched;
this one is the faithful port wired into the engine (the only clustering path
since the mode collapse).

Data model (mirrors Clojure's named-matrix + cluster maps):

  - A clustering is a ``list`` of ``dict`` clusters ``{'id': int,
    'members': list, 'center': np.ndarray (1-D float)}``. ``members`` are ROW
    NAMES (participant ids at base level; base-cluster ids at group level),
    exactly as Clojure's ``:members`` hold row names of the named matrix.
  - Input data is a ``_NamedData(row_names, matrix)`` pair: ``matrix[i]`` is the
    row vector for ``row_names[i]``. This reproduces named-matrix lookups
    (``get-row-by-name``, ``rowname-subset``) that key clusters to the current
    data by NAME — the mechanism that lets a prior tick's members be matched
    against (or dropped from) the current tick's rows.
  - ``weights`` is either ``None`` (base level) or a ``dict`` mapping row name ->
    weight (group level, ``:weights base-clusters-weights``,
    conversation.clj:444; the weight of a base cluster is its member count).

Every public function cites the Clojure source it ports. Clojure is
authoritative; where a Clojure quirk is load-bearing it is reproduced and
flagged in the docstring.
"""

from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

import numpy as np

# Reuse the EXACT first-k-distinct helper the production cold path uses
# (clusters.py:551) so that a COLD legacy clustering initialises from the same
# seed rows as ``kmeans_sklearn``'s ``use_first_k_init`` branch. Sharing this is
# what keeps the base-level cold-start invariant tight (see module tests).
from polismath.pca_kmeans_rep.clusters import _get_first_k_distinct_centers
from polismath.utils.clj_hash import clojure_hash_map_key_order

# Clojure ``same-clustering?`` default tolerance (clusters.clj:71).
SAME_CLUSTERING_THRESHOLD = 0.01
# Clojure ``kmeans`` default ``max-iters`` (clusters.clj:303).
DEFAULT_MAX_ITERS = 20


class _NamedData:
    """A named matrix: row names aligned 1:1 with rows of a float matrix.

    Reproduces the subset of ``polismath.math.named-matrix`` used by k-means:
    ``rownames`` (order-preserving), ``get-row-by-name`` (named_matrix.clj:268),
    and membership (used to emulate ``safe-rowname-subset``'s drop-missing
    behaviour, named_matrix.clj:258-265).
    """

    def __init__(self, row_names: Sequence[Any], matrix: np.ndarray):
        self.row_names: List[Any] = list(row_names)
        self.matrix: np.ndarray = np.asarray(matrix, dtype=float)
        if self.matrix.ndim != 2 or self.matrix.shape[0] != len(self.row_names):
            raise ValueError(
                "matrix must be 2-D with one row per name "
                f"(got shape {self.matrix.shape} for {len(self.row_names)} names)")
        # Last-write-wins on duplicate names would corrupt lookups; Clojure's
        # index-hash also de-dups names, but our callers pass unique names.
        self._index_by_name: Dict[Any, int] = {
            name: i for i, name in enumerate(self.row_names)}

    def get_row(self, name: Any) -> np.ndarray:
        """Row vector for ``name`` (Clojure ``get-row-by-name``)."""
        return self.matrix[self._index_by_name[name]]

    def __contains__(self, name: Any) -> bool:
        return name in self._index_by_name

    def n_distinct_rows(self, bound: Optional[int] = None) -> int:
        """Count of distinct rows (Clojure ``(count (distinct (matrix/rows ...)))``
        used for ``possible-clusters``, clusters.clj:249). NaN-safe to match the
        production first-k-distinct helper.

        Distinctness is first-encounter ``array_equal(..., equal_nan=True)``
        semantics, computed as vectorized elimination passes: each pass takes
        the first still-unmatched row and removes every row equal to it
        (elementwise ``==`` with NaN==NaN; note ``-0.0 == 0.0``, both matching
        ``array_equal``). Row equality is an equivalence relation, so the
        class count is identical to the old one-row-at-a-time scan.

        ``bound`` caps the count: with ``bound=b`` the scan stops once ``b``
        distinct rows are found, so ``min(b, n_distinct_rows(bound=b)) ==
        min(b, n_distinct_rows())`` — exactly what ``clean_start_clusters``
        needs (``min(k, ...)``) without an O(n²) full count at 33k+ rows.
        """
        m = self.matrix
        alive = np.ones(m.shape[0], dtype=bool)
        count = 0
        while (bound is None or count < bound) and alive.any():
            first = int(np.argmax(alive))
            row = m[first]
            same = ((m == row) | (np.isnan(m) & np.isnan(row))).all(axis=1)
            alive &= ~same
            count += 1
        return count


def _euclidean(a: np.ndarray, b: np.ndarray) -> float:
    """``matrix/distance`` as vectorz ACTUALLY computes it on the kmeans path
    (CLOJURE_QUIRKS.md Q11): d² = |a|² + |b|² − 2·a·b, clamped at 0.

    NOT ``norm(a − b)``: the dot-product form suffers catastrophic
    cancellation, flooring any true distance below ~1e-8 (relative to the
    vectors' magnitude) to EXACTLY 0.0. That floor is semantic in Clojure —
    near-coincident points TIE at 0.0 against multiple clusters and min-key's
    last-wins tie-break merges them into the LATER cluster (verified on the
    vw every-vote step-57 pair: true distance 4.66e-15 → both cluster
    distances 0.0 → merge; math/dev/proj_probe.clj + journal 2026-07-22).
    This module only runs in clojure-legacy mode, so the quirk is gated by
    construction."""
    av = np.asarray(a, dtype=float)
    bv = np.asarray(b, dtype=float)
    d2 = float(np.dot(av, av)) + float(np.dot(bv, bv)) - 2.0 * float(np.dot(av, bv))
    # NaN must propagate, not silently become 0: python's max(0.0, nan) returns
    # 0.0 (nan compares false against 0.0, so max just returns its first arg),
    # but real vectorz does no such clamp and would NaN instead.
    if d2 < 0.0:
        d2 = 0.0
    return float(np.sqrt(d2))


def _row_norms(matrix: np.ndarray) -> np.ndarray:
    """Per-row squared norms, BIT-EQUAL to ``float(np.dot(row, row))``.

    Computed as a batched matmul ``(n,1,d) @ (n,d,1)``, which numpy evaluates
    as one BLAS-style dot per row — empirically verified bit-identical to the
    scalar ``np.dot`` on this machine across n=1..33422, d=1..783, scales
    1e-8..1e8 (blas probe, journal item 9a). NOT ``einsum``/``(m*m).sum(1)``/
    plain ``m @ c`` (dgemv): those reassociate the accumulation for d>=4 (and
    einsum even for d=2) and differ in the last ulp — which Q11's cancellation
    then amplifies into a changed 0.0-tie, i.e. changed cluster lineage.
    """
    m = np.asarray(matrix, dtype=float)
    return np.matmul(m[:, None, :], m[:, :, None]).reshape(-1)


def _euclidean_col(matrix: np.ndarray, center: np.ndarray,
                   row_norms: np.ndarray) -> np.ndarray:
    """``_euclidean(row, center)`` for every row at once — bit-identical.

    Reproduces the scalar path exactly, element by element:

      - cross products via the same batched-matmul-per-row kernel as
        ``_row_norms`` (bit-equal to ``float(np.dot(row, center))``);
      - the 3-term combine in the scalar's exact order/associativity:
        ``(|row|² + |center|²) − 2·cross`` — left-to-right, matching
        ``float(np.dot(av,av)) + float(np.dot(bv,bv)) - 2.0*float(...)``;
      - the negative-residue floor as an elementwise post-combine select
        (``np.where(d2 < 0.0, 0.0, d2)``), so NaN propagates (NaN < 0 is
        False) exactly like the scalar ``if d2 < 0.0`` branch — never a
        ``maximum``-style clamp;
      - the same IEEE ``sqrt``.

    The Q11 cancellation quirk (true distances ~1e-8 flooring to EXACTLY 0.0
    and deciding tie-merges) is therefore preserved bit-for-bit; the vw
    knife-edge pair is pinned in tests/test_legacy_kmeans.py.
    """
    cv = np.asarray(center, dtype=float)
    cross = np.matmul(matrix[:, None, :], cv[:, None]).reshape(-1)
    d2 = (row_norms + float(np.dot(cv, cv))) - 2.0 * cross
    d2 = np.where(d2 < 0.0, 0.0, d2)
    return np.sqrt(d2)


def weighted_mean(rows: Union[np.ndarray, Sequence[Any]],
                  weights: Optional[Sequence[float]] = None) -> np.ndarray:
    """Mean (or weighted mean) of row vectors — Clojure ``weighted-mean``
    (clusters.clj:89-126, matrix branch). ``rows`` is anything
    ``np.asarray`` turns into an (n, d) matrix: an ndarray slice (the
    vectorized callers) or a sequence of row vectors.

    Clojure computes ``(count w)/(sum w) * sum_i(w_i * row_i)`` then takes the
    plain per-row mean, which algebraically equals ``sum_i(w_i row_i)/sum_i(w_i)``
    = ``np.average(rows, weights=w, axis=0)``. Unweighted -> arithmetic mean.
    """
    arr = np.asarray(rows, dtype=float)
    if weights is None:
        return np.mean(arr, axis=0)
    return np.average(arr, axis=0, weights=np.asarray(weights, dtype=float))


def _cluster_weights(members: Sequence[Any],
                     hm_weights: Optional[Mapping[Any, float]]) -> Optional[List[float]]:
    """Per-member weight seq for a cluster — Clojure ``cluster-weights``
    (clusters.clj:133-139). ``None`` when ``hm_weights`` is falsey."""
    if not hm_weights:
        return None
    return [hm_weights[m] for m in members]


def init_clusters(data: _NamedData, k: int) -> List[Dict[str, Any]]:
    """First ``k`` distinct rows in encounter order, ids ``0..k-1``, empty members.

    Port of Clojure ``init-clusters`` (clusters.clj:55-65). Reuses
    ``_get_first_k_distinct_centers`` (clusters.py:551) so the seed rows are
    byte-identical to the production cold path's init. May return fewer than
    ``k`` clusters when the data has fewer than ``k`` distinct rows (``take k``
    semantics).
    """
    centers = _get_first_k_distinct_centers(data.matrix, k)
    return [
        {'id': i, 'members': [], 'center': np.asarray(center, dtype=float)}
        for i, center in enumerate(centers)
    ]


def same_clustering(clusters1: List[Dict[str, Any]],
                    clusters2: List[Dict[str, Any]],
                    threshold: float = SAME_CLUSTERING_THRESHOLD) -> bool:
    """Whether two clusterings' SORTED centers are pairwise within ``threshold``.

    Port of Clojure ``same-clustering?`` (clusters.clj:68-76). Two Clojure
    quirks are reproduced deliberately:

      - Centers are SORTED (order-independent comparison). Clojure sorts vectors
        with ``compare`` = lexicographic; we sort by the center tuple.
      - Clojure zips the two sorted center seqs with ``utils/zip``, which is
        ``interleave``-based and TRUNCATES to the shorter seq (utils.clj:78-83).
        So it does NOT require equal lengths — if one clustering has fewer
        clusters, only the common prefix of sorted centers is compared. We
        replicate that (``zip`` truncation), rather than the stricter
        ``len != len -> False`` used elsewhere (clusters.py:133).
    """
    c1 = sorted((np.asarray(c['center'], dtype=float) for c in clusters1),
                key=lambda v: tuple(v.tolist()))
    c2 = sorted((np.asarray(c['center'], dtype=float) for c in clusters2),
                key=lambda v: tuple(v.tolist()))
    return all(_euclidean(x, y) < threshold for x, y in zip(c1, c2))


def cluster_step(data: _NamedData,
                 clusters: List[Dict[str, Any]],
                 weights: Optional[Mapping[Any, float]] = None) -> List[Dict[str, Any]]:
    """One Lloyd step: reassign every row to its nearest center, drop empty
    clusters, recenter.

    Port of Clojure ``cluster-step`` (clusters.clj:142-158):

      1. Clear members (keep id + center) — ``cleared-clusters``.
      2. ``reduce add-to-closest`` over the rows in row order: each row joins the
         nearest cluster by ``matrix/distance`` to its center. Ties resolve to
         the LATER cluster in the current cluster order (Clojure ``min-key``
         returns the last of equal-keyed args, clusters.clj:44-52). Exact ties
         are measure-zero on real float projections; the rule is fixed for
         reproducibility and to match Clojure's array-map order for k<=8.
      3. Drop clusters that received no members (``filter > 0``). k can shrink.
      4. Recenter each surviving cluster on the rows it captured, weighted by
         ``cluster-weights`` (clusters.clj:154-158).

    Cluster ORDER of the result follows the input cluster order (non-empty
    only). Clojure's ``(into {} ...)`` is an array-map for <=8 clusters
    (insertion/id order) but a hash-map for >8 (hash order); the only observable
    effect of order is the assignment tie-break above, so this deterministic
    order matches Clojure except on measure-zero exact ties in large clusterings.
    """
    n = len(clusters)
    if n == 0:
        return []
    centers = [np.asarray(c['center'], dtype=float) for c in clusters]

    # Assignment SCAN order: Clojure's add-to-closest iterates the
    # cleared-clusters map — ``(into {})`` of [id cluster] pairs is an
    # array-map in insertion (input) order for <=8 clusters but a
    # PersistentHashMap for >8, whose seq order is the HAMT trie order of
    # the id hashes (clusters.clj:79-86, 149). min-key keeps the LAST
    # minimal entry in that order, so the scan order is semantic exactly on
    # distance ties — and Q11's cancellation floor makes exact 0.0 ties
    # COMMON, not measure-zero (pc-modheavy-01 step 2: 12 seed clusters
    # emptied clj-side purely by hash-order ties, recorded 80 vs 92;
    # journal 2026-07-24). clojure_hash_map_key_order reproduces the real
    # Clojure order (cross-validated against clojure -M for n=9/20).
    if n > 8:
        hash_pos = {cid: i for i, cid in enumerate(
            clojure_hash_map_key_order([c['id'] for c in clusters]))}
        scan = sorted(range(n), key=lambda j: hash_pos[clusters[j]['id']])
    else:
        scan = list(range(n))

    # Vectorized scan (item 9a): one bit-identical distance COLUMN per
    # center, folded in scan order with the scalar loop's exact update rule
    # ``d <= best`` — so ties go to the LATER cluster in scan order (Clojure
    # min-key semantics over the map's iteration order), and a NaN distance
    # never wins (NaN <= x is False), matching the scalar branch outcome
    # row by row.
    matrix = data.matrix
    row_norms = _row_norms(matrix)
    best_dist = _euclidean_col(matrix, centers[scan[0]], row_norms)
    best_idx = np.full(matrix.shape[0], scan[0], dtype=np.intp)
    for j in scan[1:]:
        d = _euclidean_col(matrix, centers[j], row_norms)
        upd = d <= best_dist
        best_dist = np.where(upd, d, best_dist)
        best_idx = np.where(upd, j, best_idx)

    out: List[Dict[str, Any]] = []
    for j in range(n):
        rows_j = np.flatnonzero(best_idx == j)
        if rows_j.size == 0:
            continue  # drop empty cluster
        # Ascending row indices == the row-order append of the scalar loop.
        members_j = [data.row_names[i] for i in rows_j]
        w = _cluster_weights(members_j, weights)
        out.append({
            'id': clusters[j]['id'],
            'members': members_j,
            'center': weighted_mean(matrix[rows_j], w),
        })
    return out


def _recenter_center(data: _NamedData,
                     members: Sequence[Any],
                     weights: Optional[Mapping[Any, float]]) -> Optional[np.ndarray]:
    """Center from members that still exist in ``data`` (weighted). Returns
    ``None`` if no member survives — the caller decides drop-vs-keep.

    Shared core of Clojure ``recenter-clusters`` / ``safe-recenter-clusters``
    (clusters.clj:161-191): both subset members to those present in the current
    data (``rowname-subset`` / ``safe-rowname-subset`` drop missing names,
    named_matrix.clj:135-141, 258-265) and take the weighted mean.
    """
    surviving = [m for m in members if m in data]
    if not surviving:
        return None
    # Gather by index in one fancy-indexing slice: identical values to the
    # old per-name ``get_row`` list, so the mean is bit-identical.
    idx = [data._index_by_name[m] for m in surviving]
    w = _cluster_weights(surviving, weights)
    return weighted_mean(data.matrix[idx], w)


def safe_recenter_clusters(data: _NamedData,
                           clusters: List[Dict[str, Any]],
                           weights: Optional[Mapping[Any, float]] = None) -> List[Dict[str, Any]]:
    """Recenter each cluster on its surviving members; DROP clusters whose
    members all vanished; if EVERY cluster vanishes, fall back to one big
    cluster.

    Port of Clojure ``safe-recenter-clusters`` (clusters.clj:171-191).

      - Only ``:center`` is updated; ``:members`` keep their full prior list
        (vanished names included). They are re-subset on every later recenter
        and flushed by the first ``cluster-step`` in the k-means loop, so the
        FINAL clustering never carries a vanished member (Clojure identical).
      - Fallback id is ``(inc (apply max -1 (map :id clusters)))`` over the
        ORIGINAL clusters (clusters.clj:188) — ``-1`` floor makes it 0 when
        empty.
    """
    out: List[Dict[str, Any]] = []
    for clst in clusters:
        center = _recenter_center(data, clst['members'], weights)
        if center is None:
            continue  # all members vanished -> drop (nil, removed)
        out.append({'id': clst['id'], 'members': list(clst['members']), 'center': center})

    if not out:
        # Everything vanished: one cluster of all current rows (clusters.clj:187-190).
        max_id = max((c['id'] for c in clusters), default=-1)
        return [{
            'id': max_id + 1,
            'members': list(data.row_names),
            'center': _recenter_center(data, data.row_names, weights),
        }]
    return out


def recenter_clusters(data: _NamedData,
                      clusters: List[Dict[str, Any]],
                      weights: Optional[Mapping[Any, float]] = None) -> List[Dict[str, Any]]:
    """Recenter each cluster on its surviving members (no dropping).

    Port of Clojure ``recenter-clusters`` (clusters.clj:161-168). If a cluster's
    members have all vanished mid-loop (only reachable in a degenerate split
    edge), its center is kept unchanged rather than becoming NaN — a defensive,
    idempotent belt on a measure-zero path that Clojure never exercises on real
    data (most-distal never extracts a singleton's only point; :dist would be 0).
    """
    out: List[Dict[str, Any]] = []
    for clst in clusters:
        center = _recenter_center(data, clst['members'], weights)
        if center is None:
            out.append({'id': clst['id'], 'members': list(clst['members']),
                        'center': np.asarray(clst['center'], dtype=float)})
        else:
            out.append({'id': clst['id'], 'members': list(clst['members']), 'center': center})
    return out


def merge_clusters(clst1: Dict[str, Any], clst2: Dict[str, Any]) -> Dict[str, Any]:
    """Merge two clusters, keeping the LARGER cluster's id.

    Port of Clojure ``merge-clusters`` (clusters.clj:194-199):

      - ``new-id`` = id of ``(max-key #(count (:members %)) clst1 clst2)``. On a
        member-count TIE, Clojure ``max-key`` returns the LAST arg, i.e.
        ``clst2`` — reproduced here.
      - members concatenated (``clst1`` then ``clst2``).
      - center = size-weighted mean of the two centers (weights = member counts).
    """
    n1, n2 = len(clst1['members']), len(clst2['members'])
    new_id = clst1['id'] if n1 > n2 else clst2['id']  # tie -> clst2 (max-key last)
    return {
        'id': new_id,
        'members': list(clst1['members']) + list(clst2['members']),
        'center': weighted_mean(
            [np.asarray(clst1['center'], dtype=float),
             np.asarray(clst2['center'], dtype=float)],
            weights=[n1, n2]),
    }


def uniqify_clusters(clusters: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Merge clusters that have IDENTICAL centers.

    Port of Clojure ``uniqify-clusters`` (clusters.clj:220-227): fold left; for
    each cluster, if an already-accumulated cluster has an exactly-equal center,
    ``merge-clusters`` the two in place (at the incumbent's position); else
    append. Center equality is exact (``=`` on vectors) — reproduced with
    ``np.array_equal``.
    """
    acc: List[Dict[str, Any]] = []
    for clst in clusters:
        match_idx = None
        for i, existing in enumerate(acc):
            if np.array_equal(np.asarray(existing['center'], dtype=float),
                              np.asarray(clst['center'], dtype=float)):
                match_idx = i
                break
        if match_idx is not None:
            acc[match_idx] = merge_clusters(acc[match_idx], clst)
        else:
            acc.append(clst)
    return acc


def most_distal(data: _NamedData, clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The data point whose distance to its NEAREST center is greatest.

    Port of Clojure ``most-distal`` (clusters.clj:202-217). For each row: find
    ``(min over clusters of (distance, cluster-id))`` — its nearest center. Then
    across rows take the ``max`` by that distance. Tie behaviour mirrors Clojure:

      - inner ``min-key`` on distance -> nearest cluster ties resolve to the
        LATER cluster in ``clusters`` order;
      - outer ``max-key`` on distance -> farthest row ties resolve to the LATER
        row in ``data`` row order.

    Returns ``{'dist', 'clst_id', 'id'}`` where ``id`` is the row name.

    Vectorized (item 9a) with the scalar loops' exact semantics:

      - inner fold over clusters uses bit-identical distance columns and the
        update rule ``d <= near`` (NaN never wins, ties -> later cluster);
      - the outer scalar loop ("row i wins iff ``near_dist[i] >= best``",
        row 0 initializes) reduces to: if ``near_dist[0]`` is NaN, row 0
        wins forever (nothing satisfies ``x >= NaN``); otherwise NaN rows
        can never win (``NaN >= best`` is False) and among the non-NaN rows
        a running last-wins max is exactly the LAST argmax.
    """
    matrix = data.matrix
    n_rows = matrix.shape[0]
    if n_rows == 0:
        return {'dist': None, 'clst_id': None, 'id': None}

    row_norms = _row_norms(matrix)
    near_dist = _euclidean_col(
        matrix, np.asarray(clusters[0]['center'], dtype=float), row_norms)
    near_j = np.zeros(n_rows, dtype=np.intp)
    for j in range(1, len(clusters)):
        d = _euclidean_col(
            matrix, np.asarray(clusters[j]['center'], dtype=float), row_norms)
        upd = d <= near_dist
        near_dist = np.where(upd, d, near_dist)
        near_j = np.where(upd, j, near_j)

    if np.isnan(near_dist[0]):
        win = 0
    else:
        valid = np.flatnonzero(~np.isnan(near_dist))
        vmax = near_dist[valid].max()
        win = int(valid[np.flatnonzero(near_dist[valid] == vmax)[-1]])
    return {'dist': float(near_dist[win]),
            'clst_id': clusters[int(near_j[win])]['id'],
            'id': data.row_names[win]}


def clean_start_clusters(data: _NamedData,
                         clusters: List[Dict[str, Any]],
                         k: int,
                         weights: Optional[Mapping[Any, float]] = None) -> List[Dict[str, Any]]:
    """Prepare a prior clustering as the seed for a new k-means round.

    Port of Clojure ``clean-start-clusters`` (clusters.clj:230-277). Three
    phases when prior clusters exist:

      1. ``safe-recenter-clusters`` — recenter on surviving members, drop dead
         clusters, big-cluster fallback if all die.
      2. ``uniqify-clusters`` — merge identical-center clusters.
      3. Split loop — while ``min(k, #distinct-rows) > #clusters``: recenter,
         find the most-distal row; if its distance > 0, pull it out into a NEW
         singleton cluster with id ``(inc (max ids))`` and repeat; else stop.

    With no prior clusters, defers to ``init-clusters`` (the warm path is never
    used to build from scratch, clusters.clj:274-277).
    """
    if not clusters:
        return init_clusters(data, k)

    clusters = safe_recenter_clusters(data, clusters, weights)
    clusters = uniqify_clusters(clusters)
    # ``bound=k`` stops the distinct-row scan at k classes: min(k, .) makes
    # any count beyond k unobservable, so this is exact (and not O(n²)).
    possible = min(k, data.n_distinct_rows(bound=k))

    while True:
        clusters = recenter_clusters(data, clusters, weights)
        if possible <= len(clusters):
            return clusters
        outlier = most_distal(data, clusters)
        if outlier['dist'] is None or outlier['dist'] <= 0:
            return clusters
        outlier_id = outlier['id']
        # Remove the outlier from whichever cluster(s) hold it.
        clusters = [
            {'id': c['id'],
             'members': [m for m in c['members'] if m != outlier_id],
             'center': c['center']}
            for c in clusters
        ]
        new_id = max(c['id'] for c in clusters) + 1  # (inc (max ids))
        clusters = clusters + [{
            'id': new_id,
            'members': [outlier_id],
            'center': np.asarray(data.get_row(outlier_id), dtype=float),
        }]


def kmeans(data: _NamedData,
           k: int,
           last_clusters: Optional[List[Dict[str, Any]]] = None,
           weights: Optional[Mapping[Any, float]] = None,
           max_iters: int = DEFAULT_MAX_ITERS) -> List[Dict[str, Any]]:
    """K-means with lineage — Clojure ``kmeans`` (clusters.clj:301-312).

    Seed = ``clean-start-clusters`` when ``last_clusters`` is given (warm start
    with id lineage), else ``init-clusters`` (cold, first-k-distinct). Then
    iterate ``cluster-step`` until ``same-clustering?`` or ``max_iters`` is
    exhausted. Clojure ALWAYS runs at least one ``cluster-step`` (the ``(= iter
    0)`` check happens AFTER computing ``new-clusters``), so ``max_iters=0``
    still performs a single reassignment.

    Args:
        data: ``_NamedData`` — rows keyed by name (pids at base level,
            base-cluster ids at group level).
        k: target cluster count (``base-k``=100 at base level; 2..max-k at group
            level).
        last_clusters: the previous tick's clustering (id-carrying dicts) or
            ``None`` for a cold start.
        weights: ``None`` (base) or ``{name: weight}`` (group,
            ``base-clusters-weights``).
        max_iters: iteration cap. Clojure passes ``:base-iters``=100 at base
            level; at group level it passes the MISNAMED ``:cluster-iters`` key
            which ``kmeans`` ignores, so the group level actually runs the
            default (see ``DEFAULT_MAX_ITERS`` = 20). Callers must pass the value
            the Clojure code EFFECTIVELY uses.

    Returns:
        List of cluster dicts ``{'id', 'members', 'center'}``. NOT sorted — the
        caller applies ``sort-by :id`` (conversation.clj:406, 437).
    """
    if data.matrix.shape[0] == 0:
        return []
    clusters = (clean_start_clusters(data, last_clusters, k, weights)
                if last_clusters else init_clusters(data, k))
    iters = max_iters
    while True:
        new_clusters = cluster_step(data, clusters, weights)
        if iters == 0 or same_clustering(clusters, new_clusters):
            return new_clusters
        clusters = new_clusters
        iters -= 1
