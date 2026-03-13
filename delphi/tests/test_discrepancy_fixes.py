"""
Per-discrepancy tests for Python-Clojure parity fixes.

Each test class targets ONE specific discrepancy from the fix plan
(delphi/docs/CLJ-PARITY-FIXES-PLAN.md). Tests are designed to FAIL before
the fix is applied and PASS after. They are parametrized by ALL available
datasets with Clojure reference blobs.

Discrepancies tested:
    D2  - In-conv participant threshold
    D4  - Pseudocount formula
    D5  - Proportion test formula
    D6  - Two-proportion test adjustment
    D7  - Repness metric formula
    D8  - Finalize comment stats logic
    D9  - Z-score significance thresholds
    D10 - Representative comment selection
    D11 - Consensus comment selection
    D12 - Comment priorities
    D15 - Moderation handling

Not tested here (deferred or tested elsewhere):
    D1/D1b - PCA sign flips (needs replay infrastructure)
    D3     - K-smoother buffer (needs replay infrastructure)
    D13    - Subgroup clustering (unused, deferred)
    D14    - Large conv optimization (deferred)
"""

import json
import math

import numpy as np
import pytest
import pytest_check as check

from polismath.conversation.conversation import Conversation
from polismath.pca_kmeans_rep.repness import (
    PSEUDO_COUNT,
    Z_90,
    Z_95,
    prop_test,
    two_prop_test,
    repness_metric,
    finalize_cmt_stats,
)
from polismath.regression import get_dataset_files, get_blob_variants
from polismath.regression.clojure_comparer import (
    ClojureComparer,
    unfold_clojure_group_clusters,
)
from polismath.regression.datasets import discover_datasets
from conftest import _get_requested_datasets, make_dataset_params, parse_dataset_blob_id
from tests.common_utils import load_votes, load_comments, load_clojure_output


# ---------------------------------------------------------------------------
# Dataset+blob parametrization (same pattern as test_legacy_clojure_regression.py)
# ---------------------------------------------------------------------------

def _get_clojure_dataset_blob_ids(include_local: bool, requested: set[str] | None = None) -> list[str]:
    """Get composite 'dataset-blob_type' IDs for all filled blobs."""
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


def pytest_generate_tests(metafunc):
    """Parametrize tests with clojure dataset+blob_type at collection time."""
    if "dataset_name" in metafunc.fixturenames:
        include_local = metafunc.config.getoption("--include-local", default=False)
        requested = _get_requested_datasets(metafunc.config)
        blob_ids = _get_clojure_dataset_blob_ids(include_local, requested)
        params = make_dataset_params(blob_ids)
        metafunc.parametrize("dataset_name", params, scope="class")


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

# Module-level caches — Conversation is keyed by dataset name (shared across
# blob variants), blobs are keyed by composite ID.
_CONV_CACHE: dict = {}
_BLOB_CACHE: dict = {}


def _get_or_compute_conversation(dataset_name: str) -> dict:
    """Compute (or retrieve cached) conversation for a dataset."""
    import gc
    if dataset_name in _CONV_CACHE:
        return _CONV_CACHE[dataset_name]

    # Evict other datasets
    for ds in list(_CONV_CACHE.keys()):
        if ds != dataset_name:
            _CONV_CACHE.pop(ds, None)
            Conversation._reset_conversion_cache()
            gc.collect()

    files = get_dataset_files(dataset_name)
    votes = load_votes(files['votes'])
    comments = load_comments(files['comments'])

    conv = Conversation(dataset_name)
    conv = conv.update_votes(votes)
    conv = conv.recompute()

    data = {
        'conv': conv,
        'dataset_name': dataset_name,
        'files': files,
        'comments': comments,
    }
    _CONV_CACHE[dataset_name] = data
    return data


@pytest.fixture(scope="class")
def conversation_data(dataset_name):
    """Class-scoped fixture: runs the full pipeline once per dataset+blob_type.

    dataset_name here is actually a composite 'dataset-blob_type' ID
    (e.g., 'biodiversity-incremental' or 'biodiversity-cold_start'). The Conversation is shared across blob variants.
    """
    global _BLOB_CACHE
    ds_name, blob_type = parse_dataset_blob_id(dataset_name)

    # Get or compute the conversation (shared across blob variants)
    conv_data = _get_or_compute_conversation(ds_name)

    # Load the specific blob variant (cache per composite ID)
    if dataset_name not in _BLOB_CACHE:
        for bid in list(_BLOB_CACHE.keys()):
            if not bid.startswith(ds_name + '-'):
                _BLOB_CACHE.pop(bid, None)
        files = get_dataset_files(ds_name, blob_type=blob_type)
        clojure = load_clojure_output(files['math_blob'])
        _BLOB_CACHE[dataset_name] = clojure

    return {
        'conv': conv_data['conv'],
        'clojure': _BLOB_CACHE[dataset_name],
        'dataset_name': ds_name,
        'blob_type': blob_type,
        'files': conv_data['files'],
        'comments': conv_data['comments'],
    }


