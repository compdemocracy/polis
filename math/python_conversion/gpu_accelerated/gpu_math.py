"""
GPU-accelerated implementation of Pol.is math algorithms.
This module uses cupy for NVIDIA GPUs and can fall back to PyTorch for Apple Metal.
"""

import os
import time
import numpy as np
import pandas as pd
import warnings

# Try importing cupy first (NVIDIA GPUs)
try:
    import cupy as cp
    HAS_CUPY = True
    BACKEND = "cupy"
    xp = cp  # Math library to use (cp for cupy)
    print("Using cupy as GPU backend")
except ImportError:
    HAS_CUPY = False
    BACKEND = None

# If cupy fails, try PyTorch (works with Apple Metal too)
if not HAS_CUPY:
    try:
        import torch
        HAS_TORCH = True
        BACKEND = "torch"
        print("Using PyTorch as GPU backend")
        
        # Function to convert numpy to torch tensor on GPU
        def to_device(arr):
            if isinstance(arr, np.ndarray):
                # Convert to float32 for MPS compatibility (Apple Silicon doesn't support float64)
                arr_float32 = arr.astype(np.float32) if arr.dtype == np.float64 else arr
                return torch.from_numpy(arr_float32).to('cuda' if torch.cuda.is_available() else 'mps')
            return arr
        
        # Function to convert torch tensor to numpy
        def to_numpy(tensor):
            if isinstance(tensor, torch.Tensor):
                return tensor.cpu().numpy()
            return tensor
    except ImportError:
        HAS_TORCH = False
        BACKEND = None
        warnings.warn("Neither cupy nor PyTorch found. Falling back to CPU with numpy.")
        xp = np  # Use numpy as fallback

def has_gpu():
    """Check if a GPU is available and configured."""
    if HAS_CUPY:
        try:
            cp.cuda.runtime.getDeviceCount()
            return True
        except:
            return False
    elif HAS_TORCH:
        return torch.cuda.is_available() or hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()
    return False

def get_device_info():
    """Get information about the available GPU devices."""
    info = {"backend": BACKEND}
    
    if HAS_CUPY:
        try:
            num_devices = cp.cuda.runtime.getDeviceCount()
            devices = []
            for i in range(num_devices):
                device = cp.cuda.runtime.getDeviceProperties(i)
                devices.append({
                    "id": i,
                    "name": device.get("name", "Unknown"),
                    "total_memory": device.get("totalGlobalMem", 0) / (1024**3),  # GB
                    "compute_capability": f"{device.get('major', 0)}.{device.get('minor', 0)}"
                })
            info["devices"] = devices
        except:
            info["devices"] = "Error retrieving device information"
    
    elif HAS_TORCH:
        if torch.cuda.is_available():
            devices = []
            for i in range(torch.cuda.device_count()):
                devices.append({
                    "id": i,
                    "name": torch.cuda.get_device_name(i),
                    "total_memory": torch.cuda.get_device_properties(i).total_memory / (1024**3),  # GB
                    "compute_capability": f"{torch.cuda.get_device_capability(i)[0]}.{torch.cuda.get_device_capability(i)[1]}"
                })
            info["devices"] = devices
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            info["devices"] = [{"name": "Apple MPS (Metal Performance Shaders)"}]
    
    return info

def to_gpu(arr):
    """Transfer a numpy array to GPU memory."""
    if arr is None:
        return None
        
    if HAS_CUPY:
        if isinstance(arr, np.ndarray):
            return cp.array(arr)
        return arr
    elif HAS_TORCH:
        return to_device(arr)
    return arr  # Fallback to CPU

def to_cpu(arr):
    """Transfer a GPU array back to CPU memory."""
    if arr is None:
        return None
        
    if HAS_CUPY:
        if isinstance(arr, cp.ndarray):
            return cp.asnumpy(arr)
        return arr
    elif HAS_TORCH:
        return to_numpy(arr)
    return arr  # Already on CPU

