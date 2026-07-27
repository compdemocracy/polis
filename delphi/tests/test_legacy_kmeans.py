#!/usr/bin/env python3
"""
Unit tests for the faithful Clojure k-means port (PR-C, legacy_kmeans.py).

Every expected value is hand-derived from the Clojure rules in
math/src/polismath/math/clusters.clj (cited per test), on tiny synthetic
matrices — NOT recomputed from the code under test. Covers the lineage
semantics that make this a DIFFERENT algorithm from clusters.py's warm start:
first-k-distinct cold init, drop-vanished, (inc max-id) new ids,
merge-keeps-larger-id, identical-center merge, most-distal split, weighted
group-level recentering, and stable ids across a warm-start chain.
"""

import os
import sys

import numpy as np
import pytest

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.pca_kmeans_rep.legacy_kmeans import (
    _NamedData,
    weighted_mean,
    init_clusters,
    same_clustering,
    cluster_step,
    safe_recenter_clusters,
    recenter_clusters,
    merge_clusters,
    uniqify_clusters,
    most_distal,
    clean_start_clusters,
    kmeans,
)


def _nd(names, rows):
    return _NamedData(names, np.array(rows, dtype=float))


def _by_id(clusters):
    return {c['id']: c for c in clusters}


# ---------------------------------------------------------------------------
# weighted_mean (clusters.clj:89-126)
# ---------------------------------------------------------------------------

class TestWeightedMean:
    def test_unweighted_is_arithmetic_mean(self):
        m = weighted_mean([[0.0, 0.0], [2.0, 4.0]])
        np.testing.assert_allclose(m, [1.0, 2.0])

    def test_weighted_is_sum_w_row_over_sum_w(self):
        # (1*[0,0] + 3*[3,0]) / 4 = [9/4, 0]
        m = weighted_mean([[0.0, 0.0], [3.0, 0.0]], weights=[1, 3])
        np.testing.assert_allclose(m, [2.25, 0.0])


# ---------------------------------------------------------------------------
# init_clusters (clusters.clj:55-65)
# ---------------------------------------------------------------------------

class TestInitClusters:
    def test_first_k_distinct_encounter_order(self):
        data = _nd(['a', 'b', 'c', 'd'], [[0, 0], [1, 1], [0, 0], [2, 2]])
        clusters = init_clusters(data, 3)
        # Distinct rows in encounter order: [0,0], [1,1], [2,2] -> ids 0,1,2.
        assert [c['id'] for c in clusters] == [0, 1, 2]
        np.testing.assert_allclose(clusters[0]['center'], [0, 0])
        np.testing.assert_allclose(clusters[1]['center'], [1, 1])
        np.testing.assert_allclose(clusters[2]['center'], [2, 2])
        assert all(c['members'] == [] for c in clusters)

    def test_fewer_distinct_than_k(self):
        data = _nd(['a', 'b', 'c'], [[0, 0], [0, 0], [1, 1]])
        clusters = init_clusters(data, 5)
        assert [c['id'] for c in clusters] == [0, 1]  # only 2 distinct rows


# ---------------------------------------------------------------------------
# same_clustering (clusters.clj:68-76) — sorted centers, zip-truncation
# ---------------------------------------------------------------------------

class TestSameClustering:
    def test_true_when_centers_match_within_threshold(self):
        a = [{'id': 0, 'members': [], 'center': np.array([0.0, 0.0])},
             {'id': 1, 'members': [], 'center': np.array([5.0, 5.0])}]
        b = [{'id': 9, 'members': [], 'center': np.array([5.001, 5.0])},
             {'id': 8, 'members': [], 'center': np.array([0.0, 0.0])}]
        assert same_clustering(a, b) is True  # sorted centers, <0.01 apart

    def test_false_when_a_center_moved(self):
        a = [{'id': 0, 'members': [], 'center': np.array([0.0, 0.0])}]
        b = [{'id': 0, 'members': [], 'center': np.array([0.5, 0.0])}]
        assert same_clustering(a, b) is False

    def test_zip_truncates_to_shorter(self):
        # Clojure utils/zip is interleave-based -> truncates; only the common
        # prefix of SORTED centers is compared (clusters.clj:72-76, utils.clj:78).
        a = [{'id': 0, 'members': [], 'center': np.array([0.0, 0.0])}]
        b = [{'id': 0, 'members': [], 'center': np.array([0.0, 0.0])},
             {'id': 1, 'members': [], 'center': np.array([9.0, 9.0])}]
        assert same_clustering(a, b) is True  # extra cluster in b ignored


