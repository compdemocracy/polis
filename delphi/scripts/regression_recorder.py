#!/usr/bin/env python3
"""
Recorder CLI for capturing golden snapshots of Conversation computation outputs.

This is a thin wrapper around the ConversationRecorder class from polismath.regression.
"""

import logging
import click


@click.command()
@click.argument('datasets', nargs=-1)
@click.option('--force', is_flag=True, default=False, help='Force overwrite existing golden snapshot')
@click.option('--benchmark/--no-benchmark', default=True, help='Enable/disable timing measurements (default: enabled)')
@click.option('--log-level', type=click.Choice(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'], case_sensitive=False),
              default='INFO', help='Set logging level (default: INFO). Use DEBUG to save PCA debug output.')
def main(datasets: tuple, force: bool, benchmark: bool, log_level: str):
    """
    Record golden snapshots for datasets.

    If no datasets are specified, records for all available datasets.
    Otherwise, records only the specified datasets.

    Examples:
        python recorder.py                    # Record all datasets
        python recorder.py biodiversity       # Record only biodiversity
        python recorder.py biodiversity vw    # Record biodiversity and vw
        python recorder.py --log-level DEBUG  # Record with debug logging
    """
    # Configure logging - must be done before imports to prevent conversation module
    # from adding its own handler
    logging.basicConfig(
        level=getattr(logging, log_level.upper()),
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        force=True  # Force reconfiguration if already configured
    )

    # Import after logging is configured to ensure conversation module uses root logger
    from polismath.regression import ConversationRecorder, list_available_datasets

    recorder = ConversationRecorder()

    # If no datasets specified, use all available datasets
    if not datasets:
        available_datasets = list_available_datasets()
        datasets = list(available_datasets.keys())
        click.echo(f"No datasets specified. Recording all available datasets: {', '.join(datasets)}\n")
    else:
        # Validate that specified datasets exist
        available_datasets = list_available_datasets()
        invalid_datasets = [d for d in datasets if d not in available_datasets]
        if invalid_datasets:
            available = ', '.join(available_datasets.keys())
            click.echo(f"Error: Unknown dataset(s): {', '.join(invalid_datasets)}", err=True)
            click.echo(f"Available datasets: {available}", err=True)
            raise click.Abort()

    # Record each dataset
    for dataset in datasets:
        click.echo(f"\n{'='*60}")
        click.echo(f"Recording golden snapshot for: {dataset}")
        click.echo(f"{'='*60}")
        recorder.record_golden(dataset, force=force, benchmark=benchmark)


if __name__ == "__main__":
    main()
