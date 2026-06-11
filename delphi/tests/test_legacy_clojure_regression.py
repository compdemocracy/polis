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

from typing import Optional

import pytest
import pytest_check as check

from polismath.regression import get_dataset_files, get_blob_variants
from polismath.regression.datasets import discover_datasets
from tests.common_utils import load_clojure_output
from conftest import _get_requested_datasets, make_dataset_params, parse_dataset_blob_id
from polismath.regression.clojure_comparer import (
    ClojureComparer,
    unfold_clojure_group_clusters,
)


def _get_clojure_dataset_blob_ids(include_local: bool, requested: Optional[set[str]] = None) -> list[str]:
    """Get composite 'dataset-blob_type' IDs for all filled blobs.

    Returns IDs like 'biodiversity-incremental', 'engage-incremental', 'engage-cold_start'.
    Only includes blobs that have meaningful content (PCA, clusters, etc.).
    Filters by dataset name if --datasets is specified.
    """
    datasets = discover_datasets(include_local=include_local)
    result = []
    for name, info in datasets.items():
        if not (info.has_votes and info.has_comments and info.has_clojure_reference):
            continue
        if requested and name not in requested:
            continue
        for blob_type in get_blob_variants(name):
            result.append(f"{name}-{blob_type}")
    return result


# Module-level cache for blobs (keyed by composite ID)
_BLOB_CACHE: dict = {}


def pytest_generate_tests(metafunc):
    """Parametrize tests with clojure dataset+blob_type at collection time."""
    if "dataset_blob_id" in metafunc.fixturenames:
        include_local = metafunc.config.getoption("--include-local", default=False)
        requested = _get_requested_datasets(metafunc.config)
        blob_ids = _get_clojure_dataset_blob_ids(include_local, requested)
        params = make_dataset_params(blob_ids)
        metafunc.parametrize("dataset_blob_id", params, scope="class")


