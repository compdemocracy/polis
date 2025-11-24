#!/usr/bin/env python3
"""
Benchmark script for update_votes performance.

Usage:
    cd delphi
    ../.venv/bin/python -m polismath.benchmarks.bench_update_votes [dataset_name] [--runs N]

Example:
    ../.venv/bin/python -m polismath.benchmarks.bench_update_votes bg2050 --runs 3
"""
import argparse
import time
import sys


def benchmark_update_votes(dataset_name: str = 'bg2050', runs: int = 3) -> dict:
    """
    Benchmark update_votes on a dataset.

    Args:
        dataset_name: Name of the dataset to benchmark
        runs: Number of runs to average

    Returns:
        Dictionary with benchmark results
    """
    from polismath.conversation import Conversation
    from polismath.regression.utils import prepare_votes_data

    print(f"Loading dataset '{dataset_name}'...")
    votes_dict, metadata = prepare_votes_data(dataset_name)
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


def main():
    parser = argparse.ArgumentParser(description='Benchmark update_votes performance')
    parser.add_argument('dataset', nargs='?', default='bg2050',
                        help='Dataset name (default: bg2050)')
    parser.add_argument('--runs', type=int, default=3,
                        help='Number of benchmark runs (default: 3)')
    args = parser.parse_args()

    try:
        benchmark_update_votes(args.dataset, args.runs)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
