#!/usr/bin/env python3
"""
Investigate why Python and Clojure pick different k values for group clustering.

On vw: Python picks k=4, Clojure picks k=2. Both use silhouette maximization.
This script isolates the source of divergence by comparing each pipeline stage.

Usage:
    cd delphi
    uv run python scripts/investigate_k_divergence.py [--dataset vw|biodiversity|...]
"""

import argparse
import json
import logging
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from polismath.conversation.conversation import Conversation
from polismath.pca_kmeans_rep.clusters import (
    calculate_silhouette_sklearn,
    kmeans_sklearn,
)
from polismath.pca_kmeans_rep.pca import pca_project_dataframe
from polismath.regression.datasets import get_dataset_files
from polismath.regression.utils import prepare_votes_data

logging.basicConfig(level=logging.WARNING, format="%(message)s")
logger = logging.getLogger(__name__)


def load_clojure_blob(dataset_name: str, blob_type: str = "cold_start") -> dict:
    """Load a Clojure math blob for the given dataset."""
    files = get_dataset_files(dataset_name, blob_type=blob_type)
    blob_path = files.get("math_blob")
    if not blob_path:
        raise FileNotFoundError(f"No {blob_type} blob for {dataset_name}")
    with open(blob_path) as f:
        return json.load(f)


def load_dataset_and_run_python(dataset_name: str) -> Conversation:
    """Load a dataset and run the Python pipeline."""
    votes_dict, metadata = prepare_votes_data(dataset_name)
    conv = Conversation(dataset_name, last_updated=metadata["fixed_timestamp"])
    conv = conv.update_votes(votes_dict, recompute=True)
    return conv


def extract_clojure_projections(blob: dict) -> dict:
    """Extract participant projections from Clojure blob's base-clusters."""
    bc = blob["base-clusters"]
    proj = {}
    for members, x, y in zip(bc["members"], bc["x"], bc["y"]):
        for pid in members:
            proj[pid] = np.array([x, y])
    return proj


def compare_pca_components(python_pca: dict, clojure_pca: dict) -> None:
    """Compare PCA components between Python and Clojure."""
    py_comps = np.asarray(python_pca["comps"])
    clj_comps = np.array(clojure_pca["comps"])

    print("\n=== PCA Component Comparison ===")
    print(f"  Python components shape: {py_comps.shape}")
    print(f"  Clojure components shape: {clj_comps.shape}")

    for i in range(min(len(py_comps), len(clj_comps))):
        cos_sim = np.dot(py_comps[i], clj_comps[i]) / (
            np.linalg.norm(py_comps[i]) * np.linalg.norm(clj_comps[i])
        )
        cos_sim_abs = abs(cos_sim)
        sign = "+" if cos_sim > 0 else "-"
        print(f"  PC{i+1} cosine similarity: {cos_sim:+.6f} (|cos|={cos_sim_abs:.6f}, sign={sign})")
        if cos_sim_abs < 0.99:
            print(f"    *** SIGNIFICANT DIVERGENCE (|cos| < 0.99) ***")

    # Compare centers
    py_center = np.asarray(python_pca["center"])
    clj_center = np.array(clojure_pca["center"])
    center_diff = np.max(np.abs(py_center - clj_center))
    norms = np.linalg.norm(py_center) * np.linalg.norm(clj_center)
    center_cos = np.dot(py_center, clj_center) / norms if norms > 0 else 0
    print(f"  Center max absolute diff: {center_diff:.6f}")
    print(f"  Center cosine similarity: {center_cos:.6f}")


def compare_projections(python_proj: dict, clojure_proj: dict) -> None:
    """Compare participant projections between Python and Clojure."""
    common_pids = sorted(set(python_proj.keys()) & set(clojure_proj.keys()))
    py_only = set(python_proj.keys()) - set(clojure_proj.keys())
    clj_only = set(clojure_proj.keys()) - set(python_proj.keys())

    print("\n=== Projection Comparison ===")
    print(f"  Common participants: {len(common_pids)}")
    if py_only:
        print(f"  Python-only: {len(py_only)} {sorted(py_only)[:10]}...")
    if clj_only:
        print(f"  Clojure-only: {len(clj_only)} {sorted(clj_only)[:10]}...")

    if not common_pids:
        print("  No common participants to compare!")
        return

    py_arr = np.array([python_proj[pid] for pid in common_pids])
    clj_arr = np.array([clojure_proj[pid] for pid in common_pids])

    diffs = py_arr - clj_arr
    print(f"  Max absolute diff: {np.max(np.abs(diffs)):.4f}")
    print(f"  Mean absolute diff: {np.mean(np.abs(diffs)):.4f}")
    print(f"  RMS diff: {np.sqrt(np.mean(diffs**2)):.4f}")

    # Python range vs Clojure range
    for dim in range(min(py_arr.shape[1], 2)):
        py_range = py_arr[:, dim].max() - py_arr[:, dim].min()
        clj_range = clj_arr[:, dim].max() - clj_arr[:, dim].min()
        print(f"  Dim {dim} range: Python={py_range:.4f}, Clojure={clj_range:.4f}")

    # Check correlation per dimension (sign-aware and sign-agnostic)
    for dim in range(min(py_arr.shape[1], 2)):
        corr = np.corrcoef(py_arr[:, dim], clj_arr[:, dim])[0, 1]
        print(f"  Dim {dim} Pearson correlation: {corr:+.6f}")

    # Show first few participants
    print("\n  First 5 participants (pid: python → clojure):")
    for pid in common_pids[:5]:
        py = python_proj[pid]
        clj = clojure_proj[pid]
        print(f"    pid={pid}: [{py[0]:8.4f}, {py[1]:8.4f}] → [{clj[0]:8.4f}, {clj[1]:8.4f}]")