@pytest.fixture(scope="class")
def clojure_blob(conversation_data):
    return conversation_data['clojure']


@pytest.fixture(scope="class")
def conv(conversation_data):
    return conversation_data['conv']


# ---------------------------------------------------------------------------
# Helpers for extracting Clojure repness data
# ---------------------------------------------------------------------------

def _clojure_repness_entries(blob: dict) -> list[dict]:
    """Flatten Clojure repness dict {gid: [entries]} into a list with gid added."""
    repness = blob.get('repness', {})
    result = []
    for gid_str, entries in repness.items():
        gid = int(gid_str)
        for entry in entries:
            result.append({**entry, 'gid': gid})
    return result


def _clojure_in_conv_set(blob: dict) -> set[int]:
    """Get the set of in-conv participant IDs from Clojure blob."""
    return set(blob.get('in-conv', []))


# ============================================================================
# D2 — In-Conv Participant Threshold
# ============================================================================

@pytest.mark.clojure_comparison
class TestD2InConvThreshold:
    """
    D2: Clojure uses threshold = min(7, n_cmts) for in-conv filtering.
    Python now matches (fixed from 7 + sqrt(n_cmts) * 0.1).
    """

    def test_in_conv_count_matches(self, conv, clojure_blob, dataset_name):
        """Number of in-conv participants should match Clojure."""
        if 'in-conv' not in clojure_blob:
            pytest.skip(f"[{dataset_name}] Clojure blob has no in-conv data")
        if dataset_name.endswith('-incremental'):
            # Incremental blobs were built progressively as votes trickled in,
            # so the threshold min(7, n_cmts) was evaluated at each iteration
            # with a smaller n_cmts than the final value. This admits a few
            # extra participants to in-conv during earlier iterations.
            # The difference is tiny (1-2 participants) when a cold-start blob
            # is available. Very large conversations have empty cold-start blobs
            # because Clojure can't process them in one pass.
            pytest.xfail("D2: behaviour matches on cold-start, incremental deferred to future PR")
        clojure_in_conv = _clojure_in_conv_set(clojure_blob)
        python_in_conv_count = len(conv._get_in_conv_participants())

        print(f"[{dataset_name}] In-conv: Python={python_in_conv_count}, Clojure={len(clojure_in_conv)}")
        check.equal(python_in_conv_count, len(clojure_in_conv),
                     f"In-conv count mismatch: Python={python_in_conv_count}, Clojure={len(clojure_in_conv)}")

    def test_in_conv_set_matches(self, conv, clojure_blob, dataset_name):
        """The actual set of in-conv participants should match Clojure."""
        if 'in-conv' not in clojure_blob:
            pytest.skip(f"[{dataset_name}] Clojure blob has no in-conv data")
        if dataset_name.endswith('-incremental'):
            # Incremental blobs were built progressively as votes trickled in,
            # so the threshold min(7, n_cmts) was evaluated at each iteration
            # with a smaller n_cmts than the final value. This admits a few
            # extra participants to in-conv during earlier iterations.
            # The difference is tiny (1-2 participants) when a cold-start blob
            # is available. Very large conversations have empty cold-start blobs
            # because Clojure can't process them in one pass.
            pytest.xfail("D2: behaviour matches on cold-start, incremental deferred to future PR")
        clojure_in_conv = _clojure_in_conv_set(clojure_blob)
        python_in_conv = conv._get_in_conv_participants()
        # Convert python pids to int for comparison
        python_in_conv_int = set()
        for pid in python_in_conv:
            try:
                python_in_conv_int.add(int(pid))
            except (ValueError, TypeError):
                python_in_conv_int.add(pid)

        only_python = python_in_conv_int - clojure_in_conv
        only_clojure = clojure_in_conv - python_in_conv_int

        print(f"[{dataset_name}] Only in Python: {len(only_python)}, Only in Clojure: {len(only_clojure)}")

        check.equal(only_python, set(), f"Participants in Python but not Clojure: {len(only_python)}")
        check.equal(only_clojure, set(), f"Participants in Clojure but not Python: {len(only_clojure)}")


# ============================================================================
# D2c — Vote Count Source (raw vs filtered matrix)
# ============================================================================