# ---------------------------------------------------------------------------
# cluster_step (clusters.clj:142-158) — assign, drop empty, recenter
# ---------------------------------------------------------------------------

class TestClusterStep:
    def test_assign_drop_empty_and_recenter(self):
        data = _nd(['a', 'b', 'c', 'd'], [[0, 0], [0, 1], [10, 10], [10, 11]])
        clusters = init_clusters(data, 2)  # centers [0,0], [0,1]
        stepped = cluster_step(data, clusters)
        by = _by_id(stepped)
        # a->c0 (dist 0); b->c1 (dist 0); c,d closer to c1 -> c1 gets b,c,d.
        assert set(by[0]['members']) == {'a'}
        assert set(by[1]['members']) == {'b', 'c', 'd'}
        np.testing.assert_allclose(by[0]['center'], [0, 0])
        np.testing.assert_allclose(by[1]['center'], [20 / 3, 22 / 3])

    def test_empty_cluster_is_dropped(self):
        # Two init centers, but all points identical -> one cluster empties out.
        data = _nd(['a', 'b'], [[0, 0], [0, 0]])
        clusters = [{'id': 0, 'members': [], 'center': np.array([0.0, 0.0])},
                    {'id': 1, 'members': [], 'center': np.array([9.0, 9.0])}]
        stepped = cluster_step(data, clusters)
        assert [c['id'] for c in stepped] == [0]  # id 1 got no members, dropped

    def test_weighted_recentering(self):
        # Group-level style: weights by name. Two points assigned to one cluster.
        data = _nd([0, 1], [[0.0, 0.0], [0.0, 2.0]])
        clusters = [{'id': 7, 'members': [], 'center': np.array([0.0, 1.0])}]
        stepped = cluster_step(data, clusters, weights={0: 1, 1: 3})
        # weighted mean y = (1*0 + 3*2)/4 = 1.5 (vs unweighted 1.0)
        np.testing.assert_allclose(stepped[0]['center'], [0.0, 1.5])


class TestClusterStepHashOrderTieBreak:
    """Clojure's cluster-step iterates the cleared-clusters map: ``(into {})``
    of ``[id cluster]`` pairs is an array-map in INSERTION (input) order for
    <=8 clusters but a PersistentHashMap for >8, whose seq order is the HAMT
    trie order of the id hashes (clusters.clj:79-86, 149). add-to-closest's
    min-key keeps the LAST minimal entry in THAT order, so the scan order is
    semantic exactly on distance ties — which the Q11 cancellation floor
    makes COMMON, not measure-zero (pc-modheavy-01 step 2: 12 seed clusters
    emptied clj-side by hash-order ties, 80 vs 92 recorded clusters; journal
    2026-07-24).

    Ground truth from real Clojure (clojure -M eval, 2026-07-24):
      (keys (into {} (map (juxt identity identity) (range 9))))
        => (0 7 1 4 6 3 2 5 8)     ; ids 1 and 7 INVERT input order
      (range 8) stays (0 1 2 3 4 5 6 7)   ; array-map, insertion order
    polismath.utils.clj_hash.clojure_hash_map_key_order reproduces the n=9
    and n=20 orders bit-for-bit (cross-validated same session)."""

    @staticmethod
    def _tie_fixture(n_ids):
        # Row 't' ties at distance 0.0 between clusters 1 and 7 (both centers
        # exactly its position); every other cluster holds its own coincident
        # row so nothing else moves or empties.
        names, rows, clusters = [], [], []
        for i in range(n_ids):
            if i in (1, 7):
                center = [5.0, 5.0]
            else:
                center = [10.0 * i, -7.0]
                names.append(f"p{i}")
                rows.append(center)
            clusters.append({'id': i, 'members': [], 'center': np.array(center)})
        names.append("t")
        rows.append([5.0, 5.0])
        return _nd(names, rows), clusters

    def test_gt8_ties_resolve_by_clojure_hash_map_order(self):
        data, clusters = self._tie_fixture(9)
        by = _by_id(cluster_step(data, clusters))
        # hash order (0 7 1 4 6 3 2 5 8): id 1 comes AFTER id 7 -> 1 wins.
        assert 't' in by[1]['members']
        assert 7 not in by  # cluster 7 got no members -> dropped

    def test_le8_ties_resolve_by_input_order(self):
        data, clusters = self._tie_fixture(8)
        by = _by_id(cluster_step(data, clusters))
        # array-map insertion order == input order: id 7 is later -> 7 wins.
        assert 't' in by[7]['members']
        assert 1 not in by