def run_clustering_with_projections(
    projections: dict,
    label: str,
    max_k: int = 5,
) -> int:
    """Run group clustering on given projections and return selected k."""
    pids = sorted(projections.keys())
    proj_array = np.array([projections[pid] for pid in pids])

    n_points = len(pids)
    base_k = min(100, n_points)

    print(f"\n=== Clustering with {label} ({n_points} participants) ===")

    # Step 1: Base clustering
    base_labels, base_centers, base_member_lists = kmeans_sklearn(
        proj_array, k=base_k, max_iters=100
    )
    n_base = len(base_centers)
    base_sizes = [len(m) for m in base_member_lists]
    print(f"  Base clusters: {n_base} (sizes: min={min(base_sizes)}, max={max(base_sizes)}, "
          f"singletons={sum(1 for s in base_sizes if s == 1)})")

    # Step 2: Group clustering with silhouette selection
    eff_max_k = min(max_k, 2 + n_base // 12)
    eff_max_k = max(2, min(eff_max_k, n_base))

    base_weights = np.array([len(m) for m in base_member_lists])

    best_k = 2
    best_score = -1

    for k in range(2, eff_max_k + 1):
        group_labels, group_centers, group_member_lists = kmeans_sklearn(
            base_centers, k=k, max_iters=100, weights=base_weights
        )
        score = calculate_silhouette_sklearn(base_centers, group_labels)
        marker = ""
        if score > best_score:
            best_score = score
            best_k = k
            marker = " ← best"
        group_sizes = [len(m) for m in group_member_lists]
        print(f"  k={k}: silhouette={score:.6f}, sizes={group_sizes}{marker}")

    print(f"  Selected k={best_k}")
    return best_k


def run_silhouette_comparison(python_proj: dict, clojure_proj: dict) -> None:
    """Compare silhouette scores for the same clustering applied to both projection sets."""
    common_pids = sorted(set(python_proj.keys()) & set(clojure_proj.keys()))
    if not common_pids:
        return

    py_arr = np.array([python_proj[pid] for pid in common_pids])
    clj_arr = np.array([clojure_proj[pid] for pid in common_pids])

    print("\n=== Silhouette Cross-Comparison ===")
    print("  (Clj labels = labels from clustering Clj projections)")
    print("  (Py labels  = labels from clustering Py projections)")

    for k in [2, 3, 4, 5]:
        if k >= len(common_pids):
            break
        clj_labels, _, _ = kmeans_sklearn(clj_arr, k=k, max_iters=100)
        clj_sil_clj = silhouette_score(clj_arr, clj_labels)
        clj_sil_py = silhouette_score(py_arr, clj_labels)

        py_labels, _, _ = kmeans_sklearn(py_arr, k=k, max_iters=100)
        py_sil_py = silhouette_score(py_arr, py_labels)
        py_sil_clj = silhouette_score(clj_arr, py_labels)

        print(f"  k={k}:")
        print(f"    Clj labels → sil(clj)={clj_sil_clj:.4f}, sil(py)={clj_sil_py:.4f}")
        print(f"    Py  labels → sil(py)={py_sil_py:.4f},  sil(clj)={py_sil_clj:.4f}")


def investigate_pca_algorithm_impact(rating_mat: pd.DataFrame, clojure_pca: dict) -> None:
    """Analyze eigenvalue structure to understand PCA divergence potential."""
    print("\n=== PCA Algorithm Impact ===")

    matrix_data = rating_mat.to_numpy(dtype=float, copy=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        col_means = np.nanmean(matrix_data, axis=0)
    col_means = np.where(np.isnan(col_means), 0.0, col_means)
    nan_idx = np.where(np.isnan(matrix_data))
    matrix_imputed = matrix_data.copy()
    matrix_imputed[nan_idx] = col_means[nan_idx[1]]

    pca_sklearn = PCA(n_components=min(10, *matrix_imputed.shape), random_state=42)
    pca_sklearn.fit(matrix_imputed)

    evr = pca_sklearn.explained_variance_ratio_
    print(f"  Top 10 explained variance ratios:")
    for i, ev in enumerate(evr):
        cum = sum(evr[:i+1])
        print(f"    PC{i+1}: {ev:.4f} (cumulative: {cum:.4f})")

    if len(evr) >= 2:
        ratio = evr[0] / evr[1]
        print(f"  EV1/EV2 ratio: {ratio:.4f}")
        if ratio < 2.0:
            print(f"    *** Small ratio — power iteration may converge to different subspace ***")
        else:
            print(f"    Eigenvalue gap is large — power iteration should agree with SVD")

    # NaN sparsity info
    total = matrix_data.size
    n_nan = np.isnan(matrix_data).sum()
    print(f"  Matrix shape: {matrix_data.shape}")
    print(f"  NaN sparsity: {n_nan}/{total} ({100*n_nan/total:.1f}%)")


def main():
    parser = argparse.ArgumentParser(description="Investigate K divergence")
    parser.add_argument("--dataset", default="vw", help="Dataset name (default: vw)")
    parser.add_argument(
        "--blob-type",
        default="cold_start",
        help="Blob type: cold_start or incremental (default: cold_start)",
    )
    args = parser.parse_args()

    dataset = args.dataset
    blob_type = args.blob_type

    print(f"{'='*60}")
    print(f"K-Divergence Investigation: {dataset} ({blob_type} blob)")
    print(f"{'='*60}")

    # Step 1: Load Clojure blob
    print(f"\nLoading Clojure {blob_type} blob...")
    blob = load_clojure_blob(dataset, blob_type=blob_type)

    clj_k = len(blob["group-clusters"])
    clj_group_sizes = [len(g["members"]) for g in blob["group-clusters"]]
    clj_n_base = len(blob["base-clusters"]["id"])
    clj_in_conv = blob.get("in-conv", [])
    print(f"  Clojure k={clj_k}, group sizes={clj_group_sizes}")
    print(f"  Clojure base clusters: {clj_n_base}")
    print(f"  Clojure in-conv: {len(clj_in_conv)} participants")

    # Step 2: Run Python pipeline
    print(f"\nRunning Python pipeline...")
    conv = load_dataset_and_run_python(dataset)

    py_k = len(conv.group_clusters) if conv.group_clusters else 0
    py_group_sizes = sorted(
        [len(g["members"]) for g in (conv.group_clusters or [])], reverse=True
    )
    py_n_base = len(conv.base_clusters) if conv.base_clusters else 0
    py_in_conv = conv._get_in_conv_participants()
    print(f"  Python k={py_k}, group sizes={py_group_sizes}")
    print(f"  Python base clusters: {py_n_base}")
    print(f"  Python in-conv: {len(py_in_conv)} participants")

    # Step 3: Compare in-conv sets
    clj_in_conv_set = set(clj_in_conv)
    py_in_conv_set = set(py_in_conv)
    in_conv_match = clj_in_conv_set == py_in_conv_set
    print(f"\n  In-conv sets match: {in_conv_match}")
    if not in_conv_match:
        print(f"    Python-only: {sorted(py_in_conv_set - clj_in_conv_set)[:10]}")
        print(f"    Clojure-only: {sorted(clj_in_conv_set - py_in_conv_set)[:10]}")

    # Step 4: Compare PCA
    compare_pca_components(conv.pca, blob["pca"])

    # Step 5: Compare projections
    clj_proj = extract_clojure_projections(blob)
    py_proj = conv.proj
    compare_projections(py_proj, clj_proj)

    # Step 6: PCA algorithm analysis
    investigate_pca_algorithm_impact(conv.rating_mat, blob["pca"])

    # Step 7: Clustering with Python projections (reproducing Python's choice)
    py_k_result = run_clustering_with_projections(
        {pid: py_proj[pid] for pid in py_in_conv if pid in py_proj},
        "Python PCA",
    )

    # Step 8: Clustering with Clojure projections (injection test)
    common_in_conv = py_in_conv_set & clj_in_conv_set
    clj_proj_filtered = {pid: clj_proj[pid] for pid in common_in_conv if pid in clj_proj}
    clj_k_result = run_clustering_with_projections(
        clj_proj_filtered,
        "Clojure PCA (injected)",
    )

    # Step 9: Cross-comparison of silhouette
    run_silhouette_comparison(
        {pid: py_proj[pid] for pid in common_in_conv if pid in py_proj},
        {pid: clj_proj[pid] for pid in common_in_conv if pid in clj_proj},
    )

    # Summary
    print(f"\n{'='*60}")
    print(f"SUMMARY")
    print(f"{'='*60}")
    print(f"  Clojure blob k:                {clj_k}")
    print(f"  Python pipeline k:             {py_k_result}")
    print(f"  Python clustering + Clj PCA k: {clj_k_result}")
    if clj_k_result == clj_k and py_k_result != clj_k:
        print(f"\n  >>> PCA is the primary source of k divergence <<<")
        print(f"  When Clojure projections are injected, Python picks the same k.")
    elif clj_k_result != clj_k:
        print(f"\n  >>> Clustering/silhouette also contributes to divergence <<<")
        print(f"  Even with Clojure projections, Python picks a different k.")
    else:
        print(f"\n  >>> k matches across all configurations <<<")


if __name__ == "__main__":
    main()
