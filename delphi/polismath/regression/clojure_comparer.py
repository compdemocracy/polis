"""
Utilities for comparing Python implementation with Clojure reference outputs.

This module provides functions to compare Python polismath outputs with
Clojure math_blob reference outputs. It adopts tolerance patterns from
polismath.regression.comparer for consistency.

These tests will be removed once the Clojure implementation is fully phased out.
"""

import json
import logging
from typing import Dict, Any, List, Tuple, Optional
import numpy as np

from polismath.regression.datasets import get_dataset_files

logger = logging.getLogger(__name__)


class ClojureComparer:
    """
    Compare Python outputs with Clojure math_blob outputs.

    Similar to ConversationComparer but specifically for Clojure compatibility testing.
    Provides configurable tolerance framework for numerical comparisons.
    """

    def __init__(
        self,
        abs_tolerance: float = 1e-8,
        rel_tolerance: float = 1e-6,
        jaccard_threshold: float = 0.95,
        distribution_tolerance: float = 0.05,
    ) -> None:
        """
        Initialize with tolerance configuration.

        Args:
            abs_tolerance: Absolute tolerance for numerical comparisons (very tight by default)
            rel_tolerance: Relative tolerance for numerical comparisons (very tight by default)
            jaccard_threshold: Minimum Jaccard similarity for cluster matching (default: 0.95)
            distribution_tolerance: Maximum L1 distance for distributions (default: 0.05)
        """
        self.abs_tol = abs_tolerance
        self.rel_tol = rel_tolerance
        self.jaccard_threshold = jaccard_threshold
        self.distribution_tolerance = distribution_tolerance
        self.differences = []
        self.warnings = []

    def compare_clusters(
        self,
        python_clusters: List[Dict[str, Any]],
        clojure_clusters: List[Dict[str, Any]],
        dataset_name: str = ""
    ) -> Dict[str, Any]:
        """
        Comprehensive cluster comparison combining distribution and membership analysis.

        Args:
            python_clusters: List of Python cluster dicts with 'members' and optionally 'center'
            clojure_clusters: List of Clojure cluster dicts with 'members' and optionally 'center'
            dataset_name: Name of dataset for logging

        Returns:
            Dict with:
            - distribution_comparison: Size distribution similarity results
            - membership_comparison: Cluster membership mapping results
            - overall_match: Boolean indicating if clusters match within tolerances
        """
        dist_result = compare_cluster_distributions(
            python_clusters,
            clojure_clusters,
            tolerance=self.distribution_tolerance
        )

        membership_result = compare_cluster_membership(
            python_clusters,
            clojure_clusters,
            min_jaccard=self.jaccard_threshold
        )

        overall_match = (
            dist_result.get('match_status', False) and
            membership_result.get('match_status', False)
        )

        if not overall_match:
            msg = f"[{dataset_name}] Clustering differences detected"
            logger.warning(msg)
            self.warnings.append(msg)

        return {
            'distribution_comparison': dist_result,
            'membership_comparison': membership_result,
            'overall_match': overall_match
        }


def load_clojure_math_blob(dataset_name: str) -> Dict[str, Any]:
    """
    Load Clojure math_blob.json for a dataset.

    Args:
        dataset_name: Name of the dataset (e.g., 'biodiversity', 'vw')

    Returns:
        Dictionary containing the Clojure math_blob output

    Raises:
        FileNotFoundError: If math_blob file not found
        json.JSONDecodeError: If file is not valid JSON
    """
    dataset_files = get_dataset_files(dataset_name)
    math_blob_path = dataset_files['math_blob']

    with open(math_blob_path, 'r') as f:
        return json.load(f)


