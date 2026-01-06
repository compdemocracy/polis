#!/usr/bin/env python3
"""
Comparer CLI for comparing current Conversation outputs with golden snapshots.

This is a thin wrapper around the ConversationComparer class from polismath.regression.
"""

import logging
import click


@click.command()
@click.argument('datasets', nargs=-1)
@click.option('--benchmark', is_flag=True, help='Enable timing comparison')
@click.option('-i', '--ignore-pca-sign-flip', is_flag=True, help='Ignore sign flips in PCA components (multiplication by -1)')
@click.option('--include-local', is_flag=True, default=False, help='Include datasets from real_data/.local/')
@click.option('--log-level', type=click.Choice(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'], case_sensitive=False),
              default='INFO', help='Set logging level (default: INFO). Use DEBUG to save detailed comparison output.')
@click.option('--outlier-fraction', type=float, default=0.01,
              help='Fraction of values (0.0-1.0) allowed to exceed tight tolerance. Default 0.01 (1%).')
@click.option('--loose-rel-tol', type=float, default=None,
              help='Loose relative tolerance for outliers. Default: 10 * rel_tolerance.')
@click.option('--loose-abs-tol', type=float, default=None,
              help='Loose absolute tolerance for outliers. Default: 1000 * abs_tolerance.')
def main(datasets: tuple, benchmark: bool, ignore_pca_sign_flip: bool, include_local: bool, log_level: str,
         outlier_fraction: float, loose_rel_tol: float | None, loose_abs_tol: float | None):
    """
    Compare current implementation with golden snapshots.

    If no datasets are specified, compares all available datasets.
    Otherwise, compares only the specified datasets.

    Examples:
        # Compare all datasets:
        python comparer.py

        # Compare only biodiversity:
        python comparer.py biodiversity

        # Compare biodiversity and vw:
        python comparer.py biodiversity vw

        # Include datasets from real_data/.local/:
        python comparer.py --include-local

        # Compare with debug logging:
        python comparer.py --log-level DEBUG

        # Compare with PCA sign flip tolerance:
        python comparer.py -i biodiversity

        # Allow 1% of values to be outliers (within 10% loose tolerance):
        python comparer.py -i --outlier-fraction 0.01 biodiversity
    """
    # Configure logging - must be done before imports to prevent conversation module
    # from adding its own handler
    logging.basicConfig(
        level=getattr(logging, log_level.upper()),
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        force=True  # Force reconfiguration if already configured
    )

    # Import after logging is configured to ensure conversation module uses root logger
    from polismath.regression import ConversationComparer, list_available_datasets

    comparer = ConversationComparer(
        ignore_pca_sign_flip=ignore_pca_sign_flip,
        outlier_fraction=outlier_fraction,
        loose_rel_tolerance=loose_rel_tol,
        loose_abs_tolerance=loose_abs_tol,
    )

    # If no datasets specified, use all available datasets
    if not datasets:
        available_datasets = list_available_datasets(include_local=include_local)
        datasets = list(available_datasets.keys())
        click.echo(f"No datasets specified. Comparing all available datasets: {', '.join(datasets)}\n")
    else:
        # Validate that specified datasets exist.
        # Use include_local=True for explicit names: if someone asks for a dataset
        # by name, we should find it regardless of where it lives.
        available_datasets = list_available_datasets(include_local=True)
        invalid_datasets = [d for d in datasets if d not in available_datasets]
        if invalid_datasets:
            available = ', '.join(available_datasets.keys())
            click.echo(f"Error: Unknown dataset(s): {', '.join(invalid_datasets)}", err=True)
            click.echo(f"Available datasets: {available}", err=True)
            raise click.Abort()

    # Compare each dataset
    results_summary = {}

    for dataset in datasets:
        click.echo(f"\n{'='*60}")
        click.echo(f"Comparing: {dataset}")
        click.echo(f"{'='*60}")

        result = comparer.compare_with_golden(dataset, benchmark=benchmark)

        # Track results
        passed = "error" not in result and result.get("overall_match", False)
        results_summary[dataset] = passed

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