# ---------------------------------------------------------------------------
# safe_recenter_clusters (clusters.clj:171-191) — drop vanished
# ---------------------------------------------------------------------------

class TestSafeRecenter:
    def test_drops_cluster_whose_members_all_vanished(self):
        clusters = [
            {'id': 0, 'members': ['a', 'b'], 'center': np.array([0.0, 0.5])},
            {'id': 1, 'members': ['c', 'd'], 'center': np.array([10.0, 10.5])},
        ]
        # New data: c and d are gone; a, b remain; e is new.
        data = _nd(['a', 'b', 'e'], [[0, 0], [0, 1], [5, 5]])
        out = safe_recenter_clusters(data, clusters)
        assert [c['id'] for c in out] == [0]  # cluster 1 dropped
        np.testing.assert_allclose(out[0]['center'], [0.0, 0.5])

    def test_all_vanished_fallback_one_big_cluster_inc_max_id(self):
        clusters = [{'id': 4, 'members': ['x'], 'center': np.array([0.0, 0.0])}]
        data = _nd(['y', 'z'], [[1, 1], [3, 3]])  # x gone
        out = safe_recenter_clusters(data, clusters)
        assert len(out) == 1
        assert out[0]['id'] == 5  # (inc (max 4))
        assert set(out[0]['members']) == {'y', 'z'}
        np.testing.assert_allclose(out[0]['center'], [2.0, 2.0])


# ---------------------------------------------------------------------------
# merge_clusters / uniqify_clusters (clusters.clj:194-227)
# ---------------------------------------------------------------------------

class TestMerge:
    def test_merge_keeps_larger_id_and_weighted_center(self):
        big = {'id': 3, 'members': ['a', 'a2'], 'center': np.array([1.0, 1.0])}
        small = {'id': 8, 'members': ['b'], 'center': np.array([4.0, 4.0])}
        merged = merge_clusters(big, small)
        assert merged['id'] == 3  # larger member count keeps its id
        assert merged['members'] == ['a', 'a2', 'b']
        # weighted by counts: (2*[1,1] + 1*[4,4]) / 3 = [2,2]
        np.testing.assert_allclose(merged['center'], [2.0, 2.0])

    def test_merge_tie_keeps_second_arg_id(self):
        c1 = {'id': 3, 'members': ['a'], 'center': np.array([0.0, 0.0])}
        c2 = {'id': 8, 'members': ['b'], 'center': np.array([2.0, 2.0])}
        merged = merge_clusters(c1, c2)
        # Clojure max-key returns the LAST of equal-keyed args -> c2's id.
        assert merged['id'] == 8

    def test_uniqify_merges_identical_centers_keeps_larger(self):
        clusters = [
            {'id': 0, 'members': ['a', 'a2'], 'center': np.array([1.0, 1.0])},
            {'id': 1, 'members': ['b'], 'center': np.array([1.0, 1.0])},
            {'id': 2, 'members': ['c'], 'center': np.array([9.0, 9.0])},
        ]
        out = uniqify_clusters(clusters)
        by = _by_id(out)
        assert set(by.keys()) == {0, 2}  # 0 and 1 merged, 1's id gone (0 larger)
        assert by[0]['members'] == ['a', 'a2', 'b']


# ---------------------------------------------------------------------------
# most_distal (clusters.clj:202-217)
# ---------------------------------------------------------------------------

class TestMostDistal:
    def test_farthest_point_from_nearest_center(self):
        clusters = [{'id': 0, 'members': ['a', 'b'], 'center': np.array([0.0, 0.0])}]
        data = _nd(['a', 'b', 'c'], [[0, 0], [0, 0], [3, 4]])
        out = most_distal(data, clusters)
        assert out['id'] == 'c'
        assert out['clst_id'] == 0
        assert out['dist'] == pytest.approx(5.0)


# ---------------------------------------------------------------------------
# clean_start_clusters (clusters.clj:230-277) — split loop, new ids
# ---------------------------------------------------------------------------

