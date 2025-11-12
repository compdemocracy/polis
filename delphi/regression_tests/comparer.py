#!/usr/bin/env python3
"""
Comparer CLI for comparing current Conversation outputs with golden snapshots.

This is a thin wrapper around the ConversationComparer class from regression_lib.
"""

import click
from regression_lib import ConversationComparer
from tests.dataset_config import list_available_datasets


@click.command()
@click.argument('datasets', nargs=-1)
@click.option('--benchmark', is_flag=True, help='Enable timing comparison')
def main(datasets: tuple, benchmark: bool):
    """
    Compare current implementation with golden snapshots.

    If no datasets are specified, compares all available datasets.
    Otherwise, compares only the specified datasets.

    Examples:
        python comparer.py                    # Compare all datasets
        python comparer.py biodiversity       # Compare only biodiversity
        python comparer.py biodiversity vw    # Compare biodiversity and vw
    """
    comparer = ConversationComparer()

    # If no datasets specified, use all available datasets
    if not datasets:
        available_datasets = list_available_datasets()
        datasets = list(available_datasets.keys())
        click.echo(f"No datasets specified. Comparing all available datasets: {', '.join(datasets)}\n")
    else:
        # Validate that specified datasets exist
        available_datasets = list_available_datasets()
        invalid_datasets = [d for d in datasets if d not in available_datasets]
        if invalid_datasets:
            available = ', '.join(available_datasets.keys())
            click.echo(f"Error: Unknown dataset(s): {', '.join(invalid_datasets)}", err=True)
            click.echo(f"Available datasets: {available}", err=True)
            raise click.Abort()

    # Compare each dataset
    all_passed = True
    results_summary = {}

    for dataset in datasets:
        click.echo(f"\n{'='*60}")
        click.echo(f"Comparing: {dataset}")
        click.echo(f"{'='*60}")

        result = comparer.compare_with_golden(dataset, benchmark=benchmark)

        # Track results
        passed = "error" not in result and result.get("overall_match", False)
        results_summary[dataset] = passed

        if not passed:
            all_passed = False

    # Print summary
    click.echo(f"\n{'='*60}")
    click.echo("COMPARISON SUMMARY")
    click.echo(f"{'='*60}\n")

    passed_datasets = [name for name, passed in results_summary.items() if passed]
    failed_datasets = [name for name, passed in results_summary.items() if not passed]

    click.echo(f"Total: {len(results_summary)} dataset(s)")
    click.echo(f"Passed: {len(passed_datasets)}")
    if failed_datasets:
        click.echo(f"Failed: {len(failed_datasets)}")

    if passed_datasets:
        click.echo(f"\n✓ Passed:")
        for name in passed_datasets:
            click.echo(f"  {name}")

    if failed_datasets:
        click.echo(f"\n✗ Failed:")
        for name in failed_datasets:
            click.echo(f"  {name}")
        click.echo("\nSome datasets failed comparison!", err=True)
        exit(1)
    else:
        click.echo("\n✓ All datasets passed!")
        exit(0)


if __name__ == "__main__":
    main()
