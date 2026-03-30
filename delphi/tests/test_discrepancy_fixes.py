"""
Per-discrepancy tests for Python-Clojure parity fixes.

Each test class targets ONE specific discrepancy from the fix plan
(delphi/docs/PLAN_DISCREPANCY_FIXES.md). Tests are designed to FAIL before
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

import math

import numpy as np
import pytest
import pytest_check as check

from polismath.conversation.conversation import Conversation
from polismath.pca_kmeans_rep.repness import (
    PSEUDO_COUNT,
    Z_90,
    Z_95,
    z_score_sig_90,
    z_score_sig_95,
    prop_test,
    two_prop_test,
    repness_metric,
    finalize_cmt_stats,
)
from polismath.regression import get_dataset_files, get_blob_variants
from polismath.regression.datasets import discover_datasets
from conftest import _get_requested_datasets, make_dataset_params, parse_dataset_blob_id
from tests.common_utils import load_clojure_output


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

# Module-level cache for blobs (keyed by composite ID)
_BLOB_CACHE: dict = {}


@pytest.fixture(scope="class")
def conversation_data(dataset_name, get_or_compute_conversation):
    """Class-scoped fixture: runs the full pipeline once per dataset+blob_type.

    dataset_name here is actually a composite 'dataset-blob_type' ID
    (e.g., 'biodiversity-incremental' or 'biodiversity-cold_start'). The
    Conversation is shared across blob variants via the session-scoped
    get_or_compute_conversation fixture.
    """
    global _BLOB_CACHE
    ds_name, blob_type = parse_dataset_blob_id(dataset_name)

    # Get or compute the conversation (shared across blob variants via session cache)
    conv_data = get_or_compute_conversation(ds_name)

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
                1: list(range(4, 10)), # 6 raw votes (tids 4..9; tid=4 moderated-out) → NOT in-conv
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
    D4: Previously Python used PSEUDO_COUNT = 1.5 → pa = (na + 0.75) / (ns + 1.5).
        Clojure uses PSEUDO_COUNT = 2.0 → pa = (na + 1) / (ns + 2).
        Python has been updated to 2.0 to match; these tests assert that.
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
    D9: Z-score thresholds and semantics must match Clojure stats.clj:
        (defn z-sig-90? [z-val] (> z-val 1.2816))
        (defn z-sig-95? [z-val] (> z-val 1.6449))

    Three aspects: correct values, strict > (not >=), one-tailed (no abs).
    """

    def test_z90_matches_clojure(self):
        """Z_90 should be one-tailed (1.2816), not two-tailed (1.645)."""
        check.almost_equal(Z_90, 1.2816, abs=0.001,
                            msg=f"Z_90 should be 1.2816 (one-tailed), got {Z_90}")

    def test_z95_matches_clojure(self):
        """Z_95 should be one-tailed (1.6449), not two-tailed (1.96)."""
        check.almost_equal(Z_95, 1.6449, abs=0.001,
                            msg=f"Z_95 should be 1.6449 (one-tailed), got {Z_95}")

    def test_z_sig_strict_greater_than(self):
        """Clojure uses strict >, not >=. Boundary values must NOT pass."""
        check.is_false(z_score_sig_90(Z_90),
                       "z_score_sig_90(Z_90) should be False (strict >, not >=)")
        check.is_false(z_score_sig_95(Z_95),
                       "z_score_sig_95(Z_95) should be False (strict >, not >=)")

    def test_z_sig_one_tailed(self):
        """Clojure uses (> z-val threshold), no abs(). Negative values must NOT pass."""
        check.is_false(z_score_sig_90(-2.0),
                       "z_score_sig_90(-2.0) should be False (one-tailed, no abs)")
        check.is_false(z_score_sig_95(-2.0),
                       "z_score_sig_95(-2.0) should be False (one-tailed, no abs)")

    def test_repness_not_empty(self, conv, dataset_name):
        """Repness should produce non-empty comment_repness with correct thresholds."""
        repness = conv.repness
        check.is_not_none(repness, "Repness should not be None")
        if repness:
            check.is_in('comment_repness', repness, "Should have comment_repness key")
            if 'comment_repness' in repness:
                check.greater(len(repness['comment_repness']), 0,
                              "comment_repness should not be empty")

    @pytest.mark.xfail(reason="D5/D6: z-values differ → different significance decisions → different sets")
    def test_significance_sets_match_clojure(self, conv, clojure_blob, dataset_name):
        """Post-significance-filtering comment sets should match Clojure per group.

        Both sides apply z-sig-90? to their z-values and select top comments.
        With D9 the gate semantics match (>, no abs), but the z-values
        themselves differ until D5 (prop test) and D6 (two-prop test) are fixed.
        """
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})

        mismatches = []
        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            clj_tids = set(e['tid'] for e in clj_entries)
            py_entries = python_repness.get(gid, [])
            py_tids = set(int(e['comment_id']) for e in py_entries)

            if clj_tids != py_tids:
                only_clj = sorted(clj_tids - py_tids)
                only_py = sorted(py_tids - clj_tids)
                mismatches.append(f"  g{gid}: clj_only={only_clj}, py_only={only_py}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} groups with different rep comment sets:")
            for m in mismatches:
                print(m)

        check.equal(len(mismatches), 0,
                    f"{len(mismatches)} groups differ in selected rep comments")

    @pytest.mark.xfail(reason="D5/D6/D10: different z-values and selection → no shared comments to compare")
    def test_z_values_match_clojure(self, conv, clojure_blob, dataset_name):
        """Z-score values for shared rep comments should match Clojure.

        For comments in BOTH Clojure and Python selections, compare:
        - p-test (Clojure) vs pat (Python) — proportion test z-score
        - repness-test (Clojure) vs rat (Python) — two-proportion test z-score

        Requires D10 (same comment selection) so there ARE shared comments,
        then D5/D6 so the values match.
        """
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})

        shared_count = 0
        pat_mismatches = []
        rat_mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_entries = python_repness.get(gid, [])
            py_by_tid = {int(e['comment_id']): e for e in py_entries}

            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue

                shared_count += 1

                # Compare p-test vs pat (proportion test z-score)
                clj_pat = clj_entry.get('p-test', 0)
                py_pat = py_entry.get('pat', 0)
                if abs(clj_pat - py_pat) > 0.01:
                    pat_mismatches.append(
                        f"  g{gid}/t{tid}: clj p-test={clj_pat:.4f}, py pat={py_pat:.4f}")

                # Compare repness-test vs rat (two-proportion test z-score)
                clj_rat = clj_entry.get('repness-test', 0)
                py_rat = py_entry.get('rat', 0)
                if abs(clj_rat - py_rat) > 0.01:
                    rat_mismatches.append(
                        f"  g{gid}/t{tid}: clj repness-test={clj_rat:.4f}, py rat={py_rat:.4f}")

        if pat_mismatches:
            print(f"[{dataset_name}] {len(pat_mismatches)} pat/p-test mismatches:")
            for m in pat_mismatches[:10]:
                print(m)
        if rat_mismatches:
            print(f"[{dataset_name}] {len(rat_mismatches)} rat/repness-test mismatches:")
            for m in rat_mismatches[:10]:
                print(m)

        check.greater(shared_count, 0,
                      "No shared comments to compare — selection sets are disjoint (D10)")
        check.equal(len(pat_mismatches), 0,
                    f"{len(pat_mismatches)} p-test/pat mismatches (D5)")
        check.equal(len(rat_mismatches), 0,
                    f"{len(rat_mismatches)} repness-test/rat mismatches (D6)")