def unfold_clojure_group_clusters(math_blob: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Unfold Clojure's two-level clustering to participant level for comparison.

    Both Clojure and Python use two-level clustering:
    1. Participants → base clusters (~100 small clusters)
    2. Base clusters → groups (k final groups)

    This function unfolds Clojure's group-clusters from base cluster IDs
    to participant IDs.  Python's equivalent is Conversation._unfolded_group_clusters().

    Args:
        math_blob: Clojure math_blob dictionary with 'group-clusters' and 'base-clusters'

    Returns:
        List of unfolded group clusters with participant IDs as members.
        Each dict has 'id' and 'members' keys.

    Example:
        Clojure group-clusters: [{id: 0, members: [6, 18, 21, ...]}, ...]  # base cluster IDs
        Unfolded: [{id: 0, members: [0, 8, 24, 26, ...]}, ...]  # participant IDs
    """
    group_clusters = math_blob.get('group-clusters', [])
    base_clusters = math_blob.get('base-clusters', {})

    if not group_clusters:
        logger.warning("Missing group-clusters in Clojure output; nothing to unfold")
        return []

    if not base_clusters:
        raise ValueError(
            "Missing base-clusters in Clojure output; "
            "cannot unfold group-clusters from base-cluster IDs to participant IDs"
        )

    # Build a lookup from base cluster ID to participant IDs
    # base-clusters is in "folded" format: {id: [0,1,2,...], members: [[...], [...], ...]}
    bc_ids = base_clusters.get('id', [])
    bc_members = base_clusters.get('members', [])

    if len(bc_ids) != len(bc_members):
        raise ValueError(
            f"Mismatch between base cluster IDs ({len(bc_ids)}) and members "
            f"({len(bc_members)}); cannot unfold group-clusters"
        )

    # Create lookup: base_cluster_id → participant_ids
    base_cluster_lookup = {}
    for bc_id, participants in zip(bc_ids, bc_members):
        base_cluster_lookup[bc_id] = participants

    # Unfold each group cluster
    unfolded_groups = []
    for group in group_clusters:
        group_id = group.get('id', 0)
        base_cluster_ids = group.get('members', [])

        # Collect all participant IDs from the base clusters
        participant_ids = []
        for bc_id in base_cluster_ids:
            if bc_id in base_cluster_lookup:
                participant_ids.extend(base_cluster_lookup[bc_id])
            else:
                logger.warning(f"Base cluster ID {bc_id} not found in base-clusters")

        # Convert participant IDs to strings to match Python's format
        # Python uses string IDs ('0', '1', '10'), Clojure uses integers (0, 1, 10)
        participant_ids_str = [str(pid) for pid in participant_ids]

        unfolded_group = {
            'id': group_id,
            'members': participant_ids_str,
        }

        # Preserve center if present (though it may not be meaningful at participant level)
        if 'center' in group:
            unfolded_group['center'] = group['center']

        unfolded_groups.append(unfolded_group)

    logger.info(f"Unfolded {len(unfolded_groups)} Clojure groups from base clusters")
    return unfolded_groups


def compare_cluster_distributions(
    python_clusters: List[Dict[str, Any]],
    clojure_clusters: List[Dict[str, Any]],
    tolerance: float = 0.05
) -> Dict[str, Any]:
    """
    Compare cluster size distributions using L1 distance on normalized sizes.

    Compares the distribution of cluster sizes between Python and Clojure
    implementations. This is useful for detecting whether clustering produces
    similar grouping patterns, even if individual memberships differ slightly.

    Args:
        python_clusters: List of cluster dicts with 'members'
        clojure_clusters: List of cluster dicts with 'members'
        tolerance: Maximum L1 distance for "similar" (default: 0.05)

    Returns:
        Dict with:
        - python_sizes: Sorted list of cluster sizes (Python)
        - clojure_sizes: Sorted list of cluster sizes (Clojure)
        - num_clusters_match: Boolean indicating if cluster counts match
        - l1_distance: L1 distance between normalized size distributions
        - similarity_score: Similarity score (1.0 = identical, 0.0 = very different)
        - match_status: Boolean indicating if distributions match within tolerance
    """
    # Get cluster sizes
    python_sizes = [len(c.get('members', [])) for c in python_clusters]
    clojure_sizes = [len(c.get('members', [])) for c in clojure_clusters]

    # Sort for consistent comparison
    python_sizes.sort(reverse=True)
    clojure_sizes.sort(reverse=True)

    # Check if number of clusters matches
    num_clusters_match = len(python_sizes) == len(clojure_sizes)

    # Compute L1 distance between normalized distributions
    if python_sizes and clojure_sizes:
        # Pad the shorter list with zeros
        max_len = max(len(python_sizes), len(clojure_sizes))
        python_padded = python_sizes + [0] * (max_len - len(python_sizes))
        clojure_padded = clojure_sizes + [0] * (max_len - len(clojure_sizes))

        # Normalize to get distributions
        python_total = sum(python_padded)
        clojure_total = sum(clojure_padded)

        if python_total > 0 and clojure_total > 0:
            python_norm = np.array([p / python_total for p in python_padded])
            clojure_norm = np.array([c / clojure_total for c in clojure_padded])

            # L1 distance between normalized size distributions
            w_distance = float(np.sum(np.abs(python_norm - clojure_norm)))
            similarity = max(0.0, 1.0 - w_distance)
        else:
            w_distance = float('inf')
            similarity = 0.0
    else:
        w_distance = float('inf')
        similarity = 0.0

    match_status = (
        num_clusters_match
        and w_distance != float('inf')
        and w_distance <= tolerance
    )

    return {
        'python_sizes': python_sizes,
        'clojure_sizes': clojure_sizes,
        'num_clusters_match': num_clusters_match,
        'l1_distance': w_distance,
        'similarity_score': similarity,
        'match_status': match_status
    }


def find_best_cluster_mapping(
    python_clusters: List[Dict[str, Any]],
    clojure_clusters: List[Dict[str, Any]]
) -> Dict[int, Tuple[int, float]]:
    """
    Map Python clusters to Clojure clusters by maximum Jaccard overlap.

    Uses greedy matching: for each Python cluster, finds the Clojure cluster
    with the highest Jaccard similarity that hasn't been matched yet.

    Args:
        python_clusters: List of Python cluster dicts with 'members'
        clojure_clusters: List of Clojure cluster dicts with 'members'

    Returns:
        Dict mapping Python cluster index -> (Clojure cluster index, Jaccard score)
    """
    python_to_clojure = {}
    used_clojure = set()

    for py_idx in range(len(python_clusters)):
        python_members = set(python_clusters[py_idx].get('members', []))

        best_clj_idx = None
        best_jaccard = -1.0

        for clj_idx in range(len(clojure_clusters)):
            if clj_idx in used_clojure:
                continue

            clojure_members = set(clojure_clusters[clj_idx].get('members', []))

            # Compute Jaccard similarity
            intersection = len(python_members & clojure_members)
            union = len(python_members | clojure_members)
            jaccard = (intersection / union) if union > 0 else 0.0

            if jaccard > best_jaccard:
                best_jaccard = jaccard
                best_clj_idx = clj_idx

        if best_clj_idx is not None:
            python_to_clojure[py_idx] = (best_clj_idx, best_jaccard)
            used_clojure.add(best_clj_idx)

    return python_to_clojure


def compare_cluster_membership(
    python_clusters: List[Dict[str, Any]],
    clojure_clusters: List[Dict[str, Any]],
    min_jaccard: float = 0.95
) -> Dict[str, Any]:
    """
    Compare cluster membership using Jaccard similarity with best mapping.

    Finds the best mapping between Python and Clojure clusters based on
    Jaccard similarity, then validates that all mapped pairs meet the
    minimum similarity threshold.

    Args:
        python_clusters: List of cluster dicts with 'members'
        clojure_clusters: List of cluster dicts with 'members'
        min_jaccard: Minimum Jaccard similarity for "matching" (default: 0.95)

    Returns:
        Dict with:
        - mapping: Dict mapping Python idx -> (Clojure idx, Jaccard score)
        - jaccard_scores: List of all Jaccard scores for mapped pairs
        - overall_similarity: Average Jaccard across all mapped pairs
        - match_status: Whether all pairs meet min_jaccard threshold
        - num_python_clusters: Number of Python clusters
        - num_clojure_clusters: Number of Clojure clusters
    """
    mapping = find_best_cluster_mapping(python_clusters, clojure_clusters)

    jaccard_scores = [score for _, score in mapping.values()]

    num_python = len(python_clusters)
    num_clojure = len(clojure_clusters)
    counts_match = num_python == num_clojure
    complete_mapping = len(mapping) == num_python

    if jaccard_scores:
        overall_similarity = np.mean(jaccard_scores)
        match_status = (
            counts_match
            and complete_mapping
            and all(score >= min_jaccard for score in jaccard_scores)
        )
    else:
        overall_similarity = 0.0
        match_status = False

    return {
        'mapping': mapping,
        'jaccard_scores': jaccard_scores,
        'overall_similarity': overall_similarity,
        'match_status': match_status,
        'num_python_clusters': len(python_clusters),
        'num_clojure_clusters': len(clojure_clusters)
    }


def compare_projections(
    python_proj: Dict[str, Any],
    clojure_proj: Dict[str, Any],
    transformations: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    Compare PCA projections with transformation testing.

    Tests different coordinate transformations to find best match,
    handling PCA sign/axis ambiguity (PCA is defined up to sign flip).

    Args:
        python_proj: Dict of {participant_id: [x, y] or {'x': x, 'y': y}}
        clojure_proj: Dict of {participant_id: [x, y] or {'x': x, 'y': y}}
        transformations: List of transformation names to try.
                        If None, tries all 8 standard transformations.

    Returns:
        Dict with:
        - best_transformation: Name of best-matching transformation
        - same_quadrant_percentage: % of points in same quadrant after transform
        - average_distance: Mean Euclidean distance after transform
        - distribution_similarity: L1 similarity of norm distributions
        - common_participants: Number of participants in both projections
    """
    if transformations is None:
        transformations = [
            'none', 'flip_x', 'flip_y', 'flip_both',
            'transpose', 'transpose_flip_x', 'transpose_flip_y', 'transpose_flip_both'
        ]

    # Find common participants
    common_ids = set(python_proj.keys()) & set(clojure_proj.keys())

    if not common_ids:
        return {
            'best_transformation': 'none',
            'same_quadrant_percentage': 0.0,
            'average_distance': float('inf'),
            'distribution_similarity': 0.0,
            'common_participants': 0
        }

    # Convert to numpy arrays
    py_projs = {}
    cl_projs = {}

    for pid in common_ids:
        # Parse Python projection
        py_val = python_proj[pid]
        if isinstance(py_val, (list, np.ndarray)):
            py_projs[pid] = np.array(py_val[:2])  # Take first 2 dimensions
        elif isinstance(py_val, dict):
            py_projs[pid] = np.array([py_val.get('x', 0), py_val.get('y', 0)])
        else:
            continue

        # Parse Clojure projection
        cl_val = clojure_proj[pid]
        if isinstance(cl_val, (list, np.ndarray)):
            cl_projs[pid] = np.array(cl_val[:2])
        elif isinstance(cl_val, dict):
            cl_projs[pid] = np.array([cl_val.get('x', 0), cl_val.get('y', 0)])
        else:
            del py_projs[pid]  # Remove if Clojure parsing failed
            continue

    # Define transformation functions
    transform_funcs = {
        'none': lambda p: p,
        'flip_x': lambda p: np.array([-p[0], p[1]]),
        'flip_y': lambda p: np.array([p[0], -p[1]]),
        'flip_both': lambda p: np.array([-p[0], -p[1]]),
        'transpose': lambda p: np.array([p[1], p[0]]),
        'transpose_flip_x': lambda p: np.array([-p[1], p[0]]),
        'transpose_flip_y': lambda p: np.array([p[1], -p[0]]),
        'transpose_flip_both': lambda p: np.array([-p[1], -p[0]])
    }

    # Try each transformation
    best_same_quadrant = 0
    best_avg_dist = float('inf')
    best_transformation = 'none'
    best_results = None

    for trans_name in transformations:
        if trans_name not in transform_funcs:
            continue

        transform_fn = transform_funcs[trans_name]

        # Apply transformation
        transformed_py = {pid: transform_fn(proj) for pid, proj in py_projs.items()}

        # Compute metrics
        distances = []
        same_quadrant = 0

        for pid in transformed_py:
            py_p = transformed_py[pid]
            cl_p = cl_projs[pid]

            # Euclidean distance
            dist = np.linalg.norm(py_p - cl_p)
            distances.append(dist)

            # Same quadrant check
            if (py_p[0] * cl_p[0] >= 0) and (py_p[1] * cl_p[1] >= 0):
                same_quadrant += 1

        avg_dist = np.mean(distances) if distances else float('inf')
        sq_pct = same_quadrant / len(transformed_py) if transformed_py else 0.0

        # Update best if better
        if same_quadrant > best_same_quadrant or (same_quadrant == best_same_quadrant and avg_dist < best_avg_dist):
            best_same_quadrant = same_quadrant
            best_avg_dist = avg_dist
            best_transformation = trans_name
            best_results = {
                'transformed_projections': transformed_py,
                'distances': distances,
                'same_quadrant_count': same_quadrant,
                'same_quadrant_percentage': sq_pct,
                'average_distance': avg_dist
            }

    # Compute distribution similarity using best transformation
    if best_results:
        transformed_py = best_results['transformed_projections']
        py_norms = [np.linalg.norm(proj) for proj in transformed_py.values()]
        cl_norms = [np.linalg.norm(proj) for proj in cl_projs.values()]

        if py_norms and cl_norms:
            # Normalize to [0, 1]
            py_min, py_max = min(py_norms), max(py_norms)
            cl_min, cl_max = min(cl_norms), max(cl_norms)

            py_norm = np.array([(n - py_min) / (py_max - py_min) if py_max > py_min else 0.5 for n in py_norms])
            cl_norm = np.array([(n - cl_min) / (cl_max - cl_min) if cl_max > cl_min else 0.5 for n in cl_norms])

            l1_dist = float(np.sum(np.abs(py_norm - cl_norm))) / max(len(py_norm), 1)
            dist_sim = max(0.0, 1.0 - l1_dist)
        else:
            dist_sim = 0.0
    else:
        dist_sim = 0.0

    return {
        'best_transformation': best_transformation,
        'same_quadrant_percentage': best_results['same_quadrant_percentage'] if best_results else 0.0,
        'average_distance': best_avg_dist,
        'distribution_similarity': dist_sim,
        'common_participants': len(py_projs)
    }


def compute_distribution_similarity(
    dist1: List[float],
    dist2: List[float]
) -> float:
    """
    Compute L1 distance between two distributions and convert to similarity.

    Args:
        dist1: First distribution (list of values)
        dist2: Second distribution (list of values)

    Returns:
        Similarity score (1.0 = identical, 0.0 = very different)
    """
    if not dist1 or not dist2:
        return 0.0

    # Normalize distributions
    dist1_arr = np.array(dist1, dtype=float)
    dist2_arr = np.array(dist2, dtype=float)
    s1, s2 = dist1_arr.sum(), dist2_arr.sum()
    dist1_norm = dist1_arr / s1 if s1 > 0 else dist1_arr
    dist2_norm = dist2_arr / s2 if s2 > 0 else dist2_arr

    # Compute L1 distance and convert to similarity (clipped to [0, 1])
    l1_dist = float(np.sum(np.abs(dist1_norm - dist2_norm)))
    return max(0.0, min(1.0, 1.0 - l1_dist))