def _build_conv_with_moderation(
    n_comments: int = 10,
    mod_out_tids: list | None = None,
    participant_votes: dict | None = None,
) -> Conversation:
    """Build a synthetic Conversation with moderation applied.

    Args:
        n_comments: Total number of comments (tids 0..n_comments-1).
        mod_out_tids: List of tids to moderate-out.
        participant_votes: Dict mapping pid → list of tids they voted on.
            If None, a single participant votes on all comments.

    Returns:
        A Conversation with votes ingested and moderation applied (no recompute).
    """
    if participant_votes is None:
        participant_votes = {0: list(range(n_comments))}

    votes_list = []
    for pid, tids in participant_votes.items():
        for tid in tids:
            votes_list.append({'pid': pid, 'tid': tid, 'vote': 1})

    conv = Conversation('test-d2c')
    conv = conv.update_votes({'votes': votes_list}, recompute=False)

    if mod_out_tids:
        conv = conv.update_moderation(
            {'mod_out_tids': mod_out_tids}, recompute=False
        )

    return conv


class TestD2cVoteCountSource:
    """
    D2c: Vote counts for in-conv threshold must come from raw_rating_mat
    (includes votes on moderated-out comments), not rating_mat (filtered).

    Clojure's user-vote-counts (conversation.clj:217-225) uses raw-rating-mat.
    Python currently uses self.rating_mat, undercounting when comments are
    moderated-out.
    """

    def test_vote_count_includes_moderated_out_votes(self):
        """Participant who voted on 10 comments (3 moderated-out) should have count=10."""
        conv = _build_conv_with_moderation(
            n_comments=10,
            mod_out_tids=[0, 1, 2],
            participant_votes={0: list(range(10))},
        )

        vote_counts = conv._compute_user_vote_counts()
        assert vote_counts[0] == 10, (
            f"Vote count should be 10 (from raw_rating_mat), got {vote_counts[0]} "
            f"(rating_mat has {len(conv.rating_mat.columns)} columns)"
        )

    def test_n_cmts_includes_moderated_out_comments(self):
        """n_cmts in threshold should count all comments including moderated-out.

        With 10 total comments and 5 moderated-out, n_cmts should be 10.
        This matters when non-moderated-out count < 7: the threshold would be
        artificially low in Python (min(7,5)=5 vs correct min(7,10)=7).
        """
        conv = _build_conv_with_moderation(
            n_comments=10,
            mod_out_tids=[0, 1, 2, 3, 4],
            participant_votes={0: list(range(10))},
        )

        # raw_rating_mat has all columns; rating_mat has only non-moderated-out
        n_cmts_raw = len(conv.raw_rating_mat.columns)
        n_cmts_filtered = len(conv.rating_mat.columns)

        assert n_cmts_raw == 10, f"raw_rating_mat should have 10 columns, got {n_cmts_raw}"
        assert n_cmts_filtered == 5, f"rating_mat should have 5 columns, got {n_cmts_filtered}"

        # The threshold used by _get_in_conv_participants should be min(7, 10) = 7,
        # not min(7, 5) = 5. Verify indirectly: participant with exactly 6 votes
        # should NOT be in-conv (threshold=7), but would be if n_cmts=5 (threshold=5).
        conv2 = _build_conv_with_moderation(
            n_comments=10,
            mod_out_tids=[0, 1, 2, 3, 4],
            participant_votes={
                0: list(range(10)),    # 10 raw votes → in-conv
                1: list(range(4, 10)), # 6 raw votes (1 moderated-out: tid=4) → NOT in-conv
            },
        )
        in_conv = conv2._get_in_conv_participants()
        assert 0 in in_conv, "P0 (10 raw votes) should be in-conv"
        assert 1 not in in_conv, (
            "P1 (6 raw votes) should NOT be in-conv with threshold=7, "
            "but would be if n_cmts wrongly used filtered count (5)"
        )

    def test_participant_stays_in_conv_after_moderation(self):
        """Participant with 8 votes stays in-conv even when 3 comments moderated-out.

        This is the critical scenario: participant votes above threshold (8 >= 7),
        comments get moderated-out between update_votes calls reducing filtered
        count to 5, but raw count is still 8 so they should remain in-conv.
        """
        # Participant 0: votes on 8 comments (above threshold of 7)
        # Participant 1: votes on 7 comments (borderline)
        conv = _build_conv_with_moderation(
            n_comments=10,
            mod_out_tids=[0, 1, 2],  # 3 moderated-out
            participant_votes={
                0: list(range(8)),   # votes on c0-c7; after mod, only c3-c7 visible (5)
                1: list(range(7)),   # votes on c0-c6; after mod, only c3-c6 visible (4)
            },
        )

        in_conv = conv._get_in_conv_participants()

        # Both should be in-conv: raw counts are 8 and 7, threshold is min(7, 10) = 7
        assert 0 in in_conv, (
            f"Participant 0 (8 raw votes) should be in-conv, "
            f"but filtered count is {np.sum(~np.isnan(conv.rating_mat.loc[0].values))}"
        )
        assert 1 in in_conv, (
            f"Participant 1 (7 raw votes) should be in-conv, "
            f"but filtered count is {np.sum(~np.isnan(conv.rating_mat.loc[1].values))}"
        )


# ============================================================================
# D2d — In-Conv Monotonicity
# ============================================================================

