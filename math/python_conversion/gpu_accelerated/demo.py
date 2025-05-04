#!/usr/bin/env python
"""
Simplified demo script for GPU-accelerated Pol.is math
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

def main():
    """Main function to demonstrate GPU acceleration."""
    print("GPU-Accelerated Pol.is Math Demonstration")
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
    
    # Create synthetic data
    print("\nCreating synthetic data...")
    n_samples = 1000
    n_features = 50
    data = create_synthetic_data(n_samples, n_features)
    print(f"Created dataset with {n_samples} participants and {n_features} comments")
    print(f"Data shape: {data.shape}")
    print(f"Non-NaN values: {np.sum(~np.isnan(data))}")
    print(f"Sparsity: {np.sum(np.isnan(data)) / data.size:.2%}")
    
    # Run the GPU pipeline
    print("\nRunning GPU-accelerated pipeline...")
    start_time = time.time()
    gpu_math = GPUPolisMath(n_components=2, seed=42)
    results = gpu_math.process(data)
    
    total_time = time.time() - start_time
    print(f"\nGPU processing completed in {total_time:.2f} seconds")
    
    # Print results summary
    print("\nResults summary:")
    print(f"Number of clusters: {len(results['clusters'])}")
    for i, cluster in enumerate(results['clusters']):
        print(f"  Cluster {i}: {len(cluster['members'])} participants")
    
    # Create visualization
    print("\nCreating visualization...")
    visualize_results(results)
    
    print("\nDemo completed successfully!")

def create_synthetic_data(n_samples, n_features):
    """Create synthetic vote data."""
    np.random.seed(42)
    # Create random votes (-1, 0, 1) as floating point to support NaN
    votes = np.random.choice([-1.0, 0.0, 1.0], size=(n_samples, n_features), p=[0.4, 0.2, 0.4])
    # Introduce sparsity (about 70% NaN)
    mask = np.random.random(size=votes.shape) < 0.7
    votes[mask] = np.nan
    return votes

def visualize_results(results):
    """Visualize the PCA projections and clusters."""
    projections = np.array(results['projections'])
    
    # Get cluster assignments
    labels = np.zeros(len(projections))
    for i, cluster in enumerate(results['clusters']):
        for member in cluster['members']:
            labels[member] = i
    
    # Create plot
    plt.figure(figsize=(10, 8))
    scatter = plt.scatter(projections[:, 0], projections[:, 1], c=labels, cmap='viridis', alpha=0.7, s=50)
    
    # Add cluster centers
    centers = np.array([cluster['center'] for cluster in results['clusters']])
    plt.scatter(centers[:, 0], centers[:, 1], c=range(len(centers)), marker='*', s=300, cmap='viridis', edgecolors='black', linewidths=1.5)
    
    # Add legend
    legend1 = plt.legend(*scatter.legend_elements(), title="Clusters")
    plt.gca().add_artist(legend1)
    
    plt.title('Participant Projections and Clusters')
    plt.xlabel('Principal Component 1')
    plt.ylabel('Principal Component 2')
    plt.grid(True, alpha=0.3)
    
    # Save the plot
    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    os.makedirs(output_dir, exist_ok=True)
    plt.savefig(os.path.join(output_dir, "projections.png"))
    print(f"Visualization saved to {os.path.join(output_dir, 'projections.png')}")
    
    # Show plot if in interactive mode
    if plt.isinteractive():
        plt.show()

if __name__ == "__main__":
    main()