"""
Unit tests for polismath.regression.clojure_comparer utilities.

Tests comparison functions with synthetic inputs to validate correctness
independently of real dataset volatility.
"""

import pytest

from polismath.regression.clojure_comparer import (
    compare_cluster_distributions,
    compare_cluster_membership,
    compare_projections,
    find_best_cluster_mapping,
    compute_distribution_similarity,
)


# ---------------------------------------------------------------------------
# compare_cluster_distributions
# ---------------------------------------------------------------------------

class TestCompareClusterDistributions:
    """Tests for L1-based cluster size distribution comparison."""

    def test_identical_distributions(self):
        """Identical clusters should have zero distance and match."""
        clusters = [
            {"members": [1, 2, 3]},
            {"members": [4, 5, 6]},
        ]
        result = compare_cluster_distributions(clusters, clusters)
        assert result["num_clusters_match"] is True
        assert result["l1_distance"] == pytest.approx(0.0)
        assert result["similarity_score"] == pytest.approx(1.0)
        assert result["match_status"] is True

    def test_different_sizes_same_count(self):
        """Clusters with same count but different sizes should have nonzero distance."""
        python = [{"members": [1, 2, 3, 4, 5]}, {"members": [6]}]
        clojure = [{"members": [1, 2, 3]}, {"members": [4, 5, 6]}]
        result = compare_cluster_distributions(python, clojure)
        assert result["num_clusters_match"] is True
        assert result["l1_distance"] > 0.0
        assert result["similarity_score"] < 1.0

    def test_different_cluster_counts_fails(self):
        """Different number of clusters must fail match_status regardless of distance."""
        python = [{"members": [1, 2]}, {"members": [3, 4]}, {"members": [5, 6]}]
        clojure = [{"members": [1, 2, 3]}, {"members": [4, 5, 6]}]
        result = compare_cluster_distributions(python, clojure)
        assert result["num_clusters_match"] is False
        assert result["match_status"] is False

    def test_empty_clusters(self):
        """Empty cluster lists should not match."""
        result = compare_cluster_distributions([], [{"members": [1]}])
        assert result["match_status"] is False

        result = compare_cluster_distributions([], [])
        assert result["match_status"] is False

    def test_single_cluster_identical(self):
        """Single identical cluster should match."""
        c = [{"members": [1, 2, 3]}]
        result = compare_cluster_distributions(c, c)
        assert result["match_status"] is True
        assert result["l1_distance"] == pytest.approx(0.0)

    def test_tolerance_boundary(self):
        """Distance exactly at tolerance should pass; just above should fail."""
        # Two clusters: [60, 40] vs [55, 45] — normalized [0.6, 0.4] vs [0.55, 0.45]
        # L1 = |0.6-0.55| + |0.4-0.45| = 0.05 + 0.05 = 0.1
        python = [{"members": list(range(60))}, {"members": list(range(60, 100))}]
        clojure = [{"members": list(range(55))}, {"members": list(range(55, 100))}]
        result = compare_cluster_distributions(python, clojure, tolerance=0.1)
        assert result["match_status"] is True

        result = compare_cluster_distributions(python, clojure, tolerance=0.09)
        assert result["match_status"] is False


# ---------------------------------------------------------------------------
# find_best_cluster_mapping & compare_cluster_membership
# ---------------------------------------------------------------------------

class TestFindBestClusterMapping:
    """Tests for greedy cluster mapping by Jaccard similarity."""

    def test_identical_clusters(self):
        """Identical clusters should map 1:1 with Jaccard 1.0."""
        clusters = [
            {"members": [1, 2, 3]},
            {"members": [4, 5, 6]},
        ]
        mapping = find_best_cluster_mapping(clusters, clusters)
        assert len(mapping) == 2
        for _, (_, jaccard) in mapping.items():
            assert jaccard == pytest.approx(1.0)

    def test_disjoint_clusters(self):
        """Completely disjoint clusters should have Jaccard 0."""
        python = [{"members": [1, 2, 3]}]
        clojure = [{"members": [4, 5, 6]}]
        mapping = find_best_cluster_mapping(python, clojure)
        assert len(mapping) == 1
        assert mapping[0][1] == pytest.approx(0.0)

    def test_partial_overlap(self):
        """Partially overlapping clusters should have 0 < Jaccard < 1."""
        python = [{"members": [1, 2, 3, 4]}]
        clojure = [{"members": [3, 4, 5, 6]}]
        mapping = find_best_cluster_mapping(python, clojure)
        # Intersection: {3, 4} = 2, Union: {1,2,3,4,5,6} = 6, Jaccard = 2/6
        assert mapping[0][1] == pytest.approx(2.0 / 6.0)