# GPU-accelerated PCA implementation
class GPUPCA:
    def __init__(self, n_components=2, max_iter=500, tol=1e-6, seed=42):
        """GPU-accelerated PCA implementation using power iteration.
        
        Args:
            n_components: Number of principal components to compute
            max_iter: Maximum iterations for power iteration
            tol: Convergence tolerance
            seed: Random seed for reproducibility
        """
        self.n_components = n_components
        self.max_iter = max_iter
        self.tol = tol
        self.seed = seed
        self.components_ = None
        self.center_ = None
        self.explained_variance_ = None
        
    def fit(self, X):
        """Fit the PCA model to the data.
        
        Args:
            X: Input data matrix
        
        Returns:
            Self
        """
        # Validate input
        if X is None or X.size == 0:
            raise ValueError("Empty input matrix")
            
        # Transfer data to GPU if needed
        X_gpu = to_gpu(X)
        
        start_time = time.time()
        
        if HAS_CUPY:
            # Compute center (mean of each column)
            self.center_ = cp.nanmean(X_gpu, axis=0)
            
            # Center the data
            X_centered = X_gpu - self.center_
            
            # Replace NaN with 0
            X_centered = cp.nan_to_num(X_centered, nan=0.0)
            
            # Compute components using power iteration
            components = []
            explained_variance = []
            
            # Set random seed
            cp.random.seed(self.seed)
            
            for i in range(self.n_components):
                # Initialize random vector
                vec = cp.random.randn(X_centered.shape[1])
                vec = vec / cp.linalg.norm(vec)
                
                # Power iteration
                for j in range(self.max_iter):
                    prev_vec = vec.copy()
                    
                    # Compute X^T * X * vec
                    Xv = cp.dot(X_centered, vec)
                    vec = cp.dot(X_centered.T, Xv)
                    
                    # Normalize
                    norm = cp.linalg.norm(vec)
                    if norm < self.tol:
                        break
                    vec = vec / norm
                    
                    # Check convergence
                    if cp.abs(cp.abs(cp.dot(vec, prev_vec)) - 1.0) < self.tol:
                        break
                
                # Deflate matrix
                if i < self.n_components - 1:
                    X_proj = cp.outer(cp.dot(X_centered, vec), vec)
                    X_centered = X_centered - X_proj
                
                # Store component and explained variance
                components.append(vec)
                var = cp.dot(vec, cp.dot(cp.dot(X_gpu.T, X_gpu), vec))
                explained_variance.append(var)
            
            # Stack components
            self.components_ = cp.vstack(components)
            self.explained_variance_ = cp.array(explained_variance)
            
        elif HAS_TORCH:
            # Compute using PyTorch
            X_gpu = to_device(X)
            
            # Compute center (mean of each column)
            self.center_ = torch.nanmean(X_gpu, dim=0)
            
            # Center the data
            X_centered = X_gpu - self.center_
            
            # Replace NaN with 0
            X_centered = torch.nan_to_num(X_centered, nan=0.0)
            
            # Compute components using power iteration
            components = []
            explained_variance = []
            
            # Set random seed
            torch.manual_seed(self.seed)
            
            for i in range(self.n_components):
                # Initialize random vector
                vec = torch.randn(X_centered.shape[1], device=X_gpu.device)
                vec = vec / torch.linalg.norm(vec)
                
                # Power iteration
                for j in range(self.max_iter):
                    prev_vec = vec.clone()
                    
                    # Compute X^T * X * vec
                    Xv = torch.mv(X_centered, vec)
                    vec = torch.mv(X_centered.T, Xv)
                    
                    # Normalize
                    norm = torch.linalg.norm(vec)
                    if norm < self.tol:
                        break
                    vec = vec / norm
                    
                    # Check convergence
                    if torch.abs(torch.abs(torch.dot(vec, prev_vec)) - 1.0) < self.tol:
                        break
                
                # Deflate matrix
                if i < self.n_components - 1:
                    X_proj = torch.outer(torch.mv(X_centered, vec), vec)
                    X_centered = X_centered - X_proj
                
                # Store component and explained variance
                components.append(vec)
                X_gpu_T = X_gpu.T
                var = torch.dot(vec, torch.mv(torch.mm(X_gpu_T, X_gpu), vec))
                explained_variance.append(var)
            
            # Stack components
            self.components_ = torch.stack(components)
            self.explained_variance_ = torch.tensor(explained_variance, device=X_gpu.device)
        
        else:
            # Fallback to numpy
            from sklearn.decomposition import PCA
            pca = PCA(n_components=self.n_components, random_state=self.seed)
            pca.fit(X)
            self.components_ = pca.components_
            self.center_ = pca.mean_
            self.explained_variance_ = pca.explained_variance_
        
        print(f"PCA completed in {time.time() - start_time:.2f} seconds")
        return self
        
    def transform(self, X):
        """Transform data into the PCA space.
        
        Args:
            X: Input data matrix
        
        Returns:
            Transformed data
        """
        if self.components_ is None:
            raise ValueError("PCA model not fitted")
            
        # Transfer data to GPU if needed
        X_gpu = to_gpu(X)
        center_gpu = to_gpu(self.center_)
        components_gpu = to_gpu(self.components_)
        
        # Center the data
        X_centered = X_gpu - center_gpu
        
        # Replace NaN with 0
        if HAS_CUPY:
            X_centered = cp.nan_to_num(X_centered, nan=0.0)
            # Project data
            X_transformed = cp.dot(X_centered, components_gpu.T)
        elif HAS_TORCH:
            X_centered = torch.nan_to_num(X_centered, nan=0.0)
            # Project data
            X_transformed = torch.mm(X_centered, components_gpu.T)
        else:
            X_centered = np.nan_to_num(X_centered, nan=0.0)
            # Project data
            X_transformed = np.dot(X_centered, components_gpu.T)
        
        return X_transformed
        
    def fit_transform(self, X):
        """Fit the model and transform the data.
        
        Args:
            X: Input data matrix
        
        Returns:
            Transformed data
        """
        self.fit(X)
        return self.transform(X)