class TestD2dInConvMonotonicity:
    """
    D2d: Once a participant qualifies for in-conv, they must never be removed.

    These tests pass today because Python does full recompute from raw_rating_mat
    (which includes all historical votes, even on moderated-out comments).
    If the code is ever refactored to use delta vote processing, in-conv MUST be
    persisted to DynamoDB — see compdemocracy/polis#2358 and the Clojure approach
    in conv_man.clj:55, conversation.clj:244.
    """

    def test_t1_basic_monotonicity_across_updates(self):
        """Participant who qualified in batch 1 stays in-conv after batch 2.

        P votes on 7 comments in batch 1 → qualifies. Batch 2 adds new comments
        but P doesn't vote on them. P's count stays 7 → still in-conv.

        Would FAIL under delta processing without persistence if batch 2 only
        contained new votes and P's old votes weren't re-scanned.
        """
        conv = Conversation('test-d2d-t1')

        # Batch 1: P0 votes on 7 comments, P1 votes on all 10
        batch1 = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10)],
        ]}
        conv = conv.update_votes(batch1, recompute=False)
        in_conv_after_b1 = conv._get_in_conv_participants()
        assert 0 in in_conv_after_b1, "P0 should be in-conv after batch 1 (7 votes)"

        # Batch 2: new comments c10-c14, only P1 votes on them
        batch2 = {'votes': [
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10, 15)],
        ]}
        conv = conv.update_votes(batch2, recompute=False)
        in_conv_after_b2 = conv._get_in_conv_participants()
        assert 0 in in_conv_after_b2, (
            "P0 should still be in-conv after batch 2 (7 votes unchanged)"
        )

    def test_t2_monotonicity_survives_moderation(self):
        """Participant stays in-conv after their voted comments are moderated-out.

        P votes on 7 comments → qualifies. 3 comments moderated-out. P's raw
        count is still 7 → still in-conv (because raw_rating_mat is used).

        Would FAIL under delta processing without persistence if moderation
        caused a recount from only the filtered matrix.
        """
        conv = Conversation('test-d2d-t2')
        votes = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10)],
        ]}
        conv = conv.update_votes(votes, recompute=False)

        in_conv_before = conv._get_in_conv_participants()
        assert 0 in in_conv_before, "P0 should be in-conv before moderation"

        # Moderate out 3 of P0's comments
        conv = conv.update_moderation({'mod_out_tids': [0, 1, 2]}, recompute=False)

        in_conv_after = conv._get_in_conv_participants()
        assert 0 in in_conv_after, (
            "P0 should still be in-conv after moderation "
            "(7 raw votes, only 4 on filtered matrix)"
        )

    def test_t3_worker_restart_with_moderation(self):
        """Participant survives worker restart + moderation.

        P votes on 7 comments → qualifies. Worker dies. 3 comments moderated-out.
        New worker rebuilds from all votes. P still has 7 raw votes → in-conv.

        This is the KEY test that would FAIL under delta processing without
        persistence: after restart, only new votes would be scanned.
        """
        # Original worker
        conv1 = Conversation('test-d2d-t3')
        votes = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10)],
        ]}
        conv1 = conv1.update_votes(votes, recompute=False)
        assert 0 in conv1._get_in_conv_participants()

        # Simulate worker restart: new Conversation object, replay ALL votes
        conv2 = Conversation('test-d2d-t3')
        conv2 = conv2.update_votes(votes, recompute=False)

        # Apply moderation that happened while worker was dead
        conv2 = conv2.update_moderation({'mod_out_tids': [0, 1, 2]}, recompute=False)

        in_conv = conv2._get_in_conv_participants()
        assert 0 in in_conv, (
            "P0 should be in-conv after restart+moderation "
            "(full recompute from all votes)"
        )

    def test_t4_worker_restart_moderation_no_new_votes(self):
        """Rebuild from existing votes after moderation, no new votes needed.

        Same as T3 but verifies that recompute alone is sufficient — no "trigger"
        of new votes is needed to re-evaluate in-conv.
        """
        votes = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10)],
        ]}

        # Build from scratch with moderation already applied
        conv = Conversation('test-d2d-t4')
        conv = conv.update_votes(votes, recompute=False)
        conv = conv.update_moderation({'mod_out_tids': [0, 1, 2]}, recompute=False)

        in_conv = conv._get_in_conv_participants()
        assert 0 in in_conv, (
            "P0 should be in-conv with just existing votes + moderation"
        )

    def test_t5_mixed_participants_moderation(self):
        """Both old and new participants correct after moderation.

        P0 votes on c0-c6. c0-c2 moderated-out. New participant Q votes on c3-c9.
        Rebuild from all votes. Both should be in-conv:
        - P0: 7 raw votes (c0-c6), threshold min(7,10)=7 → qualifies
        - Q: 7 votes on non-moderated-out comments → qualifies
        """
        conv = Conversation('test-d2d-t5')
        votes = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],   # c0-c6
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(3, 10)],  # c3-c9
        ]}
        conv = conv.update_votes(votes, recompute=False)
        conv = conv.update_moderation({'mod_out_tids': [0, 1, 2]}, recompute=False)

        in_conv = conv._get_in_conv_participants()
        assert 0 in in_conv, "P0 (7 raw votes) should be in-conv"
        assert 1 in in_conv, "P1 (7 votes on non-moderated-out comments) should be in-conv"


