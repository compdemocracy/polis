#!/usr/bin/env python
"""
Script to benchmark the bg2050 dataset using GPU vs CPU
"""

import os
import sys
import time
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import psutil

# Add parent directory to path to import the GPU module
sys.path.append('.')

# Import the GPU-accelerated math module
from gpu_accelerated.gpu_math import has_gpu, get_device_info, GPUPCA, GPUKMeans, GPUPolisMath

def memory_usage():
    """Get current memory usage in GB."""
    process = psutil.Process(os.getpid())
    return process.memory_info().rss / (1024**3)

def load_dataset(dataset_name="bg2050", subsample=None):
    """
    Load votes dataset with optional subsampling
    
    Args:
        dataset_name: Name of the dataset folder in real_data
        subsample: If provided, randomly sample this many participants
        
    Returns:
        vote_matrix, participant_ids, comment_ids
    """
    print(f"Loading dataset: {dataset_name}")
    start_time = time.time()
    
    # Define paths
    dataset_path = f"real_data/{dataset_name}"
    votes_path = os.path.join(dataset_path, "votes.csv")
    
    # Load data
    votes_df = pd.read_csv(votes_path)
    
    # Get unique IDs
    all_ptpt_ids = sorted(votes_df["voter-id"].unique())
    all_cmt_ids = sorted(votes_df["comment-id"].unique())
    
    # Subsample if requested
    if subsample is not None and subsample < len(all_ptpt_ids):
        np.random.seed(42)
        selected_ptpts = np.random.choice(all_ptpt_ids, subsample, replace=False)
        votes_df = votes_df[votes_df["voter-id"].isin(selected_ptpts)]
        ptpt_ids = sorted(votes_df["voter-id"].unique())
        cmt_ids = sorted(votes_df["comment-id"].unique())
    else:
        ptpt_ids = all_ptpt_ids
        cmt_ids = all_cmt_ids
    
    # Create mapping dictionaries
    ptpt_idx = {pid: i for i, pid in enumerate(ptpt_ids)}
    cmt_idx = {cid: i for i, cid in enumerate(cmt_ids)}
    
    # Create vote matrix
    n_ptpts = len(ptpt_ids)
    n_cmts = len(cmt_ids)
    vote_matrix = np.full((n_ptpts, n_cmts), np.nan)
    
    # Fill vote matrix
    for _, row in votes_df.iterrows():
        ptpt_id = row["voter-id"]
        cmt_id = row["comment-id"]
        vote = row["vote"]
        
        if ptpt_id in ptpt_idx and cmt_id in cmt_idx:
            vote_matrix[ptpt_idx[ptpt_id], cmt_idx[cmt_id]] = vote
    
    load_time = time.time() - start_time
    
    # Report on the loaded data
    n_votes = np.sum(~np.isnan(vote_matrix))
    sparsity = np.sum(np.isnan(vote_matrix)) / vote_matrix.size
    memory_used = memory_usage()
    
    print(f"Loaded {dataset_name} dataset with {n_ptpts} participants and {n_cmts} comments")
    print(f"Matrix shape: {vote_matrix.shape}")
    print(f"Non-NaN values: {n_votes}")
    print(f"Sparsity: {sparsity:.4f} ({sparsity*100:.2f}%)")
    print(f"Memory usage: {memory_used:.2f} GB")
    print(f"Loading time: {load_time:.2f} seconds")
    
    return vote_matrix, ptpt_ids, cmt_ids

