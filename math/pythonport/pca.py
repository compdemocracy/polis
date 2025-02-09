import numpy as np

def power_iteration(data, iters=100, start=None):
    """
    Produces the first eigenvector of data using power iteration method.
    
    Args:
        data: numpy array of shape (n_samples, n_features)
        iters: maximum number of iterations (default: 100). Note: this
        will be incremented by 1 to reproduce the behavior of the
        clojure version, which goes through at least one iteration
        even if iters is 0.
        start: starting vector (default: None, will use vector of ones)
    
    Returns:
        normalized eigenvector
    """
    n_cols = data.shape[1]
    
    # Reproduce the behavior of the clojure version
    # whose main loop goes through at least one iteration even
    # if iters is 0.
    iters = iters + 1

    # Initialize start vector if not provided
    if start is None:
        start = np.ones(n_cols)
    
    # Extend start vector if needed (matching Clojure behavior)
    if len(start) < n_cols:
        start = np.concatenate([start, np.ones(n_cols - len(start))])
    
    last_eigval = 0
    curr_vector = start
    
    for _ in range(iters):
        # Compute X^T X v (equivalent to Clojure's xtxr)
        product_vector = data.T @ (data @ curr_vector)
        
        # Compute eigenvalue as length of product vector
        eigval = np.linalg.norm(product_vector)
        
        # Normalize the vector
        normed = product_vector / np.linalg.norm(product_vector)
        
        # Check convergence
        if eigval == last_eigval:
            break
            
        curr_vector = normed
        last_eigval = eigval
    
    return curr_vector

def powerit_pca(data, n_components, iters=100, start_vectors=None):
    """
    Find the first n_components principal components of the data matrix.
    
    Args:
        data: numpy array of shape (n_samples, n_features)
        n_components: number of components to compute
        iters: number of iterations for power iteration (default: 100)
        start_vectors: list of starting vectors (default: None)
    
    Returns:
        dict containing:
            'center': mean of the data
            'comps': array of principal components
    """
    # Center the data
    center = np.mean(data, axis=0)
    centered_data = data - center
    
    # Determine maximum possible components
    data_dim = min(centered_data.shape)
    n_components = min(n_components, data_dim)
    
    # Initialize components list
    components = []
    current_data = centered_data.copy()
    
    # Compute components one at a time
    for i in range(n_components):
        # Get start vector (either from provided list or random)
        start_vector = (start_vectors[i] if start_vectors is not None and i < len(start_vectors)
                       else np.random.rand(current_data.shape[1]))
        
        # Compute principal component
        pc = power_iteration(current_data, iters, start_vector)
        components.append(pc)
        
        # Factor out the computed component from the data
        if i < n_components - 1:  # No need to factor out on last iteration
            # Project data onto pc and subtract
            proj = np.outer(np.dot(current_data, pc), pc)
            if not np.allclose(np.dot(pc, pc), 0):  # Only factor if pc is not zero vector
                current_data = current_data - proj
    
    return {
        'center': center,
        'comps': np.array(components)
    }

def wrapped_pca(data, n_components, start_vectors=None, **kwargs):
    """
    Wrapper for powerit_pca that handles zero vectors in start_vectors.
    
    Args:
        data: numpy array of shape (n_samples, n_features)
        n_components: number of components to compute
        start_vectors: list of starting vectors (default: None)
        **kwargs: additional arguments passed to powerit_pca
    
    Returns:
        dict containing:
            'center': mean of the data
            'comps': array of principal components
    """
    if start_vectors is not None:
        # Replace zero vectors with None
        start_vectors = [None if np.allclose(v, 0) else v for v in start_vectors]
    
    return powerit_pca(data, n_components, start_vectors=start_vectors, **kwargs) 