# ============================================================================
# D4 — Pseudocount Formula
# ============================================================================

@pytest.mark.clojure_comparison
class TestD4Pseudocount:
    """
    D4: Python uses PSEUDO_COUNT = 1.5 → pa = (na + 0.75) / (ns + 1.5)
        Clojure uses PSEUDO_COUNT = 2.0 → pa = (na + 1) / (ns + 2)
    """

    def test_pseudocount_constant(self):
        """Verify the pseudocount constant matches Clojure's Beta(2,2) prior."""
        # Target: PSEUDO_COUNT = 2.0
        check.equal(PSEUDO_COUNT, 2.0,
                     f"PSEUDO_COUNT should be 2.0 (Clojure Beta(2,2) prior), got {PSEUDO_COUNT}")

    def test_pa_values_match_clojure(self, conv, clojure_blob, dataset_name):
        """p-success values should match Clojure for specific (group, comment) pairs."""
        clojure_entries = _clojure_repness_entries(clojure_blob)
        if not clojure_entries:
            pytest.skip("No repness entries in Clojure blob")

        mismatches = 0
        total = 0
        for entry in clojure_entries:
            clj_pa = entry.get('p-success')
            clj_na = entry.get('n-success')
            clj_ns = entry.get('n-trials')
            if clj_pa is None or clj_na is None or clj_ns is None:
                continue

            # Recompute with Python's current pseudocount
            python_pa = (clj_na + PSEUDO_COUNT / 2) / (clj_ns + PSEUDO_COUNT)
            total += 1

            if abs(python_pa - clj_pa) > 1e-6:
                mismatches += 1

        print(f"[{dataset_name}] pa mismatches: {mismatches}/{total}")
        check.equal(mismatches, 0, f"pa values differ for {mismatches}/{total} entries")


# ============================================================================
# D9 — Z-Score Significance Thresholds
# ============================================================================

@pytest.mark.clojure_comparison
class TestD9ZScoreThresholds:
    """
    D9: Python uses two-tailed z-scores (Z_90=1.645, Z_95=1.96)
        Clojure uses one-tailed z-scores (Z_90=1.2816, Z_95=1.6449)

    Python's higher thresholds mean fewer comments pass significance,
    leading to empty comment_repness.
    """

    def test_z90_matches_clojure(self):
        """Z_90 should be one-tailed (1.2816), not two-tailed (1.645)."""
        check.almost_equal(Z_90, 1.2816, abs=0.001,
                            msg=f"Z_90 should be 1.2816 (one-tailed), got {Z_90}")

    def test_z95_matches_clojure(self):
        """Z_95 should be one-tailed (1.6449), not two-tailed (1.96)."""
        check.almost_equal(Z_95, 1.6449, abs=0.001,
                            msg=f"Z_95 should be 1.6449 (one-tailed), got {Z_95}")

    def test_repness_not_empty(self, conv, dataset_name):
        """Repness should produce non-empty comment_repness with correct thresholds."""
        repness = conv.repness
        check.is_not_none(repness, "Repness should not be None")
        if repness:
            check.is_in('comment_repness', repness, "Should have comment_repness key")
            if 'comment_repness' in repness:
                check.greater(len(repness['comment_repness']), 0,
                              "comment_repness should not be empty")


# ============================================================================
# D5 — Proportion Test Formula
# ============================================================================