def evaluate_scaling(dataset_name="bg2050"):
    """
    Evaluate how the algorithms scale with this dataset by testing subsamples
    """
    # Define subsample sizes to test
    subsample_sizes = [100, 500, 1000, 2000, 5000]
    
    # Find max possible subsample
    votes_path = os.path.join("real_data", dataset_name, "votes.csv")
    votes_df = pd.read_csv(votes_path)
    max_participants = votes_df["voter-id"].nunique()
    
    # Add max participants if it's smaller than the largest subsample size
    for size in subsample_sizes:
        if size > max_participants:
            subsample_sizes = [s for s in subsample_sizes if s <= max_participants]
            break
    
    # If we can, add the full dataset size
    if max_participants not in subsample_sizes:
        subsample_sizes.append(max_participants)
    
    # Prepare results storage
    results = {
        "sample_size": [],
        "matrix_shape": [],
        "gpu_available": has_gpu(),
        "backend": get_device_info()["backend"],
        "cpu_pca_time": [],
        "gpu_pca_time": [],
        "cpu_total_time": [],
        "gpu_total_time": [],
        "memory_usage": []
    }
    
    # Test each subsample size
    for size in subsample_sizes:
        print(f"\n{'='*50}")
        print(f"Testing with {size} participants")
        print(f"{'='*50}")
        
        # Load subsampled data
        try:
            vote_matrix, _, _ = load_dataset(dataset_name, subsample=size)
            results["sample_size"].append(size)
            results["matrix_shape"].append(vote_matrix.shape)
            results["memory_usage"].append(memory_usage())
        except Exception as e:
            print(f"Error loading data: {e}")
            continue
        
        # Clean data
        clean_matrix = np.nan_to_num(vote_matrix, nan=0.0)
        
        # Test CPU PCA
        print("\nRunning CPU PCA...")
        try:
            from sklearn.decomposition import PCA
            
            start_time = time.time()
            pca = PCA(n_components=2)
            projections_cpu = pca.fit_transform(clean_matrix)
            cpu_pca_time = time.time() - start_time
            
            print(f"CPU PCA completed in {cpu_pca_time:.2f} seconds")
            results["cpu_pca_time"].append(cpu_pca_time)
            
            # Test full CPU pipeline
            start_time = time.time()
            
            # Determine number of clusters
            n_samples = clean_matrix.shape[0]
            if n_samples < 100:
                n_clusters = 2
            elif n_samples < 1000:
                n_clusters = 3
            elif n_samples < 10000:
                n_clusters = 4
            else:
                n_clusters = 5
                
            from sklearn.cluster import KMeans
            kmeans = KMeans(n_clusters=n_clusters, random_state=42)
            labels_cpu = kmeans.fit_predict(projections_cpu)
            
            cpu_total_time = time.time() - start_time
            print(f"CPU pipeline completed in {cpu_total_time:.2f} seconds")
            results["cpu_total_time"].append(cpu_total_time)
            
        except Exception as e:
            print(f"Error with CPU implementation: {e}")
            results["cpu_pca_time"].append(None)
            results["cpu_total_time"].append(None)
        
        # Test GPU PCA
        if has_gpu():
            print("\nRunning GPU PCA...")
            try:
                start_time = time.time()
                gpu_pca = GPUPCA(n_components=2)
                projections_gpu = gpu_pca.fit_transform(clean_matrix)
                gpu_pca_time = time.time() - start_time
                
                print(f"GPU PCA completed in {gpu_pca_time:.2f} seconds")
                results["gpu_pca_time"].append(gpu_pca_time)
                
                # Test full GPU pipeline
                start_time = time.time()
                
                gpu_math = GPUPolisMath(n_components=2)
                try:
                    gpu_results = gpu_math.process(vote_matrix)
                    gpu_total_time = time.time() - start_time
                    print(f"GPU pipeline completed in {gpu_total_time:.2f} seconds")
                    results["gpu_total_time"].append(gpu_total_time)
                    
                    if cpu_total_time is not None and gpu_total_time is not None:
                        speedup = cpu_total_time / gpu_total_time
                        print(f"GPU speedup: {speedup:.2f}x")
                        
                except Exception as e:
                    print(f"Error in GPU pipeline: {e}")
                    results["gpu_total_time"].append(None)
                
            except Exception as e:
                print(f"Error with GPU implementation: {e}")
                results["gpu_pca_time"].append(None)
                if "gpu_total_time" in results and len(results["gpu_total_time"]) < len(results["sample_size"]):
                    results["gpu_total_time"].append(None)
        else:
            results["gpu_pca_time"].append(None)
            results["gpu_total_time"].append(None)
            print("GPU not available for testing")
    
    # Create visualizations
    plt.figure(figsize=(15, 10))
    
    # PCA time comparison
    plt.subplot(2, 2, 1)
    plt.plot(results["sample_size"], results["cpu_pca_time"], 'o-', label='CPU')
    if has_gpu():
        plt.plot(results["sample_size"], results["gpu_pca_time"], 'o-', label='GPU')
    plt.xlabel('Number of Participants')
    plt.ylabel('PCA Time (seconds)')
    plt.title('PCA Execution Time')
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    # Total time comparison
    plt.subplot(2, 2, 2)
    plt.plot(results["sample_size"], results["cpu_total_time"], 'o-', label='CPU')
    if has_gpu():
        plt.plot(results["sample_size"], results["gpu_total_time"], 'o-', label='GPU')
    plt.xlabel('Number of Participants')
    plt.ylabel('Total Time (seconds)')
    plt.title('Total Pipeline Execution Time')
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    # Speedup
    if has_gpu():
        plt.subplot(2, 2, 3)
        speedups = []
        valid_sizes = []
        for i, size in enumerate(results["sample_size"]):
            if (results["cpu_total_time"][i] is not None and 
                results["gpu_total_time"][i] is not None and
                results["gpu_total_time"][i] > 0):
                speedup = results["cpu_total_time"][i] / results["gpu_total_time"][i]
                speedups.append(speedup)
                valid_sizes.append(size)
        
        if speedups:
            plt.plot(valid_sizes, speedups, 'o-', color='green')
            plt.xlabel('Number of Participants')
            plt.ylabel('Speedup Factor (CPU/GPU)')
            plt.title('GPU Speedup')
            plt.grid(True, alpha=0.3)
            
            # Add speedup labels
            for i, (size, speedup) in enumerate(zip(valid_sizes, speedups)):
                plt.text(size, speedup + 0.1, f"{speedup:.2f}x", 
                         horizontalalignment='center')
    
    # Memory usage
    plt.subplot(2, 2, 4)
    plt.plot(results["sample_size"], results["memory_usage"], 'o-', color='purple')
    plt.xlabel('Number of Participants')
    plt.ylabel('Memory Usage (GB)')
    plt.title('Memory Usage')
    plt.grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig("gpu_accelerated/output/bg2050_benchmark.png")
    print(f"\nBenchmark results saved to gpu_accelerated/output/bg2050_benchmark.png")
    
    # Create a summary of results
    summary = pd.DataFrame({
        "Sample Size": results["sample_size"],
        "Matrix Shape": [f"{shape[0]}x{shape[1]}" for shape in results["matrix_shape"]],
        "CPU PCA Time (s)": results["cpu_pca_time"],
        "GPU PCA Time (s)": results["gpu_pca_time"],
        "CPU Total Time (s)": results["cpu_total_time"],
        "GPU Total Time (s)": results["gpu_total_time"],
        "Memory Usage (GB)": results["memory_usage"]
    })
    
    # Add speedup column if GPU is available
    if has_gpu():
        speedups = []
        for i in range(len(results["sample_size"])):
            if (results["cpu_total_time"][i] is not None and 
                results["gpu_total_time"][i] is not None and
                results["gpu_total_time"][i] > 0):
                speedup = results["cpu_total_time"][i] / results["gpu_total_time"][i]
                speedups.append(f"{speedup:.2f}x")
            else:
                speedups.append("N/A")
        
        summary["Speedup"] = speedups
    
    summary.to_csv("gpu_accelerated/output/bg2050_benchmark_results.csv", index=False)
    print(f"Benchmark results saved to gpu_accelerated/output/bg2050_benchmark_results.csv")
    
    return summary

