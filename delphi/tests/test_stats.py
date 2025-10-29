"""
Tests for the statistics module.
"""

import math
import os
import sys

import numpy as np
import pytest
from scipy import stats as scipy_stats

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from polismath.pca_kmeans_rep.stats import (
    bayesian_ci_95,
    binomial_test,
    bootstrap_ci_95,
    ci_95,
    fisher_exact_test,
    gini_coefficient,
    prop_test,
    shannon_entropy,
    two_prop_test,
    weighted_stddev,
    z_sig_90,
    z_sig_95,
)


class TestProportionTests:
    """Tests for proportion test functions."""

    def test_prop_test(self):
        """Test the proportion test function."""
        # Test with different proportions
        z1 = prop_test(80, 100)  # 80% success
        z2 = prop_test(50, 100)  # 50% success
        z3 = prop_test(20, 100)  # 20% success

        # Higher proportion should yield positive z-scores
        assert z1 > 0
        # 50% proportion should yield z-score close to 0
        assert abs(z2) < 0.5
        # Lower proportion should yield negative z-scores
        assert z3 < 0

        # Test with extreme values
        assert prop_test(0, 0) != float("inf")  # Should handle edge cases
        assert prop_test(1, 1) != float("inf")

    def test_two_prop_test(self):
        """Test the two-proportion test function."""
        # Test with different proportions
        z1 = two_prop_test(80, 100, 50, 100)  # 80% vs 50%
        z2 = two_prop_test(50, 100, 50, 100)  # 50% vs 50%
        z3 = two_prop_test(20, 100, 50, 100)  # 20% vs 50%

        # First proportion higher should yield positive z-scores
        assert z1 > 0
        # Equal proportions should yield z-score close to 0
        assert abs(z2) < 0.5
        # First proportion lower should yield negative z-scores
        assert z3 < 0

        # Test with extreme values
        assert two_prop_test(0, 0, 50, 100) != float("inf")  # Should handle edge cases
        assert two_prop_test(100, 100, 100, 100) != float("inf")

    def test_significance_functions(self):
        """Test the significance testing functions."""
        # 90% confidence level (z > 1.2816)
        assert z_sig_90(1.3)
        assert z_sig_90(-1.3)
        assert not z_sig_90(1.0)
        assert not z_sig_90(-1.0)

        # 95% confidence level (z > 1.6449)
        assert z_sig_95(1.7)
        assert z_sig_95(-1.7)
        assert not z_sig_95(1.5)
        assert not z_sig_95(-1.5)

    def test_prop_test_vs_scipy(self):
        """Compare our prop_test with scipy's version."""
        # Calculate using our function
        our_z = prop_test(70, 100)

        # Calculate using scipy
        # Scipy doesn't apply pseudocounts, so results will differ
        # We add pseudocounts for comparison
        p_hat = (70 + 1) / (100 + 2)
        scipy_z = (p_hat - 0.5) / math.sqrt(p_hat * (1 - p_hat) / (100 + 2))

        # Should be close
        assert abs(our_z - scipy_z) < 0.01

    def test_two_prop_test_vs_scipy(self):
        """Compare our two_prop_test with scipy's version."""
        # Calculate using our function
        our_z = two_prop_test(70, 100, 50, 100)

        # Calculate using scipy
        # Scipy doesn't apply pseudocounts, so results will differ
        # We add pseudocounts for comparison
        p1 = (70 + 1) / (100 + 2)
        p2 = (50 + 1) / (100 + 2)
        pooled_p = ((70 + 1) + (50 + 1)) / ((100 + 2) + (100 + 2))
        scipy_z = (p1 - p2) / math.sqrt(pooled_p * (1 - pooled_p) * (1 / (100 + 2) + 1 / (100 + 2)))

        # Should be close
        assert abs(our_z - scipy_z) < 0.01


class TestInformationTheory:
    """Tests for information theory functions."""

    def test_shannon_entropy(self):
        """Test Shannon entropy calculation."""
        # Uniform distribution has maximum entropy
        uniform = np.array([0.25, 0.25, 0.25, 0.25])
        max_entropy = shannon_entropy(uniform)
        assert np.isclose(max_entropy, 2.0)  # log2(4) = 2

        # Non-uniform distribution has lower entropy
        non_uniform = np.array([0.5, 0.25, 0.125, 0.125])
        lower_entropy = shannon_entropy(non_uniform)
        assert lower_entropy < max_entropy

        # Distribution with certainty has zero entropy
        certain = np.array([1.0, 0.0, 0.0, 0.0])
        zero_entropy = shannon_entropy(certain)
        assert np.isclose(zero_entropy, 0.0)

    def test_gini_coefficient(self):
        """Test Gini coefficient calculation."""
        # Perfect equality has Gini = 0
        equal = np.array([10, 10, 10, 10])
        assert np.isclose(gini_coefficient(equal), 0.0)

        # Perfect inequality has Gini = 1 - 1/n
        unequal = np.array([0, 0, 0, 10])
        expected_gini = 1 - 1 / 4
        assert np.isclose(gini_coefficient(unequal), expected_gini, atol=0.01)

        # Some inequality
        partial = np.array([5, 10, 15, 20])
        gini = gini_coefficient(partial)
        assert 0 < gini < 1