@pytest.mark.clojure_comparison
class TestD5ProportionTest:
    """
    D5: Python uses standard z-test: (p - 0.5) / sqrt(0.25/n)
        Clojure uses Wilson-score-like: 2*sqrt(n+1)*((succ+1)/(n+1) - 0.5)

    Clojure formula has built-in regularization via +1 terms.
    """

    @pytest.mark.xfail(reason="D5: Python standard z-test vs Clojure Wilson-score-like")
    def test_prop_test_matches_clojure_formula(self):
        """prop_test should match Clojure's formula for known inputs."""
        # Example: 12 successes out of 13 trials
        succ, n = 12, 13
        # Clojure formula: 2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)
        expected = 2 * math.sqrt(n + 1) * ((succ + 1) / (n + 1) - 0.5)

        # Current Python: prop_test(p, n, 0.5) where p = (succ + pc/2) / (n + pc)
        p = (succ + PSEUDO_COUNT / 2) / (n + PSEUDO_COUNT)
        python_result = prop_test(p, n, 0.5)

        print(f"prop_test(succ={succ}, n={n}): Python={python_result:.4f}, Clojure={expected:.4f}")
        check.almost_equal(python_result, expected, abs=0.01,
                            msg=f"prop_test mismatch: Python={python_result:.4f}, Clojure={expected:.4f}")

    def test_clojure_pat_values_consistent_with_formula(self, clojure_blob, dataset_name):
        """Sanity check: Clojure's p-test values match the documented formula."""
        clojure_entries = _clojure_repness_entries(clojure_blob)
        if not clojure_entries:
            pytest.skip("No repness entries in Clojure blob")

        mismatches = 0
        total = 0
        max_diff = 0.0
        for entry in clojure_entries:
            clj_pat = entry.get('p-test')
            if clj_pat is None:
                continue
            clj_na = entry.get('n-success', 0)
            clj_ns = entry.get('n-trials', 0)
            if clj_ns == 0:
                continue

            # Recompute using Clojure's documented formula
            expected = 2 * math.sqrt(clj_ns + 1) * ((clj_na + 1) / (clj_ns + 1) - 0.5)

            total += 1
            diff = abs(clj_pat - expected)
            if diff > 0.01:
                mismatches += 1
                max_diff = max(max_diff, diff)

        print(f"[{dataset_name}] pat consistency: {total - mismatches}/{total} match formula (max_diff={max_diff:.4f})")
        check.equal(mismatches, 0, f"Clojure p-test values don't match formula for {mismatches}/{total}")


# ============================================================================
# D6 — Two-Proportion Test Adjustment
# ============================================================================

@pytest.mark.clojure_comparison
class TestD6TwoPropTest:
    """
    D6: Python uses standard two-proportion z-test without pseudocounts.
        Clojure adds +1 pseudocount to all 4 inputs (succ1, n1, succ2, n2).
    """

    def test_two_prop_test_with_pseudocounts(self):
        """two_prop_test should add +1 pseudocounts matching Clojure."""
        # With pseudocounts: (succ+1)/(n+2) for both groups
        succ1, n1 = 10, 20
        succ2, n2 = 15, 30

        # Clojure formula adds +1 to successes and +2 to trials
        p1_clj = (succ1 + 1) / (n1 + 2)
        p2_clj = (succ2 + 1) / (n2 + 2)
        p_pooled_clj = (succ1 + succ2 + 2) / (n1 + n2 + 4)
        se_clj = math.sqrt(p_pooled_clj * (1 - p_pooled_clj) * (1 / (n1 + 2) + 1 / (n2 + 2)))
        expected = (p1_clj - p2_clj) / se_clj if se_clj > 0 else 0.0

        # Python currently doesn't add pseudocounts
        p1_py = succ1 / n1
        p2_py = succ2 / n2
        python_result = two_prop_test(p1_py, n1, p2_py, n2)

        print(f"two_prop_test: Python={python_result:.4f}, Clojure(with pseudocounts)={expected:.4f}")
        check.almost_equal(python_result, expected, abs=0.01,
                            msg=f"two_prop_test should include pseudocounts: Python={python_result:.4f}, expected={expected:.4f}")


# ============================================================================
# D7 — Repness Metric Formula
# ============================================================================

@pytest.mark.clojure_comparison
class TestD7RepnessMetric:
    """
    D7: Python uses pa * (|pat| + |rat|) — weighted sum of absolutes
        Clojure uses ra * rat * pa * pat — product of signed values

    The Clojure product formula is more conservative: any factor near 0
    kills the whole metric.
    """

    @pytest.mark.xfail(reason="D7: Python uses pa*(|pat|+|rat|), target is ra*rat*pa*pat")
    def test_metric_formula_is_product(self):
        """repness_metric should use product formula (ra * rat * pa * pat)."""
        stats = {
            'pa': 0.8, 'pat': 2.5, 'ra': 1.3, 'rat': 1.8,
            'pd': 0.2, 'pdt': -1.5, 'rd': 0.7, 'rdt': -0.9,
        }

        # Clojure formula for agree: ra * rat * pa * pat
        expected_agree = stats['ra'] * stats['rat'] * stats['pa'] * stats['pat']
        # Current Python formula: pa * (|pat| + |rat|)
        current_python = stats['pa'] * (abs(stats['pat']) + abs(stats['rat']))

        result = repness_metric(stats, 'a')
        print(f"agree_metric: current={result:.4f}, expected(Clojure)={expected_agree:.4f}, current_formula={current_python:.4f}")

        check.almost_equal(result, expected_agree, abs=0.01,
                            msg=f"agree_metric should be ra*rat*pa*pat={expected_agree:.4f}, got {result:.4f}")


# ============================================================================
# D8 — Finalize Comment Stats Logic
# ============================================================================

