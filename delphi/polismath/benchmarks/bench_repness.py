#!/usr/bin/env python3
"""
Benchmark script for repness (representativeness) computation performance.

Usage:
    cd delphi
    ../.venv/bin/python -m polismath.benchmarks.bench_repness <votes_csv_path> [--runs N]
    ../.venv/bin/python -m polismath.benchmarks.bench_repness <votes_csv_path> --profile

Example:
    ../.venv/bin/python -m polismath.benchmarks.bench_repness real_data/.local/r7wehfsmutrwndviddnii-bg2050/2025-11-25-1909-r7wehfsmutrwndviddnii-votes.csv --runs 3
    ../.venv/bin/python -m polismath.benchmarks.bench_repness real_data/.local/r7wehfsmutrwndviddnii-bg2050/2025-11-25-1909-r7wehfsmutrwndviddnii-votes.csv --profile
"""
# TODO(datasets): Once PR https://github.com/compdemocracy/polis/pull/2312 is merged,
# use the datasets package with include_local=True instead of requiring a path argument.

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
from polismath.pca_kmeans_rep.repness import (
    conv_repness,
    comment_stats,
    add_comparative_stats,
    finalize_cmt_stats,
    select_rep_comments,
    compute_group_comment_stats_df,
    select_rep_comments_df,
    select_consensus_comments_df,
    prop_test_vectorized,
    two_prop_test_vectorized
)


profile_option = click.option(
    '--profile', '-p',
    is_flag=True,
    help='Run with line profiler on conv_repness',
)


def setup_conversation(votes_csv: Path) -> tuple[Conversation, str, int, float]:
    """
    Load votes and setup conversation with PCA and clusters.

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

    print("Setting up conversation with votes and clusters...")
    setup_start = time.perf_counter()
    conv = Conversation(dataset_name)
    conv = conv.update_votes(votes_dict, recompute=False)
    conv._compute_pca()
    conv._compute_clusters()
    setup_time = time.perf_counter() - setup_start

    print(f"Setup completed in {setup_time:.2f}s")
    print(f"  Matrix shape: {conv.raw_rating_mat.shape}")
    print(f"  Number of groups: {len(conv.group_clusters)}")
    print()

    return conv, dataset_name, n_votes, setup_time


def benchmark_repness(votes_csv: Path, runs: int = 3) -> dict:
    """
    Benchmark repness computation on a dataset.

    Args:
        votes_csv: Path to votes CSV file
        runs: Number of runs to average

    Returns:
        Dictionary with benchmark results
    """
    conv, dataset_name, n_votes, setup_time = setup_conversation(votes_csv)

    # Benchmark repness computation
    print(f"Benchmarking repness computation ({runs} runs)...")
    times = []
    for i in range(runs):
        start = time.perf_counter()
        conv._compute_repness()
        elapsed = time.perf_counter() - start
        times.append(elapsed)
        n_rep_comments = sum(len(v) for v in conv.repness.get('group_repness', {}).values())
        print(f"  Run {i+1}: {elapsed:.3f}s ({n_rep_comments} representative comments)")

    avg = sum(times) / len(times)
    min_time = min(times)
    max_time = max(times)

    print()
    print("=" * 50)
    print(f"Dataset: {dataset_name}")
    print(f"Votes: {n_votes:,}")
    print(f"Matrix shape: {conv.raw_rating_mat.shape}")
    print(f"Groups: {len(conv.group_clusters)}")
    print(f"Average repness time: {avg:.3f}s")
    print(f"Min/Max: {min_time:.3f}s / {max_time:.3f}s")

    # Calculate comments per second
    n_comments = conv.raw_rating_mat.shape[1]
    n_participants = conv.raw_rating_mat.shape[0]
    n_groups = len(conv.group_clusters)

    # Repness complexity is roughly O(groups * comments * participants)
    operations = n_groups * n_comments * n_participants
    print(f"Throughput: {operations/avg:,.0f} ops/sec (groups × comments × participants)")

    return {
        'dataset': dataset_name,
        'n_votes': n_votes,
        'shape': conv.raw_rating_mat.shape,
        'n_groups': n_groups,
        'times': times,
        'avg': avg,
        'min': min_time,
        'max': max_time,
        'setup_time': setup_time,
    }


def profile_repness(votes_csv: Path) -> None:
    """
    Run line profiler on conv_repness.

    Args:
        votes_csv: Path to votes CSV file
    """
    from line_profiler import LineProfiler
    conv, _, _, _ = setup_conversation(votes_csv)

    # Setup line profiler
    profiler = LineProfiler()
    profiler.add_function(conv_repness)
    profiler.add_function(compute_group_comment_stats_df)
    profiler.add_function(select_rep_comments_df)
    profiler.add_function(select_consensus_comments_df)
    profiler.add_function(prop_test_vectorized)
    profiler.add_function(two_prop_test_vectorized)

    # Run profiled
    print("Running conv_repness with line profiler...")
    profiler.runcall(conv_repness, conv.rating_mat, conv.group_clusters)

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
    """Benchmark repness computation performance."""
    if profile:
        profile_repness(votes_csv)
    else:
        benchmark_repness(votes_csv, runs)


if __name__ == '__main__':
    main()
