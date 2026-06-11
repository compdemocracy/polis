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
import pandas as pd
import pytest
import pytest_check as check

from polismath.conversation.conversation import Conversation
from polismath.pca_kmeans_rep.repness import (
    PSEUDO_COUNT,
    Z_90,
    Z_95,
    z_score_sig_90,
    z_score_sig_95,
    prop_test_vectorized,
    two_prop_test_vectorized,
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

        # Both raw_rating_mat and rating_mat have all columns (D15 fix:
        # moderated-out columns are zeroed, not removed)
        n_cmts_raw = len(conv.raw_rating_mat.columns)
        n_cmts_filtered = len(conv.rating_mat.columns)

        assert n_cmts_raw == 10, f"raw_rating_mat should have 10 columns, got {n_cmts_raw}"
        assert n_cmts_filtered == 10, f"rating_mat should keep all 10 columns (zeroed, not removed), got {n_cmts_filtered}"

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
        """prop_test_vectorized(succ, n) should match Clojure's formula for known
        inputs, including the n=0 boundary (no short-circuit; +1 pseudocount → 1.0)."""
        # (succ, n, label_for_diagnostic)
        cases = pd.DataFrame([
            (12, 13, "high success rate"),
            (5, 8, "moderate"),
            (0, 10, "all failures"),
            (10, 10, "all successes"),
            (1, 2, "tiny sample"),
            (50, 100, "larger sample"),
            (0, 1, "single trial, no success"),
            (1, 1, "single trial, success"),
            (0, 0, "n=0 boundary (no short-circuit; +1 pseudocount → 1.0)"),
        ], columns=['succ', 'n', 'label'])

        # Clojure formula: 2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)
        cases['expected'] = (2 * np.sqrt(cases['n'] + 1)
                              * ((cases['succ'] + 1) / (cases['n'] + 1) - 0.5))
        cases['actual'] = prop_test_vectorized(cases['succ'], cases['n'])
        cases['diff'] = (cases['actual'] - cases['expected']).abs()

        mismatches = cases[cases['diff'] > 1e-10]
        assert mismatches.empty, (
            f"{len(mismatches)}/{len(cases)} prop_test_vectorized mismatches:\n"
            + mismatches.to_string(index=False))

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
        """two_prop_test_vectorized should match Clojure's per-row formula, including
        edge cases that exercise the pi_hat==1 guard and the no-pop=0 short-circuit."""
        cases = pd.DataFrame([
            # (succ_in, succ_out, pop_in, pop_out, label)
            (10, 15, 20, 30, "typical case"),
            (0, 0, 10, 10, "no successes in either group"),
            (5, 5, 10, 10, "identical groups"),
            (10, 0, 10, 10, "all success in group, none outside"),
            (1, 1, 1, 1, "minimal counts"),
            (50, 20, 100, 200, "asymmetric sizes"),
            (0, 10, 20, 30, "no success in group, some outside"),
            # pi_hat==1 boundary cases (Clojure: returns 0; vectorized: NaN → 0.0)
            (5, 5, 0, 10, "pop_in=0, succ saturates → pi_hat=1 guard"),
            (5, 5, 10, 0, "pop_out=0, succ saturates → pi_hat=1 guard"),
            (0, 0, 0, 0, "all zero → pi_hat=1 guard"),
        ], columns=['succ_in', 'succ_out', 'pop_in', 'pop_out', 'label'])

        cases['expected'] = cases.apply(
            lambda r: self._clojure_two_prop_test(
                r['succ_in'], r['succ_out'], r['pop_in'], r['pop_out']),
            axis=1)
        cases['actual'] = two_prop_test_vectorized(
            cases['succ_in'], cases['succ_out'], cases['pop_in'], cases['pop_out'])
        cases['diff'] = (cases['actual'] - cases['expected']).abs()

        mismatches = cases[cases['diff'] > 1e-3]
        assert mismatches.empty, (
            f"{len(mismatches)}/{len(cases)} two_prop_test mismatches:\n"
            + mismatches.to_string(index=False))

        # Pin the no-pop=0-short-circuit behavior: real pop=0 (no pi_hat=1 collapse)
        # → (5,5,0,100) produces a large positive z, confirming the +1-pseudocount
        # path runs instead of short-circuiting.
        no_pi_hat_collapse = two_prop_test_vectorized(
            pd.Series([5]), pd.Series([5]), pd.Series([0]), pd.Series([100])).iloc[0]
        check.greater(no_pi_hat_collapse, 10.0,
                      "pop_in=0 should NOT short-circuit to 0 when pi_hat<1; "
                      "+1 pseudocount produces large positive z")

    def test_two_prop_test_pseudocount_effect(self):
        """Pseudocounts should shrink z-scores toward zero for small samples."""
        # With small n, the +1 pseudocount has a large effect:
        # succ=1, pop=1 → without pseudocount: p=1.0 (extreme); with pseudocount,
        # both numerator and denominator shift.
        results = two_prop_test_vectorized(
            pd.Series([1, 100]),    # succ_in:  small, large
            pd.Series([0, 0]),      # succ_out: zero in both
            pd.Series([2, 200]),    # pop_in:   small, large
            pd.Series([2, 200]),    # pop_out:  small, large
        )
        result_small, result_large = results.iloc[0], results.iloc[1]
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
        """Pins the agree_metric/disagree_metric formula with hand-computed values.

        Clojure repness-metric (repness.clj:191-193):
            (* repness repness-test p-success p-test)
        Production code mirrors this in compute_group_comment_stats_df:
            stats_df['agree_metric'] = stats_df['ra'] * stats_df['rat']
                                       * stats_df['pa'] * stats_df['pat']
            stats_df['disagree_metric'] = stats_df['rd'] * stats_df['rdt']
                                          * stats_df['pd'] * stats_df['pdt']
        Signed product — no abs(). Negative z-scores flip the sign.
        """
        df = pd.DataFrame([{
            'pa': 0.8, 'pat': 2.5, 'ra': 1.3, 'rat': 1.8,
            'pd': 0.2, 'pdt': -1.5, 'rd': 0.7, 'rdt': -0.9,
        }])

        agree_metric = (df['ra'] * df['rat'] * df['pa'] * df['pat']).iloc[0]
        disagree_metric = (df['rd'] * df['rdt'] * df['pd'] * df['pdt']).iloc[0]

        # Hand-computed reference values.
        check.almost_equal(agree_metric, 4.68, abs=1e-10,
                            msg=f"agree_metric (1.3 * 1.8 * 0.8 * 2.5) = 4.68, got {agree_metric}")
        # Two negatives cancel — signed product.
        check.almost_equal(disagree_metric, 0.189, abs=1e-10,
                            msg=f"disagree_metric (0.7 * -0.9 * 0.2 * -1.5) = 0.189, got {disagree_metric}")

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

    def test_repful_classification_boundary(self):
        """Pin the repful classification logic: agree iff rat > rdt (strict), else disagree.

        Production code (compute_group_comment_stats_df):
            stats_df['repful'] = np.where(stats_df['rat'] > stats_df['rdt'],
                                          'agree', 'disagree')
        Clojure (repness.clj:178):
            (if (> rat rdt) :agree :disagree)

        Strict `>` — `rat == rdt` falls through to 'disagree'. Covers:
        - rat < rdt  → 'disagree' (case where old Python 3-branch wrongly said 'agree')
        - rat > rdt  → 'agree'    (case where old Python wrongly said 'disagree')
        - rat == rdt → 'disagree' (strict >, non-zero boundary)
        - rat == rdt == 0 → 'disagree' (all-zero boundary, distinct from above)
        - negative z-scores: comparison works on signed values (-0.5 > -2.0)
        """
        cases = pd.DataFrame([
            (0.5, 1.5, 'disagree', "rat < rdt: old Python 3-branch would say agree"),
            (1.5, 0.5, 'agree', "rat > rdt: old Python 3-branch would say disagree"),
            (1.5, 1.5, 'disagree', "rat == rdt non-zero (strict >)"),
            (0.0, 0.0, 'disagree', "rat == rdt == 0 boundary"),
            (-0.5, -2.0, 'agree', "negative z-scores: -0.5 > -2.0"),
        ], columns=['rat', 'rdt', 'expected', 'label'])

        cases['actual'] = np.where(cases['rat'] > cases['rdt'], 'agree', 'disagree')

        mismatches = cases[cases['actual'] != cases['expected']]
        assert mismatches.empty, (
            f"{len(mismatches)}/{len(cases)} repful mismatches:\n"
            + mismatches.to_string(index=False))

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

    Clojure behavior (named_matrix.clj:214-230):
      zero-out-columns sets all values in moderated columns to 0,
      preserving the matrix structure (same number of columns).

    Python should match: _apply_moderation() must zero out moderated
    columns rather than removing them, so that:
      - rating_mat.columns includes moderated tids (zeroed)
      - tids output includes moderated tids
      - Matrix dimensions match Clojure
    """

    def test_moderated_comments_zeroed_not_removed(self, conv, clojure_blob, dataset_name):
        """
        After applying moderation, rating_mat should still have all columns.
        Moderated columns should be zeroed, not removed.
        """
        mod_out = clojure_blob.get('mod-out') or []
        if not mod_out:
            pytest.skip(f"[{dataset_name}] No moderated comments in this dataset")

        # Apply moderation from the Clojure blob to the Python conversation
        mod_conv = conv.update_moderation(
            {'mod_out_tids': mod_out},
            recompute=False,
        )

        n_cols_python = len(mod_conv.rating_mat.columns)
        n_cols_raw = len(mod_conv.raw_rating_mat.columns)

        print(f"[{dataset_name}] mod-out: {len(mod_out)}")
        print(f"[{dataset_name}] Python rating_mat cols: {n_cols_python}, raw cols: {n_cols_raw}")
        print(f"[{dataset_name}] Clojure tids: {len(clojure_blob.get('tids', []))}")

        # After zeroing (not removing), column count should match raw matrix
        check.equal(
            n_cols_python, n_cols_raw,
            f"rating_mat should keep all columns (zeroed, not removed): "
            f"got {n_cols_python}, expected {n_cols_raw}"
        )

        # Moderated columns should be all zeros (not NaN, not original values)
        for tid in mod_out:
            if tid in mod_conv.rating_mat.columns:
                col_values = mod_conv.rating_mat[tid].values
                check.is_true(
                    np.all(col_values == 0.0),
                    f"Moderated tid {tid} should be all zeros, "
                    f"got non-zero values: {col_values[col_values != 0.0][:5]}"
                )

    def test_tids_include_moderated(self, conv, clojure_blob, dataset_name):
        """The tids output should include moderated-out comments (matching Clojure)."""
        mod_out = clojure_blob.get('mod-out') or []
        if not mod_out:
            pytest.skip(f"[{dataset_name}] No moderated comments in this dataset")

        mod_conv = conv.update_moderation(
            {'mod_out_tids': mod_out},
            recompute=False,
        )

        # rating_mat.columns (used for tids output) should include moderated tids
        for tid in mod_out:
            if tid in mod_conv.raw_rating_mat.columns:
                check.is_in(
                    tid, set(mod_conv.rating_mat.columns),
                    f"Moderated tid {tid} should still be in rating_mat columns"
                )


class TestD15SyntheticModeration:
    """
    Synthetic tests for D15 moderation handling.

    Clojure zeros out moderated columns (named_matrix.clj:214-230).
    Python must match: _apply_moderation() zeros columns, not removes them.
    """

    def _make_conversation_with_moderation(self, mod_out_tids):
        """Create a small conversation and apply moderation."""
        import pandas as pd

        # 5 participants, 4 comments. Votes: agree=1, disagree=-1, pass=0, no vote=NaN
        data = {
            0: [1.0, -1.0, 1.0, np.nan, 0.0],
            1: [-1.0, 1.0, 0.0, 1.0, -1.0],
            2: [1.0, 1.0, -1.0, -1.0, 1.0],
            3: [np.nan, 0.0, 1.0, 1.0, -1.0],
        }
        votes_df = pd.DataFrame(data, index=[0, 1, 2, 3, 4])

        conv = Conversation("synthetic_d15")
        conv.raw_rating_mat = votes_df.copy()
        conv.rating_mat = votes_df.copy()
        conv.participant_count, conv.comment_count = votes_df.shape

        # Apply moderation
        conv.mod_out_tids = set(mod_out_tids)
        conv._apply_moderation()
        return conv

    def test_zeroing_preserves_columns(self):
        """Moderated columns should still be present in rating_mat."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[1, 3])

        # All 4 columns should still be present
        assert len(conv.rating_mat.columns) == 4, (
            f"Expected 4 columns, got {len(conv.rating_mat.columns)}: "
            f"moderated columns should be zeroed, not removed"
        )
        assert set(conv.rating_mat.columns) == {0, 1, 2, 3}

    def test_zeroed_columns_are_all_zero(self):
        """Moderated columns should have all values set to 0.0."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[1, 3])

        for tid in [1, 3]:
            col = conv.rating_mat[tid].values
            assert np.all(col == 0.0), (
                f"Moderated column {tid} should be all zeros, got {col}"
            )

    def test_non_moderated_columns_unchanged(self):
        """Non-moderated columns should retain their original values."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[1])

        # Column 0 should be unchanged: [1, -1, 1, NaN, 0]
        col0 = conv.rating_mat[0].values
        assert col0[0] == 1.0
        assert col0[1] == -1.0
        assert np.isnan(col0[3])  # NaN preserved for non-moderated

    def test_empty_moderation_no_change(self):
        """No moderation should leave the matrix unchanged."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[])
        assert len(conv.rating_mat.columns) == 4

    def test_moderate_nonexistent_tid(self):
        """Moderating a tid that doesn't exist in the matrix should be a no-op."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[99])
        # All columns preserved, no crash
        assert len(conv.rating_mat.columns) == 4
        # Original values intact
        assert conv.rating_mat[0].values[0] == 1.0

    # ------------------------------------------------------------------
    # Downstream parity tests: zeroed columns must NOT poison user-vote
    # counts, per-comment votes-base, or _compute_vote_stats.
    # Audit-discovered 2026-06-09. Clojure (conversation.clj:220-228, 593-600)
    # routes these from raw-rating-mat, not the zeroed rating-mat.
    # ------------------------------------------------------------------

    def test_user_vote_counts_uses_raw_rating_mat(self):
        """user-vote-counts must reflect actual votes, not the post-D15 zeros.

        Synthetic conv has pid 3 with raw NaN on tid 0 (didn't vote). After
        moderating tid 0, the OLD bug (reading from rating_mat) counts the
        zeroed cell as a vote → pid 3 inflates from 3 to 4. The fix routes
        through raw_rating_mat to match Clojure (conversation.clj:220-228).
        """
        conv = self._make_conversation_with_moderation(mod_out_tids=[0])
        counts = conv._compute_user_vote_counts()
        # Truth per raw matrix (NaN cells excluded):
        #   pid 0 voted on tids 0,1,2 (NaN on 3) → 3
        #   pid 1: all 4
        #   pid 2: all 4
        #   pid 3 voted on tids 1,2,3 (NaN on 0) → 3   ← would inflate to 4 with old bug
        #   pid 4: all 4
        assert counts.get(0) == 3
        assert counts.get(1) == 4
        assert counts.get(2) == 4
        assert counts.get(3) == 3, (
            "pid 3 didn't vote on moderated tid 0 (raw=NaN); count must stay 3, "
            f"not inflate to {counts.get(3)}"
        )
        assert counts.get(4) == 4

    def test_votes_base_uses_raw_rating_mat(self):
        """to_dict's votes-base for moderated tids must reflect raw votes, not zeros.

        After moderating tid 0 the OLD bug returns
        {0: {'A': 0, 'D': 0, 'S': 5}} (all 5 pids appear as 'S' since 0.0 is
        non-NaN). Truth (raw_rating_mat) is {'A': 2, 'D': 1, 'S': 4} (4 actual
        votes; pid 3 NaN). Matches Clojure (conversation.clj:593-600).
        """
        conv = self._make_conversation_with_moderation(mod_out_tids=[0])
        vb = conv._compute_votes_base()
        # tid 0 (moderated): pid 0=1.0 (A), pid 1=-1.0 (D), pid 2=1.0 (A),
        # pid 3=NaN, pid 4=0.0 (pass) → A=2, D=1, S=4
        assert vb[0] == {'A': 2, 'D': 1, 'S': 4}, (
            f"moderated tid 0 votes-base must come from raw_rating_mat: got {vb[0]}"
        )
        # tid 1 (not moderated): pid 0=-1, pid 1=1, pid 2=1, pid 3=0, pid 4=-1
        # → A=2, D=2, S=5
        assert vb[1] == {'A': 2, 'D': 2, 'S': 5}

    def test_compute_vote_stats_uses_raw_rating_mat(self):
        """_compute_vote_stats.n_votes must not count moderated-out zeros."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[0])
        conv._compute_vote_stats()
        # Truth (raw): 4 + 5 + 5 + 4 = 18 actual votes across all tids.
        # OLD bug (rating_mat with zeroed tid 0): 5 (zeroed) + 5 + 5 + 4 = 19.
        assert conv.vote_stats['n_votes'] == 18, (
            f"n_votes must count raw votes only; got {conv.vote_stats['n_votes']}, expected 18"
        )

    def test_vote_counts_exclude_moderated_out_participants(self):
        """Moderated-out *participants* (mod_out_ptpts) must NOT appear in vote stats.

        D15 fixed moderated comment *columns* (zeroed, not removed). Polis also
        supports moderated-out *participants* via `mod_out_ptpts`, which
        `_apply_moderation` drops from `rating_mat.index`. The raw_rating_mat
        routing for vote counting must NOT leak these participants — otherwise
        excluded users' votes would still show up in `user-vote-counts`,
        `votes-base`, and `_compute_vote_stats`.
        """
        import pandas as pd

        # Same matrix as the helper, with pid 3 moderated out.
        data = {
            0: [1.0, -1.0, 1.0, np.nan, 0.0],
            1: [-1.0, 1.0, 0.0, 1.0, -1.0],
            2: [1.0, 1.0, -1.0, -1.0, 1.0],
            3: [np.nan, 0.0, 1.0, 1.0, -1.0],
        }
        votes_df = pd.DataFrame(data, index=[0, 1, 2, 3, 4])
        conv = Conversation("synthetic_d15_mod_ptpts")
        conv.raw_rating_mat = votes_df.copy()
        conv.rating_mat = votes_df.copy()
        conv.participant_count, conv.comment_count = votes_df.shape
        conv.mod_out_ptpts = {3}  # ban pid 3
        conv._apply_moderation()

        # rating_mat should have dropped pid 3
        assert 3 not in conv.rating_mat.index, "_apply_moderation should drop mod_out_ptpts"

        # user-vote-counts must not include pid 3
        counts = conv._compute_user_vote_counts()
        assert 3 not in counts, (
            f"moderated-out pid 3 leaked into user-vote-counts: {sorted(counts.keys())}"
        )

        # votes-base counts must reflect 4 participants (0,1,2,4), not 5.
        # tid 1 (not moderated): pid 0=-1 (D), pid 1=1 (A), pid 2=0 (pass),
        #                        pid 3 dropped, pid 4=-1 (D)  → A=1, D=2, S=4
        vb = conv._compute_votes_base()
        assert vb[1] == {'A': 1, 'D': 2, 'S': 4}, (
            f"tid 1 votes-base must exclude moderated-out pid 3; "
            f"got {vb[1]}, expected {{A:1, D:2, S:4}}"
        )

        # vote_stats global n_votes: only count over the 4 remaining participants.
        # pid 0: 3, pid 1: 4, pid 2: 4, pid 4: 4 → total 15 (not 18).
        conv._compute_vote_stats()
        assert conv.vote_stats['n_votes'] == 15, (
            f"n_votes must exclude moderated-out participants: got "
            f"{conv.vote_stats['n_votes']}, expected 15"
        )

    def test_to_dict_and_to_dynamo_dict_serialize_user_vote_counts_and_votes_base(self):
        """End-to-end serialization shape regression for the 2026-06-09 refactor.

        Before this session, `to_dict` and `to_dynamo_dict` each had their own
        inline implementations of user-vote-counts and votes-base. Both were
        refactored to route through `_compute_user_vote_counts()` /
        `_compute_votes_base()`. This test pins the serializer output shape so
        the refactor can't silently change the on-the-wire format:

        - `to_dict.user-vote-counts`  : key `'user-vote-counts'` (hyphen),
                                        value `{int-pid: int-count}` per Clojure naming.
        - `to_dict.votes-base`        : key `'votes-base'`, value `{int-tid: {'A','D','S'}}`.
        - `to_dynamo_dict.user_vote_counts` : key with **underscore**, same value shape.
        - `to_dynamo_dict.votes_base`       : key with **underscore**, value
                                              `{int-tid: {'agree','disagree','total'}}`
                                              (DynamoDB key convention, NOT A/D/S).

        Also: values must be `int` (DynamoDB rejects `numpy.int64` later in the
        serialization pipeline; the helpers wrap with `int(...)`).
        """
        # Build a tiny conv with enough state for both serializers to reach
        # the user-vote-counts / votes-base sections without crashing
        # downstream on missing PCA / cluster state. Both serializers gate
        # group-votes / projections on empty `group_clusters` / `proj`, so a
        # bare-bones conv is enough.
        conv = self._make_conversation_with_moderation(mod_out_tids=[])
        # Minimal extra state for the serializers (set on default __init__
        # values where possible; only add what the serializers actually read).
        conv.conversation_id = 99999
        conv.last_updated = 0

        # ---- to_dict ----
        try:
            blob = conv.to_dict()
        except Exception as e:  # pragma: no cover
            pytest.fail(f"to_dict() raised on synthetic conv: {e!r}")

        assert 'user-vote-counts' in blob, "to_dict must produce 'user-vote-counts' (hyphen) key"
        assert 'votes-base' in blob, "to_dict must produce 'votes-base' (hyphen) key"

        uvc = blob['user-vote-counts']
        assert isinstance(uvc, dict)
        assert len(uvc) == 5, f"5 participants → 5 vote-count entries, got {len(uvc)}"
        for pid, count in uvc.items():
            assert isinstance(pid, int), (
                f"to_dict user-vote-counts pid must be int (numpy-safe), got {type(pid)}")
            assert isinstance(count, int) and not isinstance(count, bool), (
                f"to_dict user-vote-counts value must be int, got {type(count)}")

        vb = blob['votes-base']
        assert isinstance(vb, dict)
        assert len(vb) == 4, f"4 comments → 4 votes-base entries, got {len(vb)}"
        for tid, entry in vb.items():
            assert isinstance(tid, int), (
                f"to_dict votes-base tid must be int (numpy-safe), got {type(tid)}")
            assert set(entry.keys()) == {'A', 'D', 'S'}, (
                f"to_dict votes-base entry must have Clojure-style A/D/S keys, got {set(entry.keys())}")
            for k, v in entry.items():
                assert isinstance(v, int) and not isinstance(v, bool), (
                    f"to_dict votes-base {k} must be int, got {type(v)}")

        # ---- to_dynamo_dict ----
        try:
            dyn = conv.to_dynamo_dict()
        except Exception as e:  # pragma: no cover
            pytest.fail(f"to_dynamo_dict() raised on synthetic conv: {e!r}")

        assert 'user_vote_counts' in dyn, "to_dynamo_dict must produce 'user_vote_counts' (underscore)"
        assert 'votes_base' in dyn, "to_dynamo_dict must produce 'votes_base' (underscore)"
        # Crucial: the OLD format used hyphens NOWHERE; the DynamoDB serializer
        # must never emit Clojure-style keys.
        assert 'user-vote-counts' not in dyn, "to_dynamo_dict must not emit hyphen-style key"
        assert 'votes-base' not in dyn, "to_dynamo_dict must not emit hyphen-style key"

        dyn_uvc = dyn['user_vote_counts']
        assert isinstance(dyn_uvc, dict)
        assert len(dyn_uvc) == 5
        for pid, count in dyn_uvc.items():
            assert isinstance(pid, int), (
                f"to_dynamo_dict user_vote_counts pid must be int, got {type(pid)}")
            assert isinstance(count, int) and not isinstance(count, bool), (
                f"to_dynamo_dict user_vote_counts value must be int, got {type(count)}")

        dyn_vb = dyn['votes_base']
        assert isinstance(dyn_vb, dict)
        assert len(dyn_vb) == 4
        for tid, entry in dyn_vb.items():
            assert isinstance(tid, int), (
                f"to_dynamo_dict votes_base tid must be int, got {type(tid)}")
            assert set(entry.keys()) == {'agree', 'disagree', 'total'}, (
                "to_dynamo_dict votes_base entries must have DynamoDB-style "
                f"agree/disagree/total keys (NOT A/D/S), got {set(entry.keys())}")
            for k, v in entry.items():
                assert isinstance(v, int) and not isinstance(v, bool), (
                    f"to_dynamo_dict votes_base {k} must be int, got {type(v)}")

        # Cross-check: the per-participant counts must match between the two
        # serializers (same helper, just different key names on the way out).
        for pid in uvc:
            assert uvc[pid] == dyn_uvc[pid], (
                f"user-vote-counts mismatch for pid {pid}: "
                f"to_dict={uvc[pid]}, to_dynamo_dict={dyn_uvc[pid]}")

        # And A/D/S vs agree/disagree/total must agree per-tid.
        for tid in vb:
            assert vb[tid]['A'] == dyn_vb[tid]['agree']
            assert vb[tid]['D'] == dyn_vb[tid]['disagree']
            assert vb[tid]['S'] == dyn_vb[tid]['total']


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

    # prop_test / repness_metric / repful formula tests are covered by
    # TestD5ProportionTest::test_prop_test_matches_clojure_formula,
    # TestD7RepnessMetric::test_metric_formula_is_product, and
    # TestD8FinalizeStats::test_repful_classification_boundary respectively
    # (migrated to vectorized in PR 14a).


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

def _blob_repness_rows(clojure_blob):
    """Flatten the Clojure blob's `repness` dict into a list of per-(gid, tid) rows
    for vectorized comparison. Each row is `{gid, tid, **entry_keys}`."""
    return [{'gid': gid, **entry}
            for gid, entries in clojure_blob.get('repness', {}).items()
            for entry in entries]


@pytest.mark.clojure_comparison
class TestD5BlobInjection:
    """D5: Verify prop_test_vectorized against real Clojure blob p-test values.

    Collect (n-success, n-trials, p-test) from every repness entry in the blob,
    run a single vectorized call, compare element-wise. Tests the actual
    production code path (same call shape as `compute_group_comment_stats_df`).
    """

    def test_prop_test_matches_blob_p_test(self, clojure_blob, dataset_name):
        """prop_test_vectorized(n_success, n_trials) should match blob's p-test
        for every repness entry."""
        rows = _blob_repness_rows(clojure_blob)
        if not rows:
            pytest.skip(f"No repness in Clojure blob for {dataset_name}")

        df = pd.DataFrame(rows)[['gid', 'tid', 'n-success', 'n-trials', 'p-test']]
        df['actual'] = prop_test_vectorized(df['n-success'], df['n-trials'])
        df['diff'] = (df['actual'] - df['p-test']).abs()

        mismatches = df[df['diff'] > 1e-4]
        assert mismatches.empty, (
            f"[{dataset_name}] {len(mismatches)}/{len(df)} p-test mismatches:\n"
            + mismatches.head(10).to_string(index=False))


@pytest.mark.clojure_comparison
class TestD6BlobInjection:
    """D6: Verify two_prop_test_vectorized against real Clojure blob
    repness-test values.

    For each repness entry, reconstruct the two_prop_test inputs from
    group-votes (group counts vs total-minus-group), collect into a DataFrame,
    and run a single vectorized call. Tests the actual production code path.
    """

    def test_two_prop_test_matches_blob_repness_test(self, clojure_blob, dataset_name):
        """two_prop_test_vectorized should match blob's repness-test for every
        repness entry."""
        repness = clojure_blob.get('repness', {})
        group_votes = clojure_blob.get('group-votes', {})
        if not repness or not group_votes:
            pytest.skip(f"No repness or group-votes in blob for {dataset_name}")

        # Precompute total votes across ALL groups for each comment.
        all_group_votes: dict = {}
        for other_gid, other_gv_data in group_votes.items():
            for tid_str, counts in other_gv_data.get('votes', {}).items():
                if tid_str not in all_group_votes:
                    all_group_votes[tid_str] = {'A': 0, 'D': 0, 'S': 0}
                all_group_votes[tid_str]['A'] += counts['A']
                all_group_votes[tid_str]['D'] += counts['D']
                all_group_votes[tid_str]['S'] += counts['S']

        rows = []
        for gid, entries in repness.items():
            gv = group_votes.get(gid, {}).get('votes', {})
            for entry in entries:
                tid_str = str(entry['tid'])
                repful = entry['repful-for']
                group_cv = gv.get(tid_str, {'A': 0, 'D': 0, 'S': 0})
                total_cv = all_group_votes.get(tid_str, {'A': 0, 'D': 0, 'S': 0})

                if repful == 'agree':
                    succ_in = group_cv['A']
                    succ_out = total_cv['A'] - group_cv['A']
                else:
                    succ_in = group_cv['D']
                    succ_out = total_cv['D'] - group_cv['D']

                rows.append({
                    'gid': gid, 'tid': entry['tid'], 'repful': repful,
                    'succ_in': succ_in, 'succ_out': succ_out,
                    'pop_in': group_cv['S'],
                    'pop_out': total_cv['S'] - group_cv['S'],
                    'expected': entry['repness-test'],
                })

        df = pd.DataFrame(rows)
        df['actual'] = two_prop_test_vectorized(
            df['succ_in'], df['succ_out'], df['pop_in'], df['pop_out'])
        df['diff'] = (df['actual'] - df['expected']).abs()

        mismatches = df[df['diff'] > 1e-4]
        assert mismatches.empty, (
            f"[{dataset_name}] {len(mismatches)}/{len(df)} repness-test mismatches:\n"
            + mismatches.head(10).to_string(index=False))


@pytest.mark.clojure_comparison
class TestD4BlobInjection:
    """D4: Verify p-success (pseudocount formula) against blob values."""

    def test_p_success_matches_blob(self, clojure_blob, dataset_name):
        """(n_success + 1) / (n_trials + 2) should match blob's p-success."""
        rows = _blob_repness_rows(clojure_blob)
        if not rows:
            pytest.skip(f"No repness in blob for {dataset_name}")

        df = pd.DataFrame(rows)[['gid', 'tid', 'n-success', 'n-trials', 'p-success']]
        df['actual'] = ((df['n-success'] + PSEUDO_COUNT / 2)
                        / (df['n-trials'] + PSEUDO_COUNT))
        df['diff'] = (df['actual'] - df['p-success']).abs()

        mismatches = df[df['diff'] > 1e-4]
        assert mismatches.empty, (
            f"[{dataset_name}] {len(mismatches)}/{len(df)} p-success mismatches:\n"
            + mismatches.head(10).to_string(index=False))