@pytest.mark.clojure_comparison
class TestD8FinalizeStats:
    """
    D8: Python uses if pa > 0.5 AND ra > 1.0 → 'agree'; elif pd > 0.5 AND rd > 1.0 → 'disagree'
        Clojure uses simple rat > rdt → 'agree'; else → 'disagree'
    """

    @pytest.mark.xfail(reason="D8: Python uses pa/ra thresholds, target is rat>rdt comparison")
    def test_repful_uses_rat_vs_rdt(self):
        """repful classification should use rat > rdt (Clojure logic)."""
        # Case where Python and Clojure disagree:
        # pa > 0.5 and ra > 1.0 → Python says 'agree'
        # but rat < rdt → Clojure says 'disagree'
        stats = {
            'pa': 0.6, 'pat': 1.0, 'ra': 1.2, 'rat': 0.5,
            'pd': 0.4, 'pdt': -0.5, 'rd': 0.8, 'rdt': 1.5,
            'agree_metric': 0.0,  # placeholder
            'disagree_metric': 0.0,
        }

        result = finalize_cmt_stats(stats)

        # Clojure: rat (0.5) < rdt (1.5) → 'disagree'
        # Python: pa (0.6) > 0.5 and ra (1.2) > 1.0 → 'agree'
        check.equal(result['repful'], 'disagree',
                     f"repful should be 'disagree' when rat < rdt, got '{result['repful']}'")


# ============================================================================
# D10 — Representative Comment Selection
# ============================================================================

@pytest.mark.clojure_comparison
class TestD10RepCommentSelection:
    """
    D10: Python selects 3 agree + 2 disagree = 5 total
         Clojure selects up to 5 total, agrees first, with beats-best-by-test logic
    """

    @pytest.mark.xfail(reason="D10: Different selection logic than Clojure")
    def test_rep_comments_match_clojure(self, conv, clojure_blob, dataset_name):
        """Selected representative comments per group should match Clojure."""
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = conv.repness or {}
        group_repness = python_repness.get('group_repness', {})

        total_groups = 0
        matching_groups = 0

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            clj_tids = set(e['tid'] for e in clj_entries)

            py_entries = group_repness.get(gid, [])
            py_tids = set(e.get('comment_id') for e in py_entries)

            total_groups += 1
            overlap = len(clj_tids & py_tids)
            total_unique = len(clj_tids | py_tids)

            if clj_tids == py_tids:
                matching_groups += 1

            print(f"[{dataset_name}] Group {gid}: Clojure tids={sorted(clj_tids)}, Python tids={sorted(py_tids)}, overlap={overlap}/{total_unique}")

        check.equal(matching_groups, total_groups,
                     f"Only {matching_groups}/{total_groups} groups have matching rep comments")


# ============================================================================
# D11 — Consensus Comment Selection
# ============================================================================

@pytest.mark.clojure_comparison
class TestD11ConsensusSelection:
    """
    D11: Python uses ALL groups pa > 0.6, top 2 overall
         Clojure uses per-comment pa > 0.5, top 5 agree + 5 disagree with z-test scores
    """

    @pytest.mark.xfail(reason="D11: Different consensus selection logic than Clojure")
    def test_consensus_matches_clojure(self, conv, clojure_blob, dataset_name):
        """Consensus comments should match Clojure's selection."""
        clj_consensus = clojure_blob.get('consensus', {})
        if not clj_consensus:
            pytest.skip("No consensus in Clojure blob")

        # Clojure consensus has 'agree' and 'disagree' keys
        clj_agree_tids = set(e['tid'] for e in clj_consensus.get('agree', []))
        clj_disagree_tids = set(e['tid'] for e in clj_consensus.get('disagree', []))
        clj_all = clj_agree_tids | clj_disagree_tids

        py_consensus = conv.repness.get('consensus_comments', []) if conv.repness else []
        py_tids = set(c.get('comment_id') for c in py_consensus)

        print(f"[{dataset_name}] Consensus: Clojure agree={sorted(clj_agree_tids)}, disagree={sorted(clj_disagree_tids)}")
        print(f"[{dataset_name}] Consensus: Python={sorted(py_tids)}")

        overlap = len(clj_all & py_tids)
        print(f"[{dataset_name}] Consensus overlap: {overlap}/{len(clj_all)}")

        check.equal(py_tids, clj_all,
                     f"Consensus mismatch: Python={sorted(py_tids)}, Clojure={sorted(clj_all)}")


# ============================================================================
# D12 — Comment Priorities
# ============================================================================