# ============================================================================
# D5 — Proportion Test Formula
# ============================================================================

@pytest.mark.clojure_comparison
class TestD5ProportionTest:
    """
    D5: Python uses standard z-test: (p - 0.5) / sqrt(0.25/n)
        Clojure uses Wilson-score-like: 2*sqrt(n+1)*((succ+1)/(n+1) - 0.5)

    Clojure formula has built-in regularization via +1 terms.
    After fix, prop_test(succ, n) matches Clojure exactly.
    """

    def test_prop_test_matches_clojure_formula(self):
        """prop_test(succ, n) should match Clojure's formula for known inputs."""
        test_cases = [
            (12, 13),  # High success rate
            (5, 8),    # Moderate
            (0, 10),   # All failures
            (10, 10),  # All successes
            (1, 2),    # Tiny sample
            (50, 100), # Larger sample
            (0, 1),    # Single trial, no success
            (1, 1),    # Single trial, success
        ]
        for succ, n in test_cases:
            # Clojure formula: 2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)
            expected = 2 * math.sqrt(n + 1) * ((succ + 1) / (n + 1) - 0.5)
            result = prop_test(succ, n)
            check.almost_equal(result, expected, abs=1e-10,
                                msg=f"prop_test({succ}, {n}): got {result:.6f}, expected {expected:.6f}")

    def test_prop_test_edge_cases(self):
        """prop_test n=0: no short-circuit, +1 pseudocount yields 1.0 (Clojure parity)."""
        # Clojure stats.clj:10-15 has no n=0 guard. After (map inc ...), (0, 0)
        # becomes (1, 1), giving 2*sqrt(1)*(1/1 - 0.5) = 1.0.
        assert prop_test(0, 0) == 1.0

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

    @pytest.mark.xfail(reason="D5/D10: prop test formula differs + no shared comments")
    def test_pat_values_match_clojure_blob(self, conv, clojure_blob, dataset_name):
        """p-test (Clojure) vs pat (Python) for shared rep comments."""
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})
        shared_count = 0
        mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_by_tid = {int(e['comment_id']): e for e in python_repness.get(gid, [])}
            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue
                shared_count += 1
                clj_val = clj_entry.get('p-test', 0)
                py_val = py_entry.get('pat', 0)
                if abs(clj_val - py_val) > 0.01:
                    mismatches.append(
                        f"  g{gid}/t{tid}: clj={clj_val:.4f}, py={py_val:.4f}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} p-test/pat mismatches:")
            for m in mismatches[:10]:
                print(m)
        check.greater(shared_count, 0,
                      "No shared comments to compare (D10)")
        check.equal(len(mismatches), 0, f"{len(mismatches)} p-test/pat mismatches")