# GPU-accelerated K-means clustering
class GPUKMeans:
    def __init__(self, n_clusters=3, max_iter=300, tol=1e-4, seed=42):
        """GPU-accelerated K-means clustering.
        
        Args:
            n_clusters: Number of clusters
            max_iter: Maximum iterations
            tol: Convergence tolerance
            seed: Random seed for reproducibility
        """
        self.n_clusters = n_clusters
        self.max_iter = max_iter
        self.tol = tol
        self.seed = seed
        self.cluster_centers_ = None
        self.labels_ = None
        self.inertia_ = None
        
    def _init_centroids(self, X):
        """Initialize centroids using k-means++ algorithm."""
        n_samples = X.shape[0]
        
        if HAS_CUPY:
            cp.random.seed(self.seed)
            
            # Choose first centroid randomly
            first_idx = cp.random.choice(n_samples)
            centroids = [X[first_idx]]
            
            for _ in range(1, self.n_clusters):
                # Compute distances to closest centroid for each point
                dists = cp.full(n_samples, cp.inf)
                
                for centroid in centroids:
                    # Compute squared distances
                    new_dists = cp.sum((X - centroid)**2, axis=1)
                    # Keep minimum distance
                    dists = cp.minimum(dists, new_dists)
                
                # Choose next centroid with probability proportional to squared distance
                if cp.sum(dists) > 0:
                    probs = dists / cp.sum(dists)
                    next_idx = cp.random.choice(n_samples, p=probs)
                else:
                    # If all distances are zero, choose randomly
                    next_idx = cp.random.choice(n_samples)
                    
                centroids.append(X[next_idx])
                
            return cp.array(centroids)
            
        elif HAS_TORCH:
            torch.manual_seed(self.seed)
            device = X.device
            
            # Choose first centroid randomly
            first_idx = torch.randint(0, n_samples, (1,), device=device)
            centroids = [X[first_idx].squeeze()]
            
            for _ in range(1, self.n_clusters):
                # Compute distances to closest centroid for each point
                dists = torch.full((n_samples,), float('inf'), device=device)
                
                for centroid in centroids:
                    # Compute squared distances
                    new_dists = torch.sum((X - centroid)**2, dim=1)
                    # Keep minimum distance
                    dists = torch.minimum(dists, new_dists)
                
                # Choose next centroid with probability proportional to squared distance
                sum_dists = torch.sum(dists)
                if sum_dists > 0:
                    probs = dists / sum_dists
                    next_idx = torch.multinomial(probs, 1)
                else:
                    # If all distances are zero, choose randomly
                    next_idx = torch.randint(0, n_samples, (1,), device=device)
                    
                centroids.append(X[next_idx].squeeze())
                
            return torch.stack(centroids)
        
        else:
            # Fallback to numpy
            np.random.seed(self.seed)
            
            # Choose first centroid randomly
            first_idx = np.random.choice(n_samples)
            centroids = [X[first_idx]]
            
            for _ in range(1, self.n_clusters):
                # Compute distances to closest centroid for each point
                dists = np.full(n_samples, np.inf)
                
                for centroid in centroids:
                    # Compute squared distances
                    new_dists = np.sum((X - centroid)**2, axis=1)
                    # Keep minimum distance
                    dists = np.minimum(dists, new_dists)
                
                # Choose next centroid with probability proportional to squared distance
                sum_dists = np.sum(dists)
                if sum_dists > 0:
                    probs = dists / sum_dists
                    next_idx = np.random.choice(n_samples, p=probs)
                else:
                    # If all distances are zero, choose randomly
                    next_idx = np.random.choice(n_samples)
                    
                centroids.append(X[next_idx])
                
            return np.array(centroids)
    
    def fit(self, X, sample_weight=None):
        """Fit the K-means model to the data.
        
        Args:
            X: Input data matrix
            sample_weight: Optional sample weights
        
        Returns:
            Self
        """
        if X.shape[0] < self.n_clusters:
            raise ValueError(f"n_samples={X.shape[0]} should be >= n_clusters={self.n_clusters}")
            
        start_time = time.time()
        
        # Transfer data to GPU if needed
        X_gpu = to_gpu(X)
        if sample_weight is not None:
            sample_weight = to_gpu(sample_weight)
        
        if HAS_CUPY:
            # Initialize centroids
            centroids = self._init_centroids(X_gpu)
            
            for iteration in range(self.max_iter):
                # Compute distances to centroids
                distances = cp.zeros((X_gpu.shape[0], self.n_clusters))
                for i, centroid in enumerate(centroids):
                    sq_diff = (X_gpu - centroid) ** 2
                    distances[:, i] = cp.sum(sq_diff, axis=1)
                
                # Assign points to closest centroid
                labels = cp.argmin(distances, axis=1)
                
                # Update centroids
                new_centroids = cp.zeros_like(centroids)
                
                for i in range(self.n_clusters):
                    mask = (labels == i)
                    if cp.any(mask):
                        if sample_weight is not None:
                            # Weighted average
                            weights = sample_weight[mask]
                            new_centroids[i] = cp.average(X_gpu[mask], axis=0, weights=weights)
                        else:
                            new_centroids[i] = cp.mean(X_gpu[mask], axis=0)
                    else:
                        # Handle empty clusters
                        new_centroids[i] = centroids[i]
                
                # Check convergence
                if cp.mean(cp.sum((new_centroids - centroids) ** 2, axis=1)) < self.tol:
                    break
                    
                centroids = new_centroids
            
            # Compute final labels and inertia
            distances = cp.zeros((X_gpu.shape[0], self.n_clusters))
            for i, centroid in enumerate(centroids):
                sq_diff = (X_gpu - centroid) ** 2
                distances[:, i] = cp.sum(sq_diff, axis=1)
                
            labels = cp.argmin(distances, axis=1)
            
            # Compute inertia (sum of squared distances to closest centroid)
            inertia = 0
            for i in range(self.n_clusters):
                mask = (labels == i)
                if cp.any(mask):
                    cluster_dists = cp.sum((X_gpu[mask] - centroids[i]) ** 2, axis=1)
                    if sample_weight is not None:
                        inertia += cp.sum(cluster_dists * sample_weight[mask])
                    else:
                        inertia += cp.sum(cluster_dists)
            
            self.cluster_centers_ = to_cpu(centroids)
            self.labels_ = to_cpu(labels)
            self.inertia_ = float(to_cpu(inertia))
            
        elif HAS_TORCH:
            # Initialize centroids
            centroids = self._init_centroids(X_gpu)
            
            for iteration in range(self.max_iter):
                # Compute distances to centroids
                distances = torch.zeros((X_gpu.shape[0], self.n_clusters), device=X_gpu.device)
                for i, centroid in enumerate(centroids):
                    sq_diff = (X_gpu - centroid) ** 2
                    distances[:, i] = torch.sum(sq_diff, dim=1)
                
                # Assign points to closest centroid
                labels = torch.argmin(distances, dim=1)
                
                # Update centroids
                new_centroids = torch.zeros_like(centroids)
                
                for i in range(self.n_clusters):
                    mask = (labels == i)
                    if torch.any(mask):
                        if sample_weight is not None:
                            # Weighted average
                            weights = sample_weight[mask]
                            new_centroids[i] = torch.sum(X_gpu[mask] * weights.unsqueeze(1), dim=0) / torch.sum(weights)
                        else:
                            new_centroids[i] = torch.mean(X_gpu[mask], dim=0)
                    else:
                        # Handle empty clusters
                        new_centroids[i] = centroids[i]
                
                # Check convergence
                if torch.mean(torch.sum((new_centroids - centroids) ** 2, dim=1)) < self.tol:
                    break
                    
                centroids = new_centroids
            
            # Compute final labels and inertia
            distances = torch.zeros((X_gpu.shape[0], self.n_clusters), device=X_gpu.device)
            for i, centroid in enumerate(centroids):
                sq_diff = (X_gpu - centroid) ** 2
                distances[:, i] = torch.sum(sq_diff, dim=1)
                
            labels = torch.argmin(distances, dim=1)
            
            # Compute inertia (sum of squared distances to closest centroid)
            inertia = 0
            for i in range(self.n_clusters):
                mask = (labels == i)
                if torch.any(mask):
                    cluster_dists = torch.sum((X_gpu[mask] - centroids[i]) ** 2, dim=1)
                    if sample_weight is not None:
                        inertia += torch.sum(cluster_dists * sample_weight[mask])
                    else:
                        inertia += torch.sum(cluster_dists)
            
            self.cluster_centers_ = to_cpu(centroids)
            self.labels_ = to_cpu(labels)
            self.inertia_ = float(to_cpu(inertia))
            
        else:
            # Fallback to numpy
            from sklearn.cluster import KMeans
            kmeans = KMeans(
                n_clusters=self.n_clusters,
                max_iter=self.max_iter,
                tol=self.tol,
                random_state=self.seed
            )
            kmeans.fit(X, sample_weight=sample_weight)
            self.cluster_centers_ = kmeans.cluster_centers_
            self.labels_ = kmeans.labels_
            self.inertia_ = kmeans.inertia_
        
        print(f"K-means completed in {time.time() - start_time:.2f} seconds")
        return self
        
    def predict(self, X):
        """Predict the closest cluster for new data.
        
        Args:
            X: Input data matrix
        
        Returns:
            Predicted cluster indices
        """
        if self.cluster_centers_ is None:
            raise ValueError("K-means model not fitted")
            
        # Transfer data to GPU if needed
        X_gpu = to_gpu(X)
        centroids = to_gpu(self.cluster_centers_)
        
        if HAS_CUPY:
            # Compute distances to centroids
            distances = cp.zeros((X_gpu.shape[0], self.n_clusters))
            for i, centroid in enumerate(centroids):
                sq_diff = (X_gpu - centroid) ** 2
                distances[:, i] = cp.sum(sq_diff, axis=1)
                
            # Assign points to closest centroid
            labels = cp.argmin(distances, axis=1)
            return to_cpu(labels)
            
        elif HAS_TORCH:
            # Compute distances to centroids
            distances = torch.zeros((X_gpu.shape[0], self.n_clusters), device=X_gpu.device)
            for i, centroid in enumerate(centroids):
                sq_diff = (X_gpu - centroid) ** 2
                distances[:, i] = torch.sum(sq_diff, dim=1)
                
            # Assign points to closest centroid
            labels = torch.argmin(distances, dim=1)
            return to_cpu(labels)
            
        else:
            # Compute distances to centroids
            distances = np.zeros((X.shape[0], self.n_clusters))
            for i, centroid in enumerate(self.cluster_centers_):
                sq_diff = (X - centroid) ** 2
                distances[:, i] = np.sum(sq_diff, axis=1)
                
            # Assign points to closest centroid
            labels = np.argmin(distances, axis=1)
            return labels

    def fit_predict(self, X, sample_weight=None):
        """Fit the model and predict the closest cluster for each sample.
        
        Args:
            X: Input data matrix
            sample_weight: Optional sample weights
            
        Returns:
            Predicted cluster indices
        """
        self.fit(X, sample_weight=sample_weight)
        return self.labels_

