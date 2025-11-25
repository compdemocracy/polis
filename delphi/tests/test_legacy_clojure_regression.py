"""
Legacy: Comparison with Clojure implementation. Will be removed once Clojure is phased out.

Tests for the conversion with real data from conversations, comparing Python output
against the old Clojure implementation's math_blob outputs.
"""

import pytest
import pytest_check as check
import os
import sys
import json

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.conversation.conversation import Conversation
from polismath.regression import get_dataset_files
from tests.common_utils import load_votes, load_comments, load_clojure_output


@pytest.fixture(scope="module", params=["biodiversity", "vw"])
def conversation_data(request):
    """
    Module-scoped fixture that loads and computes conversation once per dataset.
    This avoids redundant computation when running multiple comparison tests.
    """
    dataset_name = request.param

    # Get dataset files using central configuration
    dataset_files = get_dataset_files(dataset_name)
    votes_path = dataset_files['votes']
    comments_path = dataset_files['comments']
    clojure_output_path = dataset_files['math_blob']
    data_dir = dataset_files['data_dir']

    # Load the Clojure output for comparison
    clojure_output = load_clojure_output(clojure_output_path)

    # Create a new conversation
    conv = Conversation(dataset_name)

    # Load votes
    votes = load_votes(votes_path)

    # Load comments
    comments = load_comments(comments_path)

    # Update conversation with votes and comments
    print(f"\n[{dataset_name}] Processing conversation with {len(votes['votes'])} votes and {len(comments['comments'])} comments")
    conv = conv.update_votes(votes)

    # Recompute to generate clustering, PCA, and representativeness
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
    output_dir = os.path.join(os.path.dirname(data_dir), '.test_outputs', 'python_output', dataset_name)
    os.makedirs(output_dir, exist_ok=True)

    # Save the conversation data
    output_path = os.path.join(output_dir, 'conversation_result.json')
    with open(output_path, 'w') as f:
        json.dump(conv.to_dict(), f, indent=2)

    print(f"[{dataset_name}] Saved results to {output_path}")

    # Return all data needed for comparison tests
    return {
        'conv': conv,
        'clojure_output': clojure_output,
        'dataset_name': dataset_name,
        'comments': comments
    }


def test_basic_outputs(conversation_data):
    """
    Test that basic pipeline outputs are calculated correctly.
    This test checks that the pipeline runs successfully and produces
    representativeness calculations.
    """
    dataset_name = conversation_data['dataset_name']
    conv = conversation_data['conv']

    print(f"\n[{dataset_name}] Testing basic outputs...")

    # Compare basic pipeline outputs like representativeness
    check.is_not_none(conv.repness, "Representativeness should be calculated")
    check.is_in('comment_repness', conv.repness or {}, "Comment representativeness should exist")
    if conv.repness and 'comment_repness' in conv.repness:
        check.greater(len(conv.repness['comment_repness']), 0, "Should have representative comments")


