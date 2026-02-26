"""
Legacy: Comparison with Clojure implementation. Will be removed once Clojure is phased out.

Tests for the conversion with real data from conversations, comparing Python output
against the old Clojure implementation's math_blob outputs.

Datasets are auto-discovered from:
- real_data/ (committed datasets, always included)
- real_data/.local/ (local datasets, included with --include-local flag)

Only datasets with math_blob (has_clojure_reference=True) are included.

Performance note: Uses scope="class" with parametrization to ensure only ONE
Conversation object is in memory at a time (teardown between datasets).
"""

import pytest
import pytest_check as check
import gc

from polismath.conversation.conversation import Conversation
from polismath.regression import get_dataset_files
from polismath.regression.datasets import discover_datasets
from tests.common_utils import load_votes, load_comments, load_clojure_output
from conftest import _get_requested_datasets, make_dataset_params
from polismath.regression.clojure_comparer import (
    ClojureComparer,
    compare_cluster_distributions,
    compare_cluster_membership,
    unfold_clojure_group_clusters
)


def _get_clojure_datasets(include_local: bool, requested: set[str] | None = None) -> list[str]:
    """Get datasets that have Clojure math_blob for comparison.

    Only requires votes, comments, and math_blob - does NOT require golden_snapshot.
    Filters by requested datasets if specified.
    """
    datasets = discover_datasets(include_local=include_local)
    result = [
        name for name, info in datasets.items()
        if info.has_votes and info.has_comments and info.has_clojure_reference
    ]
    # Filter by --datasets if specified
    if requested:
        result = [d for d in result if d in requested]
    return result


# Module-level cache for conversation data - survives across fixture calls
_CONVERSATION_CACHE: dict = {}


def pytest_generate_tests(metafunc):
    """Parametrize tests with clojure datasets at collection time."""
    if "dataset_name" in metafunc.fixturenames:
        include_local = metafunc.config.getoption("--include-local", default=False)
        requested = _get_requested_datasets(metafunc.config)
        datasets = _get_clojure_datasets(include_local, requested)
        # Add xdist_group marker to each parameter for parallel execution
        params = make_dataset_params(datasets)
        metafunc.parametrize("dataset_name", params, scope="class")


def _cleanup_previous_datasets(current_dataset: str):
    """Clear cached datasets except the current one to manage memory."""
    global _CONVERSATION_CACHE
    for ds in list(_CONVERSATION_CACHE.keys()):
        if ds != current_dataset:
            print(f"[{ds}] Cleaning up previous dataset...")
            _CONVERSATION_CACHE.pop(ds, None)
            Conversation._reset_conversion_cache()
            gc.collect()


@pytest.fixture(scope="class")
def conversation_data(dataset_name):
    """
    Class-scoped fixture computed once per dataset.
    Uses module-level cache to avoid recomputation.
    """
    global _CONVERSATION_CACHE

    # Clean up previous datasets to manage memory
    _cleanup_previous_datasets(dataset_name)

    # Return cached data if available
    if dataset_name in _CONVERSATION_CACHE:
        return _CONVERSATION_CACHE[dataset_name]

    # Compute the data

    # Get dataset files using central configuration
    dataset_files = get_dataset_files(dataset_name)

    # Load the Clojure output for comparison
    clojure_output = load_clojure_output(dataset_files['math_blob'])

    # Create and compute conversation
    votes = load_votes(dataset_files['votes'])
    comments = load_comments(dataset_files['comments'])

    print(f"\n[{dataset_name}] Processing conversation with {len(votes['votes'])} votes and {len(comments['comments'])} comments")
    conv = Conversation(dataset_name)
    conv = conv.update_votes(votes)

    print(f"[{dataset_name}] Recomputing conversation analysis...")
    conv = conv.recompute()

    # Extract key metrics for reporting
    group_count = len(conv.group_clusters)
    print(f"[{dataset_name}] Found {group_count} groups")
    print(f"[{dataset_name}] Processed {conv.comment_count} comments")
    print(f"[{dataset_name}] Found {conv.participant_count} participants")

    if conv.repness and 'comment_repness' in conv.repness:
        print(f"[{dataset_name}] Calculated representativeness for {len(conv.repness['comment_repness'])} comments")

    # Print top representative comments for each group
    if conv.repness and 'comment_repness' in conv.repness:
        for group_id in range(group_count):
            print(f"\n[{dataset_name}] Top representative comments for Group {group_id}:")
            group_repness = [item for item in conv.repness['comment_repness'] if item['gid'] == group_id]

            # Sort by representativeness
            group_repness.sort(key=lambda x: abs(x['repness']), reverse=True)

            # Print top 5 comments
            for i, rep_item in enumerate(group_repness[:5]):
                comment_id = rep_item['tid']
                # Get the comment text if available
                comment_txt = next((c['txt'] for c in comments['comments'] if str(c['tid']) == str(comment_id)), 'Unknown')
                print(f"  {i+1}. Comment {comment_id} (Repness: {rep_item['repness']:.4f}): {comment_txt[:50]}...")

    # Save the Python conversion results for manual inspection
    import os
    import json
    data_dir = dataset_files['data_dir']
    output_dir = os.path.join(os.path.dirname(data_dir), '.test_outputs', 'python_output', dataset_name)
    os.makedirs(output_dir, exist_ok=True)

    output_path = os.path.join(output_dir, 'conversation_result.json')
    with open(output_path, 'w') as f:
        json.dump(conv.to_dict(), f, indent=2)

    print(f"[{dataset_name}] Saved results to {output_path}")

    # Cache for sharing across test methods
    data = {
        'conv': conv,
        'clojure_output': clojure_output,
        'dataset_name': dataset_name,
        'comments': comments,
    }
    _CONVERSATION_CACHE[dataset_name] = data

    return data