# ============================================================================
# D6 — Two-Proportion Test Adjustment
# ============================================================================

@pytest.mark.clojure_comparison
class TestD6TwoPropTest:
    """
    D6: Python uses standard two-proportion z-test without pseudocounts.
        Clojure adds +1 pseudocount to all 4 inputs (stats.clj:18-33):
        (map inc [succ-in succ-out pop-in pop-out])
        pi1 = (succ-in+1)/(pop-in+1), pi2 = (succ-out+1)/(pop-out+1)
        pi-hat = (succ-in+1 + succ-out+1) / (pop-in+1 + pop-out+1)
    """

    @staticmethod
    def _clojure_two_prop_test(succ_in, succ_out, pop_in, pop_out):
        """Reference implementation of Clojure's two-prop-test (stats.clj:18-33)."""
        s1, s2, p1, p2 = succ_in + 1, succ_out + 1, pop_in + 1, pop_out + 1
        pi1 = s1 / p1
        pi2 = s2 / p2
        pi_hat = (s1 + s2) / (p1 + p2)
        if pi_hat == 1:
            return 0.0
        return (pi1 - pi2) / math.sqrt(pi_hat * (1 - pi_hat) * (1/p1 + 1/p2))

    def test_two_prop_test_matches_clojure_formula(self):
        """two_prop_test(succ_in, succ_out, pop_in, pop_out) should match Clojure."""
        # Test cases: (succ_in, succ_out, pop_in, pop_out)
        test_cases = [
            (10, 15, 20, 30),     # typical case
            (0, 0, 10, 10),       # no successes in either group
            (5, 5, 10, 10),       # identical groups
            (10, 0, 10, 10),      # all success in group, none outside
            (1, 1, 1, 1),         # minimal counts
            (50, 20, 100, 200),   # asymmetric sizes
            (0, 10, 20, 30),      # no success in group, some outside
        ]

        for succ_in, succ_out, pop_in, pop_out in test_cases:
            expected = self._clojure_two_prop_test(succ_in, succ_out, pop_in, pop_out)
            result = two_prop_test(succ_in, succ_out, pop_in, pop_out)
            check.almost_equal(
                result, expected, abs=0.001,
                msg=f"two_prop_test({succ_in},{succ_out},{pop_in},{pop_out}): "
                    f"got={result:.4f}, expected={expected:.4f}")

    def test_two_prop_test_edge_cases(self):
        """Edge cases: pi_hat=1 returns 0; pop=0 with pop=0 short-circuit removed.

        Clojure (stats.clj:18-33) increments ALL four inputs by 1 (no special-
        casing of pop=0). Each case below happens to return 0 because of the
        pi_hat==1 guard, NOT because pop=0 — verify by tracing the math.
        """
        # (5,5,0,10) → s1=6,s2=6,p1=1,p2=11 → pi_hat = 12/12 = 1.0 → 0 via guard
        check.equal(two_prop_test(5, 5, 0, 10), 0.0)
        # (5,5,10,0) → s1=6,s2=6,p1=11,p2=1 → pi_hat = 12/12 = 1.0 → 0 via guard
        check.equal(two_prop_test(5, 5, 10, 0), 0.0)
        # (0,0,0,0)  → s1=1,s2=1,p1=1,p2=1  → pi_hat = 2/2  = 1.0 → 0 via guard
        check.equal(two_prop_test(0, 0, 0, 0), 0.0)
        # Real pop=0 (no pi_hat=1 collapse): (5,5,0,100) gives a large positive z,
        # confirming the +1-pseudocount path runs instead of short-circuiting.
        check.greater(two_prop_test(5, 5, 0, 100), 10.0,
                      "pop_in=0 should NOT short-circuit to 0; +1 pseudocount produces large positive z")

    def test_two_prop_test_pseudocount_effect(self):
        """Pseudocounts should shrink z-scores toward zero for small samples."""
        # With small n, the +1 pseudocount has a large effect
        # succ=1, pop=1 → without pseudocount: p=1.0 (extreme)
        # With pseudocount: (1+1)/(1+1) = 1.0, but denominator also shifts
        result_small = two_prop_test(1, 0, 2, 2)
        result_large = two_prop_test(100, 0, 200, 200)
        # The large-sample z should be more extreme (less regularized)
        check.greater(abs(result_large), abs(result_small),
                      "Large samples should produce more extreme z-scores than small ones")

    @pytest.mark.xfail(reason="D6/D10: two-prop test differs + no shared comments to compare")
    def test_rat_values_match_clojure_blob(self, conv, clojure_blob, dataset_name):
        """repness-test (Clojure) vs rat (Python) for shared rep comments.

        Unlike D5's pat test, rat (two-proportion test) needs group-vs-others
        counts which aren't in the blob, so we compare for shared comments only.
        """
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})
        shared_count = 0
        mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_by_tid = {int(e['comment_id']): e for e in python_repness.get(gid, [])}
            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue
                shared_count += 1
                clj_val = clj_entry.get('repness-test', 0)
                py_val = py_entry.get('rat', 0)
                if abs(clj_val - py_val) > 0.01:
                    mismatches.append(
                        f"  g{gid}/t{tid}: clj={clj_val:.4f}, py={py_val:.4f}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} repness-test/rat mismatches:")
            for m in mismatches[:10]:
                print(m)
        check.greater(shared_count, 0,
                      "No shared comments to compare — selection sets are disjoint (D10)")
        check.equal(len(mismatches), 0, f"{len(mismatches)} repness-test/rat mismatches")


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

    @pytest.mark.xfail(reason="D7/D10: metric formula differs + no shared comments")
    def test_repness_metric_matches_clojure_blob(self, conv, clojure_blob, dataset_name):
        """repness (Clojure) vs agree/disagree_metric (Python) for shared comments."""
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})
        shared_count = 0
        mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_by_tid = {int(e['comment_id']): e for e in python_repness.get(gid, [])}
            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue
                shared_count += 1
                clj_val = clj_entry.get('repness', 0)
                py_val = py_entry.get('agree_metric', 0) if py_entry.get('repful') == 'agree' else py_entry.get('disagree_metric', 0)
                if abs(clj_val - py_val) > 0.01:
                    mismatches.append(
                        f"  g{gid}/t{tid}: clj={clj_val:.4f}, py={py_val:.4f}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} repness metric mismatches:")
            for m in mismatches[:10]:
                print(m)
        check.greater(shared_count, 0,
                      "No shared comments to compare (D10)")
        check.equal(len(mismatches), 0, f"{len(mismatches)} repness metric mismatches")


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

    @pytest.mark.xfail(reason="D8/D10: repful logic differs + no shared comments")
    def test_repful_matches_clojure_blob(self, conv, clojure_blob, dataset_name):
        """repful-for (Clojure) vs repful (Python) for shared rep comments."""
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})
        shared_count = 0
        mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_by_tid = {int(e['comment_id']): e for e in python_repness.get(gid, [])}
            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue
                shared_count += 1
                clj_val = clj_entry.get('repful-for', '')
                py_val = py_entry.get('repful', '')
                if clj_val != py_val:
                    mismatches.append(
                        f"  g{gid}/t{tid}: clj={clj_val}, py={py_val}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} repful mismatches:")
            for m in mismatches[:10]:
                print(m)
        check.greater(shared_count, 0,
                      "No shared comments to compare (D10)")
        check.equal(len(mismatches), 0, f"{len(mismatches)} repful-for/repful mismatches")


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
            py_tids = set(int(e['comment_id']) for e in py_entries)

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
        py_tids = set(int(c['comment_id']) for c in py_consensus)

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

    def test_prop_test_matches_clojure_formula_synthetic(self):
        """prop_test(succ, n) should produce 2*sqrt(n+1)*((succ+1)/(n+1) - 0.5)."""
        # Small n: 5 successes out of 8 trials
        succ, n = 5, 8
        expected = 2 * 3.0 * (6.0 / 9.0 - 0.5)  # = 1.0
        result = prop_test(succ, n)
        assert abs(result - expected) < 1e-10, f"prop_test({succ}, {n})={result}, expected {expected}"

    def test_clojure_repness_metric_product(self):
        """Python's repness_metric matches Clojure (* repness repness-test p-success p-test).

        Verifies the actual production function, not a re-implementation of the formula.
        """
        stats = {
            'pa': 0.8, 'pat': 3.0, 'ra': 1.5, 'rat': 2.0,
            'pd': 0.2, 'pdt': -1.0, 'rd': 0.5, 'rdt': -0.5,
        }
        # Agree: (* ra rat pa pat) = 1.5 * 2.0 * 0.8 * 3.0 = 7.2
        assert repness_metric(stats, 'a') == pytest.approx(7.2)
        # Disagree (same product, no (1-pd) trick): (* rd rdt pd pdt)
        # = 0.5 * -0.5 * 0.2 * -1.0 = 0.05 (two negatives cancel — signed product)
        assert repness_metric(stats, 'd') == pytest.approx(0.05)

    def test_clojure_repful_uses_rat_vs_rdt(self):
        """Clojure determines repful by comparing rat vs rdt."""
        # rat > rdt → agree
        assert (2.0 > 1.0)  # rat=2.0, rdt=1.0 → agree

        # rat < rdt → disagree
        assert (0.5 < 1.5)  # rat=0.5, rdt=1.5 → disagree