class TestCleanStart:
    def test_split_creates_new_cluster_with_inc_max_id(self):
        # One surviving cluster (id 5) + a distal new point -> split to 2.
        clusters = [{'id': 5, 'members': ['a'], 'center': np.array([0.0, 0.0])}]
        data = _nd(['a', 'z'], [[0, 0], [9, 9]])
        out = clean_start_clusters(data, clusters, k=2)
        by = _by_id(out)
        assert set(by.keys()) == {5, 6}  # new cluster id = inc(max(5))
        assert by[6]['members'] == ['z']
        np.testing.assert_allclose(by[6]['center'], [9, 9])

    def test_no_split_when_enough_clusters(self):
        clusters = [
            {'id': 0, 'members': ['a'], 'center': np.array([0.0, 0.0])},
            {'id': 1, 'members': ['b'], 'center': np.array([9.0, 9.0])},
        ]
        data = _nd(['a', 'b'], [[0, 0], [9, 9]])
        out = clean_start_clusters(data, clusters, k=2)
        assert {c['id'] for c in out} == {0, 1}  # already at possible=2


# ---------------------------------------------------------------------------
# kmeans end-to-end (clusters.clj:301-312)
# ---------------------------------------------------------------------------

class TestKmeansEndToEnd:
    def test_cold_two_well_separated_groups(self):
        data = _nd(['a', 'b', 'c', 'd'], [[0, 0], [0, 1], [10, 10], [10, 11]])
        out = kmeans(data, k=2, max_iters=100)
        by = _by_id(out)
        assert set(by[0]['members']) == {'a', 'b'}
        assert set(by[1]['members']) == {'c', 'd'}
        # Compare center vectors AS-IS: sorting coordinates would mask an
        # x/y axis swap.
        np.testing.assert_allclose(by[0]['center'], [0.0, 0.5])
        np.testing.assert_allclose(by[1]['center'], [10.0, 10.5])

    def test_cold_singletons_when_k_equals_n_distinct(self):
        # k == n distinct rows -> each point its own cluster, ids by encounter.
        data = _nd(['a', 'b', 'c'], [[0, 0], [5, 5], [9, 1]])
        out = kmeans(data, k=3, max_iters=100)
        by = _by_id(out)
        assert by[0]['members'] == ['a']
        assert by[1]['members'] == ['b']
        assert by[2]['members'] == ['c']

    def test_warm_start_preserves_ids_adds_new_participant(self):
        # Tick 1: two groups -> ids {0,1}. Tick 2: same points + a far new point,
        # k bumped to 3. Old ids 0,1 persist; the new group gets a strictly
        # larger id (lineage).
        d1 = _nd(['a', 'b', 'c', 'd'], [[0, 0], [0, 1], [10, 10], [10, 11]])
        t1 = kmeans(d1, k=2, max_iters=100)
        assert {c['id'] for c in t1} == {0, 1}

        d2 = _nd(['a', 'b', 'c', 'd', 'e'],
                 [[0, 0], [0, 1], [10, 10], [10, 11], [100, 100]])
        t2 = kmeans(d2, k=3, last_clusters=t1, max_iters=100)
        ids = {c['id'] for c in t2}
        assert {0, 1}.issubset(ids)          # lineage preserved
        assert max(ids) >= 2                  # new cluster id strictly larger
        by = _by_id(t2)
        # 'e' is the lone far point -> its own new cluster.
        e_cluster = next(c for c in t2 if 'e' in c['members'])
        assert e_cluster['id'] >= 2
        assert e_cluster['members'] == ['e']

    def test_warm_start_weighted_group_level(self):
        # Group-level cold k-means with member-count weights; weighted mean must
        # pull the c0 center toward the heavier member (clusters.clj:154-158).
        data = _nd([0, 1, 2], [[0.0, 0.0], [0.0, 2.0], [10.0, 10.0]])
        out = kmeans(data, k=2, weights={0: 1, 1: 3, 2: 1}, max_iters=100)
        by = _by_id(out)
        c0 = next(c for c in out if set(c['members']) == {0, 1})
        # weighted center y = (1*0 + 3*2)/4 = 1.5, NOT unweighted 1.0
        np.testing.assert_allclose(c0['center'], [0.0, 1.5])


