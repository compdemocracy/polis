#!/usr/bin/env python3
"""
Visualize and compare clustering results between different math blob sources.

This script generates side-by-side and overlay visualizations comparing:
- Comparison A: Golden snapshot (Python) vs Cold-start Clojure blob
- Comparison B: Cold-start Clojure blob vs Regular Clojure blob

The visualizations focus on the final group clustering layer, showing convex hulls
around base cluster centers with comprehensive comparison metrics.
"""

import json
import logging
import traceback
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

import click
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon
from scipy.spatial import ConvexHull

# Add parent directory to path for imports
from polismath.regression import (
    discover_datasets,
    list_available_datasets,
    get_dataset_files,
    get_dataset_info
)
from polismath.regression.clojure_comparer import compare_cluster_membership


logger = logging.getLogger(__name__)


def unfold_base_clusters(folded: Dict) -> List[Dict]:
    """
    Convert folded base-clusters format to list of cluster dicts.

    Args:
        folded: Folded format with 'id', 'members', 'x', 'y', 'count' arrays

    Returns:
        List of cluster dicts with 'id', 'members', 'center' fields
    """
    if isinstance(folded, list):
        # Already unfolded
        return folded

    return [
        {
            'id': id_val,
            'members': members,
            'center': [x, y]
        }
        for id_val, members, x, y in zip(
            folded['id'],
            folded['members'],
            folded['x'],
            folded['y']
        )
    ]


def detect_pca_sign_flips(
    reference_pca: Dict,
    target_pca: Dict,
    correlation_threshold: float = 0.9
) -> List[int]:
    """
    Detect which PCA components are sign-flipped between reference and target.

    PCA components can have arbitrary sign direction. This function compares
    the correlation between corresponding components to detect flips.

    Args:
        reference_pca: Reference PCA dict with 'comps' key
        target_pca: Target PCA dict with 'comps' key
        correlation_threshold: Minimum absolute correlation to consider components matched

    Returns:
        List of sign multipliers for each component: [1, -1] means PC1 unchanged, PC2 flipped
    """
    ref_comps = reference_pca.get('comps', [])
    tgt_comps = target_pca.get('comps', [])

    if not ref_comps or not tgt_comps:
        logger.warning("No PCA components found for sign flip detection")
        return [1, 1]  # Default: no flip

    n_components = min(len(ref_comps), len(tgt_comps))
    sign_flips = []

    for i in range(n_components):
        ref_comp = np.array(ref_comps[i])
        tgt_comp = np.array(tgt_comps[i])

        # Handle different lengths (use common subset)
        min_len = min(len(ref_comp), len(tgt_comp))
        ref_comp = ref_comp[:min_len]
        tgt_comp = tgt_comp[:min_len]

        # Compute correlation
        if np.std(ref_comp) > 0 and np.std(tgt_comp) > 0:
            correlation = np.corrcoef(ref_comp, tgt_comp)[0, 1]
        else:
            correlation = 0

        # Determine sign flip based on correlation
        if correlation < -correlation_threshold:
            # Strong negative correlation = sign flipped
            sign_flips.append(-1)
            logger.info(f"  PC{i+1}: sign-flipped (correlation={correlation:.4f})")
        elif correlation > correlation_threshold:
            # Strong positive correlation = no flip
            sign_flips.append(1)
            logger.debug(f"  PC{i+1}: no flip (correlation={correlation:.4f})")
        else:
            # Weak correlation - assume no flip but warn
            sign_flips.append(1)
            logger.warning(f"  PC{i+1}: weak correlation ({correlation:.4f}), assuming no flip")

    return sign_flips


def apply_sign_flips_to_clusters(
    clusters: List[Dict],
    sign_flips: List[int]
) -> List[Dict]:
    """
    Apply PCA sign flips to cluster centers.

    Args:
        clusters: List of cluster dicts with 'center' as [x, y]
        sign_flips: List of sign multipliers [sign_x, sign_y]

    Returns:
        New list of clusters with corrected centers
    """
    if sign_flips == [1, 1]:
        return clusters  # No changes needed

    corrected = []
    for cluster in clusters:
        new_cluster = cluster.copy()
        center = cluster['center']
        # Apply sign flips to each coordinate
        new_center = [
            center[i] * sign_flips[i] if i < len(sign_flips) else center[i]
            for i in range(len(center))
        ]
        new_cluster['center'] = new_center
        corrected.append(new_cluster)

    return corrected


