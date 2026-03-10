#!/usr/bin/env python3
"""
Benchmark script for PCA computation performance.

Usage:
    cd delphi
    python -m polismath.benchmarks.bench_pca <votes_csv_path> [--runs N]
    python -m polismath.benchmarks.bench_pca <votes_csv_path> --profile

Example:
    python -m polismath.benchmarks.bench_pca real_data/.local/r7wehfsmutrwndviddnii-bg2050/2025-11-25-1909-r7wehfsmutrwndviddnii-votes.csv --runs 3
    python -m polismath.benchmarks.bench_pca real_data/.local/r7wehfsmutrwndviddnii-bg2050/2025-11-25-1909-r7wehfsmutrwndviddnii-votes.csv --profile
"""

import time
from pathlib import Path

import click

from polismath.benchmarks.benchmark_utils import (
    load_votes_from_csv,
    extract_dataset_name,
    votes_csv_argument,
    runs_option,
)
from polismath.conversation import Conversation
from polismath.pca_kmeans_rep.pca import pca_project_dataframe


profile_option = click.option(
    '--profile', '-p',
    is_flag=True,
    help='Run with line profiler on PCA functions',
)


def setup_conversation(votes_csv: Path) -> tuple[Conversation, str, int, float]:
    """
    Load votes and setup conversation (without computing PCA).

    Args:
        votes_csv: Path to votes CSV file

    Returns:
        Tuple of (conversation, dataset_name, n_votes, setup_time)
    """
    dataset_name = extract_dataset_name(votes_csv)

    print(f"Loading votes from '{votes_csv}'...")
    votes_dict = load_votes_from_csv(votes_csv)
    n_votes = len(votes_dict['votes'])
    print(f"Loaded {n_votes:,} votes")
    print()

    print("Setting up conversation with votes...")
    setup_start = time.perf_counter()
    conv = Conversation(dataset_name)
    conv = conv.update_votes(votes_dict, recompute=False)
    setup_time = time.perf_counter() - setup_start

    print(f"Setup completed in {setup_time:.2f}s")
    print(f"  Matrix shape: {conv.raw_rating_mat.shape}")
    print()

    return conv, dataset_name, n_votes, setup_time


def benchmark_pca(votes_csv: Path, runs: int = 3) -> dict:
    """
    Benchmark PCA computation on a dataset.

    Args:
        votes_csv: Path to votes CSV file
        runs: Number of runs to average

    Returns:
        Dictionary with benchmark results
    """
    conv, dataset_name, n_votes, setup_time = setup_conversation(votes_csv)

    # Benchmark PCA computation
    print(f"Benchmarking PCA computation ({runs} runs)...")
    times = []
    for i in range(runs):
        # Reset PCA state to force recomputation
        conv.pca = None
        conv.proj = None

        start = time.perf_counter()
        conv._compute_pca()
        elapsed = time.perf_counter() - start
        times.append(elapsed)

        n_components = conv.pca['comps'].shape[0] if conv.pca else 0
        n_projections = len(conv.proj) if conv.proj else 0
        print(f"  Run {i+1}: {elapsed:.3f}s ({n_components} components, {n_projections} projections)")

    avg = sum(times) / len(times)
    min_time = min(times)
    max_time = max(times)

    print()
    print("=" * 50)
    print(f"Dataset: {dataset_name}")
    print(f"Votes: {n_votes:,}")
    print(f"Matrix shape: {conv.raw_rating_mat.shape}")
    print(f"Average PCA time: {avg:.3f}s")
    print(f"Min/Max: {min_time:.3f}s / {max_time:.3f}s")

    # Calculate throughput metrics
    n_participants = conv.raw_rating_mat.shape[0]
    n_comments = conv.raw_rating_mat.shape[1]

    # PCA complexity is roughly O(min(n,p) * n * p) for n samples and p features
    operations = min(n_participants, n_comments) * n_participants * n_comments
    print(f"Throughput: {operations/avg:,.0f} ops/sec (min(n,p) x n x p)")
    print(f"Participants/sec: {n_participants/avg:,.0f}")

    return {
        'dataset': dataset_name,
        'n_votes': n_votes,
        'shape': conv.raw_rating_mat.shape,
        'times': times,
        'avg': avg,
        'min': min_time,
        'max': max_time,
        'setup_time': setup_time,
    }


def profile_pca(votes_csv: Path) -> None:
    """
    Run line profiler on PCA functions.

    Args:
        votes_csv: Path to votes CSV file
    """
    from line_profiler import LineProfiler

    conv, _, _, _ = setup_conversation(votes_csv)

    # Get clean matrix for profiling
    clean_matrix = conv._get_clean_matrix()

    # Setup line profiler
    profiler = LineProfiler()
    profiler.add_function(pca_project_dataframe)

    # Run profiled
    print("Running pca_project_dataframe with line profiler...")
    profiler.runcall(pca_project_dataframe, clean_matrix, 2)

    # Print results
    print()
    print("=" * 70)
    print("LINE PROFILE RESULTS")
    print("=" * 70)
    profiler.print_stats()


@click.command()
@votes_csv_argument
@runs_option
@profile_option
def main(votes_csv: Path, runs: int, profile: bool):
    """Benchmark PCA computation performance."""
    if profile:
        profile_pca(votes_csv)
    else:
        benchmark_pca(votes_csv, runs)


if __name__ == '__main__':
    main()
