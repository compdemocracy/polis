#!/usr/bin/env python
"""
Benchmark script to compare CPU and GPU implementations
"""

import os
import sys
import time
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import the GPU-accelerated math module
from gpu_accelerated.gpu_math import has_gpu, get_device_info, GPUPCA, GPUKMeans, GPUPolisMath

# Import the CPU implementation
from polismath.math.pca import powerit_pca
from polismath.math.clusters import kmeans

def create_synthetic_data(n_samples, n_features):
    """Create synthetic vote data."""
    np.random.seed(42)
    # Create random votes (-1, 0, 1) as floating point to support NaN
    votes = np.random.choice([-1.0, 0.0, 1.0], size=(n_samples, n_features), p=[0.4, 0.2, 0.4])
    # Introduce sparsity (about 70% NaN)
    mask = np.random.random(size=votes.shape) < 0.7
    votes[mask] = np.nan
    return votes

def run_cpu_implementation(vote_matrix, n_components=2, seed=42):
    """Run the CPU implementation and measure time."""
    start_time = time.time()
    
    # Clean data
    clean_matrix = np.nan_to_num(vote_matrix, nan=0.0)
    
    # Run PCA
    pca_start = time.time()
    pca_results = powerit_pca(clean_matrix, n_comps=n_components)
    pca_time = time.time() - pca_start
    print(f"CPU PCA completed in {pca_time:.2f} seconds")
    
    # Project data
    proj_start = time.time()
    center = pca_results["center"]
    comps = pca_results["comps"]
    centered = clean_matrix - center
    projections = np.dot(centered, comps.T)
    proj_time = time.time() - proj_start
    print(f"CPU Projection completed in {proj_time:.2f} seconds")
    
    # Auto-determine number of clusters
    n_samples = clean_matrix.shape[0]
    if n_samples < 100:
        n_clusters = 2
    elif n_samples < 1000:
        n_clusters = 3
    elif n_samples < 10000:
        n_clusters = 4
    else:
        n_clusters = 5
    print(f"Auto-determined {n_clusters} clusters based on dataset size")
    
    # Run clustering
    cluster_start = time.time()
    clusters = kmeans(projections, k=n_clusters)
    cluster_time = time.time() - cluster_start
    print(f"CPU Clustering completed in {cluster_time:.2f} seconds")
    
    # Calculate correlation matrix
    corr_start = time.time()
    correlation = np.corrcoef(clean_matrix, rowvar=False)
    corr_time = time.time() - corr_start
    print(f"CPU Correlation matrix completed in {corr_time:.2f} seconds")
    
    total_time = time.time() - start_time
    print(f"CPU implementation total time: {total_time:.2f} seconds")
    
    return {
        "pca": pca_results,
        "projections": projections,
        "clusters": clusters,
        "correlation": correlation,
        "timing": {
            "pca": pca_time,
            "projection": proj_time,
            "clustering": cluster_time,
            "correlation": corr_time,
            "total": total_time
        }
    }

def run_gpu_implementation(vote_matrix, n_components=2, seed=42):
    """Run the GPU implementation and measure time."""
    start_time = time.time()
    
    # Create GPU math pipeline
    gpu_math = GPUPolisMath(n_components=n_components, seed=seed)
    
    # Process data
    try:
        results = gpu_math.process(vote_matrix)
        # Add timing information
        total_time = time.time() - start_time
        print(f"GPU implementation total time: {total_time:.2f} seconds")
        
        return {
            "results": results,
            "timing": {
                "total": total_time
            }
        }
    except Exception as e:
        print(f"Error in GPU processing: {e}")
        return None

def benchmark_different_sizes():
    """Benchmark with different dataset sizes."""
    sizes = [500, 1000, 2000]  # Smaller range for demo
    cpu_times = []
    gpu_times = []
    
    for size in sizes:
        print(f"\n----- Testing with {size} participants -----")
        # Create dataset
        data = create_synthetic_data(size, 50)
        
        # Run CPU implementation
        print("\nRunning CPU implementation...")
        cpu_result = run_cpu_implementation(data)
        cpu_times.append(cpu_result["timing"]["total"])
        
        # Run GPU implementation
        print("\nRunning GPU implementation...")
        gpu_result = run_gpu_implementation(data)
        if gpu_result:
            gpu_times.append(gpu_result["timing"]["total"])
        else:
            gpu_times.append(None)
    
    # Create visualization
    plt.figure(figsize=(12, 8))
    
    valid_indices = [i for i, t in enumerate(gpu_times) if t is not None]
    valid_sizes = [sizes[i] for i in valid_indices]
    valid_cpu_times = [cpu_times[i] for i in valid_indices]
    valid_gpu_times = [gpu_times[i] for i in valid_indices]
    
    plt.plot(valid_sizes, valid_cpu_times, 'o-', label='CPU')
    plt.plot(valid_sizes, valid_gpu_times, 'o-', label='GPU')
    
    # Calculate speedup
    speedups = [cpu / gpu if gpu > 0 else 0 for cpu, gpu in zip(valid_cpu_times, valid_gpu_times)]
    
    # Add speedup text
    for i, (size, cpu_time, gpu_time) in enumerate(zip(valid_sizes, valid_cpu_times, valid_gpu_times)):
        plt.text(size, (cpu_time + gpu_time) / 2, f"{speedups[i]:.1f}x", 
                 horizontalalignment='center', verticalalignment='center',
                 bbox=dict(facecolor='white', alpha=0.8))
    
    plt.title('Performance Comparison: CPU vs GPU')
    plt.xlabel('Number of Participants')
    plt.ylabel('Execution Time (seconds)')
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    # Save figure
    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    os.makedirs(output_dir, exist_ok=True)
    plt.savefig(os.path.join(output_dir, "performance_comparison.png"))
    print(f"\nPerformance comparison saved to {os.path.join(output_dir, 'performance_comparison.png')}")

def main():
    """Main function to run benchmarks."""
    print("GPU vs CPU Performance Benchmark")
    print("=" * 50)
    
    # Check GPU availability
    print(f"GPU available: {has_gpu()}")
    device_info = get_device_info()
    print(f"Backend: {device_info['backend']}")
    print("\nDevice information:")
    if 'devices' in device_info and isinstance(device_info['devices'], list):
        for i, device in enumerate(device_info['devices']):
            print(f"Device {i}:")
            for key, value in device.items():
                print(f"  {key}: {value}")
    else:
        print(device_info.get('devices', 'No devices available'))
    
    # Run benchmarks
    benchmark_different_sizes()

if __name__ == "__main__":
    main()