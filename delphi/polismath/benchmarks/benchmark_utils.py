"""
Shared utilities for benchmark scripts.
"""

import time
from pathlib import Path
from typing import Callable, Dict, Any

import click
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

    # Use vectorized pandas operations instead of iterrows() for efficiency
    df = df.rename(columns={
        'voter-id': 'pid',
        'comment-id': 'tid',
    })
    if 'timestamp' in df.columns:
        df['created'] = df['timestamp'].astype(int)
    else:
        df['created'] = fixed_timestamp

    votes_list = df[['pid', 'tid', 'vote', 'created']].to_dict('records')

    return {
        'votes': votes_list,
        'lastVoteTimestamp': fixed_timestamp
    }


def extract_dataset_name(votes_path: Path) -> str:
    """
    Extract dataset name from path.

    Args:
        votes_path: Path to votes CSV file

    Returns:
        Dataset name (e.g., "r7wehfsmutrwndviddnii-bg2050" -> "bg2050")
    """
    parent_name = votes_path.parent.name
    if '-' in parent_name:
        return parent_name.split('-', 1)[1]
    return parent_name


def run_benchmark(
    func: Callable[[], Any],
    runs: int,
    description: str = "operation"
) -> Dict[str, Any]:
    """
    Run a benchmark function multiple times and collect timing statistics.

    Args:
        func: Function to benchmark (called with no arguments)
        runs: Number of runs
        description: Description for printing

    Returns:
        Dictionary with timing statistics and results from last run
    """
    times = []
    result = None
    for i in range(runs):
        start = time.perf_counter()
        result = func()
        elapsed = time.perf_counter() - start
        times.append(elapsed)
        print(f"  Run {i+1}: {elapsed:.3f}s")

    avg = sum(times) / len(times)
    min_time = min(times)
    max_time = max(times)

    return {
        'times': times,
        'avg': avg,
        'min': min_time,
        'max': max_time,
        'result': result,
    }


# Common click options for benchmark scripts
votes_csv_argument = click.argument(
    'votes_csv',
    type=click.Path(exists=True, path_type=Path),
)

runs_option = click.option(
    '--runs', '-n',
    default=3,
    help='Number of benchmark runs (default: 3)',
)
