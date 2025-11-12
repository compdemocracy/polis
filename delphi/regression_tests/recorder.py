#!/usr/bin/env python3
"""
Recorder CLI for capturing golden snapshots of Conversation computation outputs.

This is a thin wrapper around the ConversationRecorder class from regression_lib.
"""

import click
from regression_lib import ConversationRecorder


@click.command()
@click.argument('dataset', default='biodiversity')
@click.option('--force', is_flag=True, default=False, help='Force overwrite existing golden snapshot')
@click.option('--benchmark/--no-benchmark', default=True, help='Enable/disable timing measurements (default: enabled)')
def main(dataset: str, force: bool, benchmark: bool):
    """Record golden snapshot for a dataset."""
    recorder = ConversationRecorder()
    recorder.record_golden(dataset, force=force, benchmark=benchmark)


if __name__ == "__main__":
    main()
