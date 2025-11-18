#!/usr/bin/env python3
"""
Comprehensive test of ID type handling in NEW version.
Tests how the new version handles different input types for participant and comment IDs.
"""

import pytest
from polismath.conversation.conversation import Conversation


# ============================================================================
# CONVERSATION TESTS (full pipeline)
# ============================================================================

@pytest.mark.parametrize("ptpt_ids,comment_ids,expected_ptpt_types,expected_ptpts_sorted,expected_comment_types,expected_comments_sorted", [
    # Integer IDs - should be converted to strings and sorted lexicographically
    (
        [1, 10, 2, 100, 5, 50],
        [3, 30, 20, 4],
        ['str', 'str', 'str', 'str', 'str', 'str'],
        ['1', '10', '100', '2', '5', '50'],  # Lexicographic order as strings
        ['str', 'str', 'str', 'str'],
        ['20', '3', '30', '4']  # Lexicographic order as strings
    ),
    # String IDs (numeric) - should preserve type and sort lexicographically
    (
        ['1', '10', '2', '100', '5', '50'],
        ['3', '30', '20', '4'],
        ['str', 'str', 'str', 'str', 'str', 'str'],
        ['1', '10', '100', '2', '5', '50'],
        ['str', 'str', 'str', 'str'],
        ['20', '3', '30', '4']
    ),
    # String IDs (alphanumeric) - should preserve type and sort lexicographically
    (
        ['user1', 'user10', 'user2', 'user100'],
        ['comment1', 'comment10', 'comment2'],
        ['str', 'str', 'str', 'str'],
        ['user1', 'user10', 'user100', 'user2'],
        ['str', 'str', 'str'],
        ['comment1', 'comment10', 'comment2']
    ),
    # String IDs (short alphanumeric) - should preserve type and sort lexicographically
    (
        ['p1', 'p10', 'p2', 'p100', 'p5', 'p50'],
        ['c1', 'c10', 'c2', 'c20'],
        ['str', 'str', 'str', 'str', 'str', 'str'],
        ['p1', 'p10', 'p100', 'p2', 'p5', 'p50'],
        ['str', 'str', 'str', 'str'],
        ['c1', 'c10', 'c2', 'c20']
    ),
    # Float IDs - should be converted to strings and sorted lexicographically
    (
        [1.0, 10.0, 2.0, 100.0, 5.0, 50.0],
        [3.0, 30.0, 20.0, 4.0],
        ['str', 'str', 'str', 'str', 'str', 'str'],
        ['1.0', '10.0', '100.0', '2.0', '5.0', '50.0'],
        ['str', 'str', 'str', 'str'],
        ['20.0', '3.0', '30.0', '4.0']
    ),
])
def test_conversation_homogeneous_types(ptpt_ids, comment_ids, expected_ptpt_types, expected_ptpts_sorted, expected_comment_types, expected_comments_sorted):
    """Test Conversation with homogeneous ID types (all same type)."""
    conv = Conversation(conversation_id='test_conv')

    # Create votes: each participant votes on each comment
    votes = []
    for ptpt_id in ptpt_ids:
        for comment_id in comment_ids:
            # Alternate between 1 and -1 votes
            vote_val = 1 if (hash(str(ptpt_id)) + hash(str(comment_id))) % 2 == 0 else -1
            votes.append({
                'pid': ptpt_id,
                'tid': comment_id,
                'vote': vote_val
            })

    # Update conversation with votes
    conv = conv.update_votes({'votes': votes})

    # Get resulting row and column names from rating matrix
    result_ptpts = list(conv.rating_mat.index)
    result_tids = list(conv.rating_mat.columns)

    # Check that types are converted to strings
    assert [type(x).__name__ for x in result_ptpts] == expected_ptpt_types, \
        f"Participant types not as expected: {[type(x).__name__ for x in result_ptpts]} != {expected_ptpt_types}"
    assert [type(x).__name__ for x in result_tids] == expected_comment_types, \
        f"Comment types not as expected: {[type(x).__name__ for x in result_tids]} != {expected_comment_types}"

    # Check that IDs are sorted correctly (lexicographically as strings)
    assert result_ptpts == expected_ptpts_sorted, \
        f"Participants not sorted correctly: {result_ptpts} != {expected_ptpts_sorted}"
    assert result_tids == expected_comments_sorted, \
        f"Comments not sorted correctly: {result_tids} != {expected_comments_sorted}"

    # Check that they're in sorted order
    assert result_ptpts == sorted(result_ptpts), \
        f"Participants not in sorted order: {result_ptpts} != {sorted(result_ptpts)}"
    assert result_tids == sorted(result_tids), \
        f"Comments not in sorted order: {result_tids} != {sorted(result_tids)}"