def apply_sign_flips_to_group_clusters(
    group_clusters: List[Dict],
    sign_flips: List[int]
) -> List[Dict]:
    """
    Apply PCA sign flips to group cluster centers if they have center coordinates.

    Args:
        group_clusters: List of group cluster dicts
        sign_flips: List of sign multipliers [sign_x, sign_y]

    Returns:
        New list of group clusters with corrected centers
    """
    if sign_flips == [1, 1]:
        return group_clusters

    corrected = []
    for group in group_clusters:
        new_group = group.copy()
        if 'center' in group:
            center = group['center']
            new_center = [
                center[i] * sign_flips[i] if i < len(sign_flips) else center[i]
                for i in range(len(center))
            ]
            new_group['center'] = new_center
        corrected.append(new_group)

    return corrected


def load_cluster_data(file_path: str) -> Dict[str, Any]:
    """
    Load cluster data from math blob or golden snapshot.

    Handles both formats:
    - Golden snapshot: stages.after_clustering.{group_clusters, base-clusters}
    - Math blob: {group-clusters, base-clusters} at top level

    Args:
        file_path: Path to JSON file

    Returns:
        Dict with 'group_clusters', 'base_clusters' (both unfolded), and 'pca' data
    """
    logger.info(f"Loading cluster data from {file_path}")

    with open(file_path, 'r') as f:
        data = json.load(f)

    pca_data = {}

    # Check if this is a golden snapshot (has 'stages' key)
    if 'stages' in data:
        logger.debug("Detected golden snapshot format")
        after_clustering = data['stages']['after_clustering']

        # Extract group_clusters (underscore in golden snapshots)
        group_clusters = after_clustering.get('group_clusters', [])

        # Extract base-clusters (hyphen in golden snapshots)
        base_clusters_raw = after_clustering.get('base-clusters', [])

        # Extract PCA data from after_pca stage
        after_pca = data['stages'].get('after_pca', {})
        pca_data = after_pca.get('pca', {})

    else:
        logger.debug("Detected math blob format")

        # Extract group-clusters (hyphen in math blobs)
        group_clusters = data.get('group-clusters', [])

        # Extract base-clusters (hyphen in math blobs, may be folded)
        base_clusters_raw = data.get('base-clusters', [])

        # Extract PCA data from top level
        pca_data = data.get('pca', {})

    # Unfold base-clusters if needed
    if isinstance(base_clusters_raw, dict):
        base_clusters = unfold_base_clusters(base_clusters_raw)
    else:
        base_clusters = base_clusters_raw

    logger.info(f"Loaded {len(group_clusters)} group clusters and {len(base_clusters)} base clusters")

    # Warn if no group clusters found
    if len(group_clusters) == 0:
        logger.warning(f"No group clusters found in {file_path}. This may be a cold-start blob that hasn't completed two-level clustering yet.")

    return {
        'group_clusters': group_clusters,
        'base_clusters': base_clusters,
        'pca': pca_data
    }


def get_base_cluster_positions(
    group_cluster: Dict,
    base_clusters: List[Dict]
) -> np.ndarray:
    """
    Get 2D positions of base clusters belonging to a group.

    Args:
        group_cluster: Group cluster with 'members' (base cluster IDs)
        base_clusters: List of all base clusters with 'center' coordinates

    Returns:
        Array of shape (n_members, 2) with x, y coordinates
    """
    member_ids = set(group_cluster['members'])

    # Build ID to cluster mapping for efficiency
    id_to_cluster = {bc['id']: bc for bc in base_clusters}

    # Extract centers for members
    positions = []
    for member_id in member_ids:
        if member_id in id_to_cluster:
            positions.append(id_to_cluster[member_id]['center'])
        else:
            logger.warning(f"Base cluster {member_id} not found in base_clusters")

    return np.array(positions)