# Correlation matrix calculation
def gpu_correlation_matrix(X, handle_nan=True):
    """Compute correlation matrix on GPU.
    
    Args:
        X: Input data matrix
        handle_nan: Whether to handle NaN values
        
    Returns:
        Correlation matrix
    """
    # Transfer data to GPU if needed
    X_gpu = to_gpu(X)
    
    if HAS_CUPY:
        if handle_nan:
            # Handle NaN values by replacing with 0
            X_clean = cp.nan_to_num(X_gpu, nan=0.0)
            
            # Compute column means
            col_means = cp.nanmean(X_gpu, axis=0)
            
            # Center the data
            X_centered = X_clean - col_means
            
            # Compute standard deviations
            col_stds = cp.sqrt(cp.nanmean(X_gpu**2, axis=0) - col_means**2)
            col_stds[col_stds < 1e-10] = 1.0  # Avoid division by zero
            
            # Compute correlation matrix
            corr = cp.dot(X_centered.T, X_centered) / (X_gpu.shape[0] - 1)
            corr /= col_stds[:, None]
            corr /= col_stds[None, :]
        else:
            # Use built-in corrcoef
            corr = cp.corrcoef(X_gpu, rowvar=False)
            
        return to_cpu(corr)
        
    elif HAS_TORCH:
        X_gpu = to_device(X)
        
        if handle_nan:
            # Handle NaN values by replacing with 0
            X_clean = torch.nan_to_num(X_gpu, nan=0.0)
            
            # Compute column means
            col_means = torch.nanmean(X_gpu, dim=0)
            
            # Center the data
            X_centered = X_clean - col_means
            
            # Compute standard deviations
            col_stds = torch.sqrt(torch.nanmean(X_gpu**2, dim=0) - col_means**2)
            col_stds[col_stds < 1e-10] = 1.0  # Avoid division by zero
            
            # Compute correlation matrix
            corr = torch.mm(X_centered.T, X_centered) / (X_gpu.shape[0] - 1)
            corr /= col_stds.unsqueeze(1)
            corr /= col_stds.unsqueeze(0)
        else:
            # Compute correlation manually
            X_centered = X_gpu - torch.mean(X_gpu, dim=0)
            corr = torch.mm(X_centered.T, X_centered) / (X_gpu.shape[0] - 1)
            col_stds = torch.std(X_gpu, dim=0)
            col_stds[col_stds < 1e-10] = 1.0  # Avoid division by zero
            corr /= col_stds.unsqueeze(1)
            corr /= col_stds.unsqueeze(0)
            
        return to_cpu(corr)
        
    else:
        # Fallback to numpy
        if handle_nan:
            # Handle NaN values
            X_clean = np.nan_to_num(X, nan=0.0)
            
            # Compute column means
            col_means = np.nanmean(X, axis=0)
            
            # Center the data
            X_centered = X_clean - col_means
            
            # Compute standard deviations
            col_stds = np.sqrt(np.nanmean(X**2, axis=0) - col_means**2)
            col_stds[col_stds < 1e-10] = 1.0  # Avoid division by zero
            
            # Compute correlation matrix
            corr = np.dot(X_centered.T, X_centered) / (X.shape[0] - 1)
            corr /= col_stds[:, None]
            corr /= col_stds[None, :]
        else:
            # Use built-in corrcoef
            corr = np.corrcoef(X, rowvar=False)
            
        return corr