@pytest.mark.skip(reason="Clojure regression tests not yet fully implemented - clustering algorithms may differ")
def test_group_clustering(conversation_data):
    """
    Test that group clustering matches the Clojure implementation.
    This test compares the number of groups, group sizes, and membership
    overlap between Python and Clojure implementations.
    
    NOTE: Currently skipped as there are known differences between Python and Clojure
    clustering implementations that need to be resolved.
    """
    dataset_name = conversation_data['dataset_name']
    conv = conversation_data['conv']
    clojure_output = conversation_data['clojure_output']

    print(f"\n[{dataset_name}] Testing group clustering...")

    # Compare group clustering results between Python and Clojure implementations
    if 'group-clusters' not in clojure_output:
        check.is_in('group-clusters', clojure_output, "Clojure output should contain group-clusters")
        return

    print(f"[{dataset_name}] Comparing group clustering:")
    clojure_clusters = clojure_output['group-clusters']
    python_clusters = conv.group_clusters

    # 1. Compare number of groups
    clojure_n_groups = len(clojure_clusters)
    python_n_groups = len(python_clusters)
    print(f"  Number of groups - Python: {python_n_groups}, Clojure: {clojure_n_groups}")
    check.equal(python_n_groups, clojure_n_groups,
               f"Number of groups should match (Python: {python_n_groups}, Clojure: {clojure_n_groups})")

    if python_n_groups != clojure_n_groups:
        return

    # 2. Match groups by best overlap (groups may be numbered differently)
    python_to_clojure_mapping = {}
    used_clojure_groups = set()

    print("\n  Finding best group mappings:")
    for py_idx in range(python_n_groups):
        python_members = set(python_clusters[py_idx]['members'])
        best_clj_idx = None
        best_jaccard = -1.0

        for clj_idx in range(clojure_n_groups):
            if clj_idx in used_clojure_groups:
                continue
            clojure_members = set(clojure_clusters[clj_idx]['members'])
            intersection = len(python_members & clojure_members)
            union = len(python_members | clojure_members)
            jaccard = (intersection / union) if union > 0 else 0

            if best_clj_idx is None or jaccard > best_jaccard:
                best_jaccard = jaccard
                best_clj_idx = clj_idx

        if best_clj_idx is not None:
            python_to_clojure_mapping[py_idx] = best_clj_idx
            used_clojure_groups.add(best_clj_idx)
            print(f"    Python group {py_idx} -> Clojure group {best_clj_idx} (Jaccard: {best_jaccard*100:.1f}%)")
        else:
            print(f"    Python group {py_idx} -> No matching Clojure group found")

    # 3. Compare group sizes with matched groups
    print("\n  Comparing matched group sizes:")
    for py_idx, clj_idx in python_to_clojure_mapping.items():
        clojure_size = len(clojure_clusters[clj_idx]['members'])
        python_size = len(python_clusters[py_idx]['members'])
        print(f"    Python group {py_idx} ({python_size} members) <-> Clojure group {clj_idx} ({clojure_size} members)")

        size_diff_pct = abs(python_size - clojure_size) / max(clojure_size, 1) * 100
        check.less_equal(size_diff_pct, 15.0,
                       f"Matched groups (Py:{py_idx}/Clj:{clj_idx}) size difference should be ≤15% (Python: {python_size}, Clojure: {clojure_size}, diff: {size_diff_pct:.1f}%)")

    # 4. Compare group membership overlap with matched groups
    print("\n  Comparing matched group membership:")
    for py_idx, clj_idx in python_to_clojure_mapping.items():
        clojure_members = set(clojure_clusters[clj_idx]['members'])
        python_members = set(python_clusters[py_idx]['members'])

        intersection = len(clojure_members & python_members)
        union = len(clojure_members | python_members)
        jaccard_similarity = (intersection / union * 100) if union > 0 else 0
        symmetric_diff = len(clojure_members ^ python_members)

        print(f"    Python group {py_idx} <-> Clojure group {clj_idx}:")
        print(f"      Jaccard similarity: {jaccard_similarity:.1f}%")
        print(f"      Symmetric difference: {symmetric_diff} members")
        print(f"      Intersection: {intersection}/{union} members")

        check.greater_equal(jaccard_similarity, 70.0,
                          f"Matched groups (Py:{py_idx}/Clj:{clj_idx}) should have ≥70% Jaccard similarity (got {jaccard_similarity:.1f}%)")


@pytest.mark.skip(reason="Clojure regression tests not yet fully implemented - comment priorities may differ")
def test_comment_priorities(conversation_data):
    """
    Test that comment priorities match the Clojure implementation.
    This test compares the priority values assigned to comments between
    Python and Clojure implementations.
    """
    dataset_name = conversation_data['dataset_name']
    conv = conversation_data['conv']
    clojure_output = conversation_data['clojure_output']

    print(f"\n[{dataset_name}] Testing comment priorities...")

    # Compare comment priorities between Python and Clojure implementations
    print(f"[{dataset_name}] Comparing comment priorities:")
    has_python_priorities = hasattr(conv, 'comment_priorities')
    has_clojure_priorities = 'comment-priorities' in clojure_output

    check.is_true(has_python_priorities, "Python output should have comment_priorities attribute")
    check.is_true(has_clojure_priorities, "Clojure output should have comment-priorities")

    if not (has_python_priorities and has_clojure_priorities):
        return

    python_priorities = conv.comment_priorities
    clojure_priorities = clojure_output['comment-priorities']

    # Count matching priorities (approximately)
    matches = 0
    total = 0

    for comment_id, priority in python_priorities.items():
        if comment_id in clojure_priorities:
            clojure_priority = float(clojure_priorities[comment_id])
            # Allow for some numerical differences
            if abs(priority - clojure_priority) / max(1, clojure_priority) < 0.2:  # 20% tolerance
                matches += 1
            total += 1

    match_percentage = (matches / total * 100) if total > 0 else 0
    print(f"  Priority matches: {matches}/{total} ({match_percentage:.1f}%)")

    # Soft assertions for Clojure comparison
    check.greater(total, 0, "Should have comment priorities to compare with Clojure")
    check.greater_equal(match_percentage, 70.0,
                      f"Priority match rate with Clojure should be ≥70% (got {match_percentage:.1f}%)")
