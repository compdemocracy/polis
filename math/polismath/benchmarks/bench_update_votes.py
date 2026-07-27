#!/usr/bin/env python3
"""
Benchmark script for update_votes performance.

Usage:
    cd delphi
    ../.venv/bin/python -m polismath.benchmarks.bench_update_votes <votes_csv_path> [--runs N]

Example:
    ../.venv/bin/python -m polismath.benchmarks.bench_update_votes real_data/.local/r7wehfsmutrwndviddnii-bg2050/2025-11-25-1909-r7wehfsmutrwndviddnii-votes.csv --runs 3
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


def benchmark_update_votes(votes_csv: Path, runs: int = 3) -> dict:
    """
    Benchmark update_votes on a dataset.

    Args:
        votes_csv: Path to votes CSV file
        runs: Number of runs to average

    Returns:
        Dictionary with benchmark results
    """
    from polismath.conversation import Conversation

    dataset_name = extract_dataset_name(votes_csv)

    print(f"Loading votes from '{votes_csv}'...")
    votes_dict = load_votes_from_csv(votes_csv)
    n_votes = len(votes_dict['votes'])
    print(f"Loaded {n_votes:,} votes")
    print()

    times = []
    for i in range(runs):
        conv = Conversation(dataset_name)
        start = time.perf_counter()
        conv = conv.update_votes(votes_dict, recompute=False)
        elapsed = time.perf_counter() - start
        times.append(elapsed)
        print(f"  Run {i+1}: {elapsed:.2f}s")

    avg = sum(times) / len(times)
    min_time = min(times)
    max_time = max(times)

    print()
    print(f"Dataset: {dataset_name}")
    print(f"Votes: {n_votes:,}")
    print(f"Matrix shape: {conv.raw_rating_mat.shape}")
    print(f"Average time: {avg:.2f}s")
    print(f"Min/Max: {min_time:.2f}s / {max_time:.2f}s")
    print(f"Throughput: {n_votes/avg:,.0f} votes/sec")

    return {
        'dataset': dataset_name,
        'n_votes': n_votes,
        'shape': conv.raw_rating_mat.shape,
        'times': times,
        'avg': avg,
        'min': min_time,
        'max': max_time,
        'throughput': n_votes / avg,
    }


@click.command()
@votes_csv_argument
@runs_option
def main(votes_csv: Path, runs: int):
    """Benchmark update_votes performance."""
    benchmark_update_votes(votes_csv, runs)


if __name__ == '__main__':
    main()
