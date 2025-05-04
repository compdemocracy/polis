"""
Statistical functions for the Pol.is math module.

This module provides statistical utilities used throughout the system,
particularly for measuring representativeness and significance.
"""

import numpy as np
import math
from typing import Dict, List, Optional, Tuple, Union


def prop_test(success_count: int, total_count: int) -> float:
    """
    Proportion test for a single proportion.
    
    Calculates a z-statistic for a single proportion using a pseudocount adjustment
    to prevent division by zero.
    
    Args:
        success_count: Number of successes
        total_count: Total number of trials
        
    Returns:
        Z-statistic for the proportion test
    """
    # Add pseudocount to avoid division by zero
    success_count_adj = success_count + 1
    total_count_adj = total_count + 2
    
    # Calculate proportion
    p_hat = success_count_adj / total_count_adj
    
    # Standard error
    se = math.sqrt(p_hat * (1 - p_hat) / total_count_adj)
    
    # Return z-statistic
    return (p_hat - 0.5) / se


def two_prop_test(success_count_1: int, total_count_1: int,
                 success_count_2: int, total_count_2: int) -> float:
    """
    Two-proportion z-test.
    
    Compares proportions between two populations using pseudocounts for stability.
    
    Args:
        success_count_1: Number of successes in first group
        total_count_1: Total number of trials in first group
        success_count_2: Number of successes in second group
        total_count_2: Total number of trials in second group
        
    Returns:
        Z-statistic for the two-proportion test
    """
    # Add pseudocounts to avoid division by zero
    success_count_1_adj = success_count_1 + 1
    total_count_1_adj = total_count_1 + 2
    success_count_2_adj = success_count_2 + 1
    total_count_2_adj = total_count_2 + 2
    
    # Calculate proportions
    p_hat_1 = success_count_1_adj / total_count_1_adj
    p_hat_2 = success_count_2_adj / total_count_2_adj
    
    # Pooled proportion
    pooled_p_hat = (success_count_1_adj + success_count_2_adj) / (total_count_1_adj + total_count_2_adj)
    
    # Handle edge case when pooled proportion is 1
    if pooled_p_hat >= 0.9999:
        pooled_p_hat = 0.9999
    
    # Standard error
    se = math.sqrt(pooled_p_hat * (1 - pooled_p_hat) * 
                  (1/total_count_1_adj + 1/total_count_2_adj))
    
    # Return z-statistic
    return (p_hat_1 - p_hat_2) / se


def z_sig_90(z: float) -> bool:
    """
    Test significance at 90% confidence level.
    
    Args:
        z: Z-statistic to test
        
    Returns:
        True if significant at 90% confidence level
    """
    return abs(z) > 1.2816


def z_sig_95(z: float) -> bool:
    """
    Test significance at 95% confidence level.
    
    Args:
        z: Z-statistic to test
        
    Returns:
        True if significant at 95% confidence level
    """
    return abs(z) > 1.6449


def shannon_entropy(p: np.ndarray) -> float:
    """
    Calculate Shannon entropy for a probability distribution.
    
    Args:
        p: Probability distribution
        
    Returns:
        Shannon entropy value
    """
    # Filter zeros to avoid log(0)
    p = p[p > 0]
    return -np.sum(p * np.log2(p))


def gini_coefficient(values: np.ndarray) -> float:
    """
    Calculate Gini coefficient as a measure of inequality.
    
    Args:
        values: Array of values
        
    Returns:
        Gini coefficient (0 = perfect equality, 1 = perfect inequality)
    """
    # Handle edge cases
    values = np.asarray(values)
    n = len(values)
    if n <= 1 or np.all(values == values[0]):
        return 0.0
    
    # Ensure all values are non-negative (Gini is typically for income/wealth)
    if np.any(values < 0):
        values = values - np.min(values)  # Shift to non-negative
    
    # Handle zero sum case
    if np.sum(values) == 0:
        return 0.0
    
    # Sort values (ascending)
    sorted_values = np.sort(values)
    
    # Calculate cumulative proportion of population and values
    cumulative_population = np.arange(1, n + 1) / n
    cumulative_values = np.cumsum(sorted_values) / np.sum(sorted_values)
    
    # Calculate Gini coefficient using the area method
    # Area between Lorenz curve and line of equality
    return 1 - 2 * np.trapz(cumulative_values, cumulative_population)


