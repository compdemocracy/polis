import numpy as np
from sklearn.decomposition import PCA

def test_single_row_pca():
    # Test data: single row matrix
    X = np.array([[1, 2, 3, 4]])
    
    # Fit PCA with 2 components
    pca = PCA(n_components=1)
    _ = pca.fit_transform(X)
    
    # Get the center (mean) that PCA subtracted
    center = pca.mean_
    expected_center = np.array([1, 2, 3, 4])
    
    # Test assertions on the center
    np.testing.assert_array_almost_equal(center, expected_center)
    
    # No point in checking the components, they do not mean anything with a single sample

def test_single_column_pca():
    # Test data: single column matrix
    X = np.array([[1], [2], [3], [4]])
    
    # Fit PCA with 1 component (since we only have 1 dimension)
    pca = PCA(n_components=1)
    X_transformed = pca.fit_transform(X)
    
    # Get the center (mean) that PCA subtracted
    center = pca.mean_
    expected_center = np.array([2.5])  # mean of [1,2,3,4]
    
    # Get the principal components (eigenvector)
    components = pca.components_
    # For a single column, the component should just be [1.0]
    expected_component = np.array([1.0])
    
    # The transformed data should be the centered data
    expected_transformed = np.array([[-1.5], [-0.5], [0.5], [1.5]])
    
    # Test assertions
    np.testing.assert_array_almost_equal(center, expected_center)
    np.testing.assert_array_almost_equal(components[0], expected_component)
    np.testing.assert_array_almost_equal(X_transformed, expected_transformed)
    
    # Verify that component explains all variance
    assert abs(pca.explained_variance_ratio_[0] - 1.0) < 1e-7 