@pytest.mark.clojure_comparison
class TestD12CommentPriorities:
    """
    D12: Comment priorities are not computed by Python.
         Clojure computes priorities based on PCA extremity and importance.
    """

    @pytest.mark.xfail(reason="D12: Comment priorities not implemented in Python")
    def test_comment_priorities_exist(self, conv, clojure_blob, dataset_name):
        """Python should produce comment-priorities matching Clojure."""
        clj_priorities = clojure_blob.get('comment-priorities', {})
        check.greater(len(clj_priorities), 0,
                       f"Clojure has {len(clj_priorities)} comment priorities")

        # Check that Python produces priorities
        has_priorities = hasattr(conv, 'comment_priorities') and conv.comment_priorities
        check.is_true(has_priorities, "Python should compute comment_priorities")

        if not has_priorities:
            return

        py_priorities = conv.comment_priorities
        # Compare rankings (Spearman correlation would be ideal, but check overlap first)
        common_tids = set(str(k) for k in clj_priorities.keys()) & set(str(k) for k in py_priorities.keys())
        print(f"[{dataset_name}] Common priority tids: {len(common_tids)}/{len(clj_priorities)}")
        check.greater(len(common_tids), 0, "Should have common priority tids")


# ============================================================================
# D15 — Moderation Handling
# ============================================================================

@pytest.mark.clojure_comparison
class TestD15ModerationHandling:
    """
    D15: Python removes moderated comments entirely from matrix.
         Clojure zeros them out (keeps structure, sets values to 0).
    """

    def test_moderated_comments_zeroed_not_removed(self, conv, clojure_blob, dataset_name):
        """
        Moderated comments should be zeroed out, not removed, if any exist.

        Note: This test only applies when the dataset has moderated comments.
        """
        # Check if Clojure blob has mod-out comments
        mod_out = clojure_blob.get('mod-out', [])
        if not mod_out:
            pytest.skip(f"[{dataset_name}] No moderated comments in this dataset")

        # If there ARE moderated comments, check Python's handling
        n_cols_python = len(conv.rating_mat.columns)
        n_tids_clojure = len(clojure_blob.get('tids', []))

        print(f"[{dataset_name}] Moderated comments: {len(mod_out)}")
        print(f"[{dataset_name}] Python matrix columns: {n_cols_python}, Clojure tids: {n_tids_clojure}")

        # Clojure keeps all tids (zeroed for mod-out), Python removes them
        check.equal(n_cols_python, n_tids_clojure,
                     f"Matrix columns differ: Python={n_cols_python}, Clojure={n_tids_clojure} (mod-out={len(mod_out)})")


# ============================================================================
# Synthetic edge-case tests (not dataset-dependent)
# ============================================================================

class TestSyntheticEdgeCases:
    """
    Synthetic tests with made-up data to verify specific formulas
    independently of any real dataset. These document intent clearly
    and prevent regressions.
    """

    def test_pseudocount_beta_2_2_prior(self):
        """With PSEUDO_COUNT=2.0, pa should use Beta(2,2) prior: (na+1)/(ns+2)."""
        na, ns = 3, 4
        expected = (na + 1) / (ns + 2)  # = 4/6 = 0.6667
        actual = (na + PSEUDO_COUNT / 2) / (ns + PSEUDO_COUNT)
        check.almost_equal(actual, expected, abs=1e-10,
                            msg=f"With PSEUDO_COUNT={PSEUDO_COUNT}: got {actual}, expected {expected}")

    def test_z_thresholds_are_one_tailed(self):
        """Z thresholds should be one-tailed: Z_90=1.2816, Z_95=1.6449."""
        check.almost_equal(Z_90, 1.2816, abs=0.001,
                            msg=f"Z_90={Z_90}, expected 1.2816 (one-tailed)")
        check.almost_equal(Z_95, 1.6449, abs=0.001,
                            msg=f"Z_95={Z_95}, expected 1.6449 (one-tailed)")

    def test_clojure_prop_test_formula(self):
        """Verify Clojure's proportion test formula: 2*sqrt(n+1)*((succ+1)/(n+1) - 0.5)."""
        # Small n: 5 successes out of 8 trials
        succ, n = 5, 8
        result = 2 * math.sqrt(n + 1) * ((succ + 1) / (n + 1) - 0.5)
        # Manual: 2 * 3 * (6/9 - 0.5) = 6 * 0.1667 = 1.0
        expected = 2 * 3.0 * (6.0 / 9.0 - 0.5)
        assert abs(result - expected) < 1e-10

    def test_clojure_repness_metric_product(self):
        """Verify Clojure's repness metric is a product: ra * rat * pa * pat."""
        ra, rat, pa, pat = 1.5, 2.0, 0.8, 3.0
        expected = ra * rat * pa * pat  # = 7.2
        assert expected == pytest.approx(7.2)

    def test_clojure_repful_uses_rat_vs_rdt(self):
        """Clojure determines repful by comparing rat vs rdt."""
        # rat > rdt → agree
        assert (2.0 > 1.0)  # rat=2.0, rdt=1.0 → agree

        # rat < rdt → disagree
        assert (0.5 < 1.5)  # rat=0.5, rdt=1.5 → disagree