def weighted_stddev(values: np.ndarray, weights: Optional[np.ndarray] = None) -> float:
    """
    Calculate weighted standard deviation.
    
    Args:
        values: Array of values
        weights: Optional weights for values
        
    Returns:
        Weighted standard deviation
    """
    if weights is None:
        return np.std(values)
    
    # Normalize weights
    weights = weights / np.sum(weights)
    
    # Calculate weighted mean
    weighted_mean = np.sum(values * weights)
    
    # Calculate weighted variance
    weighted_variance = np.sum(weights * (values - weighted_mean)**2)
    
    # Return weighted standard deviation
    return np.sqrt(weighted_variance)


def ci_95(values: np.ndarray) -> Tuple[float, float]:
    """
    Calculate 95% confidence interval using Student's t-distribution.
    
    Args:
        values: Array of values
        
    Returns:
        Tuple of (lower bound, upper bound)
    """
    n = len(values)
    if n < 2:
        return (0.0, 0.0)
    
    mean = np.mean(values)
    stderr = np.std(values, ddof=1) / np.sqrt(n)
    
    # 95% CI using t-distribution
    t_crit = 1.96  # Approximation for large samples
    if n < 30:
        from scipy import stats
        t_crit = stats.t.ppf(0.975, n-1)
    
    lower = mean - t_crit * stderr
    upper = mean + t_crit * stderr
    
    return (lower, upper)


def bayesian_ci_95(success_count: int, total_count: int) -> Tuple[float, float]:
    """
    Calculate 95% Bayesian confidence interval for a proportion.
    
    Uses the Jeffreys prior for better behavior at extremes.
    
    Args:
        success_count: Number of successes
        total_count: Total number of trials
        
    Returns:
        Tuple of (lower bound, upper bound)
    """
    from scipy import stats
    
    # Jeffreys prior (Beta(0.5, 0.5))
    alpha = success_count + 0.5
    beta = total_count - success_count + 0.5
    
    lower = stats.beta.ppf(0.025, alpha, beta)
    upper = stats.beta.ppf(0.975, alpha, beta)
    
    return (lower, upper)


def bootstrap_ci_95(values: np.ndarray, 
                   statistic: callable = np.mean, 
                   n_bootstrap: int = 1000) -> Tuple[float, float]:
    """
    Calculate 95% confidence interval using bootstrap resampling.
    
    Args:
        values: Array of values
        statistic: Function to compute the statistic of interest
        n_bootstrap: Number of bootstrap samples
        
    Returns:
        Tuple of (lower bound, upper bound)
    """
    from scipy import stats
    
    n = len(values)
    if n < 2:
        return (0.0, 0.0)
    
    # Generate bootstrap samples
    bootstrap_stats = []
    for _ in range(n_bootstrap):
        # Sample with replacement
        sample = np.random.choice(values, size=n, replace=True)
        # Compute statistic
        bootstrap_stats.append(statistic(sample))
    
    # Calculate 95% confidence interval
    lower = np.percentile(bootstrap_stats, 2.5)
    upper = np.percentile(bootstrap_stats, 97.5)
    
    return (lower, upper)


def binomial_test(success_count: int, total_count: int, p: float = 0.5) -> float:
    """
    Perform a binomial test for a proportion.
    
    Args:
        success_count: Number of successes
        total_count: Total number of trials
        p: Expected proportion under null hypothesis
        
    Returns:
        P-value for the test
    """
    from scipy import stats
    
    if total_count == 0:
        return 1.0
    
    # In newer versions of scipy, binom_test was renamed to binomtest
    # and its API was updated to return an object with a pvalue attribute
    try:
        # Try the new API first
        result = stats.binomtest(success_count, total_count, p)
        return result.pvalue
    except AttributeError:
        # Fall back to the old API if available
        try:
            return stats.binom_test(success_count, total_count, p)
        except AttributeError:
            # If neither is available, implement a simple approximation
            import math
            from scipy.special import comb
            
            # Calculate binomial PMF
            def binom_pmf(k, n, p):
                return comb(n, k) * (p ** k) * ((1 - p) ** (n - k))
            
            # Calculate two-sided p-value
            observed_pmf = binom_pmf(success_count, total_count, p)
            p_value = 0.0
            
            for k in range(total_count + 1):
                k_pmf = binom_pmf(k, total_count, p)
                if k_pmf <= observed_pmf:
                    p_value += k_pmf
                    
            return min(p_value, 1.0)


def fisher_exact_test(count_matrix: np.ndarray) -> Tuple[float, float]:
    """
    Perform Fisher's exact test on a 2x2 contingency table.
    
    Args:
        count_matrix: 2x2 contingency table
        
    Returns:
        Tuple of (odds ratio, p-value)
    """
    from scipy import stats
    
    if count_matrix.shape != (2, 2):
        raise ValueError("Count matrix must be 2x2")
    
    return stats.fisher_exact(count_matrix)