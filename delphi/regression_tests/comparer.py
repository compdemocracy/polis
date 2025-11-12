#!/usr/bin/env python3
"""
Comparer CLI for comparing current Conversation outputs with golden snapshots.

This is a thin wrapper around the ConversationComparer class from regression_lib.
"""

import click
from regression_lib import ConversationComparer


@click.command()
@click.argument('dataset', default='biodiversity')
@click.option('--benchmark', is_flag=True, help='Enable/disable timing comparison (default: disabled)')
def main(dataset: str, benchmark: bool):
    """Compare current implementation with golden snapshot."""
    comparer = ConversationComparer()
    results = comparer.compare_with_golden(dataset, benchmark=benchmark)

    # Exit with error code if comparison failed
    if "error" in results or not results.get("overall_match", False):
        exit(1)
    else:
        exit(0)


if __name__ == "__main__":
    main()