@pytest.fixture(scope="class")
def conversation_data(dataset_blob_id, get_or_compute_conversation):
    """
    Class-scoped fixture computed once per dataset+blob_type.
    Reuses the Conversation across blob variants via the session-scoped cache.
    """
    global _BLOB_CACHE
    dataset_name, blob_type = parse_dataset_blob_id(dataset_blob_id)

    # Get or compute the conversation (shared across blob variants via session cache)
    conv_data = get_or_compute_conversation(dataset_name)

    # Load the specific blob variant (cache per composite ID)
    if dataset_blob_id not in _BLOB_CACHE:
        # Evict blobs from other datasets
        for bid in list(_BLOB_CACHE.keys()):
            if not bid.startswith(dataset_name + '-'):
                _BLOB_CACHE.pop(bid, None)

        dataset_files = get_dataset_files(dataset_name, blob_type=blob_type)
        clojure_output = load_clojure_output(dataset_files['math_blob'])
        print(f"[{dataset_name}] Loaded {blob_type} blob for Clojure comparison")
        _BLOB_CACHE[dataset_blob_id] = clojure_output

    return {
        'conv': conv_data['conv'],
        'clojure_output': _BLOB_CACHE[dataset_blob_id],
        'dataset_name': dataset_name,
        'blob_type': blob_type,
        'comments': conv_data['comments'],
    }


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

        This test compares the principal components computed by Python against
        the Clojure implementation. PCA eigenvectors are only defined up to sign,
        so we check correlation (should be ±1) and angle (should be 0°).

        Note: The centers will be negated due to vote sign convention difference
        (Python: agree=+1, Clojure: agree=-1), but the eigenvectors should match.
        """
        import numpy as np

        conv = conversation_data['conv']
        clojure_output = conversation_data['clojure_output']
        dataset_name = conversation_data['dataset_name']

        print(f"\n[{dataset_name}] Testing PCA components match Clojure...")

        # Get PCA components
        if 'pca' not in clojure_output or 'comps' not in clojure_output['pca']:
            check.is_in('pca', clojure_output, "Clojure output should contain pca")
            return

        py_comps = np.array(conv.pca['comps'])
        clj_comps = np.array(clojure_output['pca']['comps'])

        # Check dimensions match
        check.equal(py_comps.shape, clj_comps.shape,
                    f"PCA component dimensions should match: Python {py_comps.shape} vs Clojure {clj_comps.shape}")

        if py_comps.shape != clj_comps.shape:
            return

        # Compare each component
        for i in range(min(2, len(py_comps))):
            py_pc = py_comps[i]
            clj_pc = clj_comps[i]

            # Correlation should be ±1 (components match up to sign)
            correlation = np.corrcoef(py_pc, clj_pc)[0, 1]
            print(f"  PC{i+1} correlation: {correlation:.6f}")

            # Angle between vectors (correct even if vectors have different norms)
            py_norm = np.linalg.norm(py_pc)
            clj_norm = np.linalg.norm(clj_pc)
            cos_sim = np.dot(py_pc, clj_pc) / (py_norm * clj_norm) if py_norm > 0 and clj_norm > 0 else 0
            # Clip for numerical stability: arccos domain is [-1, 1], but floating-point
            # errors can produce values slightly outside this range (e.g., 1.0000000002).
            # Assert we're only clipping by a tiny amount - large deviations indicate a bug.
            abs_cos_sim = np.abs(cos_sim)
            assert abs_cos_sim < 1.0 + 1e-6, f"cos_sim={cos_sim} is too far outside [-1, 1]"
            norm_angle_deg = np.arccos(np.clip(abs_cos_sim, -1, 1)) * 180 / np.pi
            print(f"  PC{i+1} angle: {norm_angle_deg:.2f}°")
            print(f"  PC{i+1} norms: Python={py_norm:.4f}, Clojure={clj_norm:.4f}")

            # Assert correlation is close to ±1 (allow 2% tolerance for numerical differences)
            check.almost_equal(abs(correlation), 1.0, rel=0.02,
                              msg=f"PC{i+1} correlation should be ±1 (got {correlation:.4f})")

            # Assert angle is small (allow 10° for power iteration numerical differences)
            # 10° ≈ 98.5% correlation - catches major regressions while allowing numerical variance
            check.less_equal(norm_angle_deg, 10.0,
                            f"PC{i+1} angle difference should be ≤10° (got {norm_angle_deg:.2f}°)")

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
        blob_type = conversation_data['blob_type']

        # Incremental blobs are progressive snapshots — in-conv sets differ
        # from single-shot computation, so clustering comparison is not valid.
        if blob_type == 'incremental':
            pytest.xfail("Incremental blobs have different in-conv from single-shot")

        # FLI cold-start: residual k divergence (Python k=3, Clojure k=2).
        # The PR's own investigation showed 94.5% NaN sparsity and a silhouette
        # gap of 0.001 between k=2 and k=3 — any tiny PCA difference tips the
        # balance. Not fixable without replicating Clojure's power-iteration PCA.
        # See `INVESTIGATION_K_DIVERGENCE.md`.
        if dataset_name == 'FLI' and blob_type == 'cold_start':
            pytest.xfail("FLI cold-start: inherent PCA divergence (flat silhouette landscape)")

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
        print(f"    L1 distance: {dist_comp['l1_distance']:.4f}")
        print(f"    Similarity score: {dist_comp['similarity_score']:.2%}")

        check.is_true(dist_comp['num_clusters_match'],
                     f"Number of clusters should match (Python: {len(python_clusters_unfolded)}, Clojure: {len(clojure_clusters_unfolded)})")
        check.less_equal(dist_comp['l1_distance'], comparer.distribution_tolerance,
                        f"L1 distance should be ≤{comparer.distribution_tolerance} (got {dist_comp['l1_distance']:.4f})")

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

    @pytest.mark.xfail(raises=AssertionError, strict=False,
                       reason="D12 / D12.6 incremental: Python's Clojure-bug-mirror (all priorities = META_PRIORITY^2 = 49) "
                              "matches Clojure cold_start exactly (XPASS), but Clojure incremental has varied priorities, "
                              "so Python's all-49 doesn't match incremental. strict=False to allow both XPASS (cold_start) "
                              "and FAIL (incremental) without test failure. Restore strict=True once Clojure bug is fixed upstream.")
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

    @pytest.mark.xfail(raises=AssertionError, strict=True, reason="D5/D6/D7/D10: z-values, metric, and selection logic differ")
    def test_repness_matches_clojure(self, conversation_data):
        """
        Test that representative comment selection matches Clojure.

        Compares selected comment sets and z-score values per group.
        Requires D5 (prop test), D6 (two-prop test), D7 (metric),
        and D10 (selection logic) to fully pass.
        """
        conv = conversation_data['conv']
        clojure_output = conversation_data['clojure_output']
        dataset_name = conversation_data['dataset_name']

        print(f"\n[{dataset_name}] Testing repness matches Clojure...")

        clj_repness = clojure_output.get('repness', {})
        check.is_true(bool(clj_repness), "Clojure output should have repness")

        py_repness = (conv.repness or {}).get('group_repness', {})
        check.is_true(bool(py_repness), "Python should have group_repness")

        if not clj_repness or not py_repness:
            return

        set_mismatches = []
        value_mismatches = []

        for gid_str, clj_entries in clj_repness.items():
            gid = int(gid_str)

            # Compare selected comment sets
            clj_tids = set(e['tid'] for e in clj_entries)
            py_entries = py_repness.get(gid, [])
            py_tids = set(int(e['comment_id']) for e in py_entries)

            if clj_tids != py_tids:
                set_mismatches.append(
                    f"  g{gid}: clj={sorted(clj_tids)}, py={sorted(py_tids)}")

            # Compare z-values for shared comments
            py_by_tid = {int(e['comment_id']): e for e in py_entries}
            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue

                clj_pat = clj_entry.get('p-test', 0)
                py_pat = py_entry.get('pat', 0)
                clj_rat = clj_entry.get('repness-test', 0)
                py_rat = py_entry.get('rat', 0)

                if abs(clj_pat - py_pat) > 0.01 or abs(clj_rat - py_rat) > 0.01:
                    value_mismatches.append(
                        f"  g{gid}/t{tid}: pat clj={clj_pat:.4f} py={py_pat:.4f}, "
                        f"rat clj={clj_rat:.4f} py={py_rat:.4f}")

        if set_mismatches:
            print(f"  Set mismatches ({len(set_mismatches)} groups):")
            for m in set_mismatches[:10]:
                print(m)
        if value_mismatches:
            print(f"  Value mismatches ({len(value_mismatches)} comments):")
            for m in value_mismatches[:10]:
                print(m)

        check.equal(len(set_mismatches), 0,
                   f"{len(set_mismatches)} groups differ in selected rep comments")
        check.equal(len(value_mismatches), 0,
                   f"{len(value_mismatches)} shared comments have z-value mismatches")