class TestDescriptiveStatistics:
    """Tests for descriptive statistics functions."""

    def test_weighted_stddev(self):
        """Test weighted standard deviation calculation."""
        # Test against numpy's unweighted version
        values = np.array([1, 2, 3, 4, 5])

        # Unweighted
        std_unweighted = weighted_stddev(values)
        assert np.isclose(std_unweighted, np.std(values))

        # Weighted with equal weights (should be same as unweighted)
        weights = np.array([1, 1, 1, 1, 1])
        std_weighted_equal = weighted_stddev(values, weights)
        assert np.isclose(std_weighted_equal, np.std(values))

        # Weighted with different weights
        weights = np.array([5, 1, 1, 1, 1])  # More weight on first value
        std_weighted = weighted_stddev(values, weights)

        # Manually calculate weighted standard deviation
        normalized_weights = weights / np.sum(weights)
        weighted_mean = np.sum(values * normalized_weights)
        weighted_variance = np.sum(normalized_weights * (values - weighted_mean) ** 2)
        manual_weighted_std = np.sqrt(weighted_variance)

        assert np.isclose(std_weighted, manual_weighted_std)


class TestConfidenceIntervals:
    """Tests for confidence interval functions."""

    def test_ci_95(self):
        """Test 95% confidence interval calculation."""
        # Generate normally distributed data
        np.random.seed(42)
        values = np.random.normal(100, 15, 1000)

        # Calculate 95% CI
        lower, upper = ci_95(values)

        # Mean should be within the interval
        mean = np.mean(values)
        assert lower <= mean <= upper

        # For large samples, CI width should be about 3.92 * standard error
        stderr = np.std(values, ddof=1) / np.sqrt(len(values))
        expected_width = 3.92 * stderr
        actual_width = upper - lower
        assert np.isclose(actual_width, expected_width, rtol=0.1)

        # Test with small sample
        small_values = values[:10]
        lower_small, upper_small = ci_95(small_values)

        # Small sample CI should be wider than large sample CI
        small_width = upper_small - lower_small
        assert small_width > actual_width

    def test_bayesian_ci_95(self):
        """Test Bayesian 95% confidence interval for proportions."""
        # Test with different proportions
        lower1, upper1 = bayesian_ci_95(80, 100)  # 80% success
        lower2, upper2 = bayesian_ci_95(50, 100)  # 50% success

        # Intervals should contain the point estimates
        assert lower1 <= 0.8 <= upper1
        assert lower2 <= 0.5 <= upper2

        # Higher proportion should have narrower interval (due to binomial variance)
        width1 = upper1 - lower1
        width2 = upper2 - lower2
        assert width1 < width2

        # Test with small sample
        lower3, upper3 = bayesian_ci_95(8, 10)  # 80% success but small sample
        width3 = upper3 - lower3

        # Small sample should have wider interval
        assert width3 > width1

    def test_bootstrap_ci_95(self):
        """Test bootstrap 95% confidence interval."""
        # Generate non-normal data
        np.random.seed(42)
        values = np.concatenate(
            [np.random.normal(100, 10, 900), np.random.normal(150, 20, 100)]  # Normal part  # Outliers
        )

        # Calculate bootstrap CI for mean
        lower, upper = bootstrap_ci_95(values)

        # Mean should be within the interval
        mean = np.mean(values)
        assert lower <= mean <= upper

        # Bootstrap CI for different statistics
        median_lower, median_upper = bootstrap_ci_95(values, np.median)

        # Median should be within its interval
        median = np.median(values)
        assert median_lower <= median <= median_upper


class TestStatisticalTests:
    """Tests for statistical test functions."""

    def test_binomial_test(self):
        """Test binomial test calculation."""
        # Test against scipy's implementation
        p1 = binomial_test(70, 100, 0.5)

        # Use the newer SciPy API if available
        try:
            p2 = scipy_stats.binomtest(70, 100, 0.5).pvalue
        except AttributeError:
            # Fall back to older API if necessary
            try:
                p2 = scipy_stats.binom_test(70, 100, 0.5)
            except AttributeError:
                # If neither is available, skip the test
                pytest.skip("SciPy binomial test functions not available")

        assert np.isclose(p1, p2)

        # Test with different expected proportions
        p3 = binomial_test(70, 100, 0.7)

        # Use the newer SciPy API if available
        try:
            p4 = scipy_stats.binomtest(70, 100, 0.7).pvalue
        except AttributeError:
            # Fall back to older API if necessary
            try:
                p4 = scipy_stats.binom_test(70, 100, 0.7)
            except AttributeError:
                # If neither is available, skip the test
                return

        assert np.isclose(p3, p4)

        # Test significance
        p5 = binomial_test(90, 100, 0.5)  # Very unlikely with p=0.5
        assert p5 < 0.001

    def test_fisher_exact_test(self):
        """Test Fisher's exact test."""
        # Create a 2x2 contingency table
        table = np.array([[12, 5], [7, 25]])

        # Calculate using our function
        odds_ratio, p_value = fisher_exact_test(table)

        # Calculate using scipy
        scipy_odds, scipy_p = scipy_stats.fisher_exact(table)

        # Results should match
        assert np.isclose(odds_ratio, scipy_odds)
        assert np.isclose(p_value, scipy_p)

        # Test for significance
        assert p_value < 0.05  # This table should show significance

        # Test with a non-significant table
        balanced_table = np.array([[10, 10], [10, 10]])

        _, p_value2 = fisher_exact_test(balanced_table)
        assert p_value2 > 0.05  # This table should not show significance
