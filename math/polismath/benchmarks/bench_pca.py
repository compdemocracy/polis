#!/usr/bin/env python3
"""
Benchmark script for PCA computation performance.

Usage:
    cd delphi
    python -m polismath.benchmarks.bench_pca <votes_csv_path> [--runs N]
    python -m polismath.benchmarks.bench_pca <votes_csv_path> --profile
    python -m polismath.benchmarks.bench_pca <votes_csv_path> --compare-impls

Example:
    python -m polismath.benchmarks.bench_pca real_data/.local/r7wehfsmutrwndviddnii-bg2050/2025-11-25-1909-r7wehfsmutrwndviddnii-votes.csv --runs 3
    python -m polismath.benchmarks.bench_pca real_data/.local/r7wehfsmutrwndviddnii-bg2050/2025-11-25-1909-r7wehfsmutrwndviddnii-votes.csv --profile
    python -m polismath.benchmarks.bench_pca real_data/r6vbnhffkxbd7ifmfbdrd-vw/2025-11-11-1704-r6vbnhffkxbd7ifmfbdrd-votes.csv --compare-impls
"""

import os
import time
from pathlib import Path

import click
import numpy as np

from polismath.benchmarks.benchmark_utils import (
    load_votes_from_csv,
    extract_dataset_name,
    votes_csv_argument,
    runs_option,
)
from polismath.conversation import Conversation
from polismath.pca_kmeans_rep.pca import (
    PCA_IMPL_CHOICES,
    PCA_IMPL_ENV_VAR,
    pca_project_dataframe,
)


profile_option = click.option(
    '--profile', '-p',
    is_flag=True,
    help='Run with line profiler on PCA functions',
)

compare_impls_option = click.option(
    '--compare-impls', '-c',
    is_flag=True,
    help='Cold-start comparison of PCA solvers (POLISMATH_PCA_IMPL values: '
         'powerit = legacy/Clojure-parity, sklearn = improved)',
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


def benchmark_impl_comparison(votes_csv: Path, runs: int = 3) -> dict:
    """
    Cold-start wall-time + component-angle comparison of the PCA solvers.

    Times pca_project_dataframe under each POLISMATH_PCA_IMPL value on the
    same clean (NaN-imputed identically inside) matrix, then reports the
    angle between the components the two solvers produce.

    Args:
        votes_csv: Path to votes CSV file
        runs: Number of runs to average per solver

    Returns:
        Dictionary with per-solver timings and per-component angles.
    """
    conv, dataset_name, n_votes, _ = setup_conversation(votes_csv)
    clean_matrix = conv._get_clean_matrix()

    results: dict = {'dataset': dataset_name, 'n_votes': n_votes,
                     'shape': clean_matrix.shape, 'impls': {}}
    saved_env = os.environ.get(PCA_IMPL_ENV_VAR)
    try:
        for impl in PCA_IMPL_CHOICES:
            os.environ[PCA_IMPL_ENV_VAR] = impl
            print(f"Benchmarking {PCA_IMPL_ENV_VAR}={impl} ({runs} runs)...")
            times = []
            pca_results = None
            for i in range(runs):
                start = time.perf_counter()
                pca_results, _ = pca_project_dataframe(clean_matrix, 2)
                elapsed = time.perf_counter() - start
                times.append(elapsed)
                print(f"  Run {i+1}: {elapsed:.3f}s")
            results['impls'][impl] = {
                'times': times,
                'avg': sum(times) / len(times),
                'min': min(times),
                'max': max(times),
                'comps': pca_results['comps'] if pca_results is not None else None,
            }
    finally:
        # Belt-and-braces: restore whatever the caller had set.
        if saved_env is None:
            os.environ.pop(PCA_IMPL_ENV_VAR, None)
        else:
            os.environ[PCA_IMPL_ENV_VAR] = saved_env

    print()
    print("=" * 50)
    print(f"Dataset: {dataset_name}")
    print(f"Votes: {n_votes:,}")
    print(f"Matrix shape: {clean_matrix.shape}")
    for impl, r in results['impls'].items():
        print(f"{impl:>8}: avg {r['avg']:.3f}s (min {r['min']:.3f}s / max {r['max']:.3f}s)")

    impl_names = list(results['impls'].keys())
    if len(impl_names) == 2:
        comps_a = results['impls'][impl_names[0]]['comps']
        comps_b = results['impls'][impl_names[1]]['comps']
        if comps_a is not None and comps_b is not None and comps_a.shape == comps_b.shape:
            angles = []
            for i in range(comps_a.shape[0]):
                norm_a = np.linalg.norm(comps_a[i])
                norm_b = np.linalg.norm(comps_b[i])
                if norm_a == 0.0 or norm_b == 0.0:
                    angles.append(float('nan'))
                    continue
                cos = abs(float(np.dot(comps_a[i], comps_b[i]))) / (norm_a * norm_b)
                angles.append(float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))))
            results['angles_deg'] = angles
            for i, angle in enumerate(angles):
                print(f"PC{i+1} angle {impl_names[0]} vs {impl_names[1]}: {angle:.3e}°")

    return results


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
@compare_impls_option
def main(votes_csv: Path, runs: int, profile: bool, compare_impls: bool):
    """Benchmark PCA computation performance."""
    if profile:
        profile_pca(votes_csv)
    elif compare_impls:
        benchmark_impl_comparison(votes_csv, runs)
    else:
        benchmark_pca(votes_csv, runs)


if __name__ == '__main__':
    main()
