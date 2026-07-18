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
        np.testing.assert_allclose(sorted(by[0]['center']), [0.0, 0.5])
        np.testing.assert_allclose(sorted(by[1]['center']), [10.0, 10.5])

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