# Batch processing for large matrices
def process_in_batches(X, batch_size=1000, func=None):
    """Process large matrices in batches to avoid memory issues.
    
    Args:
        X: Input data matrix
        batch_size: Size of each batch
        func: Function to apply to each batch
        
    Returns:
        Processed data
    """
    if func is None:
        raise ValueError("Processing function must be specified")
        
    n_samples = X.shape[0]
    results = []
    
    for i in range(0, n_samples, batch_size):
        end = min(i + batch_size, n_samples)
        batch = X[i:end]
        result = func(batch)
        results.append(result)
    
    # Combine results (depends on the function)
    if isinstance(results[0], np.ndarray) or (HAS_CUPY and isinstance(results[0], cp.ndarray)) or (HAS_TORCH and isinstance(results[0], torch.Tensor)):
        return np.vstack([to_cpu(r) for r in results])
    else:
        return results

# Full GPU-accelerated Pol.is math pipeline
class GPUPolisMath:
    def __init__(self, n_components=2, n_clusters=None, seed=42):
        """GPU-accelerated Pol.is math pipeline.
        
        Args:
            n_components: Number of PCA components
            n_clusters: Number of clusters (None for auto-determination)
            seed: Random seed for reproducibility
        """
        self.n_components = n_components
        self.n_clusters = n_clusters
        self.seed = seed
        self.pca = None
        self.kmeans = None
        self.centers = None
        
    def _auto_determine_clusters(self, n_samples):
        """Automatically determine number of clusters based on dataset size."""
        if n_samples < 100:
            return 2
        elif n_samples < 1000:
            return 3
        elif n_samples < 10000:
            return 4
        else:
            return 5
            
    def process(self, vote_matrix):
        """Process the vote matrix using the full pipeline.
        
        Args:
            vote_matrix: Input vote matrix
            
        Returns:
            Dictionary with PCA and clustering results
        """
        start_time = time.time()
        
        # Check for GPU
        if not has_gpu() and (HAS_CUPY or HAS_TORCH):
            warnings.warn("GPU backend detected, but no compatible GPU found. Falling back to CPU.")
        
        # Clean data
        clean_matrix = np.nan_to_num(vote_matrix, nan=0.0)
        
        # Auto-determine clusters if needed
        n_clusters = self.n_clusters
        if n_clusters is None:
            n_clusters = self._auto_determine_clusters(clean_matrix.shape[0])
            print(f"Auto-determined {n_clusters} clusters based on dataset size")
        
        # Perform PCA
        print("Running GPU-accelerated PCA...")
        pca_time = time.time()
        self.pca = GPUPCA(n_components=self.n_components, seed=self.seed)
        projections = self.pca.fit_transform(clean_matrix)
        print(f"PCA completed in {time.time() - pca_time:.2f} seconds")
        
        # Perform clustering
        print("Running GPU-accelerated clustering...")
        cluster_time = time.time()
        self.kmeans = GPUKMeans(n_clusters=n_clusters, seed=self.seed)
        labels = self.kmeans.fit_predict(to_cpu(projections))
        print(f"Clustering completed in {time.time() - cluster_time:.2f} seconds")
        
        # Organize results
        clusters = []
        for i in range(n_clusters):
            mask = (labels == i)
            members = np.where(mask)[0].tolist()
            if len(members) > 0:
                center = self.kmeans.cluster_centers_[i].tolist()
                clusters.append({
                    "id": i,
                    "center": center,
                    "members": members
                })
        
        # Prepare center and components for return
        components = to_cpu(self.pca.components_)
        center = to_cpu(self.pca.center_)
        
        # Prepare projections for return
        projections_cpu = to_cpu(projections)
        
        # Compute correlation matrix for comments (example of other processing)
        corr_time = time.time()
        correlation = gpu_correlation_matrix(clean_matrix)
        print(f"Correlation matrix computed in {time.time() - corr_time:.2f} seconds")
        
        print(f"Total GPU processing completed in {time.time() - start_time:.2f} seconds")
        
        return {
            "pca": {
                "center": center.tolist(),
                "components": components.tolist(),
                "explained_variance": to_cpu(self.pca.explained_variance_).tolist()
            },
            "projections": projections_cpu.tolist(),
            "clusters": clusters,
            "n_clusters": n_clusters,
            "correlation": correlation.tolist()
        }