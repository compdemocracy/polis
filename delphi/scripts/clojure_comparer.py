#!/usr/bin/env python3
"""
Clojure comparison CLI - Compare Python outputs with Clojure math_blob references.

Similar to regression_comparer.py but compares against Clojure reference implementation
to validate that the Python port produces equivalent results.

These comparisons will be removed once the Clojure implementation is fully phased out.
"""

import sys
import os
import logging
import click

# Add parent dir to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


@click.command()
@click.argument('datasets', nargs=-1)
@click.option('--include-local', is_flag=True, default=False,
              help='Include datasets from real_data/.local/')
@click.option('--log-level', type=click.Choice(['DEBUG', 'INFO', 'WARNING', 'ERROR'], case_sensitive=False),
              default='INFO', help='Set logging level (default: INFO)')
@click.option('--jaccard-threshold', type=float, default=0.95,
              help='Minimum Jaccard similarity for cluster matching (default: 0.95)')
@click.option('--distribution-tolerance', type=float, default=0.05,
              help='Maximum Wasserstein distance for distributions (default: 0.05)')
@click.option('--show-mappings', is_flag=True,
              help='Show detailed cluster mappings')
@click.option('--show-projections', is_flag=True,
              help='Show PCA projection comparison details')
def main(datasets: tuple, include_local: bool, log_level: str,
         jaccard_threshold: float, distribution_tolerance: float,
         show_mappings: bool, show_projections: bool):
    """
    Compare Python implementation with Clojure math_blob outputs.

    If no datasets are specified, compares all available datasets with Clojure math_blob.

    Examples:

        # Compare all datasets with Clojure output:

        python scripts/clojure_comparer.py


        # Compare only biodiversity dataset:

        python scripts/clojure_comparer.py biodiversity


        # Compare biodiversity and vw:

        python scripts/clojure_comparer.py biodiversity vw


        # Include datasets from real_data/.local/:

        python scripts/clojure_comparer.py --include-local


        # Compare with debug logging:

        python scripts/clojure_comparer.py --log-level DEBUG


        # Show detailed cluster mappings:

        python scripts/clojure_comparer.py --show-mappings biodiversity


        # Use custom thresholds (looser):

        python scripts/clojure_comparer.py --jaccard-threshold 0.7 --distribution-tolerance 0.3
    """
    # Configure logging
    logging.basicConfig(
        level=getattr(logging, log_level.upper()),
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        force=True
    )

    # Import after logging is configured
    from polismath.regression.clojure_comparer import ClojureComparer, load_clojure_math_blob
    from polismath.regression import list_available_datasets, get_dataset_files
    from polismath.conversation import Conversation
    from polismath.benchmarks.benchmark_utils import load_votes_from_csv

    # Get available datasets with Clojure math_blob
    all_datasets = list_available_datasets(include_local=include_local)
    clojure_datasets = {
        name: info for name, info in all_datasets.items()
        if info.get('has_clojure_reference', False)
    }

    if not datasets:
        datasets = list(clojure_datasets.keys())
        if datasets:
            click.echo(f"No datasets specified. Comparing all datasets with Clojure output: {', '.join(datasets)}\n")
        else:
            click.echo("No datasets with Clojure math_blob found.", err=True)
            click.echo("Make sure datasets in real_data/ have math_blob.json files.", err=True)
            return 1
    else:
        # Validate that specified datasets exist and have Clojure output
        invalid_datasets = [d for d in datasets if d not in clojure_datasets]
        if invalid_datasets:
            available = ', '.join(clojure_datasets.keys())
            click.echo(f"Error: Unknown dataset(s) or no Clojure output: {', '.join(invalid_datasets)}", err=True)
            click.echo(f"Available datasets with Clojure output: {available}", err=True)
            return 1

    # Initialize comparer with user-specified thresholds
    comparer = ClojureComparer(
        jaccard_threshold=jaccard_threshold,
        distribution_tolerance=distribution_tolerance
    )

    # Compare each dataset
    results_summary = {}

    for dataset in datasets:
        click.echo(f"\n{'='*60}")
        click.echo(f"Comparing: {dataset}")
        click.echo(f"{'='*60}")

        try:
            # Load Clojure output
            clojure_output = load_clojure_math_blob(dataset)
            click.echo(f"✓ Loaded Clojure math_blob")

            # Load and process Python output
            dataset_files = get_dataset_files(dataset)
            votes_data = load_votes_from_csv(dataset_files['votes'])

            click.echo(f"✓ Loaded votes data: {len(votes_data['votes'])} votes")

            # Create and compute conversation
            conv = Conversation(dataset)
            conv = conv.update_votes(votes_data)
            conv = conv.recompute()

            click.echo(f"✓ Computed Python analysis:")
            click.echo(f"  - {conv.participant_count} participants")
            click.echo(f"  - {conv.comment_count} comments")
            click.echo(f"  - {len(conv.group_clusters)} groups")

            # Compare group clusters
            click.echo(f"\n--- Clustering Comparison ---")

            if 'group-clusters' not in clojure_output:
                click.echo("⚠ Clojure output missing 'group-clusters'", err=True)
                results_summary[dataset] = False
                continue

            python_clusters = conv.group_clusters
            clojure_clusters = clojure_output['group-clusters']

            cluster_result = comparer.compare_clusters(
                python_clusters,
                clojure_clusters,
                dataset_name=dataset
            )

            # Display distribution comparison
            dist_comp = cluster_result['distribution_comparison']
            click.echo(f"\nCluster Size Distribution:")
            click.echo(f"  Python sizes:  {dist_comp['python_sizes']}")
            click.echo(f"  Clojure sizes: {dist_comp['clojure_sizes']}")
            click.echo(f"  Wasserstein distance: {dist_comp['wasserstein_distance']:.4f}")
            click.echo(f"  Similarity score: {dist_comp['similarity_score']:.2%}")
            click.echo(f"  Status: {'✓ PASS' if dist_comp['match_status'] else '✗ FAIL'} (threshold: {distribution_tolerance})")

            # Display membership comparison
            memb_comp = cluster_result['membership_comparison']
            click.echo(f"\nCluster Membership Overlap:")
            click.echo(f"  Average Jaccard similarity: {memb_comp['overall_similarity']:.2%}")
            click.echo(f"  Status: {'✓ PASS' if memb_comp['match_status'] else '✗ FAIL'} (threshold: {jaccard_threshold:.2%})")

            if show_mappings:
                click.echo(f"\n  Cluster Mapping (Python → Clojure):")
                for py_idx, (clj_idx, jaccard) in memb_comp['mapping'].items():
                    py_size = len(python_clusters[py_idx]['members'])
                    clj_size = len(clojure_clusters[clj_idx]['members'])
                    status = '✓' if jaccard >= jaccard_threshold else '✗'
                    click.echo(f"    {status} Group {py_idx} ({py_size} members) → Group {clj_idx} ({clj_size} members): {jaccard:.2%}")

            # Compare PCA projections if available
            if 'proj' in clojure_output and hasattr(conv, 'pca') and conv.pca:
                from polismath.regression.clojure_comparer import compare_projections

                click.echo(f"\n--- PCA Projection Comparison ---")

                # Get Python projections
                python_proj = {}
                if conv.pca and 'projections' in conv.pca:
                    for proj_item in conv.pca['projections']:
                        pid = proj_item['pid']
                        python_proj[str(pid)] = [proj_item['x'], proj_item['y']]

                clojure_proj = clojure_output['proj']

                proj_result = compare_projections(python_proj, clojure_proj)

                click.echo(f"  Best transformation: {proj_result['best_transformation']}")
                click.echo(f"  Same quadrant: {proj_result['same_quadrant_percentage']:.2%}")
                click.echo(f"  Average distance: {proj_result['average_distance']:.4f}")
                click.echo(f"  Distribution similarity: {proj_result['distribution_similarity']:.2%}")

                if show_projections:
                    click.echo(f"  Common participants: {proj_result['common_participants']}")

            # Overall result
            passed = cluster_result['overall_match']
            results_summary[dataset] = passed

            click.echo(f"\n{'='*60}")
            if passed:
                click.echo(f"✓ {dataset}: PASS")
            else:
                click.echo(f"✗ {dataset}: FAIL")
                click.echo(f"  See docs/PLAN_DISCREPANCY_FIXES.md for known discrepancies")
            click.echo(f"{'='*60}")

        except Exception as e:
            click.echo(f"✗ Error processing {dataset}: {e}", err=True)
            if log_level == 'DEBUG':
                import traceback
                traceback.print_exc()
            results_summary[dataset] = False

    # Print final summary
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
        click.echo("\nNote: Failures may be due to remaining Python-Clojure discrepancies.")
        click.echo("See docs/PLAN_DISCREPANCY_FIXES.md for the fix plan.")
        return 1
    else:
        click.echo("\n✓ All datasets passed!")
        return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