def plot_group_clusters_with_hulls(
    group_clusters: List[Dict],
    base_clusters: List[Dict],
    ax: plt.Axes,
    title: Optional[str],
    colors: Optional[List] = None,
    fill: bool = True,
    marker: str = 'o',
    linestyle: str = '-',
    alpha: float = 0.3,
    add_legend: bool = True
) -> None:
    """
    Plot group clusters with convex hulls.

    For each group:
    1. Extract base cluster centers that are members
    2. Plot base cluster positions as scatter points
    3. Draw convex hull around them (using scipy.spatial.ConvexHull)
    4. Color-code by group ID

    Args:
        group_clusters: List of group cluster dicts
        base_clusters: List of base cluster dicts
        ax: Matplotlib axes to plot on
        title: Plot title (None to skip)
        colors: Color palette (None to use default)
        fill: Whether to fill convex hulls
        marker: Marker style for scatter points
        linestyle: Line style for convex hull edges
        alpha: Transparency for convex hulls
        add_legend: Whether to add legend
    """
    # Use a color palette
    if colors is None:
        colors = plt.cm.tab10.colors

    for group in group_clusters:
        group_id = group['id']

        # Get positions of base clusters in this group
        positions = get_base_cluster_positions(group, base_clusters)

        if len(positions) == 0:
            logger.warning(f"Group {group_id} has no valid base cluster positions")
            continue

        color = colors[group_id % len(colors)]

        if len(positions) < 3:
            # Can't compute convex hull with < 3 points
            # Just plot the points
            ax.scatter(
                positions[:, 0], positions[:, 1],
                color=color,
                alpha=0.6,
                s=50,
                marker=marker,
                label=f"Group {group_id}"
            )
        else:
            # Compute and plot convex hull
            try:
                hull = ConvexHull(positions)
                polygon = Polygon(
                    positions[hull.vertices],
                    fill=fill,
                    facecolor=color if fill else 'none',
                    edgecolor=color,
                    alpha=alpha if fill else 1.0,  # Keep edges visible when not filling
                    linewidth=2 if fill else 3,  # Thicker lines for outline-only
                    linestyle=linestyle
                )
                ax.add_patch(polygon)

                # Plot base cluster centers
                ax.scatter(
                    positions[:, 0], positions[:, 1],
                    color=color,
                    alpha=0.6,
                    s=50,
                    marker=marker,
                    label=f"Group {group_id}",
                    facecolors=color if marker == 'o' else 'none',
                    edgecolors=color if marker != 'o' else color
                )
            except Exception as e:
                logger.warning(f"Failed to compute convex hull for group {group_id}: {e}")
                # Fall back to just plotting points
                ax.scatter(
                    positions[:, 0], positions[:, 1],
                    color=color,
                    alpha=0.6,
                    s=50,
                    marker=marker,
                    label=f"Group {group_id}"
                )

    ax.set_xlabel("PC1", fontsize=10)
    ax.set_ylabel("PC2", fontsize=10)
    if title:
        ax.set_title(title, fontsize=11, fontweight='bold')
    if add_legend and len(group_clusters) > 0:
        ax.legend(loc='best', fontsize=8, framealpha=0.9)
    ax.grid(True, alpha=0.3)
    ax.set_aspect('equal', adjustable='datalim')