# ---------------------------------------------------------------------------
# Q11: vectorz distance cancellation (CLOJURE_QUIRKS.md Q11).
# ---------------------------------------------------------------------------
class TestQ11DistanceCancellation:
    """Clojure's kmeans distances go through vectorz's d² = |a|²+|b|²−2a·b,
    whose cancellation floors true distances below ~1e-8 to EXACTLY 0.0 —
    so near-coincident points TIE and merge into the LATER cluster
    (min-key last-wins). Verified in-process on the vw every-vote step-57
    pair via math/dev/proj_probe.clj (journal 2026-07-22)."""

    def test_euclidean_uses_clojure_cancellation_formula(self):
        from polismath.pca_kmeans_rep.legacy_kmeans import _euclidean

        p5 = np.array([-1.7765256006253405, 0.65139331269767860])
        c8 = np.array([-1.7765256006253405, 0.65139331269767400])
        # True distance 4.66e-15; the vectorz formula returns exactly 0.0.
        assert _euclidean(p5, c8) == 0.0
        # Normal-scale distances stay correct.
        assert _euclidean(np.array([0.0, 0.0]), np.array([3.0, 4.0])) == pytest.approx(5.0)

    def test_euclidean_propagates_nan_instead_of_clamping(self):
        """#2663 review pin: NaN input must PROPAGATE (real vectorz has no
        clamp) — the former ``max(0.0, d2)`` silently returned 0.0 because
        python's two-arg max returns its FIRST argument when the second is
        NaN. A NaN center reaching cluster_step would otherwise be silently
        absorbed as distance-0 instead of surfacing the corruption."""
        import math

        from polismath.pca_kmeans_rep.legacy_kmeans import _euclidean

        assert math.isnan(_euclidean(np.array([np.nan, 0.0]),
                                     np.array([1.0, 2.0])))
        assert math.isnan(_euclidean(np.array([1.0, 2.0]),
                                     np.array([0.0, np.nan])))

    def test_near_coincident_singletons_merge_to_later_cluster(self):
        from polismath.pca_kmeans_rep.legacy_kmeans import _NamedData, kmeans

        # The REAL vw every-vote step-57 pair (journal 2026-07-22): the
        # cancellation collapses their 4.66e-15 separation to exactly 0.0.
        # (Not every near-coincident synthetic pair does — the residue of
        # |a|²+|b|²−2ab can land on either side of zero bit-by-bit.)
        a = [-1.7765256006253405, 0.65139331269767860]
        b = [-1.7765256006253405, 0.65139331269767400]
        far = [5.0, 5.0]
        data = _NamedData([10, 20, 30], np.array([a, b, far]))
        last = [
            {"id": 6, "members": [10], "center": np.array(a)},
            {"id": 7, "members": [30], "center": np.array(far)},
            {"id": 8, "members": [20], "center": np.array(b)},
        ]
        result = {c["id"]: sorted(c["members"]) for c in kmeans(data, 100, last_clusters=last)}
        # Clojure: both coincident points tie at distance 0.0 to clusters 6
        # AND 8 -> min-key last-wins sends both to id 8; id 6 empties, drops.
        assert result == {7: [30], 8: [10, 20]}


# ---------------------------------------------------------------------------
# Item 9a: vectorized distance columns — bit-equality pins.
#
# The scalar _euclidean path (Q11 cancellation formula) is the semantic
# reference: distances that cancel to EXACTLY 0.0 create ties that decide
# cluster-id lineage, so the vectorized per-center column MUST reproduce the
# scalar result bit for bit (==, not approx). The reference below is a
# VERBATIM copy of the pre-vectorization formula — kept here on purpose so
# the production code can never drift from it unnoticed.
# ---------------------------------------------------------------------------

def _scalar_d2_reference(av, bv):
    """Verbatim copy of the scalar ``_euclidean`` d² computation: three
    separate float(np.dot(...)) terms combined left-to-right, then the
    elementwise negative-residue floor (if-based, so NaN propagates)."""
    av = np.asarray(av, dtype=float)
    bv = np.asarray(bv, dtype=float)
    d2 = float(np.dot(av, av)) + float(np.dot(bv, bv)) - 2.0 * float(np.dot(av, bv))
    if d2 < 0.0:
        d2 = 0.0
    return d2


def _scalar_dist_reference(av, bv):
    """sqrt of the reference d² — bitwise what ``_euclidean`` returns."""
    return float(np.sqrt(_scalar_d2_reference(av, bv)))


# The vw every-vote step-57 knife-edge pair (journal 2026-07-22): true
# distance 4.66e-15, cancellation floors it to EXACTLY 0.0.
VW_KNIFE_A = [-1.7765256006253405, 0.65139331269767860]
VW_KNIFE_B = [-1.7765256006253405, 0.65139331269767400]