def main():
    """Main function to evaluate bg2050 dataset."""
    # Print system information
    print("=" * 50)
    print("BG2050 Dataset Benchmark")
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
    
    # Check memory
    available_memory = psutil.virtual_memory().available / (1024**3)
    print(f"\nAvailable memory: {available_memory:.2f} GB")
    
    # Evaluate feasibility
    votes_path = os.path.join("real_data", "bg2050", "votes.csv")
    votes_df = pd.read_csv(votes_path)
    n_participants = votes_df["voter-id"].nunique()
    n_comments = votes_df["comment-id"].nunique()
    
    print(f"\nBG2050 dataset:")
    print(f"  Participants: {n_participants}")
    print(f"  Comments: {n_comments}")
    print(f"  Matrix size: {n_participants} x {n_comments} = {n_participants * n_comments} cells")
    
    estimated_memory = (n_participants * n_comments * 8) / (1024**3)  # 8 bytes per float64
    print(f"  Estimated memory for full matrix: {estimated_memory:.2f} GB")
    
    # Check if we can process the full dataset
    if estimated_memory > available_memory * 0.8:
        print("\nWARNING: Full dataset might not fit in memory.")
        print("Will test with progressively larger subsamples to determine scaling.")
        
        # Run scaling evaluation
        summary = evaluate_scaling("bg2050")
        
        # Print conclusion
        print("\nConclusion:")
        if has_gpu():
            max_size = max(summary["Sample Size"])
            if max_size < n_participants:
                print(f"Based on scaling results, processing the full BG2050 dataset with {n_participants} participants")
                print("would require more memory than is available.")
                print(f"The largest subsample successfully processed was {max_size} participants.")
                
                # Estimate time for full dataset based on largest subsample
                largest_idx = summary["Sample Size"].index(max_size)
                if summary["GPU Total Time (s)"][largest_idx] != "N/A":
                    gpu_time = float(summary["GPU Total Time (s)"][largest_idx])
                    scaling_factor = n_participants / max_size
                    estimated_time = gpu_time * (scaling_factor ** 1.5)  # Non-linear scaling
                    print(f"\nEstimated GPU processing time for full dataset: {estimated_time:.2f} seconds (~{estimated_time/60:.2f} minutes)")
            else:
                print("Successfully processed the full BG2050 dataset.")
                
                if "Speedup" in summary.columns:
                    speedup = summary["Speedup"].iloc[-1]
                    print(f"GPU provided a {speedup} speedup over CPU for the full dataset.")
        else:
            print("No GPU available for acceleration. CPU-only processing is possible but may be slow for the full dataset.")
    else:
        print("\nFull dataset should fit in memory. Running benchmark...")
        summary = evaluate_scaling("bg2050")
    
if __name__ == "__main__":
    main()