def create_sidebyside_comparison(
    data_a: Dict,
    data_b: Dict,
    dataset_name: str,
    label_a: str,
    label_b: str,
    output_path: str,
    metrics: Dict[str, Any],
    figsize: Tuple[int, int] = (12, 6),
    dpi: int = 150
) -> None:
    """
    Create side-by-side comparison figure.

    Args:
        data_a: First clustering data
        data_b: Second clustering data
        dataset_name: Name of dataset
        label_a: Label for first clustering
        label_b: Label for second clustering
        output_path: Where to save figure
        metrics: Comparison metrics to display
        figsize: Figure size
        dpi: Resolution
    """
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=figsize)

    plot_group_clusters_with_hulls(
        data_a['group_clusters'],
        data_a['base_clusters'],
        ax1,
        f"{dataset_name}\n{label_a}"
    )

    plot_group_clusters_with_hulls(
        data_b['group_clusters'],
        data_b['base_clusters'],
        ax2,
        f"{dataset_name}\n{label_b}"
    )

    # Synchronize axis limits for direct comparison
    xlim1, xlim2 = ax1.get_xlim(), ax2.get_xlim()
    ylim1, ylim2 = ax1.get_ylim(), ax2.get_ylim()
    shared_xlim = (min(xlim1[0], xlim2[0]), max(xlim1[1], xlim2[1]))
    shared_ylim = (min(ylim1[0], ylim2[0]), max(ylim1[1], ylim2[1]))
    ax1.set_xlim(shared_xlim)
    ax2.set_xlim(shared_xlim)
    ax1.set_ylim(shared_ylim)
    ax2.set_ylim(shared_ylim)

    # Add overall metrics as figure suptitle
    metrics_text = (
        f"Groups: {metrics['n_groups_a']} vs {metrics['n_groups_b']} | "
        f"Jaccard: {metrics['jaccard_similarity']:.3f}"
    )
    if metrics.get('avg_center_distance') is not None:
        metrics_text += f" | Avg center dist: {metrics['avg_center_distance']:.3f}"

    fig.suptitle(metrics_text, fontsize=10, y=0.98)

    plt.tight_layout(rect=[0, 0, 1, 0.96])
    plt.savefig(output_path, dpi=dpi, bbox_inches='tight')
    plt.close()
    logger.info(f"Saved side-by-side comparison to {output_path}")


def create_overlay_comparison(
    data_a: Dict,
    data_b: Dict,
    dataset_name: str,
    label_a: str,
    label_b: str,
    output_path: str,
    metrics: Dict[str, Any],
    figsize: Tuple[int, int] = (10, 8),
    dpi: int = 150
) -> None:
    """
    Create overlay comparison figure with filled vs outline distinction.

    data_a is plotted with filled convex hulls and solid circular markers.
    data_b is plotted with dashed outlines and hollow square markers.

    Args:
        data_a: First clustering data (will be filled)
        data_b: Second clustering data (will be outlined)
        dataset_name: Name of dataset
        label_a: Label for first clustering
        label_b: Label for second clustering
        output_path: Where to save figure
        metrics: Comparison metrics to display
        figsize: Figure size
        dpi: Resolution
    """
    fig, ax = plt.subplots(figsize=figsize)

    # Plot data_a with solid fill and filled circular markers
    plot_group_clusters_with_hulls(
        data_a['group_clusters'],
        data_a['base_clusters'],
        ax,
        f"{dataset_name}\n{label_a} (filled) vs {label_b} (outline)",
        fill=True,
        marker='o',
        linestyle='-',
        alpha=0.3,
        add_legend=True
    )

    # Plot data_b with dashed outlines and hollow square markers
    # Use different color offset to avoid color collisions
    colors_b = plt.cm.tab20.colors[10:]  # Use second half of tab20
    plot_group_clusters_with_hulls(
        data_b['group_clusters'],
        data_b['base_clusters'],
        ax,
        title=None,  # Don't overwrite title
        colors=colors_b,
        fill=False,
        marker='s',  # Square markers for distinction
        linestyle='--',
        alpha=0.6,
        add_legend=True
    )

    # Add metrics annotation
    metrics_text = (
        f"Groups: {metrics['n_groups_a']} vs {metrics['n_groups_b']}\n"
        f"Jaccard: {metrics['jaccard_similarity']:.3f}\n"
        f"Matched: {metrics.get('matched_groups', 'N/A')}"
    )
    if metrics.get('avg_center_distance') is not None:
        metrics_text += f"\nAvg center dist: {metrics['avg_center_distance']:.3f}"

    ax.text(
        0.02, 0.98, metrics_text,
        transform=ax.transAxes,
        verticalalignment='top',
        bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.8),
        fontsize=9,
        family='monospace'
    )

    plt.tight_layout()
    plt.savefig(output_path, dpi=dpi, bbox_inches='tight')
    plt.close()
    logger.info(f"Saved overlay comparison to {output_path}")