class TestVectorizedDistanceColumnBitEquality:
    """_euclidean_col(matrix, center, row_norms) must equal the scalar path
    EXACTLY, element by element, on every shape — including the cancellation
    knife-edge and NaN propagation."""

    @staticmethod
    def _assert_col_bit_equal(X, c):
        from polismath.pca_kmeans_rep.legacy_kmeans import _euclidean_col, _row_norms

        X = np.asarray(X, dtype=float)
        col = _euclidean_col(X, np.asarray(c, dtype=float), _row_norms(X))
        ref = np.array([_scalar_dist_reference(X[i], c) for i in range(X.shape[0])])
        both_nan = np.isnan(col) & np.isnan(ref)
        assert ((col == ref) | both_nan).all(), (
            f"bit mismatch for shape {X.shape}: got {col!r} want {ref!r}")
        return col

    def test_row_norms_bit_equal_to_scalar_dot(self):
        from polismath.pca_kmeans_rep.legacy_kmeans import _row_norms

        rng = np.random.default_rng(20260727)
        for (n, d) in [(1, 2), (3, 2), (8, 2), (100, 2), (1000, 2),
                       (2, 1), (7, 5), (9, 7), (60, 100)]:
            for scale in (1.0, 1e-8, 1e8):
                X = rng.standard_normal((n, d)) * scale
                got = _row_norms(X)
                ref = np.array([float(np.dot(X[i], X[i])) for i in range(n)])
                assert (got == ref).all(), (n, d, scale)

    def test_random_shapes_bit_equal(self):
        rng = np.random.default_rng(4290)
        # Includes 1-row matrices and small-n cases (fewer rows than the
        # cluster counts exercised in the step-level tests below).
        for (n, d) in [(1, 2), (3, 2), (8, 2), (100, 2), (1000, 2),
                       (2, 1), (7, 5), (9, 7), (60, 100)]:
            for scale in (1.0, 1e-8, 1e8):
                X = rng.standard_normal((n, d)) * scale
                for _ in range(3):
                    self._assert_col_bit_equal(X, rng.standard_normal(d) * scale)
                # Center coincident with a row: self-distance must be the
                # scalar's exact result (0.0 via the cancellation formula).
                col = self._assert_col_bit_equal(X, X[0].copy())
                assert col[0] == 0.0

    def test_knife_edge_pair_cancels_to_exactly_zero(self):
        X = np.array([VW_KNIFE_A, VW_KNIFE_B, [5.0, 5.0]])
        for center in (np.array(VW_KNIFE_A), np.array(VW_KNIFE_B)):
            col = self._assert_col_bit_equal(X, center)
            # BOTH near-coincident rows floor to exactly 0.0 against either
            # center — the tie that decides Q11 merge lineage.
            assert col[0] == 0.0 and col[1] == 0.0

    def test_nan_row_and_nan_center_propagate(self):
        from polismath.pca_kmeans_rep.legacy_kmeans import _euclidean_col, _row_norms

        X = np.array([[np.nan, 0.0], [1.0, 2.0]])
        col = self._assert_col_bit_equal(X, np.array([3.0, 4.0]))
        assert np.isnan(col[0]) and not np.isnan(col[1])

        Xok = np.array([[1.0, 2.0], [3.0, 4.0]])
        col = _euclidean_col(Xok, np.array([0.0, np.nan]), _row_norms(Xok))
        assert np.isnan(col).all()