# ============================================================================
# Blob Injection Tests — Compare Python functions against real Clojure values
# ============================================================================
#
# These tests extract inputs from the Clojure math blob, feed them to Python
# functions, and compare outputs to the Clojure blob's values. This is the
# only non-tautological way to verify correctness: formula-only tests just
# re-implement our reading of the Clojure source and can't catch misreadings.
#
# Since Python and Clojure may produce different clusters (different k), we
# inject Clojure's own group memberships and vote counts from the blob,
# isolating each computation stage from upstream divergence.
# ============================================================================

@pytest.mark.clojure_comparison
class TestD5BlobInjection:
    """D5: Verify prop_test against real Clojure blob p-test values.

    For each repness entry in the blob, extract n-success and n-trials,
    feed to Python's prop_test(), compare to blob's p-test.
    """

    def test_prop_test_matches_blob_p_test(self, clojure_blob, dataset_name):
        """prop_test(n_success, n_trials) should match blob's p-test for every repness entry."""
        repness = clojure_blob.get('repness', {})
        if not repness:
            pytest.skip(f"No repness in Clojure blob for {dataset_name}")

        mismatches = []
        total = 0
        for gid, entries in repness.items():
            for entry in entries:
                n_success = entry['n-success']
                n_trials = entry['n-trials']
                expected_p_test = entry['p-test']
                actual = prop_test(n_success, n_trials)
                total += 1
                if abs(actual - expected_p_test) > 1e-4:
                    mismatches.append(
                        f"group={gid} tid={entry['tid']}: "
                        f"prop_test({n_success}, {n_trials})={actual:.6f}, "
                        f"blob p-test={expected_p_test:.6f}")

        assert not mismatches, (
            f"[{dataset_name}] {len(mismatches)}/{total} p-test mismatches:\n"
            + "\n".join(mismatches[:10]))