def test_conversation_mixed_types():
    """Test Conversation with mixed integer and string IDs."""
    conv = Conversation(conversation_id='test_conv')

    # Create votes with mixed integer and string IDs
    votes = [
        {'pid': 'alpha', 'tid': 10, 'vote': 1},
        {'pid': 2, 'tid': 'beta', 'vote': 1},
        {'pid': 'gamma', 'tid': 1, 'vote': -1},
        {'pid': 10, 'tid': 'alpha', 'vote': 1},
        {'pid': 1, 'tid': 'zeta', 'vote': -1},
        {'pid': 'beta', 'tid': 2, 'vote': 1},
    ]

    conv = conv.update_votes({'votes': votes})

    # Get participant and comment IDs
    pids = list(conv.rating_mat.index)
    tids = list(conv.rating_mat.columns)

    # All IDs should be converted to strings
    assert all(isinstance(p, str) for p in pids), \
        f"Not all PIDs are strings: {[type(p).__name__ for p in pids]}"
    assert all(isinstance(t, str) for t in tids), \
        f"Not all TIDs are strings: {[type(t).__name__ for t in tids]}"

    # Check expected lexicographic order (as strings)
    expected_pids = sorted(['1', '2', '10', 'alpha', 'beta', 'gamma'])
    expected_tids = sorted(['1', '2', '10', 'alpha', 'beta', 'zeta'])

    assert pids == expected_pids, f"PIDs not in expected order: {pids} != {expected_pids}"
    assert tids == expected_tids, f"TIDs not in expected order: {tids} != {expected_tids}"


def test_conversation_numeric_only():
    """Test Conversation with ONLY numeric IDs."""
    conv = Conversation(conversation_id='test_conv')

    votes = [
        {'pid': 5, 'tid': 10, 'vote': 1},
        {'pid': 3, 'tid': 5, 'vote': 1},
        {'pid': 1, 'tid': 20, 'vote': -1},
    ]

    conv = conv.update_votes({'votes': votes})

    # Check internal storage
    pids = list(conv.rating_mat.index)
    tids = list(conv.rating_mat.columns)

    # All should be converted to strings
    assert all(isinstance(p, str) for p in pids), \
        f"Not all PIDs are strings: {[type(p).__name__ for p in pids]}"
    assert all(isinstance(t, str) for t in tids), \
        f"Not all TIDs are strings: {[type(t).__name__ for t in tids]}"

    # Check lexicographic order (as strings)
    expected_pids = ['1', '3', '5']
    expected_tids = ['10', '20', '5']  # Lexicographic: '10' < '20' < '5'

    assert pids == expected_pids, f"PIDs not in expected order: {pids} != {expected_pids}"
    assert tids == expected_tids, f"TIDs not in expected order: {tids} != {expected_tids}"

    # Check exported data (converts back to int but maintains order)
    conv_dict = conv.to_dict()
    exported_tids = conv_dict.get('tids', [])

    # Should be converted back to integers but maintain lexicographic order
    assert all(isinstance(t, int) for t in exported_tids), \
        f"Not all exported TIDs are ints: {[type(t).__name__ for t in exported_tids]}"

    expected_exported = [10, 20, 5]  # Same lexicographic order, converted to int
    assert exported_tids == expected_exported, \
        f"Exported TIDs not in expected order: {exported_tids} != {expected_exported}"


# ============================================================================
# SUMMARY FUNCTION (for documentation/manual inspection)
# ============================================================================

def print_summary():
    """Print summary of findings (not a test, just documentation)."""
    print("\n" + "="*70)
    print("SUMMARY OF FINDINGS - NEW VERSION")
    print("="*70)
    print("\nConversation (full pipeline):")
    print("  - Converts ALL IDs to strings via str()")
    print("  - Stores and sorts as strings (lexicographically)")
    print("  - Exports: converts back to int if isdigit(), maintains order")
    print("  - Result: lexicographic order preserved even after int conversion")
    print()


if __name__ == "__main__":
    print("="*70)
    print("RUN WITH: pytest delphi/tests/test_id_type_behavior.py -v")
    print("="*70)
    print_summary()