def compute_center_distances(
    clusters_a: List[Dict],
    clusters_b: List[Dict]
) -> List[float]:
    """
    Compute Euclidean distances between aligned cluster centers.

    Assumes clusters are sorted by ID.

    Args:
        clusters_a: First set of clusters
        clusters_b: Second set of clusters

    Returns:
        List of distances
    """
    distances = []
    for ca, cb in zip(
        sorted(clusters_a, key=lambda x: x['id']),
        sorted(clusters_b, key=lambda x: x['id'])
    ):
        center_a = np.array(ca['center'])
        center_b = np.array(cb['center'])
        dist = np.linalg.norm(center_a - center_b)
        distances.append(float(dist))
    return distances


def compute_comparison_metrics(
    data_a: Dict,
    data_b: Dict
) -> Dict[str, Any]:
    """
    Compute comprehensive metrics comparing two clusterings.

    Args:
        data_a: First clustering data
        data_b: Second clustering data

    Returns:
        Dict with comparison metrics including:
        - n_groups_a, n_groups_b: Group counts
        - size_distribution_a, size_distribution_b: Size distributions
        - jaccard_similarity: Jaccard similarity score
        - matched_groups: Number of matched groups
        - avg_center_distance, max_center_distance: Center distances (if applicable)
    """
    metrics = {}

    # Basic counts
    metrics['n_groups_a'] = len(data_a['group_clusters'])
    metrics['n_groups_b'] = len(data_b['group_clusters'])

    # Size distributions
    metrics['size_distribution_a'] = [
        len(g['members']) for g in data_a['group_clusters']
    ]
    metrics['size_distribution_b'] = [
        len(g['members']) for g in data_b['group_clusters']
    ]

    # Jaccard similarity
    try:
        membership_result = compare_cluster_membership(
            data_a['group_clusters'],
            data_b['group_clusters'],
            min_jaccard=0.0  # Get score regardless of threshold
        )
        metrics['jaccard_similarity'] = membership_result.get('best_match_jaccard', 0.0)
        metrics['matched_groups'] = membership_result.get('n_matched', 0)
    except Exception as e:
        logger.warning(f"Failed to compute Jaccard similarity: {e}")
        metrics['jaccard_similarity'] = 0.0
        metrics['matched_groups'] = 0

    # Center distances (if groups can be aligned)
    if metrics['n_groups_a'] == metrics['n_groups_b'] and metrics['n_groups_a'] > 0:
        try:
            distances = compute_center_distances(
                data_a['group_clusters'],
                data_b['group_clusters']
            )
            metrics['avg_center_distance'] = float(np.mean(distances)) if distances else None
            metrics['max_center_distance'] = float(np.max(distances)) if distances else None
            metrics['center_distances'] = distances
        except Exception as e:
            logger.warning(f"Failed to compute center distances: {e}")
            metrics['avg_center_distance'] = None
            metrics['max_center_distance'] = None
    else:
        metrics['avg_center_distance'] = None
        metrics['max_center_distance'] = None

    return metrics


@click.command()
@click.argument('datasets', nargs=-1)
@click.option('--all', 'process_all', is_flag=True, help='Process all datasets')
@click.option('--include-local', is_flag=True, default=False,
              help='Include datasets from real_data/.local/')
@click.option('--output-dir', default='scripts/outputs/cluster_visualizations',
              help='Output directory for visualizations')
@click.option('--log-level', type=click.Choice(['DEBUG', 'INFO', 'WARNING', 'ERROR'],
              case_sensitive=False), default='INFO',
              help='Logging level')
@click.option('--dpi', default=150, help='DPI for saved figures')
@click.option('--figsize', default='12,6',
              help='Figure size for side-by-side plots as width,height')
