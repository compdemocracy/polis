import numpy as np
import pytest
from numpy.testing import assert_array_almost_equal
from pythonport.pca import power_iteration, wrapped_pca
from sklearn.decomposition import PCA

def test_power_iteration_basic():
    data = np.array([
        [1, 0, 0],
        [-1, 1, 0.1],
        [0, 1, 0.1],
        [0, 1, -0.1]
    ])

    expected = np.array([-0.34217, 0.93906, 0.032633])

    # Test with different starting conditions
    result1 = power_iteration(data, 2)
    result2 = power_iteration(data, 2, start=np.array([1, 1, 1]))
    result3 = power_iteration(data, 2, start=np.array([1, 1]))

    assert_array_almost_equal(result1, expected, decimal=4)
    assert_array_almost_equal(result2, expected, decimal=4)
    assert_array_almost_equal(result3, expected, decimal=4)

def test_power_iteration_convergence():
    # Simple 2x2 matrix with known eigenvalues [2, 1] and eigenvector [1, 1]/√2
    simple_data = np.array([[1.5, 0.5],
                           [0.5, 1.5]])
    start_vec = np.array([1, 0])
    result = power_iteration(simple_data, 100, start_vec)
    
    # Test convergence to correct eigenvector
    expected = np.array([0.7071, 0.7071])
    assert_array_almost_equal(result, expected, decimal=3)
    
    # Test if result is actually an eigenvector
    applied = np.dot(simple_data, result)
    lambda_val = applied[0] / result[0]
    scaled = result * lambda_val
    assert_array_almost_equal(applied, scaled, decimal=3)

def test_power_iteration_max_iterations():
    slow_data = np.array([[1.1, 1.0],
                         [0.0, 1.0]])
    start_vec = np.array([0, 1])
    
    result1 = power_iteration(slow_data, 1, start_vec)
    result3 = power_iteration(slow_data, 3, start_vec)
    
    # Test normalization
    assert_array_almost_equal(np.linalg.norm(result1), 1.0, decimal=6)
    assert_array_almost_equal(np.linalg.norm(result3), 1.0, decimal=6)
    
    # Results should be different (still converging)
    assert any(abs(x - y) > 0.01 for x, y in zip(result1, result3))

def test_power_iteration_continue_case():
    """Test that power iteration continues when neither termination condition is met"""
    slow_data = np.array([[1.01, 1.0],
                         [0.0, 1.0]])
    result = power_iteration(slow_data, 2, np.array([0, 1]))
    assert not np.array_equal(result, np.array([0, 1])), "Vector should change after iterations"
    assert_array_almost_equal(np.linalg.norm(result), 1.0, err_msg="Result should be normalized")

def test_power_iteration_zero_iterations():
    """Test that zero iterations returns normalized start vector"""
    rotation_data = np.array([[0, -1],
                            [1, 0]])
    result = power_iteration(rotation_data, 0, np.array([1, 1]))
    assert_array_almost_equal(result, np.array([0.7071067811865475, 0.7071067811865475]), decimal=3,
                            err_msg="Should return normalized start vector [1/√2, 1/√2]")

def test_power_iteration_eigenvalue_match_termination():
    """Test early termination when eigenvalue matches"""
    identity_data = np.array([[1, 0],
                            [0, 1]])
    result1 = power_iteration(identity_data, 10, np.array([1, 0]))
    result2 = power_iteration(identity_data, 1, np.array([1, 0]))
    assert_array_almost_equal(result1, np.array([1, 0]), 
                            err_msg="Should converge to eigenvector [1, 0]")
    assert_array_almost_equal(result1, result2,
                            err_msg="Should terminate early giving same result")