class TestVectorizedClusterStepEquivalence:
    """The vectorized assignment scan must reproduce the scalar row loop
    EXACTLY: same members (order included), same surviving ids, bitwise-same
    centers — under hash-scan order (>8), input order (<=8), weights, ties,
    and k>n."""

    @staticmethod
    def _reference_cluster_step(data, clusters, weights=None):
        # Verbatim pre-vectorization loop (distances via the scalar reference).
        from polismath.pca_kmeans_rep.legacy_kmeans import (
            _cluster_weights as cw, weighted_mean as wm)
        from polismath.utils.clj_hash import clojure_hash_map_key_order

        n = len(clusters)
        if n == 0:
            return []
        centers = [np.asarray(c['center'], dtype=float) for c in clusters]
        members = [[] for _ in range(n)]
        positions = [[] for _ in range(n)]
        if n > 8:
            hash_pos = {cid: i for i, cid in enumerate(
                clojure_hash_map_key_order([c['id'] for c in clusters]))}
            scan = sorted(range(n), key=lambda j: hash_pos[clusters[j]['id']])
        else:
            scan = list(range(n))
        for name, row in zip(data.row_names, data.matrix):
            best_idx = scan[0]
            best_dist = _scalar_dist_reference(row, centers[scan[0]])
            for j in scan[1:]:
                d = _scalar_dist_reference(row, centers[j])
                if d <= best_dist:
                    best_dist = d
                    best_idx = j
            members[best_idx].append(name)
            positions[best_idx].append(row)
        out = []
        for j in range(n):
            if not members[j]:
                continue
            out.append({'id': clusters[j]['id'], 'members': members[j],
                        'center': wm(positions[j], cw(members[j], weights))})
        return out

    @staticmethod
    def _assert_same(got, ref):
        assert len(got) == len(ref)
        for g, r in zip(got, ref):
            assert g['id'] == r['id']
            assert list(g['members']) == list(r['members'])
            gc = np.asarray(g['center'], dtype=float)
            rc = np.asarray(r['center'], dtype=float)
            same = (gc == rc) | (np.isnan(gc) & np.isnan(rc))
            assert gc.shape == rc.shape and same.all(), (g['id'], gc, rc)

    def _random_case(self, rng, n_rows, n_clusters, weighted, grid=True):
        # Grid-quantized coordinates make duplicate rows and row==center
        # coincidences COMMON -> exact 0.0 ties through the cancellation
        # formula, exercising the last-wins tie-break for real.
        if grid:
            vals = np.array([-1.0, -0.5, 0.0, 0.5, 1.0])
            X = vals[rng.integers(0, len(vals), size=(n_rows, 2))]
        else:
            X = rng.standard_normal((n_rows, 2))
        names = [f"p{i}" for i in range(n_rows)]
        data = _nd(names, X)
        centers = []
        for _ in range(n_clusters):
            if grid and rng.random() < 0.5 and n_rows:
                centers.append(X[rng.integers(0, n_rows)].copy())
            else:
                centers.append(rng.standard_normal(2))
        clusters = [{'id': i * 3 + 1, 'members': [], 'center': np.asarray(c)}
                    for i, c in enumerate(centers)]
        weights = ({nm: float(w) for nm, w in
                    zip(names, rng.integers(1, 5, size=n_rows))}
                   if weighted else None)
        return data, clusters, weights

    def test_matches_reference_across_fixtures(self):
        from polismath.pca_kmeans_rep.legacy_kmeans import cluster_step

        rng = np.random.default_rng(97)
        cases = [
            (50, 12, False, True),   # >8 clusters -> hash scan order + ties
            (50, 12, True, True),    # ... with weights
            (40, 5, False, True),    # <=8 clusters -> input order
            (40, 8, True, True),     # boundary n==8
            (5, 12, False, True),    # k > n
            (1, 3, False, False),    # single row
            (30, 9, False, False),   # continuous coords (no ties)
        ]
        for (n_rows, n_clusters, weighted, grid) in cases:
            for _ in range(3):
                data, clusters, weights = self._random_case(
                    rng, n_rows, n_clusters, weighted, grid)
                got = cluster_step(data, clusters, weights)
                ref = self._reference_cluster_step(data, clusters, weights)
                self._assert_same(got, ref)

    def test_nan_row_follows_scalar_semantics(self):
        # A NaN row never updates past the first scanned cluster (NaN <= x is
        # False) -> it lands in scan[0], exactly as the scalar loop did.
        from polismath.pca_kmeans_rep.legacy_kmeans import cluster_step

        data = _nd(['a', 'nanrow'], [[0.0, 0.0], [np.nan, 1.0]])
        clusters = [{'id': 0, 'members': [], 'center': np.array([0.0, 0.0])},
                    {'id': 1, 'members': [], 'center': np.array([9.0, 9.0])}]
        got = cluster_step(data, clusters)
        ref = self._reference_cluster_step(data, clusters)
        self._assert_same(got, ref)
        assert 'nanrow' in got[0]['members']  # scan[0] == input position 0


