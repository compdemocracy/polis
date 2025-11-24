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

import argparse
import time
import sys
from pathlib import Path

import pandas as pd


def load_votes_from_csv(votes_csv: Path) -> dict:
    """
    Load votes from a CSV file into the format expected by Conversation.update_votes().

    Args:
        votes_csv: Path to votes CSV file with columns: voter-id, comment-id, vote, timestamp

    Returns:
        Dictionary with 'votes' list and 'lastVoteTimestamp'
    """
    df = pd.read_csv(votes_csv)

    # Fixed timestamp for reproducibility
    fixed_timestamp = 1700000000000

    votes_list = []
    for _, row in df.iterrows():
        votes_list.append({
            'pid': row['voter-id'],
            'tid': row['comment-id'],
            'vote': row['vote'],
            'created': int(row['timestamp']) if 'timestamp' in df.columns else fixed_timestamp
        })

    return {
        'votes': votes_list,
        'lastVoteTimestamp': fixed_timestamp
    }


def benchmark_update_votes(votes_csv: str, runs: int = 3) -> dict:
    """
    Benchmark update_votes on a dataset.

    Args:
        votes_csv: Path to votes CSV file
        runs: Number of runs to average

    Returns:
        Dictionary with benchmark results
    """
    from polismath.conversation import Conversation

    votes_path = Path(votes_csv)
    if not votes_path.exists():
        raise FileNotFoundError(f"Votes CSV not found: {votes_csv}")

    # Extract dataset name from path (e.g., "r7wehfsmutrwndviddnii-bg2050" -> "bg2050")
    parent_name = votes_path.parent.name
    if '-' in parent_name:
        dataset_name = parent_name.split('-', 1)[1]
    else:
        dataset_name = parent_name

    print(f"Loading votes from '{votes_csv}'...")
    votes_dict = load_votes_from_csv(votes_path)
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
    parser.add_argument('votes_csv', help='Path to votes CSV file')
    parser.add_argument('--runs', type=int, default=3,
                        help='Number of benchmark runs (default: 3)')
    args = parser.parse_args()

    try:
        benchmark_update_votes(args.votes_csv, args.runs)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