@pytest.mark.clojure_comparison
class TestClojureRegression:
    """
    Test class for Clojure regression comparisons.
    Parametrized per-dataset, with module-level cache for efficiency.

    These tests compare Python implementation with Clojure math_blob outputs.
    They are marked with @pytest.mark.clojure_comparison so they can be optionally excluded.
    """

    def test_basic_outputs(self, conversation_data):
        """
        Test that basic pipeline outputs are calculated correctly.
        This test checks that the pipeline runs successfully and produces
        representativeness calculations.
        """
        conv = conversation_data['conv']
        dataset_name = conversation_data['dataset_name']

        print(f"\n[{dataset_name}] Testing basic outputs...")

        # Compare basic pipeline outputs like representativeness
        check.is_not_none(conv.repness, "Representativeness should be calculated")
        check.is_in('comment_repness', conv.repness or {}, "Comment representativeness should exist")
        if conv.repness and 'comment_repness' in conv.repness:
            check.greater(len(conv.repness['comment_repness']), 0, "Should have representative comments")

    def test_pca_components_match_clojure(self, conversation_data):
        """
        Test that PCA components match the Clojure implementation.

        DEPRECATED: The sklearn PCA implementation has been validated to match
        the Clojure output. Any regressions will be caught by the regression
        tests in test_regression.py which compare against golden snapshots.

        This test file will be removed once all other Clojure comparison tests
        are similarly validated and covered by regression tests.
        """
        # PCA match verified - regressions caught by test_regression.py
        pass

    @pytest.mark.xfail(reason="D2/D3: Wrong participant threshold and missing k-smoother produce different cluster counts")
    def test_group_clustering(self, conversation_data):
        """
        Test that group clustering matches the Clojure implementation.

        Both Python and Clojure use two-level clustering:
        1. Participants → base clusters (~100 small clusters)
        2. Base clusters → groups (k final groups)

        Both sides are unfolded to participant-level membership for comparison.
        """
        conv = conversation_data['conv']
        clojure_output = conversation_data['clojure_output']
        dataset_name = conversation_data['dataset_name']

        print(f"\n[{dataset_name}] Testing group clustering...")

        # Check that Clojure output has clusters
        if 'group-clusters' not in clojure_output:
            check.is_in('group-clusters', clojure_output, "Clojure output should contain group-clusters")
            return

        # Unfold both sides from base-cluster IDs to participant IDs
        python_clusters_unfolded = conv._unfolded_group_clusters()
        clojure_clusters_unfolded = unfold_clojure_group_clusters(clojure_output)

        print(f"[{dataset_name}] Comparing group clustering:")
        print(f"  Python groups: {len(python_clusters_unfolded)} (unfolded to participant level)")
        print(f"  Clojure groups: {len(clojure_clusters_unfolded)} (unfolded to participant level)")

        # Very tight thresholds: implementations should be near-identical
        comparer = ClojureComparer(
            jaccard_threshold=0.99,
            distribution_tolerance=0.01
        )

        result = comparer.compare_clusters(
            python_clusters_unfolded,
            clojure_clusters_unfolded,
            dataset_name=dataset_name
        )

        # 1. Check distribution similarity
        dist_comp = result['distribution_comparison']
        print(f"\n  Cluster Size Distribution:")
        print(f"    Python sizes:  {dist_comp['python_sizes']}")
        print(f"    Clojure sizes: {dist_comp['clojure_sizes']}")
        print(f"    Wasserstein distance: {dist_comp['wasserstein_distance']:.4f}")
        print(f"    Similarity score: {dist_comp['similarity_score']:.2%}")

        check.is_true(dist_comp['num_clusters_match'],
                     f"Number of clusters should match (Python: {len(python_clusters_unfolded)}, Clojure: {len(clojure_clusters_unfolded)})")
        check.less_equal(dist_comp['wasserstein_distance'], comparer.distribution_tolerance,
                        f"Wasserstein distance should be ≤{comparer.distribution_tolerance} (got {dist_comp['wasserstein_distance']:.4f})")

        # 2. Check membership overlap — require near-exact match
        memb_comp = result['membership_comparison']
        print(f"\n  Cluster Membership Overlap:")
        print(f"    Average Jaccard similarity: {memb_comp['overall_similarity']:.2%}")
        print(f"    Threshold: {comparer.jaccard_threshold:.2%}")

        print(f"\n  Cluster Mapping (Python → Clojure):")
        for py_idx, (clj_idx, jaccard) in memb_comp['mapping'].items():
            py_size = len(python_clusters_unfolded[py_idx]['members'])
            clj_size = len(clojure_clusters_unfolded[clj_idx]['members'])
            status = '✓' if jaccard >= comparer.jaccard_threshold else '✗'
            print(f"    {status} Group {py_idx} ({py_size} members) → Group {clj_idx} ({clj_size} members): {jaccard:.2%}")

        check.greater_equal(memb_comp['overall_similarity'], comparer.jaccard_threshold,
                          f"Average Jaccard should be ≥{comparer.jaccard_threshold:.2%} (got {memb_comp['overall_similarity']:.2%})")

        # 3. Overall match required
        check.is_true(result['overall_match'],
                     f"Clustering should match Clojure output (distribution + membership)")

    @pytest.mark.xfail(reason="D12: Comment priorities not yet implemented in Python")
    def test_comment_priorities(self, conversation_data):
        """
        Test that comment priorities match the Clojure implementation exactly.

        Comment priorities are deterministic given the same vote matrix and
        clustering, so Python and Clojure should produce identical values
        (within floating-point tolerance).
        """
        conv = conversation_data['conv']
        clojure_output = conversation_data['clojure_output']
        dataset_name = conversation_data['dataset_name']

        print(f"\n[{dataset_name}] Testing comment priorities...")

        has_python_priorities = hasattr(conv, 'comment_priorities')
        has_clojure_priorities = 'comment-priorities' in clojure_output

        check.is_true(has_python_priorities, "Python output should have comment_priorities attribute")
        check.is_true(has_clojure_priorities, "Clojure output should have comment-priorities")

        if not (has_python_priorities and has_clojure_priorities):
            return

        python_priorities = conv.comment_priorities
        clojure_priorities = clojure_output['comment-priorities']

        # All Clojure comment IDs should be present in Python
        clojure_ids = set(str(k) for k in clojure_priorities.keys())
        python_ids = set(str(k) for k in python_priorities.keys())
        check.equal(python_ids, clojure_ids,
                   f"Comment ID sets should match (Python extra: {python_ids - clojure_ids}, missing: {clojure_ids - python_ids})")

        # Compare values with tight floating-point tolerance
        mismatches = []
        for comment_id, clojure_val in clojure_priorities.items():
            cid_str = str(comment_id)
            clojure_val = float(clojure_val)

            # Look up in Python (may be int or str key)
            python_val = None
            for k, v in python_priorities.items():
                if str(k) == cid_str:
                    python_val = float(v)
                    break

            if python_val is None:
                mismatches.append(f"  tid {cid_str}: missing in Python (Clojure={clojure_val:.6f})")
                continue

            if abs(python_val - clojure_val) > 1e-6:
                mismatches.append(f"  tid {cid_str}: Python={python_val:.6f} vs Clojure={clojure_val:.6f} (diff={abs(python_val - clojure_val):.2e})")

        if mismatches:
            print(f"  Mismatches ({len(mismatches)}/{len(clojure_priorities)}):")
            for m in mismatches[:20]:
                print(m)
            if len(mismatches) > 20:
                print(f"  ... and {len(mismatches) - 20} more")
        else:
            print(f"  All {len(clojure_priorities)} priorities match exactly")

        check.equal(len(mismatches), 0,
                   f"All comment priorities should match Clojure (got {len(mismatches)} mismatches out of {len(clojure_priorities)})")