class TestVectorizedMostDistalEquivalence:
    """most_distal must reproduce the scalar double loop exactly: inner
    min over clusters (ties -> LATER cluster in input order), outer max over
    rows (ties -> LATER row), NaN rows skipped — except a NaN FIRST row,
    which the scalar loop keeps forever (nothing compares >= NaN)."""

    @staticmethod
    def _reference_most_distal(data, clusters):
        # Verbatim pre-vectorization loop.
        best_dist = None
        best_clst_id = None
        best_name = None
        for name, row in zip(data.row_names, data.matrix):
            near_dist = _scalar_dist_reference(
                row, np.asarray(clusters[0]['center'], dtype=float))
            near_id = clusters[0]['id']
            for clst in clusters[1:]:
                d = _scalar_dist_reference(
                    row, np.asarray(clst['center'], dtype=float))
                if d <= near_dist:
                    near_dist = d
                    near_id = clst['id']
            if best_dist is None or near_dist >= best_dist:
                best_dist = near_dist
                best_clst_id = near_id
                best_name = name
        return {'dist': best_dist, 'clst_id': best_clst_id, 'id': best_name}

    @classmethod
    def _assert_same(cls, data, clusters):
        from polismath.pca_kmeans_rep.legacy_kmeans import most_distal

        got = most_distal(data, clusters)
        ref = cls._reference_most_distal(data, clusters)
        assert got['clst_id'] == ref['clst_id'] and got['id'] == ref['id'], (got, ref)
        if ref['dist'] is None or np.isnan(ref['dist']):
            assert got['dist'] is ref['dist'] or np.isnan(got['dist'])
        else:
            assert got['dist'] == ref['dist']
        return got

    def test_matches_reference_on_random_and_tied_fixtures(self):
        rng = np.random.default_rng(1337)
        vals = np.array([-1.0, 0.0, 1.0])
        for n_rows, n_clusters in [(1, 1), (2, 5), (30, 3), (30, 11), (4, 9)]:
            for _ in range(5):
                X = vals[rng.integers(0, 3, size=(n_rows, 2))]
                data = _nd([f"p{i}" for i in range(n_rows)], X)
                clusters = []
                for i in range(n_clusters):
                    center = (X[rng.integers(0, n_rows)].copy()
                              if rng.random() < 0.5 else rng.standard_normal(2))
                    clusters.append({'id': i + 2, 'members': [],
                                     'center': np.asarray(center, dtype=float)})
                self._assert_same(data, clusters)

    def test_all_rows_tie_at_zero_later_row_wins(self):
        # Every row coincides with the single center -> all dists exactly 0.0
        # -> outer >= keeps the LAST row.
        data = _nd(['a', 'b', 'c'], [[1.0, 1.0], [1.0, 1.0], [1.0, 1.0]])
        clusters = [{'id': 5, 'members': [], 'center': np.array([1.0, 1.0])}]
        got = self._assert_same(data, clusters)
        assert got['id'] == 'c' and got['dist'] == 0.0

    def test_nan_first_row_sticks_nan_later_row_skipped(self):
        clusters = [{'id': 0, 'members': [], 'center': np.array([0.0, 0.0])}]
        # NaN first row: best stays row 0 with NaN dist (scalar semantics).
        data = _nd(['n', 'b'], [[np.nan, 0.0], [3.0, 4.0]])
        got = self._assert_same(data, clusters)
        assert got['id'] == 'n' and np.isnan(got['dist'])
        # NaN NON-first row: skipped (NaN >= best is False).
        data2 = _nd(['a', 'n', 'b'], [[1.0, 0.0], [np.nan, 0.0], [3.0, 4.0]])
        got2 = self._assert_same(data2, clusters)
        assert got2['id'] == 'b'


class TestNDistinctRowsBounded:
    """n_distinct_rows gains a ``bound`` cap so clean_start_clusters'
    ``min(k, n_distinct)`` never pays for a full O(n²) distinct count.
    Semantics must match the pre-vectorization scan: first-encounter
    distinctness via array_equal(..., equal_nan=True)."""

    @staticmethod
    def _reference_n_distinct(matrix):
        # Verbatim pre-vectorization implementation.
        distinct = []
        for row in np.asarray(matrix, dtype=float):
            if not any(np.array_equal(row, u, equal_nan=True) for u in distinct):
                distinct.append(row)
        return len(distinct)

    def test_unbounded_matches_reference_including_nan_and_negzero(self):
        cases = [
            [[0.0, 0.0], [0.0, 0.0], [1.0, 1.0]],
            [[np.nan, 1.0], [np.nan, 1.0], [np.nan, 2.0]],   # NaN == NaN rows
            [[-0.0, 1.0], [0.0, 1.0]],                        # -0.0 == 0.0
            [[1.0, 2.0]],
            np.zeros((0, 2)),
        ]
        data_rng = np.random.default_rng(7)
        cases.append(np.array([-1.0, 0.0, 1.0])[
            data_rng.integers(0, 3, size=(40, 2))])
        for rows in cases:
            m = np.asarray(rows, dtype=float)
            nd = _NamedData(list(range(m.shape[0])), m)
            assert nd.n_distinct_rows() == self._reference_n_distinct(m)

    def test_bounded_count_saturates_like_min(self):
        m = np.array([[0.0, 0.0], [1.0, 1.0], [0.0, 0.0], [2.0, 2.0],
                      [3.0, 3.0], [1.0, 1.0]])  # 4 distinct
        nd = _NamedData(list('abcdef'), m)
        full = self._reference_n_distinct(m)
        for k in (1, 2, 3, 4, 5, 10):
            assert min(k, nd.n_distinct_rows(bound=k)) == min(k, full)