class TestCompareClusterMembership:
    """Tests for cluster membership comparison including match_status logic."""

    def test_identical_clusters_pass(self):
        """Identical clusters should pass with default threshold."""
        clusters = [
            {"members": [1, 2, 3]},
            {"members": [4, 5, 6]},
        ]
        result = compare_cluster_membership(clusters, clusters)
        assert result["match_status"] is True
        assert result["overall_similarity"] == pytest.approx(1.0)

    def test_different_cluster_counts_fails(self):
        """Different number of clusters must fail regardless of Jaccard scores."""
        python = [{"members": [1, 2]}, {"members": [3, 4]}, {"members": [5, 6]}]
        clojure = [{"members": [1, 2, 3]}, {"members": [4, 5, 6]}]
        result = compare_cluster_membership(python, clojure)
        assert result["match_status"] is False

    def test_low_jaccard_fails(self):
        """Low Jaccard similarity should fail even with matching counts."""
        python = [{"members": [1, 2, 3, 4, 5]}]
        clojure = [{"members": [4, 5, 6, 7, 8]}]
        result = compare_cluster_membership(python, clojure, min_jaccard=0.5)
        # Jaccard = 2/8 = 0.25 < 0.5
        assert result["match_status"] is False

    def test_empty_clusters(self):
        """Empty cluster lists should not match."""
        result = compare_cluster_membership([], [])
        assert result["match_status"] is False

    def test_threshold_respected(self):
        """Match status should respect the min_jaccard threshold."""
        # Two clusters with ~67% overlap
        python = [{"members": [1, 2, 3]}]
        clojure = [{"members": [2, 3, 4]}]
        # Jaccard = 2/4 = 0.5

        result = compare_cluster_membership(python, clojure, min_jaccard=0.5)
        assert result["match_status"] is True

        result = compare_cluster_membership(python, clojure, min_jaccard=0.6)
        assert result["match_status"] is False


# ---------------------------------------------------------------------------
# compare_projections
# ---------------------------------------------------------------------------

class TestCompareProjections:
    """Tests for PCA projection comparison with transformation testing."""

    def test_identical_projections(self):
        """Identical projections should have 100% same quadrant and zero distance."""
        proj = {"0": [1.0, 2.0], "1": [-1.0, 3.0], "2": [0.5, -0.5]}
        result = compare_projections(proj, proj)
        assert result["same_quadrant_percentage"] == pytest.approx(1.0)
        assert result["average_distance"] == pytest.approx(0.0)
        assert result["common_participants"] == 3

    def test_sign_flipped_projections(self):
        """Sign-flipped projections should be detected by transformation search."""
        python = {"0": [1.0, 2.0], "1": [-1.0, 3.0]}
        clojure = {"0": [-1.0, -2.0], "1": [1.0, -3.0]}  # flip_both
        result = compare_projections(python, clojure)
        assert result["best_transformation"] == "flip_both"
        assert result["average_distance"] == pytest.approx(0.0)

    def test_x_flipped_projections(self):
        """X-axis flip should be detected."""
        python = {"0": [1.0, 2.0], "1": [-3.0, 4.0]}
        clojure = {"0": [-1.0, 2.0], "1": [3.0, 4.0]}  # flip_x
        result = compare_projections(python, clojure)
        assert result["best_transformation"] == "flip_x"
        assert result["average_distance"] == pytest.approx(0.0)

    def test_no_common_participants(self):
        """No common participants should return zero metrics."""
        python = {"0": [1.0, 2.0]}
        clojure = {"1": [1.0, 2.0]}
        result = compare_projections(python, clojure)
        assert result["common_participants"] == 0
        assert result["same_quadrant_percentage"] == 0.0

    def test_dict_format_projections(self):
        """Projections in {x, y} dict format should work."""
        proj = {"0": {"x": 1.0, "y": 2.0}, "1": {"x": -1.0, "y": 3.0}}
        result = compare_projections(proj, proj)
        assert result["same_quadrant_percentage"] == pytest.approx(1.0)
        assert result["average_distance"] == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# compute_distribution_similarity
# ---------------------------------------------------------------------------

class TestComputeDistributionSimilarity:
    """Tests for the L1-based distribution similarity helper."""

    def test_identical_distributions(self):
        assert compute_distribution_similarity([1, 2, 3], [1, 2, 3]) == pytest.approx(1.0)

    def test_completely_different(self):
        # [1, 0] normalized = [1, 0], [0, 1] normalized = [0, 1], L1 = 2.0
        # similarity = max(0, 1 - 2) = 0
        assert compute_distribution_similarity([1, 0], [0, 1]) == pytest.approx(0.0)

    def test_empty_inputs(self):
        assert compute_distribution_similarity([], [1, 2]) == 0.0
        assert compute_distribution_similarity([1, 2], []) == 0.0
        assert compute_distribution_similarity([], []) == 0.0

    def test_proportional_distributions(self):
        """Distributions that are proportional should have similarity 1.0."""
        assert compute_distribution_similarity([2, 4, 6], [1, 2, 3]) == pytest.approx(1.0)