def test_power_iteration_convergence_progression():
    """Test convergence behavior over different iteration counts"""
    diag_data = np.array([[2, 0],
                         [0, 1]])
    start_vec = np.array([1, 1])
    result1 = power_iteration(diag_data, 10, start_vec)
    result2 = power_iteration(diag_data, 1, start_vec)
    result3 = power_iteration(diag_data, 2, start_vec)

    assert_array_almost_equal(result1, np.array([1, 0]), decimal=6,
                            err_msg="Should fully converge after 10 iterations")
    assert_array_almost_equal(result2, np.array([0.998, 0.062]), decimal=3,
                            err_msg="Should partially converge after 1 iteration")
    assert_array_almost_equal(result3, np.array([0.9999, 0.0156]), decimal=3,
                            err_msg="Should converge more after 2 iterations")

def test_power_iteration_zero_matrix():
    """Test behavior with zero matrix input"""
    zero_data = np.array([[0, 0],
                         [0, 0]])
    result = power_iteration(zero_data, 10, np.array([1, 1]))
    assert_array_almost_equal(result, np.array([0, 0]), decimal=3,
                            err_msg="Zero matrix should give zero vector result")

def test_power_iteration_zero_matrices():
    data = np.array([[1, -1, 0],
                     [1, -1, 0],
                     [1, -1, 0]])
    # Test that power-iteration returns a zero vector for this degenerate case
    result = power_iteration(data, 2)
    assert_array_almost_equal(result, np.array([0, 0, 0]))

def test_wrapped_pca_shapes():
    # Test different matrix shapes
    assert wrapped_pca(np.array([[1]]), 2)
    assert wrapped_pca(np.array([[1, 0]]), 2)
    assert wrapped_pca(np.array([[1], [0]]), 2)
    assert wrapped_pca(np.array([[1, 0], [-1, 1]]), 2)

def test_wrapped_pca_zero_matrices():
    data = np.array([[1, -1, 0],
                     [1, -1, 0],
                     [1, -1, 0]])
    # need to test not only that we get something sensible here, 
    # but also that if 0 vectors are returned,
    # that our wrapped-pca still be able to start up again
    result = wrapped_pca(data, 2)

    assert_array_almost_equal(result['comps'][0], np.array([0, 0, 0]))
    assert_array_almost_equal(result['comps'][1], np.array([0, 0, 0]))

def test_wrapped_pca_zero_start_vectors():
    data = np.array([[1, 0, 0],
                     [0, -1, 1],
                     [1, 1, 0]])
    zero_vec = np.array([0, 0, 0])
    zero_vecs = [zero_vec, zero_vec]
    
    result = wrapped_pca(data, 2, start_vectors=zero_vecs)
    assert not np.array_equal(result['comps'][0], zero_vec)
    assert not np.array_equal(result['comps'][1], zero_vec)

def test_wrapped_pca_single_row():
    # Single row matrix
    data = np.array([[1, 2, 3, 4]])
    result = wrapped_pca(data, 2)
    assert_array_almost_equal(result['center'], data[0])

def test_wrapped_pca_single_column():
    # Single column matrix
    data = np.array([[1], [2], [3], [4]])
    result = wrapped_pca(data, 2)
    assert_array_almost_equal(result['center'], np.array([2.5]))
    assert_array_almost_equal(result['comps'], np.array([[1]]))

def test_wrapped_pca_vs_sklearn():
    # Use same test data as in test_power_iteration_basic
    data = np.array([
        [1, 0, 0],
        [-1, 1, 0.1],
        [0, 1, 0.1],
        [0, 1, -0.1]
    ])

    # Get results from our implementation
    our_pca = wrapped_pca(data, 2)
    our_components = np.array(our_pca['comps'])

    # Get results from sklearn
    sklearn_pca = PCA(n_components=2)
    sklearn_pca.fit(data)
    sklearn_components = sklearn_pca.components_

    # For each component, ensure they point in the same direction
    # (multiply by -1 if they point in opposite directions)
    for i in range(2):
        if np.dot(our_components[i], sklearn_components[i]) < 0:
            sklearn_components[i] = -sklearn_components[i]

    # Compare components with some tolerance
    assert_array_almost_equal(our_components, sklearn_components, decimal=4)

    # Also verify that the center was correctly computed
    assert_array_almost_equal(
        our_pca['center'],
        np.mean(data, axis=0),
        decimal=4)