def main(
    datasets: tuple,
    process_all: bool,
    include_local: bool,
    output_dir: str,
    log_level: str,
    dpi: int,
    figsize: str
):
    """
    Visualize and compare clustering results between different sources.

    Generates two types of comparisons for each dataset:
    - Comparison A: Golden snapshot (Python) vs Cold-start Clojure blob
    - Comparison B: Cold-start vs Regular Clojure blobs

    Examples:
        # Single dataset
        python visualize_cluster_comparison.py biodiversity

        # Multiple datasets
        python visualize_cluster_comparison.py biodiversity vw american-assembly

        # All datasets
        python visualize_cluster_comparison.py --all

        # Include local datasets
        python visualize_cluster_comparison.py --all --include-local
    """
    # Setup logging
    logging.basicConfig(
        level=getattr(logging, log_level.upper()),
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        force=True
    )

    # Parse figsize
    try:
        figsize_tuple = tuple(map(int, figsize.split(',')))
        if len(figsize_tuple) != 2:
            raise ValueError
    except ValueError:
        click.echo("Error: --figsize must be in format 'width,height' (e.g., '12,6')", err=True)
        raise click.Abort()

    # Dataset discovery and validation
    available_datasets = list_available_datasets(include_local=include_local)

    if process_all:
        datasets = list(available_datasets.keys())
        location = "committed + local" if include_local else "committed"
        click.echo(f"Processing all {len(datasets)} {location} dataset(s): {', '.join(datasets)}\n")
    elif datasets:
        # Validate that specified datasets exist
        invalid_datasets = [d for d in datasets if d not in available_datasets]
        if invalid_datasets:
            available = ', '.join(available_datasets.keys())
            click.echo(f"Error: Unknown dataset(s): {', '.join(invalid_datasets)}", err=True)
            click.echo(f"Available datasets: {available}", err=True)
            raise click.Abort()
        click.echo(f"Processing {len(datasets)} dataset(s): {', '.join(datasets)}\n")
    else:
        click.echo("Error: Please specify dataset name(s) or use --all", err=True)
        click.echo(f"Available datasets: {', '.join(available_datasets.keys())}", err=True)
        raise click.Abort()

    # Create base output directory
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    results_summary = {}

    for dataset in datasets:
        click.echo(f"\n{'='*60}")
        click.echo(f"Visualizing: {dataset}")
        click.echo(f"{'='*60}\n")

        try:
            # Check if dataset has required files
            info = get_dataset_info(dataset)
            if not info.has_golden:
                click.echo(f"⚠  No golden snapshot for {dataset}, skipping")
                results_summary[dataset] = False
                continue

            # Create output directory for this dataset
            output_dir_dataset = output_path / dataset
            output_dir_dataset.mkdir(parents=True, exist_ok=True)

            # Load golden snapshot (Python reference)
            files = get_dataset_files(dataset)
            golden_path = Path(files['data_dir']) / 'golden_snapshot.json'
            golden_data = load_cluster_data(str(golden_path))

            # === COMPARISON A: Golden (Python) vs Cold-start (Clojure) ===
            if info.has_cold_start_blob:
                click.echo("  Generating Comparison A: Golden vs Cold-start...")
                files_cold = get_dataset_files(dataset, prefer_cold_start=True)
                coldstart_data_raw = load_cluster_data(files_cold['math_blob'])

                # Detect and correct PCA sign flips (golden is reference)
                click.echo("  Detecting PCA sign flips (golden -> cold-start)...")
                sign_flips_a = detect_pca_sign_flips(golden_data['pca'], coldstart_data_raw['pca'])
                if sign_flips_a != [1, 1]:
                    click.echo(f"    Sign flips detected: {sign_flips_a}")
                    coldstart_data = {
                        'group_clusters': apply_sign_flips_to_group_clusters(
                            coldstart_data_raw['group_clusters'], sign_flips_a
                        ),
                        'base_clusters': apply_sign_flips_to_clusters(
                            coldstart_data_raw['base_clusters'], sign_flips_a
                        ),
                        'pca': coldstart_data_raw['pca']
                    }
                else:
                    click.echo("    No sign flips detected")
                    coldstart_data = coldstart_data_raw

                metrics_a = compute_comparison_metrics(golden_data, coldstart_data)
                metrics_a['sign_flips'] = sign_flips_a

                sidebyside_path = (output_dir_dataset / f"{dataset}_golden_vs_coldstart_sidebyside.png").resolve()
                create_sidebyside_comparison(
                    golden_data, coldstart_data, dataset,
                    "Golden (Python)", "Cold-start (Clojure, sign-corrected)",
                    str(sidebyside_path),
                    metrics_a, figsize=figsize_tuple, dpi=dpi
                )
                click.echo(f"    → {sidebyside_path}")

                overlay_path = (output_dir_dataset / f"{dataset}_golden_vs_coldstart_overlay.png").resolve()
                create_overlay_comparison(
                    golden_data, coldstart_data, dataset,
                    "Golden (Python)", "Cold-start (Clojure, sign-corrected)",
                    str(overlay_path),
                    metrics_a, figsize=(10, 8), dpi=dpi
                )
                click.echo(f"    → {overlay_path}")

                with open(output_dir_dataset / f"{dataset}_golden_vs_coldstart_metrics.json", 'w') as f:
                    json.dump(metrics_a, f, indent=2)

            # === COMPARISON B: Cold-start vs Regular (both Clojure) ===
            if info.has_cold_start_blob and info.has_math_blob:
                files_cold = get_dataset_files(dataset, prefer_cold_start=True)
                files_regular = get_dataset_files(dataset, prefer_cold_start=False)

                # Only proceed if they're different files
                if files_cold['math_blob'] != files_regular['math_blob']:
                    click.echo("  Generating Comparison B: Cold-start vs Regular...")
                    coldstart_data_raw = load_cluster_data(files_cold['math_blob'])
                    regular_data = load_cluster_data(files_regular['math_blob'])

                    # Detect and correct PCA sign flips (regular is reference)
                    click.echo("  Detecting PCA sign flips (regular -> cold-start)...")
                    sign_flips_b = detect_pca_sign_flips(regular_data['pca'], coldstart_data_raw['pca'])
                    if sign_flips_b != [1, 1]:
                        click.echo(f"    Sign flips detected: {sign_flips_b}")
                        coldstart_data = {
                            'group_clusters': apply_sign_flips_to_group_clusters(
                                coldstart_data_raw['group_clusters'], sign_flips_b
                            ),
                            'base_clusters': apply_sign_flips_to_clusters(
                                coldstart_data_raw['base_clusters'], sign_flips_b
                            ),
                            'pca': coldstart_data_raw['pca']
                        }
                    else:
                        click.echo("    No sign flips detected")
                        coldstart_data = coldstart_data_raw

                    metrics_b = compute_comparison_metrics(coldstart_data, regular_data)
                    metrics_b['sign_flips'] = sign_flips_b

                    coldstart_label = "Cold-start (sign-corrected)" if sign_flips_b != [1, 1] else "Cold-start"
                    sidebyside_path_b = (output_dir_dataset / f"{dataset}_coldstart_vs_regular_sidebyside.png").resolve()
                    create_sidebyside_comparison(
                        coldstart_data, regular_data, dataset,
                        coldstart_label, "Regular",
                        str(sidebyside_path_b),
                        metrics_b, figsize=figsize_tuple, dpi=dpi
                    )
                    click.echo(f"    → {sidebyside_path_b}")

                    overlay_path_b = (output_dir_dataset / f"{dataset}_coldstart_vs_regular_overlay.png").resolve()
                    create_overlay_comparison(
                        coldstart_data, regular_data, dataset,
                        coldstart_label, "Regular",
                        str(overlay_path_b),
                        metrics_b, figsize=(10, 8), dpi=dpi
                    )
                    click.echo(f"    → {overlay_path_b}")

                    with open(output_dir_dataset / f"{dataset}_coldstart_vs_regular_metrics.json", 'w') as f:
                        json.dump(metrics_b, f, indent=2)

            click.echo(f"  ✓ Done with {dataset}")
            results_summary[dataset] = True

        except Exception as e:
            click.echo(f"✗ Error: {e}", err=True)
            traceback.print_exc()
            results_summary[dataset] = False

    # Print summary
    click.echo(f"\n{'='*60}")
    click.echo("VISUALIZATION SUMMARY")
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
        click.echo("\nSome datasets failed visualization!", err=True)
        exit(1)
    else:
        click.echo("\n✓ All datasets visualized successfully!")
        exit(0)


if __name__ == "__main__":
    main()