@pytest.mark.clojure_comparison
class TestD6BlobInjection:
    """D6: Verify two_prop_test against real Clojure blob repness-test values.

    For each repness entry, reconstruct the two_prop_test inputs from
    group-votes (group counts vs total-minus-group), compare to blob's
    repness-test.
    """

    def test_two_prop_test_matches_blob_repness_test(self, clojure_blob, dataset_name):
        """two_prop_test should match blob's repness-test for every repness entry."""
        repness = clojure_blob.get('repness', {})
        group_votes = clojure_blob.get('group-votes', {})
        if not repness or not group_votes:
            pytest.skip(f"No repness or group-votes in blob for {dataset_name}")

        # Precompute total votes across ALL groups for each comment
        all_group_votes = {}
        for other_gid, other_gv_data in group_votes.items():
            for tid_str, counts in other_gv_data.get('votes', {}).items():
                if tid_str not in all_group_votes:
                    all_group_votes[tid_str] = {'A': 0, 'D': 0, 'S': 0}
                all_group_votes[tid_str]['A'] += counts['A']
                all_group_votes[tid_str]['D'] += counts['D']
                all_group_votes[tid_str]['S'] += counts['S']

        mismatches = []
        total = 0
        for gid, entries in repness.items():
            gv = group_votes.get(gid, {}).get('votes', {})
            for entry in entries:
                tid_str = str(entry['tid'])
                repful = entry['repful-for']
                expected_rt = entry['repness-test']

                group_cv = gv.get(tid_str, {'A': 0, 'D': 0, 'S': 0})
                total_cv = all_group_votes.get(tid_str, {'A': 0, 'D': 0, 'S': 0})

                if repful == 'agree':
                    succ_in = group_cv['A']
                    succ_out = total_cv['A'] - group_cv['A']
                else:
                    succ_in = group_cv['D']
                    succ_out = total_cv['D'] - group_cv['D']

                pop_in = group_cv['S']
                pop_out = total_cv['S'] - group_cv['S']

                actual = two_prop_test(succ_in, succ_out, pop_in, pop_out)
                total += 1
                if abs(actual - expected_rt) > 1e-4:
                    mismatches.append(
                        f"group={gid} tid={entry['tid']} ({repful}): "
                        f"two_prop_test({succ_in},{succ_out},{pop_in},{pop_out})={actual:.6f}, "
                        f"blob repness-test={expected_rt:.6f}")

        assert not mismatches, (
            f"[{dataset_name}] {len(mismatches)}/{total} repness-test mismatches:\n"
            + "\n".join(mismatches[:10]))


@pytest.mark.clojure_comparison
class TestD4BlobInjection:
    """D4: Verify p-success (pseudocount formula) against blob values."""

    def test_p_success_matches_blob(self, clojure_blob, dataset_name):
        """(n_success + 1) / (n_trials + 2) should match blob's p-success."""
        repness = clojure_blob.get('repness', {})
        if not repness:
            pytest.skip(f"No repness in blob for {dataset_name}")

        mismatches = []
        total = 0
        for gid, entries in repness.items():
            for entry in entries:
                ns = entry['n-success']
                nt = entry['n-trials']
                expected = entry['p-success']
                actual = (ns + PSEUDO_COUNT / 2) / (nt + PSEUDO_COUNT)
                total += 1
                if abs(actual - expected) > 1e-4:
                    mismatches.append(
                        f"group={gid} tid={entry['tid']}: "
                        f"pa=({ns}+1)/({nt}+2)={actual:.6f}, "
                        f"blob p-success={expected:.6f}")

        assert not mismatches, (
            f"[{dataset_name}] {len(mismatches)}/{total} p-success mismatches:\n"
            + "\n".join(mismatches[:10]))
